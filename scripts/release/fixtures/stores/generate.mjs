#!/usr/bin/env node
// Store fixtures for the store compatibility precheck (#1102).
//
// Each fixture is the set of local stores one SDK build writes when it opens
// them for the first time: the embedded server SQLite store, a daemon store
// directory (journal `daemon.db` plus one pi-durable replica under
// `durable-replicas/`) and the provider profile store. From 0.42.0 it also
// includes an exported bot-collaboration Host ledger. A released build is
// installed from npm into a temporary directory; `main` is this workspace
// (run `bun run build` first). Each store is then copied, switched to a
// rollback journal and vacuumed with 512-byte pages, which keeps the files
// small without changing their schema or rows.
//
// Usage:
//   node scripts/release/fixtures/stores/generate.mjs [--release <version>]... [--main]
// With no arguments it regenerates every release in RELEASES and `main`.
// The repository ignores *.db and *.sqlite: add a new fixture with `git add -f`.
// The package tests (server, keys, client, bot-collaboration) assert, for every fixture in
// index.json, the verdict its authored `expected` map gives each store. A new
// fixture has no `expected` map, so those tests fail until one is written.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const indexFile = path.join(here, 'index.json');

/** Released builds kept as fixtures: every release the latest Host upgrade checklist starts from (0.30.2 while AiphaBee upgrades from it, 0.31.0, 0.32.0, 0.33.0, 0.34.0, 0.35.0, 0.36.0, 0.37.0, 0.38.0) and the latest release. */
export const RELEASES = ['0.30.2', '0.31.0', '0.32.0', '0.33.0', '0.34.0', '0.35.0', '0.36.0', '0.37.0', '0.38.0', '0.39.0', '0.40.0', '0.41.0', '0.42.0'];

/** Where each store lives inside a fixture directory. */
export const FIXTURE_LAYOUT = {
  'server-sqlite': 'server-sqlite.db',
  'client-journal': 'daemon-store/daemon.db',
  'pi-durable': 'daemon-store/durable-replicas/fixture/durable-fixture.sqlite',
  'keys-profile-store': 'keys-profile-store.db',
  'bot-collaboration-ledger': 'bot-collaboration-ledger.sqlite',
};

function parseArgs(argv) {
  const releases = [];
  let main = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--release') releases.push(argv[(index += 1)] ?? '');
    else if (arg === '--main') main = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (releases.length === 0 && !main) return { releases: RELEASES, main: true };
  return { releases, main };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function packageEntry(packageDir, subpath = '.') {
  const manifest = readJson(path.join(packageDir, 'package.json'));
  const target = manifest.exports?.[subpath];
  const file = typeof target === 'string' ? target : target?.import ?? target?.default;
  if (typeof file !== 'string') throw new Error(`${manifest.name} has no import entry for ${subpath}`);
  return { url: pathToFileURL(path.join(packageDir, file)).href, version: manifest.version };
}

/** Open every store once with the build whose packages live in `dirs`, writing into `out`. */
async function writeStores(dirs, out) {
  const server = await import(packageEntry(dirs.server).url);
  const client = await import(packageEntry(dirs.client).url);
  const keys = await import(packageEntry(dirs.keys).url);
  const durable = packageEntry(dirs.piDurable, './storage/sqlite/node');
  const { openNodeSqliteStorage } = await import(durable.url);
  const { BACKGROUND_CONTEXT } = await import(packageEntry(dirs.chord, './context').url);

  const file = (store) => {
    const target = path.join(out, FIXTURE_LAYOUT[store]);
    mkdirSync(path.dirname(target), { recursive: true });
    return target;
  };
  const byok = server.createByokServer({ productId: 'store-fixture', storage: { kind: 'sqlite', path: file('server-sqlite') } });
  try {
    if (dirs.botCollaboration) {
      const { BotCollaboration, botCompactVeto } = await import(packageEntry(dirs.botCollaboration).url);
      const { HostLedger } = await import(packageEntry(dirs.server, './execution-core').url);
      const ledger = new HostLedger(file('bot-collaboration-ledger'), 'store-fixture', { compactVeto: botCompactVeto });
      let bot;
      try {
        bot = new BotCollaboration(byok, ledger, {
          botId: 'main', dreaming: false, now: () => 1_000_000, connector: async () => null,
          execution: { deviceId: 'fixture-device', payload: {
            runtime: 'pi', session: { mode: 'fresh' }, instruction: 'Return the fixture result.',
            agentRef: { agentId: 'main', profileRevision: '1' },
            egressPolicy: { policyRevision: 'fixture-v1',
              activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
              reliable: { maxPendingEventsPerAgent: 16, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 16384 },
              transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' } },
            terminalProjection: { mode: 'result-document', contract: 'store-fixture-v1', schema: { type: 'object' } },
          } },
        });
        await bot.freezeForSwitch('fixture-device', 0);
        await bot.core.flushProjections(async () => {});
        await bot.exportForSwitch([{ deviceId: 'fixture-device', expectedRevision: 1 }]);
      } finally {
        await bot?.close();
        ledger.close();
      }
    }
  } finally {
    await byok.close();
  }
  const journal = new client.SqliteLocalTaskJournal({ storeDir: path.dirname(file('client-journal')) });
  await journal.close();
  const storage = await openNodeSqliteStorage(file('pi-durable'));
  await storage.close(BACKGROUND_CONTEXT);
  const profiles = new keys.SqliteProviderProfileStore({ path: file('keys-profile-store') });
  await profiles.close();
  return { piDurable: durable.version, ...(dirs.botCollaboration ? { ledgerTenant: 'store-fixture' } : {}) };
}

/** Rewrite a store in place as one small rollback-journal file with the same schema and rows. */
function compact(file) {
  const database = new DatabaseSync(file);
  try {
    database.exec('PRAGMA journal_mode = DELETE; PRAGMA page_size = 512; VACUUM;');
  } finally {
    database.close();
  }
  for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${file}${suffix}`, { force: true });
}

function finish(label, scratch, record) {
  const target = path.join(here, label);
  rmSync(target, { recursive: true, force: true });
  const layout = Object.entries(FIXTURE_LAYOUT).filter(([store]) => store !== 'bot-collaboration-ledger' || record.ledgerTenant);
  for (const [, relative] of layout) {
    const source = path.join(scratch, relative);
    compact(source);
    mkdirSync(path.dirname(path.join(target, relative)), { recursive: true });
    copyFileSync(source, path.join(target, relative));
  }
  return { ...record, stores: Object.fromEntries(layout.map(([store, relative]) => [store, `${label}/${relative}`])) };
}

async function generateRelease(version) {
  const [major, minor] = version.split('.').map(Number);
  const includeLedger = major > 0 || minor >= 42;
  const install = mkdtempSync(path.join(tmpdir(), `byok-store-fixture-${version}-`));
  try {
    writeFileSync(path.join(install, 'package.json'), '{"private":true}\n');
    execFileSync('npm', [
      'install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '--engine-strict=false',
      `@byok-sdk/server@${version}`, `@byok-sdk/client@${version}`, `@byok-sdk/keys@${version}`,
      ...(includeLedger ? [`@byok-sdk/bot-collaboration@${version}`] : []),
    ], { cwd: install, stdio: 'inherit' });
    const modules = path.join(install, 'node_modules');
    const scratch = path.join(install, 'stores');
    const versions = await writeStores({
      server: path.join(modules, '@byok-sdk/server'),
      client: path.join(modules, '@byok-sdk/client'),
      keys: path.join(modules, '@byok-sdk/keys'),
      ...(includeLedger ? { botCollaboration: path.join(modules, '@byok-sdk/bot-collaboration') } : {}),
      piDurable: path.join(modules, '@earendil-works/pi-durable'),
      chord: path.join(modules, '@earendil-works/chord'),
    }, scratch);
    return finish(version, scratch, { source: `npm @byok-sdk/{server,client,keys${includeLedger ? ',bot-collaboration' : ''}}@${version}`, ...versions });
  } finally {
    rmSync(install, { recursive: true, force: true });
  }
}

async function generateMain() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'byok-store-fixture-main-'));
  try {
    const clientModules = path.join(repoRoot, 'packages/client/node_modules');
    const versions = await writeStores({
      server: path.join(repoRoot, 'packages/server'),
      client: path.join(repoRoot, 'packages/client'),
      keys: path.join(repoRoot, 'packages/keys'),
      botCollaboration: path.join(repoRoot, 'packages/bot-collaboration'),
      piDurable: realpathSync(path.join(clientModules, '@earendil-works/pi-durable')),
      chord: realpathSync(path.join(clientModules, '@earendil-works/chord')),
    }, scratch);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    return finish('main', scratch, { source: `workspace at ${commit}`, ...versions });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const { releases, main: includeMain } = parseArgs(process.argv.slice(2));
  const index = readJson(indexFile);
  // `expected` is authored: the verdict this tree gives each store of the fixture.
  const keep = (label, record) => ({ ...record, expected: index.fixtures[label]?.expected });
  for (const version of releases) index.fixtures[version] = keep(version, await generateRelease(version));
  if (includeMain) index.fixtures.main = keep('main', await generateMain());
  index.fixtures = Object.fromEntries(Object.entries(index.fixtures).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`[store-fixtures] wrote ${[...releases, ...(includeMain ? ['main'] : [])].join(', ')}`);
}

if (import.meta.main) {
  await main();
}
