import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// Version authority: the manifests, never a constant here. The expected
// registry version is whatever packages/core ships; the pi pin comes from
// packages/client.
const exactVersion = /^\d+\.\d+\.\d+$/;
const expectedVersion = JSON.parse(readFileSync(path.join(repoRoot, 'packages/core/package.json'), 'utf8')).version;
const piVersion = JSON.parse(readFileSync(path.join(repoRoot, 'packages/client/package.json'), 'utf8')).dependencies?.['@earendil-works/pi-coding-agent'];
if (typeof expectedVersion !== 'string' || !exactVersion.test(expectedVersion)) {
  throw new Error('packages/core/package.json: version must be an exact x.y.z release train version');
}
if (typeof piVersion !== 'string' || !exactVersion.test(piVersion)) {
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
];
const nodeBin = process.execPath;
const npmCliPath = path.join(path.dirname(nodeBin), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmInvocation = process.platform === 'win32'
  ? { command: nodeBin, prefix: [npmCliPath] }
  : { command: 'npm', prefix: [] };
if (process.platform === 'win32' && !existsSync(npmCliPath)) {
  throw new Error(`Windows npm CLI entrypoint is missing: ${npmCliPath}`);
}

const manifestArgIndex = process.argv.indexOf('--manifest');
const manifestPath = manifestArgIndex >= 0 ? process.argv[manifestArgIndex + 1] : undefined;
if (!manifestPath || manifestPath.startsWith('--')) {
  throw new Error('--manifest requires the frozen release-manifest.json path');
}
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

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

const metadata = [];
for (const packageName of packages) {
  const value = JSON.parse(run(npmInvocation.command, [...npmInvocation.prefix, 'view', `${packageName}@${expectedVersion}`, 'name', 'version', 'maintainers', 'dist', 'dependencies', 'optionalDependencies', 'peerDependencies', '--json']));
  if (value.name !== packageName || value.version !== expectedVersion) throw new Error(`${packageName}: registry identity/version mismatch`);
  const frozen = frozenPackages.get(packageName);
  if (typeof frozen.sha512Integrity !== 'string' || value.dist?.integrity !== frozen.sha512Integrity) {
    throw new Error(`${packageName}: registry tarball integrity differs from frozen artifact`);
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
            `${packageName}@${expectedVersion}: registry ${field}.${dependency} is ${range}, expected ${expectedVersion} — the published graph is split`,
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
function assertSingleVersionSet(installDirectory, expected) {
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
  for (const manifestPath of found) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== expected) {
      throw new Error(`${manifestPath}: version ${manifest.version}, expected ${expected} — the @byok-sdk graph does not close to one version set`);
    }
  }
  console.log(`[registry-readback] install tree closes to a single @byok-sdk version set (${expected}, ${found.length} package(s))`);
}

const smokeDir = mkdtempSync(path.join(os.tmpdir(), 'byok-registry-install-'));
try {
  const dependencies = Object.fromEntries(packages.map((name) => [name, expectedVersion]));
  writeFileSync(
    path.join(smokeDir, 'package.json'),
    `${JSON.stringify({ name: 'byok-registry-readback', private: true, type: 'module', dependencies }, null, 2)}\n`,
  );
  run(npmInvocation.command, [...npmInvocation.prefix, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], smokeDir);
  writeFileSync(
    path.join(smokeDir, 'readback.mjs'),
    `import assert from 'node:assert/strict';\n` +
      `const sdk = await import('byok-sdk');\n` +
      `assert.deepEqual(Object.keys(sdk).sort(), ['client','cloud','cloudDataplane','core','protocol','server']);\n` +
      `assert.equal('keys' in sdk, false);\n` +
      `await import('@byok-sdk/client/adapters');\n` +
      `await import('@byok-sdk/cloud-dataplane/runtime');\n` +
      `for (const name of ${JSON.stringify(packages.slice(0, -1))}) await import(name);\n` +
      `console.log('[registry-readback] exact registry imports OK');\n`,
  );
  run(nodeBin, ['readback.mjs'], smokeDir);
  if (existsSync(path.join(smokeDir, 'node_modules', '@byok-sdk', 'keys'))) {
    throw new Error('registry umbrella install unexpectedly contains @byok-sdk/keys');
  }
  assertSingleVersionSet(smokeDir, expectedVersion);
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
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ releaseVersion: expectedVersion, sourceGitSha: manifest.sourceGitSha, packages: metadata }));
