import assert from 'node:assert/strict';
import test from 'node:test';
import { selectImpact } from './select-impact.mjs';

test('reviewed OAR trim paths retain client and native qualification, unknown vendor scope refuses', () => {
  for (const file of ['runtimes/codex/app-server-client.ts', 'runtimes/codex/rpc-control.ts', 'runtimes/codex/session.ts', 'shared/acp/session.ts', 'shared/session-kernel.ts']) {
    const path = `packages/client/vendor/oar/51b83c9/${file}`;
    const plan = selectImpact([path]);
    assert.ok(plan.dirs.includes('packages/client'));
    assert.ok(plan.dirs.includes('examples/basic'));
    for (const family of ['adapter-lifecycle-smoke', 'execution-recovery-native', 'credential-isolation-audit']) assert.ok(plan.families.includes(family));
    assert.throws(() => selectImpact([path.replace('51b83c9', 'aaaaaaa')]));
  }
  assert.throws(() => selectImpact(['packages/client/vendor/oar/51b83c9/shared/unreviewed.ts']));
});

test('an OAR snapshot path is reviewed only when its source manifest lists it', () => {
  for (const file of ['contracts/login.ts', 'observe/graph.ts', 'LICENSE', 'shared/acp/profile.ts']) {
    assert.ok(selectImpact([`packages/client/vendor/oar/51b83c9/${file}`]).dirs.includes('packages/client'));
  }
  assert.throws(() => selectImpact(['packages/client/vendor/oar/51b83c9/contracts/unreviewed.ts']));
  assert.throws(() => selectImpact(['packages/client/vendor/oar/aaaaaaa/contracts/login.ts']));
});
