import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { documentationTestsForPaths } from './documentation-checks.mjs';
import { selectImpact, knownFamilies, reviewedScripts } from './select-impact.mjs';
import { planCi } from './plan-ci.mjs';
import { requireCiPlan } from './require-ci-plan.mjs';
import { publicManifests, RUNTIME_CONTRACT_SCRIPT } from './reviewed-content.mjs';

test('cloud-do installed-consumer smoke selects exactly its release-pack execution families', t => {
  const f = fixture(t);
  const plan = selectImpact(['scripts/release/cloud-do-consumer-smoke.mjs'], f);
  assert.deepEqual(plan.families, ['agent-memory-helper', 'dataplane', 'npm-release-pack', 'release-pack-migrate']);
  assert.deepEqual(plan.dirs, []);
});

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-reviewed-content-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const write = (path, value) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), typeof value === 'string' ? value : JSON.stringify(value)); };
  const manifest = { name: '@byok-sdk/client', version: '0.28.0', dependencies: { x: '1.0.0' } };
  const rootManifest = { scripts: { 'test:scripts': 'node --test --test-concurrency=1 scripts/old.test.mjs' } };
  const lock = { lockfileVersion: 1, workspaces: { '': { name: 'workspace' }, 'packages/client': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies } }, packages: { x: ['x@1.0.0'] } };
  write('packages/client/package.json', manifest); write('package.json', rootManifest); write('bun.lock', lock);
  write('api-surface/entries.json', { '@byok-sdk/client': { policy: { budgetBytes: 1 } }, '@byok-sdk/core': { policy: { budgetBytes: 1 } } });
  write('scripts/ci/new.test.mjs', '');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'baseline');
  return { cwd, base: git('rev-parse', 'HEAD').trim(), write, manifest, rootManifest, lock };
}
test('version-only changes select packaging; ordinary dependency upgrades qualify consumers', t => {
  const f = fixture(t);
  f.write('packages/client/package.json', { ...f.manifest, version: '0.28.1' });
  f.lock.workspaces['packages/client'].version = '0.28.1'; f.write('bun.lock', f.lock);
  const plan = selectImpact(['packages/client/package.json', 'bun.lock'], f);
  assert.deepEqual(plan.dirs, []); assert.deepEqual(plan.families, ['npm-release-pack']);
  f.write('packages/client/package.json', { ...f.manifest, version: '0.28.1', dependencies: { x: '2.0.0' } });
  assert.ok(selectImpact(['packages/client/package.json'], f).dirs.includes('packages/client'));
  f.lock.workspaces['packages/client'].dependencies = { x: '2.0.0' };
  f.lock.packages.x = ['x@2.0.0']; f.write('bun.lock', f.lock);
  assert.ok(selectImpact(['bun.lock'], f).dirs.includes('packages/client'));
});
test('root test command permits only existing additive CI tests, retaining command and old tests', t => {
  const f = fixture(t), old = f.rootManifest.scripts['test:scripts'];
  f.write('package.json', { scripts: { 'test:scripts': old + ' scripts/ci/new.test.mjs' } });
  assert.equal(selectImpact(['package.json'], f).reason, 'root-ci-scripts');
  for (const command of ['echo pass', 'node --test --test-concurrency=1 scripts/ci/new.test.mjs', old + ' scripts/ci/missing.test.mjs', old + ' ; echo pass']) {
    f.write('package.json', { scripts: { 'test:scripts': command } });
    assert.throws(() => selectImpact(['package.json'], f));
  }
});
test('root package.json admits only repo-harness script additions, removals and edits', t => {
  const f = fixture(t), old = f.rootManifest.scripts['test:scripts'];
  const scripts = extra => ({ ...f.rootManifest, scripts: { ...f.rootManifest.scripts, ...extra } });
  const base = scripts({ 'check:old': 'repo-harness run old', 'build:x': 'tsc' });
  f.write('package.json', base);
  execFileSync('git', ['-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qam', 'harness scripts'], { cwd: f.cwd });
  f.base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.cwd, encoding: 'utf8' }).trim();
  const admitted = { 'build:x': 'tsc', 'check:new': 'repo-harness brain check', 'check:old': 'repo-harness run changed' };
  f.write('package.json', { ...f.rootManifest, scripts: { 'test:scripts': old, ...admitted } });
  assert.deepEqual(selectImpact(['package.json'], f), { dirs: [], files: ['package.json'], families: [], reason: 'root-ci-scripts' });
  f.write('package.json', { ...f.rootManifest, scripts: { 'test:scripts': old + ' scripts/ci/new.test.mjs', 'build:x': 'tsc' } });
  assert.equal(selectImpact(['package.json'], f).reason, 'root-ci-scripts');
  for (const changed of [
    { ...base, scripts: { ...base.scripts, 'build:x': 'tsc -b' } },
    { ...base, scripts: { ...base.scripts, 'check:old': 'echo pass' } },
    { ...base, scripts: { ...base.scripts, 'build:x': 'repo-harness run x' } },
    { ...base, scripts: { ...base.scripts, 'check:add': 'echo pass' } },
    { ...base, scripts: { ...base.scripts, 'check:old': 'xrepo-harness run old' } },
    { ...base, name: 'renamed' },
  ]) {
    f.write('package.json', changed);
    assert.throws(() => selectImpact(['package.json'], f), /more than the reviewed fields|Unreviewed|Only existing/);
  }
});
// #1102: the gate script, its test in test:scripts, and the client files entry, each exactly.
test('the upgrade-manifest gate admits only its exact script, test and client files entry', t => {
  const f = fixture(t), old = f.rootManifest.scripts['test:scripts'];
  f.write('scripts/release/check-upgrade-manifest.test.mjs', '');
  const gate = 'node scripts/release/check-upgrade-manifest.mjs';
  const withTest = old + ' scripts/release/check-upgrade-manifest.test.mjs';
  f.write('package.json', { scripts: { 'test:scripts': withTest, 'check:upgrade-manifest': gate } });
  assert.deepEqual(selectImpact(['package.json'], f), { dirs: [], files: ['package.json'], families: [], reason: 'root-ci-scripts' });
  for (const scripts of [
    { 'test:scripts': old, 'check:upgrade-manifest': gate + ' --write' },
    { 'test:scripts': old + ' scripts/release/other.test.mjs' },
  ]) {
    f.write('package.json', { scripts });
    assert.throws(() => selectImpact(['package.json'], f), /more than the reviewed fields|Only existing/);
  }
  const files = ['dist', 'README.md', 'LICENSE'];
  execFileSync('git', ['checkout', '--', 'package.json'], { cwd: f.cwd });
  f.write('packages/client/package.json', { ...f.manifest, files });
  execFileSync('git', ['-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qam', 'files'], { cwd: f.cwd });
  f.base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.cwd, encoding: 'utf8' }).trim();
  f.write('packages/client/package.json', { ...f.manifest, files: [...files, 'upgrade-manifest.json'] });
  assert.deepEqual(selectImpact(['packages/client/package.json'], f).families, ['npm-release-pack']);
  f.write('packages/client/package.json', { ...f.manifest, files: [...files, 'upgrade-manifest.json', 'src'] });
  assert.throws(() => selectImpact(['packages/client/package.json'], f), /more than/);
});
// #1103: the client runtime contract script, exactly.
test('the client manifest admits only the exact runtime contract script', t => {
  const f = fixture(t), scripts = { test: 'vitest run' };
  f.write('packages/client/package.json', { ...f.manifest, scripts });
  execFileSync('git', ['-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qam', 'scripts'], { cwd: f.cwd });
  f.base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.cwd, encoding: 'utf8' }).trim();
  f.write('packages/client/package.json', { ...f.manifest, scripts: { ...scripts, 'test:runtime-contract': RUNTIME_CONTRACT_SCRIPT } });
  assert.deepEqual(selectImpact(['packages/client/package.json'], f).families, ['npm-release-pack']);
  for (const command of [`${RUNTIME_CONTRACT_SCRIPT} --passWithNoTests`, 'vitest run']) {
    f.write('packages/client/package.json', { ...f.manifest, scripts: { ...scripts, 'test:runtime-contract': command } });
    assert.throws(() => selectImpact(['packages/client/package.json'], f), /more than/);
  }
});

// #1094: the generated DaemonConfig schema is appended after the upgrade manifest, exactly.
test('the client files list admits exactly the appended DaemonConfig schema', t => {
  const f = fixture(t);
  const files = ['dist', 'README.md', 'LICENSE', 'upgrade-manifest.json'];
  f.write('packages/client/package.json', { ...f.manifest, files });
  execFileSync('git', ['-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qam', 'files'], { cwd: f.cwd });
  f.base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.cwd, encoding: 'utf8' }).trim();
  f.write('packages/client/package.json', { ...f.manifest, files: [...files, 'daemon-config.schema.json'] });
  assert.deepEqual(selectImpact(['packages/client/package.json'], f).families, ['npm-release-pack']);
  for (const changed of [[...files, 'daemon-config.schema.json', 'src'], ['dist', 'README.md', 'LICENSE', 'daemon-config.schema.json']]) {
    f.write('packages/client/package.json', { ...f.manifest, files: changed });
    assert.throws(() => selectImpact(['packages/client/package.json'], f), /more than/);
  }
});
test('API entry changes select only owner and dependents; unmapped entry is refused', t => {
  const f = fixture(t);
  f.write('api-surface/entries.json', { '@byok-sdk/client': { policy: { budgetBytes: 2 } }, '@byok-sdk/core': { policy: { budgetBytes: 1 } } });
  const plan = selectImpact(['api-surface/entries.json'], f);
  assert.ok(plan.dirs.includes('packages/client')); assert.ok(!plan.dirs.includes('packages/core'));
  f.write('api-surface/entries.json', { unknown: {} });
  assert.throws(() => selectImpact(['api-surface/entries.json'], f), /unmapped API/);
});
test('a bin API entry selects the package that declares the bin; an undeclared bin is refused', t => {
  const f = fixture(t);
  f.write('packages/client/package.json', { ...f.manifest, bin: { 'byok-agent-memory-mcp': './dist/bin/byok-agent-memory-mcp.js' } });
  f.write('api-surface/entries.json', { '@byok-sdk/client': { policy: { budgetBytes: 1 } }, '@byok-sdk/core': { policy: { budgetBytes: 1 } }, 'bin:byok-agent-memory-mcp': { policy: { budgetBytes: 2 } } });
  // The owner, then its one package dependent: cloud-do tests import client source (#927).
  assert.deepEqual(selectImpact(['api-surface/entries.json'], f).dirs.filter(dir => dir.startsWith('packages/')), ['packages/client', 'packages/cloud-do']);
  f.write('api-surface/entries.json', { '@byok-sdk/client': { policy: { budgetBytes: 1 } }, '@byok-sdk/core': { policy: { budgetBytes: 1 } }, 'bin:byok-unknown': {} });
  assert.throws(() => selectImpact(['api-surface/entries.json'], f), /unmapped API entry bin:byok-unknown/);
});
test('reviewed vendor and registry paths map explicitly, siblings still refuse', () => {
  assert.ok(selectImpact(['packages/client/vendor/oar/51b83c9/runtimes/grok/session.ts']).dirs.includes('packages/client'));
  assert.deepEqual(selectImpact(['scripts/release/registry-contract.test.mjs', 'scripts/release/registry-expectations.json']).dirs, []);
  assert.throws(() => selectImpact(['packages/client/vendor/oar/51b83c9/unreviewed.ts']));
  assert.throws(() => selectImpact(['scripts/release/registry-contract.mjs']));
});
test('CLI and aggregate revalidate content against the same trusted comparison base', t => {
  const f = fixture(t); f.write('packages/client/package.json', { ...f.manifest, version: '0.28.1' });
  const script = fileURLToPath(new URL('./select-impact.mjs', import.meta.url));
  const run = base => spawnSync(process.execPath, [script], { cwd: f.cwd, input: '["packages/client/package.json"]', encoding: 'utf8', env: { ...process.env, CI_BASE: base } });
  assert.equal(run(f.base).status, 0); assert.notEqual(run('').status, 0);
  const plan = planCi({ event: 'push', sha: f.base, paths: ['packages/client/package.json'], ...f });
  const needs = Object.fromEntries(['select', 'targeted', ...knownFamilies].map(id => [id, { result: ['select', 'targeted', ...plan.families].includes(id) ? 'success' : 'skipped' }]));
  assert.doesNotThrow(() => requireCiPlan(needs, plan, 'push', f.base, f.base, f.cwd));
  assert.throws(() => requireCiPlan(needs, plan, 'push', f.base, 'f'.repeat(40), f.cwd), /base mismatch/);
  f.write('packages/client/package.json', { ...f.manifest, scripts: { evil: 'true' } });
  assert.throws(() => requireCiPlan(needs, plan, 'push', f.base, f.base, f.cwd), /more than/);
});

test('published release registration fixture tests protocol without propagating production dependents', () => {
  const plan = selectImpact(['packages/protocol/src/__tests__/golden/v3.releases.json']);
  assert.deepEqual(plan.dirs, ['packages/protocol']);
  assert.deepEqual(plan.families, []);
  assert.ok(selectImpact(['packages/protocol/src/task.ts']).dirs.includes('packages/client'));
});


test('reviewed private bot fixture cloud edge is accepted only as an additive workspace dev dependency', t => {
  const f = fixture(t);
  const dir = 'examples/bot-collaboration';
  const manifest = { name: '@byok-sdk/example-bot-collaboration', private: true, version: '0.0.0', devDependencies: {} };
  f.write(`${dir}/package.json`, manifest);
  f.lock.workspaces[dir] = { name: manifest.name, version: manifest.version, devDependencies: {} };
  f.write('bun.lock', f.lock);
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'private fixture');
  f.base = git('rev-parse', 'HEAD').trim();
  manifest.devDependencies['@byok-sdk/cloud'] = 'workspace:*';
  f.write(`${dir}/package.json`, manifest);
  f.lock.workspaces[dir].devDependencies['@byok-sdk/cloud'] = 'workspace:*';
  f.write('bun.lock', f.lock);
  const plan = selectImpact(['bun.lock', `${dir}/package.json`], f);
  assert.ok(plan.dirs.includes(dir));
  assert.ok(plan.families.includes('npm-release-pack'));
  f.write(`${dir}/package.json`, { ...manifest, scripts: { test: 'echo bypass' } });
  assert.throws(() => selectImpact([`${dir}/package.json`], f), /more than/);
  f.write(`${dir}/package.json`, { ...manifest, devDependencies: {}, dependencies: manifest.devDependencies });
  assert.throws(() => selectImpact([`${dir}/package.json`], f));
  f.write(`${dir}/package.json`, manifest);
  for (const value of ['^0.28.1', 'workspace:^']) {
    f.lock.workspaces[dir].devDependencies['@byok-sdk/cloud'] = value;
    f.write('bun.lock', f.lock);
    assert.throws(() => selectImpact(['bun.lock'], f));
  }
  f.lock.workspaces[dir].devDependencies['@byok-sdk/cloud'] = 'workspace:*';
  f.write('packages/client/package.json', { ...f.manifest, dependencies: { x: '2.0.0' } });
  f.lock.workspaces['packages/client'].dependencies = { x: '2.0.0' };
  f.lock.packages.x = ['x@2.0.0']; f.write('bun.lock', f.lock);
  assert.ok(selectImpact(['bun.lock'], f).dirs.includes('packages/client'));
  f.lock.packages.x = ['x@1.0.0']; f.write('bun.lock', f.lock);
  manifest.private = false; f.write(`${dir}/package.json`, manifest);
  assert.throws(() => selectImpact(['bun.lock'], f));
});


test('reviewed root-level basic fixtures select their workspace while unknown root files fail closed', () => {
  for (const path of ['examples/basic/clarification.test.ts', 'examples/basic/goal-btw.test.ts']) {
    assert.ok(selectImpact([path]).dirs.includes('examples/basic'));
  }
  assert.throws(() => selectImpact(['examples/basic/unknown.ts']));
});

test('shared goal fixture selects its consumers without broadening unknown root support files', () => {
  const plan = selectImpact(['examples/basic/goal-btw.test-support.ts']);
  assert.deepEqual(plan.dirs, ['examples/basic', 'examples/bot-collaboration', 'examples/byok-mcp-server', 'examples/host-execution-core', 'examples/hosted-bot-collaboration',
    'examples/hosted-bot-collaboration-worker']);
  assert.deepEqual(plan.families, ['adapter-lifecycle-smoke', 'dataplane']);
  assert.throws(() => selectImpact(['examples/basic/other.test-support.ts']));
});

test('result-helper close regression selects only its exact basic workspace path', () => {
  assert.deepEqual(selectImpact(['examples/basic/goal-btw-close.test.ts']).dirs, ['examples/basic']);
  assert.throws(() => selectImpact(['examples/basic/goal-btw-close-other.test.ts']));
});

test('core sealed-payload subpath admits the exact addition only', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-core-sealed-payload-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'packages/core'), { recursive: true });
  const file = join(cwd, 'packages/core/package.json');
  const baseline = { name: '@byok-sdk/core', version: '0.28.3', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './package.json': './package.json' } };
  writeFileSync(file, JSON.stringify(baseline));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'baseline');
  const context = { cwd, base: git('rev-parse', 'HEAD').trim() };
  const candidate = structuredClone(baseline);
  candidate.exports['./sealed-payload'] = { types: './dist/sealed-payload/index.d.ts', import: './dist/sealed-payload/index.js' };
  const write = value => writeFileSync(file, JSON.stringify(value));
  write(candidate);
  assert.ok(selectImpact(['packages/core/package.json'], context).families.includes('npm-release-pack'));
  for (const mutate of [
    m => { m.exports['./sealed-payload'].import = './dist/other.js'; },
    m => { m.exports['.'].import = './dist/replaced.js'; },
    m => { m.exports['./other'] = './dist/other.js'; },
    m => { m.dependencies = { zod: '4.0.0' }; },
  ]) {
    const invalid = structuredClone(candidate); mutate(invalid); write(invalid);
    assert.throws(() => selectImpact(['packages/core/package.json'], context), /more than/);
  }
  const entry = selectImpact(['packages/core/tsup.config.ts']);
  assert.ok(entry.dirs.includes('packages/core'));
  assert.ok(entry.families.includes('npm-release-pack'));
});

test('keys pi-catalog subpath and its generator admit exact additions only', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-keys-pi-catalog-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'packages/keys'), { recursive: true });
  const file = join(cwd, 'packages/keys/package.json');
  const baseline = { name: '@byok-sdk/keys', version: '0.13.1', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } };
  writeFileSync(file, JSON.stringify(baseline));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'baseline');
  const context = { cwd, base: git('rev-parse', 'HEAD').trim() };
  const candidate = structuredClone(baseline);
  candidate.exports['./pi-catalog'] = { types: './dist/pi-catalog.d.ts', import: './dist/pi-catalog.js' };
  const write = value => writeFileSync(file, JSON.stringify(value));
  write(candidate);
  assert.ok(selectImpact(['packages/keys/package.json'], context).families.includes('npm-release-pack'));
  for (const mutate of [
    m => { m.exports['./pi-catalog'].import = './dist/other.js'; },
    m => { m.exports['.'].import = './dist/replaced.js'; },
    m => { m.exports['./other'] = './dist/other.js'; },
    m => { m.dependencies = { '@earendil-works/pi-ai': '1.3.0' }; },
  ]) {
    const invalid = structuredClone(candidate); mutate(invalid); write(invalid);
    assert.throws(() => selectImpact(['packages/keys/package.json'], context), /more than/);
  }
  const entry = selectImpact(['packages/keys/tsup.config.ts']);
  assert.ok(entry.dirs.includes('packages/keys'));
  assert.ok(entry.families.includes('npm-release-pack'));
  const generator = selectImpact(['scripts/keys/generate-pi-model-catalog.ts']);
  assert.ok(generator.dirs.includes('packages/keys') && generator.dirs.includes('packages/client'));
  assert.throws(() => selectImpact(['scripts/keys/other.ts']));
});

function commit(f, message) {
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', message);
  f.base = git('rev-parse', 'HEAD').trim();
}

test('the Node pin admits one exact X.Y.Z and selects every routine family, never the complete suite', t => {
  const f = fixture(t);
  f.write('.node-version', '24.21.0\n'); commit(f, 'node pin');
  const routine = knownFamilies.filter(id => id !== 'build-test' && id !== 'macos-client').sort();
  for (const value of ['24.22.1\n', '24.22.1', '26.0.0\n']) {
    f.write('.node-version', value);
    assert.deepEqual(selectImpact(['.node-version'], f), { dirs: [], files: ['.node-version'], families: routine, reason: 'impacted' });
  }
  f.write('.node-version', '24.22.1\n');
  const plan = planCi({ event: 'push', sha: f.base, paths: ['.node-version'], ...f });
  assert.deepEqual(plan.families, routine);
  const needs = Object.fromEntries(['select', 'targeted', ...knownFamilies].map(id => [id, { result: ['build-test', 'macos-client'].includes(id) ? 'skipped' : 'success' }]));
  assert.doesNotThrow(() => requireCiPlan(needs, plan, 'push', f.base, f.base, f.cwd));
  needs['build-test'] = { result: 'success' };
  assert.throws(() => requireCiPlan(needs, plan, 'push', f.base, f.base, f.cwd), /unexpectedly ran: build-test/);
  for (const value of ['', '24.22\n', 'v24.22.1\n', '24.22.1-rc.1\n', '>=24.22.1\n', '24.x\n', 'lts/*\n', '24.022.1\n',
    ' 24.22.1\n', '24.22.1 \n', '24.22.1\r\n', '﻿24.22.1\n', '24.22.1\n\n', '24.22.1\n24.22.0\n']) {
    f.write('.node-version', value);
    assert.throws(() => selectImpact(['.node-version'], f), /one exact X\.Y\.Z/, JSON.stringify(value));
  }
  assert.throws(() => selectImpact(['.node-version']), /requires exact CI_BASE/);
  rmSync(join(f.cwd, '.node-version'));
  assert.throws(() => selectImpact(['.node-version'], f));
});

test('a public manifest admits only the engines.node raise from >=24.15.0 to >=24.22.1', t => {
  const f = fixture(t);
  const keys = { name: '@byok-sdk/keys', version: '0.13.1', engines: { node: '>=24.15.0' } };
  const testkit = { name: '@byok-sdk/testkit', private: true, version: '0.0.0', engines: { node: '>=24.15.0' } };
  const root = { ...f.rootManifest, engines: { node: '>=24.15.0' } };
  const raise = (manifest, node = '>=24.22.1') => ({ ...manifest, engines: { ...manifest.engines, node } });
  f.write('packages/keys/package.json', keys); f.write('packages/testkit/package.json', testkit); f.write('package.json', root);
  commit(f, 'engines baseline');
  for (const candidate of [raise(keys), { ...raise(keys), version: '0.13.2' }]) {
    f.write('packages/keys/package.json', candidate);
    assert.deepEqual(selectImpact(['packages/keys/package.json'], f).families, ['npm-release-pack']);
  }
  for (const candidate of [
    raise(keys, '>=24.22.0'), raise(keys, '>=24.23.0'), raise(keys, '^24.22.1'), raise(keys, '>=24.15.0 || >=24.22.1'),
    { ...raise(keys), engines: { node: '>=24.22.1', npm: '>=11' } },
    { name: keys.name, version: keys.version },
    { ...raise(keys), dependencies: { x: '1.0.0' } },
    { ...raise(keys), description: 'neighbour' },
  ]) {
    f.write('packages/keys/package.json', candidate);
    assert.throws(() => selectImpact(['packages/keys/package.json'], f), /more than/, JSON.stringify(candidate));
  }
  f.write('packages/keys/package.json', keys);
  f.write('packages/testkit/package.json', raise(testkit));
  assert.throws(() => selectImpact(['packages/testkit/package.json'], f), /more than/);
  f.write('packages/testkit/package.json', testkit);
  f.write('package.json', raise(root));
  assert.throws(() => selectImpact(['package.json'], f), /more than/);
  f.write('package.json', root);
  for (const [from, to] of [['>=24.22.1', '>=24.15.0'], ['>=24.16.0', '>=24.22.1']]) {
    f.write('packages/keys/package.json', raise(keys, from)); commit(f, `engines ${from}`);
    f.write('packages/keys/package.json', raise(keys, to));
    assert.throws(() => selectImpact(['packages/keys/package.json'], f), /more than/, `${from} -> ${to}`);
  }
});

test('the public manifest list equals the non-private packages in the repository', () => {
  const root = new URL('../../', import.meta.url);
  const actual = [];
  for (const entry of readdirSync(new URL('packages/', root), { withFileTypes: true })) {
    const path = `packages/${entry.name}/package.json`;
    if (!entry.isDirectory() || !existsSync(new URL(path, root))) continue;
    if (JSON.parse(readFileSync(new URL(path, root), 'utf8')).private !== true) actual.push(path);
  }
  assert.deepEqual([...publicManifests].sort(), actual.sort());
});

test('the package graph check maps to the npm release pack job that runs it; siblings still refuse', () => {
  const root = new URL('../../', import.meta.url);
  const path = 'scripts/release/check-package-graph.mjs';
  assert.deepEqual(selectImpact([path]), { dirs: [], files: [path], families: ['npm-release-pack'], reason: 'impacted' });
  const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  const start = workflow.indexOf('\n  npm-release-pack:\n');
  const next = workflow.slice(start + 1).search(/\n  [a-z0-9-]+:\n/);
  assert.ok(start >= 0 && next > 0);
  assert.match(workflow.slice(start, start + 1 + next), /node scripts\/release\/pack-and-smoke\.mjs/);
  assert.match(readFileSync(new URL('scripts/release/pack-and-smoke.mjs', root), 'utf8'), /\['scripts\/release\/check-package-graph\.mjs'\]/);
  for (const [script, { tests, families = [] }] of Object.entries(reviewedScripts)) {
    assert.ok(existsSync(new URL(script, root)), script);
    assert.ok((families.length > 0 || tests.length > 0) && families.every(id => knownFamilies.includes(id) && id !== 'build-test'), script);
  }
  for (const sibling of ['scripts/release/check-package-graph.test.mjs', 'scripts/release/nested/check-package-graph.mjs',
    'scripts/release/check-package-graph.mjs.orig', 'scripts/release/registry-contract.mjs']) {
    assert.throws(() => selectImpact([sibling]), /reviewed CI mapping required/i, sibling);
  }
});

test('the client vendor notice inventory selects the client and the release pack', () => {
  const plan = selectImpact(['packages/client/vendor/third-party-manifest.json']);
  assert.ok(plan.dirs.includes('packages/client') && plan.families.includes('npm-release-pack'));
});

test('#793: the hosted example manifest and lock rows are admitted only with the reviewed shape and reused specs', t => {
  const f = fixture(t);
  const dir = 'examples/hosted-bot-collaboration', path = `${dir}/package.json`;
  const manifest = { name: '@byok-sdk/example-hosted-bot-collaboration', version: '0.0.1', private: true, type: 'module',
    scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' }, dependencies: { '@byok-sdk/client': 'workspace:*', x: '1.0.0' } };
  f.write(path, manifest);
  f.lock.workspaces[dir] = { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies };
  f.lock.packages[manifest.name] = [`${manifest.name}@workspace:${dir}`];
  f.write('bun.lock', f.lock);
  assert.ok(selectImpact([path, 'bun.lock'], f).dirs.includes(dir));
  for (const [candidate, reason] of [
    [{ ...manifest, dependencies: { x: '2.0.0' } }, 'a spec that no other workspace declares'],
    [{ ...manifest, dependencies: { y: '1.0.0' } }, 'a new package'],
    [{ ...manifest, dependencies: { '@byok-sdk/absent': 'workspace:*' } }, 'an unknown workspace'],
    [{ ...manifest, dependencies: { '@byok-sdk/client': '^0.28.0' } }, 'a registry spec for a workspace'],
    [{ ...manifest, private: false }, 'a public manifest'],
    [{ ...manifest, bin: { x: 'x.js' } }, 'an unreviewed field'],
    [{ ...manifest, scripts: { ...manifest.scripts, postinstall: 'x' } }, 'an unreviewed script'],
    [{ ...manifest, description: { text: 'x' } }, 'a description that is not a string'],
  ]) {
    f.write(path, candidate);
    assert.throws(() => selectImpact([path], f), /Reviewed CI mapping required/, reason);
  }
  f.write(path, manifest);
  f.lock.workspaces[dir].dependencies = { x: '1.0.0' }; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /lock rows differ/, 'a lock entry that differs from the manifest');
  f.lock.workspaces[dir].dependencies = manifest.dependencies;
  f.lock.packages[manifest.name] = [`${manifest.name}@workspace:examples/other`]; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /lock rows differ/, 'a package row for another path');
  f.lock.packages[manifest.name] = [`${manifest.name}@workspace:${dir}`];
  f.lock.packages.y = ['y@1.0.0']; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /no declaring workspace/, 'a new resolved package');
});

test('#794 D3: the Worker example manifest and lock rows are admitted by the same reviewed shape, under their own name', t => {
  const f = fixture(t);
  const dir = 'examples/hosted-bot-collaboration-worker', path = `${dir}/package.json`;
  const manifest = { name: '@byok-sdk/example-hosted-bot-collaboration-worker', version: '0.0.1', private: true, type: 'module',
    scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' }, dependencies: { '@byok-sdk/client': 'workspace:*', x: '1.0.0' } };
  f.write(path, manifest);
  f.lock.workspaces[dir] = { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies };
  f.lock.packages[manifest.name] = [`${manifest.name}@workspace:${dir}`];
  f.write('bun.lock', f.lock);
  assert.ok(selectImpact([path, 'bun.lock'], f).dirs.includes(dir));
  for (const [candidate, reason] of [
    [{ ...manifest, name: '@byok-sdk/example-hosted-bot-collaboration' }, 'the H example name'],
    [{ ...manifest, dependencies: { x: '2.0.0' } }, 'a spec that no other workspace declares'],
    [{ ...manifest, private: false }, 'a public manifest'],
  ]) {
    f.write(path, candidate);
    assert.throws(() => selectImpact([path], f), /Reviewed CI mapping required/, reason);
  }
  // The H example cannot vouch for a spec that no other workspace declares, nor the Worker example for H.
  f.write('examples/hosted-bot-collaboration/package.json', { name: '@byok-sdk/example-hosted-bot-collaboration', version: '0.0.1', private: true,
    type: 'module', scripts: manifest.scripts, dependencies: { x: '9.9.9' } });
  f.write(path, { ...manifest, dependencies: { x: '9.9.9' } });
  assert.throws(() => selectImpact([path], f), /may only reuse a declared dependency spec \(x\)/, 'a spec that only the H example declares');
  assert.throws(() => selectImpact(['examples/hosted-bot-collaboration/package.json'], f), /may only reuse a declared dependency spec \(x\)/,
    'a spec that only the Worker example declares');
  f.write(path, manifest);
  f.lock.workspaces[dir].dependencies = { x: '1.0.0' }; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /lock rows differ/, 'a lock entry that differs from the manifest');
});

test('#793: the K8 manifest admits only the reviewed hosted entries, and stays private', t => {
  const f = fixture(t);
  const dir = 'examples/bot-collaboration', path = `${dir}/package.json`;
  const manifest = { name: '@byok-sdk/example-bot-collaboration', private: true, version: '0.0.1', devDependencies: { '@byok-sdk/cloud': 'workspace:*' } };
  f.write(path, manifest);
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'K8 with the cloud edge');
  f.base = git('rev-parse', 'HEAD').trim();
  const exports = {
    './rules/commands': './src/rules/commands.ts', './rules/commit': './src/rules/commit.ts', './model': './src/model.ts',
    './coalesce': './src/coalesce.ts', './team': './src/team.ts', './test-support': './src/commit-vectors.test-support.ts',
  };
  f.write(path, { ...manifest, exports });
  assert.deepEqual(selectImpact([path], f).dirs.filter(name => name === dir), [dir]);
  for (const [candidate, reason] of [
    [{ ...manifest, exports: { ...exports, '.': './src/index.ts' } }, 'a root entry'],
    [{ ...manifest, exports: { ...exports, './host': './src/host.ts' } }, 'another entry'],
    [{ ...manifest, exports, scripts: { test: 'echo bypass' } }, 'another field'],
    [{ ...manifest, exports: { ...exports, './model': './src/index.ts' } }, 'an entry retargeted to another file'],
    [{ ...manifest, exports: Object.fromEntries(Object.entries(exports).filter(([key]) => key !== './team')) }, 'a subset of the entries'],
    [{ ...manifest, exports, devDependencies: { '@byok-sdk/cloud': '^0.28.0' } }, 'a cloud edge retargeted to a registry spec'],
  ]) {
    f.write(path, candidate);
    assert.throws(() => selectImpact([path], f), /more than/, reason);
  }
  f.write(path, { ...manifest, exports, private: false });
  assert.throws(() => selectImpact([path], f), /must stay private/);
  // The entries are admitted only as a new field: a base that already has other entries cannot become these.
  f.write(path, { ...manifest, exports: { './other': './src/other.ts' } });
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'K8 with other entries');
  f.base = git('rev-parse', 'HEAD').trim();
  f.write(path, { ...manifest, exports });
  assert.throws(() => selectImpact([path], f), /more than/, 'a base that already has exports');
});

test('#793 D2g: the K8 manifest admits the retention entries only on top of the hosted entries', t => {
  const f = fixture(t);
  const dir = 'examples/bot-collaboration', path = `${dir}/package.json`;
  const hosted = {
    './rules/commands': './src/rules/commands.ts', './rules/commit': './src/rules/commit.ts', './model': './src/model.ts',
    './coalesce': './src/coalesce.ts', './team': './src/team.ts', './test-support': './src/commit-vectors.test-support.ts',
  };
  const manifest = { name: '@byok-sdk/example-bot-collaboration', private: true, version: '0.0.1', exports: hosted };
  f.write(path, manifest);
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'K8 with the hosted entries');
  f.base = git('rev-parse', 'HEAD').trim();
  const retention = { './retention': './src/retention.ts', './retention-vectors': './src/retention-vectors.test-support.ts' };
  f.write(path, { ...manifest, exports: { ...hosted, ...retention } });
  assert.deepEqual(selectImpact([path], f).dirs.filter(name => name === dir), [dir]);
  for (const [candidate, reason] of [
    [{ ...manifest, exports: { ...hosted, './retention': './src/retention.ts' } }, 'one of the two entries'],
    [{ ...manifest, exports: { ...hosted, ...retention, './host': './src/host.ts' } }, 'another entry'],
    [{ ...manifest, exports: { ...hosted, ...retention, './retention': './src/host.ts' } }, 'an entry retargeted to another file'],
    [{ ...manifest, exports: { ...retention } }, 'the retention entries without the hosted entries'],
  ]) {
    f.write(path, candidate);
    assert.throws(() => selectImpact([path], f), /more than/, reason);
  }
});

test('#793 D2f-1: the K8 manifest admits the routine entries only on top of the hosted and retention entries', t => {
  const f = fixture(t);
  const dir = 'examples/bot-collaboration', path = `${dir}/package.json`;
  const hosted = {
    './rules/commands': './src/rules/commands.ts', './rules/commit': './src/rules/commit.ts', './model': './src/model.ts',
    './coalesce': './src/coalesce.ts', './team': './src/team.ts', './test-support': './src/commit-vectors.test-support.ts',
    './retention': './src/retention.ts', './retention-vectors': './src/retention-vectors.test-support.ts',
  };
  const manifest = { name: '@byok-sdk/example-bot-collaboration', private: true, version: '0.0.1', exports: hosted };
  f.write(path, manifest);
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'K8 with the hosted and retention entries');
  f.base = git('rev-parse', 'HEAD').trim();
  const routines = { './routines': './src/routines.ts', './routine-vectors': './src/routine-vectors.test-support.ts' };
  f.write(path, { ...manifest, exports: { ...hosted, ...routines } });
  assert.deepEqual(selectImpact([path], f).dirs.filter(name => name === dir), [dir]);
  const { './retention': _retention, './retention-vectors': _vectors, ...withoutRetention } = hosted;
  for (const [candidate, reason] of [
    [{ ...manifest, exports: { ...hosted, './routines': './src/routines.ts' } }, 'one of the two entries'],
    [{ ...manifest, exports: { ...hosted, ...routines, './host': './src/host.ts' } }, 'another entry'],
    [{ ...manifest, exports: { ...hosted, ...routines, './routines': './src/host.ts' } }, 'an entry retargeted to another file'],
    [{ ...manifest, exports: { ...withoutRetention, ...routines } }, 'the routine entries without the retention entries'],
  ]) {
    f.write(path, candidate);
    assert.throws(() => selectImpact([path], f), /more than/, reason);
  }
});

test('#793 D2b-out-1: the K8 manifest admits the delivery entries only on top of the hosted, retention and routine entries', t => {
  const f = fixture(t);
  const dir = 'examples/bot-collaboration', path = `${dir}/package.json`;
  const routed = {
    './rules/commands': './src/rules/commands.ts', './rules/commit': './src/rules/commit.ts', './model': './src/model.ts',
    './coalesce': './src/coalesce.ts', './team': './src/team.ts', './test-support': './src/commit-vectors.test-support.ts',
    './retention': './src/retention.ts', './retention-vectors': './src/retention-vectors.test-support.ts',
    './routines': './src/routines.ts', './routine-vectors': './src/routine-vectors.test-support.ts',
  };
  const manifest = { name: '@byok-sdk/example-bot-collaboration', private: true, version: '0.0.1', exports: routed };
  f.write(path, manifest);
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'K8 with the hosted, retention and routine entries');
  f.base = git('rev-parse', 'HEAD').trim();
  const delivery = { './channel': './src/channel.ts', './delivery': './src/delivery.ts', './delivery-routing': './src/delivery-routing.ts',
    './delivery-vectors': './src/delivery-vectors.test-support.ts' };
  f.write(path, { ...manifest, exports: { ...routed, ...delivery } });
  assert.deepEqual(selectImpact([path], f).dirs.filter(name => name === dir), [dir]);
  const { './routines': _routines, './routine-vectors': _vectors, ...withoutRoutines } = routed;
  for (const [candidate, reason] of [
    [{ ...manifest, exports: { ...routed, './channel': './src/channel.ts' } }, 'one of the four entries'],
    [{ ...manifest, exports: { ...routed, ...delivery, './host': './src/host.ts' } }, 'another entry'],
    [{ ...manifest, exports: { ...routed, ...delivery, './delivery': './src/host.ts' } }, 'an entry retargeted to another file'],
    [{ ...manifest, exports: { ...withoutRoutines, ...delivery } }, 'the delivery entries without the routine entries'],
  ]) {
    f.write(path, candidate);
    assert.throws(() => selectImpact([path], f), /more than/, reason);
  }
});

test('#975 slice 2: the K8 manifest admits the migration entry only on top of the hosted, retention, routine and delivery entries', t => {
  const f = fixture(t);
  const dir = 'examples/bot-collaboration', path = `${dir}/package.json`;
  const delivered = {
    './rules/commands': './src/rules/commands.ts', './rules/commit': './src/rules/commit.ts', './model': './src/model.ts',
    './coalesce': './src/coalesce.ts', './team': './src/team.ts', './test-support': './src/commit-vectors.test-support.ts',
    './retention': './src/retention.ts', './retention-vectors': './src/retention-vectors.test-support.ts',
    './routines': './src/routines.ts', './routine-vectors': './src/routine-vectors.test-support.ts',
    './channel': './src/channel.ts', './delivery': './src/delivery.ts', './delivery-routing': './src/delivery-routing.ts',
    './delivery-vectors': './src/delivery-vectors.test-support.ts',
  };
  const manifest = { name: '@byok-sdk/example-bot-collaboration', private: true, version: '0.0.1', exports: delivered };
  f.write(path, manifest);
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'K8 with the hosted, retention, routine and delivery entries');
  f.base = git('rev-parse', 'HEAD').trim();
  const migration = { './migration': './src/migration.ts' };
  f.write(path, { ...manifest, exports: { ...delivered, ...migration } });
  assert.deepEqual(selectImpact([path], f).dirs.filter(name => name === dir), [dir]);
  const { './delivery': _delivery, ...withoutDelivery } = delivered;
  for (const [candidate, reason] of [
    [{ ...manifest, exports: { ...delivered, ...migration, './host': './src/host.ts' } }, 'another entry'],
    [{ ...manifest, exports: { ...delivered, './migration': './src/host.ts' } }, 'the entry retargeted to another file'],
    [{ ...manifest, exports: { ...withoutDelivery, ...migration } }, 'the migration entry without a delivery entry'],
  ]) {
    f.write(path, candidate);
    assert.throws(() => selectImpact([path], f), /more than/, reason);
  }
});

test('#975 slice 5: the K8 manifest admits the switch entry only on top of the entries up to the migration entry', t => {
  const f = fixture(t);
  const dir = 'examples/bot-collaboration', path = `${dir}/package.json`;
  const migrated = {
    './rules/commands': './src/rules/commands.ts', './rules/commit': './src/rules/commit.ts', './model': './src/model.ts',
    './coalesce': './src/coalesce.ts', './team': './src/team.ts', './test-support': './src/commit-vectors.test-support.ts',
    './retention': './src/retention.ts', './retention-vectors': './src/retention-vectors.test-support.ts',
    './routines': './src/routines.ts', './routine-vectors': './src/routine-vectors.test-support.ts',
    './channel': './src/channel.ts', './delivery': './src/delivery.ts', './delivery-routing': './src/delivery-routing.ts',
    './delivery-vectors': './src/delivery-vectors.test-support.ts', './migration': './src/migration.ts',
  };
  const manifest = { name: '@byok-sdk/example-bot-collaboration', private: true, version: '0.0.1', exports: migrated };
  f.write(path, manifest);
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'K8 with the entries up to the migration entry');
  f.base = git('rev-parse', 'HEAD').trim();
  const sw = { './switch': './src/switch.ts' };
  f.write(path, { ...manifest, exports: { ...migrated, ...sw } });
  assert.deepEqual(selectImpact([path], f).dirs.filter(name => name === dir), [dir]);
  const { './migration': _migration, ...withoutMigration } = migrated;
  for (const [candidate, reason] of [
    [{ ...manifest, exports: { ...migrated, ...sw, './host': './src/host.ts' } }, 'another entry'],
    [{ ...manifest, exports: { ...migrated, './switch': './src/host.ts' } }, 'the entry retargeted to another file'],
    [{ ...manifest, exports: { ...withoutMigration, ...sw } }, 'the switch entry without the migration entry'],
  ]) {
    f.write(path, candidate);
    assert.throws(() => selectImpact([path], f), /more than/, reason);
  }
});

test('#658: the K8 cloud edge is admitted only as a workspace spec', t => {
  const f = fixture(t);
  const path = 'examples/bot-collaboration/package.json';
  const manifest = { name: '@byok-sdk/example-bot-collaboration', private: true, version: '0.0.1', devDependencies: {} };
  f.write(path, manifest);
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'K8 without the cloud edge');
  f.base = git('rev-parse', 'HEAD').trim();
  f.write(path, { ...manifest, devDependencies: { '@byok-sdk/cloud': 'workspace:*' } });
  assert.ok(selectImpact([path], f).dirs.includes('examples/bot-collaboration'));
  for (const spec of ['^0.28.0', 'workspace:^', 'file:../../packages/cloud']) {
    f.write(path, { ...manifest, devDependencies: { '@byok-sdk/cloud': spec } });
    assert.throws(() => selectImpact([path], f), /more than/, spec);
  }
});

function rebase(f, message) {
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', message);
  f.base = git('rev-parse', 'HEAD').trim();
}

test('#1106: the K4 manifest drops its core entries only with the demo description, and stays private', t => {
  const f = fixture(t);
  const path = 'examples/host-execution-core/package.json';
  const exports = { '.': './src/index.ts', './canonical': './src/canonical.ts', './test-support': './src/test-support.ts' };
  const description = 'Copy-and-own Host execution core with a durable FIFO, routine ledger and outbox';
  const demo = 'Demo Host composing @byok-sdk/server/execution-core with a real daemon; integration qualification for the published execution core';
  const manifest = { name: '@byok-sdk/example-host-execution-core', private: true, version: '0.0.1', description, exports };
  f.write(path, manifest); rebase(f, 'K4 with its core entries');
  const demoExports = { './test-support': './src/test-support.ts' };
  f.write(path, { ...manifest, description: demo, exports: demoExports });
  assert.ok(selectImpact([path], f).dirs.includes('examples/host-execution-core'));
  for (const [candidate, reason] of [
    [{ ...manifest, exports: demoExports }, 'the entries without the description'],
    [{ ...manifest, description: demo }, 'the description without the entries'],
    [{ ...manifest, description: demo, exports: { ...demoExports, './canonical': './src/canonical.ts' } }, 'an old entry kept'],
    [{ ...manifest, description: demo, exports: demoExports, dependencies: { x: '1.0.0' } }, 'a dependency change'],
  ]) {
    f.write(path, candidate);
    assert.throws(() => selectImpact([path], f), /more than/, reason);
  }
  f.write(path, { ...manifest, private: false, description: demo, exports: demoExports });
  assert.throws(() => selectImpact([path], f), /must stay private/);
});

test('#1106: the protocol manifest admits the agent-memory subpath exactly', t => {
  const f = fixture(t);
  const path = 'packages/protocol/package.json';
  const manifest = { name: '@byok-sdk/protocol', version: '0.31.0', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } };
  f.write(path, manifest); rebase(f, 'protocol without the agent-memory subpath');
  const entry = { types: './dist/agent-memory.d.ts', import: './dist/agent-memory.js' };
  f.write(path, { ...manifest, exports: { ...manifest.exports, './agent-memory': entry } });
  assert.deepEqual(selectImpact([path], f).families, ['npm-release-pack']);
  for (const [exports, reason] of [
    [{ ...manifest.exports, './agent-memory': { ...entry, import: './dist/other.js' } }, 'a retargeted subpath'],
    [{ ...manifest.exports, './agent-memory': entry, './memory': entry }, 'a second subpath'],
  ]) {
    f.write(path, { ...manifest, exports });
    assert.throws(() => selectImpact([path], f), /more than/, reason);
  }
});

test('#1106: the server manifest admits both execution-core subpaths together with existing dependencies, in manifest and lock', t => {
  const f = fixture(t);
  const path = 'packages/server/package.json';
  const root = { types: './dist/index.d.ts', import: './dist/index.js' };
  const manifest = { name: '@byok-sdk/server', version: '0.31.0', exports: { '.': root, './package.json': './package.json' },
    devDependencies: { '@byok-sdk/conformance': 'workspace:*', tsx: '^4.19.2' } };
  f.write(path, manifest);
  f.lock.workspaces['packages/server'] = { name: manifest.name, version: manifest.version, devDependencies: { '@byok-sdk/conformance': 'workspace:*', tsx: '^4.19.2' } };
  f.write('bun.lock', f.lock); rebase(f, 'server without execution-core');
  const core = { types: './dist/execution-core/index.d.ts', import: './dist/execution-core/index.js' };
  const canonical = { types: './dist/execution-core/canonical.d.ts', import: './dist/execution-core/canonical.js' };
  const exports = { '.': root, './execution-core': core, './execution-core/canonical': canonical, './package.json': './package.json' };
  const devDependencies = { '@byok-sdk/conformance': 'workspace:*', tsx: '^4.19.2' };
  f.write(path, { ...manifest, exports, devDependencies });
  f.lock.workspaces['packages/server'].devDependencies = devDependencies; f.write('bun.lock', f.lock);
  assert.ok(selectImpact([path, 'bun.lock'], f).families.includes('npm-release-pack'));
  for (const [candidate, reason] of [
    [{ ...manifest, exports: { ...exports, './execution-core/canonical': undefined } }, 'one subpath without the other'],
    [{ ...manifest, exports: { ...exports, './execution-core': { ...core, import: './dist/other.js' } } }, 'a retargeted subpath'],
    [{ ...manifest, exports: { ...exports, './execution-core/ledger': core } }, 'a third subpath'],
    [{ ...manifest, exports, devDependencies, dependencies: { tsx: '^4.19.2' } }, 'a runtime tsx edge'],
  ]) {
    f.write(path, JSON.parse(JSON.stringify(candidate)));
    assert.throws(() => selectImpact([path], f), /more than/, reason);
  }
  f.write(path, { ...manifest, exports, devDependencies });
  f.lock.workspaces['packages/server'].devDependencies = { ...devDependencies, tsx: '^4.20.0' }; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /differs from manifest/, 'a lock range the manifest does not declare');
});

test('#927: the server manifest admits only the reviewed description without a protocol version', t => {
  const f = fixture(t);
  const path = 'packages/server/package.json';
  const from = 'BYOK SDK server: single-product, single-tenant embedded coordinator over @byok-sdk/cloud — wake-driven HTTP long-poll, protocol v2, memory or single-process SQLite storage.';
  const manifest = { name: '@byok-sdk/server', version: '0.30.1', description: from };
  f.write(path, manifest); rebase(f, 'server with the v2 description');
  f.write(path, { ...manifest, description: from.replace('protocol v2, ', '') });
  assert.deepEqual(selectImpact([path], f).families, ['npm-release-pack']);
  for (const description of [from.replace('protocol v2', 'protocol v3'), 'BYOK SDK server']) {
    f.write(path, { ...manifest, description });
    assert.throws(() => selectImpact([path], f), /more than/, description);
  }
});

test('#927: the cloud-do client test edge is admitted only as a workspace spec, in manifest and lock', t => {
  const f = fixture(t);
  const path = 'packages/cloud-do/package.json';
  const manifest = { name: '@byok-sdk/cloud-do', version: '0.30.1', devDependencies: { '@byok-sdk/keys': 'workspace:*' } };
  f.write(path, manifest);
  f.lock.workspaces['packages/cloud-do'] = { name: manifest.name, version: manifest.version, devDependencies: { '@byok-sdk/keys': 'workspace:*' } };
  f.write('bun.lock', f.lock); rebase(f, 'cloud-do without the client edge');
  const edge = { '@byok-sdk/client': 'workspace:*', '@byok-sdk/keys': 'workspace:*' };
  f.write(path, { ...manifest, devDependencies: edge });
  f.lock.workspaces['packages/cloud-do'].devDependencies = edge; f.write('bun.lock', f.lock);
  const plan = selectImpact([path, 'bun.lock'], f);
  assert.ok(plan.dirs.includes('packages/cloud-do')); assert.deepEqual(plan.families, ['npm-release-pack']);
  for (const spec of ['^0.30.1', 'workspace:^']) {
    f.write(path, { ...manifest, devDependencies: { ...edge, '@byok-sdk/client': spec } });
    assert.throws(() => selectImpact([path], f), /more than/, spec);
  }
  f.write(path, { ...manifest, dependencies: { '@byok-sdk/client': 'workspace:*' } });
  assert.throws(() => selectImpact([path], f), /more than/, 'a runtime edge');
  // The lock row must match the manifest: a reviewed manifest does not admit another lock spec.
  f.write(path, { ...manifest, devDependencies: edge });
  f.lock.workspaces['packages/cloud-do'].devDependencies = { ...edge, '@byok-sdk/client': '^0.30.1' }; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /differs from manifest/, 'a lock range under a workspace manifest');
  f.write(path, manifest);
  f.lock.workspaces['packages/cloud-do'].devDependencies = edge; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /differs from manifest/, 'a lock edge the manifest does not declare');
});

test('keys model-route subpath admits the exact addition only', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-keys-model-route-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'packages/keys'), { recursive: true });
  const file = join(cwd, 'packages/keys/package.json');
  const baseline = { name: '@byok-sdk/keys', version: '0.30.1', exports: {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    './pi-catalog': { types: './dist/pi-catalog.d.ts', import: './dist/pi-catalog.js' },
  } };
  writeFileSync(file, JSON.stringify(baseline));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'baseline');
  const context = { cwd, base: git('rev-parse', 'HEAD').trim() };
  const candidate = structuredClone(baseline);
  candidate.exports['./model-route'] = { types: './dist/model-route.d.ts', import: './dist/model-route.js' };
  const write = value => writeFileSync(file, JSON.stringify(value));
  write(candidate);
  assert.ok(selectImpact(['packages/keys/package.json'], context).families.includes('npm-release-pack'));
  for (const mutate of [
    m => { m.exports['./model-route'].import = './dist/other.js'; },
    m => { m.exports['./model-route'].require = './dist/model-route.cjs'; },
    m => { m.exports['./pi-catalog'].import = './dist/replaced.js'; },
    m => { m.dependencies = { '@byok-sdk/protocol': 'workspace:*' }; },
  ]) {
    const invalid = structuredClone(candidate); mutate(invalid); write(invalid);
    assert.throws(() => selectImpact(['packages/keys/package.json'], context), /more than/);
  }
  const defaults = selectImpact(['packages/keys/src/pi-runtime-defaults.generated.ts']);
  assert.ok(defaults.dirs.includes('packages/keys') && defaults.dirs.includes('packages/client'));
  // The modules split from provider-profile.ts and secret-store.ts keep their Windows custody family.
  for (const path of ['packages/keys/src/provider-profile-binding.ts', 'packages/keys/src/secret-value.ts']) {
    assert.ok(selectImpact([path]).families.includes('adapter-lifecycle-smoke'), path);
  }
});

test('setup documentation admits only exact additive generator commands and its test', t => {
  const f = fixture(t);
  f.write('scripts/docs/device-setup.test.mjs', '');
  f.write('scripts/docs/device-setup.mjs', '');
  const scripts = {
    ...f.rootManifest.scripts,
    'docs:device-setup': 'node scripts/docs/device-setup.mjs --write',
    'check:device-setup': 'node scripts/docs/device-setup.mjs',
    'test:scripts': f.rootManifest.scripts['test:scripts'] + ' scripts/docs/device-setup.test.mjs',
  };
  f.write('package.json', { ...f.rootManifest, scripts });
  assert.equal(selectImpact(['package.json'], f).reason, 'root-ci-scripts');
  for (const name of ['docs:device-setup', 'check:device-setup']) {
    f.write('package.json', { ...f.rootManifest, scripts: { ...scripts, [name]: scripts[name] + ' ; echo bypass' } });
    assert.throws(() => selectImpact(['package.json'], f));
  }
});

// #1104: the packaging example's bundle test (script, runner and lock row) and the client packaging entry.
test('#1104: the packaging example admits only its bundle test, and the client only the ./packaging entry', t => {
  const f = fixture(t);
  const dir = 'examples/packaging';
  const manifest = { name: '@byok-sdk/example-packaging', private: true, version: '0.0.1', scripts: { typecheck: 'tsc --noEmit' }, devDependencies: { esbuild: '^0.27.7', vitest: '^4.1.10' } };
  f.write(`${dir}/package.json`, manifest);
  f.lock.workspaces[dir] = { name: manifest.name, version: manifest.version, devDependencies: { esbuild: '^0.27.7', vitest: '^4.1.10' } };
  f.write('bun.lock', f.lock);
  rebase(f, 'packaging example without a test');
  const tested = { ...manifest, scripts: { ...manifest.scripts, test: 'vitest run' }, devDependencies: { ...manifest.devDependencies, vitest: '^4.1.10' } };
  f.write(`${dir}/package.json`, tested);
  f.lock.workspaces[dir].devDependencies.vitest = '^4.1.10'; f.write('bun.lock', f.lock);
  const plan = selectImpact(['bun.lock', `${dir}/package.json`], f);
  assert.ok(plan.dirs.includes(dir));
  for (const [candidate, reason] of [
    [{ ...tested, scripts: { ...tested.scripts, test: 'vitest run --passWithNoTests' } }, 'another test command'],
    [{ ...tested, dependencies: { x: '1.0.0' } }, 'a dependency change'],
  ]) {
    f.write(`${dir}/package.json`, candidate);
    assert.throws(() => selectImpact([`${dir}/package.json`], f), /more than/, reason);
  }
  f.write(`${dir}/package.json`, { ...tested, private: false });
  assert.throws(() => selectImpact([`${dir}/package.json`], f), /must stay private/);
  f.write(`${dir}/package.json`, tested);
  f.lock.workspaces[dir].devDependencies.vitest = '^5.0.0'; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f));

  const client = 'packages/client/package.json';
  const entry = { types: './dist/adapters/packaging.d.ts', import: './dist/adapters/packaging.js' };
  const root = { '.': { types: './dist/index.d.ts', import: './dist/index.js' } };
  f.write(client, { ...f.manifest, exports: root }); rebase(f, 'client without the packaging entry');
  f.write(client, { ...f.manifest, exports: { ...root, './packaging': entry } });
  assert.deepEqual(selectImpact([client], f).families, ['npm-release-pack']);
  f.write(client, { ...f.manifest, exports: { ...root, './packaging': { ...entry, import: './dist/other.js' } } });
  assert.throws(() => selectImpact([client], f), /more than/);
});

for (const name of ['capability-matrix', 'another-projection']) test(`manifest-owned documentation check: ${name}`, t => {
  const f = fixture(t);
  const source = `scripts/docs/${name}.mjs`, drift = `scripts/docs/${name}.test.mjs`;
  f.write(source, ''); f.write(drift, '');
  const scripts = { ...f.rootManifest.scripts,
    [`docs:${name}`]: `node ${source} --write`, [`check:${name}`]: `node ${source}`,
    'test:scripts': `${f.rootManifest.scripts['test:scripts']} ${drift}` };
  f.write('package.json', { ...f.rootManifest, scripts });
  assert.equal(selectImpact(['package.json', source, drift], f).reason, 'root-ci-scripts');
  for (const input of ['packages/client/package.json', 'packages/client/src/adapters/pi/pi-capabilities.ts',
    'packages/client/src/adapters/claude/claude-version.ts', 'docs/adapter-capabilities.md', source, drift]) {
    assert.deepEqual(documentationTestsForPaths([input], f.cwd), [drift]);
  }
  for (const bad of [
    { ...scripts, [`docs:${name}`]: `node ${source} --write ; echo bypass` },
    { ...scripts, [`check:${name}`]: undefined },
    { ...scripts, 'test:scripts': f.rootManifest.scripts['test:scripts'] },
  ]) {
    f.write('package.json', { scripts: bad });
    assert.throws(() => selectImpact(['package.json', source], f), /Documentation check/);
  }
  f.write('package.json', { scripts });
  assert.throws(() => selectImpact(['scripts/docs/unregistered.mjs'], f), /unmapped/);
});

test('generic example manifest upgrades include the basic workspace', t => {
  const f = fixture(t), path = 'examples/basic/package.json';
  const manifest = { name: '@byok-sdk/example-basic', private: true, version: '0.0.1', devDependencies: { tooling: '1.0.0' } };
  f.write(path, manifest); rebase(f, 'existing basic dependency');
  f.write(path, { ...manifest, devDependencies: { tooling: '2.0.0' } });
  const plan = selectImpact([path], f);
  assert.ok(plan.dirs.includes('examples/basic'));
  assert.ok(plan.families.includes('npm-release-pack'));
  for (const bad of [{ ...manifest, private: false }, { ...manifest, scripts: { test: 'echo bypass' } }, { ...manifest, dependencies: { newEdge: '1.0.0' } }]) {
    f.write(path, bad); assert.throws(() => selectImpact([path], f));
  }
});
