import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { RuntimeDisposalFailure } from '../runtime-failure';
import { walkTaskkillPidSet } from './taskkill-pid-set';
// OAR 0.37.0 `shared/executable/process-tree.ts`, vendored with upstream bytes.
import { descendantsOf, killEntries, readProcessTable, type ProcessEntry, type ProcessTable } from '../runtime/oar-process-tree.js';

const DEFAULT_TERM_GRACE_MS = 750;
const DEFAULT_KILL_GRACE_MS = 2_000;
const POLL_MS = 20;

export type KillFn = (pid: number, signal: NodeJS.Signals | number) => void;

interface OwnedTerminationState {
  /** True only once a termination request actually reached the OS. A request that could not be spawned leaves this false so disposal re-issues it and surfaces the typed failure. */
  requested: boolean;
  /** win32 only: the process ids `taskkill /T /F` reported walking. This set — not taskkill's exit status — is what disposal measures for quiescence. */
  acceptedPids: Set<number>;
  /** POSIX only: the root's descendants read just before the SIGTERM, those that left its group included, until they have had their SIGKILL. */
  descendants: readonly ProcessEntry[];
}

const terminationState = new WeakMap<ChildProcess, OwnedTerminationState>();

function stateFor(child: ChildProcess): OwnedTerminationState {
  const existing = terminationState.get(child);
  if (existing) return existing;
  const created: OwnedTerminationState = { requested: false, acceptedPids: new Set<number>(), descendants: [] };
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

/** One live owned tree the host-exit backstop is responsible for, frozen at adoption time. */
interface HostExitTarget {
  pid: number;
  label: string;
  platform: NodeJS.Platform;
  kill: KillFn;
  spawnSyncFn: typeof spawnSync;
}

/**
 * Every owned tree that has been adopted and has not yet closed.
 *
 * Module level, not per-client: the backstop is a property of THIS process,
 * and one `exit` listener sweeping one registry is the only shape that can
 * stay synchronous. Keyed by the child so `close`/`exit` deregistration is
 * exact and a recycled pid can never resurrect a dead entry.
 */
const hostExitTargets = new Map<ChildProcess, HostExitTarget>();
let hostExitHandlerInstalled = false;

/**
 * The `exit` listener itself. Three constraints, all load-bearing:
 * it never awaits (Node runs nothing asynchronous after `exit` begins), it
 * never throws (a throw here would replace the host's own exit reason), and
 * each target is swept in its own try/catch so one unreachable tree cannot
 * strand the rest. POSIX kills the owned process GROUP — `withOwnedProcessTree`
 * made the root a group leader precisely so this one signal reaches the whole
 * group — and, for a root still running, the descendants that left the group
 * and their groups, from one synchronous process-table read. win32 has no
 * process groups to signal, so it pays for a synchronous `taskkill /T /F` per
 * target.
 */
function terminateOwnedTreesForHostExit(): void {
  // One read of the process table serves every target (OAR 0.37.0 `ownership.ts`).
  let table: ProcessTable | null = null;
  const read = (): ProcessTable => {
    table ??= readProcessTable();
    return table;
  };
  for (const [child, target] of hostExitTargets) {
    try {
      if (target.platform === 'win32') {
        target.spawnSyncFn('taskkill', ['/PID', String(target.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        // Its descendants outside its group too, found below it only while it
        // runs: a reaped pid may already be someone else's.
        if (isRunning(child)) killEntries(descendantsOf(read(), target.pid), read());
        target.kill(-target.pid, 'SIGKILL');
      }
    } catch {
      // Host exit cannot await, report, or retry one target; continue with the rest.
    }
  }
  hostExitTargets.clear();
}

function ensureHostExitHandler(): void {
  if (hostExitHandlerInstalled) return;
  hostExitHandlerInstalled = true;
  // `prependListener`: a host `exit` listener installed by embedding code may
  // itself be slow or throwing, and the trees must be gone either way.
  process.prependListener('exit', terminateOwnedTreesForHostExit);
}

/**
 * Test-only view of the host-exit backstop. Not part of any package entry
 * point (`process-tree.ts` is internal to `@byok-sdk/client`); it exists so
 * the registry contract can be asserted without a second production seam.
 */
export const __hostExitBackstopForTests = {
  /** The exact function Node invokes on `exit`. */
  run: terminateOwnedTreesForHostExit,
  registeredPids(): number[] {
    return [...hostExitTargets.values()].map((target) => target.pid);
  },
  listenerCount(): number {
    return process.listeners('exit').filter((listener) => listener === terminateOwnedTreesForHostExit).length;
  },
};

/**
 * POSIX only: what a daemon must remember about one adopted tree to end it
 * after the daemon itself was SIGKILLed or OOM-killed — the owned group's id
 * and its root's start time from the process table, which tells the root from
 * a later process given the same pid. Deliberately nothing that names a
 * command line or a path.
 */
export interface OwnedProcessGroupRecord {
  readonly pgid: number;
  readonly rootStart: string;
}

/**
 * The durable side of {@link OwnedProcessGroupRecord}: `adopted` once a tree is
 * owned, `disposed` once {@link disposeOwnedProcessTree} has proved its group
 * gone. Implementations own their persistence errors; a rejection here would
 * fail the adoption or the disposal it reports.
 */
export interface OwnedProcessGroupLedger {
  adopted(record: OwnedProcessGroupRecord): Promise<void>;
  disposed(record: OwnedProcessGroupRecord): Promise<void>;
}

/** Module level for the same reason as {@link hostExitTargets}: what a daemon death orphans is every tree THIS process adopted. */
const ownedGroupLedgers = new Set<OwnedProcessGroupLedger>();
const ownedGroupRecords = new WeakMap<ChildProcess, OwnedProcessGroupRecord>();

/** Report every POSIX tree adopted from now on to `ledger`, until the returned detach runs. */
export function attachOwnedProcessGroupLedger(ledger: OwnedProcessGroupLedger): () => void {
  ownedGroupLedgers.add(ledger);
  return () => {
    ownedGroupLedgers.delete(ledger);
  };
}

export interface AdoptOwnedProcessTreeOptions {
  child: ChildProcess;
  label: string;
  /** DI seam — defaults to `process.platform`, mirroring {@link OwnedProcessTreeOptions}. */
  platform?: NodeJS.Platform;
  /** DI seam for the win32 job-object backstop — defaults to the lazily imported `./win32-job-object`. */
  jobObject?: { assign(pid: number): Promise<void> };
  /** DI seam for the POSIX host-exit sweep — defaults to `process.kill`. */
  killFn?: KillFn;
  /** DI seam for the win32 host-exit sweep — defaults to `node:child_process`'s `spawnSync`. */
  spawnSyncFn?: typeof spawnSync;
}

/**
 * The default win32 backstop. The dynamic import is the mechanism that keeps
 * `koffi` — and any native addon — out of every non-win32 process: this
 * module is reached only from the win32 branch below, and it imports `koffi`
 * only when its bindings are actually resolved.
 */
const defaultJobObject = {
  async assign(pid: number): Promise<void> {
    const { assignOwnedProcessToJob } = await import('./win32-job-object');
    await assignOwnedProcessToJob(pid);
  },
};

/**
 * Take ownership of a just-spawned runtime tree, beyond what disposal covers.
 *
 * Two backstops with different coverage, both kernel- or runtime-owned rather
 * than sweep-based:
 *
 * 1. Every platform: the tree joins a registry a once-installed, synchronous
 *    `process` `exit` listener sweeps. This covers an ordinary daemon exit —
 *    the case where disposal simply never ran.
 * 2. win32 only: the root is assigned to the daemon-wide
 *    `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` job (see `./win32-job-object.ts`).
 *    That one is the kernel's, so it also covers the daemon deaths no listener
 *    can observe.
 *
 * Fail closed: a rejected assignment propagates, and the caller must terminate
 * the child and refuse to publish a run handle rather than run a tree nothing
 * owns. The registration happens FIRST so a child that fails assignment is
 * still swept if the daemon exits during the caller's cleanup.
 *
 * Residual boundary, stated rather than hidden: assignment happens after
 * `spawn` returns, so a grandchild forked inside that window is outside the
 * job; and neither backstop can run when the daemon itself is SIGKILLed or
 * OOM-killed on POSIX, where only the job object's kernel guarantee — which
 * POSIX does not have — would help. For that case POSIX adoption also hands
 * the attached ledgers an {@link OwnedProcessGroupRecord}, which the next
 * daemon start ends with {@link reapOwnedProcessGroups}. A root that is no
 * longer in the process table when it is read here leaves no record.
 */
export async function adoptOwnedProcessTree(options: AdoptOwnedProcessTreeOptions): Promise<void> {
  const pid = positivePid(options.child, options.label);
  // No pid means `spawn` itself failed; there is no tree to own and the
  // caller's own `error`/`close` path is already the authority.
  if (pid === undefined) return;
  const platform = options.platform ?? process.platform;

  ensureHostExitHandler();
  hostExitTargets.set(options.child, {
    pid,
    label: options.label,
    platform,
    kill: options.killFn ?? defaultKill,
    spawnSyncFn: options.spawnSyncFn ?? spawnSync,
  });
  const forget = (): void => {
    hostExitTargets.delete(options.child);
  };
  // Both events: `close` is the stdio-flush receipt every client waits on, but
  // a child with no piped stdio may only ever emit `exit`.
  options.child.once('close', forget);
  options.child.once('exit', forget);

  if (platform !== 'win32') {
    await recordOwnedGroup(options.child, pid);
    return;
  }
  await (options.jobObject ?? defaultJobObject).assign(pid);
}

async function recordOwnedGroup(child: ChildProcess, pid: number): Promise<void> {
  if (ownedGroupLedgers.size === 0) return;
  const root = readProcessTable().get(pid);
  // `withOwnedProcessTree` made the root its group's leader; anything else is
  // not a group this module owns.
  if (root === undefined || root.pgid !== pid) return;
  const record: OwnedProcessGroupRecord = { pgid: pid, rootStart: root.start };
  ownedGroupRecords.set(child, record);
  await Promise.all([...ownedGroupLedgers].map((ledger) => ledger.adopted(record)));
}

/** The disposal receipt for the durable record: called only once the owned group is proved gone. */
async function forgetOwnedGroup(child: ChildProcess): Promise<void> {
  const record = ownedGroupRecords.get(child);
  if (record === undefined) return;
  ownedGroupRecords.delete(child);
  await Promise.all([...ownedGroupLedgers].map((ledger) => ledger.disposed(record)));
}

export interface OwnedProcessGroupReap {
  /** Recorded groups that still held a process from the run that recorded them. */
  found: number;
  /** Of `found`, those gone after the SIGKILL. */
  terminated: number;
  /** Of `found`, those still holding a process at the deadline. */
  survived: number;
}

/**
 * POSIX: end the owned groups a previous daemon process recorded and could no
 * longer dispose (it was SIGKILLed or OOM-killed). One read of the process
 * table decides each group:
 *
 * - its leader pid is held by a process with a different start time: the pid
 *   was reused, so the group recorded there is already empty (a pid is never
 *   handed out while a group of that id exists) — skipped, nothing signalled;
 * - its leader is this process's own child: owned by a live daemon here — skipped;
 * - its leader is the recorded root, or processes still carry its pgid after
 *   the root exited: SIGKILL them, their groups, and the live root's
 *   descendants that left the group (OAR `killEntries`, which re-checks every
 *   pid's start time and never signals this process or its group).
 *
 * Then the table is read until no killed process and no member of a found
 * group remains, or `killGraceMs` passes. win32 records nothing and reaps
 * nothing. An unreadable table fails closed: nothing can be proved gone.
 */
export async function reapOwnedProcessGroups(
  groups: readonly OwnedProcessGroupRecord[],
  options: { platform?: NodeJS.Platform; killGraceMs?: number } = {},
): Promise<OwnedProcessGroupReap> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32' || groups.length === 0) return { found: 0, terminated: 0, survived: 0 };
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const readable = (table: ProcessTable): boolean => table.has(process.pid);
  const table = readProcessTable();
  if (!readable(table)) {
    throw new RuntimeDisposalFailure({
      stage: 'quiescence',
      reason: 'the process table could not be read to end the previous daemon run’s owned runtime process groups',
    });
  }
  const found: Array<{ pgid: number; entries: ProcessEntry[] }> = [];
  for (const group of groups) {
    const leader = table.get(group.pgid);
    if (leader !== undefined && leader.start !== group.rootStart) continue;
    // A root that is this process's own child is a live tree of a daemon in
    // this process (another daemon sharing the host), never a crash residue.
    if (leader !== undefined && leader.ppid === process.pid) continue;
    const entries = new Map<number, ProcessEntry>();
    for (const entry of table.values()) if (entry.pgid === group.pgid) entries.set(entry.pid, entry);
    if (leader !== undefined) {
      entries.set(leader.pid, leader);
      for (const descendant of descendantsOf(table, leader.pid)) entries.set(descendant.pid, descendant);
    }
    if (entries.size > 0) found.push({ pgid: group.pgid, entries: [...entries.values()] });
  }
  for (const group of found) killEntries(group.entries, table);
  const held = (group: { pgid: number; entries: ProcessEntry[] }, current: ProcessTable): boolean =>
    group.entries.some((entry) => current.get(entry.pid)?.start === entry.start) ||
    [...current.values()].some((entry) => entry.pgid === group.pgid);
  let live = found;
  const deadline = Date.now() + killGraceMs;
  while (live.length > 0) {
    const current = readProcessTable();
    if (readable(current)) live = live.filter((group) => held(group, current));
    if (live.length === 0 || Date.now() >= deadline) break;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
  return { found: found.length, terminated: found.length - live.length, survived: live.length };
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

/** The root has not exited, so its pid still names it and the table below it is its own tree. */
function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * POSIX, just before the SIGTERM: remember the root's descendants, those that
 * left its process group included (OAR 0.37.0 `spawnLineProcess().kill()`,
 * 6d1589d). Read while the root runs: once it is gone, what left its group is
 * re-parented and no longer found below it.
 */
function rememberDescendants(child: ChildProcess, pid: number): void {
  if (isRunning(child)) stateFor(child).descendants = descendantsOf(readProcessTable(), pid);
}

/**
 * SIGKILL the remembered descendants plus `more` that `table` still shows as
 * the same process (same start time), and their groups; never the host or its
 * group (OAR `killEntries`). Returns the pids signalled, for the quiescence wait.
 */
function killDescendants(child: ChildProcess, table: () => ProcessTable, more: readonly ProcessEntry[] = []): number[] {
  const state = stateFor(child);
  const entries = [...state.descendants, ...more];
  state.descendants = [];
  if (entries.length === 0) return [];
  const current = table();
  killEntries(entries, current);
  return [...new Set(entries
    .filter((entry) => entry.pid !== process.pid && current.get(entry.pid)?.start === entry.start)
    .map((entry) => entry.pid))];
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
  rememberDescendants(options.child, pid);
  signalGroup(pid, 'SIGTERM', options.label, options.killFn ?? defaultKill);
  stateFor(options.child).requested = true;
}

/**
 * Resolve only after the adapter-owned root and descendants are quiescent.
 *
 * POSIX measures the owned process GROUP, then SIGKILLs the descendants that
 * left the group (read before the SIGTERM and again before the SIGKILL, each
 * pid checked by start time) and waits until they are gone. Only ends that
 * this module starts do this: a root that exited by itself leaves its
 * descendants alone. A process that started after the first read and
 * outlives the root is not reached.
 *
 * POSIX residual, as in OAR: the tree walk finds a process only while its
 * parent chain still leads to the root. A process whose parent exited before
 * the read is re-parented to init and is not reached. Real Claude and Pi run
 * each shell command in a session of its own, so `cmd &` makes exactly this:
 * the shell exits at once and the background job outlives `close()`.
 *
 * win32 measures the pid set taskkill
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
 * narrower claim than the tree, not a false one.
 *
 * Orphans left behind by a DAEMON death are no longer out of scope, but they
 * are not THIS function's job either — nothing here runs when the daemon is
 * gone. {@link adoptOwnedProcessTree} owns that case with two backstops
 * installed at spawn time: a synchronous host-`exit` sweep on every platform,
 * and on win32 a kernel-owned kill-on-close Job Object. Their own residuals
 * remain: the tiny window between `spawn` returning and the job assignment,
 * and a daemon SIGKILL/OOM on POSIX, where no in-process listener can run and
 * there is no job object to fall back on — that case is ended by the next
 * daemon start from the record adoption wrote ({@link reapOwnedProcessGroups}),
 * not earlier. Success here is that record's disposal receipt.
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
    rememberDescendants(options.child, pid);
    signalGroup(pid, 'SIGTERM', options.label, kill);
    stateFor(options.child).requested = true;
  }
  const killed: number[] = [];
  if (!(await waitUntil(() => groupExists(pid, options.label, kill), termGraceMs))) {
    // Read again first: the root may have started more since the SIGTERM.
    const table = readProcessTable();
    const more = isRunning(options.child) ? descendantsOf(table, pid) : [];
    signalGroup(pid, 'SIGKILL', options.label, kill);
    killed.push(...killDescendants(options.child, () => table, more));
    if (!(await waitUntil(() => groupExists(pid, options.label, kill), killGraceMs))) {
      throw new RuntimeDisposalFailure({
        stage: 'quiescence',
        reason: `${options.label} runtime process group remained live after SIGKILL`,
      });
    }
  }
  // The group is gone. What the root left running outside it, from the read
  // before the SIGTERM, goes now (OAR does this when the root exits).
  killed.push(...killDescendants(options.child, readProcessTable));
  if (!(await waitUntil(() => killed.some((descendant) => processExists(descendant, options.label, kill)), killGraceMs))) {
    throw new RuntimeDisposalFailure({
      stage: 'quiescence',
      reason: `${options.label} runtime descendants outside its process group remained live after SIGKILL`,
    });
  }
  if (!(await waitWithDeadline(options.waitClosed(), killGraceMs))) {
    throw new RuntimeDisposalFailure({
      stage: 'quiescence',
      reason: `${options.label} runtime root did not emit close after its process group exited`,
    });
  }
  await forgetOwnedGroup(options.child);
}
