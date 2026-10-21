import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { selectImpact } from './select-impact.mjs';

test('helper bundler edge accepts only the reviewed pin and unchanged resolved packages', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-helper-edge-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'packages/client'), { recursive: true });
  const write = (path, value) => writeFileSync(join(cwd, path), JSON.stringify(value));
  const manifest = { name: '@byok-sdk/client', version: '0.28.1', devDependencies: { x: '1.0.0' } };
  const lock = { lockfileVersion: 1, workspaces: { '': { name: 'workspace' }, 'packages/client': structuredClone(manifest) }, packages: { esbuild: ['esbuild@0.28.1'] } };
  write('packages/client/package.json', manifest); write('bun.lock', lock);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'baseline');
  const context = { cwd, base: git('rev-parse', 'HEAD').trim() };
  manifest.devDependencies.esbuild = '0.28.1';
  lock.workspaces['packages/client'].devDependencies.esbuild = '0.28.1';
  write('packages/client/package.json', manifest); write('bun.lock', lock);
  assert.ok(selectImpact(['packages/client/package.json', 'bun.lock'], context).families.includes('npm-release-pack'));
  manifest.devDependencies.esbuild = '0.28.2'; write('packages/client/package.json', manifest);
  assert.throws(() => selectImpact(['packages/client/package.json'], context), /more than/);
  assert.throws(() => selectImpact(['bun.lock'], context), /more than/);
  manifest.devDependencies.esbuild = '0.28.1'; manifest.devDependencies.x = '2.0.0'; write('packages/client/package.json', manifest);
  assert.throws(() => selectImpact(['packages/client/package.json'], context), /more than/);
  lock.packages.esbuild = ['esbuild@0.28.2']; write('bun.lock', lock);
  assert.throws(() => selectImpact(['bun.lock'], context), /more than/);
});

test('helper smoke and source contract select client and packaging without accepting sibling scripts', () => {
  for (const path of ['packages/client/scripts/packed-agent-memory-helper-smoke.mjs', 'scripts/release/agent-memory-helper-source.test.mjs']) {
    const plan = selectImpact([path]);
    assert.ok(plan.dirs.includes('packages/client'));
    for (const family of ['agent-memory-helper', 'agent-memory-helper-linux', 'npm-release-pack']) assert.ok(plan.families.includes(family));
  }
  assert.throws(() => selectImpact(['packages/client/scripts/packed-other-smoke.mjs']));
  assert.throws(() => selectImpact(['scripts/release/unreviewed.test.mjs']));
});
