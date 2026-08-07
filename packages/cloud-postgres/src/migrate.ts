/**
 * The forward-only migration runner.
 *
 * Six rules, and each one exists because the alternative is a schema incident
 * (docs/researches/s4a-dataplane-design.md §2):
 *
 * 1. **Ordering comes from filenames.** `deploy/sql/NNNN_*.sql`, sorted by the
 *    four-digit prefix — the same constraint `check-deploy-sql-order` already
 *    enforces in CI. Two ordering authorities cannot coexist, which is the
 *    whole reason this is a hand-written runner instead of a migration
 *    framework with its own directory convention.
 * 2. **One runner at a time**, via a session-level `pg_advisory_lock` held on a
 *    single checked-out client for the entire run. Two deploy jobs starting
 *    together is normal; two of them applying the same file is not.
 * 3. **The ledger bootstraps itself.** `byok_schema_migration` is the ONLY DDL
 *    outside `deploy/sql/`. Putting it in `0001` would force the runner to
 *    special-case "the ledger does not exist yet" before it can read the
 *    ledger — two sources of truth for one table.
 * 4. **One transaction per file**, covering the file's statements AND its
 *    ledger row. A crash leaves a migration entirely applied or entirely
 *    absent, never applied-but-unrecorded (which the next run would replay).
 * 5. **Checksums are verified, not recorded and forgotten.** An already-applied
 *    file whose sha256 no longer matches the ledger raises
 *    {@link MigrationChecksumMismatchError} and the run STOPS. "Forward-only"
 *    means published files are immutable; without this check that is a slogan.
 * 6. **There is no down path.** Not "unimplemented" — absent. Rollback is
 *    "revert the application, leave the tables" (sprint S4A.6), and a
 *    destructive path that exists is a destructive path that eventually runs.
 *
 * Known boundary of rule 4: a statement that cannot run inside a transaction
 * (`CREATE INDEX CONCURRENTLY`, and `ALTER TYPE ... ADD VALUE` on older
 * servers) cannot appear in a migration file. That is a deliberate trade —
 * per-file atomicity is worth more here than building an index without a lock,
 * and the day it is not, it needs its own reviewed mechanism rather than a
 * quiet exception.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';

/**
 * An arbitrary but permanently fixed advisory-lock key. Its only requirement is
 * that every runner in every process picks the same one; changing it would let
 * an old and a new deployment migrate concurrently exactly once.
 */
const MIGRATION_ADVISORY_LOCK_KEY = '4021960801';

/** `NNNN_name.sql` — the same shape `scripts/check-deploy-sql-order.sh` enforces. */
const MIGRATION_FILENAME_PATTERN = /^(\d{4})[_-].+\.sql$/;

/**
 * The migration ledger, and the sole DDL statement in this package: every other
 * table a deployment owns is created by a file under `deploy/sql/`.
 */
const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS byok_schema_migration (
  version     text        PRIMARY KEY,
  checksum    text        NOT NULL,
  applied_at  timestamptz NOT NULL
)`;

/** One file on disk, already ordered and checksummed. */
export interface MigrationFile {
  /** The filename, e.g. `0001_cloud_local.sql`. This is the ledger's `version`. */
  readonly version: string;
  /** The four-digit prefix as a number, used for ordering only. */
  readonly ordinal: number;
  readonly checksum: string;
  readonly sql: string;
}

/** What a run did. `applied` is empty when the database was already up to date. */
export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

/**
 * A published migration file changed after it was applied.
 *
 * Fail-closed by design: the runner cannot know whether the edit was a harmless
 * comment or a dropped column, and a deployment that guesses wrong corrupts a
 * schema. The fix is a NEW migration file, never an edit to an old one.
 */
export class MigrationChecksumMismatchError extends Error {
  readonly version: string;
  readonly expectedChecksum: string;
  readonly actualChecksum: string;

  constructor(version: string, expectedChecksum: string, actualChecksum: string) {
    super(
      `Migration ${version} was already applied with checksum ${expectedChecksum}, but the file on disk hashes to ${actualChecksum}. ` +
        'Published migrations are immutable: add a new file instead of editing this one.',
    );
    this.name = 'MigrationChecksumMismatchError';
    this.version = version;
    this.expectedChecksum = expectedChecksum;
    this.actualChecksum = actualChecksum;
  }
}

/** A file in the migration directory that the naming contract does not admit. */
export class MigrationFilenameError extends Error {
  readonly filename: string;

  constructor(filename: string, reason: string) {
    super(`Migration file ${filename} is not usable: ${reason}`);
    this.name = 'MigrationFilenameError';
    this.filename = filename;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Reads and orders the migration files in `directory`.
 *
 * Ordering is by the four-digit prefix, not by whatever order the filesystem
 * hands back — `readdir` makes no promise, and on some filesystems it is
 * effectively insertion order. A non-conforming filename or a duplicated prefix
 * is an error rather than a skip: silently ignoring a `.sql` file someone
 * dropped in this directory is how a migration goes missing.
 */
export async function readMigrationFiles(directory: string): Promise<readonly MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: MigrationFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;
    const match = MIGRATION_FILENAME_PATTERN.exec(entry.name);
    if (match === null) {
      throw new MigrationFilenameError(
        entry.name,
        'expected a four-digit prefix, e.g. 0001_cloud_local.sql',
      );
    }
    const sql = await readFile(join(directory, entry.name), 'utf8');
    files.push({
      version: entry.name,
      ordinal: Number.parseInt(match[1]!, 10),
      checksum: sha256(sql),
      sql,
    });
  }

  files.sort((left, right) => left.ordinal - right.ordinal);

  for (let index = 1; index < files.length; index += 1) {
    const previous = files[index - 1]!;
    const current = files[index]!;
    if (previous.ordinal === current.ordinal) {
      throw new MigrationFilenameError(
        current.version,
        `duplicate prefix ${String(current.ordinal).padStart(4, '0')}, already used by ${previous.version}`,
      );
    }
  }

  return files;
}

async function readLedger(client: PoolClient): Promise<Map<string, string>> {
  const result = await client.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM byok_schema_migration',
  );
  return new Map(result.rows.map((row) => [row.version, row.checksum]));
}

/**
 * Applies every pending migration in `directory`, in prefix order.
 *
 * @param pool The pool to migrate. One client is checked out for the whole run
 *   because the advisory lock is session-scoped.
 * @param directory Absolute path to the migration directory (this repo's
 *   `deploy/sql/`). Required rather than defaulted: a published package cannot
 *   guess where its consumer keeps deployment assets, and guessing wrong would
 *   mean silently migrating nothing.
 */
export async function migrate(pool: Pool, directory: string): Promise<MigrationResult> {
  // Read the files BEFORE taking the lock: a filename error is a mistake in the
  // repository, and there is no reason to make a second runner queue behind it.
  const files = await readMigrationFiles(directory);

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    try {
      await client.query(LEDGER_DDL);
      const ledger = await readLedger(client);

      const applied: string[] = [];
      const alreadyApplied: string[] = [];

      for (const file of files) {
        const recordedChecksum = ledger.get(file.version);
        if (recordedChecksum !== undefined) {
          if (recordedChecksum !== file.checksum) {
            throw new MigrationChecksumMismatchError(file.version, recordedChecksum, file.checksum);
          }
          alreadyApplied.push(file.version);
          continue;
        }

        // One transaction: the file's statements and its ledger row land or
        // vanish together. A multi-statement string goes over the simple
        // protocol, which runs inside the transaction opened here.
        await client.query('BEGIN');
        try {
          await client.query(file.sql);
          await client.query(
            'INSERT INTO byok_schema_migration (version, checksum, applied_at) VALUES ($1, $2, now())',
            [file.version, file.checksum],
          );
          await client.query('COMMIT');
        } catch (error) {
          // The rollback is best-effort on purpose. When the failure was a lost
          // connection, `ROLLBACK` rejects too — and an unguarded await here
          // would replace the migration error with a transport error, hiding
          // the one fact an operator needs: which file failed and why. The
          // server discards an abandoned transaction on disconnect anyway, so
          // swallowing this rejection loses nothing and rethrowing the original
          // keeps the diagnosis intact.
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
        applied.push(file.version);
      }

      return { applied, alreadyApplied };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
