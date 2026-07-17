import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import type { AgentEvent, TaskOfferPayload } from '@byok/protocol';
import {
  PolicyUnsupportedError,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeDetectResult,
  type Session,
  type TaskContext,
} from '../../types';
import { AsyncQueue } from '../../util/async-queue';
import { resolveCodexBin, type ResolvedBin } from './resolve-bin';
import { mapPermissionPolicyToCodexArgs } from './permission-mapping';
import { isRoutineCodexEvent, mapCodexEventToAgentEvents, unmappedFrameKey } from './events';
import { CodexProcessRunner, type CodexRawEvent, type SpawnFn } from './process-runner';

const execFileAsync = promisify(execFile);

/** Applied to both `detect()` probe calls — both are local-only and empirically fast (~50-80ms each), but detect() runs on every allowlist-narrowed task offer (see task-runner.ts's `pickAdapter`), so a small ceiling is cheap insurance against either ever unexpectedly hanging. */
const DETECT_TIMEOUT_MS = 5000;

export interface CodexAdapterOptions {
  /** Override bin resolution — tests substitute the fake-codex fixture script. */
  resolveBin?: () => ResolvedBin;
  /** Override process spawning — tests substitute a fake spawn. */
  spawnFn?: SpawnFn;
}

/**
 * `RuntimeAdapter` for the OpenAI Codex CLI (`codex exec --json`), the M2-b
 * counterpart to `../pi/pi-adapter.ts`. Every empirical claim in this file
 * and its sibling modules (`events.ts`, `permission-mapping.ts`,
 * `process-runner.ts`) was driven live against the real installed `codex-cli
 * 0.144.5` in a scratch directory before being encoded — repeating the pi
 * adapter's own M0-3 discipline ("docs lied and shipped a nonexistent flag")
 * independently found the exact same bug class on codex:
 *
 *   - `codex exec --help` documents `-a`/`--ask-for-approval`; the real
 *     parser rejects it outright on `codex exec` ("unexpected argument").
 *   - `-s`/`--sandbox` works on a fresh `codex exec` but is rejected outright
 *     on `codex exec resume` (whose own --help correctly omits it).
 *   - `codex exec resume` does NOT auto-inherit the sandbox mode a session
 *     was originally started with — a read-only-started session's write
 *     SUCCEEDED on a bare resume with no sandbox override re-passed,
 *     silently falling back to this machine's own ambient config default.
 *   - This task's own brief assumed SIGINT for `interrupt()`; empirically,
 *     `codex exec` ignores SIGINT entirely (a 60s `sleep` ran to completion
 *     despite SIGINT at t=4s) — SIGTERM is used instead (confirmed to work:
 *     immediate exit, no orphaned children, thread stays resumable after).
 *
 * See `./permission-mapping.ts` and `./process-runner.ts` for the full
 * per-finding writeups (sandbox scope, network, approval model, resume
 * mechanics, stdin handling).
 *
 * Architecture, and how it differs from pi: pi is one long-lived `pi --mode
 * rpc` process for a whole session's lifetime, driven by a bidirectional
 * JSONL request/response protocol (`../pi/rpc-client.ts`). `codex exec` has
 * no such thing — it's a one-shot batch process per turn, prompt in via
 * argv, JSONL out via stdout, process exits. `CodexSession` here instead
 * spawns a fresh `CodexProcessRunner` for every turn (the initial `start()`
 * and every later `followUp()`), and forwards each one's mapped events into
 * one shared, session-lifetime `AsyncQueue` — the thing `Session.events`
 * actually exposes. `sessionRef` is codex's own `thread_id`, learned from
 * `thread.started`, which is reliably the first JSONL line codex ever prints
 * (confirmed across every empirical capture, fresh starts and resumes
 * alike) — `runCodexTurn` below awaits specifically for that line before
 * resolving, mirroring pi's own "resolve a real session id before
 * constructing the Session, fail closed if you can't" discipline
 * (`../pi/pi-adapter.ts`'s `resolveFreshSessionId`, finding F8).
 */
export class CodexAdapter implements RuntimeAdapter {
  readonly id = 'codex';

  constructor(private readonly options: CodexAdapterOptions = {}) {}

  async detect(): Promise<RuntimeDetectResult> {
    const bin = this.resolveBin();
    try {
      const versionResult = await execFileAsync(bin.command, ['--version'], { timeout: DETECT_TIMEOUT_MS });
      const version = versionResult.stdout.trim() || versionResult.stderr.trim();
      const authPresent = await this.probeAuthPresent(bin);
      return { present: true, version, authPresent };
    } catch {
      return { present: false };
    }
  }

  /**
   * `authPresent` without ever reading `~/.codex/auth.json` (credential-
   * isolation rule, `../../types.ts`): spawns codex's OWN `login status`
   * subcommand and interprets its human-readable report — the exact
   * "non-secret signal" this adapter is required to use, and cleaner than
   * pi's env-var-name check since codex's real credential model (on the
   * reference machine) is a ChatGPT OAuth session, not an env var.
   *
   * Two independently-verified channel gotchas apply here, the "pi lesson"
   * yet again:
   *   - `codex login status`'s human-readable "Logged in using ChatGPT"
   *     message prints on STDERR, not stdout (the opposite-channel
   *     counterpart of pi's own `--version`-goes-to-stderr surprise) — both
   *     streams are checked here for exactly that reason.
   *   - The NOT-logged-in message/exit-code shape was deliberately never
   *     empirically tested: this machine has a real, live ChatGPT login, and
   *     running `codex logout` to observe the negative case would have
   *     broken that login for the rest of this session/machine. The match
   *     below is intentionally conservative (`/logged in (using|with)/i`,
   *     not a bare `"logged in"` substring) specifically because a bare
   *     substring check would false-positive on a plausible negative message
   *     like "Not logged in" (itself containing the substring "logged in").
   *     This is a documented, known gap — flagged for M2-c / a follow-up
   *     empirical pass on a logged-out machine, not asserted as verified.
   */
  private async probeAuthPresent(bin: ResolvedBin): Promise<boolean> {
    try {
      const result = await execFileAsync(bin.command, ['login', 'status'], { timeout: DETECT_TIMEOUT_MS });
      return /logged in (using|with)/i.test(`${result.stdout}\n${result.stderr}`);
    } catch (err) {
      const withStreams = err as { stdout?: string; stderr?: string };
      return /logged in (using|with)/i.test(`${withStreams.stdout ?? ''}\n${withStreams.stderr ?? ''}`);
    }
  }

  capabilities(): RuntimeCapabilities {
    return { steer: false, resume: true, permissionModes: ['auto', 'readonly'] };
  }

  async start(task: TaskOfferPayload, ctx: TaskContext): Promise<Session> {
    if (typeof task.instruction !== 'string') {
      throw new PolicyUnsupportedError('codex adapter only supports string instructions in M2 (no blob-ref fetch yet)');
    }

    const mapping = mapPermissionPolicyToCodexArgs(ctx.policy);
    if (!mapping.ok) {
      throw new PolicyUnsupportedError(mapping.reason ?? 'policy rejected by codex adapter');
    }

    const bin = this.resolveBin();
    const queue = new AsyncQueue<AgentEvent>();
    const recordUnmapped = makeUnmappedFrameRecorder(new Map<string, number>());

    // Realpath'd once, up front — see `resolveRealWorkspaceDir`'s doc
    // comment for why this matters even on a single-machine, non-adversarial
    // path (unlike task-runner.ts's own realpath use, which is defending
    // against symlink swaps): `file_change` items report codex's own
    // absolute paths, built from the CHILD PROCESS's `process.cwd()`, which
    // Node/the OS resolve through any symlink in `ctx.workspaceDir` — a
    // stock `os.tmpdir()`-based workspace on macOS (`/var/folders/...`,
    // itself a symlink to `/private/var/folders/...`) hits this on literally
    // every run, not just a contrived edge case.
    const workspaceDir = await resolveRealWorkspaceDir(ctx.workspaceDir);

    const { sessionRef, runner } = await runCodexTurn({
      command: bin.command,
      resumeRef: task.sessionRef,
      instruction: task.instruction,
      policyArgs: mapping.args,
      cwd: ctx.workspaceDir,
      env: ctx.env,
      spawnFn: this.options.spawnFn,
      workspaceDir,
      queue,
      recordUnmapped,
      expectedSessionRef: task.sessionRef,
    });

    return new CodexSession({
      sessionRef,
      command: bin.command,
      workspaceDir,
      env: ctx.env,
      spawnFn: this.options.spawnFn,
      queue,
      recordUnmapped,
      initialRunner: runner,
    });
  }

  private resolveBin(): ResolvedBin {
    return (this.options.resolveBin ?? resolveCodexBin)();
  }
}

/**
 * Self-discovered finding while building this adapter's own test suite
 * (caught by a real timeout, not inspection): `fs.mkdtemp(path.join(os.
 * tmpdir(), ...))` on macOS returns a path through `/var/folders/...`, which
 * is itself a symlink to `/private/var/folders/...` — confirmed with a
 * direct probe (`fs.realpathSync(os.tmpdir())`). A child process spawned
 * with `cwd` set to the *symlinked* form still reports the *realpath'd* form
 * from its own `process.cwd()` (confirmed with a dedicated spawn probe) —
 * and `file_change` items build their absolute `path` from exactly that.
 * Without this, `events.ts`'s `extractArtifactEvents` would compute a
 * `path.relative(workspaceDir, absolutePath)` full of `../` segments for a
 * file genuinely inside the workspace, trip its own outside-the-workspace
 * safety check, and silently drop the artifact event — not a contrived edge
 * case, but the literal default shape of any workspace root built from
 * `os.tmpdir()` on macOS. Mirrors task-runner.ts's own `openArtifact`, which
 * realpaths its workspace root for the identical reason (there, defending
 * against a symlink swap; here, just matching what the child process's own
 * OS-resolved cwd will report) — same fallback too: a realpath failure
 * (workspace deleted out from under it, etc.) falls through to the original
 * path unchanged rather than failing the whole turn over it.
 */
async function resolveRealWorkspaceDir(workspaceDir: string): Promise<string> {
  return fs.realpath(workspaceDir).catch(() => workspaceDir);
}

/** Count of codex frame "keys" (see `unmappedFrameKey`) this session has told us have no `AgentEvent` mapping and aren't routine bookkeeping — i.e. genuinely unexpected traffic. Logs once per distinct key, mirroring `PiRpcClient.recordUnmappedFrame`'s exact reasoning: this is the mechanism that turns a future regression (like this task's own root-cause "read `thread.started` on every line, not just the first" class of bug would have been) into an immediate, self-diagnosing warning instead of a silent drop. */
function makeUnmappedFrameRecorder(counts: Map<string, number>): (key: string) => void {
  return (key: string): void => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    if (next === 1) {
      console.warn(
        `[byok/codex-adapter] codex emitted a frame with no AgentEvent mapping: "${key}" (further occurrences of this type won't be logged individually)`,
      );
    }
  };
}

interface RunTurnParams {
  command: string;
  resumeRef: string | undefined;
  instruction: string;
  policyArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnFn: SpawnFn | undefined;
  workspaceDir: string;
  queue: AsyncQueue<AgentEvent>;
  recordUnmapped: (key: string) => void;
  /**
   * When resuming, the sessionRef this call expects codex to echo back in
   * `thread.started` — required for BOTH `start()`'s externally-supplied
   * `task.sessionRef` and `followUp()`'s own previously-recorded
   * `sessionRef` (see `CodexSession.followUp`'s doc comment for why the
   * latter also passes this now). Fail-closed on a mismatch: the
   * already-spawned runner for this attempt is killed and the call throws
   * rather than silently adopting whatever id codex actually reported —
   * this is a real check, not just a diagnostic log.
   */
  expectedSessionRef?: string | undefined;
}

interface RunTurnResult {
  sessionRef: string;
  runner: CodexProcessRunner;
}

/**
 * `--skip-git-repo-check` is unconditional here, not policy-derived: real
 * `codex exec` (confirmed live, via this adapter's own e2e run against a
 * plain non-git scratch workspace) refuses to run at all outside a Git
 * repository — "Not inside a trusted directory and --skip-git-repo-check
 * was not specified", exit 1, no JSONL emitted — unless this flag is passed.
 * `task-runner.ts`'s `resolveWorkspaceDir` creates plain directories
 * (`fs.mkdir(dir, {recursive:true})`), never a git repo, so without this
 * every single real task would fail closed on this unrelated precondition
 * before codex ever saw the actual instruction. It carries no sandbox/
 * approval semantics of its own (purely a "do you want the git-repo safety
 * net" gate) — confirmed via `codex exec --help`, which documents it
 * separately from every sandbox/approval flag — so it's safe to always
 * include rather than threading it through `permission-mapping.ts`.
 */
function buildArgv(resumeRef: string | undefined, policyArgs: string[], instruction: string): string[] {
  const base = resumeRef !== undefined ? ['exec', 'resume', resumeRef] : ['exec'];
  return [...base, '--json', '--skip-git-repo-check', ...policyArgs, instruction];
}

/**
 * Spawn one `codex exec`/`codex exec resume` turn, await its first line
 * (must be `thread.started` — fail closed otherwise, never fabricate a
 * `sessionRef`, mirroring `../pi/pi-adapter.ts`'s finding F8), then keep
 * pumping the rest of that process's output into `params.queue` in the
 * background for as long as it runs. Shared by both `CodexAdapter.start()`
 * (a fresh turn, or a resume-via-`task.sessionRef`) and
 * `CodexSession.followUp()` (always a resume).
 */
async function runCodexTurn(params: RunTurnParams): Promise<RunTurnResult> {
  const argv = buildArgv(params.resumeRef, params.policyArgs, params.instruction);

  let firstLineSettled = false;
  let resolveFirstLine!: (ref: string) => void;
  let rejectFirstLine!: (err: Error) => void;
  const firstLine = new Promise<string>((resolve, reject) => {
    resolveFirstLine = resolve;
    rejectFirstLine = reject;
  });

  // Set once THIS turn's own mapped events include an explicit `turn_end` —
  // see the `waitClosed()` watcher below (cross-model review finding, the
  // "pi-hang class") for why this matters: `turn_end` already told
  // task-runner.ts's `pump()` this specific turn is done, so the shared
  // session-lifetime queue must stay open afterward (a later `followUp()`
  // reuses this exact same queue — see `CodexSession` below).
  let turnEnded = false;

  const runner = new CodexProcessRunner({
    command: params.command,
    args: argv,
    cwd: params.cwd,
    env: params.env,
    spawnFn: params.spawnFn,
    onEvent: (evt: CodexRawEvent) => {
      if (!firstLineSettled) {
        firstLineSettled = true;
        if (evt.type === 'thread.started' && typeof evt.thread_id === 'string' && evt.thread_id.length > 0) {
          resolveFirstLine(evt.thread_id);
        } else {
          rejectFirstLine(
            new Error(`codex did not yield thread.started as its first event (got ${JSON.stringify(evt).slice(0, 200)})`),
          );
        }
        return;
      }
      const mapped = mapCodexEventToAgentEvents(evt, params.workspaceDir);
      for (const agentEvent of mapped) {
        if (agentEvent.type === 'turn_end') turnEnded = true;
        params.queue.push(agentEvent);
      }
      if (mapped.length === 0 && !isRoutineCodexEvent(evt)) {
        params.recordUnmapped(unmappedFrameKey(evt));
      }
    },
  });

  /**
   * Cross-model review finding (the "pi-hang class" — a task that never
   * completes): `codex exec` is one-shot PER TURN (see this module's own
   * doc comment) — a failed turn (`turn.failed`, mapped to an `error`
   * AgentEvent, deliberately NOT a `turn_end`) or any other unexpected exit
   * (crash, an `interrupt()`-triggered SIGTERM) ends the child process
   * without ever producing the one signal task-runner.ts's `pump()` treats
   * as terminal. Nothing else in this file ever called `params.queue.end()`
   * for that case — confirmed reproducible: the events async-iterable's
   * `next()` stays pending forever, 250ms+ after the process has already
   * exited. pi's own `PiRpcClient.onClosed` (`../pi/rpc-client.ts`)
   * unconditionally ends its eventQueue on process close — correct THERE
   * because pi is one long-lived process for a WHOLE session (closing means
   * the whole session is over). Codex is architecturally different: a fresh
   * process per turn, sharing ONE session-lifetime queue across turns (see
   * `CodexSession.followUp()`) — unconditionally ending it here would wrongly
   * terminate a session a later `followUp()` is about to keep using. So:
   * only when THIS turn never reached `turn_end` do we surface a terminal
   * `error` AgentEvent (exit code/signal + stderr ring tail via
   * `buildExitError` — the real reason, never fabricated) and end the queue.
   * `waitClosed()` never rejects (see process-runner.ts), so no `.catch()`
   * is needed; pushing/ending an already-ended queue (e.g. `close()` beat
   * this watcher to it) is a harmless no-op (`AsyncQueue` is idempotent).
   */
  void runner.waitClosed().then(() => {
    if (turnEnded) return;
    params.queue.push({ type: 'error', message: runner.buildExitError('codex exited without completing the turn').message });
    params.queue.end();
  });

  // Race the first line against the process closing before ever producing
  // one (bad flag, ENOENT, an unknown resume id — "Error: thread/resume:
  // ... no rollout found for thread id ..." — all empirically confirmed to
  // exit fast with no JSONL at all, never a hang). Built as an explicit
  // executor rather than `Promise.race` so the "losing" side can never
  // become an unhandled rejection: `runner.waitClosed()` itself only ever
  // resolves (see process-runner.ts), and `firstLine` always has its
  // resolve/reject consumed below regardless of which settles first.
  let sessionRef: string;
  try {
    sessionRef = await new Promise<string>((resolve, reject) => {
      let settled = false;
      firstLine.then(
        (ref) => {
          if (!settled) {
            settled = true;
            resolve(ref);
          }
        },
        (err: unknown) => {
          if (!settled) {
            settled = true;
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
      );
      void runner.waitClosed().then(() => {
        if (!settled) {
          settled = true;
          reject(runner.buildExitError('codex exited before yielding an authoritative thread id'));
        }
      });
    });
  } catch (err) {
    runner.kill();
    throw err;
  }

  // Cross-model review finding: this used to only `console.warn` and
  // continue on a mismatch — "a runtime silently falling back to a
  // different session runs the task in the WRONG context." `expectedSessionRef`
  // here is always an EXTERNALLY supplied ask (`CodexAdapter.start()`'s
  // `task.sessionRef`, from the server/daemon — never `CodexSession
  // .followUp()`, which intentionally omits it; see that method's own doc
  // comment for why its own internal resume is handled differently). A
  // mismatch against an external expectation means this adapter can no
  // longer trust that codex resumed the workspace/history the caller
  // actually meant — fail closed rather than quietly proceeding.
  if (params.expectedSessionRef !== undefined && sessionRef !== params.expectedSessionRef) {
    runner.kill();
    throw new Error(
      `codex exec resume echoed a different thread id than requested (requested ${params.expectedSessionRef}, got ${sessionRef}) — refusing to continue in a possibly-wrong session (fail-closed)`,
    );
  }

  return { sessionRef, runner };
}

interface CodexSessionOptions {
  sessionRef: string;
  command: string;
  workspaceDir: string;
  env: NodeJS.ProcessEnv;
  spawnFn: SpawnFn | undefined;
  queue: AsyncQueue<AgentEvent>;
  recordUnmapped: (key: string) => void;
  initialRunner: CodexProcessRunner;
}

class CodexSession implements Session {
  /**
   * NOT `readonly` (cross-model review finding): `followUp()` below
   * re-assigns this from the runtime's own CONFIRMED reflected id on each
   * resume — see its own doc comment. Silently keeping the value captured at
   * construction time was the original bug (the NEW id `runCodexTurn`
   * returns was discarded, so every later `followUp()` kept resuming the
   * OLD, potentially stale, id); that stays fixed here. A LATER cross-model
   * re-review found the fix above was itself incomplete: `followUp()` now
   * also verifies the reflected id matches what it asked to resume BEFORE
   * this field is touched — a mismatch throws (fail-closed) instead of ever
   * reaching this assignment, so `sessionRef` only ever advances to an id
   * codex has proven it actually resumed, never one it silently swapped in.
   */
  public sessionRef: string;
  private readonly command: string;
  private readonly workspaceDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnFn: SpawnFn | undefined;
  private readonly queue: AsyncQueue<AgentEvent>;
  private readonly recordUnmapped: (key: string) => void;
  private currentRunner: CodexProcessRunner | undefined;
  private closed = false;

  constructor(options: CodexSessionOptions) {
    this.sessionRef = options.sessionRef;
    this.command = options.command;
    this.workspaceDir = options.workspaceDir;
    this.env = options.env;
    this.spawnFn = options.spawnFn;
    this.queue = options.queue;
    this.recordUnmapped = options.recordUnmapped;
    this.currentRunner = options.initialRunner;
    void this.forgetRunnerOnceClosed(options.initialRunner);
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  private async forgetRunnerOnceClosed(runner: CodexProcessRunner): Promise<void> {
    await runner.waitClosed();
    if (this.currentRunner === runner) this.currentRunner = undefined;
  }

  /**
   * New turn, same session, via the real resume mechanism (`codex exec
   * resume <sessionRef> ...`). Maps `task.policy` FRESH on every call — a
   * deliberate, evidence-based divergence from pi's own `followUp()`
   * (`../pi/pi-adapter.ts`), which ignores `task.policy` entirely and relies
   * on argv baked in once at `start()`. That's safe for pi only because pi
   * reuses one already-running RPC process for its whole session lifetime,
   * so there is nothing to re-apply. codex has no such invariant: a resume
   * spawns a BRAND NEW process, and empirically that new process does NOT
   * inherit the sandbox mode the session originally started with (see this
   * file's module doc comment) — omitting a fresh, explicit mapping here
   * would silently run the follow-up turn under this machine's ambient codex
   * config default instead of the policy this specific follow-up was
   * offered under, exactly the silent-widen failure mode this adapter exists
   * to prevent.
   *
   * Cross-model RE-review finding (this corrects the previous wave's own
   * reasoning, quoted below for context): `expectedSessionRef` IS now passed
   * to `runCodexTurn`, set to the exact id this call asked to resume
   * (`resumeRef`, captured up front before the call). The previous version
   * of this method deliberately omitted it — "this resume targets OUR OWN
   * previously-recorded `sessionRef`, not an externally supplied server
   * expectation crossing a trust boundary... whatever id codex reports back
   * for THIS resume is unambiguously the current, authoritative id for this
   * session" — but that reasoning let a resume-A/reports-B mismatch silently
   * MIGRATE this session's identity instead of failing closed: codex has no
   * documented contract for re-keying a thread on resume, so a mismatch here
   * must be treated as an error, exactly like `start()`'s own
   * `task.sessionRef` comparison (see `runCodexTurn`'s doc comment on that
   * check) — never silently adopted. `runCodexTurn` kills the (failed) new
   * runner and throws on a mismatch, BEFORE `sessionRef`/`currentRunner`
   * below are ever touched — so a thrown mismatch leaves this session in its
   * previous, still-good state rather than partially migrated. The
   * `sessionRef` return value is still captured and re-assigned below (the
   * ORIGINAL bug this fixes, one wave further back: the return value used to
   * be discarded entirely, so every later `followUp()` kept resuming a
   * stale id even after codex had moved on) — it just can now only ever be
   * the SAME id this call asked to resume, never a silently-different one.
   */
  async followUp(task: TaskOfferPayload): Promise<void> {
    if (typeof task.instruction !== 'string') {
      throw new PolicyUnsupportedError('codex adapter only supports string instructions in M2 (no blob-ref fetch yet)');
    }
    if (this.closed) {
      throw new Error('cannot follow up on a closed codex session');
    }

    const mapping = mapPermissionPolicyToCodexArgs(task.policy);
    if (!mapping.ok) {
      throw new PolicyUnsupportedError(mapping.reason ?? 'policy rejected by codex adapter');
    }

    const resumeRef = this.sessionRef;
    const { sessionRef, runner } = await runCodexTurn({
      command: this.command,
      resumeRef,
      instruction: task.instruction,
      policyArgs: mapping.args,
      cwd: this.workspaceDir,
      env: this.env,
      spawnFn: this.spawnFn,
      workspaceDir: this.workspaceDir,
      queue: this.queue,
      recordUnmapped: this.recordUnmapped,
      expectedSessionRef: resumeRef,
    });
    this.sessionRef = sessionRef;
    this.currentRunner = runner;
    void this.forgetRunnerOnceClosed(runner);
  }

  /** Best-effort abort of the current turn. SIGTERM's the currently-running child, if any — see `process-runner.ts`'s `kill()` doc comment for why SIGTERM (not SIGINT) and why this is safe: the underlying codex thread survives and stays resumable, confirmed empirically. A no-op when no turn is currently in flight. */
  async interrupt(): Promise<void> {
    this.currentRunner?.kill();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.currentRunner?.kill();
    this.queue.end();
  }

  /**
   * `codex exec` has no in-band channel to inject text into an already-
   * running turn — confirmed empirically, not assumed: there is no stdin
   * protocol (stdin is never even piped to the child — see
   * `process-runner.ts`'s module doc comment), SIGINT (a plausible
   * interrupt-and-redirect signal) is silently ignored outright, and `codex
   * exec resume` only ever starts a brand NEW turn strictly after the
   * current one has fully finished — it cannot inject into one still in
   * flight. Throws honestly rather than silently no-op-ing, matching this
   * task's explicit instruction and `capabilities().steer === false` above.
   */
  async steer(): Promise<void> {
    throw new Error(
      'codex adapter does not support steer: codex exec has no in-band channel to inject text into a running turn (no stdin protocol, SIGINT is ignored, and resume only starts a new turn after the current one finishes)',
    );
  }

  /**
   * `codex exec` never emits a `needs_approval`-equivalent event on the wire
   * — confirmed empirically (see `events.ts`'s module doc comment): a
   * sandbox-denied action resolves the approval decision internally with no
   * pause an external caller could ever observe or answer, regardless of
   * `approval_policy`. Since this session can therefore never have emitted a
   * `needs_approval` `AgentEvent` in the first place, a caller reaching this
   * method implies something upstream expected approval support that isn't
   * there — thrown as a descriptive error rather than a silent no-op,
   * mirroring `../pi/pi-adapter.ts`'s identical `resolveApproval`.
   */
  async resolveApproval(): Promise<void> {
    throw new Error(
      'codex adapter does not support approval resume: codex exec never emits a needs_approval-equivalent event (sandbox-denied actions resolve internally with no wire-visible pause)',
    );
  }
}
