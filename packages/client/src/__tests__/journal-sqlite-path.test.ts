import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { readSqliteFileUnchanged, sqliteFileUri, sqliteOpenPath } from '@byok-sdk/core/sqlite-node';
import { JOURNAL_DB_FILENAME, SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal';
import { resolveBunBin } from './support/test-bun-bin';

declare const __BYOK_JOURNAL_WORKER_SOURCE__: string;
const BUN = resolveBunBin();

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

/**
 * #2347: Bun 1.4.2's node:sqlite kept a connection's files open after
 * `close()` until its prepared statements were collected. Windows then refused
 * the delete or rename that follows a close in the same process. Each path
 * below closes a connection that prepared statements, then removes or moves
 * its files at once, under Bun and with no GC. On macOS lsof also lists what
 * is still open, so the check fails there too.
 */
describe.runIf(BUN !== undefined)('SQLite files after close under Bun (#2347)', () => {
  const child = String.raw`
    import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs';
    import { rm } from 'node:fs/promises';
    import { execFileSync } from 'node:child_process';
    import path from 'node:path';
    import { DatabaseSync } from 'node:sqlite';
    import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
    import { SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal';
    import { JournalCorruptError } from '../daemon/journal/journal';
    import { acquireReplicaLock, resetReplica } from '../adapters/pi-durable/replica';
    import { openLocalDurableStorage } from '../adapters/pi-durable/storage';
    import { inspectDaemonStores } from '../diagnostics/store-compatibility';
    import { collectDiagnostics } from '../diagnostics/diagnostics';

    const root = process.argv[2];
    const failures = [];
    const check = async (name, run) => {
      try { await run(mkdtempSync(path.join(root, name + '-'))); } catch (error) { failures.push(name + ': ' + String(error)); }
    };
    const expectGone = (...files) => { for (const f of files) if (existsSync(f)) throw new Error('still present: ' + f); };
    const replica = (store) => path.join(store, 'durable-replicas', 'a'.repeat(64), 'durable-task-1.sqlite');
    const journalStore = async (store) => { await new SqliteLocalTaskJournal({ storeDir: store }).close(); };
    const piReplica = async (file) => {
      mkdirSync(path.dirname(file), { recursive: true });
      await (await openLocalDurableStorage(file)).close(BACKGROUND_CONTEXT);
    };

    await check('quarantine', async (store) => {
      // A valid header and no schema, but the freelist points past the file:
      // the format checks and header read succeed, the schema transaction fails.
      const file = path.join(store, 'daemon.db');
      const db = new DatabaseSync(file);
      db.exec('PRAGMA user_version = 7');
      db.close();
      const fd = openSync(file, 'r+');
      const header = Buffer.alloc(8);
      header.writeUInt32BE(50, 0);
      header.writeUInt32BE(1, 4);
      writeSync(fd, header, 0, 8, 32);
      closeSync(fd);
      try { new SqliteLocalTaskJournal({ storeDir: store }); throw new Error('the journal opened'); }
      catch (error) { if (!(error instanceof JournalCorruptError)) throw error; }
      expectGone(file, file + '-wal', file + '-shm');
    });
    await check('replica-reset-and-lock', async (store) => {
      // The retention sweep's order: lock, reset the Pi replica, release, remove the lock.
      const file = replica(store);
      await piReplica(file);
      const lock = await acquireReplicaLock(file, 'retention');
      try { await resetReplica(file); } finally { lock.release(); }
      await rm(file + '.lock.sqlite');
      expectGone(file, file + '-wal', file + '-shm', file + '.lock.sqlite');
    });
    await check('store-check', async (store) => {
      await journalStore(store);
      await piReplica(replica(store));
      const results = await inspectDaemonStores({ storeDir: store });
      if (results.length !== 2 || results.some((r) => r.verdict !== 'accepted')) throw new Error(JSON.stringify(results));
    });
    await check('doctor', async (store) => {
      await journalStore(store);
      const snapshot = await collectDiagnostics(
        { productId: 'p', productName: 'p', serverUrl: 'http://127.0.0.1:0', storeDir: store },
        store,
        { adapters: [] },
      );
      if (snapshot.journal.status !== 'present') throw new Error(JSON.stringify(snapshot.journal));
      if (readdirSync(path.join(store, 'tmp', 'daemon')).length !== 0) throw new Error('diagnostics copy left behind');
    });
    await check('embedded-close-then-remove', async (store) => {
      await journalStore(store);
      rmSync(store, { recursive: true });
    });
    if (process.platform === 'darwin') {
      const open = execFileSync('lsof', ['-Fn', '-p', String(process.pid)], { encoding: 'utf8' })
        .split('\n').filter((line) => line.startsWith('n') && line.includes(root));
      if (open.length > 0) failures.push('still open after close: ' + open.map((line) => line.slice(1)).join(', '));
    }
    console.log(JSON.stringify(failures));
  `;

  it('removes or renames every file a closed connection used, without GC', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'byok-bun-close-')));
    // Inside this package's node_modules, so the bundle's external imports resolve as the package's own.
    const cacheDir = fileURLToPath(new URL('../../node_modules/.cache/', import.meta.url));
    mkdirSync(cacheDir, { recursive: true });
    const bundleDir = mkdtempSync(path.join(cacheDir, 'bun-close-child-'));
    try {
      const bundle = path.join(bundleDir, 'child.mjs');
      buildSync({
        stdin: { contents: child, resolveDir: path.dirname(fileURLToPath(import.meta.url)), sourcefile: 'child.ts', loader: 'ts' },
        bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', outfile: bundle, logLevel: 'warning',
        define: { __BYOK_CLIENT_PACKAGE_VERSION__: JSON.stringify('0.0.0-test'), __BYOK_JOURNAL_WORKER_SOURCE__: JSON.stringify(__BYOK_JOURNAL_WORKER_SOURCE__) },
      });
      const run = spawnSync(BUN!, [bundle, root], { encoding: 'utf8', timeout: 60_000 });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout.trim().split('\n').at(-1)!)).toEqual([]);
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
