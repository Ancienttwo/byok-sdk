import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { contractEnv, hermesBuildCommit, install, isExactVersion, qualifiedVersions, RUNTIMES } from './runtime-contract-install.mjs';

const root = new URL('../../', import.meta.url);

test('qualified versions come from each adapter authority and the client Pi pin', async () => {
  const versions = await qualifiedVersions();
  assert.deepEqual(Object.keys(versions).sort(), [...RUNTIMES].sort());
  const manifest = JSON.parse(readFileSync(new URL('packages/client/package.json', root), 'utf8'));
  assert.equal(versions.pi, manifest.byok.piRuntimePin);
  for (const [runtime, file, name] of [['claude', 'claude/claude-version.ts', 'QUALIFIED_CLAUDE_VERSION'], ['codex', 'codex/codex-version.ts', 'QUALIFIED_CODEX_VERSION'],
    ['grok', 'grok/grok-version.ts', 'QUALIFIED_GROK_VERSION'], ['hermes', 'hermes/hermes-version.ts', 'QUALIFIED_HERMES_VERSION'],
    ['dsh', 'dsh/dsh-version.ts', 'QUALIFIED_DSH_VERSION']]) {
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

test('Pi is bundled: nothing is installed; unknown runtimes and modes refuse', async () => {
  assert.deepEqual(await install('pi', 'qualified', { githubEnv: '' }), []);
  await assert.rejects(install('opencode', 'qualified', { githubEnv: '' }), /unknown runtime/);
  await assert.rejects(install('codex', 'newest', { githubEnv: '' }), /qualified or latest/);
});
