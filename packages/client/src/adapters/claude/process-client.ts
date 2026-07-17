import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AsyncQueue } from '../../util/async-queue';
import type { ClaudeStreamMessage } from './events';

export type SpawnFn = typeof spawn;

export interface ClaudeProcessClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
}

/** Bound on retained stderr lines, mirroring pi's identical constant/rationale in `../pi/rpc-client.ts`. */
const STDERR_RING_CAPACITY = 20;

/**
 * NDJSON process transport for `claude -p --input-format stream-json
 * --output-format stream-json`.
 *
 * Structurally simpler than pi's `PiRpcClient` in one real way, and
 * different (not simpler) in another:
 *
 * - No request/response correlation. pi's RPC mode replies to each command
 *   with a `{type:"response", id, success, ...}` — claude's stream-json has
 *   no such acknowledgement at all; writing a `{"type":"user",...}` line
 *   just starts (or queues) a turn, and the ONLY confirmation is the
 *   ordinary event stream itself (starting with a `system/init` frame).
 *   There is therefore no `pending` id->resolver map here.
 * - `waitForInit()` exists specifically to compensate for that missing
 *   ack: pi's `start()` fails fast because a bad flag/auth error rejects
 *   the pending `send()` promise for the first command. Claude's own
 *   `AsyncQueue.end()` (used for the `events` stream) is a CLEAN,
 *   non-throwing end — a process that crashes before ever emitting a line
 *   would otherwise look, from the async-iteration protocol alone, exactly
 *   like a session that legitimately produced zero events, silently
 *   swallowing the real failure. `waitForInit()` is a dedicated promise
 *   that resolves with the real `session_id` once claude's own
 *   `system/init` frame arrives, or rejects with the same enriched
 *   exit-error `events` would otherwise swallow — this is what lets
 *   `ClaudeAdapter.start()` fail loudly and immediately for a bad
 *   `--resume` target etc., mirroring pi's own fail-fast contract with a
 *   mechanism suited to claude's ack-less protocol instead of copying pi's
 *   request/response one verbatim.
 *
 * Framing, stderr-ring, and unmapped-frame-tally-in-exit-error all mirror
 * `../pi/rpc-client.ts`'s already-proven design directly (LF-delimited
 * JSONL, `node:readline` avoided for the same U+2028/U+2029 reason pi's
 * doc comment explains, `close` not `exit` for the same complete-stderr
 * guarantee) — these are generic, sound patterns, not pi-specific logic,
 * so re-implementing them independently here (rather than importing from
 * `../pi/`) keeps this adapter fully self-contained, matching this repo's
 * existing per-adapter isolation.
 */
export class ClaudeProcessClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private readonly eventQueue = new AsyncQueue<ClaudeStreamMessage>();
  private closed = false;
  private exitError: Error | undefined;
  private readonly stderrRing: string[] = [];
  private readonly unmappedFrameCounts = new Map<string, number>();

  private sessionId: string | undefined;
  private initWaiter: { resolve: (sessionId: string) => void; reject: (err: Error) => void } | undefined;

  constructor(options: ClaudeProcessClientOptions) {
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

    // `close` (not `exit`) — see pi's rpc-client.ts doc comment for why
    // this matters: it's Node's guarantee every stdout/stderr byte the
    // process wrote has already been delivered, so a bad-flag/auth-failure
    // exit error always carries the complete stderr tail.
    this.child.on('close', (code, signal) => {
      this.onClosed(this.buildExitError(code, signal));
    });
    this.child.on('error', (err) => {
      this.onClosed(err);
    });
  }

  /**
   * Write a new user turn onto stdin (`--input-format stream-json`'s wire
   * shape: `{"type":"user","message":{"role":"user","content":[{"type":
   * "text","text":...}]}}`). Used identically for the very first turn
   * (`ClaudeAdapter.start()`) and any later same-session turn
   * (`ClaudeSession.followUp()`) — empirically confirmed live that claude
   * keeps a `--input-format stream-json` process alive across multiple
   * sequential turns on ONE persistent process/session (same `session_id`
   * reported on each turn's own `system/init` and `result` frames), only
   * exiting when stdin is closed or the process is killed. This is the
   * mechanism `followUp()` relies on instead of spawning a fresh
   * `--resume`'d process per follow-up.
   */
  writeUserMessage(text: string): void {
    if (this.closed) {
      throw this.exitError ?? new Error('claude process is closed');
    }
    const line = `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
    this.child.stdin.write(line, (err) => {
      if (err) {
        console.error(`[byok/claude-adapter] failed to write to claude stdin: ${err.message}`);
      }
    });
  }

  /**
   * Resolves with claude's own `session_id` once its `system/init` frame
   * arrives (see this class's doc comment for why this exists at all).
   * Idempotent: once resolved, further calls resolve immediately with the
   * same id; if the process already closed before init ever arrived,
   * every call rejects with that same exit error.
   */
  waitForInit(): Promise<string> {
    if (this.sessionId !== undefined) return Promise.resolve(this.sessionId);
    if (this.closed) return Promise.reject(this.exitError ?? new Error('claude process is closed'));
    return new Promise((resolve, reject) => {
      this.initWaiter = { resolve, reject };
    });
  }

  /** Every parsed stream-json line — `system/init` is consumed internally (see `waitForInit`) but is also forwarded here like any other frame, so routine-frame accounting in `ClaudeSession`'s mapper stays uniform. */
  get events(): AsyncIterable<ClaudeStreamMessage> {
    return this.eventQueue;
  }

  /**
   * Record a claude stream-json frame/subtype/content-block label that
   * `ClaudeSession`'s event iterator (`../claude-adapter.ts`) decided has
   * no `AgentEvent` mapping and isn't routine bookkeeping (see
   * `events.ts`'s `MapClaudeMessageResult.unmappedLabel` doc comment) —
   * i.e. genuinely unexpected traffic. Mirrors pi's
   * `PiRpcClient.recordUnmappedFrame` exactly: logs once per distinct
   * label, folds the running tally into a later exit error for a
   * post-mortem without separate log scraping.
   */
  recordUnmappedFrame(label: string): void {
    const next = (this.unmappedFrameCounts.get(label) ?? 0) + 1;
    this.unmappedFrameCounts.set(label, next);
    if (next === 1) {
      console.warn(
        `[byok/claude-adapter] claude emitted a frame with no AgentEvent mapping: "${label}" (further occurrences of this label won't be logged individually)`,
      );
    }
  }

  /** Best-effort teardown. SIGTERM on POSIX; `taskkill /T /F` on Windows to also reap child processes claude itself spawned (e.g. Bash) — mirrors pi's cross-platform `kill()` exactly. Empirically confirmed on this (POSIX) machine: a running claude process exits cleanly within ~1s of SIGTERM (observed exit code 143 = 128+SIGTERM, i.e. claude catches and handles the signal itself rather than needing a harder kill). */
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
    let msg: ClaudeStreamMessage;
    try {
      msg = JSON.parse(line) as ClaudeStreamMessage;
    } catch {
      return; // a stray non-JSON line is not this client's concern
    }

    if (
      this.sessionId === undefined &&
      msg.type === 'system' &&
      msg.subtype === 'init' &&
      typeof msg.session_id === 'string' &&
      msg.session_id.length > 0
    ) {
      this.sessionId = msg.session_id;
      this.initWaiter?.resolve(this.sessionId);
      this.initWaiter = undefined;
    }

    this.eventQueue.push(msg);
  }

  private onStderr(chunk: string): void {
    for (const rawLine of chunk.split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      this.stderrRing.push(line);
      if (this.stderrRing.length > STDERR_RING_CAPACITY) this.stderrRing.shift();
    }
  }

  /** Mirrors pi's `buildExitError` exactly — stderr tail + unmapped-frame tally folded into one self-diagnosing message. */
  private buildExitError(code: number | null, signal: NodeJS.Signals | null): Error {
    const parts = [`claude process exited (code=${code}, signal=${signal})`];
    if (this.stderrRing.length > 0) {
      parts.push(`stderr: ${this.stderrRing.join(' | ')}`);
    }
    if (this.unmappedFrameCounts.size > 0) {
      const summary = [...this.unmappedFrameCounts.entries()].map(([label, count]) => `${label}×${count}`).join(', ');
      parts.push(`unmapped frame labels seen: ${summary}`);
    }
    return new Error(parts.join('; '));
  }

  private onClosed(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.exitError = err;
    this.initWaiter?.reject(err);
    this.initWaiter = undefined;
    this.eventQueue.end();
  }
}
