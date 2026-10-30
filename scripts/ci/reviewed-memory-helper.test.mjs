import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { selectImpact } from './select-impact.mjs';

test('existing bundler versions may upgrade while new dependency edges fail closed', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-helper-edge-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'packages/client'), { recursive: true });
  const write = (path, value) => writeFileSync(join(cwd, path), JSON.stringify(value));
  const manifest = { name: '@byok-sdk/client', version: '0.28.1', devDependencies: { x: '1.0.0', esbuild: '0.28.1' } };
  const lock = { lockfileVersion: 1, workspaces: { '': { name: 'workspace' }, 'packages/client': structuredClone(manifest) }, packages: { esbuild: ['esbuild@0.28.1'] } };
  write('package.json', { name: 'workspace' });
  write('packages/client/package.json', manifest); write('bun.lock', lock);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'baseline');
  const context = { cwd, base: git('rev-parse', 'HEAD').trim() };
  manifest.devDependencies.esbuild = '0.28.1';
  lock.workspaces['packages/client'].devDependencies.esbuild = '0.28.1';
  write('packages/client/package.json', manifest); write('bun.lock', lock);
  assert.ok(selectImpact(['packages/client/package.json', 'bun.lock'], context).families.includes('npm-release-pack'));
  manifest.devDependencies.esbuild = '0.28.2'; write('packages/client/package.json', manifest);
  assert.ok(selectImpact(['packages/client/package.json'], context).dirs.includes('packages/client'));
  assert.throws(() => selectImpact(['bun.lock'], context), /differs from manifest/);
  manifest.devDependencies.esbuild = '0.28.1'; manifest.devDependencies.x = '2.0.0'; write('packages/client/package.json', manifest);
  assert.ok(selectImpact(['packages/client/package.json'], context).dirs.includes('packages/client'));
  manifest.devDependencies.newBundler = '1.0.0'; write('packages/client/package.json', manifest);
  assert.throws(() => selectImpact(['packages/client/package.json'], context), /more than/);
  delete manifest.devDependencies.newBundler; write('packages/client/package.json', manifest);
  lock.packages.esbuild = ['esbuild@0.28.2']; write('bun.lock', lock);
  assert.throws(() => selectImpact(['bun.lock'], context), /differs from manifest/);
});

test('helper smoke and source contract select client and packaging without accepting sibling scripts', () => {
  for (const path of ['packages/client/scripts/packed-agent-memory-helper-smoke.mjs', 'scripts/release/agent-memory-helper-source.test.mjs']) {
    const plan = selectImpact([path]);
    assert.ok(plan.dirs.includes('packages/client'));
    for (const family of ['agent-memory-helper', 'agent-memory-helper-non-darwin', 'npm-release-pack']) assert.ok(plan.families.includes(family));
  }
  assert.throws(() => selectImpact(['packages/client/scripts/packed-other-smoke.mjs']));
  assert.throws(() => selectImpact(['scripts/release/unreviewed.test.mjs']));
});


test('Hermes private session mapping and smoke admit exact additions only', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-hermes-entry-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'packages/client'), { recursive: true });
  const file = join(cwd, 'packages/client/package.json');
  const baseline = { name: '@byok-sdk/client', version: '0.28.1', imports: { '#existing': './dist/existing.js' }, scripts: { build: 'tsup' } };
  writeFileSync(file, JSON.stringify(baseline));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'baseline');
  const context = { cwd, base: git('rev-parse', 'HEAD').trim() };
  const candidate = structuredClone(baseline);
  candidate.imports['#byok-hermes-session'] = { types: './dist/adapters/hermes/hermes-session-runtime.d.ts', default: './dist/adapters/hermes/hermes-session-runtime.js' };
  candidate.scripts.build += ' && node scripts/check-hermes-session-entry.mjs';
  const write = value => writeFileSync(file, JSON.stringify(value));
  write(candidate);
  assert.ok(selectImpact(['packages/client/package.json'], context).families.includes('npm-release-pack'));
  for (const mutate of [
    m => { m.imports['#byok-hermes-session'].default = './dist/other.js'; },
    m => { m.imports['#existing'] = './dist/replaced.js'; },
    m => { m.scripts.build = 'echo skipped'; },
    m => { m.dependencies = { unreviewed: '1.0.0' }; },
    m => { m.exports = { './new': './dist/new.js' }; },
  ]) {
    const invalid = structuredClone(candidate); mutate(invalid); write(invalid);
    assert.throws(() => selectImpact(['packages/client/package.json'], context), /more than/);
  }
  for (const path of ['packages/client/scripts/check-hermes-session-entry.mjs', 'packages/client/tsup.config.ts']) {
    const impact = selectImpact([path]);
    assert.ok(impact.dirs.includes('packages/client'));
    assert.ok(impact.families.includes('npm-release-pack'));
    assert.ok(!impact.families.includes('build-test'));
  }
  assert.throws(() => selectImpact(['packages/client/scripts/check-other-entry.mjs']));
});

test('client testing entry admits the exact reviewed export only', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-testing-entry-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'packages/client'), { recursive: true });
  const file = join(cwd, 'packages/client/package.json');
  const baseline = { name: '@byok-sdk/client', version: '0.28.1', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } };
  writeFileSync(file, JSON.stringify(baseline));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'baseline');
  const context = { cwd, base: git('rev-parse', 'HEAD').trim() };
  const candidate = structuredClone(baseline);
  candidate.exports['./testing'] = { types: './dist/testing/index.d.ts', import: './dist/testing/index.js' };
  const write = value => writeFileSync(file, JSON.stringify(value));
  write(candidate);
  assert.ok(selectImpact(['packages/client/package.json'], context).families.includes('npm-release-pack'));
  for (const mutate of [
    m => { m.exports['./testing'].import = './dist/other.js'; },
    m => { m.exports['./testing'].default = './dist/testing/index.js'; },
    m => { m.exports['./other'] = { types: './dist/other.d.ts', import: './dist/other.js' }; },
    m => { m.exports['.'].import = './dist/replaced.js'; },
  ]) {
    const invalid = structuredClone(candidate); mutate(invalid); write(invalid);
    assert.throws(() => selectImpact(['packages/client/package.json'], context), /more than/);
  }
});

test('the client entry check selects client packaging without broad fallback', () => {
  const impact = selectImpact(['packages/client/scripts/check-adapters-entry.mjs']);
  assert.ok(impact.dirs.includes('packages/client'));
  assert.ok(impact.families.includes('npm-release-pack'));
  assert.throws(() => selectImpact(['packages/client/scripts/check-unreviewed-entry.mjs']));
});
