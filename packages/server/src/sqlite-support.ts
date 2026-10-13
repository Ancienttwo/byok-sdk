import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync, DatabaseSyncOptions } from 'node:sqlite';

export type SqliteOpenStep = 'after-open' | 'after-wal';

/** Test-only seam for proving that post-open initialization failures release the native handle. */
export interface SqliteOpenFaultSeam {
  onStep?(step: SqliteOpenStep): void;
  close?(db: DatabaseSync): void;
}

/**
 * Preserve the initialization error after deterministically releasing an
 * already-open SQLite handle. If cleanup itself fails, surface both failures
 * instead of losing the reason construction failed or pretending ownership
 * was returned.
 */
export function closeSqliteDatabaseAfterInitializationFailure(
  db: DatabaseSync,
  initializationError: unknown,
  message: string,
  close: (db: DatabaseSync) => void = (database) => database.close(),
): never {
  try {
    close(db);
  } catch (closeError) {
    throw new AggregateError([initializationError, closeError], message);
  }
  throw initializationError;
}

/**
 * Thrown when `node:sqlite` isn't available in the running Node.js binary.
 * `node:sqlite` shipped in Node.js 22.5.0 (https://nodejs.org/api/sqlite.html)
 * and remains marked experimental there (an `ExperimentalWarning` on stderr
 * is expected and harmless — not an error). The SQLite-backed embedded store
 * composition deliberately
 * depend on nothing else — no `better-sqlite3` or other native module —
 * because staying at zero native dependencies is required to keep
 * `@byok-sdk/server` trivially packageable across platforms. The tradeoff is
 * that this composition simply doesn't work below Node 22.5; this error says so
 * clearly and up front, instead of letting a cryptic `Cannot find module
 * 'node:sqlite'` surface from deep inside a query.
 */
export class SqliteUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      'node:sqlite is unavailable in this Node.js runtime. The SQLite-backed reference ' +
        'store composition requires Node.js 22.5+ with the built-in ' +
        '`node:sqlite` module (no native dependency is used or allowed here). Upgrade Node.js, ' +
        'or select the default in-memory server storage instead.',
    );
    this.name = 'SqliteUnavailableError';
    this.cause = cause;
  }
}

/**
 * Why a SQLite file was refused at open, so a host can tell the user what to do
 * without parsing the message:
 * - `SQLITE_SCHEMA_UNSUPPORTED`: the stored version is not this build's and no
 *   matching `migration` selector was given (an older file needs one; a newer
 *   file needs a newer build).
 * - `SQLITE_MIGRATION_REFUSED`: the selected migration would lose durable
 *   authority; preserve the file for reconciliation.
 * - `SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED`: pending mailbox rows do not use
 *   the current wire major. Drain with the previous SDK before upgrading.
 * - `SQLITE_SCHEMA_INVALID`: the file contradicts its declared BYOK schema or
 *   is not a BYOK database.
 */
export type SqliteSchemaErrorCode = 'SQLITE_SCHEMA_UNSUPPORTED' | 'SQLITE_MIGRATION_REFUSED' | 'SQLITE_SCHEMA_INVALID' | 'SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED';

export class SqliteSchemaError extends Error {
  readonly code: SqliteSchemaErrorCode;
  /** The stored `schema_version`; `undefined` when the file has none. */
  readonly foundVersion: string | undefined;
  /** The schema version this build writes. */
  readonly requiredVersion: string;

  constructor(
    code: SqliteSchemaErrorCode,
    message: string,
    foundVersion: string | undefined,
    requiredVersion: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SqliteSchemaError';
    this.code = code;
    this.foundVersion = foundVersion;
    this.requiredVersion = requiredVersion;
  }
}

/**
 * Thrown when a SQLite database file is already owned by another open server —
 * in another process, or another instance in this one. One file has exactly one
 * owning process: token signing keys, presence, the task-event relay and
 * dispatch bookkeeping are process-local, so a second process on the same file
 * would split them. Run several instances only over external stores with a
 * shared `tokenSigner`.
 *
 * Ownership is an OS advisory lock on the `<path>-lock` sibling, held for the
 * lifetime of the open server. The kernel releases it when the owner closes or
 * its process exits for any reason, including SIGKILL, so a stale owner never
 * blocks the next open and no pid is ever compared (pid reuse cannot matter).
 */
export class SqliteOwnershipError extends Error {
  readonly code = 'SQLITE_DATABASE_OWNED';
  /** The database path whose ownership was refused. */
  readonly path: string;

  constructor(path: string, options?: ErrorOptions) {
    super(
      `SQLite database ${path} is already owned by another open BYOK server (this or another process). ` +
        'Close that server first; one SQLite file serves exactly one server process.',
      options,
    );
    this.name = 'SqliteOwnershipError';
    this.path = path;
  }
}

/** `node:sqlite`'s minimum Node.js version (https://nodejs.org/api/sqlite.html). */
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 5;

/**
 * Whether `nodeVersion` (a `major.minor.patch` string shaped like
 * `process.versions.node`) is new enough to have `node:sqlite` at all.
 * Exported only for this package's own tests to exercise the guard
 * deterministically (this dev/CI machine is already on a qualifying Node,
 * so the real "unavailable" path can't be triggered end-to-end here) — not
 * re-exported from `index.ts`, so not part of the public package API.
 * Unparsable input returns `true` (don't false-negative on a version string
 * shape this hasn't seen before): `loadSqliteModule`'s own `require` call is
 * the real, authoritative gate; this check only exists to turn the common
 * case (a too-old Node) into a clear message instead of a cryptic one.
 *
 * Not a sufficient capability check on its own: `node:sqlite` shipped in
 * Node 22.5.0 behind the `--experimental-sqlite` flag and only became usable
 * unflagged in a later 22.x release (https://nodejs.org/api/sqlite.html), so
 * a runtime that satisfies this version check can still fail to actually
 * load the module. Use {@link isSqliteAvailable} when the question is "can I
 * use `node:sqlite` right now", not "is the Node version new enough for it
 * to exist at all".
 */
export function isSqliteCapableNodeVersion(nodeVersion: string): boolean {
  const [majorStr, minorStr] = nodeVersion.split('.');
  const major = Number(majorStr);
  const minor = Number(minorStr);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return true;
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
}

let sqliteModule: typeof import('node:sqlite') | undefined;

/**
 * Synchronously load `node:sqlite` via `createRequire` rather than a dynamic
 * `import()`. Every reference store in this package (`InMemoryTaskStore`,
 * `LocalDiskBlobStore`) constructs synchronously via `new`, and
 * `node:sqlite`'s own API (`DatabaseSync`) is itself fully synchronous — an
 * async factory here would be the odd one out and would leak into every
 * caller (`createByokServer`, the example, tests). `node:sqlite` is a
 * built-in, so `require('node:sqlite')` resolves it even from this
 * `"type": "module"` package. Throws {@link SqliteUnavailableError} (not a
 * raw `MODULE_NOT_FOUND`/version-mismatch trace) when it can't be loaded —
 * checking the Node version first (see {@link isSqliteCapableNodeVersion})
 * gives the common "Node too old" case a specific, actionable message
 * before even attempting the `require`.
 */
function loadSqliteModule(): typeof import('node:sqlite') {
  if (sqliteModule) return sqliteModule;
  if (!isSqliteCapableNodeVersion(process.versions.node)) {
    throw new SqliteUnavailableError(
      new Error(
        `node:sqlite requires Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+; detected ${process.versions.node}`,
      ),
    );
  }
  try {
    const require = createRequire(import.meta.url);
    sqliteModule = require('node:sqlite') as typeof import('node:sqlite');
    return sqliteModule;
  } catch (err) {
    throw new SqliteUnavailableError(err);
  }
}

/**
 * Whether `node:sqlite` can ACTUALLY be loaded right now — the authoritative
 * capability check, in contrast to {@link isSqliteCapableNodeVersion}'s
 * version-string heuristic. This is what this package's own test suite uses
 * to decide whether to skip the SQLite-backed reference-store tests (rather
 * than fail them), and what anything else should call before assuming a
 * `SqliteTaskStore`/`SqliteBlobStore` can be constructed: it attempts the
 * real `require('node:sqlite')` (via {@link loadSqliteModule}, memoized) and
 * reports whether that succeeded, so it agrees with reality regardless of
 * whether the current runtime is old, too-new-but-flagged, or fully capable.
 */
export function isSqliteAvailable(): boolean {
  try {
    loadSqliteModule();
    return true;
  } catch {
    return false;
  }
}

/** Busy-timeout (ms) shared by both SQLite stores: long enough that two same-process `DatabaseSync` connections opened against the same file back-to-back (e.g. a test proving restart-safety by opening a "second instance" against the same path) don't spuriously throw `SQLITE_BUSY` under momentary write-lock contention. */
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** POSIX mode both SQLite reference-store db files (and their WAL/SHM siblings) are secured to — owner read/write only, no group/other access. Matches the convention the client-side device credential store already uses (`packages/client/src/daemon/store.ts`). */
const SECURE_FILE_MODE = 0o600;
/** POSIX mode applied to a freshly-created directory holding a SQLite reference-store db file — owner read/write/execute only. Same rationale as {@link SECURE_FILE_MODE}. */
const SECURE_DIR_MODE = 0o700;

/**
 * Open (or create) a `node:sqlite` `DatabaseSync` at `path`, applying the
 * pragmas both reference SQLite stores share: WAL journaling for a
 * file-backed database (allows a reader and a writer to proceed without
 * blocking each other, and is what makes "close instance A, open instance B
 * on the same file" — the restart-safety story — reliable) and a busy
 * timeout (see {@link DEFAULT_BUSY_TIMEOUT_MS}). WAL is skipped for
 * `:memory:`, where it's meaningless. For a file-backed path whose parent
 * directory doesn't exist yet, creates it (recursively) at
 * {@link SECURE_DIR_MODE} — mirroring the client-side device store's
 * convention of never leaving a credential directory at a permissive
 * default mode. Throws {@link SqliteUnavailableError} if `node:sqlite`
 * itself can't be loaded (Node <22.5, or a flagged intermediate 22.x — see
 * {@link isSqliteAvailable}) — callers don't need their own guard for that;
 * this is the single choke point.
 */
export function openSqliteDatabase(
  path: string,
  options?: DatabaseSyncOptions,
  faults?: SqliteOpenFaultSeam,
): DatabaseSync {
  const { DatabaseSync } = loadSqliteModule();
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: SECURE_DIR_MODE });
  }
  const db = new DatabaseSync(path, { timeout: DEFAULT_BUSY_TIMEOUT_MS, ...options });
  try {
    faults?.onStep?.('after-open');
    if (path !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL;');
      faults?.onStep?.('after-wal');
    }
    return db;
  } catch (error) {
    closeSqliteDatabaseAfterInitializationFailure(
      db,
      error,
      'SQLite open initialization failed and its native handle could not be closed',
      faults?.close,
    );
  }
}

/** SQLite's primary result code for a lock held elsewhere. */
const SQLITE_BUSY = 5;

/** Exclusive ownership of one database file; {@link SqliteOwnership.release} is idempotent. */
export interface SqliteOwnership {
  release(): void;
}

/**
 * Take exclusive ownership of the database at `path`, or throw
 * {@link SqliteOwnershipError} immediately (no busy wait) if it is held.
 *
 * The lock is SQLite's own: an EXCLUSIVE transaction held open on a dedicated
 * `<path>-lock` file. SQLite maps it to an OS advisory lock, which conflicts
 * across processes and — through SQLite's per-inode lock table — across
 * connections in one process, and which the kernel drops when the holder's
 * process dies. It is a sibling file rather than the database itself so the
 * owner's own connection, and read-only inspection of the database, are never
 * blocked by it. Nothing is ever written to it.
 */
export function acquireSqliteOwnership(path: string): SqliteOwnership {
  const { DatabaseSync } = loadSqliteModule();
  mkdirSync(dirname(path), { recursive: true, mode: SECURE_DIR_MODE });
  // SQLite opens a symlink's target. Ownership must use that same identity,
  // including when only the parent exists on the first open of a new file.
  const databasePath = existsSync(path)
    ? realpathSync(path)
    : join(realpathSync(dirname(path)), basename(path));
  // A hard link has no unique canonical name for the sibling lock or WAL.
  // Reject it before either SQLite handle opens instead of splitting writers.
  if (existsSync(databasePath) && statSync(databasePath).nlink !== 1) {
    throw new Error('SQLite ownership requires a database file with exactly one hard link');
  }
  const lockPath = `${databasePath}-lock`;
  const lock = new DatabaseSync(lockPath, { timeout: 0 });
  try {
    chmodSync(lockPath, SECURE_FILE_MODE);
    lock.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    const busy = (error as { errcode?: unknown }).errcode === SQLITE_BUSY;
    closeSqliteDatabaseAfterInitializationFailure(
      lock,
      busy ? new SqliteOwnershipError(path, { cause: error }) : error,
      'SQLite ownership acquisition failed and its lock handle could not be closed',
    );
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        lock.exec('ROLLBACK');
      } finally {
        lock.close();
      }
    },
  };
}

/**
 * Restrict `dbPath` and its WAL/SHM sibling files (`<path>-wal`,
 * `<path>-shm` — created by SQLite itself once WAL mode is active and a
 * write has happened) to owner-only read/write ({@link SECURE_FILE_MODE}).
 * Both SQLite reference stores hold sensitive bytes on disk with no other
 * access-control layer of their own — `SqliteBlobStore` an HMAC signing
 * secret plus arbitrary uploaded blob content, `SqliteTaskStore` task
 * instructions and device/session refs — so a real (non-`:memory:`)
 * database file must not be left at whatever permissive mode the process'
 * umask would otherwise give it.
 *
 * Call this AFTER the schema has been created against `dbPath` (so the
 * WAL/SHM files, which SQLite creates lazily on first write, already exist)
 * — a sibling file that doesn't exist yet is silently skipped rather than
 * treated as an error. No-op for `:memory:`.
 */
export function secureSqliteFilePermissions(dbPath: string): void {
  if (dbPath === ':memory:') return;
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(candidate)) {
      chmodSync(candidate, SECURE_FILE_MODE);
    }
  }
}
