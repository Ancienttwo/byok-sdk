import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { agyUpdaterManifest, AGY_QUALIFIED, contractEnv, hermesBuildCommit, install, isExactVersion, qualifiedVersions, RUNTIMES } from './runtime-contract-install.mjs';

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

test('an npm install takes one exact version, prereleases included', () => {
  for (const version of ['1.0.70', '0.160.0', '0.2.1-rc.5', '0.2.2-alpha.2']) assert.ok(isExactVersion(version), version);
  for (const version of ['latest', '^1.0.0', '1.0', '0.2.1-rc.5\n', '0.2.1-', '0.2.1-rc..5', '0.2.1+build']) assert.ok(!isExactVersion(version), JSON.stringify(version));
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
