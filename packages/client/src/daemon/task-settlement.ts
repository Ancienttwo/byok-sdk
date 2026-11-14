import { assertTaskCancellationBinding, journalHash, type JournalIdentity, type LocalTaskJournal, type TerminalTruthState } from './journal/journal.js';

/**
 * Validate raw journal evidence in SDK code, including for Host-injected
 * backends. Only a cancellation sequenced after the stored offer settles it;
 * an earlier one is a pre-cancel whose offer still needs its decline.
 */
export async function hasTaskCancellation(journal: Pick<LocalTaskJournal, 'readTaskCancellation'>, taskId: string, offerSeq: number, identity: JournalIdentity): Promise<boolean> {
  const record = await journal.readTaskCancellation(taskId, identity, offerSeq);
  if (record === undefined) return false;
  if (record.identity.tenantId !== identity.tenantId || record.identity.productId !== identity.productId || record.identity.deviceId !== identity.deviceId) {
    throw new Error('journal cancellation enrollment identity mismatch');
  }
  if (journalHash(record.bytes) !== record.bytesHash) throw new Error('durable cancellation bytes/hash mismatch');
  assertTaskCancellationBinding(record.bytes, taskId, offerSeq);
  return true;
}

/** {@link DaemonTaskSettlement.terminal}: the terminal kind, including a cloud cancellation before admission. */
export type DaemonTaskTerminal = 'complete' | 'failed' | 'cancelled' | 'declined';

/** What `Daemon.whenTaskSettled` resolves with. */
export interface DaemonTaskSettlement {
  readonly terminal: DaemonTaskTerminal;
  /**
   * The first settlement of the terminal; `accepted` includes a duplicate.
   * `not-required`: a durable cloud cancellation suppressed a received offer
   * before admission; no local terminal envelope or runtime was required.
   */
  readonly delivery: 'accepted' | 'rejected' | 'not-required';
  /**
   * `failed` exactly when `runtime-disposal-failed` was emitted for the task's
   * runtime, including a custom harness whose id is `scratch`. A failed
   * release of an offer-owned scratch emits that event with
   * `runtimeId: 'scratch'` but never sets `failed`.
   * `none`: this daemon holds no runtime for the task and has no disposal
   * receipt, as for a decline, a failure before start, or any task that
   * finished before a restart.
   */
  readonly disposal: 'disposed' | 'failed' | 'none';
}

/**
 * `whenTaskSettled` rejects with this when an earlier journal read returned
 * no row for the task and, once that read finished, this Daemon instance had
 * no in-memory record of the task (no held runtime, nothing settled or
 * awaited for it in this run) and no offer for it marked as seen. A read
 * that overlapped the offer's journal append is repeated instead. The mark
 * also ends when the offer's append is refused, so a refused offer with no
 * row reads as unknown too. A task whose rows retention
 * pruned, a task never journaled on this device and an offer still on its way
 * look the same. Unknown does not prove the task is over or will never start:
 * an offer may still arrive, and whether one is on its way is for the Host's
 * own server to answer. Other failures are not reported as this error: a
 * failed journal read rejects with the journal's error, stored evidence that
 * fails an SDK check (cancellation identity, hash or binding, or an unknown
 * terminal state) with an SDK `Error`, a refused offer append with that
 * append's error, and an abort with `signal.reason`.
 */
export class DaemonTaskUnknownError extends Error {
  readonly code = 'daemon_task_unknown' as const;
  constructor(readonly taskId: string) {
    super(`daemon has no record of task ${taskId}`);
    this.name = 'DaemonTaskUnknownError';
  }
}

/** The durable facts one daemon run reads for a task it has not seen. */
export interface TaskSettlementJournal {
  readTask(taskId: string): Promise<{ readonly localState: string; readonly seq: number } | undefined>;
  /** SDK-validated inbound cancellation sequenced after the received offer at `offerSeq`. */
  hasTaskCancellation(taskId: string, offerSeq: number): Promise<boolean>;
  /** Truth state of an unconfirmed terminal; `undefined` once confirmed or when there is none. */
  unconfirmedTerminal(taskId: string): Promise<TerminalTruthState | undefined>;
}

/** Runtime ownership facts the task runner reports; a disposal failure arrives with `runtime-disposal-failed`. */
export interface TaskRuntimeOwnership {
  /** Before any terminal of the task is sent. */
  runtimeHeld(taskId: string): void;
  runtimeDisposed(taskId: string): void;
}

interface Waiter {
  resolve(settlement: DaemonTaskSettlement): void;
  reject(reason: unknown): void;
}

interface Entry {
  runtime: 'none' | 'held' | 'disposed' | 'failed';
  delivered?: Pick<DaemonTaskSettlement, 'terminal' | 'delivery'>;
  result?: DaemonTaskSettlement;
  readonly waiters: Set<Waiter>;
}

// An entry that only a wait created: no runtime fact, no terminal, no result.
const isWaitOnly = (entry: Entry): boolean => entry.runtime === 'none' && entry.delivered === undefined && entry.result === undefined;

const TERMINAL_STATE_PREFIX = 'terminal:';
const TERMINALS: ReadonlySet<string> = new Set<DaemonTaskTerminal>(['complete', 'failed', 'cancelled', 'declined']);

// One per Daemon, across its runs. Fed by each terminal's first outbound
// settlement, each runtime owner's first disposal outcome and, for a task this
// daemon has not seen, the journal; never by public events. An offer seen
// before its journal append keeps a wait in between from reading as unknown;
// `offerJournaled` or `offerRefused` ends that window; a read in flight when
// `offerJournaled` runs may predate the row, so the wait reads again. A wait-only entry
// (see `isWaitOnly`) is dropped when its last waiter leaves.
export class TaskSettlementRegistry implements TaskRuntimeOwnership {
  readonly #entries = new Map<string, Entry>();
  readonly #offersSeen = new Set<string>();
  readonly #reads = new Map<string, Set<{ journaled: boolean; resolve(settlement: DaemonTaskSettlement): void }>>();
  #journal: TaskSettlementJournal | undefined;

  bindJournal(journal: TaskSettlementJournal): void {
    // A new run must read recovery's durable answer, including on the same Daemon.
    // These cancellations have no terminal row; their cached answer is run-local.
    for (const [taskId, entry] of this.#entries) {
      if (entry.result?.delivery === 'not-required') this.#entries.delete(taskId);
    }
    this.#journal = journal;
  }

  offerSeen(taskId: string): void {
    if (!this.#entries.get(taskId)?.result) this.#offersSeen.add(taskId);
  }

  /** The offer's row is durable: later waits read the journal. */
  offerJournaled(taskId: string): void {
    this.#offersSeen.delete(taskId);
    for (const read of this.#reads.get(taskId) ?? []) read.journaled = true;
  }

  /** The journal refused the offer's append; its waiters fail closed. A redelivery starts a new window. */
  offerRefused(taskId: string, reason: unknown): void {
    this.#offersSeen.delete(taskId);
    const entry = this.#entries.get(taskId);
    if (entry === undefined) return;
    for (const waiter of [...entry.waiters]) waiter.reject(reason);
    entry.waiters.clear();
    if (isWaitOnly(entry)) this.#entries.delete(taskId);
  }

  runtimeHeld(taskId: string): void {
    const entry = this.#entry(taskId);
    if (entry.result === undefined && entry.runtime === 'none') entry.runtime = 'held';
  }

  runtimeDisposed(taskId: string): void {
    const entry = this.#entry(taskId);
    if (entry.result !== undefined || entry.runtime === 'failed') return;
    entry.runtime = 'disposed';
    this.#settle(taskId, entry);
  }

  runtimeDisposalFailed(taskId: string): void {
    const entry = this.#entry(taskId);
    if (entry.result !== undefined) return;
    entry.runtime = 'failed';
    this.#settle(taskId, entry);
  }

  terminalSettled(taskId: string, terminal: DaemonTaskTerminal, delivery: DaemonTaskSettlement['delivery']): void {
    this.#offersSeen.delete(taskId);
    const entry = this.#entry(taskId);
    entry.delivered ??= { terminal, delivery };
    this.#settle(taskId, entry);
  }

  /** Only for a received offer with no execution owner, after its cloud cancel is durable. */
  cancelledBeforeAdmission(taskId: string): void {
    this.terminalSettled(taskId, 'cancelled', 'not-required');
  }

  /** A redelivery in this run cannot reopen an offer the cloud already cancelled. */
  isCancelledBeforeAdmission(taskId: string): boolean {
    return this.#entries.get(taskId)?.result?.delivery === 'not-required';
  }

  async wait(taskId: string, signal?: AbortSignal): Promise<DaemonTaskSettlement> {
    signal?.throwIfAborted();
    const journal = this.#journal;
    if (journal === undefined) throw new Error('daemon is not started; call start() first');
    let entry = this.#entries.get(taskId);
    while (entry === undefined) {
      const { promise, resolve, reject } = Promise.withResolvers<DaemonTaskSettlement | 'pending' | 'unknown'>();
      const read = { journaled: false, resolve };
      const reads = this.#reads.get(taskId) ?? new Set();
      this.#reads.set(taskId, reads.add(read));
      const abort = (): void => reject(signal?.reason);
      let durable: DaemonTaskSettlement | 'pending' | 'unknown';
      try {
        signal?.addEventListener('abort', abort, { once: true });
        // Register before entering Host code; a runtime result can also finish this read.
        void durableSettlement(journal, taskId).then(resolve, reject);
        durable = await promise;
      } finally {
        signal?.removeEventListener('abort', abort);
        reads.delete(read);
        if (reads.size === 0) this.#reads.delete(taskId);
      }
      // Decide in the continuation that unregistered the read: no offer fact can
      // land between the read's end and this check.
      signal?.throwIfAborted();
      entry = this.#entries.get(taskId);
      if (entry !== undefined) break;
      if (durable === 'unknown' && !this.#offersSeen.has(taskId)) {
        if (read.journaled) continue;
        throw new DaemonTaskUnknownError(taskId);
      }
      if (durable !== 'unknown' && durable !== 'pending') return durable;
      entry = this.#entry(taskId);
    }
    if (entry.result !== undefined) return entry.result;
    const target = entry;
    return new Promise<DaemonTaskSettlement>((resolve, reject) => {
      let detach = (): void => {};
      const waiter: Waiter = {
        resolve: (settlement) => { detach(); resolve(settlement); },
        reject: (reason) => { detach(); reject(reason); },
      };
      target.waiters.add(waiter);
      if (signal === undefined) return;
      const abort = (): void => {
        target.waiters.delete(waiter);
        if (target.waiters.size === 0 && isWaitOnly(target) && this.#entries.get(taskId) === target) this.#entries.delete(taskId);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      detach = () => signal.removeEventListener('abort', abort);
    });
  }

  #entry(taskId: string): Entry {
    let entry = this.#entries.get(taskId);
    if (entry === undefined) {
      entry = { runtime: 'none', waiters: new Set() };
      this.#entries.set(taskId, entry);
    }
    return entry;
  }

  #settle(taskId: string, entry: Entry): void {
    if (entry.result !== undefined || entry.delivered === undefined || entry.runtime === 'held') return;
    entry.result = { ...entry.delivered, disposal: entry.runtime === 'none' ? 'none' : entry.runtime };
    for (const read of this.#reads.get(taskId) ?? []) read.resolve(entry.result);
    for (const waiter of entry.waiters) waiter.resolve(entry.result);
    entry.waiters.clear();
  }
}

async function durableSettlement(journal: TaskSettlementJournal, taskId: string): Promise<DaemonTaskSettlement | 'pending' | 'unknown'> {
  const task = await journal.readTask(taskId);
  if (task === undefined) return 'unknown';
  if (task.localState === 'received' && await journal.hasTaskCancellation(taskId, task.seq)) {
    return { terminal: 'cancelled', delivery: 'not-required', disposal: 'none' };
  }
  if (!task.localState.startsWith(TERMINAL_STATE_PREFIX)) return 'pending';
  const terminal = task.localState.slice(TERMINAL_STATE_PREFIX.length);
  if (!TERMINALS.has(terminal)) throw new Error(`journal task ${taskId} has an unknown terminal state`);
  const truth = await journal.unconfirmedTerminal(taskId);
  if (truth === 'pending') return 'pending';
  return { terminal: terminal as DaemonTaskTerminal, delivery: truth === 'failed' ? 'rejected' : 'accepted', disposal: 'none' };
}
