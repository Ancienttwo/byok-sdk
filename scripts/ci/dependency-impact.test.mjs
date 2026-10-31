import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { selectImpact, knownFamilies } from './select-impact.mjs';
import { planCi, needsBuild, assertTargetedScope } from './plan-ci.mjs';
import { LOCKFILE_VERSION_REASON } from './dependency-impact.mjs';
import { requireCiPlan } from './require-ci-plan.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'dependency-impact-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const write = (p, value) => { mkdirSync(dirname(join(cwd, p)), { recursive: true }); writeFileSync(join(cwd, p), JSON.stringify(value)); };
  const root = { name: 'root', scripts: { 'test:scripts': 'node --test --test-concurrency=1 scripts/old.test.mjs' }, devDependencies: { compiler: '1.0.0' } };
  const client = { name: '@byok-sdk/client', version: '0.31.0', dependencies: { 'new-library': '1.0.0' } };
  const ui = { name: '@byok-sdk/ui-runtime', version: '0.31.0', dependencies: { unrelated: '1.0.0' } };
  const lock = { lockfileVersion: 1, workspaces: {
    '': { name: root.name, devDependencies: root.devDependencies },
    'packages/client': client, 'packages/ui-runtime': ui,
  }, packages: {
    compiler: ['compiler@1.0.0', '', {}],
    'new-library': ['new-library@1.0.0', '', { dependencies: { nested: '^1.0.0' } }],
    nested: ['nested@1.0.0', '', {}], unrelated: ['unrelated@1.0.0', '', {}],
  } };
  write('package.json', root); write('packages/client/package.json', client); write('packages/ui-runtime/package.json', ui); write('bun.lock', lock);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init'); git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'base');
  return { cwd, base: git('rev-parse', 'HEAD'), root, client, ui, lock, write };
}

function commit(cwd, message) {
  execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', message], { cwd, stdio: 'pipe' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
}

test('never-listed dependency upgrade creates a build/typecheck/test and platform plan', t => {
  const f = fixture(t);
  f.client.dependencies['new-library'] = '2.0.0';
  f.lock.packages['new-library'][0] = 'new-library@2.0.0';
  f.write('packages/client/package.json', f.client); f.write('bun.lock', f.lock);
  const plan = planCi({ ...f, event: 'pull_request', sha: 'a'.repeat(40), paths: ['packages/client/package.json', 'bun.lock'] });
  assert.equal(needsBuild(plan), true);
  assert.ok(plan.dirs.includes('packages/client'));
  assert.ok(plan.dirs.includes('examples/basic'), 'reverse workspace consumer');
  for (const id of ['npm-release-pack', 'windows-client', 'adapter-lifecycle-smoke']) assert.ok(plan.families.includes(id));
  assert.ok(!plan.families.includes('build-test') && !plan.families.includes('macos-client'));
});

test('transitive lock-only security upgrade selects its consumers', t => {
  const f = fixture(t);
  f.lock.packages.nested[0] = 'nested@1.0.1'; f.write('bun.lock', f.lock);
  const plan = selectImpact(['bun.lock'], f);
  assert.ok(plan.dirs.includes('packages/client'));
  assert.ok(!plan.dirs.includes('packages/ui-runtime'));
  assert.ok(plan.families.includes('npm-release-pack'));
});

test('root tool upgrades qualify every workspace and routine platform family', t => {
  const f = fixture(t);
  f.root.devDependencies.compiler = '2.0.0'; f.lock.packages.compiler[0] = 'compiler@2.0.0';
  f.write('package.json', f.root); f.write('bun.lock', f.lock);
  const plan = selectImpact(['package.json', 'bun.lock'], f);
  assert.ok(plan.dirs.includes('packages/client') && plan.dirs.includes('packages/ui-runtime'));
  assert.deepEqual(plan.families, knownFamilies.filter(id => !['build-test', 'macos-client'].includes(id)).sort());
});

test('unrelated manifest edits and lock mismatches are not hidden by a version upgrade', t => {
  const f = fixture(t);
  f.client.dependencies['new-library'] = '2.0.0';
  f.write('packages/client/package.json', { ...f.client, scripts: { test: 'echo bypass' } });
  assert.throws(() => selectImpact(['packages/client/package.json'], f), /more than/);
  f.write('packages/client/package.json', f.client);
  f.lock.workspaces['packages/client'] = { ...f.client, dependencies: { 'new-library': '1.0.0' } };
  f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /differs from manifest/);
});

test('an orphan lock row is rejected even beside a valid transitive upgrade', t => {
  const f = fixture(t);
  f.lock.packages.nested[0] = 'nested@1.0.1';
  f.lock.packages.orphan = ['orphan@1.0.0', '', {}]; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /no declaring workspace/);
});


test('lockfileVersion transition selects every family but stays targeted and cannot publish release artifacts', t => {
  const f = fixture(t);
  f.lock.lockfileVersion = 2; f.write('bun.lock', f.lock);
  const sha = 'a'.repeat(40);
  const plan = planCi({ ...f, event: 'pull_request', sha, paths: ['bun.lock'] });
  assert.equal(plan.mode, 'targeted');
  assert.equal(plan.reason, LOCKFILE_VERSION_REASON);
  assert.deepEqual(plan.families, [...knownFamilies].sort());
  assert.ok(plan.dirs.includes('packages/client') && plan.dirs.includes('packages/ui-runtime'));
  assert.ok(needsBuild(plan));
  assert.doesNotThrow(() => assertTargetedScope(plan));
  const needs = Object.fromEntries(['select', 'targeted', ...knownFamilies].map(id => [id, { result: 'success' }]));
  assert.doesNotThrow(() => requireCiPlan(needs, plan, 'pull_request', sha, f.base, f.cwd));
  for (const id of knownFamilies) for (const result of ['failure', 'skipped', 'cancelled']) {
    assert.throws(() => requireCiPlan({ ...needs, [id]: { result } }, plan, 'pull_request', sha, f.base, f.cwd));
  }
  execFileSync('git', ['add', 'bun.lock'], { cwd: f.cwd });
  execFileSync('git', ['-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'format transition'], { cwd: f.cwd, stdio: 'pipe' });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.cwd, encoding: 'utf8' }).trim();
  const output = join(f.cwd, 'github-output');
  const cli = execFileSync(process.execPath, [new URL('./plan-ci.mjs', import.meta.url).pathname], {
    cwd: f.cwd, encoding: 'utf8', env: { ...process.env, CI_EVENT: 'push', CI_BASE: f.base,
      GITHUB_SHA: head, GITHUB_OUTPUT: output, CI_RELEASE_SHA: head },
  });
  assert.equal(JSON.parse(cli).mode, 'targeted');
  assert.match(readFileSync(output, 'utf8'), /^release=false$/m);
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const upload = workflow.split('- name: Retain the accepted release tarballs for the publish driver')[1].split('retention-days: 30')[0];
  assert.match(upload, /if: matrix.os == 'ubuntu-latest' && needs.select.outputs.release == 'true'/);
  assert.match(upload, /uses: actions\/upload-artifact@/);
  // The aggregate recomputes from the lockfiles; a forged reason/family list
  // cannot turn an unchanged lock into full-matrix authorization.
  f.lock.lockfileVersion = 1; f.write('bun.lock', f.lock);
  assert.throws(() => requireCiPlan(needs, plan, 'pull_request', sha, f.base, f.cwd), /selection mismatch/);
});

test('other metadata and malformed format versions remain refused, including beside a valid transition', t => {
  const f = fixture(t);
  for (const lockfileVersion of [1, 2]) {
    f.write('bun.lock', { ...f.lock, lockfileVersion, unrelatedMetadata: true });
    assert.throws(() => selectImpact(['bun.lock'], f), /more than dependency fields/);
    f.write('bun.lock', { ...f.lock, lockfileVersion, fullMatrixReason: LOCKFILE_VERSION_REASON });
    assert.throws(() => selectImpact(['bun.lock'], f), /more than dependency fields/);
  }
  for (const lockfileVersion of [undefined, null, '2', 0, -1, 1.5]) {
    f.write('bun.lock', { ...f.lock, lockfileVersion });
    assert.throws(() => selectImpact(['bun.lock'], f), /positive integer/);
  }
});

test('the targeted full-matrix guard admits exactly the verified format reason', () => {
  for (const reason of [undefined, 'impacted', 'nightly', 'release', 'lockfile-version-change-extra']) {
    assert.throws(() => assertTargetedScope({ families: [...knownFamilies], reason }), /Only a verified lockfileVersion/);
  }
  assert.doesNotThrow(() => assertTargetedScope({ families: ['npm-release-pack'], reason: 'impacted' }));
});

test('unchanged format and dependency-only changes retain their existing scope regardless of caller flags', t => {
  const f = fixture(t);
  f.lock.packages.unrelated[0] = 'unrelated@1.0.1'; f.write('bun.lock', f.lock);
  const plan = planCi({ ...f, event: 'push', sha: 'a'.repeat(40), paths: ['bun.lock'],
    reason: LOCKFILE_VERSION_REASON, families: [...knownFamilies], release: true });
  assert.equal(plan.reason, 'impacted');
  assert.equal(plan.mode, 'targeted');
  assert.deepEqual(plan.dirs, ['examples/live-activity-host', 'packages/ui-runtime']);
  assert.deepEqual(plan.families, ['npm-release-pack']);
});

test('a new external root override is reviewed dependency data, not a mapping failure', t => {
  const f = fixture(t);
  f.root.overrides = { compiler: '2.0.0' };
  f.lock.overrides = { compiler: '2.0.0' };
  f.write('package.json', f.root); f.write('bun.lock', f.lock);
  const plan = selectImpact(['package.json', 'bun.lock'], f);
  assert.ok(plan.dirs.includes('packages/client'));
  assert.ok(plan.dirs.includes('packages/ui-runtime'));
  assert.ok(plan.families.includes('npm-release-pack'));
});

test('new root overrides of workspaces, file/link specs or private names still fail closed', t => {
  for (const [name, spec] of [
    ['@byok-sdk/client', '2.0.0'],
    ['compiler', 'workspace:*'],
    ['compiler', 'file:../compiler'],
    ['compiler', 'link:../compiler'],
    ['compiler', { nested: '2.0.0' }],
    ['compiler', 'latest'],
    ['compiler@>=2', '2.0.0'],
  ]) {
    const f = fixture(t);
    f.root.overrides = { [name]: spec };
    f.lock.overrides = { [name]: spec };
    f.write('package.json', f.root); f.write('bun.lock', f.lock);
    assert.throws(() => selectImpact(['package.json'], f), /more than the reviewed fields/, name + '=' + JSON.stringify(spec));
  }
});

test('a changed existing root override remains reviewed dependency data', t => {
  const f = fixture(t);
  f.root.overrides = { compiler: '1.0.0' };
  f.lock.overrides = { compiler: '1.0.0' };
  f.write('package.json', f.root); f.write('bun.lock', f.lock);
  f.base = commit(f.cwd, 'baseline override');
  f.root.overrides.compiler = '2.0.0';
  f.lock.overrides.compiler = '2.0.0';
  f.write('package.json', f.root); f.write('bun.lock', f.lock);
  const plan = selectImpact(['package.json', 'bun.lock'], f);
  assert.ok(plan.dirs.includes('packages/client') && plan.dirs.includes('packages/ui-runtime'));
  assert.ok(plan.families.includes('npm-release-pack'));
});

test('lock overrides still must equal the root manifest', t => {
  const f = fixture(t);
  f.root.overrides = { compiler: '2.0.0' };
  f.lock.overrides = { compiler: '1.0.0' };
  f.write('package.json', f.root); f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /lock overrides differ from root manifest/);
});
