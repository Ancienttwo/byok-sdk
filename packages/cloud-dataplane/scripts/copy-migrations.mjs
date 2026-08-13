/**
 * Projects the repository's migration files into the published package.
 *
 * `deploy/sql/` is the ONLY place a migration is authored — the deploy script,
 * every real-Postgres test, and `check-deploy-sql-order` all read it from the
 * repository root, so moving it into this package would create three cutovers
 * and no new truth. But a tarball that exports `migrate(pool, directory)` and
 * ships none of the files that runner applies is a published package with a
 * hole in it, which is what every host vendoring these four files by hand was
 * working around.
 *
 * So `dist/sql/` is a build artifact, never an authoring path: cleared and
 * re-copied on every build, so a deleted migration cannot linger in a package
 * as a file nothing upstream still has. Drift between the two is caught by the
 * release smoke's bidirectional SHA-256 comparison
 * (`scripts/release/pack-and-smoke.mjs`), not by trust.
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDir = fileURLToPath(new URL('../../../deploy/sql', import.meta.url));
const targetDir = fileURLToPath(new URL('../dist/sql', import.meta.url));

const migrations = readdirSync(sourceDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
  .map((entry) => entry.name)
  .sort();

if (migrations.length === 0) {
  throw new Error(`no .sql migrations found in ${sourceDir}`);
}

// Clean-then-copy, in that order: an incremental copy would leave a removed
// migration in the package forever.
rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
for (const name of migrations) {
  copyFileSync(path.join(sourceDir, name), path.join(targetDir, name));
}

console.log(`[cloud-dataplane] projected ${migrations.length} migration(s) from deploy/sql into dist/sql`);
