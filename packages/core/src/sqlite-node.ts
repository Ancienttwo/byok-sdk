import type { DatabaseSync } from 'node:sqlite';

/**
 * An existing file could not be opened read-only for its format check, for
 * example a Windows path past MAX_PATH, which a SQLite file URI cannot carry
 * in its extended-length form. Nothing has read or written the file; a store
 * refuses to start rather than treat the file as damaged.
 */
export class SqliteReadOnlyOpenError extends Error {
  constructor(readonly path: string, options: { cause: unknown }) {
    super(`SQLite file ${path} could not be opened read-only to check its format`, options);
    this.name = 'SqliteReadOnlyOpenError';
  }
}

/**
 * Run `readMetadata` on an existing, non-empty SQLite file opened read-only and
 * immutable, before anything opens it for writing. SQLite then takes no lock,
 * writes nothing to the file and creates no journal, WAL or SHM file, so a
 * store can refuse an older format without changing it.
 *
 * Only the main file is read: content still in a WAL or a hot rollback journal
 * is not seen. A store whose main file has no metadata yet while a WAL exists
 * (created by the current code and not yet checkpointed) is decided by the
 * store's own check after its writable open; a new store checkpoints right
 * after writing its metadata, which keeps that window short.
 *
 * `undefined` for `:memory:`, a missing path or a zero-length file, which hold
 * nothing to read. A file that cannot be stat'ed or opened throws
 * {@link SqliteReadOnlyOpenError}; errors thrown by `readMetadata`, including
 * SQLite's own read errors, propagate. `readMetadata` must finish its reads
 * synchronously: the handle is closed when it returns.
 */
export function readSqliteFileUnchanged<T>(
  path: string,
  readMetadata: (db: DatabaseSync) => T,
): T | undefined {
  if (path === ':memory:') return undefined;
  const { statSync } = process.getBuiltinModule('node:fs');
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new SqliteReadOnlyOpenError(path, { cause: error });
  }
  if (size === 0) return undefined;
  const { pathToFileURL } = process.getBuiltinModule('node:url');
  const url = pathToFileURL(path);
  url.searchParams.set('mode', 'ro');
  url.searchParams.set('immutable', '1');
  const sqlite = process.getBuiltinModule('node:sqlite');
  if (!sqlite) throw new Error('node:sqlite is not available in this runtime');
  let db: DatabaseSync;
  try {
    db = new sqlite.DatabaseSync(url, { readOnly: true });
  } catch (error) {
    throw new SqliteReadOnlyOpenError(path, { cause: error });
  }
  try {
    return readMetadata(db);
  } finally {
    db.close();
  }
}
