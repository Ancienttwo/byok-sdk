import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const releaseVersion = '0.3.0';
const piVersion = '0.84.1';
const packages = [
  '@byok-sdk/core',
  '@byok-sdk/protocol',
  '@byok-sdk/server',
  '@byok-sdk/cloud',
  '@byok-sdk/client',
  '@byok-sdk/cloud-postgres',
  '@byok-sdk/testkit',
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

// --- Release asset guarantee: the migration SQL a runner needs must ship WITH
// the runner. `@byok-sdk/cloud-postgres` exports `migrate(pool, directory)`, and
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
 * Reads an npm tarball into `path -> sha256`, without shelling out to `tar`:
 * this script is a release hard gate and runs on Windows runners too, so it
 * depends on node builtins only. Plain ustar walk — 512-byte header blocks,
 * octal size, contents padded to the next block.
 */
function readTarballDigests(tarballPath) {
  const tar = gunzipSync(readFileSync(tarballPath));
  const digests = new Map();
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
      digests.set(name, createHash('sha256').update(body).digest('hex'));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return digests;
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

try {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`release output directory must be empty: ${outDir}`);
  }
  mkdirSync(outDir, { recursive: true });
  run(nodeBin, ['scripts/release/check-package-graph.mjs']);
  run(pnpmInvocation.command, [...pnpmInvocation.prefix, '-r', 'run', 'build']);

  const tarballs = [];
  let migrationFiles;
  for (const packageName of packages) {
    const before = new Set(readdirSync(outDir));
    run(pnpmInvocation.command, [...pnpmInvocation.prefix, '--filter', packageName, 'pack', '--pack-destination', outDir]);
    const created = readdirSync(outDir).filter((entry) => entry.endsWith('.tgz') && !before.has(entry));
    if (created.length !== 1) throw new Error(`${packageName}: expected one tarball, created ${created.length}`);
    const file = created[0];
    const tarballPath = path.join(outDir, file);
    if (packageName === '@byok-sdk/cloud-postgres') {
      migrationFiles = assertTarballCarriesMigrations(tarballPath);
    }
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
        `import { readdirSync, statSync } from 'node:fs';\n` +
        `import { createRequire } from 'node:module';\n` +
        `const require = createRequire(import.meta.url);\n` +
        `const expected = ['client','cloud','cloudPostgres','core','protocol','server'];\n` +
        `const sdk = await import('byok-sdk');\n` +
        `assert.deepEqual(Object.keys(sdk).sort(), expected);\n` +
        `assert.equal('keys' in sdk, false);\n` +
        `for (const name of ['@byok-sdk/core','@byok-sdk/protocol','@byok-sdk/client','@byok-sdk/client/adapters','@byok-sdk/server','@byok-sdk/cloud','@byok-sdk/cloud-postgres']) await import(name);\n` +
        `for (const name of ['byok-sdk','@byok-sdk/core','@byok-sdk/protocol','@byok-sdk/client','@byok-sdk/server','@byok-sdk/cloud','@byok-sdk/cloud-postgres']) {\n` +
        `  const manifest = require(name + '/package.json');\n` +
        `  assert.equal(manifest.version, '${releaseVersion}', name);\n` +
        `}\n` +
        // The other half of the release-asset guarantee: the tarball check above
        // proves the bytes are IN the package, this proves the installed package
        // can point a runner at them without any source checkout in reach.
        `const { migrationsDir } = await import('@byok-sdk/cloud-postgres');\n` +
        `const migrations = migrationsDir();\n` +
        `assert.equal(statSync(migrations).isDirectory(), true, migrations);\n` +
        `assert.deepEqual(readdirSync(migrations).sort(), ${JSON.stringify([...migrationFiles].sort())});\n` +
        `console.log('[release-pack] isolated imports OK');\n`,
    );
    run(nodeBin, ['smoke.mjs'], smokeDir);
    if (existsSync(path.join(smokeDir, 'node_modules', '@byok-sdk', 'keys'))) {
      throw new Error('isolated umbrella install unexpectedly contains @byok-sdk/keys');
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
