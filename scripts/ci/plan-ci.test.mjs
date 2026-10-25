import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planCi, changedPaths, isReleaseRef, needsBuild } from './plan-ci.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requireCiPlan } from './require-ci-plan.mjs';
import { knownFamilies, reviewedScripts } from './select-impact.mjs';
const sha = 'a'.repeat(40);
const ref = 'refs/heads/main';
const results = plan => Object.fromEntries(['select', 'targeted', ...knownFamilies].map(id => [id, {
  result: id === 'select' || (id === 'targeted' && plan.mode === 'targeted') || plan.families.includes(id) ? 'success' : 'skipped',
}]));
test('only exact approved dispatch selects the complete release matrix', () => {
  const plan = planCi({ event: 'workflow_dispatch', sha, approvedSha: sha, ref });
  assert.deepEqual(plan.families, knownFamilies);
  assert.doesNotThrow(() => requireCiPlan(results(plan), plan, 'workflow_dispatch', sha));
  assert.throws(() => planCi({ event: 'workflow_dispatch', sha, approvedSha: 'b'.repeat(40), ref }));
  assert.throws(() => planCi({ event: 'workflow_dispatch', sha, ref }));
});
test('routine docs select no matrix, but mandatory scope checks must succeed', () => {
  for (const event of ['push', 'pull_request']) {
    const plan = planCi({ event, sha, paths: ['README.md'] });
    assert.deepEqual(plan.families, []);
    assert.doesNotThrow(() => requireCiPlan(results(plan), plan, event, sha));
    for (const id of ['select', 'targeted']) for (const result of ['skipped', 'cancelled', 'failure']) {
      assert.throws(() => requireCiPlan({ ...results(plan), [id]: { result } }, plan, event, sha));
    }
    assert.throws(() => requireCiPlan(results(plan), { ...plan, families: ['build-test'] }, event, sha));
    assert.throws(() => requireCiPlan({ ...results(plan), 'build-test': { result: 'success' } }, plan, event, sha));
  }
});
test('release gate rejects every incomplete family and never accepts routine evidence', () => {
  const plan = planCi({ event: 'workflow_dispatch', sha, approvedSha: sha, ref });
  for (const id of knownFamilies) for (const result of ['failure', 'skipped', 'cancelled', undefined]) {
    assert.throws(() => requireCiPlan({ ...results(plan), [id]: { result } }, plan, 'workflow_dispatch', sha));
  }
  assert.throws(() => requireCiPlan(results(plan), plan, 'push', sha));
  assert.throws(() => requireCiPlan(results(plan), plan, 'workflow_dispatch', 'b'.repeat(40)));
  const missing = results(plan); delete missing.targeted;
  assert.throws(() => requireCiPlan(missing, plan, 'workflow_dispatch', sha));
});

test('renames include both deleted source and destination workspace paths', () => {
  for (const target of ['docs/moved.md', 'packages/server/src/moved.ts']) {
    const cwd = mkdtempSync(path.join(tmpdir(), 'ci-impact-rename-'));
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      git('init');
      mkdirSync(path.join(cwd, 'packages/client/src'), { recursive: true });
      writeFileSync(path.join(cwd, 'packages/client/src/source.ts'), 'export const value = 1;\n');
      git('add', '.'); git('-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'before');
      const base = git('rev-parse', 'HEAD').trim();
      mkdirSync(path.dirname(path.join(cwd, target)), { recursive: true });
      renameSync(path.join(cwd, 'packages/client/src/source.ts'), path.join(cwd, target));
      git('add', '-A'); git('-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'rename');
      const paths = changedPaths(base, cwd);
      assert.deepEqual([...paths].sort(), ['packages/client/src/source.ts', target].sort());
      assert.ok(planCi({ event: 'pull_request', sha, paths }).dirs.includes('packages/client'));
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }
});
test('CI policy and runbook changes take the contract-only lane', () => {
  const plan = planCi({ event: 'pull_request', sha, paths: ['.github/workflows/release.yml', 'deploy/runbooks/release-responsibility.md', 'scripts/ci/plan-ci.mjs'] });
  assert.deepEqual(plan.dirs, []); assert.deepEqual(plan.families, []);
  assert.equal(plan.reason, 'root-ci-scripts');
});
test('a migration PR plans the targeted cloud-dataplane suite, the dataplane job and the packed migrate job (#654)', () => {
  const plan = planCi({ event: 'pull_request', sha, paths: ['deploy/sql/0027_e2ee_member.sql', 'tests/sql/control_plane_invariants.sql'] });
  assert.equal(plan.mode, 'targeted');
  // The hosted example (#793 D2b-1) and its Worker composition (#794 D3) depend on cloud-dataplane, so the graph also selects them.
  assert.deepEqual(plan.dirs, ['examples/hosted-bot-collaboration', 'examples/hosted-bot-collaboration-worker', 'packages/cloud-dataplane']);
  assert.deepEqual(plan.families, ['dataplane', 'release-pack-migrate']);
  assert.ok(needsBuild(plan));
  assert.ok(!plan.families.includes('build-test'));
});
test('a ci.yml change runs every routine family and the client suite, never the complete suite (W7)', () => {
  const plan = planCi({ event: 'pull_request', sha, paths: ['.github/workflows/ci.yml'] });
  assert.ok(plan.dirs.includes('packages/client'));
  assert.deepEqual(plan.families, knownFamilies.filter(id => id !== 'build-test').sort());
  assert.equal(plan.reason, 'impacted');
});


test('native memory export is required for its owned paths and skipped for other routine changes', () => {
  const id = 'agent-memory-export-linux';
  for (const event of ['pull_request', 'push']) {
    for (const file of ['packages/protocol/src/constants.ts', 'packages/client/src/daemon/task-runner.ts']) {
      assert.ok(!planCi({ event, sha, paths: [file] }).families.includes(id), file);
    }
    for (const file of ['packages/client/src/daemon/agent-memory-export.ts', 'packages/client/src/__tests__/agent-memory-export.test.ts']) {
      const plan = planCi({ event, sha, paths: [file] });
      assert.ok(plan.families.includes(id));
      assert.doesNotThrow(() => requireCiPlan(results(plan), plan, event, sha));
      for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
        assert.throws(() => requireCiPlan({ ...results(plan), [id]: { result } }, plan, event, sha), /did not succeed/);
      }
      const missing = results(plan); delete missing[id];
      assert.throws(() => requireCiPlan(missing, plan, event, sha), /inventory mismatch/);
    }
    const docs = planCi({ event, sha, paths: ['README.md'] });
    assert.equal(results(docs)[id].result, 'skipped');
    assert.throws(() => requireCiPlan({ ...results(docs), [id]: { result: 'success' } }, docs, event, sha), /Unselected CI job/);
  }
  assert.ok(planCi({ event: 'workflow_dispatch', sha, approvedSha: sha, ref }).families.includes(id));
});

test('PR CLI pairs the tested merge with its actual main parent and rejects inconsistent evidence', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ci-merge-base-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = message => { git('add', '.'); git('-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid', 'commit', '-m', message); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-b', 'main');
    writeFileSync(path.join(cwd, 'README.md'), 'base\n');
    const eventBase = commit('event base');
    git('checkout', '-b', 'topic');
    writeFileSync(path.join(cwd, 'README.md'), 'PR documentation\n');
    mkdirSync(path.join(cwd, 'docs'), { recursive: true });
    writeFileSync(path.join(cwd, 'docs/notes.md'), 'PR notes\n');
    const prHead = commit('PR');
    git('checkout', 'main');
    mkdirSync(path.join(cwd, 'packages/client/src'), { recursive: true });
    writeFileSync(path.join(cwd, 'packages/client/src/intervening.ts'), 'export const unrelated = 1;\n');
    const actualBase = commit('intervening main production change');
    git('-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid', 'merge', '--no-ff', 'topic', '-m', 'tested merge');
    const merge = git('rev-parse', 'HEAD');
    const invoke = (script, overrides = {}) => execFileSync(process.execPath, [new URL(script, import.meta.url).pathname], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI_EVENT: 'pull_request', CI_BASE: eventBase, CI_PR_HEAD: prHead, GITHUB_SHA: merge, GITHUB_OUTPUT: path.join(cwd, 'output'), ...overrides },
    });
    const plan = JSON.parse(invoke('./plan-ci.mjs'));
    assert.deepEqual(plan.files, ['README.md', 'docs/notes.md']);
    assert.equal(plan.base, actualBase);
    assert.deepEqual(plan.families, []);
    const evidence = { CI_PLAN: JSON.stringify(plan), CI_NEEDS: JSON.stringify(results(plan)) };
    assert.doesNotThrow(() => invoke('./run-targeted.mjs', evidence));
    assert.doesNotThrow(() => invoke('./require-ci-plan.mjs', evidence));
    for (const script of ['./plan-ci.mjs', './run-targeted.mjs', './require-ci-plan.mjs']) {
      assert.throws(() => invoke(script, { ...evidence, GITHUB_SHA: prHead }));
      assert.throws(() => invoke(script, { ...evidence, CI_PR_HEAD: eventBase }));
      assert.throws(() => invoke(script, { ...evidence, CI_BASE: prHead }));
    }
    const omitted = { ...plan, files: [] };
    for (const script of ['./run-targeted.mjs', './require-ci-plan.mjs']) assert.throws(() => invoke(script, { ...evidence, CI_PLAN: JSON.stringify(omitted) }));
    git('checkout', 'topic');
    assert.throws(() => invoke('./plan-ci.mjs', { GITHUB_SHA: prHead }));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('the complete matrix runs only from an exact dispatch on main or release/*', () => {
  for (const good of ['refs/heads/main', 'refs/heads/release/0.28.2', 'refs/heads/release/0.28.2-rc.1']) {
    assert.ok(isReleaseRef(good), good);
    assert.deepEqual(planCi({ event: 'workflow_dispatch', sha, approvedSha: sha, ref: good }).families, knownFamilies);
  }
  for (const bad of ['refs/heads/fix/612-unknown-wake-audit', 'refs/heads/diagnose/640-writer-handoff', 'refs/heads/codex/release-0.28.1-frozen',
    'refs/heads/integration/byok-batch-20261021', 'refs/heads/release/', 'refs/heads/release/a/b', 'refs/tags/v0.28.1', 'refs/heads/mainline', '', undefined]) {
    assert.ok(!isReleaseRef(bad), String(bad));
    assert.throws(() => planCi({ event: 'workflow_dispatch', sha, approvedSha: sha, ref: bad }), /only on main or release/, String(bad));
  }
});

test('a routine plan never contains the complete test suite', () => {
  for (const event of ['pull_request', 'push']) {
    const plan = planCi({ event, sha, paths: ['packages/protocol/src/task.ts', 'packages/client/src/daemon/task-runner.ts', 'packages/client/src/adapters/codex/codex-adapter.ts'] });
    assert.equal(plan.mode, 'targeted');
    assert.ok(!plan.families.includes('build-test'));
    assert.throws(() => requireCiPlan(results(plan), { ...plan, families: [...knownFamilies] }, event, sha));
  }
});

// #649: the targeted job installs for a reviewed script whose tests need
// installed packages; the other reviewed scripts run their tests without one.
test('reviewed release scripts install only when their tests need packages', () => {
  const install = ['scripts/release/check-package-graph.mjs', 'scripts/release/pack-and-smoke.mjs', 'scripts/release/pack-and-smoke.test.mjs',
    'scripts/release/publish.mjs'];
  for (const path of Object.keys(reviewedScripts)) {
    assert.equal(needsBuild(planCi({ event: 'push', sha, paths: [path] })), install.includes(path), path);
  }
  assert.equal(needsBuild(planCi({ event: 'push', sha, paths: ['README.md'] })), false);
  assert.equal(needsBuild(planCi({ event: 'push', sha, paths: ['packages/core/src/index.ts'] })), true);
});
