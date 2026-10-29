import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalStoreId, StoreCompatibility } from '@byok-sdk/core';
import { inspectDaemonStores } from '../upgrade-check/store-compatibility';
import { runUpgradeStoreCheckCommand, UPGRADE_CHECK_REFUSED_EXIT_CODE } from '../bin/commands/upgrade';
import { isSqliteAvailable } from '../daemon/journal/sqlite-support';
import { SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal';
import { acquireReplicaLock, admitReplica, DURABLE_REPLICA_DIRNAME } from '../adapters/pi-durable/replica';

/** #1102: the daemon store precheck (journal + pi-durable replicas) and `byok-agent upgrade check --store`. */

const describeSqlite = isSqliteAvailable() ? describe : describe.skip;
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const FIXTURES = join(REPO, 'scripts/release/fixtures/stores');
const DAEMON_STORES = ['client-journal', 'pi-durable'] as const;
/** Every `LocalStoreId`, exactly once: the type rejects a missing or an unknown id. */
const LOCAL_STORE_IDS: Record<LocalStoreId, true> = { 'server-sqlite': true, 'client-journal': true, 'keys-profile-store': true, 'pi-durable': true };

interface FixtureIndex {
  readonly fixtures: Record<string, { readonly stores: Record<string, string>; readonly expected?: Record<string, string> }>;
}
interface UpgradeManifest {
  readonly from: { readonly version: string };
  readonly entries: readonly { readonly acceptance?: string; readonly items: readonly string[] }[];
}

const index = JSON.parse(readFileSync(join(FIXTURES, 'index.json'), 'utf8')) as FixtureIndex;
const manifest = JSON.parse(readFileSync(join(REPO, 'packages/client/upgrade-manifest.json'), 'utf8')) as UpgradeManifest;
const ACCEPTANCE_VERDICT: Record<string, string> = { accept: 'accepted', 'new-path-repair': 'new-path-repair', reject: 'rejected' };

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'byok-daemon-store-check-'));
  scratch.push(directory);
  return directory;
}

/** A copy of the fixture's daemon store directory (journal + replica). */
function fixtureStoreDir(label: string): string {
  const journal = index.fixtures[label]?.stores['client-journal'];
  if (journal === undefined) throw new Error(`fixture ${label} has no client-journal store`);
  const storeDir = join(tempDir(), 'store');
  cpSync(join(FIXTURES, journal, '..'), storeDir, { recursive: true });
  return storeDir;
}

function byStore(results: readonly StoreCompatibility[]): Record<string, string[]> {
  const verdicts: Record<string, string[]> = {};
  for (const result of results) (verdicts[result.store] ??= []).push(result.verdict);
  return verdicts;
}

/** Bytes digest and mtime of every file under `directory`, by relative path. */
function treeState(directory: string): Record<string, string> {
  const state: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else state[relative(directory, path)] = `${createHash('sha256').update(readFileSync(path)).digest('hex')} ${statSync(path).mtimeMs}`;
    }
  };
  walk(directory);
  return state;
}

describe('store ids', () => {
  it('are the upgrade manifest store items that live on a Host or device', async () => {
    const snapshot = (await import(pathToFileURL(join(REPO, 'scripts/release/upgrade-manifest/snapshot.mjs')).href)) as { STORES: { id: string }[] };
    const local = snapshot.STORES.map((store) => store.id).filter((id) => id !== 'cloud-dataplane-postgres');
    expect(Object.keys(LOCAL_STORE_IDS).sort()).toEqual(local.sort());
  });
});

describeSqlite('inspectDaemonStores', () => {
  it('has an authored verdict for every fixture', () => {
    for (const [label, fixture] of Object.entries(index.fixtures)) {
      for (const store of DAEMON_STORES) {
        expect(fixture.expected?.[store], `scripts/release/fixtures/stores/index.json: ${label}.expected.${store}`).toBeDefined();
      }
    }
  });

  for (const [label, fixture] of Object.entries(index.fixtures)) {
    it(`gives the ${label} fixture its expected verdicts`, async () => {
      const results = await inspectDaemonStores({ storeDir: fixtureStoreDir(label) });
      expect(byStore(results)).toEqual({
        'client-journal': [fixture.expected?.['client-journal']],
        'pi-durable': [fixture.expected?.['pi-durable']],
      });
    });
  }

  it('agrees with the upgrade manifest on stores the baseline release wrote', async () => {
    const baseline = manifest.from.version;
    expect(index.fixtures[baseline], `generate the ${baseline} store fixture`).toBeDefined();
    const verdicts = byStore(await inspectDaemonStores({ storeDir: fixtureStoreDir(baseline) }));
    for (const store of DAEMON_STORES) {
      const entry = manifest.entries.find((candidate) => candidate.items.includes(`store:${store}`));
      // An acceptance covers every older file; a baseline file may still be accepted.
      const allowed = entry === undefined ? ['accepted'] : ['accepted', ACCEPTANCE_VERDICT[entry.acceptance ?? '']];
      for (const verdict of verdicts[store] ?? []) expect(allowed).toContain(verdict);
    }
  });

  it('reports an empty store directory as an absent journal and no replicas', async () => {
    const results = await inspectDaemonStores({ storeDir: join(tempDir(), 'never-started') });
    expect(results).toEqual([expect.objectContaining({ store: 'client-journal', verdict: 'absent' })]);
  });

  it('rejects a journal written before withheld_bytes, as the manifest says', async () => {
    const storeDir = join(tempDir(), 'store');
    await new SqliteLocalTaskJournal({ storeDir }).close();
    const database = new DatabaseSync(join(storeDir, 'daemon.db'));
    database.exec('ALTER TABLE journal_envelope DROP COLUMN withheld_bytes;');
    database.close();
    const [journal] = await inspectDaemonStores({ storeDir });
    expect(journal).toMatchObject({ store: 'client-journal', verdict: 'rejected', code: 'JournalUnavailableError' });
    expect(manifest.entries.find((entry) => entry.items.includes('store:client-journal'))?.acceptance ?? 'reject').toBe('reject');
  });

  it('rejects a damaged journal without quarantining the original', async () => {
    const storeDir = join(tempDir(), 'store');
    mkdirSync(storeDir);
    writeFileSync(join(storeDir, 'daemon.db'), 'not a sqlite database, only text that is long enough to have a header'.repeat(10));
    const before = treeState(storeDir);
    const [journal] = await inspectDaemonStores({ storeDir });
    expect(journal).toMatchObject({ verdict: 'rejected', code: 'JournalCorruptError' });
    expect(treeState(storeDir)).toEqual(before);
  });

  it('rejects a pi-durable replica with a newer schema', async () => {
    const storeDir = fixtureStoreDir('main');
    const replica = join(FIXTURES, index.fixtures.main!.stores['pi-durable']!);
    const copy = join(storeDir, relative(join(FIXTURES, index.fixtures.main!.stores['client-journal']!, '..'), replica));
    const database = new DatabaseSync(copy);
    database.exec('UPDATE durable_schema SET version = version + 1;');
    database.close();
    const results = await inspectDaemonStores({ storeDir });
    expect(results.find((result) => result.store === 'pi-durable')).toMatchObject({ verdict: 'rejected' });
  });

  it('inspects a replica whose task id makes its name end in .lock.sqlite, and skips only real locks', async () => {
    // byokreview B1: taskId 'fixture.lock' is a valid writer path, durable-fixture.lock.sqlite.
    const storeDir = fixtureStoreDir('main');
    const home = join(tempDir(), 'home');
    mkdirSync(home);
    const binding = { agentRef: { tenantId: 't', agentId: 'a', profileRevision: '1' }, leaseId: 'lease', canonicalHome: home };
    const root = join(storeDir, DURABLE_REPLICA_DIRNAME);
    const healthy = await admitReplica(root, { ...binding, taskId: 'fixture' });
    cpSync(join(FIXTURES, index.fixtures.main!.stores['pi-durable']!), healthy);
    const lock = await acquireReplicaLock(healthy, 'lease');
    lock.release();
    const damaged = await admitReplica(root, { ...binding, taskId: 'fixture.lock' });
    expect(damaged.endsWith('durable-fixture.lock.sqlite')).toBe(true);
    writeFileSync(damaged, 'not a sqlite database, only text that is long enough to have a header'.repeat(10));

    const replicas = (await inspectDaemonStores({ storeDir })).filter((result) => result.store === 'pi-durable');
    expect(replicas.map((result) => [relative(root, result.path).split('/').pop(), result.verdict]).sort()).toEqual([
      ['durable-fixture.lock.sqlite', 'rejected'],
      ['durable-fixture.sqlite', 'accepted'],
      ['durable-fixture.sqlite', 'accepted'],
    ]);
    const code = await runUpgradeStoreCheckCommand({ storeDir, json: true, log: () => undefined });
    expect(code).toBe(UPGRADE_CHECK_REFUSED_EXIT_CODE);
  });

  it('leaves every file in the store directory unchanged, and creates nothing in it', async () => {
    const storeDir = fixtureStoreDir('main');
    const before = treeState(storeDir);
    await inspectDaemonStores({ storeDir });
    expect(treeState(storeDir)).toEqual(before);
  });
});

describeSqlite('byok-agent upgrade check --store', () => {
  it('prints JSON and exits 0 when every store is accepted', async () => {
    const lines: string[] = [];
    const code = await runUpgradeStoreCheckCommand({ storeDir: fixtureStoreDir('main'), json: true, log: (line) => lines.push(line) });
    expect(code).toBe(0);
    const report = JSON.parse(lines.join('\n')) as { version: string; stores: StoreCompatibility[] };
    expect(typeof report.version).toBe('string');
    expect(report.stores.map((store) => [store.store, store.verdict])).toEqual([['client-journal', 'accepted'], ['pi-durable', 'accepted']]);
  });

  it('prints one line per store and exits 2 when a store would be refused', async () => {
    const storeDir = join(tempDir(), 'store');
    await new SqliteLocalTaskJournal({ storeDir }).close();
    const database = new DatabaseSync(join(storeDir, 'daemon.db'));
    database.exec('ALTER TABLE journal_envelope DROP COLUMN withheld_bytes;');
    database.close();
    const lines: string[] = [];
    const code = await runUpgradeStoreCheckCommand({ storeDir, json: false, log: (line) => lines.push(line) });
    expect(code).toBe(UPGRADE_CHECK_REFUSED_EXIT_CODE);
    expect(UPGRADE_CHECK_REFUSED_EXIT_CODE).toBe(2);
    expect(lines[1]).toMatch(/^rejected client-journal .*daemon\.db code=JournalUnavailableError — /);
  });
});
