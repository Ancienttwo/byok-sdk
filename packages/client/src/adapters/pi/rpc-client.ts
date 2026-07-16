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

/** Bound on retained stderr lines (see `onStderr`/`buildExitError`) — enough to show a real crash reason without an unbounded footprint for a long-lived process that's merely chatty on stderr. */
const STDERR_RING_CAPACITY = 20;

/**
 * pi's 4 blocking "dialog" extension-UI methods (rpc.md's "Extension UI
 * Protocol": `select`/`confirm`/`input`/`editor` emit an
 * `extension_ui_request` and BLOCK pi's whole run until a matching
 * `extension_ui_response` arrives). The other 5 methods
 * (`notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text`) are
 * fire-and-forget and must never get a reply (rpc.md: "Responses are sent
 * for dialog methods only") — see `respondToExtensionUiRequest`.
 */
const DIALOG_UI_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

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
  /** Bounded tail of recent stderr lines — pi discarded this entirely before (nothing ever read `child.stderr`), which is exactly why finding #1 (`Error: Unknown option: --session-id`, exit 1) had to be root-caused by hand instead of reading it off a thrown error. See `buildExitError`. */
  private readonly stderrRing: string[] = [];
  /** Count of pi RPC message types `PiSession` (pi-adapter.ts) has told us have no `AgentEvent` mapping and aren't routine bookkeeping — see `recordUnmappedFrame`. */
  private readonly unmappedFrameCounts = new Map<string, number>();

  constructor(options: PiRpcClientOptions) {
    const spawnFn = options.spawnFn ?? spawn;
    this.child = spawnFn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => this.onStderr(chunk));

    // `close` (not `exit`): `exit` can fire before stdio streams finish
    // flushing, which matters a lot for finding #1's "instant exit" shape —
    // `close` is Node's guarantee that every stdout/stderr byte the process
    // ever wrote has already been delivered to our listeners, so the error
    // built below always has the complete stderr tail, not a truncated one.
    this.child.on('close', (code, signal) => {
      this.onClosed(this.buildExitError(code, signal));
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

  /** Every non-response, non-`extension_ui_request` line — the latter is answered directly by this client (see `respondToExtensionUiRequest`) and never enqueued. */
  get events(): AsyncIterable<PiRpcMessage> {
    return this.eventQueue;
  }

  /**
   * Record a pi RPC message `type` that `PiSession` (pi-adapter.ts) decided
   * has no `AgentEvent` mapping and isn't routine bookkeeping (see
   * `events.ts`'s `ROUTINE_PI_EVENT_TYPES`) — i.e. genuinely unexpected
   * traffic. Logs once per distinct type (not per occurrence, so a
   * repeating unmapped type can't spam stdout); the running tally is also
   * folded into this client's exit-time error message (`buildExitError`) so
   * a post-mortem on a failed/hung task has it without needing separate log
   * scraping. This is the exact mechanism that would have turned this
   * task's root-cause hang (`agent_end` arriving with no mapping) into a
   * one-line, immediate warning instead of a silent stall.
   */
  recordUnmappedFrame(type: string): void {
    const next = (this.unmappedFrameCounts.get(type) ?? 0) + 1;
    this.unmappedFrameCounts.set(type, next);
    if (next === 1) {
      console.warn(
        `[byok/pi-adapter] pi emitted a frame type with no AgentEvent mapping: "${type}" (further occurrences of this type won't be logged individually)`,
      );
    }
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
    if (msg.type === 'extension_ui_request' && typeof msg.id === 'string' && typeof msg.method === 'string') {
      // Answered here, not enqueued — see `respondToExtensionUiRequest`. If
      // left unanswered this blocks pi's entire run exactly like the
      // agent_end/agent_settled root-cause bug does (process alive, idle,
      // waiting on stdin forever) — this was the task's leading hypothesis
      // for finding #2 before the live-frame capture pinned the actual
      // cause on the settle-event mismatch; handled regardless, since it's a
      // real, documented way for a future extension/skill to hang a task.
      this.respondToExtensionUiRequest(msg.id, msg.method);
      return;
    }
    this.eventQueue.push(msg);
  }

  /**
   * Answer pi's extension-UI blocking protocol headlessly (rpc.md's
   * "Extension UI Protocol"). Fail-closed policy, stated explicitly because
   * it's a security-relevant default, not an incidental one: this NEVER
   * approves or picks a value on the caller's behalf — every dialog method
   * (`select`/`confirm`/`input`/`editor`) gets `{cancelled: true}`, the one
   * response shape rpc.md documents as valid for all four uniformly
   * ("Dismiss any dialog method... the extension receives `undefined` (for
   * select/input/editor) or `false` (for confirm)"). An extension asking
   * e.g. `confirm("Delete everything?")` gets a firm decline, never a
   * guessed approval — this adapter has no human in the loop to ask, and
   * silently approving would defeat any extension that uses these dialogs
   * specifically as a permission gate. Fire-and-forget methods
   * (`notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text`) get no
   * reply at all — sending one would itself violate rpc.md ("Responses are
   * sent for dialog methods only").
   */
  private respondToExtensionUiRequest(id: string, method: string): void {
    if (!DIALOG_UI_METHODS.has(method)) return; // fire-and-forget — no response expected or sent
    this.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id, cancelled: true })}\n`);
  }

  private onStderr(chunk: string): void {
    for (const rawLine of chunk.split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      this.stderrRing.push(line);
      if (this.stderrRing.length > STDERR_RING_CAPACITY) this.stderrRing.shift();
    }
  }

  /**
   * finding #1 ("bad flag → instant exit", e.g. the `--session-id`/
   * `--exclude-tools` bugs this task fixes): the daemon used to report only
   * `pi process exited (code=1, signal=null)` — accurate but useless for
   * diagnosing *why* without re-running pi by hand with a raw JSONL logger,
   * exactly as this task's own root-cause investigation had to. Folding in
   * the stderr tail and any unmapped-frame tally makes that self-diagnosing
   * from the thrown error alone.
   */
  private buildExitError(code: number | null, signal: NodeJS.Signals | null): Error {
    const parts = [`pi process exited (code=${code}, signal=${signal})`];
    if (this.stderrRing.length > 0) {
      parts.push(`stderr: ${this.stderrRing.join(' | ')}`);
    }
    if (this.unmappedFrameCounts.size > 0) {
      const summary = [...this.unmappedFrameCounts.entries()].map(([type, count]) => `${type}×${count}`).join(', ');
      parts.push(`unmapped frame types seen: ${summary}`);
    }
    return new Error(parts.join('; '));
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
