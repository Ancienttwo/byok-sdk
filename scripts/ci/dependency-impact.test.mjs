import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { selectImpact, knownFamilies } from './select-impact.mjs';
import { planCi, needsBuild } from './plan-ci.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'dependency-impact-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const write = (p, value) => { mkdirSync(dirname(join(cwd, p)), { recursive: true }); writeFileSync(join(cwd, p), JSON.stringify(value)); };
  const root = { name: 'root', scripts: { 'test:scripts': 'node --test --test-concurrency=1 scripts/old.test.mjs' }, devDependencies: { compiler: '1.0.0' } };
  const client = { name: '@byok-sdk/client', version: '0.31.0', dependencies: { 'new-library': '1.0.0' } };
  const ui = { name: '@byok-sdk/ui-runtime', version: '0.31.0', dependencies: { unrelated: '1.0.0' } };
  const lock = { lockfileVersion: 1, workspaces: {
    '': { name: root.name, devDependencies: root.devDependencies },
    'packages/client': client, 'packages/ui-runtime': ui,
  }, packages: {
    compiler: ['compiler@1.0.0', '', {}],
    'new-library': ['new-library@1.0.0', '', { dependencies: { nested: '^1.0.0' } }],
    nested: ['nested@1.0.0', '', {}], unrelated: ['unrelated@1.0.0', '', {}],
  } };
  write('package.json', root); write('packages/client/package.json', client); write('packages/ui-runtime/package.json', ui); write('bun.lock', lock);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init'); git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'base');
  return { cwd, base: git('rev-parse', 'HEAD'), root, client, ui, lock, write };
}

test('never-listed dependency upgrade creates a build/typecheck/test and platform plan', t => {
  const f = fixture(t);
  f.client.dependencies['new-library'] = '2.0.0';
  f.lock.packages['new-library'][0] = 'new-library@2.0.0';
  f.write('packages/client/package.json', f.client); f.write('bun.lock', f.lock);
  const plan = planCi({ ...f, event: 'pull_request', sha: 'a'.repeat(40), paths: ['packages/client/package.json', 'bun.lock'] });
  assert.equal(needsBuild(plan), true);
  assert.ok(plan.dirs.includes('packages/client'));
  assert.ok(plan.dirs.includes('examples/basic'), 'reverse workspace consumer');
  for (const id of ['npm-release-pack', 'windows-client', 'adapter-lifecycle-smoke']) assert.ok(plan.families.includes(id));
  assert.ok(!plan.families.includes('build-test') && !plan.families.includes('macos-client'));
});

test('transitive lock-only security upgrade selects its consumers', t => {
  const f = fixture(t);
  f.lock.packages.nested[0] = 'nested@1.0.1'; f.write('bun.lock', f.lock);
  const plan = selectImpact(['bun.lock'], f);
  assert.ok(plan.dirs.includes('packages/client'));
  assert.ok(!plan.dirs.includes('packages/ui-runtime'));
  assert.ok(plan.families.includes('npm-release-pack'));
});

test('root tool upgrades qualify every workspace and routine platform family', t => {
  const f = fixture(t);
  f.root.devDependencies.compiler = '2.0.0'; f.lock.packages.compiler[0] = 'compiler@2.0.0';
  f.write('package.json', f.root); f.write('bun.lock', f.lock);
  const plan = selectImpact(['package.json', 'bun.lock'], f);
  assert.ok(plan.dirs.includes('packages/client') && plan.dirs.includes('packages/ui-runtime'));
  assert.deepEqual(plan.families, knownFamilies.filter(id => !['build-test', 'macos-client'].includes(id)).sort());
});

test('unrelated manifest edits and lock mismatches are not hidden by a version upgrade', t => {
  const f = fixture(t);
  f.client.dependencies['new-library'] = '2.0.0';
  f.write('packages/client/package.json', { ...f.client, scripts: { test: 'echo bypass' } });
  assert.throws(() => selectImpact(['packages/client/package.json'], f), /more than/);
  f.write('packages/client/package.json', f.client);
  f.lock.workspaces['packages/client'] = { ...f.client, dependencies: { 'new-library': '1.0.0' } };
  f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /differs from manifest/);
});

test('an orphan lock row is rejected even beside a valid transitive upgrade', t => {
  const f = fixture(t);
  f.lock.packages.nested[0] = 'nested@1.0.1';
  f.lock.packages.orphan = ['orphan@1.0.0', '', {}]; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /no declaring workspace/);
});
