import { assertImplementationIdentityDependency } from './implementation-identity-edges.mjs';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertInstalledPiRuntime, iterateTarballFiles, parsePiRuntimeIdentity, PI_DEPENDENCY_SPECIFIER, readLockedPiClosure,
} from './pi-runtime-identity.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// Version authority: the manifests, never a constant here. The release train
// version is whatever packages/core ships, keys versions independently, and
// the pi pin comes from packages/client, parsed by the one shared Pi runtime
// identity reader. Every assertion below compares against these derived values.
const exactReleaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const releaseVersion = JSON.parse(readFileSync(path.join(repoRoot, 'packages/core/package.json'), 'utf8')).version;
const keysVersion = JSON.parse(readFileSync(path.join(repoRoot, 'packages/keys/package.json'), 'utf8')).version;
const piRuntime = parsePiRuntimeIdentity(
  JSON.parse(readFileSync(path.join(repoRoot, 'packages/client/package.json'), 'utf8')),
);
if (typeof releaseVersion !== 'string' || !exactReleaseVersion.test(releaseVersion)) {
  throw new Error('packages/core/package.json: version must be an exact SemVer release train version');
}
if (typeof keysVersion !== 'string' || !exactReleaseVersion.test(keysVersion)) {
  throw new Error('packages/keys/package.json: version must be an exact SemVer independent version');
}
const packages = [
  { name: '@byok-sdk/core', directory: 'packages/core' },
  { name: '@byok-sdk/implementation-identity', directory: 'packages/implementation-identity' },
  { name: '@byok-sdk/protocol', directory: 'packages/protocol' },
  { name: '@byok-sdk/server', directory: 'packages/server' },
  { name: '@byok-sdk/cloud', directory: 'packages/cloud' },
  { name: '@byok-sdk/client', directory: 'packages/client' },
  { name: '@byok-sdk/cloud-dataplane', directory: 'packages/cloud-dataplane' },
  { name: '@byok-sdk/ui-runtime', directory: 'packages/ui-runtime' },
  { name: '@byok-sdk/keys', directory: 'packages/keys' },
];
const expectedPackageVersions = Object.fromEntries(
  packages.map(({ name }) => [name, name === '@byok-sdk/keys' ? keysVersion : releaseVersion]),
);
const nodeBin = process.execPath;
const bunBin = process.platform === 'win32' ? 'bun.exe' : 'bun';
const npmCliPath = path.join(path.dirname(nodeBin), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmInvocation = process.platform === 'win32'
  ? { command: nodeBin, prefix: [npmCliPath] }
  : { command: 'npm', prefix: [] };
if (process.platform === 'win32' && !existsSync(npmCliPath)) {
  throw new Error(`Windows npm CLI entrypoint is missing: ${npmCliPath}`);
}
const outArgIndex = process.argv.indexOf('--out-dir');
const requestedOut = outArgIndex >= 0 ? process.argv[outArgIndex + 1] : undefined;
if (outArgIndex >= 0 && (!requestedOut || requestedOut.startsWith('--'))) {
  throw new Error('--out-dir requires a path');
}
const ephemeralRoot = requestedOut ? undefined : mkdtempSync(path.join(os.tmpdir(), 'byok-release-pack-'));
const outDir = path.resolve(repoRoot, requestedOut ?? path.join(ephemeralRoot, 'artifacts'));

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function sha512Integrity(filePath) {
  return `sha512-${createHash('sha512').update(readFileSync(filePath)).digest('base64')}`;
}

// --- Release asset guarantee: the migration SQL a runner needs must ship WITH
// the runner. `@byok-sdk/cloud-dataplane` exports `migrate(pool, directory)`, and
// until the build projected `deploy/sql` into `dist/sql` the tarball carried the
// runner and none of the files it runs — an install-time hole no import smoke
// can see. `deploy/sql` stays the only place migrations are authored; `dist/sql`
// is a generated copy, so the only thing that keeps them honest is this
// comparison. It is deliberately BIDIRECTIONAL and content-addressed: a missing
// file, an extra file, and an edited file each fail, and nothing here hardcodes
// how many migrations exist.

const deploySqlDir = path.join(repoRoot, 'deploy', 'sql');
const TARBALL_SQL_PREFIX = 'package/dist/sql/';

/** The authoring authority's current contents, keyed by filename. */
function readDeploySql() {
  const files = readdirSync(deploySqlDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) throw new Error(`no .sql files found in ${deploySqlDir}`);
  return new Map(files.map((name) => [name, sha256(path.join(deploySqlDir, name))]));
}

function readTarballDigests(tarballPath) {
  const digests = new Map();
  for (const [name, body] of iterateTarballFiles(tarballPath)) {
    digests.set(name, createHash('sha256').update(body).digest('hex'));
  }
  return digests;
}

function readTarballEntry(tarballPath, entryName) {
  for (const [name, body] of iterateTarballFiles(tarballPath)) {
    if (name === entryName) return body;
  }
  return undefined;
}

function assertTarballCarriesMigrations(tarballPath) {
  const expected = readDeploySql();
  const digests = readTarballDigests(tarballPath);
  const actual = new Map(
    [...digests]
      .filter(([entry]) => entry.startsWith(TARBALL_SQL_PREFIX))
      .map(([entry, digest]) => [entry.slice(TARBALL_SQL_PREFIX.length), digest]),
  );

  const missing = [...expected.keys()].filter((name) => !actual.has(name));
  const extra = [...actual.keys()].filter((name) => !expected.has(name));
  const modified = [...expected]
    .filter(([name, digest]) => actual.has(name) && actual.get(name) !== digest)
    .map(([name]) => name);
  if (missing.length > 0 || extra.length > 0 || modified.length > 0) {
    throw new Error(
      `${path.basename(tarballPath)} does not carry deploy/sql byte-for-byte under dist/sql/:\n` +
        `  missing: ${missing.join(', ') || '(none)'}\n` +
        `  extra: ${extra.join(', ') || '(none)'}\n` +
        `  modified: ${modified.join(', ') || '(none)'}`,
    );
  }
  console.log(`[release-pack] ${path.basename(tarballPath)} carries ${expected.size} migration(s) matching deploy/sql`);
  return [...expected.keys()];
}

// --- Frozen-artifact dependency edge guard: `bun pm pack` rewrites
// `workspace:*` edges from bun.lock's workspace records, not from the
// manifests, so a stale lockfile publishes tarballs whose internal @byok-sdk
// edges point at the previous train — the split registry graph v0.4.1 shipped
// with. The packed package.json is the only artifact that proves what npm will
// actually resolve, so every internal edge is asserted at pack time.
function assertTarballInternalEdges(tarballPath, packageName, expectedPackageVersion) {
  const entry = readTarballEntry(tarballPath, 'package/package.json');
  if (entry === undefined) throw new Error(`${path.basename(tarballPath)}: carries no package/package.json`);
  const packed = JSON.parse(entry.toString('utf8'));
  if (packed.name !== packageName) {
    throw new Error(`${path.basename(tarballPath)}: packed name is ${packed.name}, expected ${packageName}`);
  }
  if (packed.version !== expectedPackageVersion) {
    throw new Error(`${path.basename(tarballPath)}: packed version is ${packed.version}, expected ${expectedPackageVersion}`);
  }
  if (packageName === '@byok-sdk/keys' && packed.dependencies?.['@byok-sdk/core'] !== releaseVersion) {
    throw new Error(
      `${path.basename(tarballPath)}: packed keys dependency @byok-sdk/core is ` +
        `${packed.dependencies?.['@byok-sdk/core'] ?? '(missing)'}, expected ${releaseVersion}; ` +
        'the artifact must carry a published core version, not a workspace override',
    );
  }
  if (packageName === '@byok-sdk/client' || packageName === '@byok-sdk/keys') {
    assertImplementationIdentityDependency(packed, releaseVersion);
  }
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [dependency, range] of Object.entries(packed[field] ?? {})) {
      if (dependency.startsWith('@byok-sdk/')) {
        if (range !== releaseVersion) {
          throw new Error(
            `${path.basename(tarballPath)}: ${field}.${dependency} is ${range}, expected ${releaseVersion} — ` +
              'bun.lock workspace records were stale when this tarball was packed',
          );
        }
      }
    }
  }
  console.log(`[release-pack] ${path.basename(tarballPath)} internal @byok-sdk edges all pin ${releaseVersion}`);
}

/**
 * Asserts an install tree's @byok-sdk graph closes to exactly one version set:
 * every installed @byok-sdk package sits at the release version, and no copy
 * hides under a second node_modules — the nested-copy fallback npm takes when
 * published internal edges disagree. The retired `byok-sdk` umbrella is still
 * collected, so any artifact that drags it back in fails as an unexpected
 * package. Follows node_modules chains only, so the walk stays cheap on large
 * trees.
 */
function assertSingleVersionSet(installDirectory, expectedVersions) {
  const root = path.join(installDirectory, 'node_modules');
  const found = [];
  const visit = (nodeModulesDirectory) => {
    const retiredUmbrella = path.join(nodeModulesDirectory, 'byok-sdk', 'package.json');
    if (existsSync(retiredUmbrella)) found.push(retiredUmbrella);
    const scope = path.join(nodeModulesDirectory, '@byok-sdk');
    if (existsSync(scope)) {
      for (const entry of readdirSync(scope)) {
        const manifest = path.join(scope, entry, 'package.json');
        if (existsSync(manifest)) found.push(manifest);
      }
    }
    for (const entry of readdirSync(nodeModulesDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (entry.name.startsWith('@')) {
        for (const scoped of readdirSync(path.join(nodeModulesDirectory, entry.name))) {
          const nested = path.join(nodeModulesDirectory, entry.name, scoped, 'node_modules');
          if (existsSync(nested)) visit(nested);
        }
        continue;
      }
      const nested = path.join(nodeModulesDirectory, entry.name, 'node_modules');
      if (existsSync(nested)) visit(nested);
    }
  };
  visit(root);
  if (found.length === 0) throw new Error(`${installDirectory}: no @byok-sdk packages found under node_modules`);
  const allowedParents = new Set([path.join(root, 'byok-sdk')]);
  const scopeRoot = path.join(root, '@byok-sdk');
  if (existsSync(scopeRoot)) {
    for (const entry of readdirSync(scopeRoot)) allowedParents.add(path.join(scopeRoot, entry));
  }
  const nestedCopies = found.filter((manifestPath) => !allowedParents.has(path.dirname(manifestPath)));
  if (nestedCopies.length > 0) {
    throw new Error(`split @byok-sdk version set — nested copies installed:\n  ${nestedCopies.join('\n  ')}`);
  }
  const seenNames = new Set();
  for (const manifestPath of found) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const expected = expectedVersions[manifest.name];
    if (typeof expected !== 'string') {
      throw new Error(`${manifestPath}: unexpected @byok-sdk package ${manifest.name} in the release install`);
    }
    if (manifest.version !== expected) {
      throw new Error(`${manifestPath}: version ${manifest.version}, expected ${expected} — the @byok-sdk graph does not close to its exact package versions`);
    }
    seenNames.add(manifest.name);
  }
  for (const packageName of Object.keys(expectedVersions)) {
    if (!seenNames.has(packageName)) {
      throw new Error(`${installDirectory}: missing expected release package ${packageName}`);
    }
  }
  console.log(`[release-pack] install tree closes to exact package versions (${found.length} package(s))`);
}

function assertNpmCoreClosure(installDirectory) {
  const tree = JSON.parse(run(npmInvocation.command, [...npmInvocation.prefix, 'ls', '@byok-sdk/core', '--all', '--json'], installDirectory));
  const versions = new Set();
  function collect(value) {
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [name, entry] of Object.entries(value)) {
      if (name === '@byok-sdk/core' && entry && typeof entry === 'object' && typeof entry.version === 'string') {
        versions.add(entry.version);
      }
      collect(entry);
    }
  }
  collect(tree);
  if (versions.size !== 1 || !versions.has(releaseVersion)) {
    throw new Error(
      `npm ls @byok-sdk/core --all --json resolved ${[...versions].sort().join(', ') || '(none)'}, expected only ${releaseVersion}`,
    );
  }
  console.log(`[release-pack] npm ls @byok-sdk/core --all --json resolves only ${releaseVersion}`);
}

// Exercise the SDK-owned factory from its installed private dist artifact.
// Native readback is distribution evidence, not implementation-identity attestation.
function runInstalledFffSmoke(installDirectory) {
  const probePath = path.join(installDirectory, 'fff-packed-smoke.mjs');
  const tempDirectory = path.join(installDirectory, 'fff-temp');
  mkdirSync(tempDirectory);
  writeFileSync(probePath, String.raw`
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const installRoot = realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const installedPath = (file) => {
  const resolved = realpathSync(file);
  assert.ok(resolved.startsWith(installRoot + path.sep), 'resolved outside isolated install: ' + resolved);
  return resolved;
};
const manifest = (resolver, name) => {
  // Some peers hide package.json in exports. Read the first physical package
  // on this importer's Node resolution path instead of importing a hidden subpath.
  const candidate = resolver.resolve.paths(name).map((base) => path.join(base, name, 'package.json')).find(existsSync);
  assert.ok(candidate, 'missing installed package ' + name);
  const file = installedPath(candidate);
  const value = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(value.name, name);
  return { file, value };
};
const client = manifest(require, '@byok-sdk/client');
const clientRequire = createRequire(client.file);
const expectedVersion = client.value.dependencies['@ff-labs/pi-fff'];
assert.match(expectedVersion, /^\d+\.\d+\.\d+$/, 'client must pin FFF exactly');
const extension = manifest(clientRequire, '@ff-labs/pi-fff');
assert.equal(extension.value.version, expectedVersion);
const extensionRequire = createRequire(extension.file);
// These satisfy the unexecuted npm TS source package's peer declarations.
// The SDK factory is bundled: its actual TUI binding is checked below instead.
const sourcePeers = Object.fromEntries(['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']
  .map((name) => [name, manifest(extensionRequire, name).value.version]));
const nativeManifests = {};
for (const name of ['@ff-labs/fff-node', '@ff-labs/fff-bun']) {
  const installed = manifest(extensionRequire, name);
  assert.equal(installed.value.version, extension.value.dependencies[name], name);
  nativeManifests[name] = installed;
}
const nativeRequire = createRequire(nativeManifests['@ff-labs/fff-node'].file);
const nativeManifest = nativeManifests['@ff-labs/fff-node'];
const nativeEntry = installedPath(path.join(path.dirname(nativeManifest.file), nativeManifest.value.exports['.'].import));
const native = await import(pathToFileURL(nativeEntry).href);
const binaryPackage = manifest(nativeRequire, native.getNpmPackageName());
assert.equal(binaryPackage.value.version, nativeManifests['@ff-labs/fff-node'].value.optionalDependencies[binaryPackage.value.name]);
const binaryPath = installedPath(native.findBinary());
assert.equal(binaryPath, installedPath(path.join(path.dirname(binaryPackage.file), native.getLibFilename())), 'native must load the npm platform binary');
native.FileFinder.ensureLoaded();
const ffi = manifest(nativeRequire, 'ffi-rs');
const ffiRequire = createRequire(ffi.file);
const addons = Object.keys(require.cache).filter((file) => file.endsWith('.node') && path.basename(file).startsWith('ffi-rs.'));
assert.equal(addons.length, 1, 'expected one actually loaded ffi-rs platform addon');
const addonPath = installedPath(addons[0]);
const addonManifestPath = installedPath(path.join(path.dirname(addonPath), 'package.json'));
const addon = JSON.parse(readFileSync(addonManifestPath, 'utf8'));
assert.equal(addon.version, ffi.value.optionalDependencies[addon.name]);
assert.equal(installedPath(ffiRequire.resolve(addon.name)), addonPath);
const lock = JSON.parse(readFileSync(path.join(installRoot, 'package-lock.json'), 'utf8'));
for (const entry of [client, extension, ...Object.values(nativeManifests), binaryPackage, ffi, {file: addonManifestPath, value: addon}]) {
  const key = path.relative(installRoot, path.dirname(entry.file)).split(path.sep).join('/');
  assert.equal(lock.packages[key].version, entry.value.version, key);
  assert.ok(lock.packages[key].resolved, key + ' has no npm resolution readback');
  assert.match(lock.packages[key].integrity, /^sha512-/, key + ' has no npm integrity readback');
}
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
console.log('[release-pack] installed FFF native readback ' + JSON.stringify({
  extension: extension.value.version, node: nativeManifests['@ff-labs/fff-node'].value.version,
  bun: nativeManifests['@ff-labs/fff-bun'].value.version, platform: process.platform, arch: process.arch,
  runtime: process.version, binary: binaryPackage.value.name, binarySha256: digest(binaryPath),
  ffi: ffi.value.version, addon: addon.name, addonSha256: digest(addonPath), attested: false,
}));

const factoryEntry = installedPath(path.join(path.dirname(client.file), 'dist/adapters/pi/fff-extension.js'));
const factorySource = readFileSync(factoryEntry, 'utf8');
const factoryMap = JSON.parse(readFileSync(installedPath(factoryEntry + '.map'), 'utf8'));
const tuiSources = factoryMap.sources.filter((source) => source.includes('/@earendil-works/pi-tui/'));
assert.ok(tuiSources.length > 0, 'FFF factory lacks bundled TUI provenance');
for (const source of tuiSources) {
  assert.ok(source.includes('/@earendil-works+pi-tui@' + client.value.byok.piRuntimePin + '/node_modules/'),
    'FFF factory bundled TUI provenance differs from the client pin: ' + source);
}
assert.doesNotMatch(factorySource, /\b(?:from|import)\s*['"]@earendil-works\/pi-tui(?:\/[^'"]*)?['"]|\b(?:import|require)\s*\(\s*['"]@earendil-works\/pi-tui(?:\/[^'"]*)?['"]/, 'FFF factory must inline its TUI binding');
console.log('[release-pack] installed FFF factory TUI bundle provenance ' + JSON.stringify({
  version: client.value.byok.piRuntimePin, sources: tuiSources.length, sourcePeers, unbundledExtensionExecuted: false, attested: false,
}));
const { createByokFffExtension } = await import(pathToFileURL(factoryEntry).href);
assert.equal(typeof createByokFffExtension, 'function');
const { createAgentSession, createAgentSessionRuntime, createAgentSessionServices, SessionManager } = await import('@earendil-works/pi-coding-agent');
const { validateToolArguments } = await import('@earendil-works/pi-ai');
const cwd = path.join(installRoot, 'fff-workspace');
const agentDir = path.join(installRoot, 'fff-agent');
mkdirSync(path.join(cwd, 'src'), { recursive: true });
mkdirSync(agentDir);
writeFileSync(path.join(cwd, 'src/alpha-search.ts'), 'export const token = "FFF_PACKED_SEARCH_TOKEN";\n');
mkdirSync(path.join(cwd, 'ignored'));
writeFileSync(path.join(cwd, '.gitignore'), 'ignored/\n');
writeFileSync(path.join(cwd, 'ignored/secret.ts'), 'FFF_PACKED_IGNORED_TOKEN\n');
execFileSync('git', ['init', '--quiet'], { cwd });
execFileSync('git', ['add', '.'], { cwd });
const errors = [];
let session;
let runtimeHost;
try {
  runtimeHost = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
    const services = await createAgentSessionServices({ cwd, agentDir,
    modelRuntimeSignal: AbortSignal.timeout(15000),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [createByokFffExtension()] },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const result = await createAgentSession({ cwd, agentDir, sessionManager,
    modelRuntime: services.modelRuntime, settingsManager: services.settingsManager, resourceLoader: services.resourceLoader,
    tools: ['fffind', 'ffgrep'],
    });
    return { ...result, services, diagnostics: [] };
  }, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
  session = runtimeHost.session;
  await session.bindExtensions({ mode: 'rpc', onError: (error) => errors.push(error) });
  assert.deepEqual(session.getActiveToolNames().sort(), ['fffind', 'ffgrep']);
  const execute = async (name, args) => {
    const tool = session.agent.state.tools.find((entry) => entry.name === name);
    assert.ok(tool, name + ' missing from installed Pi registry');
    const call = { type: 'toolCall', id: 'packed-' + name, name, arguments: args };
    const result = await tool.execute(call.id, validateToolArguments(tool, call), AbortSignal.timeout(15000));
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.content.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');
  };
  assert.match(await execute('fffind', { pattern: 'alpha search' }), /src\/alpha-search\.ts/);
  const grep = await execute('ffgrep', { pattern: 'FFF_PACKED_SEARCH_TOKEN' });
  assert.match(grep, /src\/alpha-search\.ts/);
  assert.match(grep, /FFF_PACKED_SEARCH_TOKEN/);
  assert.match(await execute('ffgrep', { pattern: 'FFF_PACKED_IGNORED_TOKEN', mode: 'plain' }), /No matches found/);
  assert.deepEqual(errors, []);
} finally {
  await runtimeHost?.dispose();
}
assert.deepEqual(readdirSync(process.env.TMPDIR), [], 'owned native directories remain after shutdown');
console.log('[release-pack] installed SDK-owned FFF factory real find/grep, ignored-file negative control and shutdown cleanup passed; prompts=0; attested=false');
`);
  const result = spawnSync(nodeBin, [probePath], {
    cwd: installDirectory, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, NODE_PATH: '', TMPDIR: tempDirectory, TMP: tempDirectory, TEMP: tempDirectory,
      PI_CODING_AGENT_DIR: path.join(installDirectory, 'fff-agent'),
      XDG_CACHE_HOME: path.join(installDirectory, 'fff-cache'), XDG_DATA_HOME: path.join(installDirectory, 'fff-data') },
  });
  if (result.status !== 0) {
    throw new Error(`installed FFF smoke failed (${result.status})\n${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  }
  console.log(result.stdout.trim());
}

function runStaleKeysEdgeNegativeControl() {
  const fixturePath = path.join(repoRoot, 'scripts', 'release', 'fixtures', 'keys-0.2.0-stale-core-edge.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const staleCoreVersion = fixture.dependencies?.['@byok-sdk/core'];
  if (
    fixture.schemaVersion !== 1 ||
    fixture.package !== '@byok-sdk/keys' ||
    fixture.version !== '0.2.0' ||
    staleCoreVersion !== '0.4.2'
  ) {
    throw new Error(`${fixturePath}: stale registry edge fixture identity is invalid`);
  }

  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'byok-stale-keys-edge-'));
  try {
    const tarballDirectory = path.join(fixtureRoot, 'tarballs');
    mkdirSync(tarballDirectory);
    writeFileSync(
      path.join(fixtureRoot, 'package.json'),
      `${JSON.stringify({ name: fixture.package, version: fixture.version, dependencies: fixture.dependencies }, null, 2)}\n`,
    );
    run(npmInvocation.command, [...npmInvocation.prefix, 'pack', '--pack-destination', tarballDirectory], fixtureRoot);
    const tarballs = readdirSync(tarballDirectory).filter((entry) => entry.endsWith('.tgz'));
    if (tarballs.length !== 1) throw new Error(`${fixturePath}: expected one synthetic stale keys tarball, found ${tarballs.length}`);
    let rejection;
    try {
      assertTarballInternalEdges(path.join(tarballDirectory, tarballs[0]), fixture.package, fixture.version);
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }
    const expected = `packed keys dependency @byok-sdk/core is ${staleCoreVersion}, expected ${releaseVersion}`;
    if (!rejection?.includes(expected)) {
      throw new Error(`${fixturePath}: stale keys edge was not rejected as expected; got ${rejection ?? '(no rejection)'}`);
    }
    console.log(`[release-pack] negative control detected the registry ${fixture.package}@${fixture.version} -> @byok-sdk/core@${staleCoreVersion} stale edge`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function runStaleImplementationIdentityNegativeControl() {
  const dependency = '@byok-sdk/implementation-identity';
  const stale = releaseVersion === '0.0.0' ? '0.0.1' : '0.0.0';
  for (const name of ['@byok-sdk/client', '@byok-sdk/keys']) {
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'byok-stale-identity-edge-'));
    try {
      const version = expectedPackageVersions[name];
      const tarballDirectory = path.join(fixtureRoot, 'tarballs');
      mkdirSync(tarballDirectory);
      writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({
        name, version, dependencies: { '@byok-sdk/core': releaseVersion, [dependency]: stale },
      }));
      run(npmInvocation.command, [...npmInvocation.prefix, 'pack', '--pack-destination', tarballDirectory], fixtureRoot);
      const tarballs = readdirSync(tarballDirectory).filter((entry) => entry.endsWith('.tgz'));
      if (tarballs.length !== 1) throw new Error(`${name}: negative control must produce one tarball`);
      let rejection;
      try {
        assertTarballInternalEdges(path.join(tarballDirectory, tarballs[0]), name, version);
      } catch (error) {
        rejection = error instanceof Error ? error.message : String(error);
      }
      if (!rejection?.includes(`dependency ${dependency} is ${stale}, expected ${releaseVersion}`)) {
        throw new Error(`${name}: stale shared identity edge was not rejected: ${rejection ?? '(no rejection)'}`);
      }
      console.log(`[release-pack] negative control rejected ${name} packed identity edge ${stale}`);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
}

if (process.argv.includes('--self-test-stale-identity-edge')) {
  runStaleImplementationIdentityNegativeControl();
  process.exit(0);
}

if (process.argv.includes('--self-test-stale-keys-edge')) {
  runStaleKeysEdgeNegativeControl();
  process.exit(0);
}

// sourceGitSha must identify the exact artifact contents: refuse to pack a dirty worktree.
const worktreeStatus = run('git', [
  'status',
  '--porcelain=v1',
  '--untracked-files=all',
]);

if (worktreeStatus !== '') {
  throw new Error(
    'release pack requires a clean worktree so sourceGitSha identifies the exact artifact contents; commit or remove these changes before packing:\n' +
      worktreeStatus,
  );
}

try {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`release output directory must be empty: ${outDir}`);
  }
  mkdirSync(outDir, { recursive: true });
  run(nodeBin, ['scripts/release/check-package-graph.mjs']);
  runStaleImplementationIdentityNegativeControl();
  run(bunBin, ['run', 'build']);

  const tarballs = [];
  let migrationFiles;
  for (const { name: packageName, directory } of packages) {
    const before = new Set(readdirSync(outDir));
    run(bunBin, ['pm', 'pack', '--destination', outDir], path.join(repoRoot, directory));
    const created = readdirSync(outDir).filter((entry) => entry.endsWith('.tgz') && !before.has(entry));
    if (created.length !== 1) throw new Error(`${packageName}: expected one tarball, created ${created.length}`);
    const file = created[0];
    const tarballPath = path.join(outDir, file);
    const expectedPackageVersion = packageName === '@byok-sdk/keys' ? keysVersion : releaseVersion;
    assertTarballInternalEdges(tarballPath, packageName, expectedPackageVersion);
    if (packageName === '@byok-sdk/cloud-dataplane') {
      migrationFiles = assertTarballCarriesMigrations(tarballPath);
    }
    tarballs.push({
      package: packageName,
      version: expectedPackageVersion,
      file,
      sha256: sha256(tarballPath),
      sha512Integrity: sha512Integrity(tarballPath),
    });
  }

  const smokeDir = mkdtempSync(path.join(os.tmpdir(), 'byok-release-install-'));
  try {
    const smokeArtifactsDir = path.join(smokeDir, 'artifacts');
    mkdirSync(smokeArtifactsDir);
    for (const entry of tarballs) {
      copyFileSync(path.join(outDir, entry.file), path.join(smokeArtifactsDir, entry.file));
    }
    const dependencies = Object.fromEntries(
      tarballs.map((entry) => [entry.package, `file:./artifacts/${entry.file}`]),
    );
    writeFileSync(
      path.join(smokeDir, 'package.json'),
      `${JSON.stringify({ name: 'byok-release-smoke', private: true, type: 'module', dependencies }, null, 2)}\n`,
    );
    run(npmInvocation.command, [...npmInvocation.prefix, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], smokeDir);
    runInstalledFffSmoke(smokeDir);
    writeFileSync(
      path.join(smokeDir, 'smoke.mjs'),
      `import assert from 'node:assert/strict';\n` +
        `import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';\n` +
        `import { createRequire } from 'node:module';\n` +
        `import { tmpdir } from 'node:os';\n` +
        `import path from 'node:path';\n` +
        `const require = createRequire(import.meta.url);\n` +
        `for (const name of ['@byok-sdk/core','@byok-sdk/protocol','@byok-sdk/client','@byok-sdk/client/adapters','@byok-sdk/client/agent-memory','@byok-sdk/client/assertion-client','@byok-sdk/client/mcp-server','@byok-sdk/server','@byok-sdk/cloud','@byok-sdk/cloud-dataplane','@byok-sdk/cloud-dataplane/runtime','@byok-sdk/ui-runtime','@byok-sdk/keys']) await import(name);\n` +
        `const { AgentHomeBusyError, AgentHomeManager } = await import('@byok-sdk/client');\n` +
        `const parallelRoot = mkdtempSync(path.join(tmpdir(), 'byok-packed-agent-session-'));\n` +
        `try {\n` +
        `  const manager = new AgentHomeManager({ hostStorageRoot: parallelRoot });\n` +
        `  const agentRef = { agentId: 'packed-parallel-agent', profileRevision: 'profile-1' };\n` +
        `  const first = await manager.acquireExecution(agentRef, { taskId: 'task-one', sessionRef: 'session-one' });\n` +
        `  const second = await manager.acquireExecution(agentRef, { taskId: 'task-two', sessionRef: 'session-two' });\n` +
        `  assert.equal(first.lease.canonicalHome, second.lease.canonicalHome);\n` +
        `  assert.equal(first.lease.homeIdentity, second.lease.homeIdentity);\n` +
        `  await assert.rejects(\n` +
        `    manager.acquireExecution(agentRef, { taskId: 'task-one-retry', sessionRef: 'session-one' }),\n` +
        `    AgentHomeBusyError,\n` +
        `  );\n` +
        `  await assert.rejects(first.lease.bindSession('session-one-mismatch'), AgentHomeBusyError);\n` +
        `  await assert.rejects(\n` +
        `    manager.acquireExecution(agentRef, { taskId: 'task-one-after-mismatch', sessionRef: 'session-one' }),\n` +
        `    AgentHomeBusyError,\n` +
        `  );\n` +
        `  await first.lease.release();\n` +
        `  await assert.rejects(manager.acquire(agentRef), AgentHomeBusyError);\n` +
        `  await second.lease.release();\n` +
        `  const quiescent = await manager.acquire(agentRef);\n` +
        `  await quiescent.lease.release();\n` +
        `} finally {\n` +
        `  rmSync(parallelRoot, { recursive: true, force: true });\n` +
        `}\n` +
        `console.log('[release-pack] installed Agent sessions parallelize by session and serialize duplicates');\n` +
        // The embedded-host memory subpath is the one entry whose VALUE is what
        // it does not carry: an embedded product imports it precisely to avoid
        // the daemon composition and the WebSocket transport the root entry
        // pulls in. Proving that from the installed tarball is the only place
        // the guarantee is real for a downstream consumer.
        `const agentMemory = await import('@byok-sdk/client/agent-memory');\n` +
        `assert.equal(typeof agentMemory.AgentMemoryService, 'function');\n` +
        `assert.equal(typeof agentMemory.serveAgentMemoryMcpOverStdio, 'function');\n` +
        `assert.equal('connectControlClient' in agentMemory, false);\n` +
        `assert.equal('createDaemon' in agentMemory, false);\n` +
        // Same argument for the assertion sub-path, and its value is likewise
        // what it does NOT carry: a Host toolset server imports it precisely to
        // request an assertion without the daemon graph — which drags
        // `@modelcontextprotocol/client` and, through pi, `ajv`'s `new Function`
        // provider in. Only the installed tarball proves that for a consumer.
        `const assertionClient = await import('@byok-sdk/client/assertion-client');\n` +
        `assert.deepEqual(Object.keys(assertionClient).sort(), ['requestDeviceAssertion','requestTaskAssertion']);\n` +
        `const assertionEntry = path.join('node_modules','@byok-sdk','client','dist','assertion-client','index.js');\n` +
        `const assertionSource = readFileSync(assertionEntry, 'utf8');\n` +
        `for (const needle of ['ajv','pi-coding-agent','@earendil-works','@modelcontextprotocol/client','new Function']) {\n` +
        `  assert.equal(assertionSource.includes(needle), false, assertionEntry + ' carries ' + needle);\n` +
        `}\n` +
        // The MCP server core is the same argument a third time, and the
        // sharpest: it is a SERVER a CSP-locked host spawns, and its whole
        // reason to exist is that an SDK-reserved MCP server must not need
        // `@modelcontextprotocol/sdk` (or anything that generates code) to
        // answer a JSON-RPC line. The installed tarball is the only place that
        // is true for a consumer.
        `const mcpServer = await import('@byok-sdk/client/mcp-server');\n` +
        `assert.equal(typeof mcpServer.serveMcpOverStdio, 'function');\n` +
        `assert.deepEqual([...mcpServer.MCP_SERVER_SUPPORTED_PROTOCOL_VERSIONS], ['2025-11-25','2025-06-18','2024-11-05']);\n` +
        `const mcpServerEntry = path.join('node_modules','@byok-sdk','client','dist','mcp-server','index.js');\n` +
        `const mcpServerSource = readFileSync(mcpServerEntry, 'utf8');\n` +
        `for (const needle of ['ajv','pi-coding-agent','@earendil-works','@modelcontextprotocol/client','@modelcontextprotocol/sdk','new Function']) {\n` +
        `  assert.equal(mcpServerSource.includes(needle), false, mcpServerEntry + ' carries ' + needle);\n` +
        `}\n` +
        `for (const [name, version] of [['@byok-sdk/core','${releaseVersion}'],['@byok-sdk/implementation-identity','${releaseVersion}'],['@byok-sdk/protocol','${releaseVersion}'],['@byok-sdk/client','${releaseVersion}'],['@byok-sdk/server','${releaseVersion}'],['@byok-sdk/cloud','${releaseVersion}'],['@byok-sdk/cloud-dataplane','${releaseVersion}'],['@byok-sdk/ui-runtime','${releaseVersion}'],['@byok-sdk/keys','${keysVersion}']]) {\n` +
        `  const manifest = require(name + '/package.json');\n` +
        `  assert.equal(manifest.version, version, name);\n` +
        `}\n` +
        `await import('@byok-sdk/implementation-identity');\n` +
        `for (const consumer of ['client', 'keys']) assert.equal(require('@byok-sdk/' + consumer + '/package.json').dependencies['@byok-sdk/implementation-identity'], '${releaseVersion}');\n` +
        `const keysManifest = require('@byok-sdk/keys/package.json');\n` +
        `assert.equal(keysManifest.dependencies?.['@byok-sdk/core'], '${releaseVersion}');\n` +
        `assert.notEqual(keysManifest.dependencies?.['@byok-sdk/core'], 'workspace:*');\n` +
        // The other half of the release-asset guarantee: the tarball check above
        // proves the bytes are IN the package, this proves the installed package
        // can point a runner at them without any source checkout in reach.
        `const { migrationsDir } = await import('@byok-sdk/cloud-dataplane');\n` +
        `const migrations = migrationsDir();\n` +
        `assert.equal(statSync(migrations).isDirectory(), true, migrations);\n` +
        `assert.deepEqual(readdirSync(migrations).sort(), ${JSON.stringify([...migrationFiles].sort())});\n` +
        `console.log('[release-pack] isolated imports OK');\n`,
    );
    run(nodeBin, ['smoke.mjs'], smokeDir);
    copyFileSync(path.join(repoRoot, 'scripts/release/recurring-smoke.mjs'), path.join(smokeDir, 'recurring-smoke.mjs'));
    run(nodeBin, ['recurring-smoke.mjs'], smokeDir);
    // Preserve the verifier's relative module graph in the isolated fixture.
    // These are test-oracle files, not a replacement runtime or mutable install evidence.
    for (const relative of [
      'scripts/release/pi-runtime-identity.mjs',
      'scripts/release/pi-launcher-smoke.mjs',
      'packages/client/src/adapters/pi/official-pi-installation.mjs',
      'packages/client/src/adapters/pi/official-pi-closure.json',
    ]) {
      const target = path.join(smokeDir, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(repoRoot, relative), target);
    }
    // This is the decisive installed-runtime proof (real RPC get_state against
    // the pinned Pi with extensions loaded); echo it instead of swallowing it.
    console.log(run(nodeBin, ['scripts/release/pi-launcher-smoke.mjs'], smokeDir));
    assertSingleVersionSet(smokeDir, expectedPackageVersions);
    assertNpmCoreClosure(smokeDir);
    // The worker runtime subpath must stay deployable outside Node: the smoke
    // import above proves it loads, this proves it never grew node: builtins.
    const runtimePath = path.join(smokeDir, 'node_modules', '@byok-sdk', 'cloud-dataplane', 'dist', 'runtime.js');
    if (!existsSync(runtimePath)) {
      throw new Error(`isolated install is missing @byok-sdk/cloud-dataplane/dist/runtime.js (${runtimePath})`);
    }
    const nodeBuiltinSpecifier = /(?:\bimport\b[^'"`\n]*|\brequire\b[^'"`\n]*)['"`]node:/;
    if (nodeBuiltinSpecifier.test(readFileSync(runtimePath, 'utf8'))) {
      throw new Error('@byok-sdk/cloud-dataplane/dist/runtime.js must not reference node: builtins (worker runtime)');
    }
    const clientManifest = JSON.parse(readFileSync(path.join(smokeDir, 'node_modules', '@byok-sdk', 'client', 'package.json'), 'utf8'));
    if (clientManifest.dependencies['@juicesharp/rpiv-todo'] !== undefined) throw new Error('packed client retained a second npm todo authority');
    console.log('[release-pack] client dependencies=' + Object.keys(clientManifest.dependencies).length +
      '; delta from M1a: -rpiv-todo +rpiv-i18n +rpiv-config +typebox +official Pi closure (pi-ai, pi-agent-core, chord, pi-codemode, pi-mcp, pi-telemetry, pi-tui)');

    const installedAgentBin = path.join(smokeDir, 'node_modules', '@byok-sdk', 'client', 'dist', 'bin', 'byok-agent.js');
    const emptyAgentHome = path.join(smokeDir, 'empty-agent-home');
    mkdirSync(emptyAgentHome);
    const missingAgentConfig = path.join(emptyAgentHome, 'must-not-be-read.json');
    const installedAgentVersion = spawnSync(nodeBin, [installedAgentBin, '--version'], {
      cwd: smokeDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: emptyAgentHome,
        USERPROFILE: emptyAgentHome,
        APPDATA: emptyAgentHome,
        BYOK_CONFIG: missingAgentConfig,
        BYOK_PI_BIN: path.join(emptyAgentHome, 'missing-pi'),
        BYOK_CLAUDE_BIN: path.join(emptyAgentHome, 'missing-claude'),
        BYOK_CODEX_BIN: path.join(emptyAgentHome, 'missing-codex'),
        HTTP_PROXY: 'http://127.0.0.1:1',
        HTTPS_PROXY: 'http://127.0.0.1:1',
      },
    });
    if (installedAgentVersion.status !== 0) {
      throw new Error(
        `installed byok-agent --version failed (${installedAgentVersion.status})\n` +
          `${installedAgentVersion.stdout}${installedAgentVersion.stderr}`,
      );
    }
    console.log(run(nodeBin, [path.join(repoRoot, 'packages/client/scripts/packed-cli-mcp-smoke.mjs'), '--install-root', smokeDir]));
    const expectedAgentVersionOutput = `${clientManifest.version}\n`;
    if (installedAgentVersion.stdout !== expectedAgentVersionOutput || installedAgentVersion.stderr !== '') {
      throw new Error(
        `installed byok-agent --version reported stdout=${JSON.stringify(installedAgentVersion.stdout)} ` +
          `stderr=${JSON.stringify(installedAgentVersion.stderr)}, expected exact stdout ` +
          `${JSON.stringify(expectedAgentVersionOutput)} and empty stderr`,
      );
    }
    if (readdirSync(emptyAgentHome).length !== 0) {
      throw new Error('installed byok-agent --version touched the empty HOME despite being a zero-state command');
    }
    if (clientManifest.dependencies?.[PI_DEPENDENCY_SPECIFIER] !== piRuntime.spec) {
      throw new Error(`isolated client manifest must require pi ${piRuntime.spec}`);
    }
    if (clientManifest.optionalDependencies?.[PI_DEPENDENCY_SPECIFIER]) {
      throw new Error('isolated client manifest must not make pi optional');
    }
    // The official package at the pinned version, and the whole isolated tree
    // holds exactly the pinned official closure with the locked integrities.
    const piManifest = JSON.parse(readFileSync(path.join(smokeDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8'));
    if (piManifest.name !== piRuntime.packageName || piManifest.version !== piRuntime.version) {
      throw new Error(
        `isolated client install resolved pi ${piManifest.name}@${piManifest.version}, expected ${piRuntime.packageName}@${piRuntime.version}`,
      );
    }
    const lockedPiClosure = readLockedPiClosure(readFileSync(path.join(repoRoot, 'bun.lock'), 'utf8'), piRuntime);
    assertInstalledPiRuntime(smokeDir, piRuntime, lockedPiClosure, 'release-pack', npmInvocation);
  } finally {
    rmSync(smokeDir, { recursive: true, force: true });
  }

  const manifest = {
    schemaVersion: 2,
    releaseVersion,
    sourceGitSha: run('git', ['rev-parse', 'HEAD']),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    packages: tarballs,
  };
  writeFileSync(path.join(outDir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest));
} finally {
  if (ephemeralRoot) rmSync(ephemeralRoot, { recursive: true, force: true });
}
