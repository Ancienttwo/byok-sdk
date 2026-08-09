import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const expectedVersion = '0.1.0';
const packages = [
  '@byok-sdk/core',
  '@byok-sdk/protocol',
  '@byok-sdk/server',
  '@byok-sdk/cloud',
  '@byok-sdk/client',
  '@byok-sdk/cloud-postgres',
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
  const value = JSON.parse(run(npmInvocation.command, [...npmInvocation.prefix, 'view', `${packageName}@${expectedVersion}`, 'name', 'version', 'maintainers', 'dist', '--json']));
  if (value.name !== packageName || value.version !== expectedVersion) throw new Error(`${packageName}: registry identity/version mismatch`);
  const frozen = frozenPackages.get(packageName);
  if (typeof frozen.sha512Integrity !== 'string' || value.dist?.integrity !== frozen.sha512Integrity) {
    throw new Error(`${packageName}: registry tarball integrity differs from frozen artifact`);
  }
  const maintainers = Array.isArray(value.maintainers) ? value.maintainers : [value.maintainers];
  if (!maintainers.some((entry) => String(typeof entry === 'string' ? entry : entry?.name).includes('ancienttwo'))) {
    throw new Error(`${packageName}: ancienttwo is not present in registry maintainers`);
  }
  metadata.push(value);
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
      `assert.deepEqual(Object.keys(sdk).sort(), ['client','cloud','cloudPostgres','core','protocol','server']);\n` +
      `assert.equal('keys' in sdk, false);\n` +
      `for (const name of ${JSON.stringify(packages.slice(0, -1))}) await import(name);\n` +
      `console.log('[registry-readback] exact registry imports OK');\n`,
  );
  run(nodeBin, ['readback.mjs'], smokeDir);
  if (existsSync(path.join(smokeDir, 'node_modules', '@byok-sdk', 'keys'))) {
    throw new Error('registry umbrella install unexpectedly contains @byok-sdk/keys');
  }
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ releaseVersion: expectedVersion, sourceGitSha: manifest.sourceGitSha, packages: metadata }));
