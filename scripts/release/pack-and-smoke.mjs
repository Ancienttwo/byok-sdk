import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const releaseVersion = '0.1.0';
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
const pnpmInvocation = process.platform === 'win32'
  ? { command: nodeBin, prefix: [process.env.npm_execpath ?? ''] }
  : { command: 'pnpm', prefix: [] };
const npmCliPath = path.join(path.dirname(nodeBin), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmInvocation = process.platform === 'win32'
  ? { command: nodeBin, prefix: [npmCliPath] }
  : { command: 'npm', prefix: [] };
if (process.platform === 'win32' && !pnpmInvocation.prefix[0]) {
  throw new Error('Windows release-pack must be launched through pnpm so npm_execpath identifies the pnpm JS entrypoint');
}
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

try {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`release output directory must be empty: ${outDir}`);
  }
  mkdirSync(outDir, { recursive: true });
  run(nodeBin, ['scripts/release/check-package-graph.mjs']);
  run(pnpmInvocation.command, [...pnpmInvocation.prefix, '-r', 'run', 'build']);

  const tarballs = [];
  for (const packageName of packages) {
    const before = new Set(readdirSync(outDir));
    run(pnpmInvocation.command, [...pnpmInvocation.prefix, '--filter', packageName, 'pack', '--pack-destination', outDir]);
    const created = readdirSync(outDir).filter((entry) => entry.endsWith('.tgz') && !before.has(entry));
    if (created.length !== 1) throw new Error(`${packageName}: expected one tarball, created ${created.length}`);
    const file = created[0];
    const tarballPath = path.join(outDir, file);
    tarballs.push({
      package: packageName,
      version: releaseVersion,
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
        `import { createRequire } from 'node:module';\n` +
        `const require = createRequire(import.meta.url);\n` +
        `const expected = ['client','cloud','cloudPostgres','core','protocol','server'];\n` +
        `const sdk = await import('byok-sdk');\n` +
        `assert.deepEqual(Object.keys(sdk).sort(), expected);\n` +
        `assert.equal('keys' in sdk, false);\n` +
        `for (const name of ['@byok-sdk/core','@byok-sdk/protocol','@byok-sdk/client','@byok-sdk/server','@byok-sdk/cloud','@byok-sdk/cloud-postgres']) await import(name);\n` +
        `for (const name of ['byok-sdk','@byok-sdk/core','@byok-sdk/protocol','@byok-sdk/client','@byok-sdk/server','@byok-sdk/cloud','@byok-sdk/cloud-postgres']) {\n` +
        `  const manifest = require(name + '/package.json');\n` +
        `  assert.equal(manifest.version, '${releaseVersion}', name);\n` +
        `}\n` +
        `console.log('[release-pack] isolated imports OK');\n`,
    );
    run(nodeBin, ['smoke.mjs'], smokeDir);
    if (existsSync(path.join(smokeDir, 'node_modules', '@byok-sdk', 'keys'))) {
      throw new Error('isolated umbrella install unexpectedly contains @byok-sdk/keys');
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
