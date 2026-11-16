import type { DatabaseSync } from 'node:sqlite';

/**
 * An existing file could not be opened read-only for its format check.
 * Nothing has read or written the file; a store refuses to start rather than
 * treat the file as damaged.
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
  const sqlite = process.getBuiltinModule('node:sqlite');
  if (!sqlite) throw new Error('node:sqlite is not available in this runtime');
  let db: DatabaseSync;
  try {
    db = new sqlite.DatabaseSync(`${fileUri(path)}?mode=ro&immutable=1`, { readOnly: true });
  } catch (error) {
    throw new SqliteReadOnlyOpenError(path, { cause: error });
  }
  try {
    return readMetadata(db);
  } finally {
    db.close();
  }
}

/**
 * A SQLite `file:` URI naming `path`. SQLite's Windows VFS does not add the
 * extended-length prefix itself, so past the legacy MAX_PATH the path is
 * given as `\\?\<absolute>`, the form the stores' writable opens use; a
 * `file:///` URL cannot carry it. Every byte outside the unreserved set is
 * percent-encoded, so `?`, `#` and `%` in a path stay part of the name.
 */
function fileUri(path: string): string {
  const { resolve, win32 } = process.getBuiltinModule('node:path');
  let absolute = process.platform === 'win32' ? win32.resolve(path) : resolve(path);
  if (process.platform === 'win32' && !absolute.startsWith('\\\\?\\') && absolute.length >= 240) absolute = `\\\\?\\${absolute}`;
  const bytes = new TextEncoder().encode(absolute);
  let encoded = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    encoded += /[A-Za-z0-9._~/-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return `file:${encoded}`;
}

