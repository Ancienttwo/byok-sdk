import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync, DatabaseSyncOptions } from 'node:sqlite';

import { ByokKeysError } from './errors';

export type SqliteOpenStep = 'after-open' | 'after-wal' | 'after-synchronous';

/** Test-only seam for proving that post-open initialization failures release the native handle. */
export interface SqliteOpenFaultSeam {
  onStep?(step: SqliteOpenStep): void;
  close?(database: DatabaseSync): void;
}

/** Release an opened handle before propagating an initialization failure. */
export function closeSqliteDatabaseAfterInitializationFailure(
  database: DatabaseSync,
  initializationError: unknown,
  message: string,
  close: (database: DatabaseSync) => void = (handle) => handle.close(),
): never {
  try {
    close(database);
  } catch (closeError) {
    throw new AggregateError([initializationError, closeError], message);
  }
  throw initializationError;
}

/** Owner-only directory mode, matching `providers.ts:1236`. */
const SECURE_DIR_MODE = 0o700;

/** Owner-only file mode, matching `providers.ts:158`. */
const SECURE_FILE_MODE = 0o600;

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

interface SqliteModule {
  DatabaseSync: new (
    path: string,
    options?: DatabaseSyncOptions,
  ) => DatabaseSync;
}

/**
 * Load `node:sqlite`, or fail with a `ByokKeysError` that says why.
 *
 * `node:sqlite` shipped in Node.js 22.5.0 and stays marked experimental (an
 * `ExperimentalWarning` on stderr is expected and harmless). Following
 * `@byok-sdk/server`'s `sqlite-support.ts`, the SQLite-backed store here depends on
 * nothing else — no `better-sqlite3`, no native module — because zero native
 * dependencies is what keeps this package trivially packageable. The tradeoff
 * is that {@link SqliteProviderProfileStore} does not work below Node 22.5, and
 * this error says so instead of letting a cryptic `Cannot find module` surface
 * from deep inside a query.
 */
export function loadSqliteModule(): SqliteModule {
  try {
    return createRequire(import.meta.url)('node:sqlite') as SqliteModule;
  } catch (error) {
    throw new ByokKeysError(
      'PROVIDER_STORE_UNAVAILABLE',
      'node:sqlite is unavailable in this Node.js runtime. SqliteProviderProfileStore ' +
        'requires Node.js 22.5+ with the built-in `node:sqlite` module (no native ' +
        'dependency is used or allowed here). Upgrade Node.js, or use ' +
        'InMemoryProviderProfileStore instead.',
      { cause: error },
    );
  }
}

/**
 * Whether `node:sqlite` can ACTUALLY be loaded right now.
 *
 * Same predicate as `@byok-sdk/server`'s `sqlite-support.ts`, and it exists for the
 * same reason: this package's `engines.node` is `>=20` and CI runs the matrix
 * on 20 and 22, but `node:sqlite` shipped in 22.5 and stayed behind
 * `--experimental-sqlite` for part of the 22.x line. A version-number
 * comparison would therefore be wrong in both directions, so this attempts the
 * real require via {@link loadSqliteModule} and reports whether it succeeded.
 *
 * Callers use it to skip a SQLite-backed path rather than fail it — the
 * package's own SQLite-backed suites gate on it — and anything else should call
 * it before assuming a {@link SqliteProviderProfileStore} can be constructed.
 */
export function isSqliteAvailable(): boolean {
  try {
    loadSqliteModule();
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a database, creating its parent directory owner-only first. `:memory:`
 * skips every filesystem step, which is how the shared contract suite exercises
 * the SQLite code path without leaving anything on disk.
 */
export function openSqliteDatabase(
  path: string,
  options?: DatabaseSyncOptions,
  faults?: SqliteOpenFaultSeam,
): DatabaseSync {
  const { DatabaseSync } = loadSqliteModule();
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { mode: SECURE_DIR_MODE, recursive: true });
  }
  const database = new DatabaseSync(path, {
    timeout: DEFAULT_BUSY_TIMEOUT_MS,
    ...options,
  });
  try {
    faults?.onStep?.('after-open');
    if (path !== ':memory:') {
      database.exec('PRAGMA journal_mode = WAL');
      faults?.onStep?.('after-wal');
      database.exec('PRAGMA synchronous = FULL');
      faults?.onStep?.('after-synchronous');
    }
    return database;
  } catch (error) {
    closeSqliteDatabaseAfterInitializationFailure(
      database,
      error,
      'provider profile SQLite open initialization failed and its native handle could not be closed',
      faults?.close,
    );
  }
}

/**
 * Restrict `databasePath` and its WAL/SHM siblings to owner-only read/write.
 *
 * The profile table holds no secret — that is the whole point of splitting the
 * key into the OS credential store — but it does hold every provider endpoint
 * this machine talks to, and the source locked the file down
 * (`providers.ts:158`), so the port keeps that. Call after the schema exists,
 * so the lazily-created WAL/SHM files are already there; a sibling that does
 * not exist is skipped rather than treated as an error. No-op for `:memory:`.
 */
export function secureSqliteFilePermissions(databasePath: string): void {
  if (databasePath === ':memory:') return;
  for (const candidate of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ]) {
    if (existsSync(candidate)) {
      chmodSync(candidate, SECURE_FILE_MODE);
    }
  }
}
