import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { RuntimeDisposalFailure } from '../runtime-failure';
import { walkTaskkillPidSet } from './taskkill-pid-set';
// OAR 0.37.0 `shared/executable/process-tree.ts`, vendored with upstream bytes.
import { descendantsOf, killEntries, readProcessTable, type ProcessEntry, type ProcessTable } from '../runtime/oar-process-tree.js';

const DEFAULT_TERM_GRACE_MS = 750;
const DEFAULT_KILL_GRACE_MS = 2_000;
const POLL_MS = 20;
/** POSIX: how often a running owned root's descendants are read. A process started and orphaned inside one period is not seen. */
export const OWNED_TREE_OBSERVE_MS = 1_000;

export type KillFn = (pid: number, signal: NodeJS.Signals | number) => void;

interface OwnedTerminationState {
  /** True only once a termination request actually reached the OS. A request that could not be spawned leaves this false so disposal re-issues it and surfaces the typed failure. */
  requested: boolean;
  /** win32 only: the process ids `taskkill /T /F` reported walking. This set — not taskkill's exit status — is what disposal measures for quiescence. */
  acceptedPids: Set<number>;
  /** POSIX only: the root's descendants seen while it ran (each observation, and the read just before the SIGTERM), those that left its group or its tree included, until they have had their SIGKILL. */
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

/**
 * POSIX: the running owned roots whose descendants are observed, by child.
 * A runtime may start a tool in a session of its own (dsh, Claude and Pi do).
 * Once the root dies from an outside SIGKILL, that tool is re-parented and no
 * read from the root finds it, so its entry has to be taken while the root
 * runs. One table read per period serves every root.
 */
const observedRoots = new Map<ChildProcess, number>();
let observer: NodeJS.Timeout | undefined;

function observeOwnedRoots(): void {
  let table: ProcessTable;
  try {
    table = readProcessTable();
  } catch {
    // A timer has no caller to fail. The previous observation stands, and
    // disposal reads the table again before it signals anything.
    return;
  }
  for (const [child, pid] of observedRoots) rememberDescendants(child, pid, table);
}

function observeOwnedRoot(child: ChildProcess, pid: number): void {
  observedRoots.set(child, pid);
  observer ??= setInterval(observeOwnedRoots, OWNED_TREE_OBSERVE_MS).unref();
  const stop = (): void => {
    observedRoots.delete(child);
    if (observedRoots.size > 0 || observer === undefined) return;
    clearInterval(observer);
    observer = undefined;
  };
  child.once('close', stop);
  child.once('exit', stop);
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
 * after the daemon itself was SIGKILLed or OOM-killed. Deliberately nothing
 * that names a command line or a path:
 *
 * - `pgid` and `rootStart`: the owned group and its root's start time from the
 *   process table, which tells the root from a later process given its pid;
 * - `bootId`: the boot the record was written in ({@link readBootId}). Start times are only
 *   comparable within one boot (Linux reports clock ticks since boot), and a
 *   record from an earlier boot names processes that are all gone;
 * - `writerPid` and `writerStart`: the process that adopted the tree. While
 *   that process still runs the tree is its live one, not a crash residue.
 */
export interface OwnedProcessGroupRecord {
  readonly pgid: number;
  readonly rootStart: string;
  readonly bootId: string;
  readonly writerPid: number;
  readonly writerStart: string;
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

let cachedBootId: string | undefined;

/**
 * Read one boot's identity. Linux: `boot_id`. Other POSIX (darwin): the
 * per-boot `kern.bootsessionuuid` — not `kern.boottime`, which XNU shifts when
 * the calendar clock is stepped, and which would then pass a live orphan's
 * record off as an earlier boot's. Unreadable, empty or oversized throws:
 * a record nothing can date is never written, and nothing is declared ended
 * on a guess. Exported with its read seams for tests only.
 */
export function readBootId(
  platform: NodeJS.Platform,
  deps: { readFile: (file: string) => string; sysctl: (key: string) => string } = {
    readFile: (file) => readFileSync(file, 'utf8'),
    sysctl: (key) => execFileSync('sysctl', ['-n', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }),
  },
): string {
  let id: string;
  try {
    id = (platform === 'linux' ? deps.readFile('/proc/sys/kernel/random/boot_id') : deps.sysctl('kern.bootsessionuuid')).trim();
  } catch (cause) {
    throw new Error('the boot identity could not be read', { cause });
  }
  if (id.length === 0 || id.length > 64) throw new Error('the boot identity could not be read');
  return id;
}

/** This boot's identity ({@link readBootId}), read once per process. */
export function currentBootId(): string {
  cachedBootId ??= readBootId(process.platform);
  return cachedBootId;
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
  nativeAssetRoot?: string;
  child: ChildProcess;
  label: string;
  /** DI seam — defaults to `process.platform`, mirroring {@link OwnedProcessTreeOptions}. */
  platform?: NodeJS.Platform;
  /** DI seam for the win32 job-object backstop — defaults to the lazily imported `./win32-job-object`. `release()` ends the tree's job; {@link disposeOwnedProcessTree} calls it once the tree is proved gone. */
  jobObject?: { assign(pid: number): Promise<{ release(): void }> };
  /** DI seam for the POSIX host-exit sweep — defaults to `process.kill`. */
  killFn?: KillFn;
  /** DI seam for the win32 host-exit sweep — defaults to `node:child_process`'s `spawnSync`. */
  spawnSyncFn?: typeof spawnSync;
  /** DI seam for the POSIX ledger record's process-table read — defaults to the vendored `readProcessTable`. */
  readProcessTableFn?: () => ProcessTable;
}

/**
 * The default win32 backstop. The dynamic import is the mechanism that keeps
 * `koffi` — and any native addon — out of every non-win32 process: this
 * module is reached only from the win32 branch below, and it imports `koffi`
 * only when its bindings are actually resolved.
 */
const defaultJobObject = {
  async assign(pid: number, nativeAssetRoot?: string): Promise<{ release(): void }> {
    const { assignOwnedProcessToJob } = await import('./win32-job-object');
    return assignOwnedProcessToJob(pid, { nativeAssetRoot });
  },
};

/**
 * win32 only: each adopted tree's own kill-on-close job, held until
 * {@link disposeOwnedProcessTree} proves that tree gone. Keyed by the child,
 * like {@link ownedGroupRecords}, so every client's disposal of its own child
 * is what releases its job. A job never released here stays open until the
 * daemon exits, and the kernel then kills whatever is left in it.
 */
const treeJobs = new WeakMap<ChildProcess, { release(): void }>();
/** Children whose disposal already proved the tree gone, for an assignment that settles after that proof. */
const provenGone = new WeakSet<ChildProcess>();

function releaseTreeJob(child: ChildProcess): void {
  provenGone.add(child);
  const job = treeJobs.get(child);
  if (job === undefined) return;
  treeJobs.delete(child);
  job.release();
}

/**
 * Take ownership of a just-spawned runtime tree, beyond what disposal covers.
 *
 * Two backstops with different coverage, both kernel- or runtime-owned rather
 * than sweep-based:
 *
 * 1. Every platform: the tree joins a registry a once-installed, synchronous
 *    `process` `exit` listener sweeps. This covers an ordinary daemon exit —
 *    the case where disposal simply never ran.
 * 2. win32 only: the root is assigned to a `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
 *    job of its own (see `./win32-job-object.ts`), held until disposal proves
 *    the tree gone. That one is the kernel's, so it also covers the daemon
 *    deaths no listener can observe: they close every job handle at once.
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
 * daemon start ends with {@link reapOwnedProcessGroups}. A root that already
 * exited leaves no record; a record that cannot be written fails adoption.
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
    observeOwnedRoot(options.child, pid);
    await recordOwnedGroup(options.child, pid, options.label, options.readProcessTableFn ?? readProcessTable);
    return;
  }
  const job = await (options.jobObject ? options.jobObject.assign(pid) : defaultJobObject.assign(pid, options.nativeAssetRoot));
  // A disposal that finished while the assignment was in flight already
  // proved this tree gone, so its job holds nothing that may still live.
  if (provenGone.has(options.child)) job.release();
  else treeJobs.set(options.child, job);
}

async function recordOwnedGroup(child: ChildProcess, pid: number, label: string, read: () => ProcessTable): Promise<void> {
  if (ownedGroupLedgers.size === 0) return;
  const table = read();
  const writer = table.get(process.pid);
  // Fail closed: an owned tree whose record could not be written is refused,
  // like a win32 tree whose job assignment failed.
  if (writer === undefined) throw new Error(`${label} runtime process group could not be recorded: the process table is unreadable`);
  const root = table.get(pid);
  if (root === undefined) {
    // Our own child stays in the table until Node reaps it, and Node sets the
    // exit status in the same step: absent and not exited cannot both hold.
    if (!isRunning(child)) return;
    throw new Error(`${label} runtime process group could not be recorded: its root is missing from the process table`);
  }
  if (root.pgid !== pid) throw new Error(`${label} runtime root is not its own process-group leader`);
  const record: OwnedProcessGroupRecord = {
    pgid: pid, rootStart: root.start, bootId: currentBootId(), writerPid: process.pid, writerStart: writer.start,
  };
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
  /** Records whose writer process still runs: its live trees, left alone. */
  liveWriter: number;
  /** The records confirmed ended — already gone, or terminated here. Only these may be dropped. */
  ended: OwnedProcessGroupRecord[];
  /** The records counted in `survived`. */
  survivors: OwnedProcessGroupRecord[];
}

/** Same boot only: Linux start times are clock ticks, elsewhere `ps` `lstart` to the second. Unparseable is never "after". */
function startedAtOrAfter(start: string, rootStart: string): boolean {
  if (/^\d+$/u.test(start) && /^\d+$/u.test(rootStart)) return BigInt(start) >= BigInt(rootStart);
  const at = Date.parse(start);
  const root = Date.parse(rootStart);
  return Number.isFinite(at) && Number.isFinite(root) && at >= root;
}

/**
 * POSIX: end the owned groups a previous daemon process recorded and could no
 * longer dispose (it was SIGKILLed or OOM-killed). One read of the process
 * table decides each record:
 *
 * - written in an earlier boot: everything it named is gone — ended, nothing
 *   signalled;
 * - its writer process still runs (same pid and start time): that process's
 *   live tree — left alone and kept;
 * - its leader pid is held by a process with a different start time: the pid
 *   was reused, so the recorded group is already empty (a pid is never handed
 *   out while a group of that id exists) — ended, nothing signalled;
 * - its leader is the recorded root: SIGKILL the group, and the root's
 *   descendants that left it, with their groups;
 * - its leader is gone and processes still carry its pgid: they are the
 *   root's only if every one started no earlier than the root (the root led a
 *   session of its own, so nothing older can have joined its group). A group
 *   holding an older process is someone else's — ended, nothing signalled.
 *   Otherwise SIGKILL them.
 *
 * Every signal goes through OAR `killEntries`, which re-checks each pid's
 * start time and never signals this process or its group. Then the table is
 * read until no killed process and no member of a found group remains, or
 * `killGraceMs` passes. win32 records nothing and reaps nothing. An
 * unreadable table or boot identity fails closed: nothing can be proved gone.
 *
 * Residual, stated: a recorded group that emptied, whose pgid then went to a
 * new process that made a group of it and left only younger members behind
 * (a double-fork daemon), is indistinguishable from the root's orphans.
 */
export async function reapOwnedProcessGroups(
  groups: readonly OwnedProcessGroupRecord[],
  options: { platform?: NodeJS.Platform; killGraceMs?: number } = {},
): Promise<OwnedProcessGroupReap> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32' || groups.length === 0) return { found: 0, terminated: 0, survived: 0, liveWriter: 0, ended: [], survivors: [] };
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const readable = (table: ProcessTable): boolean => table.has(process.pid);
  const table = readProcessTable();
  if (!readable(table)) {
    throw new RuntimeDisposalFailure({
      stage: 'quiescence',
      reason: 'the process table could not be read to end the previous daemon run\u2019s owned runtime process groups',
    });
  }
  const bootId = currentBootId();
  const ended: OwnedProcessGroupRecord[] = [];
  let liveWriter = 0;
  type Found = { record: OwnedProcessGroupRecord; entries: ProcessEntry[] };
  const found: Found[] = [];
  for (const group of groups) {
    if (group.bootId !== bootId) {
      ended.push(group);
      continue;
    }
    if (table.get(group.writerPid)?.start === group.writerStart) {
      liveWriter += 1;
      continue;
    }
    const leader = table.get(group.pgid);
    if (leader !== undefined && leader.start !== group.rootStart) {
      ended.push(group);
      continue;
    }
    const members = [...table.values()].filter((entry) => entry.pgid === group.pgid);
    if (leader === undefined && members.some((entry) => !startedAtOrAfter(entry.start, group.rootStart))) {
      ended.push(group);
      continue;
    }
    const entries = new Map<number, ProcessEntry>(members.map((entry) => [entry.pid, entry]));
    if (leader !== undefined) {
      entries.set(leader.pid, leader);
      for (const descendant of descendantsOf(table, leader.pid)) entries.set(descendant.pid, descendant);
    }
    if (entries.size === 0) ended.push(group);
    else found.push({ record: group, entries: [...entries.values()] });
  }
  for (const group of found) killEntries(group.entries, table);
  const held = (group: Found, current: ProcessTable): boolean =>
    group.entries.some((entry) => current.get(entry.pid)?.start === entry.start) ||
    [...current.values()].some((entry) => entry.pgid === group.record.pgid && startedAtOrAfter(entry.start, group.record.rootStart));
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
  for (const group of found) if (!live.includes(group)) ended.push(group.record);
  return {
    found: found.length, terminated: found.length - live.length, survived: live.length, liveWriter, ended,
    survivors: live.map((group) => group.record),
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

/** The root has not exited, so its pid still names it and the table below it is its own tree. */
function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * POSIX, at each observation and just before the SIGTERM: remember the root's
 * descendants, those that left its process group included (OAR 0.37.0
 * `spawnLineProcess().kill()`, 6d1589d). Read while the root runs: once it is
 * gone, what left its group is re-parented and no longer found below it. An
 * entry seen before stays while `table` shows the same process (same start
 * time), so one whose parent exited is still remembered.
 */
function rememberDescendants(child: ChildProcess, pid: number, table?: ProcessTable): void {
  if (!isRunning(child)) return;
  const current = table ?? readProcessTable();
  const state = stateFor(child);
  const remembered = new Map<number, ProcessEntry>();
  for (const entry of state.descendants) if (current.get(entry.pid)?.start === entry.start) remembered.set(entry.pid, entry);
  for (const entry of descendantsOf(current, pid)) remembered.set(entry.pid, entry);
  state.descendants = [...remembered.values()];
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
 * left the group (observed every {@link OWNED_TREE_OBSERVE_MS} while the root
 * ran, read before the SIGTERM and again before the SIGKILL, each pid checked
 * by start time) and waits until they are gone. That holds however the root
 * ended, an outside SIGKILL included (#1269): the group signal never reaches a
 * tool in a group of its own, and once the root is gone only the remembered
 * entry leads to it.
 *
 * POSIX residual: the tree walk finds a process only while its parent chain
 * still leads to the root. A process that is re-parented, or whose root dies,
 * before any observation or read saw it is not reached: within one observation
 * period, a root SIGKILLed right after starting a tool, or `cmd &` from a
 * shell that exits at once (real Claude and Pi run each shell command in a
 * session of its own).
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
 * not earlier. Success here is that record's disposal receipt, and on win32
 * the release of the tree's own kill-on-close job; a failure keeps that job
 * open until the daemon exits.
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
    // Proved gone: closing the tree's job can no longer end anything live.
    // Every failure above leaves it open for the daemon-exit backstop.
    releaseTreeJob(options.child);
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
