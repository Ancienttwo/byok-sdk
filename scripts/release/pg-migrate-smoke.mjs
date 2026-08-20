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
import { createHash } from 'node:crypto';
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
if (!dependencies['@byok-sdk/cloud-dataplane']) {
  throw new Error('release manifest carries no @byok-sdk/cloud-dataplane tarball');
}

const baselineFixture = JSON.parse(
  readFileSync(path.join(repoRoot, 'scripts', 'release', 'fixtures', 'v0.4.2-migration-checksums.json'), 'utf8'),
);
if (baselineFixture.schemaVersion !== 1 || baselineFixture.releaseVersion !== '0.4.2') {
  throw new Error('v0.4.2 migration fixture identity is invalid');
}

// The expectation comes from the authoring directory, so adding a migration
// never needs an edit here — and a migration the build failed to project shows
// up as a missing version rather than a smaller number nobody reads.
const expected = readdirSync(path.join(repoRoot, 'deploy', 'sql'), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
  .map((entry) => entry.name)
  .sort();
if (expected.length === 0) throw new Error('no .sql files found in deploy/sql');
const baselineExpected = Object.keys(baselineFixture.migrations).sort();
if (
  baselineExpected.length === 0 ||
  baselineExpected.some((name, index) => expected[index] !== name) ||
  expected.length <= baselineExpected.length
) {
  throw new Error('A2 candidate must preserve the sorted v0.4.2 baseline and add at least one later migration');
}

function readTaggedMigration(name) {
  const tagPath = `v${baselineFixture.releaseVersion}:deploy/sql/${name}`;
  const result = spawnSync('git', ['show', tagPath], {
    cwd: repoRoot,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw new Error(`git show ${tagPath} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `git show ${tagPath} failed (${result.status}); the checkout must include tag v${baselineFixture.releaseVersion}\n` +
        (result.stderr ?? Buffer.alloc(0)).toString('utf8'),
    );
  }
  const expectedChecksum = baselineFixture.migrations[name];
  const actualChecksum = createHash('sha256').update(result.stdout).digest('hex');
  if (actualChecksum !== expectedChecksum) {
    throw new Error(`${tagPath} hashes to ${actualChecksum}, expected frozen checksum ${expectedChecksum}`);
  }
  return result.stdout;
}

const smokeDir = mkdtempSync(path.join(os.tmpdir(), 'byok-pg-migrate-smoke-'));
try {
  const smokeArtifactsDir = path.join(smokeDir, 'artifacts');
  const baselineTagDir = path.join(smokeDir, 'v0.4.2-migrations');
  mkdirSync(smokeArtifactsDir);
  mkdirSync(baselineTagDir);
  for (const entry of manifest.packages) {
    copyFileSync(path.join(artifactsDir, entry.file), path.join(smokeArtifactsDir, entry.file));
  }
  for (const name of baselineExpected) {
    writeFileSync(path.join(baselineTagDir, name), readTaggedMigration(name));
  }
  writeFileSync(
    path.join(smokeDir, 'package.json'),
    `${JSON.stringify({ name: 'byok-pg-migrate-smoke', private: true, type: 'module', dependencies }, null, 2)}\n`,
  );
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], smokeDir);

  writeFileSync(
    path.join(smokeDir, 'migrate-smoke.mjs'),
    `import assert from 'node:assert/strict';\n` +
      `import { createByokPool, migrate, migrationsDir, PostgresDeviceAssertionReplayAuthority } from '@byok-sdk/cloud-dataplane';\n` +
      `const expected = ${JSON.stringify(expected)};\n` +
      `const baseline = ${JSON.stringify(baselineExpected)};\n` +
      `const baselineChecksums = ${JSON.stringify(baselineFixture.migrations)};\n` +
      `const connectionString = process.env.DATABASE_URL;\n` +
      `const controlPool = createByokPool({ connectionString });\n` +
      `let emptyPool;\n` +
      `let upgradePool;\n` +
      `const baselineDirectory = ${JSON.stringify(baselineTagDir)};\n` +
      `async function readSeedRows(pool) {\n` +
      `  const [stream, mailbox, task, truth, entitlement, usage] = await Promise.all([\n` +
      `    pool.query("SELECT tenant_id, device_id, next_seq, acked_seq, acked_at FROM device_stream WHERE tenant_id = 'tenant-upgrade'"),\n` +
      `    pool.query("SELECT tenant_id, device_id, seq, message_id, body, body_hash, byte_size, state, appended_at FROM outbox WHERE tenant_id = 'tenant-upgrade'"),\n` +
      `    pool.query("SELECT tenant_id, task_id, device_id, owner_device_id, status, updated_at FROM task WHERE tenant_id = 'tenant-upgrade'"),\n` +
      `    pool.query("SELECT tenant_id, kind, subject_id, rev, content_hash, byte_size, body_kind, body_inline, written_at FROM attested_record WHERE tenant_id = 'tenant-upgrade'"),\n` +
      `    pool.query("SELECT tenant_id, version, hard_limit_bytes, max_object_bytes, max_inline_bytes, mailbox_limit_bytes, retention_policy_id FROM storage_entitlement WHERE tenant_id = 'tenant-upgrade'"),\n` +
      `    pool.query("SELECT tenant_id, committed_object_bytes, committed_inline_bytes, mailbox_bytes, object_count, updated_at FROM storage_usage WHERE tenant_id = 'tenant-upgrade'"),\n` +
      `  ]);\n` +
      `  return { stream: stream.rows, mailbox: mailbox.rows, task: task.rows, truth: truth.rows, entitlement: entitlement.rows, usage: usage.rows };\n` +
      `}\n` +
      `try {\n` +
      `  const directory = migrationsDir();\n` +
      `  const existing = await controlPool.query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = 'public' OR table_schema = 'byok_upgrade_v042' ORDER BY table_schema, table_name");\n` +
      `  const upgradeSchema = await controlPool.query("SELECT 1 FROM pg_namespace WHERE nspname = 'byok_upgrade_v042'");\n` +
      `  if (existing.rowCount !== 0 || upgradeSchema.rowCount !== 0) {\n` +
      `    throw new Error('DATABASE_URL must have no public tables and no byok_upgrade_v042 schema');\n` +
      `  }\n` +
      `  await controlPool.query('CREATE SCHEMA byok_upgrade_v042');\n` +
      `  emptyPool = createByokPool({ connectionString });\n` +
      `  upgradePool = createByokPool({ connectionString, max: 64, options: '-c search_path=byok_upgrade_v042' });\n` +
      `\n` +
      `  const first = await migrate(emptyPool, directory);\n` +
      `  assert.deepEqual([...first.applied], expected, 'first run must apply every shipped migration');\n` +
      `  assert.deepEqual([...first.alreadyApplied], [], 'the database was not empty');\n` +
      // A second run over the same installed directory is the checksum path as
      // much as the idempotence one: the runner re-hashes every applied file,
      // so a projection that drifted between runs would raise here.
      `  const second = await migrate(emptyPool, directory);\n` +
      `  assert.deepEqual([...second.applied], [], 'second run must be a no-op');\n` +
      `  assert.deepEqual([...second.alreadyApplied], expected, 'second run must recognise every migration');\n` +
      `  const ledger = await emptyPool.query('SELECT version FROM byok_schema_migration ORDER BY version');\n` +
      `  assert.deepEqual(ledger.rows.map((row) => row.version), expected, 'ledger must record every migration');\n` +
      `\n` +
      `  const prior = await migrate(upgradePool, baselineDirectory);\n` +
      `  assert.deepEqual([...prior.applied], baseline, 'v0.4.2 fixture must apply migrations 0001-0007 only');\n` +
      `  assert.deepEqual([...prior.alreadyApplied], []);\n` +
      `  const priorLedger = await upgradePool.query('SELECT version, checksum FROM byok_schema_migration ORDER BY version');\n` +
      `  assert.deepEqual(Object.fromEntries(priorLedger.rows.map((row) => [row.version, row.checksum])), baselineChecksums, 'v0.4.2 fixture checksums drifted');\n` +
      `\n` +
      `  await upgradePool.query("INSERT INTO device_stream (tenant_id, device_id, next_seq, acked_seq, acked_at) VALUES ('tenant-upgrade', 'device-upgrade', 3, 1, '2026-08-20T00:00:00.000Z')");\n` +
      `  await upgradePool.query("INSERT INTO outbox (tenant_id, device_id, seq, message_id, body, body_hash, byte_size, state, appended_at) VALUES ('tenant-upgrade', 'device-upgrade', 2, 'message-upgrade', '{\\\"kind\\\":\\\"fixture\\\"}', repeat('a', 64), 18, 'pending', '2026-08-20T00:01:00.000Z')");\n` +
      `  await upgradePool.query("INSERT INTO task (tenant_id, task_id, device_id, owner_device_id, status, updated_at) VALUES ('tenant-upgrade', 'task-upgrade', 'device-upgrade', 'device-upgrade', 'Running', '2026-08-20T00:02:00.000Z')");\n` +
      `  await upgradePool.query("INSERT INTO attested_record (tenant_id, kind, subject_id, rev, content_hash, byte_size, body_kind, body_inline, written_at) VALUES ('tenant-upgrade', 'profile', 'profile-upgrade', 4, repeat('b', 64), 16, 'inline', '{\\\"provider\\\":\\\"fixture\\\"}', '2026-08-20T00:03:00.000Z')");\n` +
      `  await upgradePool.query("INSERT INTO storage_entitlement (tenant_id, version, hard_limit_bytes, max_object_bytes, max_inline_bytes, mailbox_limit_bytes, retention_policy_id) VALUES ('tenant-upgrade', 3, 1048576, 524288, 65536, 262144, 'retention-upgrade')");\n` +
      `  await upgradePool.query("INSERT INTO storage_usage (tenant_id, committed_object_bytes, committed_inline_bytes, mailbox_bytes, object_count, updated_at) VALUES ('tenant-upgrade', 1024, 128, 18, 2, '2026-08-20T00:04:00.000Z')");\n` +
      `  const before = await readSeedRows(upgradePool);\n` +
      `\n` +
      `  const upgraded = await migrate(upgradePool, directory);\n` +
      `  assert.deepEqual([...upgraded.applied], expected.slice(baseline.length), 'candidate must apply only migrations newer than v0.4.2');\n` +
      `  assert.deepEqual([...upgraded.alreadyApplied], baseline, 'candidate must retain the v0.4.2 ledger');\n` +
      `  assert.deepEqual(await readSeedRows(upgradePool), before, 'candidate migration changed existing stream/mailbox/task/truth/quota rows');\n` +
      `  const replayTable = await upgradePool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'byok_upgrade_v042' AND tablename = 'device_assertion_replay' ORDER BY indexname");\n` +
      `  assert.deepEqual(replayTable.rows.map((row) => row.indexname), ['device_assertion_replay_expiry_idx', 'device_assertion_replay_pkey']);\n` +
      `  const replay = new PostgresDeviceAssertionReplayAuthority(upgradePool);\n` +
      `  const replayInput = { tenantId: 'tenant-upgrade', issuer: 'https://api.example.com', productId: 'product-upgrade', deviceId: 'device-upgrade', audience: 'connector-binding', jti: 'AAAAAAAAAAAAAAAAAAAAAA', expiresAt: '2099-01-01T00:00:00.000Z' };\n` +
      `  const replayResults = await Promise.all(Array.from({ length: 64 }, () => replay.consume(replayInput)));\n` +
      `  assert.equal(replayResults.filter(Boolean).length, 1, 'exactly one concurrent installed-package replay consume must win');\n` +
      `  assert.equal(await replay.consume(replayInput), false, 'the consumed replay key must remain rejected');\n` +
      `  const final = await migrate(upgradePool, directory);\n` +
      `  assert.deepEqual([...final.applied], []);\n` +
      `  assert.deepEqual([...final.alreadyApplied], expected);\n` +
      `  console.log('[pg-migrate-smoke] default-schema empty install applied ' + expected.length + ' migration(s); tag-bound v0.4.2 fixture preserved stream/mailbox/task/truth/quota rows, applied ' + upgraded.applied.join(', ') + ', and admitted exactly one of 64 concurrent replay consumes');\n` +
      `} finally {\n` +
      `  await Promise.allSettled([emptyPool?.end(), upgradePool?.end(), controlPool.end()]);\n` +
      `}\n`,
  );
  console.log(run(nodeBin, ['migrate-smoke.mjs'], smokeDir, { ...process.env, DATABASE_URL: databaseUrl }));
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}
