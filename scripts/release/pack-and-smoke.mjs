import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// Version authority: the manifests, never a constant here. The release train
// version is whatever packages/core ships; the pi pin comes from
// packages/client. Every assertion below compares against these derived values.
const exactVersion = /^\d+\.\d+\.\d+$/;
const releaseVersion = JSON.parse(readFileSync(path.join(repoRoot, 'packages/core/package.json'), 'utf8')).version;
const keysVersion = JSON.parse(readFileSync(path.join(repoRoot, 'packages/keys/package.json'), 'utf8')).version;
const piVersion = JSON.parse(readFileSync(path.join(repoRoot, 'packages/client/package.json'), 'utf8')).dependencies?.['@earendil-works/pi-coding-agent'];
if (typeof releaseVersion !== 'string' || !exactVersion.test(releaseVersion)) {
  throw new Error('packages/core/package.json: version must be an exact x.y.z release train version');
}
if (typeof keysVersion !== 'string' || !exactVersion.test(keysVersion)) {
  throw new Error('packages/keys/package.json: version must be an exact x.y.z version');
}
if (typeof piVersion !== 'string' || !exactVersion.test(piVersion)) {
  throw new Error('packages/client/package.json: @earendil-works/pi-coding-agent must be pinned to an exact x.y.z version');
}
const packages = [
  { name: '@byok-sdk/core', directory: 'packages/core' },
  { name: '@byok-sdk/protocol', directory: 'packages/protocol' },
  { name: '@byok-sdk/server', directory: 'packages/server' },
  { name: '@byok-sdk/cloud', directory: 'packages/cloud' },
  { name: '@byok-sdk/client', directory: 'packages/client' },
  { name: '@byok-sdk/cloud-dataplane', directory: 'packages/cloud-dataplane' },
  { name: '@byok-sdk/ui-runtime', directory: 'packages/ui-runtime' },
  { name: '@byok-sdk/testkit', directory: 'packages/testkit' },
  { name: 'byok-sdk', directory: 'packages/sdk' },
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

/**
 * Walks an npm tarball without shelling out to `tar`: this script is a release
 * hard gate and runs on Windows runners too, so it depends on node builtins
 * only. Plain ustar walk — 512-byte header blocks, octal size, contents padded
 * to the next block. Yields every regular file as `name -> Buffer`.
 */
function* iterateTarballFiles(tarballPath) {
  const tar = gunzipSync(readFileSync(tarballPath));
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeField, 8);
    if (!Number.isFinite(size)) throw new Error(`${tarballPath}: unreadable tar size for ${name}`);
    const typeFlag = String.fromCharCode(header[156]);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    // '0'/'\0' are regular files; 'x'/'g'/'L' are metadata records, and the
    // long-name forms would matter only for paths this package cannot produce.
    if (typeFlag === '0' || typeFlag === '\0') {
      yield [name, body];
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
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
function assertTarballInternalEdges(tarballPath, packageName, expectedPackageVersion = expectedPackageVersions[packageName]) {
  if (typeof expectedPackageVersion !== 'string') {
    throw new Error(`${path.basename(tarballPath)}: no expected version is configured for ${packageName}`);
  }
  const entry = readTarballEntry(tarballPath, 'package/package.json');
  if (entry === undefined) throw new Error(`${path.basename(tarballPath)}: carries no package/package.json`);
  const packed = JSON.parse(entry.toString('utf8'));
  if (packed.name !== packageName) {
    throw new Error(`${path.basename(tarballPath)}: packed name is ${packed.name}, expected ${packageName}`);
  }
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [dependency, range] of Object.entries(packed[field] ?? {})) {
      if (dependency === 'byok-sdk' || dependency.startsWith('@byok-sdk/')) {
        if (range !== releaseVersion) {
          throw new Error(
            `${path.basename(tarballPath)}: ${field}.${dependency} is ${range}, expected ${releaseVersion} — ` +
              'bun.lock workspace records were stale when this tarball was packed',
          );
        }
      }
    }
  }
  if (packed.version !== expectedPackageVersion) {
    throw new Error(`${path.basename(tarballPath)}: packed version is ${packed.version}, expected ${expectedPackageVersion}`);
  }
  console.log(`[release-pack] ${path.basename(tarballPath)} internal @byok-sdk edges all pin ${releaseVersion}`);
}

/**
 * Asserts an install tree contains each expected release package at its exact
 * manifest version and no copy hides under a second node_modules — the nested
 * fallback npm takes when published internal edges disagree. Keys has an
 * independent package version, so package identity, not a shared train number,
 * is the authority here.
 */
function assertSingleVersionSet(installDirectory, expectedVersions) {
  const root = path.join(installDirectory, 'node_modules');
  const found = [];
  const visit = (nodeModulesDirectory) => {
    const umbrella = path.join(nodeModulesDirectory, 'byok-sdk', 'package.json');
    if (existsSync(umbrella)) found.push(umbrella);
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
    const expected = `dependencies.@byok-sdk/core is ${staleCoreVersion}, expected ${releaseVersion}`;
    if (!rejection?.includes(expected)) {
      throw new Error(`${fixturePath}: stale keys edge was not rejected as expected; got ${rejection ?? '(no rejection)'}`);
    }
    console.log(`[release-pack] negative control detected the registry ${fixture.package}@${fixture.version} -> @byok-sdk/core@${staleCoreVersion} stale edge`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
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
    assertTarballInternalEdges(tarballPath, packageName);
    if (packageName === '@byok-sdk/cloud-dataplane') {
      migrationFiles = assertTarballCarriesMigrations(tarballPath);
    }
    tarballs.push({
      package: packageName,
      version: expectedPackageVersions[packageName],
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
    writeFileSync(
      path.join(smokeDir, 'smoke.mjs'),
      `import assert from 'node:assert/strict';\n` +
        `import { readdirSync, statSync } from 'node:fs';\n` +
        `import { createRequire } from 'node:module';\n` +
        `const require = createRequire(import.meta.url);\n` +
        `const expected = ['client','cloud','cloudDataplane','core','protocol','server','uiRuntime'];\n` +
        `const expectedVersions = ${JSON.stringify(expectedPackageVersions)};\n` +
        `const sdk = await import('byok-sdk');\n` +
        `assert.deepEqual(Object.keys(sdk).sort(), expected);\n` +
        `assert.equal('keys' in sdk, false);\n` +
        `for (const name of ['@byok-sdk/core','@byok-sdk/protocol','@byok-sdk/client','@byok-sdk/client/adapters','@byok-sdk/server','@byok-sdk/cloud','@byok-sdk/cloud-dataplane','@byok-sdk/cloud-dataplane/runtime','@byok-sdk/ui-runtime','@byok-sdk/keys']) await import(name);\n` +
        `for (const [name, version] of Object.entries(expectedVersions)) {\n` +
        `  const manifest = require(name + '/package.json');\n` +
        `  assert.equal(manifest.version, version, name);\n` +
        `}\n` +
        `assert.equal(require('@byok-sdk/keys/package.json').dependencies['@byok-sdk/core'], '${releaseVersion}');\n` +
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
    if (clientManifest.dependencies?.['@earendil-works/pi-coding-agent'] !== piVersion) {
      throw new Error(`isolated client manifest must require pi ${piVersion}`);
    }
    if (clientManifest.optionalDependencies?.['@earendil-works/pi-coding-agent']) {
      throw new Error('isolated client manifest must not make pi optional');
    }
    const piManifest = JSON.parse(readFileSync(path.join(smokeDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8'));
    if (piManifest.version !== piVersion) {
      throw new Error(`isolated client install resolved pi ${piManifest.version}, expected ${piVersion}`);
    }
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
