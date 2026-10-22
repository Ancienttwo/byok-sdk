import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { selectImpact, knownFamilies, reviewedReleaseScripts } from './select-impact.mjs';
import { planCi } from './plan-ci.mjs';
import { requireCiPlan } from './require-ci-plan.mjs';
import { publicManifests } from './reviewed-content.mjs';
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
  assert.deepEqual(selectImpact(['api-surface/entries.json'], f).dirs.filter(dir => dir.startsWith('packages/')), ['packages/client']);
  f.write('api-surface/entries.json', { '@byok-sdk/client': { policy: { budgetBytes: 1 } }, '@byok-sdk/core': { policy: { budgetBytes: 1 } }, 'bin:byok-unknown': {} });
  assert.throws(() => selectImpact(['api-surface/entries.json'], f), /unmapped API entry bin:byok-unknown/);
});
test('reviewed vendor and registry paths map explicitly, siblings still refuse', () => {
  assert.ok(selectImpact(['packages/client/vendor/oar/60ad09b/runtimes/grok/session.ts']).dirs.includes('packages/client'));
  assert.deepEqual(selectImpact(['scripts/release/registry-contract.test.mjs', 'scripts/release/registry-expectations.json']).dirs, []);
  assert.throws(() => selectImpact(['packages/client/vendor/oar/60ad09b/unreviewed.ts']));
  assert.throws(() => selectImpact(['scripts/release/publish.mjs']));
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
  assert.deepEqual(plan.dirs, ['examples/basic', 'examples/bot-collaboration', 'examples/byok-mcp-server', 'examples/host-execution-core']);
  assert.deepEqual(plan.families, ['adapter-lifecycle-smoke']);
  assert.throws(() => selectImpact(['examples/basic/other.test-support.ts']));
});

test('result-helper close regression selects only its exact basic workspace path', () => {
  assert.deepEqual(selectImpact(['examples/basic/goal-btw-close.test.ts']).dirs, ['examples/basic']);
  assert.throws(() => selectImpact(['examples/basic/goal-btw-close-other.test.ts']));
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
  for (const [script, families] of Object.entries(reviewedReleaseScripts)) {
    assert.ok(existsSync(new URL(script, root)), script);
    assert.ok(families.length > 0 && families.every(id => knownFamilies.includes(id) && id !== 'build-test'), script);
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
