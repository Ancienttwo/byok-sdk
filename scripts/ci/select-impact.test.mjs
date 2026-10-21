import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { knownFamilies, selectImpact, workspaceGraph } from './select-impact.mjs';
const root = new URL('../../', import.meta.url);

test('reviewed graph covers every workspace and all local dependency edges', () => {
  const actual = {};
  for (const prefix of ['packages', 'examples']) {
    for (const entry of readdirSync(new URL(`${prefix}/`, root), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let manifest;
      try { manifest = JSON.parse(readFileSync(new URL(`${prefix}/${entry.name}/package.json`, root), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      actual[`${prefix}/${entry.name}`] = { name: manifest.name, dependencies: [...new Set(
        ['dependencies', 'devDependencies', 'peerDependencies'].flatMap(field => Object.keys(manifest[field] ?? {}).filter(name => name.startsWith('@byok-sdk/'))),
      )].sort() };
    }
  }
  assert.deepEqual(workspaceGraph, actual);
});

test('docs and known CI contracts select light checks, not release families', () => {
  assert.deepEqual(selectImpact(['README.md', 'docs/releases/v0.28.1.md']), {
    dirs: [], files: ['README.md', 'docs/releases/v0.28.1.md'], families: [], reason: 'docs-only',
  });
  for (const path of ['.github/workflows/ci.yml', '.github/workflows/release.yml', 'scripts/ci/select-impact.mjs']) {
    assert.equal(selectImpact([path]).reason, 'root-ci-scripts');
    assert.deepEqual(selectImpact([path]).families, []);
  }
});

test('client source/deleted tests select native safety families and reverse dependents', () => {
  for (const path of ['packages/client/src/daemon/task-runner.ts', 'packages/client/src/__tests__/deleted.test.ts', 'api-surface/client.d.ts']) {
    const impact = selectImpact([path]);
    assert.ok(impact.dirs.includes('packages/client'));
    assert.ok(impact.dirs.includes('examples/host-execution-core'));
    for (const family of ['execution-recovery-native', 'credential-isolation-audit', 'ipc-smoke', 'windows-git-workspace', 'adapter-lifecycle-smoke', 'agent-memory-helper', 'agent-memory-helper-linux', 'packageability-smoke', 'windows-service-smoke']) assert.ok(impact.families.includes(family), family);
    assert.ok(!impact.families.includes('build-test'));
    assert.ok(!impact.families.includes('npm-release-pack'));
  }
});

test('shared protocol changes propagate through multiple dependency levels', () => {
  const impact = selectImpact(['packages/protocol/src/task.ts']);
  for (const dir of ['packages/server', 'packages/client', 'packages/cloud-dataplane', 'packages/ui-runtime', 'examples/bot-collaboration']) assert.ok(impact.dirs.includes(dir), dir);
  assert.ok(impact.families.includes('dataplane'));
  assert.ok(!impact.dirs.includes('packages/keys'));
});

test('isolated example changes do not select unrelated native families', () => {
  assert.deepEqual(selectImpact(['examples/live-activity-host/src/index.ts']).dirs, ['examples/live-activity-host']);
  assert.deepEqual(selectImpact(['examples/live-activity-host/src/index.ts']).families, []);
});

test('schema, native memory and SEA changes retain relevant qualification', () => {
  const schema = selectImpact(['packages/cloud-dataplane/migrations/0010.sql']);
  assert.ok(schema.families.includes('dataplane'));
  assert.ok(schema.families.includes('release-pack-migrate'));
  for (const path of ['packages/client/native/agent-memory-fs/main.go', 'templates/packaging/sea/build.sh', 'examples/packaging/src/index.ts']) {
    const impact = selectImpact([path]);
    assert.ok(impact.families.includes('packageability-smoke'));
    assert.ok(impact.families.includes('npm-release-pack'));
  }
});

test('unknown, broad policy/dependency inputs and malformed paths fail closed', () => {
  for (const path of ['bun.lock', 'package.json', 'packages/client/package.json', 'api-surface/entries.json', '.github/workflows/unreviewed.yml', 'packages/new/src/index.ts', 'packages/client/vendor/new.js', 'scripts/release/publish.mjs', 'other/a.md', '../README.md', './README.md', '/README.md', 'docs//a.md', 'docs/../README.md', 'docs/a\nb.md', 'docs\\a.md', '', null]) {
    assert.throws(() => selectImpact([path]), /release validation required/i, String(path));
  }
  for (const paths of [[], null, {}, 'README.md']) assert.throws(() => selectImpact(paths), /release validation required/i);
  assert.throws(() => selectImpact(['README.md', 'unknown']), /release validation required/i);
});

test('selection is deterministic, deduplicated, and uses only known family IDs', () => {
  const paths = ['packages/client/src/a.ts', 'packages/core/src/b.ts', 'README.md'];
  const selection = selectImpact(paths);
  assert.deepEqual(selection, selectImpact([...paths].reverse().concat(paths)));
  assert.ok(selection.families.every(id => knownFamilies.includes(id)));
  assert.equal(knownFamilies.length, 13);
});

test('CLI accepts JSON stdin and fails closed without an output selection on bad JSON', () => {
  const script = fileURLToPath(new URL('./select-impact.mjs', import.meta.url));
  const good = spawnSync(process.execPath, [script], { input: '["README.md"]', encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).reason, 'docs-only');
  for (const input of ['{', '[]', '["unknown"]']) {
    const bad = spawnSync(process.execPath, [script], { input, encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.equal(bad.stdout, '');
  }
});
