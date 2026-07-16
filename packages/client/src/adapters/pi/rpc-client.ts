import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AsyncQueue } from '../../util/async-queue';

export type SpawnFn = typeof spawn;

/**
 * A pi RPC-mode message: either a `{type:"response", id, success, ...}` reply
 * to a command we sent, or an unsolicited event/extension-UI-request. Field
 * shapes vary by `type` (see docs.md / this task's live probes), so this
 * stays a loose bag rather than a full discriminated union — M0 only needs
 * a handful of fields off of each.
 */
export interface PiRpcMessage {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface PiRpcClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
}

/**
 * JSONL request/response + event-stream client for `pi --mode rpc`.
 *
 * Framing per pi's own docs/rpc.md: strict JSONL, LF (`\n`) as the only
 * record delimiter (a trailing `\r` is stripped; this deliberately does NOT
 * use `node:readline`, which pi's docs call out as non-compliant because it
 * also splits on U+2028/U+2029 — valid inside JSON strings).
 *
 * Responses are correlated by `id`, never by arrival order: empirically,
 * pi's responses do not preserve request order (an immediate parse-failure
 * response can overtake a slower in-flight command's response).
 */
export class PiRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<
    string,
    { resolve: (msg: PiRpcMessage) => void; reject: (err: Error) => void }
  >();
  private readonly eventQueue = new AsyncQueue<PiRpcMessage>();
  private closed = false;
  private exitError: Error | undefined;

  constructor(options: PiRpcClientOptions) {
    const spawnFn = options.spawnFn ?? spawn;
    this.child = spawnFn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));

    this.child.on('exit', (code, signal) => {
      this.onClosed(new Error(`pi process exited (code=${code}, signal=${signal})`));
    });
    this.child.on('error', (err) => {
      this.onClosed(err);
    });
  }

  /** Send a command, resolved with its correlated `response` message. */
  send(command: Record<string, unknown> & { type: string; id?: string }): Promise<PiRpcMessage> {
    if (this.closed) {
      return Promise.reject(this.exitError ?? new Error('pi process is closed'));
    }
    const id = command.id ?? `req-${this.nextId++}`;
    const full = { ...command, id };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(full)}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Every non-response line: events plus `extension_ui_request`s. */
  get events(): AsyncIterable<PiRpcMessage> {
    return this.eventQueue;
  }

  /** Best-effort teardown. SIGTERM on POSIX; `taskkill /T /F` on Windows to also reap child processes pi itself spawned (e.g. bash). */
  kill(): void {
    if (this.closed) return;
    const pid = this.child.pid;
    if (process.platform === 'win32' && pid !== undefined) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
    } else {
      this.child.kill('SIGTERM');
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) this.onLine(line);
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let msg: PiRpcMessage;
    try {
      msg = JSON.parse(line) as PiRpcMessage;
    } catch {
      return; // a stray non-JSON line is not this client's concern
    }
    if (msg.type === 'response' && typeof msg.id === 'string' && this.pending.has(msg.id)) {
      const waiter = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      waiter?.resolve(msg);
      return;
    }
    this.eventQueue.push(msg);
  }

  private onClosed(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.exitError = err;
    for (const [, waiter] of this.pending) waiter.reject(err);
    this.pending.clear();
    this.eventQueue.end();
  }
}
