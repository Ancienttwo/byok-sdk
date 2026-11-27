import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSqliteFileUnchanged } from '@byok-sdk/core/sqlite-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemorySecretStore, listProviderProfileSecretNames, removeRetiredProviderCredentials } from './index';
import { LATEST_PROVIDER_SECRET_RECOVERY_SCHEMA, providerSecretRecoverySignature } from './provider-secret-recovery';
import { inspectProviderProfileStore } from './store-compatibility';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { isSqliteAvailable, loadSqliteModule } from './sqlite-support';

/** #2530: hooks into the precheck's file reads, so a store file can vanish at an exact step. */
const fsHooks = vi.hoisted(() => ({
  afterStat: undefined as ((path: string) => void) | undefined,
  beforeCopy: undefined as ((source: string, destination: string) => void) | undefined,
  copyError: undefined as unknown,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const statSync = ((...args: Parameters<typeof actual.statSync>) => {
    const stat = actual.statSync(...args);
    fsHooks.afterStat?.(String(args[0]));
    return stat;
  }) as typeof actual.statSync;
  const copyFileSync: typeof actual.copyFileSync = (source, destination, mode) => {
    fsHooks.beforeCopy?.(String(source), String(destination));
    try {
      actual.copyFileSync(source, destination, mode);
    } catch (error) {
      fsHooks.copyError = error;
      throw error;
    }
  };
  return { ...actual, default: { ...actual, statSync, copyFileSync }, statSync, copyFileSync };
});

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
  fsHooks.afterStat = undefined;
  fsHooks.beforeCopy = undefined;
  fsHooks.copyError = undefined;
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
    const { mtimeNs, ctimeNs, mode } = statSync(file, { bigint: true });
    return [name, `${createHash('sha256').update(readFileSync(file)).digest('hex')} ${mtimeNs} ${ctimeNs} ${mode}`];
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
    database.exec('DROP TABLE provider_profile');
    database.exec(earlier);
    database.exec('CREATE UNIQUE INDEX provider_profile_single_enabled ON provider_profile(kind) WHERE enabled = 1;');
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

  it('refuses a WAL that vanishes between its fingerprint and its copy (#2530)', async () => {
    const file = join(tempDir(), 'profiles.db');
    await new SqliteProviderProfileStore({ path: file }).close();
    writeFileSync(`${file}-wal`, '');
    fsHooks.beforeCopy = (source) => {
      if (source === `${file}-wal`) rmSync(source);
    };
    await expect(inspectProviderProfileStore(file)).rejects.toThrow(`${file} changed while it was being checked`);
  });

  it('refuses a main file that vanishes after the first stat instead of checking a fresh copy (#2530)', async () => {
    const file = join(tempDir(), 'profiles.db');
    await new SqliteProviderProfileStore({ path: file }).close();
    fsHooks.afterStat = (path) => {
      if (path !== file) return;
      fsHooks.afterStat = undefined;
      rmSync(file);
    };
    await expect(inspectProviderProfileStore(file)).rejects.toThrow(`${file} changed while it was being checked`);
  });

  it('lets a copy failure with the source intact propagate as itself (#2530)', async () => {
    const file = join(tempDir(), 'profiles.db');
    await new SqliteProviderProfileStore({ path: file }).close();
    fsHooks.beforeCopy = (_source, destination) => rmSync(dirname(destination), { recursive: true, force: true });
    const error = await inspectProviderProfileStore(file).catch((caught: unknown) => caught);
    expect(error).toBe(fsHooks.copyError);
    expect(error).toMatchObject({ code: 'ENOENT' });
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

async function currentStore(name = 'profiles.db'): Promise<{ file: string; id: string }> {
  const file = join(tempDir(), name);
  const store = new SqliteProviderProfileStore({ path: file });
  await store.close();
  return { file, id: store.credentialNamespaceId };
}

async function expectRecoveryRefused(file: string, error: { code: string }): Promise<void> {
  const base = new InMemorySecretStore();
  const scoped = new InMemorySecretStore();
  const scope = vi.spyOn(base, 'scope').mockReturnValue(scoped);
  const deletions = [vi.spyOn(base, 'delete'), vi.spyOn(scoped, 'delete')];
  const names = listProviderProfileSecretNames(file);
  await expect(names).rejects.toMatchObject(error);
  await expect(names).rejects.not.toHaveProperty('cause');
  await expect(removeRetiredProviderCredentials(file, base)).rejects.toMatchObject(error);
  expect(scope).not.toHaveBeenCalled();
  for (const remove of deletions) expect(remove).not.toHaveBeenCalled();
}

describeSqlite('offline provider credential recovery', () => {
  it('keeps the latest allowed signature aligned with a newly created store', async () => {
    const file = join(tempDir(), 'current.db');
    await new SqliteProviderProfileStore({ path: file }).close();
    expect(readSqliteFileUnchanged(file, providerSecretRecoverySignature)).toBe(LATEST_PROVIDER_SECRET_RECOVERY_SCHEMA);
    expect(await listProviderProfileSecretNames(file)).toEqual([]);
  });

  it.each(historicalDdl.map(ddl => [ddl.split('\n', 1)[0], ddl] as const))('rejects the shared layout %s', async (_label, ddl) => {
    const file = join(tempDir(), 'historical.db');
    editFixture(file, ddl);
    await expectRecoveryRefused(file, stale);
  });

  it.each(['0.41.0', '0.44.1'])('leaves credentials unchanged for the released %s shared layout', async (release) => {
    const file = fixtureCopy(release);
    editFixture(file, insertProfile('openai'));
    const before = directoryState(dirname(file));
    await expectRecoveryRefused(file, stale);
    expect(directoryState(dirname(file))).toEqual(before);
  });

  it('removes only the retired DB’s profile and pending names, even when another DB uses the same name', async () => {
    const retired = await currentStore();
    const active = await currentStore();
    const pending = `INSERT INTO provider_custody_pending (profile_ref, operation, since)
      VALUES ('pending', 'configure', 'now'), ('openai', 'replace_secret', 'now');`;
    editFixture(retired.file, `${insertProfile('openai', 'bearer', 1)}${insertProfile('keyless', 'none')}${pending}`);
    editFixture(active.file, insertProfile('openai'));
    const before = directoryState(dirname(retired.file));
    const base = new InMemorySecretStore();
    const retiredSecrets = base.scope(retired.id);
    const activeSecrets = base.scope(active.id);
    const names = ['model-keyless-api-key', 'model-openai-api-key', 'model-pending-api-key'];
    for (const name of ['model-openai-api-key', 'model-pending-api-key', 'model-unrelated-api-key']) {
      await retiredSecrets.set(name, 'retired-key');
    }
    await activeSecrets.set('model-openai-api-key', 'active-key');
    await base.set('model-openai-api-key', 'base-decoy');

    expect(await listProviderProfileSecretNames(retired.file)).toEqual(names);
    const scope = vi.spyOn(base, 'scope').mockReturnValueOnce(retiredSecrets);
    const remove = vi.spyOn(retiredSecrets, 'delete');
    await expect(removeRetiredProviderCredentials(retired.file, base)).resolves.toBeUndefined();
    expect(scope).toHaveBeenCalledExactlyOnceWith(retired.id);
    expect(remove.mock.calls.flat()).toEqual(names);
    for (const name of names) await expect(retiredSecrets.has(name)).resolves.toBe(false);
    await expect(retiredSecrets.get('model-unrelated-api-key')).resolves.toBe('retired-key');
    await expect(activeSecrets.get('model-openai-api-key')).resolves.toBe('active-key');
    await expect(base.get('model-openai-api-key')).resolves.toBe('base-decoy');
    expect(directoryState(dirname(retired.file))).toEqual(before);
  });

  it('stops on a backend failure and retries the partial cleanup using the same retired DB', async () => {
    const { file, id } = await currentStore();
    for (const ref of ['a', 'b', 'c']) editFixture(file, insertProfile(ref));
    const before = directoryState(dirname(file));
    const base = new InMemorySecretStore();
    const secrets = base.scope(id);
    const names = ['model-a-api-key', 'model-b-api-key', 'model-c-api-key'];
    for (const name of names) await secrets.set(name, 'test-credential');
    const deleteEntry = secrets.delete.bind(secrets);
    const remove = vi.spyOn(secrets, 'delete').mockImplementationOnce(deleteEntry)
      .mockRejectedValueOnce(new Error('backend echoed test-credential'));
    vi.spyOn(base, 'scope').mockReturnValue(secrets);
    await expect(removeRetiredProviderCredentials(file, base)).rejects.toMatchObject({
      code: 'PROVIDER_SECRET_STORE_FAILED', message: 'Provider credential store operation failed',
    });
    expect(remove.mock.calls.flat()).toEqual(names.slice(0, 2));
    await expect(secrets.has(names[0]!)).resolves.toBe(false);
    await expect(secrets.has(names[2]!)).resolves.toBe(true);
    remove.mockClear();
    await expect(removeRetiredProviderCredentials(file, base)).resolves.toBeUndefined();
    expect(remove.mock.calls.flat()).toEqual(names);
    for (const name of names) await expect(secrets.has(name)).resolves.toBe(false);
    expect(directoryState(dirname(file))).toEqual(before);
  });

  it.each([
    ['extra table', 'CREATE TABLE unrelated(id TEXT)'],
    ['absent index', 'DROP INDEX provider_profile_single_enabled'],
    ['changed pending DDL', 'ALTER TABLE provider_custody_pending ADD COLUMN unexpected TEXT'],
    ['substitute view', "DROP TABLE provider_profile; CREATE VIEW provider_profile AS SELECT 'openai' AS profile_ref"],
    ['removed namespace row', 'DELETE FROM provider_store_metadata'],
    ['invalid namespace', "UPDATE provider_store_metadata SET credential_namespace_id = credential_namespace_id || char(0) || 'tail'"],
  ])('rejects %s before binding the credential backend', async (_label, sql) => {
    const { file } = await currentStore();
    editFixture(file, insertProfile('retained') + sql);
    const before = directoryState(dirname(file));
    await expectRecoveryRefused(file, stale);
    expect(directoryState(dirname(file))).toEqual(before);
  });

  it('rejects invalid profile or pending refs even after reading valid refs', async () => {
    const { file } = await currentStore();
    editFixture(file, insertProfile('valid'));
    for (const value of ["'BAD-REF'", 'NULL', "'valid' || char(0) || 'tail'"]) {
      editFixture(file, `INSERT INTO provider_custody_pending (profile_ref, operation, since) VALUES (${value}, 'configure', 'now');`);
      await expectRecoveryRefused(file, stale);
      editFixture(file, 'DELETE FROM provider_custody_pending');
    }
  });

  it('rejects missing, non-file, in-memory and damaged inputs', async () => {
    const dir = tempDir();
    const damaged = join(dir, 'damaged.db');
    writeFileSync(damaged, 'not a database'.repeat(10));
    for (const file of [dir, join(dir, 'missing.db'), ':memory:', damaged]) {
      await expectRecoveryRefused(file, unavailable);
    }
  });

  it.each(['-wal', '-shm', '-journal'])('rejects even an empty %s file and preserves it', async (suffix) => {
    const { file } = await currentStore();
    writeFileSync(file + suffix, '');
    const before = directoryState(dirname(file));
    await expectRecoveryRefused(file, unavailable);
    expect(directoryState(dirname(file))).toEqual(before);
  });

  it.skipIf(process.platform === 'win32')('checks for sidecars at the supplied and resolved database paths', async () => {
    const { file } = await currentStore();
    const alias = join(tempDir(), 'alias.db');
    symlinkSync(file, alias);
    expect(await listProviderProfileSecretNames(alias)).toEqual([]);
    for (const path of [file, alias]) {
      writeFileSync(path + '-wal', '');
      await expectRecoveryRefused(alias, unavailable);
      rmSync(path + '-wal');
    }
  });

  it('refuses a live WAL and reads its committed rows after close and checkpoint', async () => {
    const fileName = process.platform === 'win32' ? '#%.db' : '#%?.db';
    const { file } = await currentStore(fileName);
    const { DatabaseSync } = loadSqliteModule();
    const writer = new DatabaseSync(file);
    try {
      writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;' + insertProfile('wal-only'));
      const before = directoryState(dirname(file));
      expect(statSync(file + '-wal').size).toBeGreaterThan(0);
      await expectRecoveryRefused(file, unavailable);
      expect(directoryState(dirname(file))).toEqual(before);
    } finally {
      writer.close();
    }
    const before = directoryState(dirname(file));
    expect(await listProviderProfileSecretNames(file)).toEqual(['model-wal-only-api-key']);
    expect(directoryState(dirname(file))).toEqual(before);
  });

  it('refuses a rollback journal left by a process that did not close', async () => {
    const { file } = await currentStore();
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
    await expectRecoveryRefused(file, unavailable);
    expect(directoryState(dirname(file))).toEqual(before);
  });
});
