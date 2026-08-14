import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { RuntimeDisposalFailure } from '../runtime-failure';
import { walkTaskkillPidSet } from './taskkill-pid-set';

const DEFAULT_TERM_GRACE_MS = 750;
const DEFAULT_KILL_GRACE_MS = 2_000;
const POLL_MS = 20;

type KillFn = (pid: number, signal: NodeJS.Signals | number) => void;

interface OwnedTerminationState {
  /** True only once a termination request actually reached the OS. A request that could not be spawned leaves this false so disposal re-issues it and surfaces the typed failure. */
  requested: boolean;
  /** win32 only: the process ids `taskkill /T /F` reported walking. This set — not taskkill's exit status — is what disposal measures for quiescence. */
  acceptedPids: Set<number>;
}

const terminationState = new WeakMap<ChildProcess, OwnedTerminationState>();

function stateFor(child: ChildProcess): OwnedTerminationState {
  const existing = terminationState.get(child);
  if (existing) return existing;
  const created: OwnedTerminationState = { requested: false, acceptedPids: new Set<number>() };
  terminationState.set(child, created);
  return created;
}

export interface OwnedProcessTreeOptions {
  child: ChildProcess;
  waitClosed: () => Promise<void>;
  isClosed: () => boolean;
  label: string;
  termGraceMs?: number;
  killGraceMs?: number;
  /** DI seam — defaults to `process.platform`. Lets the win32 branch be exercised from POSIX CI, mirroring `util/secure-dir.ts`'s identical convention. */
  platform?: NodeJS.Platform;
  /** DI seam for the win32 `taskkill` sweep — defaults to `node:child_process`'s `spawn`. */
  spawnFn?: typeof spawn;
  /** DI seam for liveness probing — defaults to `process.kill`. */
  killFn?: KillFn;
}

function defaultKill(pid: number, signal: NodeJS.Signals | number): void {
  process.kill(pid, signal);
}

/**
 * Every bundled runtime root is an owned process-group leader on POSIX. Pipes
 * remain referenced, so `detached` changes ownership topology without making
 * the runtime outlive the daemon. Windows uses taskkill's `/T` tree authority.
 */
export function withOwnedProcessTree<T extends SpawnOptions>(options: T): T {
  return {
    ...options,
    ...(process.platform === 'win32' ? { windowsHide: true } : { detached: true }),
  };
}

function positivePid(child: ChildProcess, label: string): number | undefined {
  const pid = child.pid;
  if (pid === undefined) return undefined;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new RuntimeDisposalFailure({
      stage: 'signal',
      reason: `${label} runtime process has an unsafe owned pid`,
    });
  }
  return pid;
}

function groupExists(pid: number, label: string, kill: KillFn): boolean {
  try {
    kill(-pid, 0);
    return true;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw new RuntimeDisposalFailure({
      stage: 'quiescence',
      reason: `${label} runtime process-group state could not be verified`,
    }, { cause });
  }
}

/** win32 counterpart of {@link groupExists} for one walked pid; EPERM carries the identical "taken by a live process" reading. */
function processExists(pid: number, label: string, kill: KillFn): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw new RuntimeDisposalFailure({
      stage: 'quiescence',
      reason: `${label} runtime process ${pid} state could not be verified`,
    }, { cause });
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals, label: string, kill: KillFn): void {
  try {
    kill(-pid, signal);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    // macOS can transiently report EPERM for an orphaned group containing
    // only processes already exiting. It is not success: the quiescence
    // poll below must still prove the group disappears before close settles.
    if (code === 'ESRCH' || code === 'EPERM') return;
    throw new RuntimeDisposalFailure({
      stage: 'signal',
      reason: `${label} runtime process group ${pid} could not receive ${signal} (${code ?? 'unknown'})`,
    }, { cause });
  }
}

/**
 * Runs `taskkill /PID <pid> /T /F` and returns its combined output.
 *
 * The exit status is deliberately never read: taskkill reports non-zero for a
 * root that already exited, which is quiescence rather than a failed request.
 * Only a taskkill that could not be SPAWNED is a `stage:'signal'` failure —
 * everything else is decided by measuring the walked pid set afterwards.
 *
 * Output is captured as raw bytes and decoded latin1; see
 * `./taskkill-pid-set.ts` for why that is the byte-safe choice under every
 * console OEM codepage.
 */
async function runTaskkill(pid: number, options: OwnedProcessTreeOptions): Promise<string> {
  const spawnFn = options.spawnFn ?? spawn;
  return new Promise<string>((resolve, reject) => {
    const signalFailure = (cause: unknown): void => {
      reject(new RuntimeDisposalFailure({
        stage: 'signal',
        reason: `${options.label} runtime process tree termination could not be requested`,
      }, { cause }));
    };
    let taskkill: ChildProcess;
    try {
      taskkill = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (cause) {
      signalFailure(cause);
      return;
    }
    const chunks: Buffer[] = [];
    taskkill.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    taskkill.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
    // A failed spawn emits `error` before `close`, so the first settle is the
    // failure; a spawned taskkill settles on `close`, after every byte arrived.
    taskkill.once('error', signalFailure);
    taskkill.once('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
  });
}

/** win32: the subset of the walked pid set that is still holding a live process. */
function liveAcceptedPids(accepted: Iterable<number>, label: string, kill: KillFn): number[] {
  const live: number[] = [];
  for (const pid of accepted) {
    if (processExists(pid, label, kill)) live.push(pid);
  }
  return live;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
  return true;
}

async function waitWithDeadline(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
    void promise.then(
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(true);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      },
    );
  });
}

/**
 * Immediate termination request used by interrupt paths; close remains the
 * receipt. On win32 the request also RECORDS the pid set taskkill walked,
 * which is what {@link disposeOwnedProcessTree} later measures — so an
 * interrupt that is fired and forgotten still leaves disposal a measurable
 * tree. A request that could not be spawned records nothing, which makes
 * disposal re-issue it and surface `stage:'signal'` itself.
 */
export async function requestOwnedProcessTreeTermination(options: OwnedProcessTreeOptions): Promise<void> {
  const platform = options.platform ?? process.platform;
  // win32 deliberately has NO `isClosed()` short-circuit: a root that exited on
  // its own leaves descendants Windows never re-parents, so skipping the walk
  // here would let disposal claim quiescence it never measured. A dead root
  // simply makes taskkill report nothing beyond itself — a cheap sweep for a
  // measured receipt. POSIX keeps the short-circuit: its group signal is
  // already the whole-tree operation.
  if (platform !== 'win32' && options.isClosed()) return;
  const pid = positivePid(options.child, options.label);
  if (pid === undefined) return;
  if (platform === 'win32') {
    const output = await runTaskkill(pid, options);
    const state = stateFor(options.child);
    // The root's own line names THIS process as its parent; accepting that pid
    // would make quiescence unreachable by construction.
    for (const walked of walkTaskkillPidSet(output, pid, [process.pid])) state.acceptedPids.add(walked);
    state.requested = true;
    return;
  }
  signalGroup(pid, 'SIGTERM', options.label, options.killFn ?? defaultKill);
  stateFor(options.child).requested = true;
}

/**
 * Resolve only after the adapter-owned root and descendants are quiescent.
 *
 * POSIX measures the owned process GROUP; win32 measures the pid set taskkill
 * reported walking (`stage:'quiescence'` names how many of those were still
 * alive at the deadline). Neither platform reads a terminator's exit status:
 * on win32 `stage:'signal'` now means only that taskkill could not be spawned.
 * `close` stays the final receipt on both — it is the stdio-flush guarantee,
 * not the liveness proof.
 *
 * Grace budget: each phase carries its own full grace on both platforms. On
 * win32 the quiescence poll gets `killGraceMs` and the close wait that follows
 * gets a fresh `killGraceMs`; POSIX likewise gives the SIGTERM wait
 * `termGraceMs`, the SIGKILL wait `killGraceMs`, and the close wait another
 * `killGraceMs`. Worst-case disposal is therefore bounded by the sum, never by
 * one shared deadline that could starve the close wait after a slow drain.
 *
 * Residual boundary, stated honestly. Three cases this mechanism cannot cover:
 * a descendant whose intermediate parent died before any sweep observed it is
 * unreachable, because Windows does not re-parent orphans — nothing in the
 * surviving tree links back to it and `taskkill /T` cannot find it. The same
 * window means a recycled pid could read as alive. And if taskkill's output is
 * empty or unparseable, the walked set collapses to `{root}`: disposal then
 * measures the root alone and reports quiescence on that basis, which is a
 * narrower claim than the tree, not a false one. Preventing orphans left behind
 * by a DAEMON crash is a separate job-object concern, explicitly out of scope.
 */
export async function disposeOwnedProcessTree(options: OwnedProcessTreeOptions): Promise<void> {
  const pid = positivePid(options.child, options.label);
  const termGraceMs = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const platform = options.platform ?? process.platform;
  const kill = options.killFn ?? defaultKill;

  if (pid === undefined) {
    if (await waitWithDeadline(options.waitClosed(), killGraceMs)) return;
    throw new RuntimeDisposalFailure({
      stage: 'quiescence',
      reason: `${options.label} runtime process did not settle after spawn failure`,
    });
  }

  if (platform === 'win32') {
    // No `isClosed()` guard: at least one taskkill walk must precede any
    // quiescence claim, or a root that exited on its own would let unmeasured
    // descendants pass as quiescent.
    if (!terminationState.get(options.child)?.requested) {
      await requestOwnedProcessTreeTermination(options);
    }
    const accepted = terminationState.get(options.child)?.acceptedPids ?? new Set<number>();
    const deadline = Date.now() + killGraceMs;
    const resweepAt = Date.now() + Math.floor(killGraceMs / 2);
    let reswept = false;
    let live = liveAcceptedPids(accepted, options.label, kill);
    while (live.length > 0) {
      if (Date.now() >= deadline) {
        throw new RuntimeDisposalFailure({
          stage: 'quiescence',
          reason: `${options.label} runtime process tree did not quiesce: ${live.length} of ${accepted.size} walked process ids were still alive at the disposal deadline`,
        });
      }
      if (!reswept && Date.now() >= resweepAt) {
        reswept = true;
        // Re-issue against what is still live rather than the original root:
        // an intermediate that has since exited would hide its own subtree.
        for (const livePid of live) {
          for (const walked of walkTaskkillPidSet(await runTaskkill(livePid, options), livePid, [process.pid])) {
            accepted.add(walked);
          }
        }
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, POLL_MS);
      });
      live = liveAcceptedPids(accepted, options.label, kill);
    }
    if (!(await waitWithDeadline(options.waitClosed(), killGraceMs))) {
      throw new RuntimeDisposalFailure({
        stage: 'quiescence',
        reason: `${options.label} runtime root did not emit close after its process tree quiesced`,
      });
    }
    return;
  }

  if (groupExists(pid, options.label, kill) && !terminationState.get(options.child)?.requested) {
    signalGroup(pid, 'SIGTERM', options.label, kill);
    stateFor(options.child).requested = true;
  }
  if (!(await waitUntil(() => groupExists(pid, options.label, kill), termGraceMs))) {
    signalGroup(pid, 'SIGKILL', options.label, kill);
    if (!(await waitUntil(() => groupExists(pid, options.label, kill), killGraceMs))) {
      throw new RuntimeDisposalFailure({
        stage: 'quiescence',
        reason: `${options.label} runtime process group remained live after SIGKILL`,
      });
    }
  }
  if (!(await waitWithDeadline(options.waitClosed(), killGraceMs))) {
    throw new RuntimeDisposalFailure({
      stage: 'quiescence',
      reason: `${options.label} runtime root did not emit close after its process group exited`,
    });
  }
}
