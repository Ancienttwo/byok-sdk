/**
 * The migrate runner's fault suite.
 *
 * A hand-written runner's bug IS a production schema incident, so the runner
 * cases here are asserted against a real Postgres: files applied out of order,
 * a published file edited after the fact, two runners racing, and a migration
 * that fails halfway through. The package-owned readback guard uses a narrow
 * query-only ledger double so every mismatch class runs without a substrate.
 *
 * The racing case is why the substrate is a container. Two runners genuinely
 * contending for an advisory lock over two connections is the whole assertion;
 * an embedded engine that serializes connections would make it pass vacuously.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MigrationChecksumMismatchError,
  MigrationFilenameError,
  MigrationStateMismatchError,
  migrate,
  readMigrationFiles,
  verifyMigrations,
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

interface LedgerRow {
  readonly version: string;
  readonly checksum: string;
}

interface VerificationPoolState {
  readonly rows?: readonly LedgerRow[];
  readonly error?: unknown;
  readonly queries: string[];
}

/** A query-only pool for the package-owned ledger readback guard. */
function verificationPool(state: VerificationPoolState): Pool {
  const client = {
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      state.queries.push(sql);
      if (sql !== 'SELECT version, checksum FROM byok_schema_migration') {
        throw new Error(`unexpected verification query: ${sql}`);
      }
      if (state.error !== undefined) throw state.error;
      return { rows: [...(state.rows ?? [])] as T[] };
    },
    release(): void {},
  };
  return { connect: async () => client } as unknown as Pool;
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

describe('package-owned migration verification', () => {
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

  it('returns exact package rows ordered by migration version', async () => {
    const directory = await directoryOf({
      '0002_second.sql': 'SELECT 2',
      '0001_first.sql': 'SELECT 1',
    });
    const files = await readMigrationFiles(directory);
    const pool = verificationPool({
      rows: [
        { version: files[1]!.version, checksum: files[1]!.checksum },
        { version: files[0]!.version, checksum: files[0]!.checksum },
      ],
      queries: [],
    });

    await expect(verifyMigrations(pool, directory)).resolves.toEqual(
      files.map(({ version, checksum }) => ({ version, checksum })),
    );
  });

  it('defaults to the migration projection shipped beside the built root entry', async () => {
    const built = (await import(new URL('../../dist/index.js', import.meta.url).href)) as {
      migrationsDir(): string;
      verifyMigrations(pool: Pool): Promise<readonly LedgerRow[]>;
    };
    const files = await readMigrationFiles(built.migrationsDir());
    const pool = verificationPool({
      rows: files.map(({ version, checksum }) => ({ version, checksum })),
      queries: [],
    });

    await expect(built.verifyMigrations(pool)).resolves.toEqual(
      files.map(({ version, checksum }) => ({ version, checksum })),
    );
  });

  it('aggregates missing, unexpected, and checksum issues in stable order', async () => {
    const directory = await directoryOf({
      '0003_third.sql': 'SELECT 3',
      '0001_first.sql': 'SELECT 1',
    });
    const files = await readMigrationFiles(directory);
    const pool = verificationPool({
      rows: [
        { version: '0004_unexpected.sql', checksum: 'unexpected-checksum-4' },
        { version: '0002_unexpected.sql', checksum: 'unexpected-checksum-2' },
        { version: files[0]!.version, checksum: 'changed-checksum' },
      ],
      queries: [],
    });

    const error = await verifyMigrations(pool, directory).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationStateMismatchError);
    expect((error as MigrationStateMismatchError).issues).toEqual([
      {
        kind: 'checksum_mismatch',
        version: files[0]!.version,
        expectedChecksum: files[0]!.checksum,
        actualChecksum: 'changed-checksum',
      },
      {
        kind: 'missing',
        version: files[1]!.version,
        expectedChecksum: files[1]!.checksum,
      },
      {
        kind: 'unexpected',
        version: '0002_unexpected.sql',
        actualChecksum: 'unexpected-checksum-2',
      },
      {
        kind: 'unexpected',
        version: '0004_unexpected.sql',
        actualChecksum: 'unexpected-checksum-4',
      },
    ]);
  });

  it('reports a missing ledger table without bootstrapping it', async () => {
    const directory = await directoryOf({ '0001_first.sql': 'SELECT 1' });
    const state: VerificationPoolState = {
      error: Object.assign(new Error('relation "byok_schema_migration" does not exist'), {
        code: '42P01',
      }),
      queries: [],
    };

    const error = await verifyMigrations(verificationPool(state), directory).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MigrationStateMismatchError);
    expect((error as MigrationStateMismatchError).issues).toEqual([
      { kind: 'ledger_missing', table: 'byok_schema_migration' },
    ]);
    expect(state.queries).toEqual(['SELECT version, checksum FROM byok_schema_migration']);
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
