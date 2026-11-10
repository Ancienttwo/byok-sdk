import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { agyUpdaterManifest, AGY_QUALIFIED, contractEnv, hermesBuildCommit, install, installNpm, isExactVersion, qualifiedVersions, RUNTIMES, vendoredHermesInstaller } from './runtime-contract-install.mjs';

const root = new URL('../../', import.meta.url);

test('qualified versions come from each adapter authority and the client Pi pin', async () => {
  const versions = await qualifiedVersions();
  assert.deepEqual(Object.keys(versions).sort(), [...RUNTIMES].sort());
  const manifest = JSON.parse(readFileSync(new URL('packages/client/package.json', root), 'utf8'));
  assert.equal(versions.pi, manifest.byok.piRuntimePin);
  for (const [runtime, file, name] of [['claude', 'claude/claude-version.ts', 'QUALIFIED_CLAUDE_VERSION'], ['codex', 'codex/codex-version.ts', 'QUALIFIED_CODEX_VERSION'],
    ['grok', 'grok/grok-version.ts', 'QUALIFIED_GROK_VERSION'], ['hermes', 'hermes/hermes-version.ts', 'QUALIFIED_HERMES_VERSION'],
    ['dsh', 'dsh/dsh-version.ts', 'QUALIFIED_DSH_VERSION'], ['agy', 'antigravity/agy-version.ts', 'QUALIFIED_AGY_VERSION']]) {
    const source = readFileSync(new URL(`packages/client/src/adapters/${file}`, root), 'utf8');
    assert.ok(source.includes(`export const ${name} = '${versions[runtime]}';`), `${runtime}: ${versions[runtime]}`);
  }
});

test('the Hermes build names the commit the installer checks out', () => {
  assert.equal(hermesBuildCommit('0.22.2+2364.g0b10b9f'), '0b10b9f');
  assert.throws(() => hermesBuildCommit('0.22.2'), /names no commit/);
});

test('vendored Hermes installers match the qualified commit and checksums', async () => {
  const version = (await qualifiedVersions()).hermes;
  const vendor = new URL('scripts/ci/vendor/hermes/', root);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', vendor), 'utf8'));
  const work = mkdtempSync(join(tmpdir(), 'hermes-vendor-'));
  try {
    mkdirSync(join(work, manifest.commit));
    for (const file of ['install.sh', 'install.ps1']) {
      const actualPath = vendoredHermesInstaller(version, file);
      assert.equal(basename(dirname(actualPath)), manifest.commit);
      assert.match(execFileSync('git', ['check-attr', 'text', '--', actualPath], { encoding: 'utf8' }), /text: unset/);
      const bytes = readFileSync(actualPath);
      writeFileSync(join(work, manifest.commit, file), bytes);
    }
    writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest));
    assert.throws(() => vendoredHermesInstaller('1.0.0+1.gabcdef0', 'install.sh', work), /does not match/);
    for (const file of ['install.sh', 'install.ps1']) {
      writeFileSync(join(work, manifest.commit, file), 'tampered');
      assert.throws(() => vendoredHermesInstaller(version, file, work), /checksum mismatch/);
    }
    rmSync(join(work, manifest.commit), { recursive: true });
    assert.throws(() => vendoredHermesInstaller(version, 'install.sh', work), /ENOENT/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('an npm install takes one exact version, prereleases included', () => {
  for (const version of ['1.0.70', '0.160.0', '0.2.1-rc.5', '0.2.2-alpha.2']) assert.ok(isExactVersion(version), version);
  for (const version of ['latest', '^1.0.0', '1.0', '0.2.1-rc.5\n', '0.2.1-', '0.2.1-rc..5', '0.2.1+build']) assert.ok(!isExactVersion(version), JSON.stringify(version));
});

test('qualified npm installs use the lock and reject version drift', () => {
  const work = mkdtempSync(join(tmpdir(), 'rc-npm-'));
  const source = join(work, 'vendor', 'dsh');
  const name = '@deepseek-ai/dsh';
  const version = '0.2.2-rc.1';
  const manifest = { private: true, dependencies: { [name]: version } };
  const lock = { packages: { '': { dependencies: manifest.dependencies }, [`node_modules/${name}`]: { version } } };
  const calls = [];
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(source, 'package-lock.json'), JSON.stringify(lock));
  const fakeNpm = (args, options) => { calls.push({ args, options }); return args[0] === 'view' ? version : ''; };
  try {
    const target = join(work, 'qualified');
    installNpm('dsh', 'qualified', version, target, fakeNpm, join(work, 'vendor'));
    assert.deepEqual(calls[0].args, ['ci', '--no-audit', '--no-fund']);
    assert.equal(calls[0].options.cwd, target);
    assert.deepEqual(JSON.parse(readFileSync(join(target, 'package-lock.json'), 'utf8')), lock);
    assert.throws(() => installNpm('dsh', 'qualified', '0.2.2-rc.2', join(work, 'drift'), fakeNpm, join(work, 'vendor')), /lock does not match qualified version/);
    assert.equal(calls.length, 1);
    calls.length = 0;
    installNpm('dsh', 'latest', 'ignored', join(work, 'latest'), fakeNpm);
    assert.deepEqual(calls.map(call => call.args), [
      ['view', name, 'version'], ['install', '--no-audit', '--no-fund', '--save-exact', `${name}@${version}`],
    ]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('vendored npm runtime locks match the qualified versions', async () => {
  const versions = await qualifiedVersions();
  const work = mkdtempSync(join(tmpdir(), 'rc-locks-'));
  try {
    for (const runtime of ['dsh', 'claude', 'codex', 'grok', 'opencode1', 'opencode2']) {
      const calls = [];
      installNpm(runtime, 'qualified', versions[runtime], join(work, runtime), args => calls.push(args));
      assert.deepEqual(calls, [['ci', '--no-audit', '--no-fund']], runtime);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('a qualified run hands the suite the binary only; a latest run also its version', () => {
  assert.deepEqual(contractEnv('codex', '/x/codex', undefined), ['BYOK_CONTRACT_CODEX_BIN=/x/codex']);
  assert.deepEqual(contractEnv('grok', '/x/grok', '1.0.70'), ['BYOK_CONTRACT_GROK_BIN=/x/grok', 'BYOK_CONTRACT_GROK_VERSION=1.0.70']);
});

test('the agy archive table pins the adapter\'s qualified version on every runner platform', async () => {
  assert.equal(AGY_QUALIFIED.version, (await qualifiedVersions()).agy);
  assert.deepEqual(Object.keys(AGY_QUALIFIED.archives).sort(), ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']);
  for (const { url, sha512 } of Object.values(AGY_QUALIFIED.archives)) {
    assert.ok(url.includes(`/${AGY_QUALIFIED.version}-`), url);
    assert.match(sha512, /^[0-9a-f]{128}$/);
  }
  assert.match(agyUpdaterManifest('win32', 'x64'), /\/manifests\/windows_amd64\.json$/);
  assert.throws(() => agyUpdaterManifest('freebsd', 'x64'), /no agy release/);
});

test('a latest agy install verifies the manifest SHA-512 and the version the binary reports', { skip: process.platform === 'win32' }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'rc-agy-'));
  try {
    const packed = join(work, 'packed');
    mkdirSync(packed);
    writeFileSync(join(packed, 'antigravity'), '#!/bin/sh\necho 9.9.9\n');
    chmodSync(join(packed, 'antigravity'), 0o755);
    execFileSync('tar', ['-czf', join(work, 'cli.tar.gz'), '-C', packed, 'antigravity']);
    const archive = readFileSync(join(work, 'cli.tar.gz'));
    const url = 'https://example.test/cli.tar.gz';
    const sha512 = createHash('sha512').update(archive).digest('hex');
    const serving = (manifest) => async (target) => target === url ? archive : Buffer.from(JSON.stringify(manifest));
    const [binLine, versionLine] = await install('agy', 'latest', { dir: join(work, 'ok'), githubEnv: '', download: serving({ version: '9.9.9', url, sha512 }) });
    assert.equal(binLine, `BYOK_CONTRACT_AGY_BIN=${join(work, 'ok', 'antigravity')}`);
    assert.equal(versionLine, 'BYOK_CONTRACT_AGY_VERSION=9.9.9');
    await assert.rejects(install('agy', 'latest', { dir: join(work, 'digest'), githubEnv: '', download: serving({ version: '9.9.9', url, sha512: '0'.repeat(128) }) }), /checksum mismatch/);
    await assert.rejects(install('agy', 'latest', { dir: join(work, 'lied'), githubEnv: '', download: serving({ version: '9.9.8', url, sha512 }) }), /reports "9\.9\.9", expected 9\.9\.8/);
    await assert.rejects(install('agy', 'latest', { dir: join(work, 'bad'), githubEnv: '', download: serving({ version: 'latest', url, sha512 }) }), /malformed/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('Pi is bundled: nothing is installed; unknown runtimes and modes refuse', async () => {
  assert.deepEqual(await install('pi', 'qualified', { githubEnv: '' }), []);
  await assert.rejects(install('opencode', 'qualified', { githubEnv: '' }), /unknown runtime/);
  await assert.rejects(install('codex', 'newest', { githubEnv: '' }), /qualified or latest/);
});
