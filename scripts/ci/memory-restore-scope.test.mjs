import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { selectImpact, knownFamilies } from './select-impact.mjs';
import { planCi } from './plan-ci.mjs';
import { requireCiPlan } from './require-ci-plan.mjs';
const id = 'agent-memory-export-linux';
const sha = 'a'.repeat(40);
// #1106: the K4 memory source moved into the server execution core; its Linux tests stay in the K4 demo.
for (const file of [
  'packages/server/src/execution-core/memory.ts', 'packages/server/src/execution-core/memory-restore.ts',
  'examples/host-execution-core/src/memory-restore.test.ts', 'examples/host-execution-core/src/memory-linux.test.ts',
  'examples/host-execution-core/src/fixtures/memory-restore-crash.ts',
]) {
  test(`${file} requires native restore qualification and aggregate success`, () => {
    assert.deepEqual(selectImpact([file]).families, ['adapter-lifecycle-smoke', id, 'dataplane']);
    for (const event of ['push', 'pull_request']) {
      const plan = planCi({ event, sha, paths: [file] });
      const needs = Object.fromEntries(['select', 'targeted', ...knownFamilies].map(key => [key, {
        result: ['select', 'targeted', ...plan.families].includes(key) ? 'success' : 'skipped',
      }]));
      assert.doesNotThrow(() => requireCiPlan(needs, plan, event, sha));
      for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
        assert.throws(() => requireCiPlan({ ...needs, [id]: { result } }, plan, event, sha));
      }
      delete needs[id];
      assert.throws(() => requireCiPlan(needs, plan, event, sha));
    }
  });
}
test('unrelated K4 sources do not fan out to Linux memory qualification', () => {
  for (const name of ['index.ts', 'memory-other.ts', 'memory-restore.test-support.ts', 'fixtures/memory-restore-other.ts', 'fixtures/memory-restore-crash-extra.ts', 'fixtures/nested/memory-restore-crash.ts']) {
    assert.deepEqual(selectImpact([`examples/host-execution-core/src/${name}`]).families, ['adapter-lifecycle-smoke', 'dataplane']);
  }
  for (const name of ['index.ts', 'ledger.ts', 'memory-other.ts', 'memory.test.ts']) {
    assert.deepEqual(selectImpact([`packages/server/src/execution-core/${name}`]).families, ['adapter-lifecycle-smoke', 'dataplane']);
  }
});
test('selected Linux family forces restore qualification', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const block = workflow.split('  agent-memory-export-linux:\n')[1].split('\n  agent-memory-helper-non-darwin:')[0];
  assert.match(block, /BYOK_REQUIRE_MEMORY_RESTORE_LINUX: '1'/);
  assert.match(block, /run: bun run --filter @byok-sdk\/example-host-execution-core test -- src\/memory-restore.test.ts src\/memory-linux.test.ts/);
});
