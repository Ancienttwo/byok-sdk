import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { selectImpact, knownFamilies } from './select-impact.mjs';
import { planCi } from './plan-ci.mjs';
import { requireCiPlan } from './require-ci-plan.mjs';
import { reviewedBinOwners } from './reviewed-content.mjs';
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


test('reviewed bin ownership exactly projects public package manifests', () => {
  const actual = {};
  const root = new URL('../../packages/', import.meta.url);
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const manifest = JSON.parse(readFileSync(new URL(`${dir.name}/package.json`, root), 'utf8'));
    if (manifest.private === true) continue;
    for (const name of Object.keys(manifest.bin ?? {})) {
      assert.equal(actual[`bin:${name}`], undefined, `duplicate bin ${name}`);
      actual[`bin:${name}`] = `packages/${dir.name}`;
    }
  }
  assert.deepEqual(reviewedBinOwners, actual);
});

test('bin API deltas select their real owner and unknown bins still fail closed', t => {
  const f = fixture(t);
  for (const [bin, owner] of Object.entries(reviewedBinOwners)) {
    f.write('api-surface/entries.json', { [bin]: { policy: { budgetBytes: 2 } },
      '@byok-sdk/client': { policy: { budgetBytes: 1 } }, '@byok-sdk/core': { policy: { budgetBytes: 1 } } });
    const plan = selectImpact(['api-surface/entries.json'], f);
    assert.ok(plan.dirs.includes(owner), bin);
    if (owner === 'packages/keys') {
      assert.ok(plan.dirs.includes('examples/salesko-connector-broker'));
      assert.ok(plan.dirs.includes('examples/packaging'));
      assert.ok(!plan.dirs.includes('packages/client'));
    }
  }
  f.write('api-surface/entries.json', { 'bin:byok-unreviewed': {} });
  assert.throws(() => selectImpact(['api-surface/entries.json'], f), /unmapped API/);
});

test('private SQLite packaging dependencies are narrowly admitted in manifest and lock', t => {
  const f = fixture(t), dir = 'examples/packaging';
  const manifest = { name: '@byok-sdk/example-packaging', private: true, version: '0.0.1', dependencies: { '@byok-sdk/client': 'workspace:*' } };
  f.write(`${dir}/package.json`, manifest);
  f.lock.workspaces[dir] = structuredClone(manifest);
  delete f.lock.workspaces[dir].private;
  f.write('bun.lock', f.lock);
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'packaging fixture');
  f.base = git('rev-parse', 'HEAD').trim();
  const after = { ...manifest, dependencies: { ...manifest.dependencies, '@byok-sdk/keys': 'workspace:*', '@byok-sdk/server': 'workspace:*' } };
  f.write(`${dir}/package.json`, after);
  f.lock.workspaces[dir].dependencies = { ...after.dependencies };
  f.write('bun.lock', f.lock);
  const plan = selectImpact(['bun.lock', `${dir}/package.json`], f);
  assert.deepEqual(plan.dirs, [dir]);
  assert.deepEqual(plan.families, ['npm-release-pack', 'packageability-smoke']);
  for (const invalid of [
    { ...after, private: false },
    { ...after, scripts: { test: 'echo bypass' } },
    { ...after, dependencies: { ...after.dependencies, '@byok-sdk/keys': '^0.13.1' } },
    { ...after, dependencies: { ...after.dependencies, '@byok-sdk/cloud': 'workspace:*' } },
    { ...after, dependencies: { ...after.dependencies, '@byok-sdk/client': 'workspace:^' } },
  ]) {
    f.write(`${dir}/package.json`, invalid);
    assert.throws(() => selectImpact([`${dir}/package.json`], f));
  }
  f.write(`${dir}/package.json`, after);
  for (const mutate of [
    lock => { lock.workspaces[dir].dependencies['@byok-sdk/keys'] = 'workspace:^'; },
    lock => { delete lock.workspaces[dir].dependencies['@byok-sdk/server']; },
    lock => { lock.workspaces[dir].dependencies['@byok-sdk/cloud'] = 'workspace:*'; },
    lock => { lock.packages.x = ['x@2.0.0']; },
  ]) {
    const invalid = structuredClone(f.lock); mutate(invalid); f.write('bun.lock', invalid);
    assert.throws(() => selectImpact(['bun.lock'], f));
  }
});

test('SQLite packaging root fixtures select both packaging families without admitting siblings', () => {
  for (const path of ['examples/packaging/sqlite-fixture.ts', 'examples/packaging/sqlite-smoke.mjs']) {
    const plan = selectImpact([path]);
    assert.deepEqual(plan.dirs, ['examples/packaging']);
    assert.deepEqual(plan.families, ['npm-release-pack', 'packageability-smoke']);
  }
  assert.equal(selectImpact(['examples/packaging/SQLITE-VALIDATION.md']).reason, 'docs-only');
  assert.throws(() => selectImpact(['examples/packaging/unreviewed.mjs']));
});

test('shared goal fixture selects its consumers without broadening unknown root support files', () => {
  const plan = selectImpact(['examples/basic/goal-btw.test-support.ts']);
  assert.deepEqual(plan.dirs, ['examples/basic', 'examples/bot-collaboration', 'examples/byok-mcp-server', 'examples/host-execution-core']);
  assert.deepEqual(plan.families, ['adapter-lifecycle-smoke']);
  assert.throws(() => selectImpact(['examples/basic/other.test-support.ts']));
});
