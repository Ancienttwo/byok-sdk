/**
 * The migrate runner's fault suite.
 *
 * A hand-written runner's bug IS a production schema incident, so the cases
 * here are the ways it can be wrong, each asserted against a real Postgres
 * rather than a mock: files applied out of order, a published file edited after
 * the fact, two runners racing, and a migration that fails halfway through.
 *
 * The racing case is why the substrate is a container. Two runners genuinely
 * contending for an advisory lock over two connections is the whole assertion;
 * an embedded engine that serializes connections would make it pass vacuously.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MigrationChecksumMismatchError,
  MigrationFilenameError,
  migrate,
  readMigrationFiles,
} from '../migrate';
import {
  createDataplaneScope,
  SKIP_DATAPLANE,
  SKIP_REASON,
  type DataplaneScope,
} from './support/dataplane';

async function migrationDirectory(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'byok-migrate-'));
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(join(directory, name), sql, 'utf8');
  }
  return directory;
}

describe('migration file discipline', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function directoryOf(files: Readonly<Record<string, string>>): Promise<string> {
    const path = await migrationDirectory(files);
    directories.push(path);
    return path;
  }

  it('orders by four-digit prefix, not by whatever readdir returns', async () => {
    // Written in reverse so insertion order and prefix order disagree.
    const directory = await directoryOf({
      '0010_ten.sql': 'SELECT 10',
      '0002_two.sql': 'SELECT 2',
      '0001_one.sql': 'SELECT 1',
    });

    const files = await readMigrationFiles(directory);
    expect(files.map((file) => file.version)).toEqual([
      '0001_one.sql',
      '0002_two.sql',
      '0010_ten.sql',
    ]);
    expect(files.map((file) => file.ordinal)).toEqual([1, 2, 10]);
  });

  it('refuses a .sql file without the four-digit prefix instead of skipping it', async () => {
    const directory = await directoryOf({
      '0001_one.sql': 'SELECT 1',
      'hotfix.sql': 'SELECT 2',
    });

    await expect(readMigrationFiles(directory)).rejects.toBeInstanceOf(MigrationFilenameError);
  });

  it('refuses a duplicated prefix, which has no defined order', async () => {
    const directory = await directoryOf({
      '0001_one.sql': 'SELECT 1',
      '0001_also_one.sql': 'SELECT 2',
    });

    await expect(readMigrationFiles(directory)).rejects.toMatchObject({
      name: 'MigrationFilenameError',
    });
  });

  it('ignores files that are not .sql at all', async () => {
    const directory = await directoryOf({
      '0001_one.sql': 'SELECT 1',
      'README.md': 'not a migration',
    });

    const files = await readMigrationFiles(directory);
    expect(files.map((file) => file.version)).toEqual(['0001_one.sql']);
  });

  it('exposes no down, rollback, or drop path', async () => {
    const runner = await import('../migrate');
    expect(Object.keys(runner).filter((name) => /down|rollback|revert|drop/i.test(name))).toEqual(
      [],
    );
  });
});

describe.skipIf(SKIP_DATAPLANE)('migrate runner against Postgres', () => {
  let scope: DataplaneScope;
  const directories: string[] = [];

  beforeEach(async () => {
    scope = await createDataplaneScope();
  });

  afterEach(async () => {
    await scope.dispose();
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function directoryOf(files: Readonly<Record<string, string>>): Promise<string> {
    const path = await migrationDirectory(files);
    directories.push(path);
    return path;
  }

  it('applies pending files in order and records each in the ledger', async () => {
    const directory = await directoryOf({
      '0001_first.sql': 'CREATE TABLE first_table (id int PRIMARY KEY);',
      '0002_second.sql': 'CREATE TABLE second_table (id int PRIMARY KEY);',
    });

    const result = await migrate(scope.pool, directory);
    expect(result.applied).toEqual(['0001_first.sql', '0002_second.sql']);
    expect(result.alreadyApplied).toEqual([]);

    const ledger = await scope.pool.query<{ version: string }>(
      'SELECT version FROM byok_schema_migration ORDER BY version',
    );
    expect(ledger.rows.map((row) => row.version)).toEqual(['0001_first.sql', '0002_second.sql']);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const directory = await directoryOf({
      '0001_first.sql': 'CREATE TABLE first_table (id int PRIMARY KEY);',
    });

    await migrate(scope.pool, directory);
    const second = await migrate(scope.pool, directory);

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(['0001_first.sql']);
  });

  it('applies only the new file when one is added later', async () => {
    const first = await directoryOf({
      '0001_first.sql': 'CREATE TABLE first_table (id int PRIMARY KEY);',
    });
    await migrate(scope.pool, first);

    const both = await directoryOf({
      '0001_first.sql': 'CREATE TABLE first_table (id int PRIMARY KEY);',
      '0002_second.sql': 'CREATE TABLE second_table (id int PRIMARY KEY);',
    });
    const result = await migrate(scope.pool, both);

    expect(result.applied).toEqual(['0002_second.sql']);
    expect(result.alreadyApplied).toEqual(['0001_first.sql']);
  });

  it('stops fail-closed when an applied file has been edited', async () => {
    const original = await directoryOf({
      '0001_first.sql': 'CREATE TABLE first_table (id int PRIMARY KEY);',
    });
    await migrate(scope.pool, original);

    // Same version, different bytes: exactly what forward-only forbids.
    const drifted = await directoryOf({
      '0001_first.sql': 'CREATE TABLE first_table (id int PRIMARY KEY, extra text);',
      '0002_second.sql': 'CREATE TABLE second_table (id int PRIMARY KEY);',
    });

    await expect(migrate(scope.pool, drifted)).rejects.toBeInstanceOf(
      MigrationChecksumMismatchError,
    );

    // Fail-closed means the run STOPPED: the later file was not applied either.
    const tables = await scope.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'second_table'",
      [scope.schema],
    );
    expect(tables.rows[0]?.count).toBe('0');
  });

  it('rolls a partially failing migration back entirely, ledger row included', async () => {
    const directory = await directoryOf({
      '0001_first.sql': 'CREATE TABLE first_table (id int PRIMARY KEY);',
      // First statement succeeds, second is invalid: the transaction has to
      // take the first one back down with it.
      '0002_broken.sql':
        'CREATE TABLE half_built (id int PRIMARY KEY);\nINSERT INTO nonexistent_table (id) VALUES (1);',
    });

    await expect(migrate(scope.pool, directory)).rejects.toThrow();

    const tables = await scope.pool.query<{ table_name: string }>(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
      [scope.schema],
    );
    const names = tables.rows.map((row) => row.table_name);
    expect(names).toContain('first_table');
    expect(names).not.toContain('half_built');

    const ledger = await scope.pool.query<{ version: string }>(
      'SELECT version FROM byok_schema_migration ORDER BY version',
    );
    expect(ledger.rows.map((row) => row.version)).toEqual(['0001_first.sql']);
  });

  it('lets a fixed migration apply on the next run after a partial failure', async () => {
    const broken = await directoryOf({
      '0001_first.sql': 'CREATE TABLE first_table (id int PRIMARY KEY);',
      '0002_broken.sql': 'INSERT INTO nonexistent_table (id) VALUES (1);',
    });
    await expect(migrate(scope.pool, broken)).rejects.toThrow();

    const fixed = await directoryOf({
      '0001_first.sql': 'CREATE TABLE first_table (id int PRIMARY KEY);',
      '0002_broken.sql': 'CREATE TABLE second_table (id int PRIMARY KEY);',
    });
    const result = await migrate(scope.pool, fixed);

    // 0002 never reached the ledger, so its checksum is not pinned yet and the
    // corrected file is simply the pending migration.
    expect(result.applied).toEqual(['0002_broken.sql']);
  });

  it('serializes two concurrent runners: each file is applied exactly once', async () => {
    const directory = await directoryOf({
      '0001_first.sql': 'CREATE TABLE first_table (id int PRIMARY KEY);',
      '0002_second.sql': 'CREATE TABLE second_table (id int PRIMARY KEY);',
    });

    // Two runners over independent connections. Without the advisory lock both
    // would read an empty ledger and both would run `CREATE TABLE`, and the
    // loser would fail with "relation already exists" instead of no-opping.
    const [left, right] = await Promise.all([
      migrate(scope.pool, directory),
      migrate(scope.pool, directory),
    ]);

    expect([...left.applied, ...right.applied].sort()).toEqual([
      '0001_first.sql',
      '0002_second.sql',
    ]);
    expect([...left.alreadyApplied, ...right.alreadyApplied].sort()).toEqual([
      '0001_first.sql',
      '0002_second.sql',
    ]);

    const ledger = await scope.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM byok_schema_migration',
    );
    expect(ledger.rows[0]?.count).toBe('2');
  });

  it('holds no lock once a run has finished, including a failed one', async () => {
    const broken = await directoryOf({
      '0001_broken.sql': 'INSERT INTO nonexistent_table (id) VALUES (1);',
    });
    await expect(migrate(scope.pool, broken)).rejects.toThrow();

    // A leaked advisory lock would make every later deploy hang forever, which
    // is a far worse failure than the migration error that caused it.
    //
    // Filtered to this scope's own backends by application_name: pg_locks is
    // server-wide, and another test file legitimately holding the same lock at
    // this instant would otherwise fail an assertion about THIS runner.
    const held = await scope.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND a.application_name = $1`,
      [scope.applicationName],
    );
    expect(held.rows[0]?.count).toBe('0');

    const fixed = await directoryOf({
      '0001_broken.sql': 'CREATE TABLE recovered (id int PRIMARY KEY);',
    });
    await expect(migrate(scope.pool, fixed)).resolves.toMatchObject({
      applied: ['0001_broken.sql'],
    });
  });
});
