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
    db = new sqlite.DatabaseSync(`${sqliteFileUri(path)}?mode=ro&immutable=1`, { readOnly: true });
  } catch (error) {
    throw new SqliteReadOnlyOpenError(path, { cause: error });
  }
  try {
    return readMetadata(db);
  } finally {
    db.close();
  }
}

const EXTENDED = '\\\\?\\';

/**
 * The path handed to SQLite, which is not always the path the rest of the code
 * uses. On Windows the SQLite VFS does not apply the extended-length prefix
 * itself: past the legacy MAX_PATH the open fails, and a failed open is
 * indistinguishable from a damaged file at the call site. The prefix is
 * applied only when the path is long enough to need it, so ordinary installs
 * keep the plain path. Every SQLite open of a store path, writable or the
 * read-only format check, names the file through this one rule.
 */
export function sqliteOpenPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || path === ':memory:') return path;
  const absolute = process.getBuiltinModule('node:path').win32.resolve(path);
  if (absolute.startsWith(EXTENDED) || absolute.length < 240) return absolute;
  return EXTENDED + absolute;
}

/**
 * A SQLite `file:` URI naming `path` as {@link sqliteOpenPath} does. A
 * `file:///` URL cannot carry the Windows extended-length prefix, so the URI
 * is built directly: every UTF-8 byte outside the unreserved set and `/` is
 * percent-encoded, so `%`, `#`, `?` and non-ASCII characters stay part of the
 * name.
 */
export function sqliteFileUri(path: string, platform: NodeJS.Platform = process.platform): string {
  const target = platform === 'win32' ? sqliteOpenPath(path, platform) : process.getBuiltinModule('node:path').posix.resolve(path);
  let encoded = '';
  for (const byte of new TextEncoder().encode(target)) {
    const char = String.fromCharCode(byte);
    encoded += /[A-Za-z0-9._~/-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return `file:${encoded}`;
}
