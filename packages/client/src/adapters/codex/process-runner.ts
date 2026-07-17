import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

export type SpawnFn = typeof spawn;

/** stdin is `null` (never a Writable) — this process never pipes stdin to the child; see the module doc comment below for why. */
type CodexChildProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * One parsed line of `codex exec --json` / `codex exec resume --json`
 * output. Field shapes vary by `type` (see `./events.ts`'s module doc
 * comment for the empirically-captured catalog), so this stays a loose bag
 * rather than a full discriminated union, mirroring `PiRpcMessage` in
 * `../pi/rpc-client.ts`.
 */
export interface CodexRawEvent {
  type: string;
  [key: string]: unknown;
}

export interface CodexProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
  /** Called once per parsed JSONL line, in arrival order. */
  onEvent: (evt: CodexRawEvent) => void;
}

/** Bound on retained stderr lines (see `onStderr`/`buildExitError`) — mirrors `STDERR_RING_CAPACITY` in `../pi/rpc-client.ts`. */
const STDERR_RING_CAPACITY = 20;

/**
 * Spawns and streams ONE `codex exec` / `codex exec resume` invocation — i.e.
 * exactly one turn.
 *
 * Unlike pi (a single long-lived RPC server process for a whole session's
 * lifetime — see `../pi/rpc-client.ts`), `codex exec` is a one-shot batch
 * process per turn with no persistent request/response channel: it takes its
 * prompt as an argv positional, streams JSONL to stdout for the one turn
 * it's running, and exits. `../codex-adapter.ts`'s `CodexSession` constructs
 * a fresh `CodexProcessRunner` for every turn (the initial `start()` and
 * every later `followUp()`), forwarding each one's lines into the same
 * long-lived event queue.
 *
 * stdin is deliberately never piped to the child (`stdio: ['ignore', 'pipe',
 * 'pipe']`): `codex exec --help` documents that a piped, non-TTY stdin is
 * read and appended to the prompt as a `<stdin>` block even when a prompt was
 * ALSO given as an argv positional, and empirically every single real
 * invocation made while building this adapter logged "Reading additional
 * input from stdin..." on stderr regardless of whether a prompt argument was
 * given. Leaving `stdio: ['pipe', ...]` open for stdin and never closing it
 * risks codex blocking on that read forever — exactly the hang class this
 * task was built to avoid (the pi adapter's own `agent_end`/`agent_settled`
 * mismatch left a task stuck `Running` forever in the M0/M1 GLM run).
 * `'ignore'` presents immediate EOF instead, which was verified live with a
 * dedicated Node `child_process` probe before this was written: no hang,
 * clean completion at normal model latency. This adapter never needs to
 * SEND codex anything over stdin — there is no in-band steer/approval
 * protocol (see `../codex-adapter.ts`'s `steer`/`resolveApproval`).
 */
export class CodexProcessRunner {
  private readonly child: CodexChildProcess;
  private readonly onEvent: (evt: CodexRawEvent) => void;
  private buffer = '';
  private readonly stderrRing: string[] = [];
  private closed = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;

  constructor(options: CodexProcessOptions) {
    this.onEvent = options.onEvent;
    const spawnFn = options.spawnFn ?? spawn;
    this.child = spawnFn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => this.onStderr(chunk));

    // `close` (not `exit`), mirroring rpc-client.ts's own reasoning: `close`
    // is Node's guarantee every stdout/stderr byte the process wrote has
    // already reached our listeners, so a post-mortem error built afterward
    // always has the complete stderr tail.
    this.child.on('close', (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      this.finishClosing();
    });
    this.child.on('error', () => {
      // e.g. ENOENT for a missing binary — buildExitError's stderr tail will
      // be empty in this case, but exitCode/exitSignal staying null is
      // itself informative (never claims a fabricated exit code).
      this.finishClosing();
    });
  }

  private finishClosing(): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveClosed();
  }

  /** Resolves once the child process has fully exited (both exit and stdio-flush guaranteed — see the `close` listener above). Never rejects. */
  waitClosed(): Promise<void> {
    return this.closedPromise;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Best-effort teardown. SIGTERM on POSIX: SIGINT was empirically confirmed
   * to be silently ignored by `codex exec` (a real, direct test — a 60s
   * shell `sleep` ran to full, unaffected completion despite SIGINT sent at
   * t=4s) — a genuine, evidence-based correction to this task's own initial
   * assumption ("interrupt: SIGINT — POSIX here"). SIGTERM was separately
   * confirmed to terminate the process immediately (exit code 143) with no
   * orphaned child processes left behind (the shell command it was running
   * died with it), and — critically — the underlying codex thread remained
   * cleanly resumable afterward via `codex exec resume` (no corruption from
   * killing mid-turn). `taskkill /T /F` on Windows, mirroring
   * `../pi/rpc-client.ts`'s own cross-platform convention.
   */
  kill(): void {
    if (this.closed) return;
    const pid = this.child.pid;
    if (process.platform === 'win32' && pid !== undefined) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
    } else {
      this.child.kill('SIGTERM');
    }
  }

  /** Builds a descriptive error folding in the exit code/signal and the stderr tail — mirrors `PiRpcClient.buildExitError`'s reasoning: a post-mortem on a failed start/resume should never need separately re-running codex by hand with a raw JSONL logger to learn why. */
  buildExitError(context: string): Error {
    const parts = [`${context} (exit code=${this.exitCode}, signal=${this.exitSignal})`];
    if (this.stderrRing.length > 0) {
      parts.push(`stderr: ${this.stderrRing.join(' | ')}`);
    }
    return new Error(parts.join('; '));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) this.parseLine(line);
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  private parseLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // a stray non-JSON line is not this runner's concern
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
      return;
    }
    this.onEvent(parsed as CodexRawEvent);
  }

  private onStderr(chunk: string): void {
    for (const rawLine of chunk.split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      this.stderrRing.push(line);
      if (this.stderrRing.length > STDERR_RING_CAPACITY) this.stderrRing.shift();
    }
  }
}
