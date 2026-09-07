import { RuntimeExecutionFailure } from '../../runtime-failure';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { adoptOwnedProcessTree, disposeOwnedProcessTree, requestOwnedProcessTreeTermination, withOwnedProcessTree } from '../process-tree';

export type SpawnFn = typeof spawn;

/** Prompt-bearing invocations pipe stdin and close it after the exact prompt. */
type CodexChildProcess = ChildProcessByStdio<Writable | null, Readable, Readable>;

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
  instruction?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
  /** Called once per parsed JSONL line, in arrival order. */
  onEvent: (evt: CodexRawEvent) => void;
  onFailure?: (error: RuntimeExecutionFailure) => void;
  /**
   * DI seam scoped to ADOPTION only (`../process-tree.ts`'s
   * `adoptOwnedProcessTree`), so the win32 job-object branch is exercisable
   * from POSIX. Disposal keeps `process.platform` as its own authority — this
   * must never silently reroute the taskkill sweep on a real host.
   */
  platform?: NodeJS.Platform;
  /** DI seam for the win32 job-object backstop; see `../win32-job-object.ts`. */
  jobObject?: { assign(pid: number): Promise<void> };
}

/** Bound on retained stderr lines (see `onStderr`/`buildExitError`) — mirrors `STDERR_RING_CAPACITY` in `../pi/rpc-client.ts`. */
const STDERR_RING_CAPACITY = 20;
export const CODEX_MAX_FRAME_BYTES = 1024 * 1024;
export const CODEX_MAX_DEFERRED_BYTES = 4 * 1024 * 1024;
export const CODEX_MAX_STDERR_BYTES = 64 * 1024;

/**
 * Spawns and streams ONE `codex exec` / `codex exec resume` invocation — i.e.
 * exactly one turn.
 *
 * Unlike pi (a single long-lived RPC server process for a whole session's
 * lifetime — see `../pi/rpc-client.ts`), `codex exec` is a one-shot batch
 * process per turn with no persistent request/response channel: it takes its
 * prompt from stdin with the documented `-` positional, streams JSONL to stdout for the one turn
 * it's running, and exits. `../codex-adapter.ts`'s `CodexSession` constructs
 * a fresh `CodexProcessRunner` for every turn (the initial `start()` and
 * every later `followUp()`), forwarding each one's lines into the same
 * long-lived event queue.
 *
 * Prompt stdin is closed with EOF immediately after writing. This is a one-shot
 * input channel; steer and approvals are not multiplexed over it.
 */
export class CodexProcessRunner {
  private readonly child: CodexChildProcess;
  private readonly onEvent: (evt: CodexRawEvent) => void;
  private readonly frameChunks: Buffer[] = [];
  private frameBytes = 0;
  private deferredBytes = 0;
  private stderrBytes = 0;
  private transportFailure: RuntimeExecutionFailure | undefined;
  private readonly onFailure: CodexProcessOptions['onFailure'];
  private readonly stderrRing: string[] = [];
  private closed = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private disposalAttempt: Promise<void> | undefined;
  /** Resolves once this tree is backstopped (see `adoptOwnedProcessTree`); rejects with the adoption failure, having already terminated the tree. */
  private readonly adopted: Promise<void>;
  /** Set before the fail-closed termination starts; `buildExitError` reports it instead of the exit status of the kill we ourselves requested. */
  private adoptionFailure: Error | undefined;
  private adoption: 'pending' | 'adopted' | 'failed' = 'pending';
  /**
   * Lines parsed before adoption settled. Unlike pi and claude, this runner has
   * no first awaited operation of its own to gate on — its caller reads the
   * FIRST event as the authoritative thread id. Holding events until the tree
   * is backstopped is what keeps that caller from publishing a session for a
   * tree the job object never took.
   */
  private readonly deferredEvents: CodexRawEvent[] = [];

  constructor(options: CodexProcessOptions) {
    this.onEvent = options.onEvent;
    this.onFailure = options.onFailure;
    const spawnFn = options.spawnFn ?? spawn;
    this.child = spawnFn(options.command, options.args, withOwnedProcessTree({
      cwd: options.cwd,
      env: options.env,
      stdio: [options.instruction === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })) as CodexChildProcess;

    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.adopted = this.adoptOwnedTree(options);
    // The rejection is surfaced through `buildExitError` on the close the
    // teardown itself causes; this keeps it from raising an unhandled rejection.
    this.adopted.catch(() => {});

    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));

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
    if (options.instruction !== undefined) {
      this.child.stdin!.on('error', () => {
        this.failTransport('codex prompt stdin failed before delivery');
      });
      // One bounded-by-task input, followed by EOF even for empty/Unicode prompts.
      this.child.stdin!.end(options.instruction, 'utf8');
    }
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
   * Immediate tree termination request. SIGTERM on POSIX: SIGINT was empirically confirmed
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
   *
   * Fire-and-forget by design: an interrupt must not block on a terminator,
   * and `dispose()` is the settlement receipt. A request that could not be
   * spawned is left unrecorded, so `dispose()` re-issues it and raises the
   * typed `stage:'signal'` failure — swallowing it here loses nothing.
   */
  kill(): void {
    void requestOwnedProcessTreeTermination(this.processTreeOptions()).catch(() => {});
  }

  dispose(): Promise<void> {
    if (!this.disposalAttempt) {
      const attempt = disposeOwnedProcessTree(this.processTreeOptions());
      this.disposalAttempt = attempt.catch((error: unknown) => {
        this.disposalAttempt = undefined;
        throw error;
      });
    }
    return this.disposalAttempt;
  }

  private processTreeOptions() {
    return {
      child: this.child,
      waitClosed: () => this.closedPromise,
      isClosed: () => this.closed,
      label: 'codex',
    };
  }

  /**
   * Backstop this tree, or tear it down. Adoption failure is a start-time
   * precondition, not a degraded mode: the child is terminated through the one
   * disposal authority, every parsed line is dropped instead of delivered, and
   * the resulting close makes the caller's own `waitClosed()` race reject with
   * the adoption failure (`buildExitError`) before a thread id is published.
   * Both cleanup attempts are best-effort because the adoption failure, not a
   * terminator's own complaint, is the reason to report.
   */
  private async adoptOwnedTree(options: CodexProcessOptions): Promise<void> {
    try {
      await adoptOwnedProcessTree({
        child: this.child,
        label: 'codex',
        platform: options.platform,
        jobObject: options.jobObject,
      });
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error(String(cause));
      this.adoptionFailure = failure;
      this.adoption = 'failed';
      this.deferredEvents.length = 0;
      await requestOwnedProcessTreeTermination(this.processTreeOptions()).catch(() => {});
      await disposeOwnedProcessTree(this.processTreeOptions()).catch(() => {});
      throw failure;
    }
    this.adoption = 'adopted';
    this.deferredBytes = 0;
    for (const evt of this.deferredEvents.splice(0)) this.onEvent(evt);
  }

  /** Arrival-order delivery, held back until the tree is backstopped (see `deferredEvents`). */
  private deliver(evt: CodexRawEvent, bytes: number): void {
    if (this.transportFailure) return;
    if (this.adoption === 'failed') return;
    if (this.adoption === 'pending') {
      if (this.deferredBytes + bytes > CODEX_MAX_DEFERRED_BYTES) {
        this.failTransport('codex pre-adoption event buffer exceeded its byte budget');
        return;
      }
      this.deferredBytes += bytes;
      this.deferredEvents.push(evt);
      return;
    }
    this.onEvent(evt);
  }

  /**
   * Builds a descriptive error folding in the exit code/signal and the stderr
   * tail — mirrors `PiRpcClient.buildExitError`'s reasoning: a post-mortem on a
   * failed start/resume should never need separately re-running codex by hand
   * with a raw JSONL logger to learn why.
   *
   * A tree this runner could not backstop is the one exception: that process
   * exited because THIS runner killed it, so `exit code=null, signal=SIGKILL`
   * plus an empty stderr tail would bury the only reason anyone can act on.
   */
  buildExitError(context: string): Error {
    if (this.transportFailure) return this.transportFailure;
    if (this.adoptionFailure !== undefined) return this.adoptionFailure;
    const parts = [`${context} (exit code=${this.exitCode}, signal=${this.exitSignal})`];
    if (this.stderrRing.length > 0) {
      parts.push(`stderr: ${this.stderrRing.join(' | ')}`);
    }
    return new Error(parts.join('; '));
  }

  private failTransport(reason: string): void {
    if (this.transportFailure) return;
    this.transportFailure = new RuntimeExecutionFailure({ phase: 'run', category: 'infrastructure',
      retry: 'non-retryable', reason });
    this.frameChunks.length = 0;
    this.frameBytes = 0;
    this.deferredEvents.length = 0;
    this.deferredBytes = 0;
    this.onFailure?.(this.transportFailure);
    this.kill();
  }

  private onData(chunk: Buffer): void {
    if (this.transportFailure) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const bytes = end - offset;
      if (this.frameBytes + bytes > CODEX_MAX_FRAME_BYTES) {
        this.failTransport('codex raw JSONL frame exceeded its byte budget');
        return;
      }
      if (bytes > 0) this.frameChunks.push(Buffer.from(chunk.subarray(offset, end)));
      this.frameBytes += bytes;
      if (newline === -1) return;
      const frame = Buffer.concat(this.frameChunks, this.frameBytes);
      this.frameChunks.length = 0;
      this.frameBytes = 0;
      const line = frame.toString('utf8').replace(/\r$/, '');
      if (line.length > 0) this.parseLine(line, frame.length);
      if (this.transportFailure) return;
      offset = newline + 1;
    }
  }

  private parseLine(line: string, bytes: number): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // a stray non-JSON line is not this runner's concern
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
      return;
    }
    this.deliver(parsed as CodexRawEvent, bytes);
  }

  private onStderr(chunk: string): void {
    const bounded = Buffer.from(chunk).subarray(-CODEX_MAX_STDERR_BYTES).toString('utf8');
    for (const rawLine of bounded.split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      this.stderrRing.push(line);
      this.stderrBytes += Buffer.byteLength(line);
      while (this.stderrRing.length > STDERR_RING_CAPACITY || this.stderrBytes > CODEX_MAX_STDERR_BYTES) {
        this.stderrBytes -= Buffer.byteLength(this.stderrRing.shift()!);
      }
    }
  }
}
