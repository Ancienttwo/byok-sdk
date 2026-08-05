import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync, DatabaseSyncOptions } from 'node:sqlite';

import { ByokKeysError } from './errors';

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
 * `@byok/server`'s `sqlite-support.ts`, the SQLite-backed store here depends on
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
 * Open a database, creating its parent directory owner-only first. `:memory:`
 * skips every filesystem step, which is how the shared contract suite exercises
 * the SQLite code path without leaving anything on disk.
 */
export function openSqliteDatabase(
  path: string,
  options?: DatabaseSyncOptions,
): DatabaseSync {
  const { DatabaseSync } = loadSqliteModule();
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { mode: SECURE_DIR_MODE, recursive: true });
  }
  const database = new DatabaseSync(path, {
    timeout: DEFAULT_BUSY_TIMEOUT_MS,
    ...options,
  });
  if (path !== ':memory:') {
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA synchronous = FULL');
  }
  return database;
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
