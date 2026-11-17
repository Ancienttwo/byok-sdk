/**
 * The journal's SQL, run against the one writable `DatabaseSync` handle.
 *
 * Only the journal worker thread (`journal-worker.ts`) constructs this, so no
 * statement here ever runs on the daemon's event loop. Every write method runs
 * inside a savepoint that the worker opened in its batch transaction; it never
 * begins or commits a transaction itself. A write returns the after-commit
 * fault steps it owes, which the worker fires once the batch has committed.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SEALED_INLINE_MAX_PADDED_LENGTH, isSealedPayload } from '@byok-sdk/protocol';
import {
  assertTaskCancellationBinding,
  journalHash,
  JournalIntegrityError,
  JournalRecordTooLargeError,
  JournalUnknownTaskError,
  type AdmissionRecord,
  type CompactOptions,
  type CompactResult,
  type JournalIdentity,
  type JournalReceipt,
  type LocalStorageUsage,
  type LocalTerminalRecord,
  type LocalTransitionRecord,
  type RecoverableTask,
  type RecoveryOutcome,
  type ReceivedEnvelopeRecord,
  type WithheldOfferRecord,
  type WithheldOfferTask,
} from './journal.js';
import type { JournalFaultStep } from './sqlite-journal.js';

/** The AES-256-GCM tag of the sealed payload v1 suite. */
const SEALED_AEAD_TAG_BYTES = 16;
/**
 * Room beside the largest inline sealed member for the rest of its envelope:
 * the envelope fields, the sealed header and the plaintext fields of the
 * sealed type (selection, policies, `sealing`).
 */
const SEALED_ENVELOPE_MARGIN_BYTES = 64 * 1024;
/**
 * The least bound on an inbound envelope record (#654). An inline sealed
 * member carries up to `SEALED_INLINE_MAX_PADDED_LENGTH` + 16 bytes of
 * ciphertext as unpadded base64url. That is above the default record bound,
 * and the daemon must journal such an envelope before it can decline it.
 * A sealed terminal record has the same floor; plaintext terminal and
 * transition records keep `maxRecordBytes`.
 */
export const ENVELOPE_RECORD_FLOOR_BYTES = Math.ceil(((SEALED_INLINE_MAX_PADDED_LENGTH + SEALED_AEAD_TAG_BYTES) * 4) / 3) + SEALED_ENVELOPE_MARGIN_BYTES;

/** Whether canonical envelope bytes carry a sealed payload (#654); read only for a record above `maxRecordBytes`. */
function isSealedEnvelope(bytes: string): boolean {
  try {
    const { type, payload } = JSON.parse(bytes) as { type?: unknown; payload?: unknown };
    return typeof type === 'string' && isSealedPayload(type, payload);
  } catch {
    return false;
  }
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * A received offer with no terminal or recovery marker whose task also has a
 * stored `task.cancel` sequenced after it: the restart rule settles it as
 * cancelled, so it ages out like a confirmed terminal. A cancellation at or
 * below the offer sequence preceded the offer and never qualifies. Malformed
 * bytes do not match; the prune transaction verifies the qualifying cancellation's hash.
 */
const CANCELLED_RECEIVED_TASK = `t.local_state = 'received' AND t.recovery_marker IS NULL
  AND NOT EXISTS (SELECT 1 FROM journal_terminal term WHERE term.task_id = t.task_id)`;
const LATER_CANCELLATION = `FROM journal_envelope c WHERE c.task_id = t.task_id AND c.seq > t.seq AND c.withheld_bytes IS NULL
  AND CASE WHEN json_valid(c.bytes) THEN json_extract(c.bytes, '$.type') END = 'task.cancel'`;

/** `local_state` for a task whose admission declined it — terminal for local purposes, and NOT something recovery should re-offer. */
const DECLINED_STATE = 'declined';
/** `local_state` a task starts in: its offer envelope is durable, nothing has been decided yet. */
const RECEIVED_STATE = 'received';

/** A missing file or directory (absent WAL/SHM, no quarantine yet) measures 0; any other error must surface, not read as a small healthy journal. */
function absentAsZero(error: unknown): number {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
  throw error;
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    return absentAsZero(error);
  }
}

function directoryBytes(dir: string): number {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    return absentAsZero(error);
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? directoryBytes(full) : fileBytes(full);
  }
  return total;
}

/** Names the task in a failed integrity check over its stored rows; the cause stays attached. */
function integrity<T>(taskId: string, check: () => T): T {
  try { return check(); }
  catch (error) { throw new JournalIntegrityError(taskId, error); }
}

/** What a write hands back: its value, and the after-commit fault steps the worker fires once the batch commits. */
export interface JournalWrite<T> {
  readonly value: T;
  readonly afterCommit: readonly JournalFaultStep[];
}

function written<T>(value: T, ...afterCommit: JournalFaultStep[]): JournalWrite<T> {
  return { value, afterCommit };
}

export interface JournalStoreOptions {
  readonly dbPath: string;
  readonly quarantineDir: string;
  readonly maxRecordBytes: number;
  /** The fault seam; throws to fail the current write at `step`. */
  readonly fault: (step: JournalFaultStep) => void;
}

export class JournalStore {
  readonly #db: DatabaseSync;
  readonly #options: JournalStoreOptions;

  constructor(db: DatabaseSync, options: JournalStoreOptions) {
    this.#db = db;
    this.#options = options;
  }

  #fault(step: JournalFaultStep): void {
    this.#options.fault(step);
  }

  #requireTask(taskId: string, operation: string): void {
    const row = this.#db.prepare('SELECT task_id FROM journal_task WHERE task_id = ?').get(taskId);
    if (!row) throw new JournalUnknownTaskError(taskId, operation);
  }

  // ---------------------------------------------------------------------
  // Writes: each runs inside the worker's per-operation savepoint.
  // ---------------------------------------------------------------------

  /**
   * The ack-critical path. Envelope bytes, the task record it opens, and the
   * idempotency receipt all land in ONE transaction, or none of them do.
   *
   * The receipt lookup happens INSIDE that transaction rather than as a cheap
   * pre-check outside it: the write lock is already held by then, so "is this
   * a redelivery?" and "write it" cannot be separated by another writer. The
   * duplicate answer is served from the stored receipt, so a redelivery
   * returns the ORIGINAL admission time and hash — the caller learns the
   * bytes are durable and that this call changed nothing, which is exactly
   * what the cursor needed.
   */
  appendEnvelope(entry: ReceivedEnvelopeRecord, admittedAt: string): JournalWrite<JournalReceipt> {
    return this.#append(entry, entry.bytes, null, admittedAt, (committedAt) => {
      if (!entry.opensTask || entry.taskId === undefined) return;
      const task = this.#db.prepare('SELECT * FROM journal_task WHERE task_id = ?').get(entry.taskId) as Record<string, unknown> | undefined;
      if (task) {
        this.#assertIdentity(task, entry.identity);
        const original = this.#db.prepare('SELECT bytes, withheld_bytes FROM journal_envelope WHERE envelope_id = ?')
          .get(task.envelope_id as string) as { bytes: string; withheld_bytes: number | null };
        // Transport IDs/seq can change on duplicate delivery, but the execution
        // contract (including exact AgentRef) must never change under task_id.
        // A withheld offer has no contract to compare: its task is declined.
        if (original.withheld_bytes === null) {
          const oldOffer = JSON.parse(original.bytes) as { type?: unknown; payload?: unknown };
          const newOffer = JSON.parse(entry.bytes) as { type?: unknown; payload?: unknown };
          if (oldOffer.type !== newOffer.type || JSON.stringify(oldOffer.payload) !== JSON.stringify(newOffer.payload)) {
            throw new Error('journal task identity reused with a different execution contract');
          }
        }
      }
      // `OR IGNORE`: a second, different envelope re-opening the same task
      // id (a re-offer after the cloud lost track) must not clobber the
      // admission/claim state the first one already accumulated. The
      // envelope row above still records that the second envelope arrived.
      this.#insertTask(entry, entry.taskId, RECEIVED_STATE, committedAt);
    });
  }

  /** #826: the decline commits with the row, because the cursor moves once this commits. */
  appendWithheldOffer(record: WithheldOfferRecord, admittedAt: string): JournalWrite<JournalReceipt> {
    const { decline, taskId } = record;
    return this.#append(record, '', record.byteLength, admittedAt, (committedAt) => {
      const task = this.#db.prepare(`SELECT t.tenant_id, t.product_id, t.device_id, e.withheld_bytes FROM journal_task t
        JOIN journal_envelope e ON e.envelope_id = t.envelope_id WHERE t.task_id = ?`).get(taskId) as Record<string, unknown> | undefined;
      if (task) {
        this.#assertIdentity(task, record.identity);
        // A task opened by a stored offer may be running: a decline must not
        // become its terminal. A task opened by a withheld offer is already declined.
        if (task.withheld_bytes === null) throw new Error('journal task identity reused with a different execution contract');
        return;
      }
      this.#assertTerminalBytes(decline.bytes, decline.payloadHash);
      this.#insertTask(record, taskId, 'terminal:declined', committedAt);
      this.#insertTerminal({ taskId, terminalType: 'declined', bytes: decline.bytes, payloadHash: decline.payloadHash,
        truthState: 'pending', attempt: 1, recordedAt: committedAt });
    });
  }

  /** Envelope row, task step and receipt; a redelivery is answered from its receipt. */
  #append(
    record: Omit<ReceivedEnvelopeRecord, 'bytes' | 'opensTask'>,
    bytes: string,
    withheldBytes: number | null,
    committedAt: string,
    openTask: (committedAt: string) => void,
  ): JournalWrite<JournalReceipt> {
    this.#fault('append:before-begin');
    const existing = this.#db
      .prepare('SELECT receipt FROM journal_idempotency WHERE scope = ? AND key = ?')
      .get('envelope', record.envelopeId) as { receipt: string } | undefined;
    if (existing) {
      const prior = JSON.parse(existing.receipt) as Omit<JournalReceipt, 'created'>;
      if (prior.bytesHash !== record.bytesHash) throw new Error('journal envelope identity collision');
      const priorIdentity = this.#db.prepare('SELECT tenant_id, product_id, device_id FROM journal_envelope WHERE envelope_id = ?').get(record.envelopeId) as Record<string, unknown>;
      this.#assertIdentity(priorIdentity, record.identity);
      return written({ ...prior, created: false }, 'append:after-commit');
    }

    this.#db
      .prepare(
        `INSERT INTO journal_envelope
           (envelope_id, tenant_id, product_id, device_id, seq, task_id, bytes, bytes_hash, withheld_bytes, received_at, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.envelopeId,
        record.identity.tenantId,
        record.identity.productId,
        record.identity.deviceId,
        record.seq,
        record.taskId ?? null,
        bytes,
        record.bytesHash,
        withheldBytes,
        record.receivedAt,
        committedAt,
      );
    this.#fault('append:after-envelope');
    openTask(committedAt);
    this.#fault('append:after-task');

    const receipt: Omit<JournalReceipt, 'created'> = {
      envelopeId: record.envelopeId,
      seq: record.seq,
      bytesHash: record.bytesHash,
      committedAt,
    };
    this.#db
      .prepare('INSERT INTO journal_idempotency (scope, key, task_id, receipt, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('envelope', record.envelopeId, record.taskId ?? null, JSON.stringify(receipt), committedAt);
    this.#fault('append:after-receipt');
    this.#fault('append:before-commit');
    return written({ ...receipt, created: true }, 'append:after-commit');
  }

  #insertTask(record: { identity: JournalIdentity; envelopeId: string; seq: number }, taskId: string, localState: string, at: string): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO journal_task
           (task_id, envelope_id, tenant_id, product_id, device_id, seq, local_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(taskId, record.envelopeId, record.identity.tenantId, record.identity.productId, record.identity.deviceId,
        record.seq, localState, at, at);
  }

  recordAdmission(record: AdmissionRecord): JournalWrite<void> {
    this.#requireTask(record.taskId, 'recordAdmission');
    this.#db
      .prepare(
        `UPDATE journal_task
            SET admitted = ?, admission_reason = ?, admission_retryable = ?, claimed_runtime = ?,
                effective_policy_hash = ?, workspace_ref = ?, local_state = ?, updated_at = ?
          WHERE task_id = ?`,
      )
      .run(
        record.admitted ? 1 : 0,
        record.reason ?? null,
        record.retryable === undefined ? null : record.retryable ? 1 : 0,
        record.claimedRuntime ?? null,
        record.effectivePolicyHash ?? null,
        record.workspaceRef ?? null,
        record.admitted ? 'admitted' : DECLINED_STATE,
        record.decidedAt,
        record.taskId,
      );
    this.#fault('admission:before-commit');
    return written(undefined);
  }

  /**
   * Idempotent by transition id. `INSERT OR IGNORE` decides it: when the row
   * already exists nothing is inserted AND the task's `local_state` is left
   * alone, so replaying an old transition cannot drag a task's state
   * backwards — which is precisely what recovery replaying a stored sequence
   * would otherwise do.
   */
  recordTransition(record: LocalTransitionRecord): JournalWrite<void> {
    this.#requireTask(record.taskId, 'recordTransition');
    const inserted = this.#db
      .prepare(
        `INSERT OR IGNORE INTO journal_transition (transition_id, task_id, from_state, to_state, occurred_at, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.transitionId,
        record.taskId,
        record.from ?? null,
        record.to,
        record.occurredAt,
        record.detail ?? null,
      );
    if (inserted.changes > 0) {
      this.#db
        .prepare('UPDATE journal_task SET local_state = ?, updated_at = ? WHERE task_id = ? AND NOT EXISTS (SELECT 1 FROM journal_terminal WHERE journal_terminal.task_id = journal_task.task_id)')
        .run(record.to, record.occurredAt, record.taskId);
    }
    this.#fault('transition:before-commit');
    return written(undefined);
  }

  /**
   * First terminal wins, matching the cloud's own receipt rule (§12.6.4:
   * 不覆写第一份事实). A repeat carrying the SAME payload hash is a delivery
   * retry and updates only the retry bookkeeping (`truth_state`, `attempt`,
   * `last_error`); a repeat carrying a DIFFERENT hash is a second, distinct
   * terminal for a task that already has one, and is recorded nowhere — the
   * first fact stands.
   */
  recordTerminal(record: LocalTerminalRecord): JournalWrite<void> {
    this.#assertTerminalBytes(record.bytes, record.payloadHash);
    this.#requireTask(record.taskId, 'recordTerminal');
    const existing = this.#db.prepare('SELECT * FROM journal_terminal WHERE task_id = ?')
      .get(record.taskId) as { payload_hash: string; bytes: string; truth_state: string } | undefined;
    if (!existing) {
      this.#insertTerminal(record);
      this.#db.prepare('UPDATE journal_task SET local_state = ?, updated_at = ? WHERE task_id = ?')
        .run(`terminal:${record.terminalType}`, record.recordedAt, record.taskId);
    } else if (existing.payload_hash === record.payloadHash && existing.bytes === record.bytes && existing.truth_state !== 'confirmed') {
      this.#db.prepare('UPDATE journal_terminal SET truth_state = ?, attempt = ?, last_error = ?, updated_at = ? WHERE task_id = ?')
        .run(record.truthState, record.attempt, record.lastError ?? null, record.recordedAt, record.taskId);
    }
    if (record.recovery !== undefined && !existing) {
      this.#db.prepare('UPDATE journal_task SET recovery_marker = ?, updated_at = ? WHERE task_id = ?')
        .run(JSON.stringify({ ...record.recovery, occurredAt: record.recovery.occurredAt ?? record.recordedAt }), record.recordedAt, record.taskId);
      this.#fault('recovery:before-commit');
    }
    this.#fault('terminal:before-commit');
    return record.recovery === undefined
      ? written(undefined, 'terminal:after-commit')
      : written(undefined, 'recovery:after-commit', 'terminal:after-commit');
  }

  #assertTerminalBytes(bytes: string, payloadHash: string): void {
    if (typeof bytes !== 'string' || journalHash(bytes) !== payloadHash) {
      throw new Error('terminal bytes do not match their canonical hash');
    }
    const { maxRecordBytes } = this.#options;
    const length = byteLength(bytes);
    if (length <= maxRecordBytes) return;
    const bound = isSealedEnvelope(bytes) ? Math.max(maxRecordBytes, ENVELOPE_RECORD_FLOOR_BYTES) : maxRecordBytes;
    if (length > bound) throw new JournalRecordTooLargeError('terminal bytes', length, bound);
  }

  #insertTerminal(record: LocalTerminalRecord): void {
    this.#db.prepare(`INSERT INTO journal_terminal
      (task_id, terminal_type, bytes, payload_hash, truth_state, attempt, last_error, recorded_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.taskId, record.terminalType, record.bytes, record.payloadHash, record.truthState,
        record.attempt, record.lastError ?? null, record.recordedAt, record.recordedAt);
  }

  replaceRefusedTerminal(taskId: string, refusedPayloadHash: string, record: LocalTerminalRecord): JournalWrite<void> {
    this.#assertTerminalBytes(record.bytes, record.payloadHash);
    const row = this.#db.prepare('SELECT payload_hash, truth_state, terminal_type, last_error FROM journal_terminal WHERE task_id = ?')
      .get(taskId) as { payload_hash: string; truth_state: string; terminal_type: string; last_error: string | null } | undefined;
    if (row?.payload_hash === record.payloadHash) return written(undefined, 'replace:after-commit');
    if (row?.payload_hash !== refusedPayloadHash || row.truth_state !== 'failed') {
      throw new Error('terminal replacement does not match a refused durable terminal');
    }
    this.#db.prepare(`UPDATE journal_terminal SET terminal_type = ?, bytes = ?, payload_hash = ?, truth_state = 'pending',
      attempt = ?, last_error = NULL, updated_at = ? WHERE task_id = ? AND payload_hash = ? AND truth_state = 'failed'`)
      .run(record.terminalType, record.bytes, record.payloadHash, record.attempt, record.recordedAt, taskId, refusedPayloadHash);
    this.#db.prepare('UPDATE journal_task SET local_state = ?, updated_at = ? WHERE task_id = ?')
      .run(`terminal:${record.terminalType}`, record.recordedAt, taskId);
    this.#db.prepare(`INSERT OR IGNORE INTO journal_transition (transition_id, task_id, from_state, to_state, occurred_at, detail)
         VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`terminal-replaced:${taskId}:${refusedPayloadHash}`, taskId, `terminal:${row.terminal_type}`, `terminal:${record.terminalType}`,
        record.recordedAt, `refused ${refusedPayloadHash}: ${row.last_error ?? ''}`);
    this.#fault('replace:before-commit');
    return written(undefined, 'replace:after-commit');
  }

  terminalDisposition(taskId: string, payloadHash: string, state: 'confirmed' | 'failed', reason: string | undefined, admittedAt: string): JournalWrite<void> {
    const row = this.#db.prepare('SELECT payload_hash FROM journal_terminal WHERE task_id = ?').get(taskId) as { payload_hash: string } | undefined;
    if (!row || row.payload_hash !== payloadHash) {
      // A late disposition of bytes that a replacement took over changes nothing.
      if (this.#db.prepare('SELECT 1 FROM journal_transition WHERE transition_id = ?').get(`terminal-replaced:${taskId}:${payloadHash}`)) {
        return written(undefined, 'confirm:after-commit');
      }
      throw new Error('terminal acknowledgement does not match durable terminal');
    }
    this.#db.prepare(`UPDATE journal_terminal SET truth_state = ?, last_error = ?, updated_at = ?
      WHERE task_id = ? AND truth_state <> 'confirmed'`).run(state, reason ?? null, admittedAt, taskId);
    this.#fault('confirm:before-commit');
    return written(undefined, 'confirm:after-commit');
  }

  /**
   * Writes the recovery marker. Idempotent and additive: a task already
   * marked is left exactly as it was (the FIRST recovery decision is the real
   * one), and no path here deletes anything — §12.7.2.1 puts recovery-marked
   * records on the never-auto-delete list, and this is what puts them there.
   */
  markRecovered(taskId: string, outcome: RecoveryOutcome, admittedAt: string): JournalWrite<void> {
    this.#requireTask(taskId, 'markRecovered');
    const occurredAt = outcome.occurredAt ?? admittedAt;
    this.#db
      .prepare('UPDATE journal_task SET recovery_marker = ?, updated_at = ? WHERE task_id = ? AND recovery_marker IS NULL')
      .run(
        JSON.stringify({ disposition: outcome.disposition, reason: outcome.reason ?? null, occurredAt }),
        occurredAt,
        taskId,
      );
    this.#fault('recovery:before-commit');
    return written(undefined);
  }

  pruneConfirmedJournalTask(taskId: string, before: string): JournalWrite<boolean> {
    const eligible = this.#db
      .prepare(
        `SELECT t.tenant_id, t.product_id, t.device_id
           FROM journal_task t
           JOIN journal_terminal term ON term.task_id = t.task_id
          WHERE t.task_id = ?
            AND t.recovery_marker IS NULL
            AND term.truth_state = 'confirmed'
            AND term.updated_at < ?`,
      )
      .get(taskId, before) as Record<string, unknown> | undefined;
    if (eligible) this.#prunableTaskCancellations(taskId, eligible);
    else if (!this.#cancelledReceivedTask(taskId, before)) return written(false);

    // Child-first, so `foreign_keys=ON` is satisfied at every statement
    // rather than deferred to the commit — a deletion order the database
    // itself rejects is a deletion order that was never reviewed.
    this.#db.prepare('DELETE FROM journal_transition WHERE task_id = ?').run(taskId);
    this.#db.prepare('DELETE FROM journal_terminal WHERE task_id = ?').run(taskId);
    this.#db.prepare('DELETE FROM journal_task WHERE task_id = ?').run(taskId);
    this.#db.prepare('DELETE FROM journal_idempotency WHERE task_id = ?').run(taskId);
    this.#db.prepare('DELETE FROM journal_envelope WHERE task_id = ?').run(taskId);
    this.#fault('prune:before-commit');
    return written(true);
  }

  /** Rechecks the cancelled-offer rule and its cutoff inside the prune transaction, verifying every stored envelope of the task first. */
  #cancelledReceivedTask(taskId: string, before: string): boolean {
    const task = this.#db.prepare(`SELECT t.tenant_id, t.product_id, t.device_id, t.seq FROM journal_task t
      WHERE t.task_id = ? AND ${CANCELLED_RECEIVED_TASK}`).get(taskId) as Record<string, unknown> | undefined;
    if (!task) return false;
    const cancellations = this.#prunableTaskCancellations(taskId, task);
    const cancellation = cancellations.find((row) => Number(row.seq) > Number(task.seq));
    // Fresh evidence under a reused task id, or a direct call, is not yet past retention.
    return cancellation !== undefined && (cancellation.committed_at as string) < before;
  }

  /** Both prune branches delete all task envelopes, so neither may bypass their integrity checks. */
  #prunableTaskCancellations(taskId: string, task: Record<string, unknown>): Record<string, unknown>[] {
    const identity = { tenantId: task.tenant_id as string, productId: task.product_id as string, deviceId: task.device_id as string };
    const rows = this.#taskEnvelopeRows(taskId, identity);
    return integrity(taskId, () => rows.filter((row) => {
      const envelope = JSON.parse(row.bytes as string) as { type?: unknown; task_id?: unknown };
      if (envelope.type === 'task.cancel') {
        if (assertTaskCancellationBinding(row.bytes as string, taskId, Number(row.seq) - 1) !== Number(row.seq)) {
          throw new Error('invalid durable cancellation binding');
        }
        return true;
      }
      if (envelope.task_id !== taskId) throw new Error('invalid durable envelope task binding');
      return false;
    }));
  }

  // ---------------------------------------------------------------------
  // Reads and maintenance: each runs alone, outside any write transaction.
  // ---------------------------------------------------------------------

  #assertIdentity(row: Record<string, unknown>, identity: JournalIdentity): void {
    if (row.tenant_id !== identity.tenantId || row.product_id !== identity.productId || row.device_id !== identity.deviceId) {
      throw new Error('journal enrollment identity mismatch; refusing cross-enrollment execution or terminal replay');
    }
  }

  #taskFields(row: Record<string, unknown>): Omit<RecoverableTask, 'envelopeBytes'> {
    return {
      taskId: row.task_id as string, envelopeId: row.envelope_id as string, seq: Number(row.seq),
      identity: { tenantId: row.tenant_id as string, productId: row.product_id as string, deviceId: row.device_id as string },
      localState: row.recovery_marker !== null && !String(row.local_state).startsWith('terminal:') ? 'interrupted' : row.local_state as string,
      ...(row.claimed_runtime == null ? {} : { claimedRuntime: row.claimed_runtime as string }),
      ...(row.workspace_ref == null ? {} : { workspaceRef: row.workspace_ref as string }),
      updatedAt: row.updated_at as string,
    };
  }

  /** Recovery never reads a withheld offer: its task always has a terminal. */
  #storedTaskRow(row: Record<string, unknown>): RecoverableTask {
    if (typeof row.envelope_bytes !== 'string' || journalHash(row.envelope_bytes) !== row.envelope_hash) {
      throw new Error('durable offer bytes/hash mismatch');
    }
    return { ...this.#taskFields(row), envelopeBytes: row.envelope_bytes };
  }

  #taskRow(row: Record<string, unknown>): RecoverableTask | WithheldOfferTask {
    if (row.withheld_bytes === null) return this.#storedTaskRow(row);
    if (row.envelope_bytes !== '') throw new Error('withheld offer row carries bytes');
    return { ...this.#taskFields(row), withheldEnvelopeBytes: Number(row.withheld_bytes) };
  }

  readTask(taskId: string, identity: JournalIdentity): RecoverableTask | WithheldOfferTask | undefined {
    const row = this.#db.prepare(`SELECT t.*, e.bytes AS envelope_bytes, e.bytes_hash AS envelope_hash, e.withheld_bytes FROM journal_task t
      JOIN journal_envelope e ON e.envelope_id = t.envelope_id WHERE t.task_id = ?`).get(taskId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    this.#assertIdentity(row, identity);
    return this.#taskRow(row);
  }

  readTaskCancellation(taskId: string, identity: JournalIdentity, afterSeq: number) {
    const row = this.#taskEnvelopeRows(taskId, identity).find((candidate) => (candidate.seq as number) > afterSeq
      && JSON.parse(candidate.bytes as string).type === 'task.cancel');
    if (!row) return undefined;
    return {
      identity: { tenantId: row.tenant_id as string, productId: row.product_id as string, deviceId: row.device_id as string },
      bytes: row.bytes as string, bytesHash: row.bytes_hash as string,
    };
  }

  /** Every non-withheld stored envelope of the task, in sequence order, after its enrollment and hash are verified. */
  #taskEnvelopeRows(taskId: string, identity: JournalIdentity): Record<string, unknown>[] {
    const rows = this.#db.prepare(`SELECT tenant_id, product_id, device_id, seq, bytes, bytes_hash, committed_at, withheld_bytes FROM journal_envelope
      WHERE task_id = ?
      ORDER BY seq, envelope_id`).all(taskId) as Record<string, unknown>[];
    // Validate every candidate before its content can exclude it, including
    // candidates after the first valid cancellation.
    integrity(taskId, () => {
      for (const row of rows) {
        this.#assertIdentity(row, identity);
        if (row.withheld_bytes !== null) {
          if (row.bytes !== '') throw new Error('withheld offer row carries bytes');
          continue;
        }
        if (typeof row.bytes !== 'string' || journalHash(row.bytes) !== row.bytes_hash) {
          throw new Error('durable cancellation candidate bytes/hash mismatch');
        }
      }
    });
    return rows.filter((row) => row.withheld_bytes === null);
  }

  listRecoveryTasks(identity: JournalIdentity): RecoverableTask[] {
    const rows = this.#db.prepare(`SELECT t.*, e.bytes AS envelope_bytes, e.bytes_hash AS envelope_hash FROM journal_task t
      JOIN journal_envelope e ON e.envelope_id = t.envelope_id
      LEFT JOIN journal_terminal term ON term.task_id = t.task_id
      WHERE term.task_id IS NULL ORDER BY t.seq, t.task_id`).all() as Record<string, unknown>[];
    return rows.map((row) => { this.#assertIdentity(row, identity); return this.#storedTaskRow(row); });
  }

  listPendingTerminals(identity: JournalIdentity): LocalTerminalRecord[] {
    const rows = this.#db.prepare(`SELECT term.*, t.tenant_id, t.product_id, t.device_id FROM journal_terminal term
      JOIN journal_task t ON t.task_id = term.task_id WHERE term.truth_state <> 'confirmed'
      ORDER BY term.recorded_at, term.task_id`).all() as Record<string, unknown>[];
    return rows.map((row) => {
      this.#assertIdentity(row, identity);
      if (typeof row.bytes !== 'string' || journalHash(row.bytes) !== row.payload_hash) throw new Error('durable terminal bytes/hash mismatch');
      return { taskId: row.task_id as string, terminalType: row.terminal_type as LocalTerminalRecord['terminalType'],
        bytes: row.bytes, payloadHash: row.payload_hash as string, truthState: row.truth_state as LocalTerminalRecord['truthState'],
        attempt: Number(row.attempt), recordedAt: row.recorded_at as string,
        ...(row.last_error === null ? {} : { lastError: row.last_error as string }) };
    });
  }

  /**
   * What this daemon was in the middle of: a task whose offer envelope is
   * durable, that has no terminal, that was not declined, and that recovery
   * has not already closed out.
   *
   * A task with a terminal is NOT here even when the cloud has not confirmed
   * it — that is terminal REDELIVERY (§12.7.3's "terminal 生成后、truth 写入前"
   * row), a different track with different evidence, and folding the two
   * together would have recovery re-admit a task that already finished.
   */
  listRecoverable(): RecoverableTask[] {
    const rows = this.#db
      .prepare(
        `SELECT t.task_id, t.envelope_id, t.seq, t.tenant_id, t.product_id, t.device_id,
                t.local_state, t.claimed_runtime, t.workspace_ref, t.updated_at, e.bytes AS envelope_bytes, e.bytes_hash AS envelope_hash
           FROM journal_task t
           JOIN journal_envelope e ON e.envelope_id = t.envelope_id
           LEFT JOIN journal_terminal term ON term.task_id = t.task_id
          WHERE t.recovery_marker IS NULL
            AND term.task_id IS NULL
            AND t.local_state <> ?
          ORDER BY t.created_at ASC, t.task_id ASC`,
      )
      .all(DECLINED_STATE) as Array<Record<string, unknown>>;
    return rows.map((row): RecoverableTask => {
      const claimedRuntime = row.claimed_runtime as string | null;
      const workspaceRef = row.workspace_ref as string | null;
      return {
        taskId: row.task_id as string,
        envelopeId: row.envelope_id as string,
        seq: Number(row.seq),
        identity: {
          tenantId: row.tenant_id as string,
          productId: row.product_id as string,
          deviceId: row.device_id as string,
        },
        localState: row.local_state as string,
        ...(claimedRuntime === null ? {} : { claimedRuntime }),
        ...(workspaceRef === null ? {} : { workspaceRef }),
        updatedAt: row.updated_at as string,
        envelopeBytes: row.envelope_bytes as string,
      };
    });
  }

  /** Physical journal/quarantine footprint and confirmed-row inventory. */
  measureUsage(admittedAt: string): LocalStorageUsage {
    const { dbPath, quarantineDir } = this.#options;
    const rows = this.#db.prepare(`SELECT COUNT(*) AS entries FROM journal_envelope`).get() as { entries: number };
    const confirmed = this.#db.prepare(`SELECT COUNT(*) AS entries, MIN(term.updated_at) AS oldest
      FROM journal_terminal term JOIN journal_task task ON task.task_id = term.task_id
      WHERE term.truth_state = 'confirmed' AND task.recovery_marker IS NULL`).get() as { entries: number; oldest: string | null };
    const cancelled = this.#db.prepare(`SELECT COUNT(*) AS entries, MIN(at) AS oldest FROM (SELECT (SELECT MIN(c.committed_at) ${LATER_CANCELLATION}) AS at
      FROM journal_task t WHERE ${CANCELLED_RECEIVED_TASK}) WHERE at IS NOT NULL`).get() as { entries: number; oldest: string | null };
    const oldest = [confirmed.oldest, cancelled.oldest].filter((at): at is string => at !== null).sort()[0];
    return {
      measuredAt: admittedAt,
      journalBytes: fileBytes(dbPath) + fileBytes(`${dbPath}-wal`) + fileBytes(`${dbPath}-shm`),
      quarantineBytes: directoryBytes(quarantineDir),
      journalEntries: Number(rows.entries), confirmedEntries: Number(confirmed.entries) + Number(cancelled.entries),
      ...(oldest === undefined ? {} : { oldestConfirmedAt: oldest }),
    };
  }

  listPrunableConfirmedTasks(cutoff: string, limit: number, after: string | undefined): string[] {
    // A cancelled received offer ages from its cancellation's commit. Once it
    // is pruned, a conforming mailbox never redelivers the offer: it replays
    // only above the acknowledged cursor and suppresses a cancelled task's
    // offer through a task record it never deletes (spec, #1990).
    const candidates = `SELECT task.task_id, term.updated_at AS at FROM journal_task task
          JOIN journal_terminal term ON term.task_id = task.task_id
         WHERE term.truth_state = 'confirmed' AND task.recovery_marker IS NULL
        UNION ALL
        SELECT t.task_id, (SELECT MIN(c.committed_at) ${LATER_CANCELLATION}) AS at FROM journal_task t WHERE ${CANCELLED_RECEIVED_TASK}`;
    const rows = (after === undefined
      ? this.#db.prepare(`SELECT task_id FROM (${candidates}) WHERE at < ? ORDER BY at, task_id LIMIT ?`).all(cutoff, limit)
      : this.#db.prepare(`WITH candidate AS (${candidates})
          SELECT task_id FROM candidate WHERE at < ? AND (at, task_id) > (SELECT at, task_id FROM candidate WHERE task_id = ?)
          ORDER BY at, task_id LIMIT ?`).all(cutoff, after, limit)) as { task_id: string }[];
    return rows.map(row => row.task_id);
  }

  /**
   * WAL checkpoint plus a BOUNDED incremental vacuum. Maintenance only — it
   * runs in the same worker queue as everything else, so it can never run
   * concurrently with an ack-critical append, and `incrementalVacuumPages`
   * caps how long one pass can hold that queue.
   */
  compact(options: CompactOptions): CompactResult {
    const startedAt = Date.now();
    const mode = options.checkpoint === 'truncate' ? 'TRUNCATE' : 'PASSIVE';
    const checkpoint = this.#db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as
      | { busy: number; log: number; checkpointed: number }
      | undefined;

    const freelistBefore = this.#freelistPages();
    if (options.incrementalVacuumPages !== undefined && options.incrementalVacuumPages > 0) {
      this.#db.exec(`PRAGMA incremental_vacuum(${Math.floor(options.incrementalVacuumPages)});`);
    }
    const freelistAfter = this.#freelistPages();

    const log = Number(checkpoint?.log ?? 0);
    const checkpointed = Number(checkpoint?.checkpointed ?? 0);
    return {
      checkpointed: Number(checkpoint?.busy ?? 0) === 0,
      walFramesRemaining: Math.max(0, log - checkpointed),
      pagesVacuumed: Math.max(0, freelistBefore - freelistAfter),
      durationMs: Date.now() - startedAt,
    };
  }

  #freelistPages(): number {
    const row = this.#db.prepare('PRAGMA freelist_count').get() as { freelist_count?: number } | undefined;
    return Number(row?.freelist_count ?? 0);
  }
}
