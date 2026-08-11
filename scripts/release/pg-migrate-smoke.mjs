/**
 * Tier 2 of the release-asset guarantee: the SQL a published tarball carries
 * actually migrates an empty database.
 *
 * `pack-and-smoke.mjs` is the release hard gate and stays free of external
 * services — it proves the bytes are in the tarball and that `migrationsDir()`
 * finds them from an isolated install. That leaves one question it deliberately
 * cannot answer: whether those files, applied by the runner that shipped beside
 * them, produce a schema against a real Postgres. This script answers it, which
 * is why it lives in CI (a service container) rather than in the gate.
 *
 * It installs the EXACT tarballs `pack-and-smoke.mjs` produced — reading them
 * from the release manifest, not repacking — so what CI migrates from is what a
 * consumer would install. No source directory is ever passed to the runner: the
 * whole point is that an installed copy knows where its own migrations are.
 *
 *   node scripts/release/pg-migrate-smoke.mjs --artifacts <dir>
 *
 * `DATABASE_URL` must point at an EMPTY database: the first run asserts that
 * every migration was applied, which a pre-migrated database would fail.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const nodeBin = process.execPath;

const artifactsArgIndex = process.argv.indexOf('--artifacts');
const requestedArtifacts = artifactsArgIndex >= 0 ? process.argv[artifactsArgIndex + 1] : undefined;
if (!requestedArtifacts || requestedArtifacts.startsWith('--')) {
  throw new Error('--artifacts requires the directory pack-and-smoke.mjs wrote its tarballs to');
}
const artifactsDir = path.resolve(repoRoot, requestedArtifacts);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL must point at an empty Postgres database');
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

const manifest = JSON.parse(readFileSync(path.join(artifactsDir, 'release-manifest.json'), 'utf8'));
const dependencies = Object.fromEntries(
  manifest.packages.map((entry) => [entry.package, `file:./artifacts/${entry.file}`]),
);
if (!dependencies['@byok-sdk/cloud-postgres']) {
  throw new Error('release manifest carries no @byok-sdk/cloud-postgres tarball');
}

// The expectation comes from the authoring directory, so adding a migration
// never needs an edit here — and a migration the build failed to project shows
// up as a missing version rather than a smaller number nobody reads.
const expected = readdirSync(path.join(repoRoot, 'deploy', 'sql'), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
  .map((entry) => entry.name)
  .sort();
if (expected.length === 0) throw new Error('no .sql files found in deploy/sql');

const smokeDir = mkdtempSync(path.join(os.tmpdir(), 'byok-pg-migrate-smoke-'));
try {
  const smokeArtifactsDir = path.join(smokeDir, 'artifacts');
  mkdirSync(smokeArtifactsDir);
  for (const entry of manifest.packages) {
    copyFileSync(path.join(artifactsDir, entry.file), path.join(smokeArtifactsDir, entry.file));
  }
  writeFileSync(
    path.join(smokeDir, 'package.json'),
    `${JSON.stringify({ name: 'byok-pg-migrate-smoke', private: true, type: 'module', dependencies }, null, 2)}\n`,
  );
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], smokeDir);

  writeFileSync(
    path.join(smokeDir, 'migrate-smoke.mjs'),
    `import assert from 'node:assert/strict';\n` +
      `import { createByokPool, migrate, migrationsDir } from '@byok-sdk/cloud-postgres';\n` +
      `const expected = ${JSON.stringify(expected)};\n` +
      `const pool = createByokPool({ connectionString: process.env.DATABASE_URL });\n` +
      `try {\n` +
      `  const directory = migrationsDir();\n` +
      `  const first = await migrate(pool, directory);\n` +
      `  assert.deepEqual([...first.applied], expected, 'first run must apply every shipped migration');\n` +
      `  assert.deepEqual([...first.alreadyApplied], [], 'the database was not empty');\n` +
      // A second run over the same installed directory is the checksum path as
      // much as the idempotence one: the runner re-hashes every applied file,
      // so a projection that drifted between runs would raise here.
      `  const second = await migrate(pool, directory);\n` +
      `  assert.deepEqual([...second.applied], [], 'second run must be a no-op');\n` +
      `  assert.deepEqual([...second.alreadyApplied], expected, 'second run must recognise every migration');\n` +
      `  const ledger = await pool.query('SELECT version FROM byok_schema_migration ORDER BY version');\n` +
      `  assert.deepEqual(ledger.rows.map((row) => row.version), expected, 'ledger must record every migration');\n` +
      `  console.log('[pg-migrate-smoke] migrated ' + expected.length + ' file(s) from ' + directory + ', re-run was a no-op');\n` +
      `} finally {\n` +
      `  await pool.end();\n` +
      `}\n`,
  );
  console.log(run(nodeBin, ['migrate-smoke.mjs'], smokeDir, { ...process.env, DATABASE_URL: databaseUrl }));
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}
