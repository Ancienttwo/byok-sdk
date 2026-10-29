import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createByokServer, inspectSqliteStore } from '../index';
import { isSqliteAvailable } from '../sqlite-support';

/** #1102: the server SQLite store precheck, over checked-in stores written by released builds. */

const describeSqlite = isSqliteAvailable() ? describe : describe.skip;
const FIXTURES = fileURLToPath(new URL('../../../../scripts/release/fixtures/stores/', import.meta.url));
const MANIFEST = fileURLToPath(new URL('../../../client/upgrade-manifest.json', import.meta.url));

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
  const directory = mkdtempSync(join(tmpdir(), 'byok-server-store-check-'));
  scratch.push(directory);
  return directory;
}

function fixtureCopy(label: string): string {
  const relative = index.fixtures[label]?.stores['server-sqlite'];
  if (relative === undefined) throw new Error(`fixture ${label} has no server-sqlite store`);
  const file = join(tempDir(), 'server.db');
  copyFileSync(join(FIXTURES, relative), file);
  return file;
}

/** Bytes digest and mtime of every file in `directory`, by name. */
function directoryState(directory: string): Record<string, string> {
  return Object.fromEntries(readdirSync(directory).sort().map((name) => {
    const file = join(directory, name);
    return [name, `${createHash('sha256').update(readFileSync(file)).digest('hex')} ${statSync(file).mtimeMs}`];
  }));
}

describeSqlite('inspectSqliteStore', () => {
  it('has an authored verdict for every fixture', () => {
    for (const [label, fixture] of Object.entries(index.fixtures)) {
      expect(fixture.expected?.['server-sqlite'], `scripts/release/fixtures/stores/index.json: ${label}.expected`).toBeDefined();
    }
  });

  for (const [label, fixture] of Object.entries(index.fixtures)) {
    it(`gives the ${label} fixture its expected verdict`, async () => {
      const result = await inspectSqliteStore(fixtureCopy(label));
      expect(result.store).toBe('server-sqlite');
      expect(result.verdict).toBe(fixture.expected?.['server-sqlite']);
    });
  }

  it('agrees with the upgrade manifest on a store the baseline release wrote', async () => {
    // The baseline is the release the manifest is written against; its fixture must exist.
    const baseline = manifest.from.version;
    expect(index.fixtures[baseline], `generate the ${baseline} store fixture`).toBeDefined();
    const entry = manifest.entries.find((candidate) => candidate.items.includes('store:server-sqlite'));
    const allowed = entry === undefined ? ['accepted'] : ['accepted', ACCEPTANCE_VERDICT[entry.acceptance ?? '']];
    expect(allowed).toContain((await inspectSqliteStore(fixtureCopy(baseline))).verdict);
  });

  it('reports a missing file as absent', async () => {
    const result = await inspectSqliteStore(join(tempDir(), 'missing.db'));
    expect(result).toMatchObject({ store: 'server-sqlite', verdict: 'absent' });
  });

  it('rejects a newer schema version, a file without BYOK metadata and a damaged file', async () => {
    const directory = tempDir();
    const newer = join(directory, 'newer.db');
    const database = new DatabaseSync(newer);
    database.exec("CREATE TABLE byok_sqlite_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO byok_sqlite_meta VALUES ('schema_version', '999');");
    database.close();
    expect(await inspectSqliteStore(newer)).toMatchObject({ verdict: 'rejected', code: 'SQLITE_SCHEMA_UNSUPPORTED' });

    const foreign = join(directory, 'foreign.db');
    const other = new DatabaseSync(foreign);
    other.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY);');
    other.close();
    expect(await inspectSqliteStore(foreign)).toMatchObject({ verdict: 'rejected', code: 'SQLITE_SCHEMA_INVALID' });

    const damaged = join(directory, 'damaged.db');
    writeFileSync(damaged, 'not a sqlite database, only text that is long enough to have a header'.repeat(10));
    expect(await inspectSqliteStore(damaged)).toMatchObject({ verdict: 'rejected' });
  });

  it('reads the WAL and leaves every file of the store unchanged', async () => {
    const directory = tempDir();
    const file = join(directory, 'server.db');
    const server = createByokServer({ productId: 'store-check', storage: { kind: 'sqlite', path: file } });
    await server.close();
    // A schema_version that only the WAL holds: the verdict proves the WAL was read.
    const writer = new DatabaseSync(file);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; UPDATE byok_sqlite_meta SET value = '5' WHERE key = 'schema_version';");
      expect(readdirSync(directory)).toContain('server.db-wal');
      const before = directoryState(directory);
      expect(await inspectSqliteStore(file)).toMatchObject({ verdict: 'new-path-repair', code: 'SQLITE_SCHEMA_UNSUPPORTED' });
      expect(directoryState(directory)).toEqual(before);
    } finally {
      writer.close();
    }
  });
});
