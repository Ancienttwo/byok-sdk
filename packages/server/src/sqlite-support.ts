import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync, DatabaseSyncOptions } from 'node:sqlite';

/**
 * Thrown when `node:sqlite` isn't available in the running Node.js binary.
 * `node:sqlite` shipped in Node.js 22.5.0 (https://nodejs.org/api/sqlite.html)
 * and remains marked experimental there (an `ExperimentalWarning` on stderr
 * is expected and harmless — not an error). The SQLite-backed reference
 * stores in this package (`SqliteTaskStore`, `SqliteBlobStore`) deliberately
 * depend on nothing else — no `better-sqlite3` or other native module —
 * because staying at zero native dependencies is required to keep
 * `@byok/server` trivially packageable across platforms. The tradeoff is
 * that these stores simply don't work below Node 22.5; this error says so
 * clearly and up front, instead of letting a cryptic `Cannot find module
 * 'node:sqlite'` surface from deep inside a query.
 */
export class SqliteUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      'node:sqlite is unavailable in this Node.js runtime. The SQLite-backed reference ' +
        'stores (SqliteTaskStore/SqliteBlobStore) require Node.js 22.5+ with the built-in ' +
        '`node:sqlite` module (no native dependency is used or allowed here). Upgrade Node.js, ' +
        'or use the default InMemoryTaskStore / LocalDiskBlobStore instead.',
    );
    this.name = 'SqliteUnavailableError';
    this.cause = cause;
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
export function openSqliteDatabase(path: string, options?: DatabaseSyncOptions): DatabaseSync {
  const { DatabaseSync } = loadSqliteModule();
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: SECURE_DIR_MODE });
  }
  const db = new DatabaseSync(path, { timeout: DEFAULT_BUSY_TIMEOUT_MS, ...options });
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  return db;
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
