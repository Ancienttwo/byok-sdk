/**
 * `SqliteLocalTaskJournal` — the production {@link LocalTaskJournal}
 * (architecture §12.7.2).
 *
 * One database, `<storeDir>/daemon.db`, holding the eight §12.7.2 tables. The
 * three properties this file exists to provide, and the mechanism for each:
 *
 * 1. **A commit means fsynced.** `synchronous=FULL` plus WAL (see
 *    `sqlite-support.ts`'s `openJournalDatabase` for the pragma order and why
 *    it matters). `appendEnvelope` resolving is the daemon's licence to let
 *    the mailbox cursor move past that seq, so anything weaker here turns
 *    every power cut into a task-loss window.
 * 2. **Envelope bytes, task record, and idempotency receipt land together or
 *    not at all.** One `BEGIN IMMEDIATE` transaction covers all three
 *    (§12.7.3: "v1 bytes 与本机 task record 已在同一个本机 transaction durable
 *    append"). This is the repo's first multi-statement SQLite transaction, so
 *    the idiom is established here: `BEGIN IMMEDIATE` (take the write lock up
 *    front — `DEFERRED` would upgrade mid-transaction and can deadlock two
 *    writers), work, `COMMIT`, and a `ROLLBACK` on any throw.
 * 3. **A redelivered envelope is a no-op.** The wire is at-least-once and a
 *    crash between commit and ack GUARANTEES a redelivery, so idempotency is
 *    the normal path, not the exceptional one: the receipt row keyed by
 *    envelope id is looked up inside the same transaction that would write it.
 *
 * Writes are serialized through a single-writer promise queue. `node:sqlite`
 * is fully synchronous, so this is not about mutual exclusion within one
 * operation — it is about ordering across them, and about giving the fault
 * seam and the busy timeout one place to live. The timeout is BOUNDED
 * (`busyTimeoutMs`) so lock contention surfaces as an error the envelope path
 * can report rather than an unbounded stall.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  JournalClosedError,
  JournalCorruptError,
  JournalRecordTooLargeError,
  JournalUnavailableError,
  JournalUnknownTaskError,
  type AdmissionRecord,
  type CategoryUsage,
  type CleanableCategory,
  type CleanupCandidate,
  type CleanupResult,
  type CompactOptions,
  type CompactResult,
  type JournalReceipt,
  type LocalStorageUsage,
  type LocalTaskJournal,
  type LocalTerminalRecord,
  type LocalTransitionRecord,
  type RecoverableTask,
  type RecoveryOutcome,
  type ReceivedEnvelopeRecord,
  type StorageCategory,
} from './journal';
import { isSqliteAvailable, openJournalDatabase, secureJournalFilePermissions } from './sqlite-support';

/** The single database file, per §12.7.2's "建议单库 `<storeDir>/daemon.db`". */
export const JOURNAL_DB_FILENAME = 'daemon.db';

/** Where a database that failed to open is moved to. On §12.7.2.1's never-auto-delete list. */
export const JOURNAL_QUARANTINE_DIRNAME = 'quarantine';

/**
 * Default per-record byte bound. Generous next to a real `task.offer` (an
 * instruction plus a policy object — kilobytes), tight enough that an
 * envelope carrying an inlined artifact is refused instead of turning the
 * journal into a blob store. See {@link JournalRecordTooLargeError}.
 */
export const DEFAULT_MAX_RECORD_BYTES = 256 * 1024;

/** Default bound on how long a write waits for the write lock before failing. */
export const DEFAULT_JOURNAL_BUSY_TIMEOUT_MS = 5_000;

/** Bound on a transition's free-form `detail` note — this is metadata, not a place for tool output. */
const MAX_TRANSITION_DETAIL_BYTES = 4 * 1024;

/**
 * Named points inside a write where {@link JournalFaultSeam} may throw.
 *
 * These exist so the crash matrix can put a failure at an exact ordering
 * boundary — "after the envelope row, before the task row", "after the receipt,
 * before the commit" — deterministically, with no wall clock and no real
 * process kill. Same DI shape as `EnsureSecureDirOptions.run`
 * (`util/secure-dir.ts`): a seam the production path never supplies, exercised
 * from any host.
 */
export type JournalFaultStep =
  | 'append:before-begin'
  | 'append:after-envelope'
  | 'append:after-task'
  | 'append:after-receipt'
  | 'append:before-commit'
  | 'admission:before-commit'
  | 'transition:before-commit'
  | 'terminal:before-commit'
  | 'recovery:before-commit'
  | 'cleanup:before-commit';

export interface JournalFaultSeam {
  /** Throw to simulate a crash or IO error at exactly this step. Return normally to proceed. */
  onStep?(step: JournalFaultStep): void;
}

export interface SqliteLocalTaskJournalOptions {
  /** The daemon's store directory. The database lives at `<storeDir>/daemon.db` and quarantine at `<storeDir>/quarantine/`. */
  readonly storeDir: string;
  /** Bound on waiting for the write lock. Default {@link DEFAULT_JOURNAL_BUSY_TIMEOUT_MS}. */
  readonly busyTimeoutMs?: number;
  /** Per-record byte bound. Default {@link DEFAULT_MAX_RECORD_BYTES}. */
  readonly maxRecordBytes?: number;
  /** Test seam — see {@link JournalFaultSeam}. Never supplied in production. */
  readonly faults?: JournalFaultSeam;
  /** Injected clock, so receipt/quarantine timestamps are deterministic under test. Defaults to the real one. */
  readonly clock?: () => Date;
}

/**
 * The eight tables of §12.7.2, verbatim in purpose:
 *
 * - `journal_envelope` — tenant/product/device, seq, envelope id, task id, raw
 *   bytes and hash, commit/ack times;
 * - `journal_task` — admission, claimed runtime, effective policy hash,
 *   workspace ref, current local state, recovery marker;
 * - `journal_transition` — transition id, from/to, `occurred_at`, idempotent
 *   by transition id;
 * - `journal_terminal` — terminal payload hash, truth write state, last
 *   retry/error;
 * - `journal_idempotency` — outbound request / envelope / receipt ids;
 * - `local_artifact_ref` — path/hash/size/ref state of filesystem objects,
 *   never the payload itself;
 * - `local_cleanup_candidate` — `eligible_at`, reason, class, attempt/error,
 *   for safe GC;
 * - `local_storage_usage` — measured or approximate bytes per category.
 *
 * `CREATE TABLE IF NOT EXISTS` only, matching the repo's existing SQLite store
 * (there is no migration machinery here, and this schema has no shipped
 * predecessor to migrate from).
 *
 * The foreign keys are load-bearing rather than decorative: with
 * `foreign_keys=ON`, a transition or terminal for a task whose offer envelope
 * was never appended is refused by the database itself. An orphan row in a
 * recovery journal is not a tolerable inconsistency — it is recovery evidence
 * that describes a task nothing can account for.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS journal_envelope (
  envelope_id   TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  product_id    TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  task_id       TEXT,
  bytes         TEXT NOT NULL,
  bytes_hash    TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  committed_at  TEXT NOT NULL,
  acked_at      TEXT
);
CREATE INDEX IF NOT EXISTS journal_envelope_seq ON journal_envelope (device_id, seq);

CREATE TABLE IF NOT EXISTS journal_task (
  task_id               TEXT PRIMARY KEY,
  envelope_id           TEXT NOT NULL REFERENCES journal_envelope (envelope_id),
  tenant_id             TEXT NOT NULL,
  product_id            TEXT NOT NULL,
  device_id             TEXT NOT NULL,
  seq                   INTEGER NOT NULL,
  admitted              INTEGER,
  admission_reason      TEXT,
  admission_retryable   INTEGER,
  claimed_runtime       TEXT,
  effective_policy_hash TEXT,
  workspace_ref         TEXT,
  local_state           TEXT NOT NULL,
  recovery_marker       TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS journal_transition (
  transition_id TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES journal_task (task_id),
  from_state    TEXT,
  to_state      TEXT NOT NULL,
  occurred_at   TEXT NOT NULL,
  detail        TEXT
);
CREATE INDEX IF NOT EXISTS journal_transition_task ON journal_transition (task_id, occurred_at);

CREATE TABLE IF NOT EXISTS journal_terminal (
  task_id       TEXT PRIMARY KEY REFERENCES journal_task (task_id),
  terminal_type TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  truth_state   TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  last_error    TEXT,
  recorded_at   TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS journal_idempotency (
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  task_id    TEXT,
  receipt    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS local_artifact_ref (
  ref_id     TEXT PRIMARY KEY,
  task_id    TEXT,
  path       TEXT NOT NULL,
  hash       TEXT,
  size_bytes INTEGER NOT NULL,
  ref_state  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_cleanup_candidate (
  candidate_id TEXT PRIMARY KEY,
  category     TEXT NOT NULL,
  ref          TEXT NOT NULL,
  eligible_at  TEXT NOT NULL,
  reason       TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  outcome      TEXT,
  resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS local_cleanup_candidate_eligible
  ON local_cleanup_candidate (resolved_at, eligible_at);

CREATE TABLE IF NOT EXISTS local_storage_usage (
  category    TEXT PRIMARY KEY,
  bytes       INTEGER NOT NULL,
  approximate INTEGER NOT NULL,
  measured_at TEXT NOT NULL
);
`;

/** `local_state` for a task whose admission declined it — terminal for local purposes, and NOT something recovery should re-offer. */
const DECLINED_STATE = 'declined';
/** `local_state` a task starts in: its offer envelope is durable, nothing has been decided yet. */
const RECEIVED_STATE = 'received';

/** The categories `measureUsage` reports. Host-reported ones default to zero-approximate rather than being guessed at. */
const HOST_REPORTED_CATEGORIES: readonly StorageCategory[] = ['cache', 'log', 'workspace'];

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function directoryBytes(dir: string): number {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? directoryBytes(full) : fileBytes(full);
  }
  return total;
}

/**
 * Move a database that could not be opened aside, with its WAL/SHM siblings
 * and a manifest, and return where it went.
 *
 * `renameSync` within one directory tree is atomic, so there is no window in
 * which the file is half-moved. NOTHING is deleted: a corrupt journal is the
 * only record of what this machine was doing, and the failure mode this
 * protects against — opening a fresh empty database over it, reporting "no
 * recoverable tasks", and losing the evidence of why — is silent and
 * unrecoverable. The manifest is written last so its presence means the move
 * completed.
 */
function quarantineDatabase(storeDir: string, dbPath: string, reason: string, now: Date): string {
  const dir = join(storeDir, JOURNAL_QUARANTINE_DIRNAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let base = `${stamp}-${JOURNAL_DB_FILENAME}`;
  // Two quarantines within the same millisecond (a restart loop against a
  // corrupt file is exactly how that happens) must not overwrite each other.
  for (let attempt = 1; existsSync(join(dir, base)); attempt += 1) {
    base = `${stamp}-${attempt}-${JOURNAL_DB_FILENAME}`;
  }
  const moved: string[] = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${dbPath}${suffix}`;
    if (!existsSync(from)) continue;
    const to = join(dir, `${base}${suffix}`);
    renameSync(from, to);
    moved.push(to);
  }
  writeFileSync(
    join(dir, `${base}.manifest.json`),
    `${JSON.stringify({ quarantinedAt: now.toISOString(), reason, originalPath: dbPath, files: moved }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return join(dir, base);
}

export class SqliteLocalTaskJournal implements LocalTaskJournal {
  readonly #db: DatabaseSync;
  readonly #dbPath: string;
  readonly #storeDir: string;
  readonly #maxRecordBytes: number;
  readonly #faults: JournalFaultSeam | undefined;
  readonly #clock: () => Date;
  /**
   * The single-writer queue's tail. Every operation chains onto it, so two
   * concurrent callers never interleave two transactions — and the `#closed`
   * check happens in queue order, not at call time, so an operation queued
   * before `close()` still runs.
   */
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: SqliteLocalTaskJournalOptions) {
    // Checked BEFORE anything touches the filesystem: §12.7.2's
    // no-silent-downgrade rule is about refusing to start, and a refusal that
    // has already created directories is a worse refusal.
    if (!isSqliteAvailable()) {
      throw new JournalUnavailableError(`node:sqlite could not be loaded on Node ${process.versions.node}`);
    }

    this.#storeDir = options.storeDir;
    this.#dbPath = join(options.storeDir, JOURNAL_DB_FILENAME);
    this.#maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    this.#faults = options.faults;
    this.#clock = options.clock ?? (() => new Date());

    mkdirSync(options.storeDir, { recursive: true, mode: 0o700 });

    // Open + schema are one unit for quarantine purposes: a file whose header
    // reads fine but whose schema cannot be created is just as unusable, and
    // just as much evidence, as one that fails at open.
    let db: DatabaseSync;
    try {
      db = openJournalDatabase(this.#dbPath, options.busyTimeoutMs ?? DEFAULT_JOURNAL_BUSY_TIMEOUT_MS);
      db.exec(SCHEMA);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const quarantinePath = quarantineDatabase(options.storeDir, this.#dbPath, reason, this.#clock());
      throw new JournalCorruptError(this.#dbPath, quarantinePath, reason, { cause: err });
    }
    this.#db = db;
    secureJournalFilePermissions(this.#dbPath);
  }

  // ---------------------------------------------------------------------
  // Single-writer queue + the repo's first multi-statement transaction idiom
  // ---------------------------------------------------------------------

  #enqueue<T>(operation: string, work: () => T): Promise<T> {
    const run = this.#tail.then(() => {
      if (this.#closed) throw new JournalClosedError(operation);
      return work();
    });
    // The queue must survive a failed operation: chain the NEXT caller onto a
    // settled promise regardless of this one's outcome, or one rejected write
    // would poison every write after it.
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * `BEGIN IMMEDIATE` … `COMMIT`, with `ROLLBACK` on any throw.
   *
   * `IMMEDIATE` rather than the default `DEFERRED`: the write lock is taken up
   * front, so a transaction can never discover halfway through that it cannot
   * upgrade. The `ROLLBACK` is itself wrapped — if the failure was the commit
   * or the connection, SQLite may already have rolled back and a second
   * `ROLLBACK` throws "cannot rollback - no transaction is active"; swallowing
   * that is correct, and swallowing it must not mask the ORIGINAL error, which
   * is what is rethrown.
   */
  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    let result: T;
    try {
      result = work();
      this.#db.exec('COMMIT');
    } catch (err) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Already rolled back by SQLite itself — see above.
      }
      throw err;
    }
    return result;
  }

  #fault(step: JournalFaultStep): void {
    this.#faults?.onStep?.(step);
  }

  #requireTask(taskId: string, operation: string): void {
    const row = this.#db.prepare('SELECT task_id FROM journal_task WHERE task_id = ?').get(taskId);
    if (!row) throw new JournalUnknownTaskError(taskId, operation);
  }

  // ---------------------------------------------------------------------
  // LocalTaskJournal
  // ---------------------------------------------------------------------

  /**
   * The ack-critical path. Envelope bytes, the task record it opens, and the
   * idempotency receipt all land in ONE transaction, or none of them do.
   *
   * The receipt lookup happens INSIDE that transaction rather than as a cheap
   * pre-check outside it: `BEGIN IMMEDIATE` already holds the write lock by
   * then, so "is this a redelivery?" and "write it" cannot be separated by
   * another writer. The duplicate answer is served from the stored receipt,
   * so a redelivery returns the ORIGINAL commit time and hash — the caller
   * learns the bytes are durable and that this call changed nothing, which is
   * exactly what the cursor needed.
   */
  appendEnvelope(record: ReceivedEnvelopeRecord): Promise<JournalReceipt> {
    const bytes = byteLength(record.bytes);
    if (bytes > this.#maxRecordBytes) {
      return Promise.reject(new JournalRecordTooLargeError('bytes', bytes, this.#maxRecordBytes));
    }
    if (record.opensTask && record.taskId === undefined) {
      return Promise.reject(
        new Error('ReceivedEnvelopeRecord.opensTask is true but no taskId was supplied — refusing to append a task-opening envelope with no task identity'),
      );
    }

    return this.#enqueue('appendEnvelope', () => {
      this.#fault('append:before-begin');
      return this.#transaction((): JournalReceipt => {
        const existing = this.#db
          .prepare('SELECT receipt FROM journal_idempotency WHERE scope = ? AND key = ?')
          .get('envelope', record.envelopeId) as { receipt: string } | undefined;
        if (existing) {
          const prior = JSON.parse(existing.receipt) as Omit<JournalReceipt, 'created'>;
          return { ...prior, created: false };
        }

        const committedAt = this.#clock().toISOString();
        this.#db
          .prepare(
            `INSERT INTO journal_envelope
               (envelope_id, tenant_id, product_id, device_id, seq, task_id, bytes, bytes_hash, received_at, committed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.envelopeId,
            record.identity.tenantId,
            record.identity.productId,
            record.identity.deviceId,
            record.seq,
            record.taskId ?? null,
            record.bytes,
            record.bytesHash,
            record.receivedAt,
            committedAt,
          );
        this.#fault('append:after-envelope');

        if (record.opensTask && record.taskId !== undefined) {
          // `OR IGNORE`: a second, different envelope re-opening the same task
          // id (a re-offer after the cloud lost track) must not clobber the
          // admission/claim state the first one already accumulated. The
          // envelope row above still records that the second envelope arrived.
          this.#db
            .prepare(
              `INSERT OR IGNORE INTO journal_task
                 (task_id, envelope_id, tenant_id, product_id, device_id, seq, local_state, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              record.taskId,
              record.envelopeId,
              record.identity.tenantId,
              record.identity.productId,
              record.identity.deviceId,
              record.seq,
              RECEIVED_STATE,
              committedAt,
              committedAt,
            );
        }
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

        return { ...receipt, created: true };
      });
    });
  }

  recordAdmission(record: AdmissionRecord): Promise<void> {
    return this.#enqueue('recordAdmission', () => {
      this.#transaction(() => {
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
      });
    });
  }

  /**
   * Idempotent by transition id. `INSERT OR IGNORE` decides it: when the row
   * already exists nothing is inserted AND the task's `local_state` is left
   * alone, so replaying an old transition cannot drag a task's state
   * backwards — which is precisely what recovery replaying a stored sequence
   * would otherwise do.
   */
  recordTransition(record: LocalTransitionRecord): Promise<void> {
    if (record.detail !== undefined && byteLength(record.detail) > MAX_TRANSITION_DETAIL_BYTES) {
      return Promise.reject(
        new JournalRecordTooLargeError('detail', byteLength(record.detail), MAX_TRANSITION_DETAIL_BYTES),
      );
    }
    return this.#enqueue('recordTransition', () => {
      this.#transaction(() => {
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
            .prepare('UPDATE journal_task SET local_state = ?, updated_at = ? WHERE task_id = ?')
            .run(record.to, record.occurredAt, record.taskId);
        }
        this.#fault('transition:before-commit');
      });
    });
  }

  /**
   * First terminal wins, matching the cloud's own receipt rule (§12.6.4:
   * 不覆写第一份事实). A repeat carrying the SAME payload hash is a delivery
   * retry and updates only the retry bookkeeping (`truth_state`, `attempt`,
   * `last_error`); a repeat carrying a DIFFERENT hash is a second, distinct
   * terminal for a task that already has one, and is recorded nowhere — the
   * first fact stands.
   */
  recordTerminal(record: LocalTerminalRecord): Promise<void> {
    return this.#enqueue('recordTerminal', () => {
      this.#transaction(() => {
        this.#requireTask(record.taskId, 'recordTerminal');
        const existing = this.#db
          .prepare('SELECT payload_hash FROM journal_terminal WHERE task_id = ?')
          .get(record.taskId) as { payload_hash: string } | undefined;

        if (existing === undefined) {
          this.#db
            .prepare(
              `INSERT INTO journal_terminal
                 (task_id, terminal_type, payload_hash, truth_state, attempt, last_error, recorded_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              record.taskId,
              record.terminalType,
              record.payloadHash,
              record.truthState,
              record.attempt,
              record.lastError ?? null,
              record.recordedAt,
              record.recordedAt,
            );
          this.#db
            .prepare('UPDATE journal_task SET local_state = ?, updated_at = ? WHERE task_id = ?')
            .run(`terminal:${record.terminalType}`, record.recordedAt, record.taskId);
        } else if (existing.payload_hash === record.payloadHash) {
          this.#db
            .prepare('UPDATE journal_terminal SET truth_state = ?, attempt = ?, last_error = ?, updated_at = ? WHERE task_id = ?')
            .run(record.truthState, record.attempt, record.lastError ?? null, record.recordedAt, record.taskId);
        }
        this.#fault('terminal:before-commit');
      });
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
  listRecoverable(): Promise<RecoverableTask[]> {
    return this.#enqueue('listRecoverable', () => {
      const rows = this.#db
        .prepare(
          `SELECT t.task_id, t.envelope_id, t.seq, t.tenant_id, t.product_id, t.device_id,
                  t.local_state, t.claimed_runtime, t.workspace_ref, t.updated_at
             FROM journal_task t
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
        };
      });
    });
  }

  /**
   * Writes the recovery marker. Idempotent and additive: a task already
   * marked is left exactly as it was (the FIRST recovery decision is the real
   * one), and no path here deletes anything — §12.7.2.1 puts recovery-marked
   * records on the never-auto-delete list, and this is what puts them there.
   */
  markRecovered(taskId: string, outcome: RecoveryOutcome): Promise<void> {
    return this.#enqueue('markRecovered', () => {
      this.#transaction(() => {
        this.#requireTask(taskId, 'markRecovered');
        const occurredAt = outcome.occurredAt ?? this.#clock().toISOString();
        this.#db
          .prepare('UPDATE journal_task SET recovery_marker = ?, updated_at = ? WHERE task_id = ? AND recovery_marker IS NULL')
          .run(
            JSON.stringify({ disposition: outcome.disposition, reason: outcome.reason ?? null, occurredAt }),
            occurredAt,
            taskId,
          );
        this.#fault('recovery:before-commit');
      });
    });
  }

  /**
   * Per-category bytes (§12.7.2.1). `journal` and `quarantine` are MEASURED
   * off the filesystem — they are this object's own footprint, so guessing
   * would be inexcusable. `cache`/`log`/`workspace` are owned by other
   * subsystems, so they come from whatever they last reported into
   * `local_storage_usage`; with nothing reported the answer is an explicit
   * zero-marked-approximate, never a fabricated estimate.
   */
  measureUsage(): Promise<LocalStorageUsage> {
    return this.#enqueue('measureUsage', () => {
      const reported = new Map(
        (
          this.#db.prepare('SELECT category, bytes, approximate FROM local_storage_usage').all() as Array<
            Record<string, unknown>
          >
        ).map((row) => [
          row.category as string,
          { bytes: Number(row.bytes), approximate: Number(row.approximate) === 1 } satisfies CategoryUsage,
        ]),
      );

      const journalBytes =
        fileBytes(this.#dbPath) + fileBytes(`${this.#dbPath}-wal`) + fileBytes(`${this.#dbPath}-shm`);
      const categories: Record<StorageCategory, CategoryUsage> = {
        journal: { bytes: journalBytes, approximate: false },
        quarantine: {
          bytes: directoryBytes(join(this.#storeDir, JOURNAL_QUARANTINE_DIRNAME)),
          approximate: false,
        },
        cache: reported.get('cache') ?? { bytes: 0, approximate: true },
        log: reported.get('log') ?? { bytes: 0, approximate: true },
        workspace: reported.get('workspace') ?? { bytes: 0, approximate: true },
      };
      const totalBytes = Object.values(categories).reduce((sum, usage) => sum + usage.bytes, 0);
      return { measuredAt: this.#clock().toISOString(), totalBytes, categories };
    });
  }

  /**
   * Record what another subsystem measured for a category it owns. Beyond
   * S3.3's minimum API and deliberately restricted to the three categories
   * this journal does NOT measure itself — reporting a number for `journal`
   * or `quarantine` would let a stale figure override a measured one.
   */
  reportCategoryUsage(category: (typeof HOST_REPORTED_CATEGORIES)[number], usage: CategoryUsage): Promise<void> {
    return this.#enqueue('reportCategoryUsage', () => {
      this.#db
        .prepare(
          `INSERT INTO local_storage_usage (category, bytes, approximate, measured_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (category) DO UPDATE SET bytes = excluded.bytes, approximate = excluded.approximate,
                                                  measured_at = excluded.measured_at`,
        )
        .run(category, usage.bytes, usage.approximate ? 1 : 0, this.#clock().toISOString());
    });
  }

  /**
   * Register something the cleanup worker may act on. Beyond S3.3's minimum
   * API (which has no producer for the candidate table), and the only way a
   * row gets in: `category` is typed {@link CleanableCategory}, so protected
   * data has no spelling that would let it be enqueued in the first place.
   */
  enqueueCleanupCandidate(candidate: {
    readonly candidateId: string;
    readonly category: CleanableCategory;
    readonly ref: string;
    readonly eligibleAt: string;
    readonly reason: string;
  }): Promise<void> {
    return this.#enqueue('enqueueCleanupCandidate', () => {
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO local_cleanup_candidate (candidate_id, category, ref, eligible_at, reason, attempts)
           VALUES (?, ?, ?, ?, ?, 0)`,
        )
        .run(candidate.candidateId, candidate.category, candidate.ref, candidate.eligibleAt, candidate.reason);
    });
  }

  listCleanupCandidates(now: Date, limit: number): Promise<CleanupCandidate[]> {
    return this.#enqueue('listCleanupCandidates', () => {
      const rows = this.#db
        .prepare(
          `SELECT candidate_id, category, ref, eligible_at, reason, attempts, last_error
             FROM local_cleanup_candidate
            WHERE resolved_at IS NULL AND eligible_at <= ?
            ORDER BY eligible_at ASC, candidate_id ASC
            LIMIT ?`,
        )
        .all(now.toISOString(), limit) as Array<Record<string, unknown>>;
      return rows.map((row): CleanupCandidate => {
        const lastError = row.last_error as string | null;
        return {
          candidateId: row.candidate_id as string,
          category: row.category as CleanableCategory,
          ref: row.ref as string,
          eligibleAt: row.eligible_at as string,
          reason: row.reason as string,
          attempts: Number(row.attempts),
          ...(lastError === null ? {} : { lastError }),
        };
      });
    });
  }

  /**
   * `deleted`/`skipped` resolve the candidate; `failed` does NOT — it bumps
   * the attempt count and records the error, leaving the row eligible again.
   * That asymmetry is what makes a cleanup worker crash safe in either order:
   * crash after deleting the file but before marking, and the candidate is
   * retried against a file that is already gone (a no-op the worker reports as
   * `deleted`); crash after marking but before deleting, and the metadata says
   * resolved for something still on disk, which the next reference scan
   * re-enqueues. Neither order can lose protected data, because protected data
   * cannot be a candidate at all.
   */
  markCleanupResult(result: CleanupResult): Promise<void> {
    return this.#enqueue('markCleanupResult', () => {
      this.#transaction(() => {
        this.#db
          .prepare(
            `UPDATE local_cleanup_candidate
                SET attempts = attempts + 1,
                    last_error = ?,
                    outcome = ?,
                    resolved_at = ?
              WHERE candidate_id = ?`,
          )
          .run(result.error ?? null, result.outcome, result.outcome === 'failed' ? null : result.at, result.candidateId);
        this.#fault('cleanup:before-commit');
      });
    });
  }

  /**
   * WAL checkpoint plus a BOUNDED incremental vacuum. Maintenance only — it
   * goes through the same single-writer queue as everything else, so it can
   * never run concurrently with an ack-critical append, and `incrementalVacuumPages`
   * caps how long one pass can hold that queue.
   */
  compact(options: CompactOptions): Promise<CompactResult> {
    return this.#enqueue('compact', () => {
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
    });
  }

  #freelistPages(): number {
    const row = this.#db.prepare('PRAGMA freelist_count').get() as { freelist_count?: number } | undefined;
    return Number(row?.freelist_count ?? 0);
  }

  close(): Promise<void> {
    return this.#enqueue('close', () => {
      this.#closed = true;
      this.#db.close();
    });
  }
}
