import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSqliteSnapshot, SqliteSnapshotError } from '../sqlite-node.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function rootDir() { const root = fs.mkdtempSync(join(tmpdir(), 'snapshot-test-')); roots.push(root); return root; }
function listing(root: string) {
  return fs.readdirSync(root).sort().map(name => { const stat = fs.statSync(join(root, name)); return [name, stat.size, stat.mtimeMs]; });
}

describe('readSqliteSnapshot', () => {
  it('reads uncheckpointed WAL commits without changing any original files', () => {
    const root = rootDir(), file = join(root, 'a%# 数据.sqlite');
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (value TEXT); INSERT INTO t VALUES (\'committed\')');
      const before = listing(root);
      expect(before.map(row => row[0])).toContain('a%# 数据.sqlite-wal');
      expect(readSqliteSnapshot(file, (snapshot, copy) => {
        if (process.platform !== 'win32') expect(fs.statSync(join(copy, '..')).mode & 0o777).toBe(0o700);
        return snapshot.prepare('SELECT value FROM t').all();
      })).toEqual([{ value: 'committed' }]);
      expect(listing(root)).toEqual(before);
    } finally { db.close(); }
  });

  it('reads WAL commits through a symlink to the database', () => {
    const root = rootDir(), file = join(root, 'store.db'), link = join(root, 'link.db');
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (value TEXT); INSERT INTO t VALUES ('committed')");
      fs.symlinkSync(file, link);
      expect(readSqliteSnapshot(link, snapshot => snapshot.prepare('SELECT value FROM t').all())).toEqual([{ value: 'committed' }]);
    } finally { db.close(); }
  });

  it('detects a WAL reset even when file metadata is unchanged', () => {
    const root = fs.realpathSync(rootDir()), file = join(root, 'store.db'), wal = file + '-wal';
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (n); INSERT INTO t VALUES (1)');
      const originalStat = fs.statSync(wal);
      const copy = fs.copyFileSync.bind(fs);
      const stat = fs.statSync.bind(fs);
      vi.spyOn(fs, 'statSync').mockImplementation(((name: fs.PathLike, options?: fs.StatOptions) => {
        const result = stat(name, options as never);
        if (String(name) === wal) Object.assign(result, { mtimeMs: originalStat.mtimeMs });
        return result;
      }) as typeof fs.statSync);
      vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, flags) => {
        copy(source, destination, flags);
        if (String(source) === file) {
          const fd = fs.openSync(wal, 'r+');
          try { const byte = Buffer.alloc(1); fs.readSync(fd, byte, 0, 1, 16); byte[0] = (byte[0] ?? 0) ^ 1; fs.writeSync(fd, byte, 0, 1, 16); }
          finally { fs.closeSync(fd); }
          expect(fs.statSync(wal).size).toBe(originalStat.size);
          expect(fs.statSync(wal).ino).toBe(originalStat.ino);
          expect(fs.statSync(wal).mtimeMs).toBe(originalStat.mtimeMs);
        }
      });
      const read = vi.fn();
      expect(() => readSqliteSnapshot(file, read)).toThrow(expect.objectContaining({ name: 'SqliteSnapshotError', reason: 'changed' }));
      expect(read).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); db.close(); }
  });

  it('refuses a copied WAL whose header differs from the original', () => {
    const root = fs.realpathSync(rootDir()), file = join(root, 'store.db');
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (n)');
      const copy = fs.copyFileSync.bind(fs);
      vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, flags) => {
        copy(source, destination, flags);
        if (String(source) === file + '-wal') {
          const fd = fs.openSync(destination, 'r+');
          try { const byte = Buffer.alloc(1); fs.readSync(fd, byte, 0, 1, 16); byte[0] = (byte[0] ?? 0) ^ 1; fs.writeSync(fd, byte, 0, 1, 16); }
          finally { fs.closeSync(fd); }
        }
      });
      const read = vi.fn();
      expect(() => readSqliteSnapshot(file, read)).toThrow(expect.objectContaining({ name: 'SqliteSnapshotError', reason: 'changed' }));
      expect(read).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); db.close(); }
  });

  it('refuses files changed during copying before invoking the callback', () => {
    const root = rootDir(), file = join(root, 'store.db');
    const db = new DatabaseSync(file); db.exec('CREATE TABLE t (n)'); db.close();
    const copy = fs.copyFileSync.bind(fs);
    vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, flags) => {
      copy(source, destination, flags);
      fs.appendFileSync(file, 'changed');
    });
    const read = vi.fn();
    expect(() => readSqliteSnapshot(file, read)).toThrow(SqliteSnapshotError);
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a potentially hot journal without opening the original', () => {
    const root = rootDir(), file = join(root, 'store.db');
    const db = new DatabaseSync(file); db.exec('CREATE TABLE t (n)'); db.close();
    const journal = Buffer.alloc(1024); Buffer.from('d9d505f920a163d7', 'hex').copy(journal);
    fs.writeFileSync(file + '-journal', journal);
    const before = listing(root), read = vi.fn();
    expect(() => readSqliteSnapshot(file, read)).toThrow(/hot rollback journal/);
    expect(read).not.toHaveBeenCalled();
    expect(listing(root)).toEqual(before);
  });

  it('refuses a hot journal beside the real target of a symlink', () => {
    const root = rootDir(), file = join(root, 'store.db'), link = join(root, 'link.db');
    const db = new DatabaseSync(file); db.exec('CREATE TABLE t (n)'); db.close();
    fs.symlinkSync(file, link);
    const journal = Buffer.alloc(1024); Buffer.from('d9d505f920a163d7', 'hex').copy(journal);
    fs.writeFileSync(file + '-journal', journal);
    const read = vi.fn();
    expect(() => readSqliteSnapshot(link, read)).toThrow(expect.objectContaining({ name: 'SqliteSnapshotError', reason: 'hot-journal' }));
    expect(read).not.toHaveBeenCalled();
  });

  it('removes the private copy when the callback throws', () => {
    const root = rootDir(), file = join(root, 'store.db');
    const db = new DatabaseSync(file); db.exec('CREATE TABLE t (n)'); db.close();
    let copy = '';
    expect(() => readSqliteSnapshot(file, (_db, path) => { copy = path; throw new Error('reader failed'); })).toThrow('reader failed');
    expect(fs.existsSync(copy)).toBe(false);
  });

  it('returns undefined for memory, missing and empty files', () => {
    const root = rootDir(), empty = join(root, 'empty'); fs.writeFileSync(empty, '');
    for (const file of ['', ':memory:', join(root, 'missing'), empty]) expect(readSqliteSnapshot(file, () => 'read')).toBeUndefined();
  });
});
