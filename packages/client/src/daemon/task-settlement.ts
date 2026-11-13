import { decodeEnvelope } from '@byok-sdk/protocol';
import { journalHash, type JournalIdentity, type LocalTaskJournal, type TerminalTruthState } from './journal/journal.js';

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
  const envelope = decodeEnvelope(record.bytes);
  if (envelope.type !== 'task.cancel' || envelope.task_id !== taskId || envelope.seq === undefined || envelope.seq <= offerSeq) {
    throw new Error('invalid durable cancellation binding');
  }
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
   * runtime; a failed release of an offer-owned scratch (`runtimeId: 'scratch'`)
   * can race the decline or failure settlement and is not covered.
   * `none`: this daemon holds no runtime for the task and has no disposal
   * receipt, as for a decline, a failure before start, or any task that
   * finished before a restart.
   */
  readonly disposal: 'disposed' | 'failed' | 'none';
}

/** `whenTaskSettled` was asked about a task with no journal row and no in-memory record. */
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
// `offerJournaled` or `offerRefused` ends that window. A wait-only entry
// (see `isWaitOnly`) is dropped when its last waiter leaves.
export class TaskSettlementRegistry implements TaskRuntimeOwnership {
  readonly #entries = new Map<string, Entry>();
  readonly #offersSeen = new Set<string>();
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
  offerJournaled(taskId: string): void { this.#offersSeen.delete(taskId); }

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
    this.#settle(entry);
  }

  runtimeDisposalFailed(taskId: string): void {
    const entry = this.#entry(taskId);
    if (entry.result !== undefined) return;
    entry.runtime = 'failed';
    this.#settle(entry);
  }

  terminalSettled(taskId: string, terminal: DaemonTaskTerminal, delivery: DaemonTaskSettlement['delivery']): void {
    this.#offersSeen.delete(taskId);
    const entry = this.#entry(taskId);
    entry.delivered ??= { terminal, delivery };
    this.#settle(entry);
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
    if (entry === undefined) {
      const durable = await durableSettlement(journal, taskId);
      signal?.throwIfAborted();
      entry = this.#entries.get(taskId);
      if (entry === undefined) {
        if (durable === 'unknown' && !this.#offersSeen.has(taskId)) throw new DaemonTaskUnknownError(taskId);
        if (durable !== 'unknown' && durable !== 'pending') return durable;
        entry = this.#entry(taskId);
      }
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

  #settle(entry: Entry): void {
    if (entry.result !== undefined || entry.delivered === undefined || entry.runtime === 'held') return;
    entry.result = { ...entry.delivered, disposal: entry.runtime === 'none' ? 'none' : entry.runtime };
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
