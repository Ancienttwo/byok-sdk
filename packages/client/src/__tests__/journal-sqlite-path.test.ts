import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { readSqliteFileUnchanged, sqliteFileUri, sqliteOpenPath } from '@byok-sdk/core/sqlite-node';
import { JOURNAL_DB_FILENAME, SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal';

/**
 * #1097: a >MAX_PATH store made SQLite's open fail, and the journal read that
 * failure as corruption: it quarantined a healthy database and the service
 * never came back up. The SQLite VFS needs the extended-length prefix; the
 * rest of the process keeps the plain path. #2286: the read-only format check
 * names the file through the same rule, as a `file:` URI.
 */
describe('sqliteOpenPath (#1097)', () => {
  it('leaves a posix path alone', () => {
    expect(sqliteOpenPath('/var/lib/byok/journal.db', 'linux')).toBe('/var/lib/byok/journal.db');
  });

  it('keeps a short Windows path plain', () => {
    expect(sqliteOpenPath('C:\\byok\\journal.db', 'win32')).toBe('C:\\byok\\journal.db');
  });

  it('prefixes a long Windows path exactly once', () => {
    const long = 'D:' + '\\a'.repeat(120) + '\\journal.db';
    expect(long.length).toBeGreaterThan(240);
    const prefixed = sqliteOpenPath(long, 'win32');
    expect(prefixed).toBe('\\\\?\\' + long);
    expect(sqliteOpenPath(prefixed, 'win32')).toBe(prefixed);
    expect(sqliteFileUri(long, 'win32')).toBe('file:%5C%5C%3F%5CD%3A' + '%5Ca'.repeat(120) + '%5Cjournal.db');
  });
});

describe('sqliteFileUri (#2286)', () => {
  it('percent-encodes %, #, ? and non-ASCII so they stay part of the name', () => {
    expect(sqliteFileUri('/s/a%b#c?d 空.db', 'linux')).toBe('file:/s/a%25b%23c%3Fd%20%E7%A9%BA.db');
    expect(sqliteFileUri('C:\\s\\a%b#c 空.db', 'win32')).toBe('file:C%3A%5Cs%5Ca%25b%23c%20%E7%A9%BA.db');
  });

  it('opens a real file whose path holds those characters', () => {
    const name = process.platform === 'win32' ? 'a%b#c 空' : 'a%b#c?d 空';
    const dir = path.join(os.tmpdir(), `byok-sqlite-uri-${process.pid}`, name);
    mkdirSync(dir, { recursive: true });
    try {
      const file = path.join(dir, 'store.db');
      const db = new DatabaseSync(file);
      db.exec('CREATE TABLE t(x)');
      db.close();
      expect(readSqliteFileUnchanged(file, read => read.prepare('SELECT count(*) AS n FROM sqlite_schema').get())).toEqual({ n: 1 });
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')('reopens an existing journal past MAX_PATH: read-only check, then writable open', async () => {
    let storeDir = path.join(os.tmpdir(), `byok-journal-long-${process.pid}`);
    while (storeDir.length < 280) storeDir = path.join(storeDir, 'a-directory-name-for-a-path-past-max-path');
    mkdirSync(storeDir, { recursive: true });
    try {
      expect(path.join(storeDir, JOURNAL_DB_FILENAME).length).toBeGreaterThan(260);
      await new SqliteLocalTaskJournal({ storeDir }).close();
      // The journal now exists, so this construction runs the read-only check on it first.
      await new SqliteLocalTaskJournal({ storeDir }).close();
    } finally {
      rmSync(path.join(os.tmpdir(), `byok-journal-long-${process.pid}`), { recursive: true, force: true });
    }
  });
});
