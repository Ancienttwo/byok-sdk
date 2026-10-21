import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { selectImpact, knownFamilies } from './select-impact.mjs';
import { planCi } from './plan-ci.mjs';
import { requireCiPlan } from './require-ci-plan.mjs';
const id = 'agent-memory-export-linux';
const sha = 'a'.repeat(40);
for (const name of ['memory.ts', 'memory-restore.ts', 'memory-restore.test.ts', 'memory-linux.test.ts']) {
  const file = `examples/host-execution-core/src/${name}`;
  test(`${name} requires native restore qualification and aggregate success`, () => {
    assert.deepEqual(selectImpact([file]).families, ['adapter-lifecycle-smoke', id]);
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
  for (const name of ['index.ts', 'memory-other.ts', 'memory-restore.test-support.ts']) {
    assert.deepEqual(selectImpact([`examples/host-execution-core/src/${name}`]).families, ['adapter-lifecycle-smoke']);
  }
});
test('selected Linux family forces restore qualification', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const block = workflow.split('  agent-memory-export-linux:\n')[1].split('\n  agent-memory-helper-linux:')[0];
  assert.match(block, /BYOK_REQUIRE_MEMORY_RESTORE_LINUX: '1'/);
  assert.match(block, /run: bun run --filter @byok-sdk\/example-host-execution-core test -- src\/memory-restore.test.ts src\/memory-linux.test.ts/);
});
