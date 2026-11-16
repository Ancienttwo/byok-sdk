import { assertNpmCoreClosure, assertSingleVersionSet } from './install-graph.mjs';
import { assertFrozenRegistryExpectations, npmView, readRegistryExpectations, readRegistryMetadata } from './registry-contract.mjs';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertInstalledPiRuntime, parsePiRuntimeIdentity, PI_DEPENDENCY_SPECIFIER, readLockedPiClosure,
} from './pi-runtime-identity.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// Version authority: the manifests, never a constant here. The expected
// registry train is whatever packages/core ships; keys carries the same version
// (check:release-graph enforces it) and is read back against its own manifest.
// The pi pin comes from packages/client, parsed by the one shared Pi runtime
// identity reader.
const exactReleaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const npmSafeDistTag = /^(?=.{1,214}$)[a-z][a-z0-9._-]*$/;
const expectedVersion = JSON.parse(readFileSync(path.join(repoRoot, 'packages/core/package.json'), 'utf8')).version;
const keysVersion = JSON.parse(readFileSync(path.join(repoRoot, 'packages/keys/package.json'), 'utf8')).version;
const piRuntime = parsePiRuntimeIdentity(
  JSON.parse(readFileSync(path.join(repoRoot, 'packages/client/package.json'), 'utf8')),
);
if (typeof expectedVersion !== 'string' || !exactReleaseVersion.test(expectedVersion)) {
  throw new Error('packages/core/package.json: version must be an exact SemVer release train version');
}
if (typeof keysVersion !== 'string' || !exactReleaseVersion.test(keysVersion)) {
  throw new Error('packages/keys/package.json: version must be an exact SemVer version');
}
const packages = [
  '@byok-sdk/core',
  '@byok-sdk/protocol',
  '@byok-sdk/server',
  '@byok-sdk/cloud',
  '@byok-sdk/client',
  '@byok-sdk/cloud-dataplane',
  '@byok-sdk/ui-runtime',
  '@byok-sdk/bot-collaboration',
  '@byok-sdk/keys',
];
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
if (manifest.schemaVersion !== 3 || manifest.releaseVersion !== expectedVersion) {
  throw new Error('frozen release manifest schema/version mismatch');
}
if (typeof manifest.sourceGitSha !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.sourceGitSha)) {
  throw new Error('frozen release manifest has no exact source Git SHA');
}
const frozenPackages = new Map(
  (Array.isArray(manifest.packages) ? manifest.packages : []).map((entry) => [entry.package, entry]),
);
if (manifest.packages?.length !== packages.length || frozenPackages.size !== packages.length || packages.some((packageName) => !frozenPackages.has(packageName))) {
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

const registryExpectations = readRegistryExpectations(repoRoot, packages);
assertFrozenRegistryExpectations(manifest, registryExpectations, expectedPackageVersions);
const metadata = readRegistryMetadata({
  packageVersions: expectedPackageVersions,
  frozenPackages,
  expectedVersion,
  expectations: registryExpectations,
  distTag,
  view: (selector, fields, allowNotFound) => npmView({
    invocation: npmInvocation, cwd: repoRoot, selector, fields, allowNotFound,
  }),
});


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
      `await import('@byok-sdk/client/adapters');\n` +
      `await import('@byok-sdk/cloud-dataplane/runtime');\n` +
      `await import('@byok-sdk/keys');\n` +
      `for (const name of ${JSON.stringify(packages)}) await import(name);\n` +
      `console.log('[registry-readback] exact registry imports OK');\n`,
  );
  run(nodeBin, ['readback.mjs'], smokeDir);
  assertSingleVersionSet(smokeDir, expectedPackageVersions, 'registry-readback');
  assertNpmCoreClosure(JSON.parse(run(npmInvocation.command, [...npmInvocation.prefix, 'ls', '@byok-sdk/core', '--all', '--json'], smokeDir)), expectedVersion, 'registry-readback');
  const clientManifest = JSON.parse(readFileSync(path.join(smokeDir, 'node_modules', '@byok-sdk', 'client', 'package.json'), 'utf8'));
  if (clientManifest.dependencies?.[PI_DEPENDENCY_SPECIFIER] !== piRuntime.spec) {
    throw new Error(`registry client manifest must require pi ${piRuntime.spec}`);
  }
  if (clientManifest.optionalDependencies?.[PI_DEPENDENCY_SPECIFIER]) {
    throw new Error('registry client manifest must not make pi optional');
  }
  // The official package at the pinned version, and the registry-installed tree
  // holds exactly the direct Pi pins with the locked integrities. The indirect
  // Pi packages are read and reported, not gated.
  const piManifest = JSON.parse(readFileSync(path.join(smokeDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8'));
  if (piManifest.name !== piRuntime.packageName || piManifest.version !== piRuntime.version) {
    throw new Error(
      `registry install resolved pi ${piManifest.name}@${piManifest.version}, expected ${piRuntime.packageName}@${piRuntime.version}`,
    );
  }
  const lockedPiClosure = readLockedPiClosure(readFileSync(path.join(repoRoot, 'bun.lock'), 'utf8'), piRuntime);
  assertInstalledPiRuntime(smokeDir, piRuntime, lockedPiClosure, 'registry-readback', npmInvocation);
  const keysManifest = JSON.parse(readFileSync(path.join(smokeDir, 'node_modules', '@byok-sdk', 'keys', 'package.json'), 'utf8'));
  if (keysManifest.dependencies?.['@byok-sdk/core'] !== expectedVersion || keysManifest.dependencies?.['@byok-sdk/core'] === 'workspace:*') {
    throw new Error(`registry keys manifest must declare core ${expectedVersion} directly`);
  }
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ releaseVersion: expectedVersion, keysVersion, sourceGitSha: manifest.sourceGitSha, packages: metadata }));
