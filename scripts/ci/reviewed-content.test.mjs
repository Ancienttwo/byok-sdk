import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { selectImpact, knownFamilies, reviewedScripts } from './select-impact.mjs';
import { planCi } from './plan-ci.mjs';
import { requireCiPlan } from './require-ci-plan.mjs';
import { publicManifests, PI_LOCK, PI_PACKAGES } from './reviewed-content.mjs';
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-reviewed-content-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const write = (path, value) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), typeof value === 'string' ? value : JSON.stringify(value)); };
  const manifest = { name: '@byok-sdk/client', version: '0.28.0', dependencies: { x: '1.0.0' } };
  const rootManifest = { scripts: { 'test:scripts': 'node --test --test-concurrency=1 scripts/old.test.mjs' } };
  const lock = { lockfileVersion: 1, workspaces: { '': { name: 'workspace' }, 'packages/client': { name: manifest.name, version: manifest.version } }, packages: { x: ['x@1.0.0'] } };
  write('packages/client/package.json', manifest); write('package.json', rootManifest); write('bun.lock', lock);
  write('api-surface/entries.json', { '@byok-sdk/client': { policy: { budgetBytes: 1 } }, '@byok-sdk/core': { policy: { budgetBytes: 1 } } });
  write('scripts/ci/new.test.mjs', '');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'baseline');
  return { cwd, base: git('rev-parse', 'HEAD').trim(), write, manifest, rootManifest, lock };
}
test('version-only manifests and lock select packaging, not workspace suites; dependencies fail closed', t => {
  const f = fixture(t);
  f.write('packages/client/package.json', { ...f.manifest, version: '0.28.1' });
  f.lock.workspaces['packages/client'].version = '0.28.1'; f.write('bun.lock', f.lock);
  const plan = selectImpact(['packages/client/package.json', 'bun.lock'], f);
  assert.deepEqual(plan.dirs, []); assert.deepEqual(plan.families, ['npm-release-pack']);
  f.write('packages/client/package.json', { ...f.manifest, version: '0.28.1', dependencies: { x: '2.0.0' } });
  assert.throws(() => selectImpact(['packages/client/package.json'], f), /more than/);
  f.lock.packages.x = ['x@2.0.0']; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /more than/);
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
  assert.ok(selectImpact(['packages/client/vendor/oar/c88a514/runtimes/grok/session.ts']).dirs.includes('packages/client'));
  assert.deepEqual(selectImpact(['scripts/release/registry-contract.test.mjs', 'scripts/release/registry-expectations.json']).dirs, []);
  assert.throws(() => selectImpact(['packages/client/vendor/oar/c88a514/unreviewed.ts']));
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
  f.lock.packages.x = ['x@2.0.0']; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /more than/);
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
  const routine = knownFamilies.filter(id => id !== 'build-test').sort();
  for (const value of ['24.22.1\n', '24.22.1', '26.0.0\n']) {
    f.write('.node-version', value);
    assert.deepEqual(selectImpact(['.node-version'], f), { dirs: [], files: ['.node-version'], families: routine, reason: 'impacted' });
  }
  f.write('.node-version', '24.22.1\n');
  const plan = planCi({ event: 'push', sha: f.base, paths: ['.node-version'], ...f });
  assert.deepEqual(plan.families, routine);
  const needs = Object.fromEntries(['select', 'targeted', ...knownFamilies].map(id => [id, { result: id === 'build-test' ? 'skipped' : 'success' }]));
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

test('reviewed undici security move admits only the exact pins and their lock entry (#700)', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-undici-move-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const write = (path, value) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), JSON.stringify(value)); };
  const resolved = {
    '8.11.2': ['undici@8.11.2', '', {}, 'sha512-u4UB2/IrKdU6lFxumHmmo1a3fCQO5tzQllRorfoRS63txhrB7xTpSn1PftwC4qEHkOaqP95fCWW4lJzwErwzhQ=='],
    '8.12.3': ['undici@8.12.3', '', {}, 'sha512-+fdndUTwBP86cVjihTp21hZHo7d6oj1c/47XPA3lL8mM0XHs+C4EkcjmgRsFnFk2f/UONGDy9ItBItmXsLOQHw=='],
    '8.12.1': ['undici@8.12.1', '', {}, 'sha512-unpatched'],
  };
  const state = pin => ({
    client: { name: '@byok-sdk/client', version: '0.28.1', dependencies: { undici: pin, x: '1.0.0' } },
    dataplane: { name: '@byok-sdk/cloud-dataplane', version: '0.28.1', devDependencies: { undici: pin } },
    lock: { lockfileVersion: 1, workspaces: { '': { name: 'workspace' },
      'packages/client': { name: '@byok-sdk/client', version: '0.28.1', dependencies: { undici: pin, x: '1.0.0' } },
      'packages/cloud-dataplane': { name: '@byok-sdk/cloud-dataplane', version: '0.28.1', devDependencies: { undici: pin } } },
    packages: { undici: resolved[pin], x: ['x@1.0.0'], '@earendil-works/pi-coding-agent/undici': ['undici@8.10.2', '', {}, 'sha512-pi'] } },
  });
  const apply = ({ client, dataplane, lock }) => {
    write('packages/client/package.json', client); write('packages/cloud-dataplane/package.json', dataplane); write('bun.lock', lock);
  };
  apply(state('8.11.2'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'baseline');
  const context = { cwd, base: git('rev-parse', 'HEAD').trim() };
  apply(state('8.12.3'));
  const plan = selectImpact(['bun.lock', 'packages/client/package.json', 'packages/cloud-dataplane/package.json'], context);
  assert.ok(plan.dirs.includes('packages/client') && plan.dirs.includes('packages/cloud-dataplane'));
  assert.ok(plan.families.includes('npm-release-pack') && plan.families.includes('dataplane'));
  // Each guard is checked on its own path, so a refusal cannot come from a sibling path.
  const moved = mutate => { const s = state('8.12.3'); mutate(s); return s; };
  const refused = { client: /packages\/client\/package\.json changes more than/, dataplane: /packages\/cloud-dataplane\/package\.json changes more than/,
    lock: /bun\.lock changes more than/, together: /bun\.lock must move both undici pins and the resolved undici entry together/ };
  for (const [reason, candidate, path, pattern] of [
    ['unpatched client pin', state('8.12.1'), 'packages/client/package.json', refused.client],
    ['client range pin', moved(s => { s.client.dependencies.undici = '^8.12.3'; }), 'packages/client/package.json', refused.client],
    ['another dependency next to undici', moved(s => { s.client.dependencies.x = '2.0.0'; }), 'packages/client/package.json', refused.client],
    ['unpatched dataplane pin', state('8.12.1'), 'packages/cloud-dataplane/package.json', refused.dataplane],
    ['undici in another manifest field', moved(s => { s.dataplane.dependencies = s.dataplane.devDependencies; delete s.dataplane.devDependencies; }), 'packages/cloud-dataplane/package.json', refused.dataplane],
    ['unpatched lock', state('8.12.1'), 'bun.lock', refused.lock],
    ['another lock dependency next to undici', moved(s => { s.lock.workspaces['packages/client'].dependencies.x = '2.0.0'; s.lock.packages.x = ['x@2.0.0']; }), 'bun.lock', refused.lock],
    ['another integrity', moved(s => { s.lock.packages.undici = [...resolved['8.12.3'].slice(0, 3), 'sha512-other']; }), 'bun.lock', refused.together],
    ['Pi undici copy', moved(s => { s.lock.packages['@earendil-works/pi-coding-agent/undici'] = resolved['8.12.3']; }), 'bun.lock', refused.lock],
    ['resolved package without a pin move', (s => { s.lock.packages.undici = resolved['8.12.3']; return s; })(state('8.11.2')), 'bun.lock', refused.lock],
    ['lock pin move while the manifests stay', moved(s => { s.client.dependencies.undici = '8.11.2'; s.dataplane.devDependencies.undici = '8.11.2'; }), 'bun.lock', refused.lock],
    ['pin move without the resolved move', moved(s => { s.lock.packages.undici = resolved['8.11.2']; }), 'bun.lock', refused.together],
    ['partial pin move', moved(s => { s.lock.workspaces['packages/cloud-dataplane'].devDependencies.undici = '8.11.2'; }), 'bun.lock', refused.together],
  ]) {
    apply(candidate);
    assert.throws(() => selectImpact([path], context), pattern, reason);
  }
});

test('reviewed Pi 1.4.0 move admits only all nine exact pins and the reviewed lock rows', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-pi-move-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const write = (path, value) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), JSON.stringify(value)); };
  const CLIENT = ['pi-coding-agent', 'pi-ai', 'pi-agent-core', 'pi-durable', 'chord'].map(name => `@earendil-works/${name}`);
  const CLOUD_DO = ['pi-durable', 'pi-ai', 'chord'].map(name => `@earendil-works/${name}`);
  const pins = (names, pin) => Object.fromEntries(names.map(name => [name, pin]));
  const rows = pin => pin === '1.4.0'
    ? Object.fromEntries([...PI_PACKAGES, 'marked-cjk-friendly'].map(name => [name, PI_LOCK[name]]))
    : Object.fromEntries(PI_PACKAGES.map(name => [name, [`${name}@${pin}`, '', {}, `sha512-${name}`]]));
  const state = pin => ({
    root: { name: 'workspace', scripts: { 'test:scripts': 'node --test --test-concurrency=1 scripts/ci/a.test.mjs' }, overrides: pins(PI_PACKAGES, pin) },
    client: { name: '@byok-sdk/client', version: '0.30.0', byok: { piRuntimePin: pin }, dependencies: { ...pins(CLIENT, pin), x: '1.0.0' } },
    cloudDo: { name: '@byok-sdk/cloud-do', version: '0.30.0', dependencies: pins(CLOUD_DO, pin) },
    lock: { lockfileVersion: 1, workspaces: { '': { name: 'workspace' },
      'packages/client': { name: '@byok-sdk/client', version: '0.30.0', dependencies: { ...pins(CLIENT, pin), x: '1.0.0' } },
      'packages/cloud-do': { name: '@byok-sdk/cloud-do', version: '0.30.0', dependencies: pins(CLOUD_DO, pin) } },
    overrides: pins(PI_PACKAGES, pin), packages: { ...rows(pin), x: ['x@1.0.0'] } },
  });
  const apply = ({ root, client, cloudDo, lock }) => {
    write('package.json', root); write('packages/client/package.json', client); write('packages/cloud-do/package.json', cloudDo); write('bun.lock', lock);
  };
  apply(state('1.3.0'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'baseline');
  const context = { cwd, base: git('rev-parse', 'HEAD').trim() };
  apply(state('1.4.0'));
  const plan = selectImpact(['package.json', 'bun.lock', 'packages/client/package.json', 'packages/cloud-do/package.json'], context);
  assert.ok(plan.dirs.includes('packages/client') && plan.dirs.includes('packages/cloud-do'));
  assert.ok(plan.families.includes('npm-release-pack'));
  const moved = mutate => { const s = state('1.4.0'); mutate(s); return s; };
  const refused = { root: /package\.json changes more than/, client: /packages\/client\/package\.json changes more than/,
    cloudDo: /packages\/cloud-do\/package\.json changes more than/, lock: /bun\.lock changes more than/,
    together: /bun\.lock must move every Pi pin, the overrides and the reviewed Pi lock rows together/ };
  for (const [reason, candidate, path, pattern] of [
    ['one override left behind', moved(s => { s.root.overrides['@earendil-works/pi-tui'] = '1.3.0'; }), 'package.json', refused.root],
    ['client range pin', moved(s => { s.client.dependencies['@earendil-works/pi-ai'] = '^1.4.0'; }), 'packages/client/package.json', refused.client],
    ['partial client move', moved(s => { s.client.dependencies['@earendil-works/chord'] = '1.3.0'; }), 'packages/client/package.json', refused.client],
    ['another dependency next to Pi', moved(s => { s.client.dependencies.x = '2.0.0'; }), 'packages/client/package.json', refused.client],
    ['runtime pin left behind', moved(s => { s.client.byok.piRuntimePin = '1.3.0'; }), 'packages/client/package.json', /must move byok\.piRuntimePin with the Pi pins/],
    ['another Pi version', state('1.4.1'), 'packages/cloud-do/package.json', refused.cloudDo],
    ['another lock dependency next to Pi', moved(s => { s.lock.workspaces['packages/client'].dependencies.x = '2.0.0'; s.lock.packages.x = ['x@2.0.0']; }), 'bun.lock', refused.lock],
    ['another integrity', moved(s => { s.lock.packages['@earendil-works/pi-ai'] = [...PI_LOCK['@earendil-works/pi-ai'].slice(0, 3), 'sha512-other']; }), 'bun.lock', refused.together],
    ['new dependency row missing', moved(s => { delete s.lock.packages['marked-cjk-friendly']; }), 'bun.lock', refused.together],
    ['overrides left behind', moved(s => { s.lock.overrides = pins(PI_PACKAGES, '1.3.0'); }), 'bun.lock', refused.together],
    ['partial workspace move', moved(s => { s.lock.workspaces['packages/cloud-do'].dependencies = pins(CLOUD_DO, '1.3.0'); }), 'bun.lock', refused.together],
    ['rows without a pin move', (s => { s.lock.packages = { ...rows('1.4.0'), x: ['x@1.0.0'] }; return s; })(state('1.3.0')), 'bun.lock', refused.lock],
  ]) {
    apply(candidate);
    assert.throws(() => selectImpact([path], context), pattern, reason);
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
  assert.throws(() => selectImpact(['bun.lock'], f), /more than/, 'a new resolved package');
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

test('#884: the K4 manifest admits only the I/O-free ./canonical entry', t => {
  const f = fixture(t);
  const path = 'examples/host-execution-core/package.json';
  const exports = { '.': './src/index.ts', './test-support': './src/test-support.ts' };
  const manifest = { name: '@byok-sdk/example-host-execution-core', private: true, version: '0.0.1', exports };
  f.write(path, manifest);
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'K4 without the canonical entry');
  f.base = git('rev-parse', 'HEAD').trim();
  f.write(path, { ...manifest, exports: { '.': './src/index.ts', './canonical': './src/canonical.ts', './test-support': './src/test-support.ts' } });
  assert.ok(selectImpact([path], f).dirs.includes('examples/host-execution-core'));
  for (const [candidate, reason] of [
    [{ ...manifest, exports: { ...exports, './canonical': './src/model.ts' } }, 'the entry retargeted to another file'],
    [{ ...manifest, exports: { ...exports, './canonical': './src/canonical.ts', './ledger': './src/ledger.ts' } }, 'a second new entry'],
    [{ ...manifest, exports: { ...exports, './canonical': './src/canonical.ts' }, dependencies: { x: '1.0.0' } }, 'a dependency change'],
  ]) {
    f.write(path, candidate);
    assert.throws(() => selectImpact([path], f), /more than/, reason);
  }
  f.write(path, { ...manifest, private: false, exports: { ...exports, './canonical': './src/canonical.ts' } });
  assert.throws(() => selectImpact([path], f), /must stay private/);
});

function rebase(f, message) {
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', message);
  f.base = git('rev-parse', 'HEAD').trim();
}

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
  assert.throws(() => selectImpact(['bun.lock'], f), /more than/, 'a lock range under a workspace manifest');
  f.write(path, manifest);
  f.lock.workspaces['packages/cloud-do'].devDependencies = edge; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /more than/, 'a lock edge the manifest does not declare');
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
