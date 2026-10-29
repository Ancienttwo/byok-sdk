import assert from 'node:assert/strict';
import test from 'node:test';
import { selectImpact } from './select-impact.mjs';

test('reviewed K4 plan is documentation while implementation retains its qualification', () => {
  const path = 'examples/host-execution-core/PLAN-612.md';
  const docs = selectImpact([path]);
  assert.equal(docs.reason, 'docs-only');
  assert.deepEqual(docs.dirs, []);
  assert.deepEqual(docs.families, []);
  const code = selectImpact([path, 'packages/server/src/execution-core/core.ts']);
  assert.ok(code.dirs.includes('examples/host-execution-core'));
  assert.ok(code.dirs.includes('examples/byok-mcp-server'));
  assert.ok(code.families.includes('adapter-lifecycle-smoke'));
  assert.throws(() => selectImpact(['examples/host-execution-core/PLAN-unknown.md']));
});
