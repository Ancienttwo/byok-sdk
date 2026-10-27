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
import { SEALED_INLINE_MAX_PADDED_LENGTH, isSealedPayload } from '@byok-sdk/protocol';
import {
  journalHash,
  type JournalIdentity,
  JournalClosedError,
  JournalCorruptError,
  JournalRecordTooLargeError,
  JournalUnavailableError,
  JournalUnknownTaskError,
  type AdmissionRecord,
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
  type WithheldOfferRecord,
  type WithheldOfferTask,
} from './journal';
import {
  isSqliteAvailable,
  JournalHandleCleanupError,
  openJournalDatabase,
  secureJournalFilePermissions,
  type JournalOpenFaultSeam,
} from './sqlite-support';

export { JournalHandleCleanupError };

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
const ENVELOPE_RECORD_FLOOR_BYTES = Math.ceil(((SEALED_INLINE_MAX_PADDED_LENGTH + SEALED_AEAD_TAG_BYTES) * 4) / 3) + SEALED_ENVELOPE_MARGIN_BYTES;

/** Whether canonical envelope bytes carry a sealed payload (#654); read only for a record above `maxRecordBytes`. */
function isSealedEnvelope(bytes: string): boolean {
  try {
    const { type, payload } = JSON.parse(bytes) as { type?: unknown; payload?: unknown };
    return typeof type === 'string' && isSealedPayload(type, payload);
  } catch {
    return false;
  }
}

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
  | 'append:after-commit'
  | 'admission:before-commit'
  | 'transition:before-commit'
  | 'terminal:before-commit'
  | 'terminal:after-commit'
  | 'recovery:after-commit'
  | 'confirm:before-commit'
  | 'confirm:after-commit'
  | 'replace:before-commit'
  | 'replace:after-commit'
  | 'recovery:before-commit'
  | 'cleanup:before-commit'
  | 'prune:before-commit';

export interface JournalFaultSeam {
  /** Throw to simulate a crash or IO error at exactly this step. Return normally to proceed. */
  onStep?(step: JournalFaultStep): void;
}

export interface SqliteLocalTaskJournalOptions {
  /** The daemon's store directory. The database lives at `<storeDir>/daemon.db` and quarantine at `<storeDir>/quarantine/`. */
  readonly storeDir: string;
  /** Bound on waiting for the write lock. Default {@link DEFAULT_JOURNAL_BUSY_TIMEOUT_MS}. */
  readonly busyTimeoutMs?: number;
  /**
   * Per-record byte bound. Default {@link DEFAULT_MAX_RECORD_BYTES}. An inbound
   * envelope record may still reach a floor derived from the inline sealed
   * maximum (415083 bytes), so a sealed envelope can be journaled and declined.
   * A task-opening envelope above the bound is kept without its bytes and
   * declined ({@link SqliteLocalTaskJournal.appendWithheldOffer}, #826).
   */
  readonly maxRecordBytes?: number;
  /** Test seam — see {@link JournalFaultSeam}. Never supplied in production. */
  readonly faults?: JournalFaultSeam;
  /** Test seam for post-open/pre-return SQLite initialization failures. Never supplied in production. */
  readonly openFaults?: JournalOpenFaultSeam;
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
 *
 * Opening permanently drops the three unused candidate/usage/artifact tables.
 * Actual artifact producers and policy live in daemon/retention.
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
  bytes         TEXT NOT NULL,
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

DROP TABLE IF EXISTS local_artifact_ref;
DROP TABLE IF EXISTS local_cleanup_candidate;
DROP TABLE IF EXISTS local_storage_usage;
CREATE INDEX IF NOT EXISTS journal_terminal_retention ON journal_terminal (truth_state, updated_at);
`;

/** `local_state` for a task whose admission declined it — terminal for local purposes, and NOT something recovery should re-offer. */
const DECLINED_STATE = 'declined';
/** `local_state` a task starts in: its offer envelope is durable, nothing has been decided yet. */
const RECEIVED_STATE = 'received';

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
  /**
   * The one in-flight or settled `close()`, so closing twice is a no-op that
   * resolves rather than a `JournalClosedError`. `close` is the one operation
   * whose postcondition is already satisfied on an already-closed journal, and
   * the daemon's shutdown sequence is documented idempotent — every other step
   * in it tolerates a second call, so this one has to as well.
   */
  #closing: Promise<void> | undefined;

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
    let db: DatabaseSync | undefined;
    try {
      db = openJournalDatabase(
        this.#dbPath,
        options.busyTimeoutMs ?? DEFAULT_JOURNAL_BUSY_TIMEOUT_MS,
        options.openFaults,
      );
      db.exec(SCHEMA);
    } catch (err) {
      // `openJournalDatabase` owns the handle until it returns. If that helper
      // could not prove cleanup, this constructor has no handle to close and
      // must preserve the typed mutation-barrier failure for the daemon rather
      // than relabeling it as ordinary corruption and releasing the lease.
      if (err instanceof JournalHandleCleanupError) throw err;
      // An open handle is itself a store writer/lock authority. Close it before
      // quarantine and before the caller can release its cross-process lease;
      // otherwise a schema failure could leave an unreachable live SQLite
      // handle behind while a second daemon is admitted.
      try {
        db?.close();
      } catch (closeError) {
        throw new JournalHandleCleanupError(
          'local task journal initialization failed and its SQLite handle could not be closed',
          [err, closeError],
        );
      }
      const reason = err instanceof Error ? err.message : String(err);
      const quarantinePath = quarantineDatabase(options.storeDir, this.#dbPath, reason, this.#clock());
      throw new JournalCorruptError(this.#dbPath, quarantinePath, reason, { cause: err });
    }
    // A hash-only predecessor cannot be silently upgraded into replay evidence.
    // Preserve its files and require an explicit operator resolution; never quarantine
    // a structurally valid old format or synthesize missing terminal bytes.
    const terminalColumns = db.prepare('PRAGMA table_info(journal_terminal)').all() as Array<{ name: string }>;
    if (!terminalColumns.some((column) => column.name === 'bytes')) {
      db.close();
      throw new JournalUnavailableError('hash-only journal format cannot replay terminals; preserve/export this journal and resolve it before starting the new execution-recovery format');
    }
    // #826: the length of a withheld offer's bytes; NULL for a stored
    // envelope. The one declaration of the column, so a journal written before
    // it existed and a new one take the same path. A failed ALTER leaves a
    // valid older journal, so it is not quarantined.
    const envelopeColumns = db.prepare('PRAGMA table_info(journal_envelope)').all() as Array<{ name: string }>;
    if (!envelopeColumns.some((column) => column.name === 'withheld_bytes')) {
      try {
        db.exec('ALTER TABLE journal_envelope ADD COLUMN withheld_bytes INTEGER');
      } catch (err) {
        db.close();
        throw err;
      }
    }
    this.#db = db;
    try {
      secureJournalFilePermissions(this.#dbPath);
    } catch (err) {
      // Permission hardening failure is not database corruption and must not
      // move evidence. It is still a construction failure, with the handle
      // synchronously closed before ownership can unwind.
      try {
        db.close();
      } catch (closeError) {
        throw new JournalHandleCleanupError(
          'local task journal permission hardening failed and its SQLite handle could not be closed',
          [err, closeError],
        );
      }
      throw err;
    }
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
    const bound = Math.max(this.#maxRecordBytes, ENVELOPE_RECORD_FLOOR_BYTES);
    if (bytes > bound) {
      return Promise.reject(new JournalRecordTooLargeError('bytes', bytes, bound));
    }
    if (record.opensTask && record.taskId === undefined) {
      return Promise.reject(
        new Error('ReceivedEnvelopeRecord.opensTask is true but no taskId was supplied — refusing to append a task-opening envelope with no task identity'),
      );
    }

    return this.#append('appendEnvelope', record, record.bytes, null, (committedAt) => {
      if (!record.opensTask || record.taskId === undefined) return;
      const task = this.#db.prepare('SELECT * FROM journal_task WHERE task_id = ?').get(record.taskId) as Record<string, unknown> | undefined;
      if (task) {
        this.#assertIdentity(task, record.identity);
        const original = this.#db.prepare('SELECT bytes, withheld_bytes FROM journal_envelope WHERE envelope_id = ?')
          .get(task.envelope_id as string) as { bytes: string; withheld_bytes: number | null };
        // Transport IDs/seq can change on duplicate delivery, but the execution
        // contract (including exact AgentRef) must never change under task_id.
        // A withheld offer has no contract to compare: its task is declined.
        if (original.withheld_bytes === null) {
          const oldOffer = JSON.parse(original.bytes) as { type?: unknown; payload?: unknown };
          const newOffer = JSON.parse(record.bytes) as { type?: unknown; payload?: unknown };
          if (oldOffer.type !== newOffer.type || JSON.stringify(oldOffer.payload) !== JSON.stringify(newOffer.payload)) {
            throw new Error('journal task identity reused with a different execution contract');
          }
        }
      }
      // `OR IGNORE`: a second, different envelope re-opening the same task
      // id (a re-offer after the cloud lost track) must not clobber the
      // admission/claim state the first one already accumulated. The
      // envelope row above still records that the second envelope arrived.
      this.#insertTask(record, record.taskId, RECEIVED_STATE, committedAt);
    });
  }

  /** #826: the decline commits with the row, because the cursor moves once this commits. */
  appendWithheldOffer(record: WithheldOfferRecord): Promise<JournalReceipt> {
    const { decline, taskId } = record;
    return this.#append('appendWithheldOffer', record, '', record.byteLength, (committedAt) => {
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

  /** One transaction: envelope row, task step and receipt; a redelivery is answered from its receipt. */
  #append(
    operation: string,
    record: Omit<ReceivedEnvelopeRecord, 'bytes' | 'opensTask'>,
    bytes: string,
    withheldBytes: number | null,
    openTask: (committedAt: string) => void,
  ): Promise<JournalReceipt> {
    return this.#enqueue(operation, () => {
      this.#fault('append:before-begin');
      const committed = this.#transaction((): JournalReceipt => {
        const existing = this.#db
          .prepare('SELECT receipt FROM journal_idempotency WHERE scope = ? AND key = ?')
          .get('envelope', record.envelopeId) as { receipt: string } | undefined;
        if (existing) {
          const prior = JSON.parse(existing.receipt) as Omit<JournalReceipt, 'created'>;
          if (prior.bytesHash !== record.bytesHash) throw new Error('journal envelope identity collision');
          const priorIdentity = this.#db.prepare('SELECT tenant_id, product_id, device_id FROM journal_envelope WHERE envelope_id = ?').get(record.envelopeId) as Record<string, unknown>;
          this.#assertIdentity(priorIdentity, record.identity);
          return { ...prior, created: false };
        }

        const committedAt = this.#clock().toISOString();
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

        return { ...receipt, created: true };
      });
      this.#fault('append:after-commit');
      return committed;
    });
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
            .prepare('UPDATE journal_task SET local_state = ?, updated_at = ? WHERE task_id = ? AND NOT EXISTS (SELECT 1 FROM journal_terminal WHERE journal_terminal.task_id = journal_task.task_id)')
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
      this.#assertTerminalBytes(record.bytes, record.payloadHash);
      this.#transaction(() => {
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
      });
      if (record.recovery !== undefined) this.#fault('recovery:after-commit');
      this.#fault('terminal:after-commit');
    });
  }

  #assertTerminalBytes(bytes: string, payloadHash: string): void {
    if (typeof bytes !== 'string' || journalHash(bytes) !== payloadHash) {
      throw new Error('terminal bytes do not match their canonical hash');
    }
    const length = byteLength(bytes);
    if (length <= this.#maxRecordBytes) return;
    const bound = isSealedEnvelope(bytes) ? Math.max(this.#maxRecordBytes, ENVELOPE_RECORD_FLOOR_BYTES) : this.#maxRecordBytes;
    if (length > bound) throw new JournalRecordTooLargeError('terminal bytes', length, bound);
  }

  #insertTerminal(record: LocalTerminalRecord): void {
    this.#db.prepare(`INSERT INTO journal_terminal
      (task_id, terminal_type, bytes, payload_hash, truth_state, attempt, last_error, recorded_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.taskId, record.terminalType, record.bytes, record.payloadHash, record.truthState,
        record.attempt, record.lastError ?? null, record.recordedAt, record.recordedAt);
  }

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

  readTask(taskId: string, identity: JournalIdentity): Promise<RecoverableTask | WithheldOfferTask | undefined> {
    return this.#enqueue('readTask', () => {
      const row = this.#db.prepare(`SELECT t.*, e.bytes AS envelope_bytes, e.bytes_hash AS envelope_hash, e.withheld_bytes FROM journal_task t
        JOIN journal_envelope e ON e.envelope_id = t.envelope_id WHERE t.task_id = ?`).get(taskId) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      this.#assertIdentity(row, identity);
      return this.#taskRow(row);
    });
  }

  listRecoveryTasks(identity: JournalIdentity): Promise<RecoverableTask[]> {
    return this.#enqueue('listRecoveryTasks', () => {
      const rows = this.#db.prepare(`SELECT t.*, e.bytes AS envelope_bytes, e.bytes_hash AS envelope_hash FROM journal_task t
        JOIN journal_envelope e ON e.envelope_id = t.envelope_id
        LEFT JOIN journal_terminal term ON term.task_id = t.task_id
        WHERE term.task_id IS NULL ORDER BY t.seq, t.task_id`).all() as Record<string, unknown>[];
      return rows.map((row) => { this.#assertIdentity(row, identity); return this.#storedTaskRow(row); });
    });
  }

  listPendingTerminals(identity: JournalIdentity): Promise<LocalTerminalRecord[]> {
    return this.#enqueue('listPendingTerminals', () => {
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
    });
  }

  confirmTerminal(taskId: string, payloadHash: string): Promise<void> {
    return this.#terminalDisposition(taskId, payloadHash, 'confirmed');
  }

  rejectTerminal(taskId: string, payloadHash: string, reason: string): Promise<void> {
    return this.#terminalDisposition(taskId, payloadHash, 'failed', reason);
  }

  replaceRefusedTerminal(taskId: string, refusedPayloadHash: string, record: LocalTerminalRecord): Promise<void> {
    return this.#enqueue('replaceRefusedTerminal', () => {
      this.#assertTerminalBytes(record.bytes, record.payloadHash);
      this.#transaction(() => {
        const row = this.#db.prepare('SELECT payload_hash, truth_state, terminal_type, last_error FROM journal_terminal WHERE task_id = ?')
          .get(taskId) as { payload_hash: string; truth_state: string; terminal_type: string; last_error: string | null } | undefined;
        if (row?.payload_hash === record.payloadHash) return;
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
      });
      this.#fault('replace:after-commit');
    });
  }

  #terminalDisposition(taskId: string, payloadHash: string, state: 'confirmed' | 'failed', reason?: string): Promise<void> {
    return this.#enqueue('terminalDisposition', () => {
      this.#transaction(() => {
        const row = this.#db.prepare('SELECT payload_hash FROM journal_terminal WHERE task_id = ?').get(taskId) as { payload_hash: string } | undefined;
        if (!row || row.payload_hash !== payloadHash) {
          // A late disposition of bytes that a replacement took over changes nothing.
          if (this.#db.prepare('SELECT 1 FROM journal_transition WHERE transition_id = ?').get(`terminal-replaced:${taskId}:${payloadHash}`)) return;
          throw new Error('terminal acknowledgement does not match durable terminal');
        }
        this.#db.prepare(`UPDATE journal_terminal SET truth_state = ?, last_error = ?, updated_at = ?
          WHERE task_id = ? AND truth_state <> 'confirmed'`).run(state, reason ?? null, this.#clock().toISOString(), taskId);
        this.#fault('confirm:before-commit');
      });
      this.#fault('confirm:after-commit');
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

  /** Physical journal/quarantine footprint and confirmed-row inventory. */
  measureUsage(): Promise<LocalStorageUsage> {
    return this.#enqueue('measureUsage', () => {
      const rows = this.#db.prepare(`SELECT COUNT(*) AS entries FROM journal_envelope`).get() as { entries: number };
      const confirmed = this.#db.prepare(`SELECT COUNT(*) AS entries, MIN(term.updated_at) AS oldest
        FROM journal_terminal term JOIN journal_task task ON task.task_id = term.task_id
        WHERE term.truth_state = 'confirmed' AND task.recovery_marker IS NULL`).get() as { entries: number; oldest: string | null };
      return {
        measuredAt: this.#clock().toISOString(),
        journalBytes: fileBytes(this.#dbPath) + fileBytes(`${this.#dbPath}-wal`) + fileBytes(`${this.#dbPath}-shm`),
        quarantineBytes: directoryBytes(join(this.#storeDir, JOURNAL_QUARANTINE_DIRNAME)),
        journalEntries: Number(rows.entries), confirmedEntries: Number(confirmed.entries),
        ...(confirmed.oldest === null ? {} : { oldestConfirmedAt: confirmed.oldest }),
      };
    });
  }

  listPrunableConfirmedTasks(cutoff: Date, limit: number): Promise<string[]> {
    if (!Number.isFinite(cutoff.getTime()) || !Number.isSafeInteger(limit) || limit <= 0) return Promise.reject(new TypeError('invalid journal retention bounds'));
    return this.#enqueue('listPrunableConfirmedTasks', () => {
      const rows = this.#db.prepare(`SELECT task.task_id FROM journal_task task
        JOIN journal_terminal term ON term.task_id = task.task_id
        WHERE term.truth_state = 'confirmed' AND task.recovery_marker IS NULL AND term.updated_at < ?
        ORDER BY term.updated_at, task.task_id LIMIT ?`).all(cutoff.toISOString(), limit) as { task_id: string }[];
      return rows.map(row => row.task_id);
    });
  }

  pruneConfirmedJournalTask(taskId: string): Promise<boolean> {
    return this.#enqueue('pruneConfirmedJournalTask', () =>
      this.#transaction(() => {
        const eligible = this.#db
          .prepare(
            `SELECT t.task_id
               FROM journal_task t
               JOIN journal_terminal term ON term.task_id = t.task_id
              WHERE t.task_id = ?
                AND t.recovery_marker IS NULL
                AND term.truth_state = 'confirmed'`,
          )
          .get(taskId);
        if (!eligible) return false;

        // Child-first, so `foreign_keys=ON` is satisfied at every statement
        // rather than deferred to the commit — a deletion order the database
        // itself rejects is a deletion order that was never reviewed.
        this.#db.prepare('DELETE FROM journal_transition WHERE task_id = ?').run(taskId);
        this.#db.prepare('DELETE FROM journal_terminal WHERE task_id = ?').run(taskId);
        this.#db.prepare('DELETE FROM journal_task WHERE task_id = ?').run(taskId);
        this.#db.prepare('DELETE FROM journal_idempotency WHERE task_id = ?').run(taskId);
        this.#db.prepare('DELETE FROM journal_envelope WHERE task_id = ?').run(taskId);
        this.#fault('prune:before-commit');
        return true;
      }),
    );
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
    // Deliberately NOT via `#enqueue`: that path rejects with
    // `JournalClosedError` once `#closed` is set, which is right for every
    // operation that still needs an open database and wrong for the one that
    // wanted it closed. Still chained onto `#tail` the same way, so an
    // operation queued before this one still runs against an open handle.
    if (this.#closing) return this.#closing;
    const run = this.#tail.then(() => {
      this.#closed = true;
      this.#db.close();
    });
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#closing = run;
    return run;
  }
}
