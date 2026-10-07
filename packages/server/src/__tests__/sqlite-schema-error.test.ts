import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMutableClock } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { createByokServer, SqliteSchemaUnsupportedError } from '../index';
import { isSqliteAvailable } from '../sqlite-support';
import { createSqliteEmbeddedStores } from '../stores/sqlite';

const describeSqlite = isSqliteAvailable() ? describe : describe.skip;

describeSqlite('SQLite schema rejection diagnostics', () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function databasePath(): string {
    const root = mkdtempSync(join(tmpdir(), 'byok-schema-error-'));
    roots.push(root);
    return join(root, 'server.sqlite');
  }

  function inspect<T>(path: string, operation: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(path);
    try { return operation(db); }
    finally { db.close(); }
  }

  function captureError(operation: () => unknown): unknown {
    try { operation(); }
    catch (error) { return error; }
    throw new Error('Expected construction to fail');
  }

  function open(path: string, migration?: 'v3-to-v4' | 'v2-to-v4') {
    return createByokServer({
      productId: 'schema-error-fixture',
      storage: { kind: 'sqlite', path, ...(migration === undefined ? {} : { migration }) },
    });
  }

  async function seedCurrent(path: string): Promise<void> {
    const stores = createSqliteEmbeddedStores({ path }, {
      clock: createMutableClock(), crypto: createWebCrypto(),
    });
    await stores.close();
  }

  it.each(['3', '999', '', undefined])(
    'reports the original stored version %s and closes the rejected handle without migrating',
    (storedVersion) => {
      const path = databasePath();
      inspect(path, (db) => {
        db.exec('CREATE TABLE byok_sqlite_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        if (storedVersion !== undefined) {
          db.prepare("INSERT INTO byok_sqlite_meta (key, value) VALUES ('schema_version', ?)")
            .run(storedVersion);
        }
      });
      const close = vi.spyOn(DatabaseSync.prototype, 'close');
      const error = captureError(() => open(path));
      expect(error).toBeInstanceOf(SqliteSchemaUnsupportedError);
      expect(error).toMatchObject({
        name: 'SqliteSchemaUnsupportedError', code: 'SQLITE_SCHEMA_UNSUPPORTED',
        storedVersion, requiredVersion: '4',
      });
      expect((error as Error).message).toContain('Stop all writers, back up the database');
      expect(close).toHaveBeenCalledTimes(1);
      expect(() => (close.mock.contexts[0] as DatabaseSync).prepare('SELECT 1')).toThrow();
      close.mockRestore();
      inspect(path, (db) => {
        expect(db.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()?.value)
          .toBe(storedVersion);
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all())
          .toMatchObject([{ name: 'byok_sqlite_meta' }]);
        // Rejection returned ownership and rolled back its transaction.
        db.exec('BEGIN IMMEDIATE; ROLLBACK');
      });
    },
  );

  it('opens a current schema normally', async () => {
    const path = databasePath();
    await seedCurrent(path);
    await open(path).close();
    inspect(path, (db) => {
      expect(db.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()?.value)
        .toBe('4');
    });
  });

  it('keeps v3 adoption explicit and refuses a mismatched migration selector', async () => {
    const path = databasePath();
    await seedCurrent(path);
    inspect(path, (db) => db.exec("ALTER TABLE task_attempt DROP COLUMN claimed_harness_id; UPDATE byok_sqlite_meta SET value = '3' WHERE key = 'schema_version'"));
    for (const migration of [undefined, 'v2-to-v4'] as const) {
      expect(captureError(() => open(path, migration))).toMatchObject({
        code: 'SQLITE_SCHEMA_UNSUPPORTED', storedVersion: '3', requiredVersion: '4',
      });
      inspect(path, (db) => {
        expect(db.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()?.value)
          .toBe('3');
        expect(db.prepare('PRAGMA table_info(task_attempt)').all().map(column => column.name))
          .not.toContain('claimed_harness_id');
      });
    }
    await open(path, 'v3-to-v4').close();
    await open(path).close();
  });

  it('preserves a migration failure and rolls back instead of classifying it as unsupported', async () => {
    const path = databasePath();
    await seedCurrent(path);
    inspect(path, (db) => db.exec("ALTER TABLE task_attempt DROP COLUMN claimed_harness_id; UPDATE byok_sqlite_meta SET value = '3' WHERE key = 'schema_version'; CREATE TRIGGER fail_version BEFORE UPDATE ON byok_sqlite_meta BEGIN SELECT RAISE(ABORT, 'injected version failure'); END"));
    const close = vi.spyOn(DatabaseSync.prototype, 'close');
    const error = captureError(() => open(path, 'v3-to-v4'));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SqliteSchemaUnsupportedError);
    expect((error as Error).message).toContain('injected version failure');
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => (close.mock.contexts[0] as DatabaseSync).prepare('SELECT 1')).toThrow();
    close.mockRestore();
    inspect(path, (db) => {
      expect(db.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()?.value)
        .toBe('3');
      expect(db.prepare('PRAGMA table_info(task_attempt)').all().map(column => column.name))
        .not.toContain('claimed_harness_id');
      db.exec('DROP TRIGGER fail_version');
    });
    await open(path, 'v3-to-v4').close();
  });

  it('preserves malformed-current-schema errors and closes the failed handle', async () => {
    const path = databasePath();
    await seedCurrent(path);
    inspect(path, (db) => db.exec('DROP TABLE task_attempt'));
    const close = vi.spyOn(DatabaseSync.prototype, 'close');
    const error = captureError(() => open(path));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SqliteSchemaUnsupportedError);
    expect((error as Error).message).toContain('task_attempt');
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => (close.mock.contexts[0] as DatabaseSync).prepare('SELECT 1')).toThrow();
  });

  it('preserves an invalid-database error and closes the failed handle', () => {
    const path = databasePath();
    writeFileSync(path, 'disposable non-SQLite fixture');
    const close = vi.spyOn(DatabaseSync.prototype, 'close');
    const error = captureError(() => open(path));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SqliteSchemaUnsupportedError);
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => (close.mock.contexts[0] as DatabaseSync).prepare('SELECT 1')).toThrow();
  });
});
