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
 *    not at all.** One transaction covers all three (§12.7.3: "v1 bytes 与本机
 *    task record 已在同一个本机 transaction durable append").
 * 3. **A redelivered envelope is a no-op.** The wire is at-least-once and a
 *    crash between commit and ack GUARANTEES a redelivery, so idempotency is
 *    the normal path, not the exceptional one: the receipt row keyed by
 *    envelope id is looked up inside the same transaction that would write it.
 *
 * The constructor checks the format, opens the file, builds the schema and
 * quarantines what it cannot open, on the calling thread. Every operation
 * after that runs on one worker thread that owns the only writable handle
 * (`journal-worker.ts`, #2332): `node:sqlite` has no async API, and a
 * `synchronous=FULL` commit on the event loop stalls the whole Host for as
 * long as the fsync takes. Operations reach the worker in call order, so it is
 * still a single-writer FIFO. Writes that queue up while a commit runs share
 * the next commit (group commit); an operation resolves only after the commit
 * that contains it has returned.
 *
 * Times the journal records (`committedAt`, disposition and recovery times,
 * `measuredAt`) are read from the injected clock when the operation is called,
 * on the caller's thread: they are admission times. One FIFO worker commits in
 * admission order, so they stay monotonic with commit order.
 *
 * If the worker thread ends without closing the database, every operation in
 * flight or queued rejects with {@link JournalUnavailableError} and none of
 * them counts as durable; every later operation rejects the same way, and
 * `close()` reports {@link JournalHandleCleanupError}, so the daemon keeps its
 * store lease. The worker is never restarted behind the caller's back.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads';
import {
  JournalClosedError,
  JournalCorruptError,
  JournalRecordTooLargeError,
  JournalUnavailableError,
  type AdmissionRecord,
  type CompactOptions,
  type CompactResult,
  type JournalIdentity,
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
} from './journal.js';
import { byteLength, ENVELOPE_RECORD_FLOOR_BYTES } from './journal-store.js';
import {
  decodeError,
  encodeError,
  type JournalOp,
  type JournalOpArgs,
  type JournalOpenReply,
  type JournalOpResult,
  type JournalRequest,
  type JournalResponse,
  type JournalWorkerData,
  type WireError,
} from './journal-worker-protocol.js';
import { readSqliteFileUnchanged, SQLITE_USER_OBJECT, SqliteReadOnlyOpenError } from '@byok-sdk/core/sqlite-node';
import {
  isSqliteAvailable,
  JournalHandleCleanupError,
  loadSqliteModule,
  openJournalDatabase,
  secureJournalFilePermissions,
  type JournalOpenFaultSeam,
} from '../../util/sqlite-support.js';

export { JournalHandleCleanupError };

/** `journal-worker.ts` bundled into one CommonJS string; defined by tsup and vitest (`scripts/journal-worker-source.ts`). */
declare const __BYOK_JOURNAL_WORKER_SOURCE__: string;

/**
 * Bound on the worker's open handshake: thread start, evaluating the bundled
 * worker and one SQLite open, under IO load. Past it the constructor gives up
 * and reports the worker's handle as not proven closed.
 */
const WORKER_OPEN_TIMEOUT_MS = 30_000;

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
  /**
   * Throw to simulate a crash or IO error at exactly this step. Return normally
   * to proceed. Called on the journal's own thread; the worker waits for it.
   */
  onStep?(step: JournalFaultStep): void;
  /** End the journal worker thread at this step, as a crash or an out-of-memory kill would. */
  exitWorkerAt?: JournalFaultStep;
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
  /** Injected clock, read when an operation is called (its admission time) and for quarantine stamps, so they are deterministic under test. Defaults to the real one. */
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
 * Artifact producers and policy live in daemon/retention.
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
  acked_at      TEXT,
  -- #826: the length of a withheld offer's bytes; NULL for a stored envelope.
  withheld_bytes INTEGER
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

CREATE INDEX IF NOT EXISTS journal_terminal_retention ON journal_terminal (truth_state, updated_at);
`;

/**
 * The tables and columns of a current journal, read from {@link SCHEMA} itself
 * so the format check and the schema cannot drift apart.
 */
let currentJournalTables: ReadonlyMap<string, string> | undefined;

/** `table -> sorted column names` for every user table in `db`. */
function journalTables(db: DatabaseSync): Map<string, string> {
  const tables = new Map<string, string>();
  const rows = db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND ${SQLITE_USER_OBJECT}`).all() as Array<{ name: string }>;
  for (const { name } of rows) {
    const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(name) as Array<{ name: string }>;
    tables.set(name, columns.map((column) => column.name).sort().join(','));
  }
  return tables;
}

function expectedJournalTables(): ReadonlyMap<string, string> {
  if (currentJournalTables) return currentJournalTables;
  const { DatabaseSync } = loadSqliteModule();
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(SCHEMA);
    currentJournalTables = journalTables(db);
  } finally {
    db.close();
  }
  return currentJournalTables;
}

const PRESERVE = 'preserve/export this journal and resolve it before starting this build';

/**
 * The journal's one format authority, run on the main file before anything
 * opens it for writing (through `readSqliteFileUnchanged`) and again on the
 * writable connection, where a not-yet-checkpointed WAL is visible. There is no
 * version row: a current journal is one whose tables and columns are exactly
 * {@link SCHEMA}'s, and a file with no schema objects is new. Anything else is
 * refused with {@link JournalUnavailableError} and left as it is.
 */
function assertCurrentJournalFormat(db: DatabaseSync): 'empty' | 'current' {
  const objects = db.prepare(`SELECT count(*) AS n FROM sqlite_schema WHERE ${SQLITE_USER_OBJECT}`).get() as { n: number };
  if (Number(objects.n) === 0) return 'empty';
  const tables = journalTables(db);
  const terminal = tables.get('journal_terminal');
  // A hash-only predecessor cannot be silently upgraded into replay evidence:
  // never synthesize missing terminal bytes.
  if (terminal !== undefined && !terminal.split(',').includes('bytes')) {
    throw new JournalUnavailableError(`hash-only journal format cannot replay terminals; ${PRESERVE} with the new execution-recovery format`);
  }
  const envelope = tables.get('journal_envelope');
  if (envelope !== undefined && !envelope.split(',').includes('withheld_bytes')) {
    throw new JournalUnavailableError(`journal written before the withheld-offer column (#826); ${PRESERVE}`);
  }
  const expected = expectedJournalTables();
  const differs = [...new Set([...expected.keys(), ...tables.keys()])].filter((name) => expected.get(name) !== tables.get(name));
  if (differs.length > 0) {
    throw new JournalUnavailableError(`journal tables ${differs.sort().join(', ')} do not match this build's journal format; ${PRESERVE}`);
  }
  return 'current';
}

/** Task-keyed envelope lookups (stored cancellation, prune) read through this instead of scanning the table. */
const ENVELOPE_TASK_INDEX = 'CREATE INDEX IF NOT EXISTS journal_envelope_task ON journal_envelope (task_id, seq)';


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

interface StartedWorker {
  readonly worker: Worker;
  readonly port: MessagePort;
}

/**
 * Starts the worker and waits, synchronously, for it to open its own
 * connection. This thread's handle `db` is still open meanwhile, so the WAL
 * and its permissions survive the handoff; it is closed only once the worker
 * holds the database. On any failure both handles are accounted for: a
 * handle that cannot be proven closed is a {@link JournalHandleCleanupError}.
 */
function startJournalWorker(
  db: DatabaseSync,
  settings: Pick<JournalWorkerData, 'dbPath' | 'quarantineDir' | 'busyTimeoutMs' | 'maxRecordBytes' | 'faults'>,
  faults: JournalFaultSeam | undefined,
): StartedWorker {
  const channel = new MessageChannel();
  const faultChannel = faults === undefined ? undefined : new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(8));
  let worker: Worker | undefined;
  let reply: JournalOpenReply | undefined;
  let startError: unknown;
  try {
    const workerData: JournalWorkerData = {
      ...settings, signal, port: channel.port2, ...(faultChannel === undefined ? {} : { faultPort: faultChannel.port2 }),
    };
    worker = new Worker(__BYOK_JOURNAL_WORKER_SOURCE__, {
      eval: true,
      workerData,
      transferList: faultChannel === undefined ? [channel.port2] : [channel.port2, faultChannel.port2],
    });
    // A worker that fails after a failed handshake is already accounted for below.
    worker.on('error', () => {});
    if (Atomics.wait(signal, 0, 0, WORKER_OPEN_TIMEOUT_MS) !== 'timed-out') {
      reply = receiveMessageOnPort(channel.port1)?.message as JournalOpenReply | undefined;
    }
  } catch (error) {
    startError = error;
  }
  if (reply?.ok === true && worker !== undefined) {
    try {
      db.close();
    } catch (closeError) {
      void worker.terminate();
      throw new JournalHandleCleanupError('the journal worker opened the database, but this thread could not close its own SQLite handle', [closeError]);
    }
    if (faultChannel !== undefined && faults !== undefined) answerFaults(faultChannel.port1, signal, faults);
    return { worker, port: channel.port1 };
  }
  void worker?.terminate();
  const cause = reply?.ok === false
    ? decodeError(reply.error)
    : startError ?? new Error(`the journal worker did not open the database within ${WORKER_OPEN_TIMEOUT_MS} ms`);
  // No worker means no second handle; a worker that never answered may hold one.
  const workerHandleClosed = worker === undefined || (reply?.ok === false && reply.closed);
  let closeError: unknown;
  try {
    db.close();
  } catch (error) {
    closeError = error;
  }
  if (!workerHandleClosed || closeError !== undefined) {
    throw new JournalHandleCleanupError(
      'the journal worker could not open the database, and its SQLite handles could not be proven closed',
      closeError === undefined ? [cause] : [cause, closeError],
    );
  }
  throw new JournalUnavailableError(`the journal worker could not open ${settings.dbPath}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
}

/** Runs the test fault seam for the worker, which waits on `signal[1]` for the verdict. */
function answerFaults(port: MessagePort, signal: Int32Array, seam: JournalFaultSeam): void {
  port.on('message', (step: JournalFaultStep) => {
    let verdict: WireError | null = null;
    try {
      seam.onStep?.(step);
    } catch (error) {
      verdict = encodeError(error);
    }
    port.postMessage(verdict);
    Atomics.store(signal, 1, 1);
    Atomics.notify(signal, 1);
  });
  port.unref();
}

export class SqliteLocalTaskJournal implements LocalTaskJournal {
  readonly #maxRecordBytes: number;
  readonly #clock: () => Date;
  readonly #worker: Worker;
  readonly #port: MessagePort;
  /** Operations sent to the worker and not yet answered, by request id. */
  readonly #requests = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  #nextId = 1;
  /** Set by `close()`: every later operation rejects with {@link JournalClosedError}. */
  #closed = false;
  /**
   * The one in-flight or settled `close()`, so closing twice is a no-op that
   * resolves rather than a `JournalClosedError`. `close` is the one operation
   * whose postcondition is already satisfied on an already-closed journal, and
   * the daemon's shutdown sequence is documented idempotent — every other step
   * in it tolerates a second call, so this one has to as well.
   */
  #closing: Promise<void> | undefined;
  /** Set when the worker ended without closing the database; every later operation rejects with it. */
  #failure: JournalUnavailableError | undefined;
  #workerError: unknown;
  readonly #exited: Promise<void>;

  constructor(options: SqliteLocalTaskJournalOptions) {
    // Checked BEFORE anything touches the filesystem: §12.7.2's
    // no-silent-downgrade rule is about refusing to start, and a refusal that
    // has already created directories is a worse refusal.
    if (!isSqliteAvailable()) {
      throw new JournalUnavailableError(`node:sqlite could not be loaded on Node ${process.versions.node}`);
    }

    const dbPath = join(options.storeDir, JOURNAL_DB_FILENAME);
    this.#maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    this.#clock = options.clock ?? (() => new Date());

    mkdirSync(options.storeDir, { recursive: true, mode: 0o700 });

    // The format is decided on the unchanged main file before the writable open
    // and its pragmas. A format refusal, or a file the read-only check cannot
    // open, is not corruption: the file
    // stays where it is. A main file SQLite cannot read is left to the writable
    // open below, which also sees the WAL and quarantines only what it cannot open.
    try {
      readSqliteFileUnchanged(dbPath, assertCurrentJournalFormat);
    } catch (err) {
      if (err instanceof JournalUnavailableError) throw err;
      if (err instanceof SqliteReadOnlyOpenError) {
        throw new JournalUnavailableError(`the journal at ${dbPath} could not be opened read-only to check its format; it was left unchanged`, { cause: err });
      }
    }
    // Open + schema are one unit for quarantine purposes: a file whose header
    // reads fine but whose schema cannot be created is just as unusable, and
    // just as much evidence, as one that fails at open.
    let db: DatabaseSync | undefined;
    let created = false;
    try {
      db = openJournalDatabase(
        dbPath,
        options.busyTimeoutMs ?? DEFAULT_JOURNAL_BUSY_TIMEOUT_MS,
        options.openFaults,
      );
      // The main file may hold no schema yet while a WAL does: the writable
      // connection sees both and makes the final decision.
      created = assertCurrentJournalFormat(db) === 'empty';
      // One transaction, so a new journal pays one synchronous=FULL commit
      // instead of one per statement, and a failure leaves no partial schema.
      // It begins only after both format checks (#2295).
      db.exec(`BEGIN IMMEDIATE;\n${SCHEMA}\nCOMMIT;`);
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
      if (err instanceof JournalUnavailableError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      const quarantinePath = quarantineDatabase(options.storeDir, dbPath, reason, this.#clock());
      throw new JournalCorruptError(dbPath, quarantinePath, reason, { cause: err });
    }
    // A deployed store gains the index on its first open; a failure is a
    // refusal to start, not corruption, so the file stays in place.
    try {
      db.exec(ENVELOPE_TASK_INDEX);
      // After the schema transaction and the index commit: a new journal's
      // schema reaches the main file at once and the WAL is left empty, so
      // the window in which only the WAL describes the format stays short.
      if (created) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err) {
      db.close();
      throw new JournalUnavailableError(`journal task index could not be built: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    try {
      secureJournalFilePermissions(dbPath);
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
    const { worker, port } = startJournalWorker(db, {
      dbPath,
      quarantineDir: join(options.storeDir, JOURNAL_QUARANTINE_DIRNAME),
      busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_JOURNAL_BUSY_TIMEOUT_MS,
      maxRecordBytes: this.#maxRecordBytes,
      ...(options.faults === undefined ? {} : { faults: options.faults.exitWorkerAt === undefined ? {} : { exitWorkerAt: options.faults.exitWorkerAt } }),
    }, options.faults);
    this.#worker = worker;
    this.#port = port;
    let exited!: () => void;
    this.#exited = new Promise((resolve) => { exited = resolve; });
    port.on('message', (response: JournalResponse) => this.#settle(response));
    worker.on('error', (error) => { this.#workerError ??= error; });
    worker.on('exit', (code) => {
      this.#onExit(code);
      exited();
    });
    this.#idle();
  }

  // ---------------------------------------------------------------------
  // The worker channel
  // ---------------------------------------------------------------------

  #call<K extends JournalOp>(op: K, ...args: JournalOpArgs<K>): Promise<JournalOpResult<K>> {
    if (this.#closed) return Promise.reject(new JournalClosedError(op));
    return this.#send({ id: this.#nextId++, op, args }) as Promise<JournalOpResult<K>>;
  }

  #send(request: JournalRequest): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      this.#requests.set(request.id, { resolve, reject });
      if (this.#requests.size === 1) this.#busy();
      try {
        this.#port.postMessage(request);
      } catch (error) {
        this.#requests.delete(request.id);
        if (this.#requests.size === 0) this.#idle();
        reject(error);
      }
    });
  }

  #settle(response: JournalResponse): void {
    const request = this.#requests.get(response.id);
    if (request === undefined) return;
    this.#requests.delete(response.id);
    if (this.#requests.size === 0) this.#idle();
    if (response.ok) request.resolve(response.value);
    else request.reject(decodeError(response.error));
  }

  /** An idle journal does not keep the process alive, as a plain SQLite handle never did; an answer still owed does. */
  #idle(): void {
    if (this.#closing !== undefined) return;
    this.#worker.unref();
    this.#port.unref();
  }

  #busy(): void {
    this.#worker.ref();
    this.#port.ref();
  }

  #onExit(code: number): void {
    // Answers the worker sent before it ended still count.
    for (let queued = receiveMessageOnPort(this.#port); queued !== undefined; queued = receiveMessageOnPort(this.#port)) {
      this.#settle(queued.message as JournalResponse);
    }
    if (this.#requests.size === 0 && this.#closed) return;
    const failure = new JournalUnavailableError(
      `the journal worker thread exited (code ${code}) without closing the database; no operation still in flight counts as durable`,
      { cause: this.#workerError },
    );
    if (!this.#closed) this.#failure = failure;
    const owed = [...this.#requests.values()];
    this.#requests.clear();
    for (const request of owed) request.reject(failure);
  }

  // ---------------------------------------------------------------------
  // LocalTaskJournal
  // ---------------------------------------------------------------------

  /**
   * The ack-critical path. Envelope bytes, the task record it opens, and the
   * idempotency receipt land in one transaction, or none of them do; a
   * redelivery is answered from the stored receipt (see `journal-store.ts`).
   */
  appendEnvelope(record: ReceivedEnvelopeRecord): Promise<JournalReceipt> {
    // A string cannot change after the check; a Buffer from untyped callers could.
    if (typeof record.bytes !== 'string') {
      return Promise.reject(new TypeError('ReceivedEnvelopeRecord.bytes must be a string'));
    }
    // The write runs after the queue drains, so it and the checks below read
    // one copy the caller cannot change in between.
    const entry: ReceivedEnvelopeRecord = Object.freeze({ ...record, identity: Object.freeze({ ...record.identity }) });
    const bytes = byteLength(entry.bytes);
    const bound = Math.max(this.#maxRecordBytes, ENVELOPE_RECORD_FLOOR_BYTES);
    if (bytes > bound) {
      return Promise.reject(new JournalRecordTooLargeError('bytes', bytes, bound));
    }
    if (entry.opensTask && entry.taskId === undefined) {
      return Promise.reject(
        new Error('ReceivedEnvelopeRecord.opensTask is true but no taskId was supplied — refusing to append a task-opening envelope with no task identity'),
      );
    }
    // Rows are read back by task id, so the row must name the task its bytes
    // bind (#2054): a Host appending directly can otherwise file one task's
    // envelope under another.
    let boundTaskId: unknown;
    try {
      boundTaskId = (JSON.parse(entry.bytes) as { task_id?: unknown }).task_id;
    } catch {
      return Promise.reject(new TypeError('ReceivedEnvelopeRecord.bytes is not a JSON envelope'));
    }
    if (boundTaskId !== entry.taskId) {
      return Promise.reject(new TypeError('ReceivedEnvelopeRecord.taskId does not match the task_id in its bytes'));
    }
    return this.#call('appendEnvelope', entry, this.#clock().toISOString());
  }

  /** #826: the decline commits with the row, because the cursor moves once this commits. */
  appendWithheldOffer(record: WithheldOfferRecord): Promise<JournalReceipt> {
    return this.#call('appendWithheldOffer', record, this.#clock().toISOString());
  }

  recordAdmission(record: AdmissionRecord): Promise<void> {
    return this.#call('recordAdmission', record);
  }

  recordTransition(record: LocalTransitionRecord): Promise<void> {
    if (record.detail !== undefined && byteLength(record.detail) > MAX_TRANSITION_DETAIL_BYTES) {
      return Promise.reject(
        new JournalRecordTooLargeError('detail', byteLength(record.detail), MAX_TRANSITION_DETAIL_BYTES),
      );
    }
    return this.#call('recordTransition', record);
  }

  recordTerminal(record: LocalTerminalRecord): Promise<void> {
    return this.#call('recordTerminal', record);
  }

  readTask(taskId: string, identity: JournalIdentity): Promise<RecoverableTask | WithheldOfferTask | undefined> {
    return this.#call('readTask', taskId, identity);
  }

  readTaskCancellation(taskId: string, identity: JournalIdentity, afterSeq: number) {
    return this.#call('readTaskCancellation', taskId, identity, afterSeq);
  }

  listRecoveryTasks(identity: JournalIdentity): Promise<RecoverableTask[]> {
    return this.#call('listRecoveryTasks', identity);
  }

  listPendingTerminals(identity: JournalIdentity): Promise<LocalTerminalRecord[]> {
    return this.#call('listPendingTerminals', identity);
  }

  confirmTerminal(taskId: string, payloadHash: string): Promise<void> {
    return this.#call('terminalDisposition', taskId, payloadHash, 'confirmed', undefined, this.#clock().toISOString());
  }

  rejectTerminal(taskId: string, payloadHash: string, reason: string): Promise<void> {
    return this.#call('terminalDisposition', taskId, payloadHash, 'failed', reason, this.#clock().toISOString());
  }

  replaceRefusedTerminal(taskId: string, refusedPayloadHash: string, record: LocalTerminalRecord): Promise<void> {
    return this.#call('replaceRefusedTerminal', taskId, refusedPayloadHash, record);
  }

  listRecoverable(): Promise<RecoverableTask[]> {
    return this.#call('listRecoverable');
  }

  markRecovered(taskId: string, outcome: RecoveryOutcome): Promise<void> {
    return this.#call('markRecovered', taskId, outcome, this.#clock().toISOString());
  }

  /** Physical journal/quarantine footprint and confirmed-row inventory. */
  measureUsage(): Promise<LocalStorageUsage> {
    return this.#call('measureUsage', this.#clock().toISOString());
  }

  listPrunableConfirmedTasks(cutoff: Date, limit: number, after?: string): Promise<string[]> {
    if (!Number.isFinite(cutoff.getTime()) || !Number.isSafeInteger(limit) || limit <= 0) return Promise.reject(new TypeError('invalid journal retention bounds'));
    return this.#call('listPrunableConfirmedTasks', cutoff.toISOString(), limit, after);
  }

  pruneConfirmedJournalTask(taskId: string, cutoff: Date): Promise<boolean> {
    if (!Number.isFinite(cutoff.getTime())) return Promise.reject(new TypeError('invalid journal retention bounds'));
    return this.#call('pruneConfirmedJournalTask', taskId, cutoff.toISOString());
  }

  compact(options: CompactOptions): Promise<CompactResult> {
    return this.#call('compact', options);
  }

  /**
   * Runs after every operation called before it, closes the worker's handle
   * and resolves once the worker thread has ended. A worker that cannot close
   * its handle, or that ended without closing it, rejects with
   * {@link JournalHandleCleanupError}: the handle is not proven released.
   */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    // Kept alive until the thread has ended, so a caller awaiting close() is not cut off.
    this.#worker.ref();
    this.#closing = this.#send({ id: this.#nextId++, op: 'close' }).then(
      () => this.#exited,
      (error: unknown) => {
        void this.#worker.terminate();
        throw new JournalHandleCleanupError('the local task journal could not prove its SQLite handle closed', [error]);
      },
    );
    return this.#closing;
  }
}
