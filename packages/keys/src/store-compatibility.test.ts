import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectProviderProfileStore } from './store-compatibility';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { isSqliteAvailable, loadSqliteModule } from './sqlite-support';

/** #1102: the provider profile store precheck, over checked-in stores written by released builds. */

const describeSqlite = isSqliteAvailable() ? describe : describe.skip;
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
const ACCEPTANCE_VERDICT: Record<string, string> = { accept: 'accepted', 'new-path-repair': 'new-path-repair', reject: 'rejected' };

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
    return [name, `${createHash('sha256').update(readFileSync(file)).digest('hex')} ${statSync(file).mtimeMs}`];
  }));
}

describeSqlite('inspectProviderProfileStore', () => {
  it('has an authored verdict for every fixture', () => {
    for (const [label, fixture] of Object.entries(index.fixtures)) {
      expect(fixture.expected?.['keys-profile-store'], `scripts/release/fixtures/stores/index.json: ${label}.expected`).toBeDefined();
    }
  });

  for (const [label, fixture] of Object.entries(index.fixtures)) {
    it(`gives the ${label} fixture its expected verdict`, async () => {
      const result = await inspectProviderProfileStore(fixtureCopy(label));
      expect(result.store).toBe('keys-profile-store');
      expect(result.verdict).toBe(fixture.expected?.['keys-profile-store']);
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
