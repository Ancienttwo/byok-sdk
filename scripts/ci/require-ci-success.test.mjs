import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { requireCiSuccess } from './require-ci-success.mjs';

const families = ['build-test', 'agent-memory-export-linux', 'agent-memory-helper-non-darwin', 'agent-memory-helper',
  'execution-recovery-native', 'adapter-lifecycle-smoke', 'dataplane',
  'windows-client', 'packageability-smoke', 'npm-release-pack',
  'release-pack-migrate', 'windows-service-smoke', 'ipc-smoke', 'credential-isolation-audit', 'hermes-real-windows', 'runtime-contract'];
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
test('workflow separates targeted events from explicit complete release validation', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /push:\n    branches: \[main\]/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /workflow_dispatch:[\s\S]*release_sha:/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
  const jobs = workflow.split('\njobs:\n')[1];
  const ids = [...jobs.matchAll(/^  ([a-z][a-z0-9-]+):$/gm)].map(match => match[1]);
  assert.deepEqual(ids, ['select', 'targeted', ...families, 'ci-required']);
  for (const family of families) {
    const block = jobs.slice(jobs.indexOf(`  ${family}:`)).split(/\n  [a-z][a-z0-9-]+:/)[0];
    assert.match(block, /^    needs: select$/m);
    assert.ok(block.includes(`contains(fromJSON(needs.select.outputs.families), '${family}')`));
  }
  const aggregate = jobs.slice(jobs.indexOf('  ci-required:'));
  assert.match(aggregate, /^    name: CI required$/m);
  assert.match(aggregate, /^    if: \$\{\{ always\(\) \}\}$/m);
  assert.deepEqual(JSON.parse(aggregate.match(/^    needs: (.*)$/m)[1]), ['select', 'targeted', ...families]);
  assert.match(aggregate, /^          CI_NEEDS: \$\{\{ toJSON\(needs\) \}\}$/m);
  assert.match(aggregate, /^        run: node scripts\/ci\/require-ci-plan.mjs$/m);
  assert.match(workflow, /if: matrix.os == 'ubuntu-latest' && needs.select.outputs.release == 'true'\n        uses: actions\/upload-artifact/);
  const release = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(release, /--event workflow_dispatch/);
  assert.doesNotMatch(release, /--event push/);
  assert.match(release, /--branch main --commit "\$GITHUB_SHA"/);
});
