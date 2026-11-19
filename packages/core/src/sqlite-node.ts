import type { DatabaseSync } from 'node:sqlite';

/**
 * SQL condition on a `sqlite_schema` row's `name` that keeps the objects a
 * store created and leaves out SQLite's own, which are named with the literal
 * `sqlite_` prefix. `name NOT LIKE 'sqlite_%'` is not equivalent: `_` matches
 * any one character in LIKE, so it also hides user objects named `sqliteX…`.
 */
export const SQLITE_USER_OBJECT = "substr(name, 1, 7) <> 'sqlite_'";

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
 * is not seen. Use {@link readSqliteSnapshot} when committed WAL data is needed.
 * A store whose main file has no metadata yet while a WAL exists
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

/** A consistent private snapshot could not be taken, or may need journal recovery. */
export class SqliteSnapshotError extends Error {
  constructor(readonly path: string, readonly reason: 'changed' | 'hot-journal', options?: { cause: unknown }) {
    super(`SQLite snapshot of ${path} unavailable: ${reason === 'changed' ? 'files changed while copying' : 'a potentially hot rollback journal exists'}`, options);
    this.name = 'SqliteSnapshotError';
  }
}

/**
 * Read committed main-file and WAL data from a writable private copy, without
 * opening the original with SQLite. Unlike {@link readSqliteFileUnchanged},
 * this sees uncheckpointed commits and refuses a potentially hot rollback
 * journal. A changed file during copying throws {@link SqliteSnapshotError}.
 * `:memory:`, missing and empty files return undefined, as in that function.
 * The callback must finish synchronously; its database and copy path are valid
 * only until it returns. The private directory and its files are then removed.
 */
export function readSqliteSnapshot<T>(path: string, read: (db: DatabaseSync, copyPath: string) => T): T | undefined {
  if (path === ':memory:') return undefined;
  const fs = process.getBuiltinModule('node:fs');
  const { join, basename, resolve } = process.getBuiltinModule('node:path');
  const file = resolve(path);
  const stat = (name: string) => {
    try { return fs.statSync(name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  };
  let initial: ReturnType<typeof stat>;
  try { initial = stat(file); }
  catch (error) { throw new SqliteReadOnlyOpenError(path, { cause: error }); }
  if (!initial || initial.size === 0) return undefined;
  const directory = fs.mkdtempSync(join(process.getBuiltinModule('node:os').tmpdir(), 'byok-sqlite-snapshot-'));
  try {
    const copy = join(directory, basename(file));
    const suffixes = ['', '-wal', '-journal'];
    const fingerprint = (suffix: string) => {
      const s = stat(file + suffix);
      return s && `${s.size}:${s.mtimeMs}:${s.ino}`;
    };
    const before = suffixes.map(fingerprint);
    const initialFingerprint = `${initial.size}:${initial.mtimeMs}:${initial.ino}`;
    if (before[0] !== initialFingerprint) throw new SqliteSnapshotError(path, 'changed');
    try {
      suffixes.forEach((suffix, i) => { if (before[i] !== undefined) fs.copyFileSync(file + suffix, copy + suffix); });
    } catch (error) {
      if (suffixes.some((suffix, i) => fingerprint(suffix) !== before[i])) {
        throw new SqliteSnapshotError(path, 'changed', { cause: error });
      }
      throw error;
    }
    if (suffixes.some((suffix, i) => fingerprint(suffix) !== before[i])) throw new SqliteSnapshotError(path, 'changed');
    // SQLite treats a journal larger than 512 bytes with a valid nonzero
    // header as hot when no writer holds the reserved lock. Do not probe locks
    // on the original: conservatively refuse this candidate even with a writer.
    if (before[2] !== undefined && fs.statSync(copy + '-journal').size > 512) {
      const fd = fs.openSync(copy + '-journal', 'r');
      const header = Buffer.alloc(8);
      let bytes: number;
      try { bytes = fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
      if (bytes === 8 && header.equals(Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]))) {
        throw new SqliteSnapshotError(path, 'hot-journal');
      }
    }
    const sqlite = process.getBuiltinModule('node:sqlite');
    if (!sqlite) throw new Error('node:sqlite is not available in this runtime');
    // Bun needs a writable copy to create WAL/SHM and may remove them on close (#2371).
    const db = new sqlite.DatabaseSync(`${sqliteFileUri(copy)}?mode=rw`);
    try { return read(db, copy); } finally { db.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
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
