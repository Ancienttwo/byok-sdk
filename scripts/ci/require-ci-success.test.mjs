import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { requireCiSuccess } from './require-ci-success.mjs';

const families = ['build-test', 'agent-memory-helper-linux', 'agent-memory-helper',
  'execution-recovery-native', 'adapter-lifecycle-smoke', 'dataplane',
  'windows-git-workspace', 'packageability-smoke', 'npm-release-pack',
  'release-pack-migrate', 'windows-service-smoke', 'ipc-smoke', 'credential-isolation-audit'];
const successful = () => Object.fromEntries(families.map(id => [id, { result: 'success' }]));

test('aggregate accepts exactly the complete successful matrix', () => {
  assert.doesNotThrow(() => requireCiSuccess(successful(), families));
});
for (const result of ['failure', 'cancelled', 'skipped', undefined, 'unknown']) {
  test(`aggregate rejects ${String(result)} in any job family`, () => {
    for (const id of families) {
      const needs = successful(); needs[id] = { result };
      assert.throws(() => requireCiSuccess(needs, families), /did not succeed/);
    }
  });
}
test('aggregate rejects missing, unexpected and malformed inventories', () => {
  const missing = successful(); delete missing['build-test'];
  assert.throws(() => requireCiSuccess(missing, families), /inventory mismatch/);
  assert.throws(() => requireCiSuccess({ ...successful(), surprise: { result: 'success' } }, families), /inventory mismatch/);
  for (const expected of [[], null, ['x', 'x'], [0]]) assert.throws(() => requireCiSuccess({}, expected), /inventory/);
  for (const needs of [null, [], 'success']) assert.throws(() => requireCiSuccess(needs, families), /needs/);
});
test('CLI fails closed when result JSON is absent or malformed', () => {
  const script = fileURLToPath(new URL('./require-ci-success.mjs', import.meta.url));
  for (const value of ['', '{', '{}']) {
    const run = spawnSync(process.execPath, [script], { env: { ...process.env, CI_NEEDS: value, CI_REQUIRED_JOBS: JSON.stringify(families) }, encoding: 'utf8' });
    assert.equal(run.status, 1, run.stdout);
  }
});
test('workflow deduplicates feature pushes without path-selecting any PR or changing release authority', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.equal(workflow.match(/^on:\n([\s\S]*?)\nconcurrency:/m)?.[1].trim(), '  push:\n    branches: [main]\n  pull_request:'.trim());
  const jobs = workflow.split('\njobs:\n')[1];
  const ids = [...jobs.matchAll(/^  ([a-z][a-z0-9-]+):$/gm)].map(match => match[1]);
  assert.deepEqual(ids, [...families, 'ci-required']);
  const aggregate = jobs.slice(jobs.indexOf('  ci-required:'));
  assert.match(aggregate, /^    name: CI required$/m);
  assert.match(aggregate, /^    if: \$\{\{ always\(\) \}\}$/m);
  assert.deepEqual(JSON.parse(aggregate.match(/^    needs: (.*)$/m)[1]), families);
  assert.deepEqual(JSON.parse(aggregate.match(/^          CI_REQUIRED_JOBS: '(.*)'$/m)[1]), families);
  assert.match(aggregate, /^          CI_NEEDS: \$\{\{ toJSON\(needs\) \}\}$/m);
  assert.match(aggregate, /^        run: node scripts\/ci\/require-ci-success.mjs$/m);
  // Job-level conditions could silently introduce path selection. Step-level
  // platform conditions are intentional and remain in the unchanged matrix.
  assert.doesNotMatch(jobs.slice(0, jobs.indexOf('  ci-required:')), /^    if:/m);
  const release = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(release, /--event push/);
  assert.match(release, /--branch main/);
});
