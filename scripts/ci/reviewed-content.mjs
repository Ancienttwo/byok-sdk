import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseBunLock } from '../release/pi-runtime-identity.mjs';
import { dependencyLockImpact, normalizeDependencyVersions } from './dependency-impact.mjs';

// The nine published manifests. A contract test keeps this list equal to the
// non-private packages/*/package.json files.
export const publicManifests = Object.freeze([
  'client', 'cloud', 'cloud-dataplane', 'cloud-do', 'core', 'keys', 'protocol', 'server', 'ui-runtime',
].map(name => `packages/${name}/package.json`));

// #1102: the upgrade-manifest gate, its test in test:scripts, and the client
// files entry that ships the manifest.
const UPGRADE_MANIFEST_GATE = 'node scripts/release/check-upgrade-manifest.mjs';
const UPGRADE_MANIFEST_TEST = 'scripts/release/check-upgrade-manifest.test.mjs';
const CLIENT_FILES = Object.freeze(['dist', 'README.md', 'LICENSE']);
// #1103: the runtime contract suite's own run, exactly; the runtime-contract CI family invokes it.
export const RUNTIME_CONTRACT_SCRIPT = 'vitest run --config src/__tests__/runtime-contract/vitest.config.ts';

// #927 drops the protocol version from the server description and declares
// the cloud-do test edge to client (its tests import client source).
const SERVER_DESCRIPTION = Object.freeze({
  from: 'BYOK SDK server: single-product, single-tenant embedded coordinator over @byok-sdk/cloud — wake-driven HTTP long-poll, protocol v2, memory or single-process SQLite storage.',
  to: 'BYOK SDK server: single-product, single-tenant embedded coordinator over @byok-sdk/cloud — wake-driven HTTP long-poll, memory or single-process SQLite storage.',
});
const CLOUD_DO_CLIENT_EDGE = '@byok-sdk/client';

const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// #793 D2 (owner O8): the private hosted (H) example. Its manifest has a fixed
// shape. It may only reuse workspaces and dependency specs that another
// workspace manifest already declares, so it adds no package and moves no version.
// #794 D3: the private Worker composition of H follows the same rule.
const HOSTED = Object.freeze({ dir: 'examples/hosted-bot-collaboration', name: '@byok-sdk/example-hosted-bot-collaboration' });
const HOSTED_WORKER = Object.freeze({ dir: 'examples/hosted-bot-collaboration-worker', name: '@byok-sdk/example-hosted-bot-collaboration-worker' });
const PRIVATE_HOSTED = Object.freeze([HOSTED, HOSTED_WORKER]);
const HOSTED_FIELDS = new Set(['name', 'version', 'private', 'type', 'description', 'scripts', 'dependencies', 'devDependencies']);
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies'];
// #793 D2a-0: the K8 entries that the hosted example imports. There is no root
// entry, so H never loads the K8 host (src/host.ts). The K8 rules still import
// the K4 root, which loads HostLedger and node:sqlite.
const K8_HOSTED_EXPORTS = Object.freeze({
  './rules/commands': './src/rules/commands.ts',
  './rules/commit': './src/rules/commit.ts',
  './model': './src/model.ts',
  './coalesce': './src/coalesce.ts',
  './team': './src/team.ts',
  './test-support': './src/commit-vectors.test-support.ts',
});
// #1106: K4 moves into @byok-sdk/server/execution-core. The example keeps only
// its daemon-backed test harness entry and a description that says so.
const K4_EXPORTS = Object.freeze({ '.': './src/index.ts', './canonical': './src/canonical.ts', './test-support': './src/test-support.ts' });
const K4_DEMO_EXPORTS = Object.freeze({ './test-support': './src/test-support.ts' });
const K4_DESCRIPTION = Object.freeze({
  from: 'Copy-and-own Host execution core with a durable FIFO, routine ledger and outbox',
  to: 'Demo Host composing @byok-sdk/server/execution-core with a real daemon; integration qualification for the published execution core',
});
// #1106: the published K4 entries, and the loader the server's forked K4 crash fixtures run under.
const SERVER_EXECUTION_CORE_EXPORTS = Object.freeze({
  './execution-core': { types: './dist/execution-core/index.d.ts', import: './dist/execution-core/index.js' },
  './execution-core/canonical': { types: './dist/execution-core/canonical.d.ts', import: './dist/execution-core/canonical.js' },
});
const SERVER_TSX = '^4.19.2';
// #1104: the single-file packaging entry, and the vitest runner of the packaging example's bundle test.
const CLIENT_PACKAGING_EXPORT = Object.freeze({ types: './dist/adapters/packaging.d.ts', import: './dist/adapters/packaging.js' });
const PACKAGING_VITEST = '^4.1.10';
// #793 D2g: the K8 retention rule and its shared vectors, added to the hosted
// entries for H's retention slice (owner question §53d).
const K8_RETENTION_EXPORTS = Object.freeze({
  './retention': './src/retention.ts',
  './retention-vectors': './src/retention-vectors.test-support.ts',
});
// #793 D2f-1: the K8 Bot routine policy and its shared vectors, added to the
// hosted and retention entries. src/routines.ts does not load the K8 host.
const K8_ROUTINE_EXPORTS = Object.freeze({
  './routines': './src/routines.ts',
  './routine-vectors': './src/routine-vectors.test-support.ts',
});
// #793 D2b-out-1: the K8 channel and delivery rules and their shared vectors, added
// to the hosted, retention and routine entries (owner question §54b). They do not
// load the K8 host.
const K8_DELIVERY_EXPORTS = Object.freeze({
  './channel': './src/channel.ts',
  './delivery': './src/delivery.ts',
  './delivery-routing': './src/delivery-routing.ts',
  './delivery-vectors': './src/delivery-vectors.test-support.ts',
});
// #975 slice 2: the K8 owner switch format, added to the hosted, retention,
// routine and delivery entries. src/migration.ts has no I/O and does not load
// the K8 host.
const K8_MIGRATION_EXPORTS = Object.freeze({ './migration': './src/migration.ts' });
// #975 slice 5: the L side of the owner switch, added on top of the migration
// entry, so the H tests can import an H export into an L tenant
// (importForSwitch, commitImport). src/switch.ts loads the K4 root entry, and
// with it node:sqlite (ledger.ts) and node:async_hooks (core.ts); it does not
// load the K8 host. Only H tests import it; H's src does not.
const K8_SWITCH_EXPORTS = Object.freeze({ './switch': './src/switch.ts' });
/** The other workspace manifests, each with its dir. */
function otherWorkspaceManifests(cwd, self) {
  const manifests = [];
  for (const prefix of ['packages', 'examples']) {
    if (!existsSync(resolve(cwd, prefix))) continue;
    for (const name of readdirSync(resolve(cwd, prefix))) {
      const dir = `${prefix}/${name}`, file = resolve(cwd, dir, 'package.json');
      if (dir !== self && existsSync(file)) manifests.push({ dir, manifest: JSON.parse(readFileSync(file, 'utf8')) });
    }
  }
  return manifests;
}
function verifyHostedManifest(manifest, cwd, example) {
  if (!plain(manifest) || Object.keys(manifest).some(key => !HOSTED_FIELDS.has(key))
    || manifest.name !== example.name || manifest.private !== true || manifest.type !== 'module' || !version(manifest.version)
    || (manifest.description !== undefined && typeof manifest.description !== 'string')
    || !isDeepStrictEqual(manifest.scripts, { typecheck: 'tsc --noEmit', test: 'vitest run' })) {
    throw new Error('Reviewed CI mapping required: the hosted example manifest has an unreviewed shape');
  }
  const others = otherWorkspaceManifests(cwd, example.dir);
  // A third-party spec must come from a workspace outside the private hosted examples, so they cannot vouch for each other.
  const declaring = others.filter(other => !PRIVATE_HOSTED.some(hosted => hosted.dir === other.dir));
  for (const field of DEPENDENCY_FIELDS) {
    if (manifest[field] === undefined) continue;
    if (!plain(manifest[field])) throw new Error('Reviewed CI mapping required: the hosted example manifest has an unreviewed shape');
    for (const [name, spec] of Object.entries(manifest[field])) {
      const reused = name.startsWith('@byok-sdk/')
        ? spec === 'workspace:*' && others.some(other => other.manifest.name === name)
        : declaring.some(other => DEPENDENCY_FIELDS.some(declared => other.manifest[declared]?.[name] === spec));
      if (!reused) throw new Error(`Reviewed CI mapping required: the hosted example may only reuse a declared dependency spec (${name})`);
    }
  }
  return manifest;
}
/** Admits a private hosted example's own lock rows when they match its reviewed manifest. Every other lock byte stays compared. */
function admitHostedLock(before, after, cwd, example) {
  const entry = after.workspaces?.[example.dir];
  if (entry === undefined) return;
  const manifest = verifyHostedManifest(JSON.parse(readFileSync(resolve(cwd, example.dir, 'package.json'), 'utf8')), cwd, example);
  const expected = { name: manifest.name, version: manifest.version };
  for (const field of DEPENDENCY_FIELDS) if (manifest[field] !== undefined) expected[field] = manifest[field];
  const row = [`${example.name}@workspace:${example.dir}`];
  if (!isDeepStrictEqual(entry, expected) || !isDeepStrictEqual(after.packages?.[example.name], row)
    || (before.packages?.[example.name] !== undefined && !isDeepStrictEqual(before.packages[example.name], row))) {
    throw new Error('Reviewed CI mapping required: the hosted example lock rows differ from its manifest');
  }
  delete before.workspaces[example.dir]; delete after.workspaces[example.dir];
  if (before.packages) delete before.packages[example.name];
  delete after.packages[example.name];
}

/** Returns the workspaces whose suites must qualify a reviewed dependency move. */
export function verifyReviewedContent(path, { base, cwd = process.cwd() } = {}) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base)) throw new Error('Content-sensitive impact requires exact CI_BASE');
  const hosted = PRIVATE_HOSTED.find(example => path === `${example.dir}/package.json`);
  const existed = execFileSync('git', ['ls-tree', '--name-only', base, '--', path], { cwd, encoding: 'utf8' }).trim() !== '';
  if (hosted && !existed) {
    // A new file has no base content, so the reviewed shape is the whole check.
    verifyHostedManifest(JSON.parse(readFileSync(resolve(cwd, path), 'utf8')), cwd, hosted);
    return [];
  }
  const beforeText = execFileSync('git', ['show', `${base}:${path}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const afterText = readFileSync(resolve(cwd, path), 'utf8');
  if (path === '.gitattributes') {
    // #603 pins both generated metadata and native build input bytes.
    // Admit only the reviewed additive LF rules, never unrelated attributes.
    const rule = 'packages/client/src/daemon/agent-memory-helper-release-pin.ts text eol=lf\n';
    const before = beforeText.replace(/\r\n/g, '\n');
    const after = afterText.replace(/\r\n/g, '\n');
    const nativeRules = 'packages/client/native/agent-memory-fs/*.go text eol=lf\n'
      + 'packages/client/native/agent-memory-fs/go.mod text eol=lf\n';
    const additions = [rule, nativeRules, rule + nativeRules];
    if (!additions.some(addition => after === before + addition
      && addition.trimEnd().split('\n').every(line => !before.split('\n').includes(line)))) {
      throw new Error('Reviewed CI mapping required: only the reviewed helper LF attributes may be added');
    }
    return [];
  }
  if (path === '.node-version') {
    // #702: every CI and release setup-node step reads this pin. Admit only one
    // exact X.Y.Z line: no range, alias, prefix, prerelease or second line.
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\n?$/.test(afterText)) {
      throw new Error('Reviewed CI mapping required: .node-version must hold one exact X.Y.Z version');
    }
    return [];
  }
  const parse = path === 'bun.lock' ? parseBunLock : JSON.parse;
  const qualify = [];
  const before = parse(beforeText), after = parse(afterText);
  if (path !== 'bun.lock') qualify.push(...normalizeDependencyVersions(before, after, path, cwd));
  if (path === 'bun.lock') {
    // Newly introduced hosted workspaces retain their shape/ownership gate.
    for (const example of PRIVATE_HOSTED) {
      if (!before.workspaces?.[example.dir] && after.workspaces?.[example.dir]) admitHostedLock(before, after, cwd, example);
    }
    return dependencyLockImpact(before, after, { cwd });
  } else if (path === 'examples/bot-collaboration/package.json') {
    if (before.private !== true || after.private !== true) throw new Error('The bot collaboration fixture must stay private');
    // #658: the private fixture cloud edge.
    if (before.devDependencies?.['@byok-sdk/cloud'] === undefined && after.devDependencies?.['@byok-sdk/cloud'] === 'workspace:*') {
      delete after.devDependencies['@byok-sdk/cloud'];
    }
    // #793 D2a-0: the K8 entries for the hosted example.
    if (before.exports === undefined && isDeepStrictEqual(after.exports, K8_HOSTED_EXPORTS)) delete after.exports;
    // #793 D2g: the retention entries, only on top of exactly the hosted entries.
    if (isDeepStrictEqual(before.exports, K8_HOSTED_EXPORTS) && isDeepStrictEqual(after.exports, { ...K8_HOSTED_EXPORTS, ...K8_RETENTION_EXPORTS })) {
      after.exports = before.exports;
    }
    // #793 D2f-1: the routine entries, only on top of exactly the hosted and retention entries.
    const retained = { ...K8_HOSTED_EXPORTS, ...K8_RETENTION_EXPORTS };
    if (isDeepStrictEqual(before.exports, retained) && isDeepStrictEqual(after.exports, { ...retained, ...K8_ROUTINE_EXPORTS })) {
      after.exports = before.exports;
    }
    // #793 D2b-out-1: the delivery entries, only on top of exactly the hosted, retention and routine entries.
    const routed = { ...retained, ...K8_ROUTINE_EXPORTS };
    if (isDeepStrictEqual(before.exports, routed) && isDeepStrictEqual(after.exports, { ...routed, ...K8_DELIVERY_EXPORTS })) {
      after.exports = before.exports;
    }
    // #975 slice 2: the migration entry, only on top of exactly the hosted, retention, routine and delivery entries.
    const delivered = { ...routed, ...K8_DELIVERY_EXPORTS };
    if (isDeepStrictEqual(before.exports, delivered) && isDeepStrictEqual(after.exports, { ...delivered, ...K8_MIGRATION_EXPORTS })) {
      after.exports = before.exports;
    }
    // #975 slice 5: the switch entry, only on top of exactly the entries up to and including the migration entry.
    const migrated = { ...delivered, ...K8_MIGRATION_EXPORTS };
    if (isDeepStrictEqual(before.exports, migrated) && isDeepStrictEqual(after.exports, { ...migrated, ...K8_SWITCH_EXPORTS })) {
      after.exports = before.exports;
    }
  } else if (path === 'examples/packaging/package.json') {
    if (before.private !== true || after.private !== true) throw new Error('The packaging example must stay private');
    // #1104: the bundle test, exactly its script and runner.
    if (before.scripts?.test === undefined && after.scripts?.test === 'vitest run') delete after.scripts.test;
    if (before.devDependencies?.vitest === undefined && after.devDependencies?.vitest === PACKAGING_VITEST) delete after.devDependencies.vitest;
  } else if (path === 'examples/host-execution-core/package.json') {
    if (before.private !== true || after.private !== true) throw new Error('The host execution core example must stay private');
    // #1106: the core entries leave together with the description, from exactly the old entries.
    if (isDeepStrictEqual(before.exports, K4_EXPORTS) && isDeepStrictEqual(after.exports, K4_DEMO_EXPORTS)
      && before.description === K4_DESCRIPTION.from && after.description === K4_DESCRIPTION.to) {
      after.exports = before.exports; after.description = before.description;
    }
  } else if (path === 'package.json') {
    // repo-harness owns its generated command scripts. Admit additions, removals
    // and edits whose old and new values both invoke repo-harness; every other
    // script and field stays in the deep comparison below.
    const harnessScript = value => typeof value === 'string' && value.startsWith('repo-harness ');
    for (const name of new Set([...Object.keys(before.scripts ?? {}), ...Object.keys(after.scripts ?? {})])) {
      const oldValue = before.scripts?.[name], newValue = after.scripts?.[name];
      if ((oldValue === undefined || harnessScript(oldValue)) && (newValue === undefined || harnessScript(newValue))) {
        delete before.scripts?.[name]; delete after.scripts?.[name];
      }
    }
    // #1102: the upgrade-manifest gate command, exactly.
    if (before.scripts?.['check:upgrade-manifest'] === undefined
      && after.scripts?.['check:upgrade-manifest'] === UPGRADE_MANIFEST_GATE) delete after.scripts['check:upgrade-manifest'];
    // #1094: admit only the exact additive setup-doc generator/check commands.
    for (const [name, command] of Object.entries({
      'docs:device-setup': 'node scripts/docs/device-setup.mjs --write',
      'check:device-setup': 'node scripts/docs/device-setup.mjs',
    })) {
      if (before.scripts?.[name] === undefined && after.scripts?.[name] === command) delete after.scripts[name];
    }
    const oldCommand = before.scripts?.['test:scripts'], newCommand = after.scripts?.['test:scripts'];
    const prefix = 'node --test --test-concurrency=1 ';
    if (!oldCommand?.startsWith(prefix) || !newCommand?.startsWith(prefix)) throw new Error('Unreviewed test command');
    const oldTests = oldCommand.slice(prefix.length).split(' '), newTests = newCommand.slice(prefix.length).split(' ');
    let index = 0;
    for (const test of newTests) {
      if (test === oldTests[index]) { index++; continue; }
      if (!(/^scripts\/ci\/[a-z0-9-]+\.test\.mjs$/.test(test) || test === UPGRADE_MANIFEST_TEST || test === 'scripts/architecture/dependency-graph.test.mjs' || test === 'scripts/docs/device-setup.test.mjs')
        || oldTests.includes(test) || !existsSync(resolve(cwd, test))) throw new Error('Only existing CI contract tests may be added');
    }
    if (index !== oldTests.length || new Set(newTests).size !== newTests.length) throw new Error('Existing tests must remain in order without duplicates');
    delete before.scripts['test:scripts']; delete after.scripts['test:scripts'];
  } else {
    if (!version(before.version) || !version(after.version)) throw new Error('Invalid package version');
    if (path === 'packages/client/package.json'
      && before.devDependencies?.esbuild === undefined
      && after.devDependencies?.esbuild === '0.28.1') {
      delete after.devDependencies.esbuild;
    }
    if (path === 'packages/client/package.json') {
      if (before.exports?.['./packaging'] === undefined && isDeepStrictEqual(after.exports?.['./packaging'], CLIENT_PACKAGING_EXPORT)) delete after.exports['./packaging'];
      const key = '#byok-hermes-session';
      const entry = { types: './dist/adapters/hermes/hermes-session-runtime.d.ts', default: './dist/adapters/hermes/hermes-session-runtime.js' };
      if (before.imports?.[key] === undefined && isDeepStrictEqual(after.imports?.[key], entry)) delete after.imports[key];
      const smoke = ' && node scripts/check-hermes-session-entry.mjs';
      if (typeof before.scripts?.build === 'string' && after.scripts?.build === before.scripts.build + smoke) after.scripts.build = before.scripts.build;
      if (before.scripts?.['test:runtime-contract'] === undefined && after.scripts?.['test:runtime-contract'] === RUNTIME_CONTRACT_SCRIPT) {
        delete after.scripts['test:runtime-contract'];
      }
      // #1102 ships the upgrade manifest in the client tarball: exactly one appended files entry.
      if (isDeepStrictEqual(before.files, CLIENT_FILES) && isDeepStrictEqual(after.files, [...CLIENT_FILES, 'upgrade-manifest.json'])) {
        after.files = before.files;
      }
      // #1094 ships the generated DaemonConfig schema beside the upgrade manifest: exactly one appended files entry.
      if (isDeepStrictEqual(before.files, [...CLIENT_FILES, 'upgrade-manifest.json'])
        && isDeepStrictEqual(after.files, [...CLIENT_FILES, 'upgrade-manifest.json', 'daemon-config.schema.json'])) {
        after.files = before.files;
      }
      // #635 adds the public transport-free test-double entry; its bundle is checked by check-adapters-entry.mjs.
      const testing = { types: './dist/testing/index.d.ts', import: './dist/testing/index.js' };
      if (before.exports?.['./testing'] === undefined && isDeepStrictEqual(after.exports?.['./testing'], testing)) delete after.exports['./testing'];
    }
    if (path === 'packages/keys/package.json') {
      // #636 adds one subpath for the generated pinned pi-ai catalog lookup.
      const key = './pi-catalog';
      const entry = { types: './dist/pi-catalog.d.ts', import: './dist/pi-catalog.js' };
      if (before.exports?.[key] === undefined && isDeepStrictEqual(after.exports?.[key], entry)) delete after.exports[key];
      // The browser-safe headless model-route subpath.
      const route = { types: './dist/model-route.d.ts', import: './dist/model-route.js' };
      if (before.exports?.['./model-route'] === undefined && isDeepStrictEqual(after.exports?.['./model-route'], route)) delete after.exports['./model-route'];
    }
    if (path === 'packages/core/package.json') {
      // #654 adds one subpath for sealed payload v1, so the root bundle does not grow.
      const key = './sealed-payload';
      const entry = { types: './dist/sealed-payload/index.d.ts', import: './dist/sealed-payload/index.js' };
      if (before.exports?.[key] === undefined && isDeepStrictEqual(after.exports?.[key], entry)) delete after.exports[key];
    }
    if (path === 'packages/server/package.json'
      && before.description === SERVER_DESCRIPTION.from && after.description === SERVER_DESCRIPTION.to) {
      after.description = before.description;
    }
    if (path === 'packages/protocol/package.json') {
      // #1106: the zod-free Agent memory Host contract, one runtime definition shared by client and server.
      const entry = { types: './dist/agent-memory.d.ts', import: './dist/agent-memory.js' };
      if (before.exports?.['./agent-memory'] === undefined && isDeepStrictEqual(after.exports?.['./agent-memory'], entry)) delete after.exports['./agent-memory'];
    }
    if (path === 'packages/server/package.json') {
      // #1106: the two K4 subpaths, added together, and tsx for the forked K4 crash fixtures.
      if (Object.keys(SERVER_EXECUTION_CORE_EXPORTS).every(key => before.exports?.[key] === undefined
        && isDeepStrictEqual(after.exports?.[key], SERVER_EXECUTION_CORE_EXPORTS[key]))) {
        for (const key of Object.keys(SERVER_EXECUTION_CORE_EXPORTS)) delete after.exports[key];
      }
      if (before.devDependencies?.tsx === undefined && after.devDependencies?.tsx === SERVER_TSX) delete after.devDependencies.tsx;
    }
    if (path === 'packages/cloud-do/package.json'
      && before.devDependencies?.[CLOUD_DO_CLIENT_EDGE] === undefined
      && after.devDependencies?.[CLOUD_DO_CLIENT_EDGE] === 'workspace:*') {
      delete after.devDependencies[CLOUD_DO_CLIENT_EDGE];
      qualify.push('packages/cloud-do');
    }
    // #702 raises the public Node floor with the Node 24.22.1 pin. Admit only
    // this exact engines.node edit in a public manifest. Any other engines value
    // or key, and any other field, still fails the comparison below.
    if (publicManifests.includes(path)
      && before.engines?.node === '>=24.15.0'
      && after.engines?.node === '>=24.22.1') {
      after.engines.node = before.engines.node;
    }
    const dir = path.slice(0, -'/package.json'.length);
    delete before.version; delete after.version;
  }
  if (!isDeepStrictEqual(before, after)) throw new Error(`Reviewed CI mapping required: ${path} changes more than the reviewed fields`);
  return qualify;
}

/** A `bin:<name>` entry belongs to the one workspace package whose manifest declares that bin. */
function binOwner(name, cwd) {
  const owners = readdirSync(resolve(cwd, 'packages')).filter(dir => {
    const manifest = resolve(cwd, 'packages', dir, 'package.json');
    return existsSync(manifest) && Object.hasOwn(JSON.parse(readFileSync(manifest, 'utf8')).bin ?? {}, name);
  });
  if (owners.length !== 1) throw new Error(`Reviewed CI mapping required: unmapped API entry bin:${name}`);
  return `packages/${owners[0]}`;
}

export function changedApiOwners({ base, cwd = process.cwd() } = {}) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base)) throw new Error('API impact requires exact CI_BASE');
  const before = JSON.parse(execFileSync('git', ['show', `${base}:api-surface/entries.json`], { cwd, encoding: 'utf8' }));
  const after = JSON.parse(readFileSync(resolve(cwd, 'api-surface/entries.json'), 'utf8'));
  const owners = new Set();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isDeepStrictEqual(before[key], after[key])) continue;
    const bin = /^bin:([a-z0-9-]+)$/.exec(key);
    if (bin) { owners.add(binOwner(bin[1], cwd)); continue; }
    const match = /^@byok-sdk\/([a-z-]+)(?:[/#]|$)/.exec(key);
    if (!match) throw new Error(`Reviewed CI mapping required: unmapped API entry ${key}`);
    owners.add(`packages/${match[1]}`);
  }
  return [...owners];
}
