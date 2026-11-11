import type { TerminalTruthState } from './journal/journal.js';

/** {@link DaemonTaskSettlement.terminal}: the kind of the task's terminal envelope. */
export type DaemonTaskTerminal = 'complete' | 'failed' | 'cancelled' | 'declined';

/** What `Daemon.whenTaskSettled` resolves with. */
export interface DaemonTaskSettlement {
  readonly terminal: DaemonTaskTerminal;
  /** The first settlement of the terminal; `accepted` includes a duplicate. */
  readonly delivery: 'accepted' | 'rejected';
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
  readTask(taskId: string): Promise<{ readonly localState: string } | undefined>;
  /** Truth state of an unconfirmed terminal; `undefined` once confirmed or when there is none. */
  unconfirmedTerminal(taskId: string): Promise<TerminalTruthState | undefined>;
}

/** Runtime ownership facts the task runner reports; a disposal failure arrives with `runtime-disposal-failed`. */
export interface TaskRuntimeOwnership {
  /** Before any terminal of the task is sent. */
  runtimeHeld(taskId: string): void;
  runtimeDisposed(taskId: string): void;
}

interface Entry {
  runtime: 'none' | 'held' | 'disposed' | 'failed';
  delivered?: Pick<DaemonTaskSettlement, 'terminal' | 'delivery'>;
  result?: DaemonTaskSettlement;
  settled?: Promise<DaemonTaskSettlement>;
  resolve?: (settlement: DaemonTaskSettlement) => void;
}

const TERMINAL_STATE_PREFIX = 'terminal:';
const TERMINALS: ReadonlySet<string> = new Set<DaemonTaskTerminal>(['complete', 'failed', 'cancelled', 'declined']);

// One per Daemon, across its runs. Fed by each terminal's first outbound
// settlement, each runtime owner's first disposal outcome and, for a task this
// daemon has not seen, the journal; never by public events. An offer seen
// before its journal append keeps a wait in between from reading as unknown.
export class TaskSettlementRegistry implements TaskRuntimeOwnership {
  readonly #entries = new Map<string, Entry>();
  readonly #offersSeen = new Set<string>();
  #journal: TaskSettlementJournal | undefined;

  bindJournal(journal: TaskSettlementJournal): void { this.#journal = journal; }

  offerSeen(taskId: string): void {
    if (!this.#entries.get(taskId)?.result) this.#offersSeen.add(taskId);
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
    const settled = entry.settled ??= new Promise<DaemonTaskSettlement>((resolve) => { entry.resolve = resolve; });
    if (signal === undefined) return settled;
    return new Promise<DaemonTaskSettlement>((resolve, reject) => {
      const abort = (): void => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      void settled.then((settlement) => {
        signal.removeEventListener('abort', abort);
        resolve(settlement);
      });
    });
  }

  #entry(taskId: string): Entry {
    let entry = this.#entries.get(taskId);
    if (entry === undefined) {
      entry = { runtime: 'none' };
      this.#entries.set(taskId, entry);
    }
    return entry;
  }

  #settle(entry: Entry): void {
    if (entry.result !== undefined || entry.delivered === undefined || entry.runtime === 'held') return;
    entry.result = { ...entry.delivered, disposal: entry.runtime === 'none' ? 'none' : entry.runtime };
    entry.resolve?.(entry.result);
  }
}

async function durableSettlement(journal: TaskSettlementJournal, taskId: string): Promise<DaemonTaskSettlement | 'pending' | 'unknown'> {
  const task = await journal.readTask(taskId);
  if (task === undefined) return 'unknown';
  if (!task.localState.startsWith(TERMINAL_STATE_PREFIX)) return 'pending';
  const terminal = task.localState.slice(TERMINAL_STATE_PREFIX.length);
  if (!TERMINALS.has(terminal)) throw new Error(`journal task ${taskId} has an unknown terminal state`);
  const truth = await journal.unconfirmedTerminal(taskId);
  if (truth === 'pending') return 'pending';
  return { terminal: terminal as DaemonTaskTerminal, delivery: truth === 'failed' ? 'rejected' : 'accepted', disposal: 'none' };
}
