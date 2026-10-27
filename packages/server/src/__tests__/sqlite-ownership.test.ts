import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, linkSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createByokServer, SqliteOwnershipError, SqliteSchemaError } from '../index';
import { isSqliteAvailable, openSqliteDatabase } from '../sqlite-support';

/**
 * Issues #388 and #414: one SQLite file, one owning server process. The owner is
 * SQLite's EXCLUSIVE lock on the actual database handle, so the stale-owner cases are
 * exercised with a real second process that dies by `exit` and by SIGKILL.
 */

const describeSqlite = isSqliteAvailable() ? describe : describe.skip;
const SQLITE_SUPPORT = fileURLToPath(new URL('../sqlite-support.ts', import.meta.url));

/**
 * A separate Node process that takes ownership of `path` through the same
 * `openSqliteDatabase` the SQLite composition uses, reports it on
 * stdout, then waits. Node strips the module's types natively.
 */
async function ownInChild(path: string, then: 'hold' | 'exit-without-release' | 'exit-during-grace'): Promise<ChildProcess> {
  const initial = createByokServer({ productId: 'sqlite-owner', storage: { kind: 'sqlite', path } });
  await initial.close();
  const script = `
    const { openSqliteDatabase } = await import(${JSON.stringify(SQLITE_SUPPORT)});
    // Held in a global: an unreachable lock handle may be finalized and closed by GC.
    globalThis.database = openSqliteDatabase(${JSON.stringify(path)});
    globalThis.database.exec('CREATE TABLE durable_marker (value INTEGER); INSERT INTO durable_marker VALUES (42); BEGIN; INSERT INTO durable_marker VALUES (99);');
    process.stdout.write('owned\\n');
    ${then === 'hold' ? 'setInterval(() => {}, 1_000);' : then === 'exit-during-grace' ? 'setTimeout(() => process.exit(0), 600);' : "process.stdin.once('data', () => process.exit(0));"}
  `;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const [chunk] = (await Promise.race([
    once(child.stdout!, 'data'),
    once(child, 'exit').then(([code]) => {
      throw new Error(`owner process exited early with ${String(code)}`);
    }),
  ])) as [Buffer];
  expect(chunk.toString()).toBe('owned\n');
  return child;
}

// A refused open retains the product's 5-second busy grace; allow the real
// cross-process operation to finish rather than timing out the test at 5s.
describeSqlite('SQLite single-process ownership', { timeout: 20_000 }, () => {
  const roots: string[] = [];
  const children: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function databasePath(): string {
    const root = mkdtempSync(join(tmpdir(), 'byok-owner-'));
    roots.push(root);
    return join(root, 'server.sqlite');
  }

  function open(path: string) {
    return createByokServer({ productId: 'sqlite-owner', storage: { kind: 'sqlite', path } });
  }

  it('refuses a second open in this process with a typed error, and hands over after close', async () => {
    const path = databasePath();
    const first = open(path);
    let refused: unknown;
    try {
      open(path);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(SqliteOwnershipError);
    expect(refused).toMatchObject({ code: 'SQLITE_DATABASE_OWNED', path });

    // The owner keeps working; external read-only inspection is excluded too.
    expect(await first.stats()).toMatchObject({ connectedDeviceCount: 0 });
    const inspect = new DatabaseSync(path, { readOnly: true });
    try {
      expect(() => inspect.prepare('SELECT COUNT(*) AS n FROM task_attempt').get()).toThrow(/locked/);
    } finally {
      inspect.close();
      await first.close();
    }
    const released = new DatabaseSync(path, { readOnly: true });
    try {
      expect(released.prepare('SELECT COUNT(*) AS n FROM task_attempt').get()).toEqual({ n: 0 });
    } finally { released.close(); }
    const second = open(path);
    await second.close();
  });

  it('refuses an open while another process owns the file', async () => {
    const path = databasePath();
    const owner = await ownInChild(path, 'hold');
    children.push(owner);
    expect(() => open(path)).toThrow(SqliteOwnershipError);
  });

  it('takes ownership if the prior process exits during the default busy grace', async () => {
    const path = databasePath();
    const owner = await ownInChild(path, 'exit-during-grace');
    children.push(owner);
    const exited = once(owner, 'exit');
    const database = openSqliteDatabase(path);
    try {
      expect(database.prepare('SELECT value FROM durable_marker').all()).toEqual([{ value: 42 }]);
      expect(database.prepare('PRAGMA locking_mode').get()).toEqual({ locking_mode: 'exclusive' });
    } finally { database.close(); }
    expect((await exited)[0]).toBe(0);
  });

  it('uses one ownership lock through a symlink to the database', async () => {
    const path = databasePath();
    const first = open(path);
    const alias = join(path, '..', 'alias.sqlite');
    symlinkSync(path, alias);
    try {
      expect(() => open(alias)).toThrow(SqliteOwnershipError);
    } finally {
      await first.close();
    }
    const next = open(alias);
    await next.close();
  });

  it('refuses hard-linked database paths whose WAL names would split recovery', async () => {
    const path = databasePath();
    const first = open(path);
    const alias = join(path, '..', 'hardlink.sqlite');
    linkSync(path, alias);
    try {
      expect(() => open(alias)).toThrow(/hard link/);
    } finally {
      await first.close();
    }
  });

  it('lets the next process open after the owner is SIGKILLed', async () => {
    const path = databasePath();
    const owner = await ownInChild(path, 'hold');
    children.push(owner);
    expect(() => open(path)).toThrow(SqliteOwnershipError);

    owner.kill('SIGKILL');
    const [, signal] = await once(owner, 'exit');
    expect(signal).toBe('SIGKILL');

    const next = openSqliteDatabase(path);
    try {
      expect(next.prepare('SELECT value FROM durable_marker').all()).toEqual([{ value: 42 }]);
      expect(next.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally { next.close(); }
    const server = open(path);
    await server.close();
  });

  it('lets the next process open after the owner exits without releasing', async () => {
    const path = databasePath();
    const owner = await ownInChild(path, 'exit-without-release');
    children.push(owner);
    expect(() => open(path)).toThrow(SqliteOwnershipError);

    owner.stdin!.write('go\n');
    const [code] = await once(owner, 'exit');
    expect(code).toBe(0);

    const next = openSqliteDatabase(path);
    try {
      expect(next.prepare('SELECT value FROM durable_marker').all()).toEqual([{ value: 42 }]);
    } finally { next.close(); }
    const server = open(path);
    await server.close();
  });

  it('releases ownership when the open itself fails', () => {
    const path = databasePath();
    const foreign = new DatabaseSync(path);
    foreign.exec('CREATE TABLE not_byok (id INTEGER)');
    foreign.close();
    expect(() => open(path)).toThrow(SqliteSchemaError);
    // Refused again for the same reason — not for an ownership the failed open leaked.
    expect(() => open(path)).toThrow(SqliteSchemaError);
  });

  it('opens without materializing task history and still rejects corrupt data on read', async () => {
    const path = databasePath();
    const first = open(path);
    await first.close();
    const corrupt = new DatabaseSync(path);
    corrupt.prepare(`INSERT INTO task_attempt
      (tenant_id, task_id, device_id, status, agent_ref_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run('product:sqlite-owner', 'bad-task', 'device', 'offered', 'invalid-json', '2026-10-13T00:00:00.000Z');
    corrupt.close();
    const reopened = open(path);
    try { await expect(reopened.tasks.get('bad-task')).rejects.toThrow(SyntaxError); }
    finally { await reopened.close(); }
  });

  it('adds the active-task covering index to existing v6 files without a schema bump', async () => {
    const path = databasePath();
    const first = open(path);
    await first.close();
    const old = new DatabaseSync(path);
    old.exec('DROP INDEX task_attempt_status_idx');
    old.close();
    const reopened = open(path);
    try { expect((await reopened.stats()).taskCountsByState.Offered).toBe(0); }
    finally { await reopened.close(); }
    // External reads require the EXCLUSIVE owner to release its handle first.
    const inspect = new DatabaseSync(path, { readOnly: true });
    try {
      expect(inspect.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'task_attempt_status_idx'").get())
        .toEqual({ name: 'task_attempt_status_idx' });
      expect(inspect.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()).toEqual({ value: '6' });
    } finally { inspect.close(); }
  });

  it('uses the actual exclusive WAL handle with the default grace and no lock sibling or SHM', () => {
    const path = databasePath();
    const database = openSqliteDatabase(path);
    try {
      database.exec('CREATE TABLE marker (id INTEGER)');
      expect(database.prepare('PRAGMA locking_mode').get()).toEqual({ locking_mode: 'exclusive' });
      expect(database.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect(database.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5_000 });
      expect(existsSync(`${path}-lock`)).toBe(false);
      expect(existsSync(`${path}-shm`)).toBe(false);
      expect(existsSync(`${path}-wal`)).toBe(true);
    } finally { database.close(); }
  });

  it('secures the database and its canonical WAL when opened through a symlink', async () => {
    const path = databasePath();
    const initial = open(path);
    await initial.close();
    const alias = join(path, '..', 'alias.sqlite');
    symlinkSync(path, alias);
    const server = open(alias);
    try {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
      expect(existsSync(`${alias}-lock`)).toBe(false);
      expect(existsSync(`${path}-lock`)).toBe(false);
      expect(existsSync(`${path}-shm`)).toBe(false);
    } finally { await server.close(); }
  });
});
