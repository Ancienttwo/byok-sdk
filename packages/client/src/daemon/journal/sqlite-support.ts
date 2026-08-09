/**
 * `node:sqlite` capability detection and connection setup for the daemon's
 * durable local journal.
 *
 * This deliberately MIRRORS `packages/server/src/sqlite-support.ts` in shape
 * rather than importing it. `@byok/client` has no dependency on `@byok/server`
 * outside its own dev/test tree, and it must not gain one: the daemon ships to
 * an end user's machine and the reference server does not. The two files are
 * therefore the same idea applied twice on purpose — the server's module is
 * internal to that package and stays untouched by this slice — with the
 * differences that matter here spelled out below:
 *
 * - the durability pragmas are the journal's own (`foreign_keys=ON`,
 *   `synchronous=FULL`, `auto_vacuum=INCREMENTAL`), not the reference stores';
 * - "unavailable" is fail-closed for a REASON here (architecture §12.7.2's
 *   no-silent-downgrade rule: a hosted daemon that cannot open a real SQLite
 *   database refuses to start rather than substituting a file journal that
 *   only looks durable), so the typed error it raises is the journal's own —
 *   see `JournalUnavailableError` in `journal.ts`.
 */
import { createRequire } from 'node:module';
import { chmodSync, existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

/** Every post-construction boundary crossed before a journal handle is returned to its owner. */
export type JournalOpenStep =
  | 'after-open'
  | 'after-auto-vacuum'
  | 'after-wal'
  | 'after-foreign-keys'
  | 'after-synchronous'
  | 'after-header-read';

/**
 * Test-only fault seam for proving that every post-open initialization failure
 * closes the native handle before control returns to the journal constructor.
 */
export interface JournalOpenFaultSeam {
  onStep?(step: JournalOpenStep): void;
  /** Test-only close override; production always calls `DatabaseSync.close()`. */
  close?(db: DatabaseSync): void;
}

/**
 * Initialization failed after SQLite returned a native handle, and closing
 * that handle also failed. Callers must retain their cross-process ownership
 * lease because the helper can no longer prove that no writer remains alive.
 */
export class JournalHandleCleanupError extends Error {
  constructor(message: string, readonly failures: readonly unknown[]) {
    super(message);
    this.name = 'JournalHandleCleanupError';
  }
}

/** `node:sqlite`'s minimum Node.js version (https://nodejs.org/api/sqlite.html). */
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 5;

/**
 * Whether `nodeVersion` (a `major.minor.patch` string shaped like
 * `process.versions.node`) is new enough for `node:sqlite` to exist at all.
 * A version-string heuristic only — `node:sqlite` shipped in 22.5.0 behind
 * `--experimental-sqlite` and became usable unflagged later, so a runtime
 * passing this can still fail to load the module. {@link isSqliteAvailable}
 * is the authoritative check; this one only exists to turn the common
 * "Node too old" case into a specific message. Unparsable input returns
 * `true` (the `require` below is the real gate; don't false-negative on a
 * version shape this hasn't seen).
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
 * `import()`. `DatabaseSync`'s entire API is synchronous, and the journal is
 * constructed synchronously from `createDaemonWithAdapters` alongside every
 * other daemon-local store (`DeviceStore`, `CursorStore`, ...) — an async
 * factory here would leak into every one of those call sites for nothing.
 * `node:sqlite` is a built-in, so `require` resolves it even from this
 * `"type": "module"` package. Memoized: the throw is re-derived per call from
 * the version check rather than cached, which keeps the failure message
 * accurate without keeping a rejected value around.
 */
export function loadSqliteModule(): typeof import('node:sqlite') {
  if (sqliteModule) return sqliteModule;
  if (!isSqliteCapableNodeVersion(process.versions.node)) {
    throw new Error(
      `node:sqlite requires Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+; detected ${process.versions.node}`,
    );
  }
  const require = createRequire(import.meta.url);
  sqliteModule = require('node:sqlite') as typeof import('node:sqlite');
  return sqliteModule;
}

/**
 * Whether `node:sqlite` can ACTUALLY be loaded right now. This is what the
 * journal's own test suites use for `describe.skipIf(!isSqliteAvailable())`
 * (the same idiom `@byok/server`'s SQLite suites already use), and what
 * `createDaemonWithAdapters` calls before constructing a hosted journal so
 * the refusal is a typed, up-front error instead of a cryptic
 * `Cannot find module 'node:sqlite'` from deep inside the first append.
 */
export function isSqliteAvailable(): boolean {
  try {
    loadSqliteModule();
    return true;
  } catch {
    return false;
  }
}

/** POSIX mode the journal database and its WAL/SHM siblings are restricted to — owner read/write only. Same convention as `daemon/store.ts`'s device credential file. */
const SECURE_FILE_MODE = 0o600;

/**
 * Open (or create) the journal database at `path` with the durability
 * settings architecture §12.7.2 pins, in the order they have to be applied:
 *
 * 1. `auto_vacuum = INCREMENTAL` — MUST precede table creation. `auto_vacuum`
 *    is only settable on a database with no schema yet; setting it afterward
 *    is silently ignored, and `compact()`'s `PRAGMA incremental_vacuum` would
 *    then be a no-op that reports success.
 * 2. `journal_mode = WAL` — a reader and the single writer proceed without
 *    blocking each other, and it is what makes "drop the instance, reopen the
 *    same file" (the entire crash-matrix method) reliable.
 * 3. `foreign_keys = ON` — the journal's tables are a real graph
 *    (transition -> task -> envelope); an orphan row here is corrupted
 *    recovery evidence, not a tolerable inconsistency.
 * 4. `synchronous = FULL` — every ack-critical transaction fsyncs before it
 *    reports committed. This is THE setting the "durable append then cursor
 *    ack" ordering rests on; NORMAL would let the WAL commit land in the OS
 *    page cache, so the cursor could advance over an envelope a power cut
 *    then erases. Applied database-wide rather than per-transaction: the
 *    journal's whole reason to exist is ack-critical writes, and the
 *    maintenance paths that do not need it (checkpoint, incremental vacuum)
 *    are off the hot path anyway.
 *
 * `busyTimeoutMs` bounds how long a write waits on the lock before throwing
 * `SQLITE_BUSY` — bounded on purpose, so contention surfaces as an error the
 * caller sees rather than an unbounded stall on the envelope path.
 *
 * Throws whatever `node:sqlite` throws (module load failure, a corrupt file,
 * an unreadable directory). Every caller is `SqliteLocalTaskJournal`'s
 * constructor, which turns each of those into its own typed error — see
 * `sqlite-journal.ts`.
 */
export function openJournalDatabase(
  path: string,
  busyTimeoutMs: number,
  faults?: JournalOpenFaultSeam,
): DatabaseSync {
  const { DatabaseSync } = loadSqliteModule();
  const db = new DatabaseSync(path, { timeout: busyTimeoutMs });
  try {
    faults?.onStep?.('after-open');
    db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
    faults?.onStep?.('after-auto-vacuum');
    db.exec('PRAGMA journal_mode = WAL;');
    faults?.onStep?.('after-wal');
    db.exec('PRAGMA foreign_keys = ON;');
    faults?.onStep?.('after-foreign-keys');
    db.exec('PRAGMA synchronous = FULL;');
    faults?.onStep?.('after-synchronous');
    // Forces a real header read: a file that is not a SQLite database (or whose
    // header is damaged) fails HERE, at open, where the quarantine path can act
    // on it — not later, mid-append, with a half-written transaction in flight.
    db.prepare('SELECT count(*) AS n FROM sqlite_schema').get();
    faults?.onStep?.('after-header-read');
    return db;
  } catch (err) {
    try {
      if (faults?.close) faults.close(db);
      else db.close();
    } catch (closeError) {
      throw new JournalHandleCleanupError(
        'local task journal initialization failed and its SQLite handle could not be closed',
        [err, closeError],
      );
    }
    throw err;
  }
}

/**
 * Restrict the journal database and its WAL/SHM siblings to owner-only
 * read/write. The journal holds raw task envelopes (instructions, policy) with
 * no other access-control layer of its own, so it must not be left at whatever
 * the process umask would give it. Call AFTER the schema exists, so the
 * WAL/SHM files SQLite creates lazily on first write are already there; a
 * sibling that does not exist yet is skipped rather than treated as an error.
 */
export function secureJournalFilePermissions(dbPath: string): void {
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(candidate)) {
      chmodSync(candidate, SECURE_FILE_MODE);
    }
  }
}
