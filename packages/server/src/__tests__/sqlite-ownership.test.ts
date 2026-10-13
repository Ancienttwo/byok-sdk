import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createByokServer, SqliteOwnershipError, SqliteSchemaError } from '../index';
import { isSqliteAvailable } from '../sqlite-support';

/**
 * Issue #388 item 2: one SQLite file, one owning server process. The owner is
 * an OS lock the kernel releases on any exit, so the stale-owner cases are
 * exercised with a real second process that dies by `exit` and by SIGKILL.
 */

const describeSqlite = isSqliteAvailable() ? describe : describe.skip;
const SQLITE_SUPPORT = fileURLToPath(new URL('../sqlite-support.ts', import.meta.url));

/**
 * A separate Node process that takes ownership of `path` through the same
 * `acquireSqliteOwnership` the SQLite composition takes it with, reports it on
 * stdout, then waits. Node strips the module's types natively.
 */
async function ownInChild(path: string, then: 'hold' | 'exit-without-release'): Promise<ChildProcess> {
  const script = `
    const { acquireSqliteOwnership } = await import(${JSON.stringify(SQLITE_SUPPORT)});
    // Held in a global: an unreachable lock handle may be finalized and closed by GC.
    globalThis.ownership = acquireSqliteOwnership(${JSON.stringify(path)});
    process.stdout.write('owned\\n');
    ${then === 'hold' ? 'setInterval(() => {}, 1_000);' : "process.stdin.once('data', () => process.exit(0));"}
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

describeSqlite('SQLite single-process ownership', () => {
  const roots: string[] = [];
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
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

    // The owner keeps working, and read-only inspection of the file is never blocked.
    expect(await first.stats()).toMatchObject({ connectedDeviceCount: 0 });
    const inspect = new DatabaseSync(path, { readOnly: true });
    expect(inspect.prepare('SELECT COUNT(*) AS n FROM task_attempt').get()).toEqual({ n: 0 });
    inspect.close();

    await first.close();
    const second = open(path);
    await second.close();
  });

  it('refuses an open while another process owns the file', async () => {
    const path = databasePath();
    const owner = await ownInChild(path, 'hold');
    children.push(owner);
    expect(() => open(path)).toThrow(SqliteOwnershipError);
  });

  it('lets the next process open after the owner is SIGKILLed', async () => {
    const path = databasePath();
    const owner = await ownInChild(path, 'hold');
    children.push(owner);
    expect(() => open(path)).toThrow(SqliteOwnershipError);

    owner.kill('SIGKILL');
    const [, signal] = await once(owner, 'exit');
    expect(signal).toBe('SIGKILL');

    const next = open(path);
    await next.close();
  });

  it('lets the next process open after the owner exits without releasing', async () => {
    const path = databasePath();
    const owner = await ownInChild(path, 'exit-without-release');
    children.push(owner);
    expect(() => open(path)).toThrow(SqliteOwnershipError);

    owner.stdin!.write('go\n');
    const [code] = await once(owner, 'exit');
    expect(code).toBe(0);

    const next = open(path);
    await next.close();
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

  it('leaves the lock sibling at owner-only permissions', async () => {
    const path = databasePath();
    writeFileSync(`${path}-lock`, '', { mode: 0o644 });
    const server = open(path);
    try {
      expect(statSync(`${path}-lock`).mode & 0o777).toBe(0o600);
    } finally {
      await server.close();
    }
  });
});
