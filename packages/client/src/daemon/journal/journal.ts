/**
 * The daemon's durable local journal port (sprint S3.3 / architecture
 * §12.7.2).
 *
 * The journal is NOT a debug log. It is the correctness precondition for
 * acking the hosted mailbox: the cloud retires a mailbox row when the daemon's
 * next poll carries a cursor past it (§12.7.3 — "领走即弃" means *cursor moved
 * past*, not *read*), so the moment the cursor advances over an envelope, that
 * envelope exists nowhere but this machine. Everything in this file exists to
 * make "the bytes are durable" a fact the cursor can be gated on.
 *
 * Two shapes here are load-bearing and deliberate:
 *
 * - **Bounded records.** The journal stores reliability metadata and small
 *   bounded bytes. Prompts, tool output, artifacts, workspaces, and blobs stay
 *   on the filesystem and are referenced, never inlined (§12.7.2). An oversized
 *   record is rejected with {@link JournalRecordTooLargeError} rather than
 *   silently truncated — a truncated envelope is not the envelope, and a
 *   journal that quietly stores something else than what arrived is worse than
 *   one that refuses.
 * - **Cleanable categories are a closed set that excludes protected data.**
 *   §12.7.2.1's never-auto-delete list (unacked envelopes, Running/
 *   AwaitApproval tasks, unconfirmed terminals, anything carrying a recovery
 *   marker, user workspaces, provider secrets, quarantine evidence) is
 *   enforced by {@link CleanableCategory} not having names for those things,
 *   so the cleanup path cannot ask for one. A runtime filter would put the
 *   never-delete list one bug away from deleting recovery evidence exactly
 *   once, in production.
 */

import { createHash } from 'node:crypto';

/**
 * The journal's one hash function, shared by every producer so a stored digest
 * and a recomputed one are comparable without a second convention. `sha256:`
 * prefixed because the algorithm has to travel with the value — an unprefixed
 * hex string is a hash of unknown provenance the day this changes.
 */
export function journalHash(bytes: string): string {
  return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}

/**
 * Who this daemon is, as recorded on every journal row (§12.7.2's minimum
 * fact set, first three entries). Carried explicitly rather than captured at
 * construction because `deviceId` is only known after `AuthManager`
 * `loadExisting()` resolves, strictly after the journal is built.
 */
export interface JournalIdentity {
  readonly tenantId: string;
  readonly productId: string;
  readonly deviceId: string;
}

/**
 * One inbound envelope, as received from the mailbox and about to be made
 * durable. `bytes` is the canonical v1 encoding (`encodeEnvelope`) of the
 * envelope this daemon parsed — the frozen codec's round-trip guarantee is
 * what makes that a faithful record — and `bytesHash` is its digest, so a
 * later reader can tell a redelivery of the same envelope from a different
 * envelope reusing an id.
 */
export interface ReceivedEnvelopeRecord {
  readonly identity: JournalIdentity;
  readonly envelopeId: string;
  /** The envelope's `task_id`, when it carries one. Required whenever {@link opensTask} is true. */
  readonly taskId?: string;
  /** The mailbox `seq` this envelope arrived at — the received cursor (§12.7.2's minimum fact set). */
  readonly seq: number;
  /** Canonical v1 bytes. Bounded — see {@link JournalRecordTooLargeError}. */
  readonly bytes: string;
  /** `sha256:<hex>` over {@link bytes}. */
  readonly bytesHash: string;
  readonly receivedAt: string;
  /**
   * Whether this envelope OPENS a local task record, i.e. whether the same
   * transaction must also create the `journal_task` row §12.7.3 requires
   * ("v1 bytes 与本机 task record 已在同一个本机 transaction durable append").
   * The caller decides this from the envelope's own type — it is the one
   * party that already knows, and re-deriving it inside the journal would put
   * a second copy of protocol semantics somewhere it does not belong.
   */
  readonly opensTask: boolean;
}

/**
 * A task-opening envelope above the inbound record bound (#826). Its bytes are
 * not stored: the journal keeps its identity, digest and length, the declined
 * task and the daemon's decline in one transaction, so the cursor can move
 * past it and the decline survives a crash.
 */
export interface WithheldOfferRecord {
  readonly identity: JournalIdentity;
  readonly envelopeId: string;
  readonly taskId: string;
  readonly seq: number;
  /** `sha256:<hex>` over the canonical bytes that were not stored. */
  readonly bytesHash: string;
  readonly byteLength: number;
  readonly receivedAt: string;
  /** The canonical `task.decline` of this task. Bounded like any terminal record. */
  readonly decline: { readonly bytes: string; readonly payloadHash: string };
}

/**
 * What {@link LocalTaskJournal.appendEnvelope} hands back. The cursor may
 * advance past {@link seq} once — and only once — this exists.
 */
export interface JournalReceipt {
  readonly envelopeId: string;
  readonly seq: number;
  readonly bytesHash: string;
  readonly committedAt: string;
  /**
   * `false` when this exact envelope id was ALREADY durable and this call
   * changed nothing — the redelivery case (§8.3's at-least-once wire means
   * every envelope can arrive twice; a crash between commit and ack
   * guarantees at least one will). A `false` here is a successful, correct
   * outcome, not an error: it says the bytes are durable, which is all the
   * cursor needed to know.
   */
  readonly created: boolean;
}

/** The admission decision for an offered task, as recorded on `journal_task`. */
export interface AdmissionRecord {
  readonly taskId: string;
  readonly admitted: boolean;
  readonly reason?: string;
  readonly retryable?: boolean;
  readonly claimedRuntime?: string;
  /** Digest of the effective policy this task runs under — the policy itself is not stored (bounded records). */
  readonly effectivePolicyHash?: string;
  /** Filesystem reference to the task's workspace. A path, never its contents. */
  readonly workspaceRef?: string;
  readonly decidedAt: string;
}

/**
 * One local execution-state transition. Idempotent by {@link transitionId}:
 * a replayed transition (recovery re-running a step, a redelivered envelope
 * driving the same move) records nothing new.
 */
export interface LocalTransitionRecord {
  readonly transitionId: string;
  readonly taskId: string;
  readonly from?: string;
  readonly to: string;
  readonly occurredAt: string;
  /** Small bounded free-form note. Not a place for tool output. */
  readonly detail?: string;
}

/** Whether the cloud has confirmed the terminal this daemon produced (§12.7.3's "terminal 生成后、truth 写入前" window). */
export type TerminalTruthState = 'pending' | 'confirmed' | 'failed';

/**
 * One canonical terminal and its delivery projection. Bytes are the replay
 * authority; the hash is checked against them, never used as a substitute.
 * The bytes change only when the cloud refused them
 * ({@link LocalTaskJournal.replaceRefusedTerminal}).
 */
export interface LocalTerminalRecord {
  readonly taskId: string;
  readonly terminalType: 'complete' | 'failed' | 'cancelled' | 'declined';
  readonly bytes: string;
  readonly payloadHash: string;
  readonly truthState: TerminalTruthState;
  /** How many times delivery to the cloud has been attempted. */
  readonly attempt: number;
  readonly lastError?: string;
  readonly recordedAt: string;
  /** Committed atomically with the original interruption report. */
  readonly recovery?: RecoveryOutcome;
}

/** A task the journal knows about that has no terminal and no recovery marker — i.e. one this daemon was in the middle of when it stopped. */
export interface RecoverableTask {
  readonly taskId: string;
  readonly envelopeId: string;
  readonly seq: number;
  readonly identity: JournalIdentity;
  readonly localState: string;
  readonly claimedRuntime?: string;
  readonly workspaceRef?: string;
  readonly updatedAt: string;
  readonly envelopeBytes: string;
}

/** A task whose offer was withheld (#826). It is declined and has nothing to run or recover. */
export interface WithheldOfferTask extends Omit<RecoverableTask, 'envelopeBytes'> {
  /** Length of the canonical offer bytes that were not stored. */
  readonly withheldEnvelopeBytes: number;
}

/**
 * What recovery decided about a task. `interrupted` is the honest default for
 * a daemon restart: local runtime sessions do not survive the process, so the
 * task is recorded as interrupted rather than pretended back into life — the
 * same semantics `GitWorkspaceStore.reconcile()` already applies to a lease
 * whose owner is gone. Nothing here deletes anything; a row that has been
 * through recovery carries a marker, and §12.7.2.1 forbids auto-deleting
 * those.
 */
export type RecoveryDisposition = 'resumed' | 'interrupted' | 'abandoned';

export interface RecoveryOutcome {
  readonly disposition: RecoveryDisposition;
  readonly reason?: string;
  readonly occurredAt?: string;
}

export interface LocalStorageUsage {
  readonly measuredAt: string;
  readonly journalBytes: number;
  readonly quarantineBytes: number;
  readonly journalEntries: number;
  readonly confirmedEntries: number;
  readonly oldestConfirmedAt?: string;
}

export interface CompactOptions {
  /**
   * `passive` never blocks a concurrent reader/writer and may checkpoint
   * nothing; `truncate` waits for the WAL to be fully applied and resets it.
   * Both are maintenance calls and belong off the active-task hot path
   * (§12.7.2).
   */
  readonly checkpoint?: 'passive' | 'truncate';
  /** Upper bound on freelist pages returned to the filesystem this pass. Bounded so compaction cannot monopolise the single writer. */
  readonly incrementalVacuumPages?: number;
}

export interface CompactResult {
  readonly checkpointed: boolean;
  /** WAL frames still outstanding after the checkpoint attempt — `0` means the WAL was fully applied. */
  readonly walFramesRemaining: number;
  readonly pagesVacuumed: number;
  readonly durationMs: number;
}

/**
 * The daemon-local durable journal (sprint S3.3's minimum API, verbatim,
 * plus {@link close}).
 *
 * A port, not an implementation detail: architecture §12.7.2 lets a host
 * inject its own backend, but only one that meets the same durability
 * contract. `SqliteLocalTaskJournal` is the shipped production implementation;
 * a plain JSON/JSONL store is explicitly NOT an acceptable substitute in
 * hosted mode, because it cannot honour the one property this interface exists
 * for — that `appendEnvelope` resolving means the bytes survived a power cut.
 */
export interface LocalTaskJournal {
  /**
   * Make one inbound envelope durable. Resolving means committed and fsynced;
   * only then may the mailbox cursor advance past `record.seq`.
   *
   * Idempotent by envelope id: appending the same envelope twice returns the
   * original receipt with `created: false` and writes nothing new. That is
   * what makes redelivery — which the at-least-once wire guarantees will
   * happen after any crash between commit and ack — a no-op rather than a
   * second side effect.
   */
  appendEnvelope(record: ReceivedEnvelopeRecord): Promise<JournalReceipt>;
  /**
   * Make one over-bound task-opening envelope durable without its bytes, with
   * its task declined and the decline pending. Idempotent by envelope id like
   * {@link appendEnvelope}. Refuses a task whose stored offer could still run.
   */
  appendWithheldOffer(record: WithheldOfferRecord): Promise<JournalReceipt>;
  /** Record the admission decision for a task whose offer envelope is already durable. */
  recordAdmission(record: AdmissionRecord): Promise<void>;
  /** Record one local execution-state transition. Idempotent by transition id. */
  recordTransition(record: LocalTransitionRecord): Promise<void>;
  /** Record (or update the retry state of) a task's terminal. Idempotent by task id: a replay with the same payload hash is a no-op beyond retry bookkeeping. */
  recordTerminal(record: LocalTerminalRecord): Promise<void>;
  /** Exact original terminal bytes, including rejected records, until acknowledged. */
  listPendingTerminals(identity: JournalIdentity): Promise<LocalTerminalRecord[]>;
  /**
   * A successful authenticated transport disposition, bound to the original
   * bytes. A disposition of bytes that {@link replaceRefusedTerminal} replaced
   * changes nothing and must not throw: the daemon keeps the batch of a failed
   * disposition and posts it again.
   */
  confirmTerminal(taskId: string, payloadHash: string): Promise<void>;
  /** A refusal of the original bytes; the same rule as {@link confirmTerminal} for replaced bytes. */
  rejectTerminal(taskId: string, payloadHash: string, reason: string): Promise<void>;
  /**
   * Replace a terminal the cloud refused ({@link rejectTerminal}) with another
   * one, which becomes the pending terminal (#654 §77b). The cloud records
   * nothing for a refused terminal, so the replacement is the first terminal
   * it receives. Refuses a row that is not refused or names another hash.
   * Idempotent: a repeat whose bytes are already current changes nothing. The
   * replaced hash is kept as a transition of the task.
   */
  replaceRefusedTerminal(taskId: string, refusedPayloadHash: string, record: LocalTerminalRecord): Promise<void>;
  /** Includes old interruption markers without reports; they must not hide pending work. */
  listRecoveryTasks(identity: JournalIdentity): Promise<RecoverableTask[]>;
  readTask(taskId: string, identity: JournalIdentity): Promise<RecoverableTask | WithheldOfferTask | undefined>;
  /** Tasks with no terminal and no recovery marker — what this daemon was in the middle of when it last stopped. */
  listRecoverable(): Promise<RecoverableTask[]>;
  /** Close out one recoverable task by writing its recovery marker. Never deletes; a marked row is on §12.7.2.1's never-auto-delete list. */
  markRecovered(taskId: string, outcome: RecoveryOutcome): Promise<void>;
  /** Physical journal/quarantine footprint and logical receipt counts; retention registry owns aggregate usage. */
  measureUsage(): Promise<LocalStorageUsage>;
  /** Confirmed terminals older than cutoff, without recovery markers, oldest first. */
  listPrunableConfirmedTasks(cutoff: Date, limit: number): Promise<string[]>;
  /** Transactionally rechecks confirmation and recovery protection before pruning. */
  pruneConfirmedJournalTask(taskId: string): Promise<boolean>;
  /** Bounded WAL checkpoint + incremental vacuum. Maintenance only; never on the envelope path. */
  compact(options: CompactOptions): Promise<CompactResult>;
  /**
   * Release the underlying handle. Beyond S3.3's minimum API — the daemon
   * owns this object's lifetime and has to be able to end it, and the crash
   * matrix needs an explicit "clean shutdown" to contrast against dropping
   * the reference without one.
   */
  close(): Promise<void>;
}

/**
 * Thrown when hosted journal mode is configured on a runtime that cannot
 * provide a real SQLite backend.
 *
 * This is architecture §12.7.2's no-silent-downgrade rule made executable:
 * "为兼容 Node 20 而退回的普通文件实现不能冒充 production durability." A daemon
 * that acks a mailbox on the strength of a journal that does not fsync loses
 * tasks only under power-cut timings — it passes every happy-path test it will
 * ever be given. Refusing to start is the only honest behaviour, so this is
 * thrown from CONSTRUCTION, before a single envelope has been accepted.
 */
export class JournalUnavailableError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(
      `hosted journal mode requires a runtime with a working node:sqlite (Node 22.5+); refusing to start: ${reason}. ` +
        'A plain-file journal is not an acceptable substitute — it cannot honour the fsync-before-ack ordering the ' +
        'hosted mailbox cursor depends on (architecture §12.7.2). Upgrade Node, or run this daemon in its default ' +
        'self-hosted mode with no hostedJournal configured.',
    );
    this.name = 'JournalUnavailableError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Thrown when the journal database is unreadable and has been moved aside.
 *
 * The database is renamed (with its WAL/SHM siblings) into
 * `<storeDir>/quarantine/`, timestamped, alongside a manifest naming the
 * reason — and then this is thrown. Nothing is deleted and nothing is
 * silently rebuilt: a fresh empty database opened over a corrupt one would
 * report "no recoverable tasks" for a machine that has some, and destroy the
 * only evidence of why. §12.7.2.1 puts quarantine on the never-auto-delete
 * list; clearing it is an explicit operator action.
 */
export class JournalCorruptError extends Error {
  constructor(
    readonly dbPath: string,
    readonly quarantinePath: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(
      `the local task journal at "${dbPath}" could not be opened (${reason}). It has been moved to "${quarantinePath}" ` +
        'with a manifest and NOT deleted; nothing was rebuilt over it. Inspect the quarantined database before ' +
        'restarting this daemon — a fresh journal would report an empty recovery set for a machine that may have ' +
        'unfinished tasks.',
    );
    this.name = 'JournalCorruptError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Thrown when a record exceeds the journal's per-record byte bound.
 *
 * The journal holds reliability metadata and small bounded bytes; large
 * payloads live on the filesystem and are referenced (§12.7.2). Rejecting is
 * the point — truncating would make the stored envelope a different envelope
 * than the one acked, which is precisely the failure this whole subsystem
 * exists to rule out.
 */
export class JournalRecordTooLargeError extends Error {
  constructor(
    readonly field: string,
    readonly actualBytes: number,
    readonly limitBytes: number,
  ) {
    super(
      `journal record field "${field}" is ${actualBytes} bytes, over the ${limitBytes}-byte bound — refusing it rather ` +
        'than truncating (a truncated envelope is not the envelope that was acked). The journal stores reliability ' +
        'metadata and small bounded bytes only; large content travels by reference (for example an instruction blob ref), never inline.',
    );
    this.name = 'JournalRecordTooLargeError';
  }
}

/** Thrown when a record references a task the journal has no row for — a transition or terminal for a task whose offer envelope was never appended. Fail-closed: the alternative is inventing the missing task row, which would fabricate recovery evidence. */
export class JournalUnknownTaskError extends Error {
  constructor(readonly taskId: string, operation: string) {
    super(
      `${operation} references task "${taskId}", which has no journal_task row — its offer envelope was never appended. ` +
        'Refusing rather than synthesising the missing row: a fabricated task record is fabricated recovery evidence.',
    );
    this.name = 'JournalUnknownTaskError';
  }
}

/** Thrown when the journal is used after {@link LocalTaskJournal.close}. */
export class JournalClosedError extends Error {
  constructor(operation: string) {
    super(`the local task journal is closed; ${operation} cannot be served`);
    this.name = 'JournalClosedError';
  }
}
