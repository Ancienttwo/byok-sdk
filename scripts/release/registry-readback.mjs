import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// Version authority: the manifests, never a constant here. The expected
// registry train is whatever packages/core ships, keys versions independently,
// and the pi pin comes from packages/client.
const exactStableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const exactReleaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const npmSafeDistTag = /^(?=.{1,214}$)[a-z][a-z0-9._-]*$/;
const expectedVersion = JSON.parse(readFileSync(path.join(repoRoot, 'packages/core/package.json'), 'utf8')).version;
const keysVersion = JSON.parse(readFileSync(path.join(repoRoot, 'packages/keys/package.json'), 'utf8')).version;
const piVersion = JSON.parse(readFileSync(path.join(repoRoot, 'packages/client/package.json'), 'utf8')).dependencies?.['@earendil-works/pi-coding-agent'];
if (typeof expectedVersion !== 'string' || !exactReleaseVersion.test(expectedVersion)) {
  throw new Error('packages/core/package.json: version must be an exact SemVer release train version');
}
if (typeof keysVersion !== 'string' || !exactReleaseVersion.test(keysVersion)) {
  throw new Error('packages/keys/package.json: version must be an exact SemVer independent version');
}
if (typeof piVersion !== 'string' || !exactStableVersion.test(piVersion)) {
  throw new Error('packages/client/package.json: @earendil-works/pi-coding-agent must be pinned to an exact x.y.z version');
}
const packages = [
  '@byok-sdk/core',
  '@byok-sdk/protocol',
  '@byok-sdk/server',
  '@byok-sdk/cloud',
  '@byok-sdk/client',
  '@byok-sdk/cloud-dataplane',
  '@byok-sdk/ui-runtime',
  '@byok-sdk/testkit',
  'byok-sdk',
  '@byok-sdk/keys',
];
// These are the stable sentinels for the prerelease channel: a prerelease must
// not advance npm's default channel even if every artifact is otherwise exact.
const expectedLatestVersions = new Map(
  packages.map((packageName) => [packageName, packageName === '@byok-sdk/keys' ? '0.3.2' : '0.8.1']),
);
const expectedPackageVersions = Object.fromEntries(
  packages.map((packageName) => [packageName, packageName === '@byok-sdk/keys' ? keysVersion : expectedVersion]),
);
const nodeBin = process.execPath;
const npmCliPath = path.join(path.dirname(nodeBin), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmInvocation = process.platform === 'win32'
  ? { command: nodeBin, prefix: [npmCliPath] }
  : { command: 'npm', prefix: [] };
if (process.platform === 'win32' && !existsSync(npmCliPath)) {
  throw new Error(`Windows npm CLI entrypoint is missing: ${npmCliPath}`);
}

function isPrereleaseVersion(version) {
  if (typeof version !== 'string' || !exactReleaseVersion.test(version)) return false;
  return version.slice(0, version.indexOf('+') === -1 ? version.length : version.indexOf('+')).includes('-');
}

function resolveReleaseDistTag(version, tag) {
  if (!isPrereleaseVersion(version)) {
    if (tag !== undefined) throw new Error(`stable release ${version} must not set --tag; omit it to retain npm's default latest behavior`);
    return undefined;
  }
  if (typeof tag !== 'string' || !npmSafeDistTag.test(tag) || tag === 'latest') {
    throw new Error(`prerelease ${version} requires a npm-safe non-latest --tag identifier`);
  }
  return tag;
}

function parseArguments(argv) {
  let manifestPath;
  let tag;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--manifest' && argument !== '--tag') {
      if (argument.startsWith('--')) throw new Error(`unknown flag ${argument}`);
      throw new Error(`unexpected argument ${argument}`);
    }
    if (seen.has(argument)) throw new Error(`${argument} may be provided only once`);
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    if (argument === '--manifest') manifestPath = value;
    else tag = value;
    index += 1;
  }
  return { manifestPath, tag };
}

const { manifestPath, tag: requestedTag } = parseArguments(process.argv.slice(2));
if (!manifestPath) {
  throw new Error('--manifest requires the frozen release-manifest.json path');
}
const distTag = resolveReleaseDistTag(expectedVersion, requestedTag);
const manifest = JSON.parse(readFileSync(path.resolve(manifestPath), 'utf8'));
if (manifest.schemaVersion !== 2 || manifest.releaseVersion !== expectedVersion) {
  throw new Error('frozen release manifest schema/version mismatch');
}
if (typeof manifest.sourceGitSha !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.sourceGitSha)) {
  throw new Error('frozen release manifest has no exact source Git SHA');
}
const frozenPackages = new Map(
  manifest.packages.map((entry) => [entry.package, entry]),
);
if (frozenPackages.size !== packages.length || packages.some((packageName) => !frozenPackages.has(packageName))) {
  throw new Error('frozen release manifest package set mismatch');
}
for (const packageName of packages) {
  if (frozenPackages.get(packageName).version !== expectedPackageVersions[packageName]) {
    throw new Error(
      `${packageName}: frozen artifact is ${frozenPackages.get(packageName).version}, expected ${expectedPackageVersions[packageName]}`,
    );
  }
}

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

const metadata = [];
for (const packageName of packages) {
  const packageVersion = expectedPackageVersions[packageName];
  const value = JSON.parse(run(npmInvocation.command, [...npmInvocation.prefix, 'view', `${packageName}@${packageVersion}`, 'name', 'version', 'maintainers', 'dist', 'dependencies', 'optionalDependencies', 'peerDependencies', '--json']));
  if (value.name !== packageName || value.version !== packageVersion) throw new Error(`${packageName}: registry identity/version mismatch`);
  const frozen = frozenPackages.get(packageName);
  if (frozen.version !== packageVersion || typeof frozen.sha512Integrity !== 'string' || value.dist?.integrity !== frozen.sha512Integrity) {
    throw new Error(`${packageName}: registry tarball integrity differs from frozen artifact`);
  }
  if (distTag) {
    const distTags = JSON.parse(run(npmInvocation.command, [...npmInvocation.prefix, 'view', packageName, 'dist-tags', '--json']));
    if (!distTags || typeof distTags !== 'object' || distTags[distTag] !== packageVersion) {
      throw new Error(`${packageName}: registry dist-tag ${distTag} is ${JSON.stringify(distTags?.[distTag])}, expected ${packageVersion}`);
    }
    const expectedLatestVersion = expectedLatestVersions.get(packageName);
    if (expectedLatestVersion && distTags.latest !== expectedLatestVersion) {
      throw new Error(`${packageName}: registry latest is ${JSON.stringify(distTags.latest)}, expected stable ${expectedLatestVersion}`);
    }
  }
  const maintainers = Array.isArray(value.maintainers) ? value.maintainers : [value.maintainers];
  if (!maintainers.some((entry) => String(typeof entry === 'string' ? entry : entry?.name).includes('ancienttwo'))) {
    throw new Error(`${packageName}: ancienttwo is not present in registry maintainers`);
  }
  // The registry is the one point where the frozen-artifact checks and the
  // published graph can diverge silently: publishing rewrites workspace edges
  // one last time. v0.4.1 shipped with @byok-sdk/*: 0.4.0 internal edges and
  // no frozen check could see it — the readback can.
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [dependency, range] of Object.entries(value[field] ?? {})) {
      if (dependency === 'byok-sdk' || dependency.startsWith('@byok-sdk/')) {
        if (range !== expectedVersion) {
          throw new Error(
            `${packageName}@${packageVersion}: registry ${field}.${dependency} is ${range}, expected ${expectedVersion} — the published graph is split`,
          );
        }
      }
    }
  }
  metadata.push(value);
}

/**
 * Asserts the registry install's @byok-sdk graph closes to exactly one version
 * set: every installed @byok-sdk package (umbrella included) sits at the
 * expected version, and no copy hides under a second node_modules — the
 * nested-copy fallback npm takes when published internal edges disagree.
 * Follows node_modules chains only, so the walk stays cheap on large trees.
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
      throw new Error(`${manifestPath}: unexpected @byok-sdk package ${manifest.name} in the registry install`);
    }
    if (manifest.version !== expected) {
      throw new Error(`${manifestPath}: version ${manifest.version}, expected ${expected} — the @byok-sdk graph does not close to its exact package versions`);
    }
    seenNames.add(manifest.name);
  }
  for (const packageName of Object.keys(expectedVersions)) {
    if (!seenNames.has(packageName)) {
      throw new Error(`${installDirectory}: missing expected registry package ${packageName}`);
    }
  }
  console.log(`[registry-readback] install tree closes to exact package versions (${found.length} package(s))`);
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
  if (versions.size !== 1 || !versions.has(expectedVersion)) {
    throw new Error(
      `npm ls @byok-sdk/core --all --json resolved ${[...versions].sort().join(', ') || '(none)'}, expected only ${expectedVersion}`,
    );
  }
  console.log(`[registry-readback] npm ls @byok-sdk/core --all --json resolves only ${expectedVersion}`);
}

const smokeDir = mkdtempSync(path.join(os.tmpdir(), 'byok-registry-install-'));
try {
  const dependencies = Object.fromEntries(packages.map((name) => [name, expectedPackageVersions[name]]));
  writeFileSync(
    path.join(smokeDir, 'package.json'),
    `${JSON.stringify({ name: 'byok-registry-readback', private: true, type: 'module', dependencies }, null, 2)}\n`,
  );
  run(npmInvocation.command, [...npmInvocation.prefix, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], smokeDir);
  writeFileSync(
    path.join(smokeDir, 'readback.mjs'),
    `import assert from 'node:assert/strict';\n` +
      `const sdk = await import('byok-sdk');\n` +
      `assert.deepEqual(Object.keys(sdk).sort(), ['client','cloud','cloudDataplane','core','protocol','server','uiRuntime']);\n` +
      `assert.equal('keys' in sdk, false);\n` +
      `await import('@byok-sdk/client/adapters');\n` +
      `await import('@byok-sdk/cloud-dataplane/runtime');\n` +
      `await import('@byok-sdk/keys');\n` +
      `for (const name of ${JSON.stringify(packages)}) await import(name);\n` +
      `console.log('[registry-readback] exact registry imports OK');\n`,
  );
  run(nodeBin, ['readback.mjs'], smokeDir);
  assertSingleVersionSet(smokeDir, expectedPackageVersions);
  assertNpmCoreClosure(smokeDir);
  const clientManifest = JSON.parse(readFileSync(path.join(smokeDir, 'node_modules', '@byok-sdk', 'client', 'package.json'), 'utf8'));
  if (clientManifest.dependencies?.['@earendil-works/pi-coding-agent'] !== piVersion) {
    throw new Error(`registry client manifest must require pi ${piVersion}`);
  }
  if (clientManifest.optionalDependencies?.['@earendil-works/pi-coding-agent']) {
    throw new Error('registry client manifest must not make pi optional');
  }
  const piManifest = JSON.parse(readFileSync(path.join(smokeDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8'));
  if (piManifest.version !== piVersion) {
    throw new Error(`registry install resolved pi ${piManifest.version}, expected ${piVersion}`);
  }
  const keysManifest = JSON.parse(readFileSync(path.join(smokeDir, 'node_modules', '@byok-sdk', 'keys', 'package.json'), 'utf8'));
  if (keysManifest.dependencies?.['@byok-sdk/core'] !== expectedVersion || keysManifest.dependencies?.['@byok-sdk/core'] === 'workspace:*') {
    throw new Error(`registry keys manifest must declare core ${expectedVersion} directly`);
  }
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ releaseVersion: expectedVersion, keysVersion, sourceGitSha: manifest.sourceGitSha, packages: metadata }));
