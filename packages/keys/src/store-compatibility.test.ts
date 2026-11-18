import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSqliteFileUnchanged } from '@byok-sdk/core/sqlite-node';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore, listProviderProfileSecretNames } from './index';
import { LATEST_PROVIDER_SECRET_RECOVERY_SCHEMA, providerSecretRecoverySignature } from './provider-secret-recovery';
import { inspectProviderProfileStore } from './store-compatibility';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { isSqliteAvailable, loadSqliteModule } from './sqlite-support';

/** #1102: the provider profile store precheck, over checked-in stores written by released builds. */

const describeSqlite = (isSqliteAvailable() || process.env.BYOK_REQUIRE_SQLITE === '1') ? describe : describe.skip;
const FIXTURES = fileURLToPath(new URL('../../../scripts/release/fixtures/stores/', import.meta.url));
const MANIFEST = fileURLToPath(new URL('../../client/upgrade-manifest.json', import.meta.url));

interface FixtureIndex {
  readonly fixtures: Record<string, { readonly stores: Record<string, string>; readonly expected?: Record<string, string> }>;
}
interface UpgradeManifest {
  readonly from: { readonly version: string };
  readonly entries: readonly { readonly acceptance?: string; readonly items: readonly string[] }[];
}

const index = JSON.parse(readFileSync(join(FIXTURES, 'index.json'), 'utf8')) as FixtureIndex;
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as UpgradeManifest;
const ACCEPTANCE_VERDICT: Record<string, string> = { accept: 'accepted', migrate: 'migration-required', 'new-path-repair': 'new-path-repair', reject: 'rejected' };

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'byok-keys-store-check-'));
  scratch.push(directory);
  return directory;
}

function fixtureCopy(label: string): string {
  const relative = index.fixtures[label]?.stores['keys-profile-store'];
  if (relative === undefined) throw new Error(`fixture ${label} has no keys-profile-store store`);
  const file = join(tempDir(), 'profiles.db');
  copyFileSync(join(FIXTURES, relative), file);
  return file;
}

function directoryState(directory: string): Record<string, string> {
  return Object.fromEntries(readdirSync(directory).sort().map((name) => {
    const file = join(directory, name);
    const { mtimeNs, mode } = statSync(file, { bigint: true });
    return [name, `${createHash('sha256').update(readFileSync(file)).digest('hex')} ${mtimeNs} ${mode}`];
  }));
}

describeSqlite('inspectProviderProfileStore', () => {
  it('has an authored verdict for every fixture', () => {
    for (const [label, fixture] of Object.entries(index.fixtures)) {
      expect(fixture.expected?.['keys-profile-store'], `scripts/release/fixtures/stores/index.json: ${label}.expected`).toBeDefined();
    }
  });

  for (const [label, fixture] of Object.entries(index.fixtures)) {
    it(`gives the ${label} fixture its expected verdict and reads it without changing it`, async () => {
      const file = fixtureCopy(label);
      const before = directoryState(dirname(file));
      const result = await inspectProviderProfileStore(file);
      expect(result.store).toBe('keys-profile-store');
      expect(result.verdict).toBe(fixture.expected?.['keys-profile-store']);
      expect(await listProviderProfileSecretNames(file)).toEqual([]);
      expect(directoryState(dirname(file))).toEqual(before);
    });
  }

  it('agrees with the upgrade manifest on a store the baseline release wrote', async () => {
    const baseline = manifest.from.version;
    expect(index.fixtures[baseline], `generate the ${baseline} store fixture`).toBeDefined();
    const entry = manifest.entries.find((candidate) => candidate.items.includes('store:keys-profile-store'));
    const allowed = entry === undefined ? ['accepted'] : ['accepted', ACCEPTANCE_VERDICT[entry.acceptance ?? '']];
    expect(allowed).toContain((await inspectProviderProfileStore(fixtureCopy(baseline))).verdict);
  });

  it('reports a missing file as absent', async () => {
    expect(await inspectProviderProfileStore(join(tempDir(), 'missing.db'))).toMatchObject({ store: 'keys-profile-store', verdict: 'absent' });
  });

  it('reports a store created by a different schema as new-path-repair', async () => {
    const file = join(tempDir(), 'stale.db');
    const { DatabaseSync } = loadSqliteModule();
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE provider_profile (profile_ref TEXT PRIMARY KEY, provider_kind TEXT NOT NULL CHECK (provider_kind IN ('openai')));");
    database.close();
    expect(await inspectProviderProfileStore(file)).toMatchObject({ verdict: 'new-path-repair', code: 'PROVIDER_STORE_SCHEMA_STALE' });
  });

  it('refuses a store with an earlier provider_kind CHECK set and leaves it unchanged', async () => {
    const directory = tempDir();
    const file = join(directory, 'profiles.db');
    await new SqliteProviderProfileStore({ path: file }).close();
    const { DatabaseSync } = loadSqliteModule();
    const database = new DatabaseSync(file);
    const { sql } = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'provider_profile'").get() as { sql: string };
    const earlier = sql.replace("'groq', ", '');
    expect(earlier).not.toBe(sql);
    database.exec(`DROP INDEX provider_profile_one_enabled; DROP TABLE provider_profile; ${earlier};`);
    database.exec('CREATE UNIQUE INDEX provider_profile_one_enabled ON provider_profile(kind) WHERE enabled = 1;');
    database.close();
    const before = directoryState(directory);
    expect(await inspectProviderProfileStore(file)).toMatchObject({ verdict: 'new-path-repair', code: 'PROVIDER_STORE_SCHEMA_STALE' });
    expect(directoryState(directory)).toEqual(before);
  });

  it('rejects a damaged file', async () => {
    const file = join(tempDir(), 'damaged.db');
    writeFileSync(file, 'not a sqlite database, only text that is long enough to have a header'.repeat(10));
    expect(await inspectProviderProfileStore(file)).toMatchObject({ verdict: 'rejected' });
  });

  it('leaves every file of the store unchanged, and creates nothing next to it', async () => {
    const directory = tempDir();
    const file = join(directory, 'profiles.db');
    await new SqliteProviderProfileStore({ path: file }).close();
    const before = directoryState(directory);
    expect(await inspectProviderProfileStore(file)).toMatchObject({ verdict: 'accepted' });
    expect(directoryState(directory)).toEqual(before);
  });
});

const unavailable = { code: 'PROVIDER_STORE_UNAVAILABLE' };
const stale = { code: 'PROVIDER_STORE_SCHEMA_STALE' };
const historicalDdl = readFileSync(new URL('./fixtures/provider-store-recovery-ddl.sql', import.meta.url), 'utf8')
  .trim().split(/\n\n(?=-- keys )/u);

function editFixture(file: string, sql: string): void {
  const { DatabaseSync } = loadSqliteModule();
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

function insertProfile(ref: string, authMode = 'bearer', enabled = 0): string {
  return `INSERT INTO provider_profile
    (profile_ref, provider_kind, kind, adapter, display_name, base_url, auth_mode, model, capabilities, enabled, created_at, updated_at)
    VALUES ('${ref}', 'custom', 'model', 'openai_compatible', 'local', 'https://example.test', '${authMode}', 'model', '[]', ${enabled}, 'a', 'a');`;
}

describeSqlite('listProviderProfileSecretNames', () => {
  it('keeps the latest allowed signature aligned with a newly created store', async () => {
    const file = join(tempDir(), 'current.db');
    await new SqliteProviderProfileStore({ path: file }).close();
    expect(readSqliteFileUnchanged(file, providerSecretRecoverySignature)).toBe(LATEST_PROVIDER_SECRET_RECOVERY_SCHEMA);
    expect(await listProviderProfileSecretNames(file)).toEqual([]);
  });

  it('uses the fixed legacy names only for provider IDs that exist', async () => {
    const file = join(tempDir(), 'legacy.db');
    editFixture(file, `${historicalDdl[0]}
      INSERT INTO provider_profile VALUES
        ('openai', 'model', 'openai_compatible', 'OpenAI', 'https://example.test', 'bearer', 'model', 1, 'a', 'a'),
        ('anthropic', 'model', 'anthropic', 'Anthropic', 'https://example.test', 'x_api_key', 'model', 0, 'a', 'a'),
        ('custom', 'model', 'openai_compatible', 'Custom', 'https://example.test', 'bearer', 'model', 0, 'a', 'a');`);
    expect(await listProviderProfileSecretNames(file)).toEqual([
      'model-anthropic-api-key', 'model-custom-api-key', 'model-openai-api-key',
    ]);
    editFixture(file, "UPDATE provider_profile SET provider_id = 'deepseek' WHERE provider_id = 'openai'");
    expect(await listProviderProfileSecretNames(file)).toEqual([
      'model-anthropic-api-key', 'model-custom-api-key', 'model-deepseek-api-key',
    ]);
  });

  for (const ddl of historicalDdl.slice(1)) {
    it(`reads the ${ddl.split(' ')[2]} ref layout`, async () => {
      const file = join(tempDir(), 'early-ref.db');
      const ref = 'x'.repeat(64);
      editFixture(file, ddl + insertProfile(ref));
      expect(await listProviderProfileSecretNames(file)).toEqual([`model-${ref}-api-key`]);
    });
  }

  it('recovers stale profile and pending names and preserves a replacement key in the same scope', async () => {
    const old = fixtureCopy('0.41.0');
    const current = fixtureCopy('0.44.0');
    editFixture(old, insertProfile('openai', 'bearer', 1) + insertProfile('old') + insertProfile('keyless', 'none') + `
      INSERT INTO provider_custody_pending (profile_ref, operation, since)
      VALUES ('pending', 'configure', 'now'), ('old', 'replace_secret', 'now');`);
    editFixture(current, insertProfile('openai'));
    expect(await inspectProviderProfileStore(old)).toMatchObject({ verdict: 'new-path-repair', ...stale });
    expect(await inspectProviderProfileStore(current)).toMatchObject({ verdict: 'accepted' });
    const before = directoryState(dirname(old));
    const names = await listProviderProfileSecretNames(old);
    expect(names).toEqual(['model-keyless-api-key', 'model-old-api-key', 'model-openai-api-key', 'model-pending-api-key']);
    const active = new Set(await listProviderProfileSecretNames(current));
    const root = new InMemorySecretStore();
    const scope = root.scope('original-scope');
    const other = root.scope('another-scope');
    for (const name of ['model-old-api-key', 'model-pending-api-key', 'model-openai-api-key', 'model-unrelated-api-key']) {
      await scope.set(name, 'fixture-key');
    }
    await other.set('model-old-api-key', 'different-scope-key');
    const removed = [];
    for (const name of names.filter((name) => !active.has(name))) removed.push(await scope.delete(name));
    expect(removed).toEqual([false, true, true]);
    expect(await scope.has('model-old-api-key')).toBe(false);
    expect(await scope.has('model-pending-api-key')).toBe(false);
    expect(await scope.get('model-openai-api-key')).toBe('fixture-key');
    expect(await scope.has('model-unrelated-api-key')).toBe(true);
    expect(await other.has('model-old-api-key')).toBe(true);
    expect(directoryState(dirname(old))).toEqual(before);
  });

  it.each([
    ['extra table', 'CREATE TABLE unrelated(id TEXT)'],
    ['absent index', 'DROP INDEX provider_profile_one_enabled'],
    ['changed pending DDL', 'ALTER TABLE provider_custody_pending ADD COLUMN unexpected TEXT'],
    ['substitute view', "DROP TABLE provider_profile; CREATE VIEW provider_profile AS SELECT 'openai' AS profile_ref"],
    ['invalid ref', insertProfile('BAD-REF')],
    ['null ref', insertProfile('valid').replace("'valid'", 'NULL')],
    ['embedded NUL', insertProfile('valid').replace("'valid'", "'valid' || char(0) || 'tail'")],
  ])('rejects %s even when other refs are valid', async (_label, sql) => {
    const file = fixtureCopy('0.41.0');
    editFixture(file, insertProfile('retained') + sql);
    const before = directoryState(dirname(file));
    const result = listProviderProfileSecretNames(file);
    await expect(result).rejects.toMatchObject(stale);
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(directoryState(dirname(file))).toEqual(before);
  });

  it('rejects a CHECK set that no released catalog wrote', async () => {
    const file = join(tempDir(), 'unknown-catalog.db');
    const ddl = historicalDdl[1]!.replace("'custom'", "'custom', 'future-vendor'");
    editFixture(file, ddl + insertProfile('valid'));
    await expect(listProviderProfileSecretNames(file)).rejects.toMatchObject(stale);
  });

  it('rejects missing, non-file, in-memory and damaged inputs', async () => {
    const dir = tempDir();
    const damaged = join(dir, 'damaged.db');
    writeFileSync(damaged, 'not a database'.repeat(10));
    for (const file of [dir, join(dir, 'missing.db'), ':memory:', damaged]) {
      await expect(listProviderProfileSecretNames(file)).rejects.toMatchObject(unavailable);
    }
  });

  it.each(['-wal', '-shm', '-journal'])('rejects even an empty %s file and preserves it', async (suffix) => {
    const file = fixtureCopy('0.41.0');
    writeFileSync(file + suffix, '');
    const before = directoryState(dirname(file));
    await expect(listProviderProfileSecretNames(file)).rejects.toMatchObject(unavailable);
    expect(directoryState(dirname(file))).toEqual(before);
  });

  it.skipIf(process.platform === 'win32')('checks for sidecars at the resolved database path', async () => {
    const file = fixtureCopy('0.41.0');
    const alias = join(tempDir(), 'alias.db');
    symlinkSync(file, alias);
    expect(await listProviderProfileSecretNames(alias)).toEqual([]);
    writeFileSync(file + '-wal', '');
    await expect(listProviderProfileSecretNames(alias)).rejects.toMatchObject(unavailable);
  });

  it('refuses a live WAL and reads its committed rows after close and checkpoint', async () => {
    const parent = process.platform === 'win32' ? '#%.db' : '#%?.db';
    const file = join(tempDir(), parent);
    copyFileSync(join(FIXTURES, '0.44.0/keys-profile-store.db'), file);
    const { DatabaseSync } = loadSqliteModule();
    const writer = new DatabaseSync(file);
    try {
      writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;' + insertProfile('wal-only'));
      const before = directoryState(dirname(file));
      expect(statSync(file + '-wal').size).toBeGreaterThan(0);
      await expect(listProviderProfileSecretNames(file)).rejects.toMatchObject(unavailable);
      expect(directoryState(dirname(file))).toEqual(before);
    } finally {
      writer.close();
    }
    const before = directoryState(dirname(file));
    expect(await listProviderProfileSecretNames(file)).toEqual(['model-wal-only-api-key']);
    expect(directoryState(dirname(file))).toEqual(before);
  });

  it('refuses a rollback journal left by a process that did not close', async () => {
    const file = fixtureCopy('0.41.0');
    const script = `
      const db = new (require('node:sqlite').DatabaseSync)(process.argv[1]);
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA cache_size=3; CREATE TABLE spill(data); BEGIN;');
      db.exec(process.argv[2]);
      db.exec('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100) INSERT INTO spill SELECT randomblob(4096) FROM n;');
      require('node:fs').writeSync(1, 'transaction left open');
      process.kill(process.pid, 'SIGKILL');
    `;
    const result = spawnSync(process.execPath, ['-e', script, file, insertProfile('not-committed')], { encoding: 'utf8' });
    expect(result.stdout).toBe('transaction left open');
    expect(result.status).not.toBe(0);
    expect(statSync(file + '-journal').size).toBeGreaterThan(512);
    const before = directoryState(dirname(file));
    await expect(listProviderProfileSecretNames(file)).rejects.toMatchObject(unavailable);
    expect(directoryState(dirname(file))).toEqual(before);
  });
});
