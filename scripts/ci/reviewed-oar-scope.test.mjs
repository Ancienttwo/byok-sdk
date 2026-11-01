import assert from 'node:assert/strict';
import test from 'node:test';
import { selectImpact } from './select-impact.mjs';

test('reviewed OAR trim paths retain client and native qualification, unknown vendor scope refuses', () => {
  for (const file of ['runtimes/codex/app-server-client.ts', 'runtimes/codex/rpc-control.ts', 'runtimes/codex/session.ts', 'shared/acp/session.ts', 'shared/session-kernel.ts']) {
    const path = `packages/client/vendor/oar/ddec7e5/${file}`;
    const plan = selectImpact([path]);
    assert.ok(plan.dirs.includes('packages/client'));
    assert.ok(plan.dirs.includes('examples/basic'));
    for (const family of ['adapter-lifecycle-smoke', 'execution-recovery-native', 'credential-isolation-audit']) assert.ok(plan.families.includes(family));
    assert.throws(() => selectImpact([path.replace('ddec7e5', 'aaaaaaa')]));
  }
  assert.throws(() => selectImpact(['packages/client/vendor/oar/ddec7e5/shared/unreviewed.ts']));
});

test('an OAR snapshot path is reviewed only when its source manifest lists it', () => {
  for (const file of ['contracts/login.ts', 'observe/graph.ts', 'LICENSE', 'shared/acp/profile.ts']) {
    assert.ok(selectImpact([`packages/client/vendor/oar/ddec7e5/${file}`]).dirs.includes('packages/client'));
  }
  assert.throws(() => selectImpact(['packages/client/vendor/oar/ddec7e5/contracts/unreviewed.ts']));
  assert.throws(() => selectImpact(['packages/client/vendor/oar/aaaaaaa/contracts/login.ts']));
});

test('an rpiv-todo snapshot path is reviewed only when its source manifest lists it', () => {
  for (const file of ['index.ts', 'tool/normalize-params.ts', 'locales/zh.json', 'LICENSE', 'PROVENANCE.md', 'source-manifest.json']) {
    const plan = selectImpact([`packages/client/vendor/rpiv-todo/2.15.0/${file}`]);
    assert.ok(plan.dirs.includes('packages/client'), file);
    assert.ok(plan.families.includes('npm-release-pack'), file);
  }
  assert.throws(() => selectImpact(['packages/client/vendor/rpiv-todo/2.15.0/unreviewed.ts']));
  assert.throws(() => selectImpact(['packages/client/vendor/rpiv-todo/9.9.9/index.ts']));
  assert.throws(() => selectImpact(['packages/client/vendor/rpiv-todo/latest/index.ts']));
});
