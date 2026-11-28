import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { documentationTestsForPaths } from './documentation-checks.mjs';
import { selectImpact, knownFamilies, reviewedScripts } from './select-impact.mjs';
import { planCi } from './plan-ci.mjs';
import { requireCiPlan } from './require-ci-plan.mjs';
import { publicManifests } from './reviewed-content.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-reviewed-content-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const write = (path, value) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), typeof value === 'string' ? value : JSON.stringify(value)); };
  const manifest = { name: '@byok-sdk/client', version: '0.28.0', dependencies: { x: '1.0.0' } };
  const rootManifest = { scripts: { 'test:scripts': 'node --test --test-concurrency=1 scripts/old.test.mjs' } };
  const lock = { lockfileVersion: 1, workspaces: { '': { name: 'workspace' }, 'packages/client': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies } }, packages: { x: ['x@1.0.0'] } };
  write('packages/client/package.json', manifest); write('package.json', rootManifest); write('bun.lock', lock);
  write('api-surface/entries.json', { '@byok-sdk/client': { policy: { budgetBytes: 1 } }, '@byok-sdk/core': { policy: { budgetBytes: 1 } } });
  write('scripts/ci/new.test.mjs', '');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'baseline');
  return { cwd, base: git('rev-parse', 'HEAD').trim(), write, manifest, rootManifest, lock };
}
test('version-only changes select packaging; ordinary dependency upgrades qualify consumers', t => {
  const f = fixture(t);
  f.write('packages/client/package.json', { ...f.manifest, version: '0.28.1' });
  f.lock.workspaces['packages/client'].version = '0.28.1'; f.write('bun.lock', f.lock);
  const plan = selectImpact(['packages/client/package.json', 'bun.lock'], f);
  assert.deepEqual(plan.dirs, []); assert.deepEqual(plan.families, ['npm-release-pack']);
  f.write('packages/client/package.json', { ...f.manifest, version: '0.28.1', dependencies: { x: '2.0.0' } });
  assert.ok(selectImpact(['packages/client/package.json'], f).dirs.includes('packages/client'));
  f.lock.workspaces['packages/client'].dependencies = { x: '2.0.0' };
  f.lock.packages.x = ['x@2.0.0']; f.write('bun.lock', f.lock);
  assert.ok(selectImpact(['bun.lock'], f).dirs.includes('packages/client'));
});
test('#2347: the Bun pin admits one exact bun@X.Y.Z alone and selects every routine family', t => {
  const f = fixture(t), routine = knownFamilies.filter(id => id !== 'build-test' && id !== 'macos-client').sort();
  const manifest = { ...f.rootManifest, packageManager: 'bun@1.4.2' };
  f.write('package.json', manifest); commit(f, 'bun pin');
  f.write('package.json', { ...manifest, packageManager: 'bun@1.4.4' });
  assert.deepEqual(selectImpact(['package.json'], f), { dirs: [], files: ['package.json'], families: routine, reason: 'impacted' });
  const scripts = { 'test:scripts': manifest.scripts['test:scripts'] + ' scripts/ci/new.test.mjs' };
  for (const changed of [
    { ...manifest, packageManager: 'bun@1.4.4', scripts },
    { ...manifest, packageManager: 'bun@^1.4.4' },
    { ...manifest, packageManager: 'bun@1.4.4+sha512.abc' },
    { ...manifest, packageManager: 'npm@11.0.0' },
    { ...manifest, packageManager: ['bun@1.4.4'] },
    { ...manifest, packageManager: [['bun@1.4.4']] },
    { scripts: manifest.scripts },
  ]) {
    f.write('package.json', changed);
    assert.throws(() => selectImpact(['package.json'], f), /changes? (?:only packageManager|more than the reviewed fields)/, JSON.stringify(changed));
  }
});
test('root test command permits only existing additive CI tests, retaining command and old tests', t => {
  const f = fixture(t), old = f.rootManifest.scripts['test:scripts'];
  f.write('package.json', { scripts: { 'test:scripts': old + ' scripts/ci/new.test.mjs' } });
  assert.equal(selectImpact(['package.json'], f).reason, 'root-ci-scripts');
  for (const command of ['echo pass', 'node --test --test-concurrency=1 scripts/ci/new.test.mjs', old + ' scripts/ci/missing.test.mjs', old + ' ; echo pass']) {
    f.write('package.json', { scripts: { 'test:scripts': command } });
    assert.throws(() => selectImpact(['package.json'], f));
  }
});
test('root admits only rh script changes', t => {
  const f = fixture(t), old = f.rootManifest.scripts['test:scripts'];
  const scripts = extra => ({ ...f.rootManifest, scripts: { ...f.rootManifest.scripts, ...extra } });
  const base = scripts({ 'check:old': 'rh run old', 'build:x': 'tsc' });
  f.write('package.json', base);
  execFileSync('git', ['-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-qam', 'harness scripts'], { cwd: f.cwd });
  f.base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.cwd, encoding: 'utf8' }).trim();
  const admitted = { 'build:x': 'tsc', 'check:new': 'rh brain check', 'check:old': 'rh run changed' };
  f.write('package.json', { ...f.rootManifest, scripts: { 'test:scripts': old, ...admitted } });
  assert.deepEqual(selectImpact(['package.json'], f), { dirs: [], files: ['package.json'], families: [], reason: 'root-ci-scripts' });
  f.write('package.json', { ...f.rootManifest, scripts: { 'test:scripts': old + ' scripts/ci/new.test.mjs', 'build:x': 'tsc' } });
  assert.equal(selectImpact(['package.json'], f).reason, 'root-ci-scripts');
  for (const changed of [
    { ...base, scripts: { ...base.scripts, 'build:x': 'tsc -b' } },
    { ...base, scripts: { ...base.scripts, 'check:old': 'echo pass' } },
    { ...base, scripts: { ...base.scripts, 'build:x': 'rh run x' } },
    { ...base, scripts: { ...base.scripts, 'check:add': 'echo pass' } },
    { ...base, scripts: { ...base.scripts, 'check:old': 'xrh run old' } },
    { ...base, scripts: { ...base.scripts, 'check:old': 'repo-harness run old' } },
    { ...base, name: 'renamed' },
  ]) {
    f.write('package.json', changed);
    assert.throws(() => selectImpact(['package.json'], f), /more than the reviewed fields|Unreviewed|Only existing/);
  }
});
test('API entry changes select only owner and dependents; unmapped entry is refused', t => {
  const f = fixture(t);
  f.write('api-surface/entries.json', { '@byok-sdk/client': { policy: { budgetBytes: 2 } }, '@byok-sdk/core': { policy: { budgetBytes: 1 } } });
  const plan = selectImpact(['api-surface/entries.json'], f);
  assert.ok(plan.dirs.includes('packages/client')); assert.ok(!plan.dirs.includes('packages/core'));
  f.write('api-surface/entries.json', { unknown: {} });
  assert.throws(() => selectImpact(['api-surface/entries.json'], f), /unmapped API/);
});
test('a bin API entry selects the package that declares the bin; an undeclared bin is refused', t => {
  const f = fixture(t);
  f.write('packages/client/package.json', { ...f.manifest, bin: { 'byok-agent-memory-mcp': './dist/bin/byok-agent-memory-mcp.js' } });
  f.write('api-surface/entries.json', { '@byok-sdk/client': { policy: { budgetBytes: 1 } }, '@byok-sdk/core': { policy: { budgetBytes: 1 } }, 'bin:byok-agent-memory-mcp': { policy: { budgetBytes: 2 } } });
  // The owner and its package dependent K8 (#1845).
  assert.deepEqual(selectImpact(['api-surface/entries.json'], f).dirs.filter(dir => dir.startsWith('packages/')), ['packages/bot-collaboration', 'packages/client']);
  f.write('api-surface/entries.json', { '@byok-sdk/client': { policy: { budgetBytes: 1 } }, '@byok-sdk/core': { policy: { budgetBytes: 1 } }, 'bin:byok-unknown': {} });
  assert.throws(() => selectImpact(['api-surface/entries.json'], f), /unmapped API entry bin:byok-unknown/);
});
test('reviewed vendor and registry paths map explicitly, siblings still refuse', () => {
  assert.ok(selectImpact(['packages/client/vendor/oar/19f1ecc/runtimes/grok/session.ts']).dirs.includes('packages/client'));
  assert.deepEqual(selectImpact(['scripts/release/registry-contract.test.mjs', 'scripts/release/registry-expectations.json']).dirs, []);
  assert.throws(() => selectImpact(['packages/client/vendor/oar/19f1ecc/unreviewed.ts']));
  assert.throws(() => selectImpact(['scripts/release/registry-contract.mjs']));
});
test('CLI and aggregate revalidate content against the same trusted comparison base', t => {
  const f = fixture(t); f.write('packages/client/package.json', { ...f.manifest, version: '0.28.1' });
  const script = fileURLToPath(new URL('./select-impact.mjs', import.meta.url));
  const run = base => spawnSync(process.execPath, [script], { cwd: f.cwd, input: '["packages/client/package.json"]', encoding: 'utf8', env: { ...process.env, CI_BASE: base } });
  assert.equal(run(f.base).status, 0); assert.notEqual(run('').status, 0);
  const plan = planCi({ event: 'push', sha: f.base, paths: ['packages/client/package.json'], ...f });
  const needs = Object.fromEntries(['select', 'release-bookkeeping', 'targeted', ...knownFamilies].map(id => [id, { result: ['select', 'release-bookkeeping', 'targeted', ...plan.families].includes(id) ? 'success' : 'skipped' }]));
  assert.doesNotThrow(() => requireCiPlan(needs, plan, 'push', f.base, f.base, f.cwd));
  assert.throws(() => requireCiPlan(needs, plan, 'push', f.base, 'f'.repeat(40), f.cwd), /base mismatch/);
  f.write('packages/client/package.json', { ...f.manifest, scripts: { evil: 'true' } });
  assert.throws(() => requireCiPlan(needs, plan, 'push', f.base, f.base, f.cwd), /more than/);
});

test('published release registration fixture tests protocol without propagating production dependents', () => {
  const plan = selectImpact(['packages/protocol/src/__tests__/golden/v3.releases.json']);
  assert.deepEqual(plan.dirs, ['packages/protocol']);
  assert.deepEqual(plan.families, []);
  assert.ok(selectImpact(['packages/protocol/src/task.ts']).dirs.includes('packages/client'));
});



test('reviewed root-level basic fixtures select their workspace while unknown root files fail closed', () => {
  for (const path of ['examples/basic/clarification.test.ts', 'examples/basic/goal-btw.test.ts']) {
    assert.ok(selectImpact([path]).dirs.includes('examples/basic'));
  }
  assert.throws(() => selectImpact(['examples/basic/unknown.ts']));
});

test('shared goal fixture selects its consumers without broadening unknown root support files', () => {
  const plan = selectImpact(['examples/basic/goal-btw.test-support.ts']);
  assert.deepEqual(plan.dirs, ['examples/basic', 'examples/byok-mcp-server', 'examples/desktop-bot-app', 'examples/host-execution-core',
    'examples/hosted-bot-collaboration', 'examples/hosted-bot-collaboration-worker', 'packages/bot-collaboration']);
  assert.deepEqual(plan.families, ['adapter-lifecycle-smoke', 'dataplane']);
  assert.throws(() => selectImpact(['examples/basic/other.test-support.ts']));
});

test('result-helper close regression selects only its exact basic workspace path', () => {
  assert.deepEqual(selectImpact(['examples/basic/goal-btw-close.test.ts']).dirs, ['examples/basic']);
  assert.throws(() => selectImpact(['examples/basic/goal-btw-close-other.test.ts']));
});

test('core and keys build entries and catalog generation retain their consumers and packed checks', () => {
  for (const dir of ['core', 'keys']) {
    const entry = selectImpact([`packages/${dir}/tsup.config.ts`]);
    assert.ok(entry.dirs.includes(`packages/${dir}`));
    assert.ok(entry.families.includes('npm-release-pack'));
  }
  const generator = selectImpact(['scripts/keys/generate-pi-model-catalog.ts']);
  assert.ok(generator.dirs.includes('packages/keys') && generator.dirs.includes('packages/client'));
  assert.throws(() => selectImpact(['scripts/keys/other.ts']));
});

function commit(f, message) {
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', message);
  f.base = git('rev-parse', 'HEAD').trim();
}

test('the Node pin admits one exact X.Y.Z and selects every routine family, never the complete suite', t => {
  const f = fixture(t);
  f.write('.node-version', '24.21.0\n'); commit(f, 'node pin');
  const routine = knownFamilies.filter(id => id !== 'build-test' && id !== 'macos-client').sort();
  for (const value of ['24.22.3\n', '24.22.3', '26.0.0\n']) {
    f.write('.node-version', value);
    assert.deepEqual(selectImpact(['.node-version'], f), { dirs: [], files: ['.node-version'], families: routine, reason: 'impacted' });
  }
  f.write('.node-version', '24.22.3\n');
  const plan = planCi({ event: 'push', sha: f.base, paths: ['.node-version'], ...f });
  assert.deepEqual(plan.families, routine);
  const needs = Object.fromEntries(['select', 'release-bookkeeping', 'targeted', ...knownFamilies].map(id => [id, { result: ['build-test', 'macos-client'].includes(id) ? 'skipped' : 'success' }]));
  assert.doesNotThrow(() => requireCiPlan(needs, plan, 'push', f.base, f.base, f.cwd));
  needs['build-test'] = { result: 'success' };
  assert.throws(() => requireCiPlan(needs, plan, 'push', f.base, f.base, f.cwd), /unexpectedly ran: build-test/);
  for (const value of ['', '24.22\n', 'v24.22.3\n', '24.22.3-rc.1\n', '>=24.22.3\n', '24.x\n', 'lts/*\n', '24.022.3\n',
    ' 24.22.3\n', '24.22.3 \n', '24.22.3\r\n', '﻿24.22.3\n', '24.22.3\n\n', '24.22.3\n24.22.0\n']) {
    f.write('.node-version', value);
    assert.throws(() => selectImpact(['.node-version'], f), /one exact X\.Y\.Z/, JSON.stringify(value));
  }
  assert.throws(() => selectImpact(['.node-version']), /requires exact CI_BASE/);
  rmSync(join(f.cwd, '.node-version'));
  assert.throws(() => selectImpact(['.node-version'], f));
});

test('the Node floor raise admits only the exact public engine change', t => {
  const f = fixture(t);
  const publicPath = 'packages/client/package.json';
  const privatePath = 'packages/testkit/package.json';
  const before = { ...f.manifest, engines: { node: '>=24.22.1' } };
  const privateManifest = { ...before, name: '@byok-sdk/testkit', private: true };
  f.write(publicPath, before);
  f.write(privatePath, privateManifest);
  commit(f, 'previous Node floor');
  const engines = { node: '>=24.22.3' };
  f.write(publicPath, { ...before, engines });
  assert.deepEqual(selectImpact([publicPath], f).families, ['npm-release-pack']);
  for (const manifest of [
    { ...before, engines: { node: '>=24.22.4' } },
    { ...before, engines: { ...engines, npm: '>=11.0.0' } },
    { ...before, engines, description: 'unreviewed change' },
  ]) {
    f.write(publicPath, manifest);
    assert.throws(() => selectImpact([publicPath], f), /more than the reviewed fields/);
  }
  f.write(privatePath, { ...privateManifest, engines });
  assert.throws(() => selectImpact([privatePath], f), /more than the reviewed fields/);
});

test('the public manifest list equals the non-private packages in the repository', () => {
  const root = new URL('../../', import.meta.url);
  const actual = [];
  for (const entry of readdirSync(new URL('packages/', root), { withFileTypes: true })) {
    const path = `packages/${entry.name}/package.json`;
    if (!entry.isDirectory() || !existsSync(new URL(path, root))) continue;
    if (JSON.parse(readFileSync(new URL(path, root), 'utf8')).private !== true) actual.push(path);
  }
  assert.deepEqual([...publicManifests].sort(), actual.sort());
});

test('the package graph check maps to the npm release pack job that runs it; siblings still refuse', () => {
  const root = new URL('../../', import.meta.url);
  const path = 'scripts/release/check-package-graph.mjs';
  assert.deepEqual(selectImpact([path]), { dirs: [], files: [path], families: ['npm-release-pack'], reason: 'impacted' });
  const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  const start = workflow.indexOf('\n  npm-release-pack:\n');
  const next = workflow.slice(start + 1).search(/\n  [a-z0-9-]+:\n/);
  assert.ok(start >= 0 && next > 0);
  assert.match(workflow.slice(start, start + 1 + next), /node scripts\/release\/pack-and-smoke\.mjs/);
  assert.match(readFileSync(new URL('scripts/release/pack-and-smoke.mjs', root), 'utf8'), /\['scripts\/release\/check-package-graph\.mjs'\]/);
  for (const [script, { tests, families = [] }] of Object.entries(reviewedScripts)) {
    assert.ok(existsSync(new URL(script, root)), script);
    assert.ok((families.length > 0 || tests.length > 0) && families.every(id => knownFamilies.includes(id) && id !== 'build-test'), script);
  }
  for (const sibling of ['scripts/release/check-package-graph.test.mjs', 'scripts/release/nested/check-package-graph.mjs',
    'scripts/release/check-package-graph.mjs.orig', 'scripts/release/registry-contract.mjs']) {
    assert.throws(() => selectImpact([sibling]), /reviewed CI mapping required/i, sibling);
  }
});

test('the client vendor notice inventory selects the client and the release pack', () => {
  const plan = selectImpact(['packages/client/vendor/third-party-manifest.json']);
  assert.ok(plan.dirs.includes('packages/client') && plan.families.includes('npm-release-pack'));
});

test('#793: the hosted example manifest and lock rows are admitted only with the reviewed shape and reused specs', t => {
  const f = fixture(t);
  const dir = 'examples/hosted-bot-collaboration', path = `${dir}/package.json`;
  const manifest = { name: '@byok-sdk/example-hosted-bot-collaboration', version: '0.0.1', private: true, type: 'module',
    scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' }, dependencies: { '@byok-sdk/client': 'workspace:*', x: '1.0.0' } };
  f.write(path, manifest);
  f.lock.workspaces[dir] = { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies };
  f.lock.packages[manifest.name] = [`${manifest.name}@workspace:${dir}`];
  f.write('bun.lock', f.lock);
  assert.ok(selectImpact([path, 'bun.lock'], f).dirs.includes(dir));
  for (const [candidate, reason] of [
    [{ ...manifest, dependencies: { x: '2.0.0' } }, 'a spec that no other workspace declares'],
    [{ ...manifest, dependencies: { y: '1.0.0' } }, 'a new package'],
    [{ ...manifest, dependencies: { '@byok-sdk/absent': 'workspace:*' } }, 'an unknown workspace'],
    [{ ...manifest, dependencies: { '@byok-sdk/client': '^0.28.0' } }, 'a registry spec for a workspace'],
    [{ ...manifest, private: false }, 'a public manifest'],
    [{ ...manifest, bin: { x: 'x.js' } }, 'an unreviewed field'],
    [{ ...manifest, scripts: { ...manifest.scripts, postinstall: 'x' } }, 'an unreviewed script'],
    [{ ...manifest, description: { text: 'x' } }, 'a description that is not a string'],
  ]) {
    f.write(path, candidate);
    assert.throws(() => selectImpact([path], f), /Reviewed CI mapping required/, reason);
  }
  f.write(path, manifest);
  f.lock.workspaces[dir].dependencies = { x: '1.0.0' }; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /lock rows differ/, 'a lock entry that differs from the manifest');
  f.lock.workspaces[dir].dependencies = manifest.dependencies;
  f.lock.packages[manifest.name] = [`${manifest.name}@workspace:examples/other`]; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /lock rows differ/, 'a package row for another path');
  f.lock.packages[manifest.name] = [`${manifest.name}@workspace:${dir}`];
  f.lock.packages.y = ['y@1.0.0']; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /no declaring workspace/, 'a new resolved package');
});

test('#794 D3: the Worker example manifest and lock rows are admitted by the same reviewed shape, under their own name', t => {
  const f = fixture(t);
  const dir = 'examples/hosted-bot-collaboration-worker', path = `${dir}/package.json`;
  const manifest = { name: '@byok-sdk/example-hosted-bot-collaboration-worker', version: '0.0.1', private: true, type: 'module',
    scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' }, dependencies: { '@byok-sdk/client': 'workspace:*', x: '1.0.0' } };
  f.write(path, manifest);
  f.lock.workspaces[dir] = { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies };
  f.lock.packages[manifest.name] = [`${manifest.name}@workspace:${dir}`];
  f.write('bun.lock', f.lock);
  assert.ok(selectImpact([path, 'bun.lock'], f).dirs.includes(dir));
  for (const [candidate, reason] of [
    [{ ...manifest, name: '@byok-sdk/example-hosted-bot-collaboration' }, 'the H example name'],
    [{ ...manifest, dependencies: { x: '2.0.0' } }, 'a spec that no other workspace declares'],
    [{ ...manifest, private: false }, 'a public manifest'],
  ]) {
    f.write(path, candidate);
    assert.throws(() => selectImpact([path], f), /Reviewed CI mapping required/, reason);
  }
  // The H example cannot vouch for a spec that no other workspace declares, nor the Worker example for H.
  f.write('examples/hosted-bot-collaboration/package.json', { name: '@byok-sdk/example-hosted-bot-collaboration', version: '0.0.1', private: true,
    type: 'module', scripts: manifest.scripts, dependencies: { x: '9.9.9' } });
  f.write(path, { ...manifest, dependencies: { x: '9.9.9' } });
  assert.throws(() => selectImpact([path], f), /may only reuse a declared dependency spec \(x\)/, 'a spec that only the H example declares');
  assert.throws(() => selectImpact(['examples/hosted-bot-collaboration/package.json'], f), /may only reuse a declared dependency spec \(x\)/,
    'a spec that only the Worker example declares');
  f.write(path, manifest);
  f.lock.workspaces[dir].dependencies = { x: '1.0.0' }; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /lock rows differ/, 'a lock entry that differs from the manifest');
});

function k8Fixture(t) {
  const f = fixture(t);
  for (const id of ['protocol', 'server', 'cloud', 'core']) {
    const manifest = { name: `@byok-sdk/${id}`, version: '0.28.0' };
    f.write(`packages/${id}/package.json`, manifest); f.lock.workspaces[`packages/${id}`] = manifest;
  }
  const k4 = { name: '@byok-sdk/example-host-execution-core', version: '0.0.1', private: true, devDependencies: { '@hono/node-server': '^2.1.3', vitest: '^5.1.0' } };
  f.write('examples/host-execution-core/package.json', k4); f.lock.workspaces['examples/host-execution-core'] = k4;
  const dir = 'packages/bot-collaboration', path = `${dir}/package.json`, name = '@byok-sdk/bot-collaboration';
  f.write(path, { name, version: '0.0.0', private: true }); f.write('bun.lock', f.lock); rebase(f, 'private K8');

  const peers = { '@hono/node-server': '^2.1.3' };
  const manifest = { name, version: '0.28.0', type: 'module', description: 'K8', license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/Ancienttwo/byok-sdk.git', directory: dir },
    bugs: { url: 'https://github.com/Ancienttwo/byok-sdk/issues' }, homepage: 'https://github.com/Ancienttwo/byok-sdk#readme',
    engines: { node: '>=24.22.3' }, sideEffects: false, main: './dist/index.js', module: './dist/index.js', types: './dist/index.d.ts',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './host-kit': { types: './dist/host-kit.d.ts', import: './dist/host-kit.js' },
      './rules': { types: './dist/rules/index.d.ts', import: './dist/rules/index.js' },
      './testing': { types: './dist/testing.d.ts', import: './dist/testing.js' }, './package.json': './package.json' },
    files: ['dist', 'README.md', 'LICENSE'], publishConfig: { access: 'public' },
    scripts: { build: 'tsup && tsc -p tsconfig.build.json', typecheck: 'tsc --noEmit', test: 'vitest run', clean: 'rm -rf dist' },
    dependencies: { '@byok-sdk/client': 'workspace:*', '@byok-sdk/core': 'workspace:*', '@byok-sdk/protocol': 'workspace:*', '@byok-sdk/server': 'workspace:*' },
    peerDependencies: peers, peerDependenciesMeta: { '@hono/node-server': { optional: true } },
    devDependencies: { '@byok-sdk/cloud': 'workspace:*', '@byok-sdk/example-host-execution-core': 'workspace:*',
      ...peers, vitest: '^5.1.0' } };
  return { f, dir, path, manifest };
}

test('#1845: the published K8 manifest has one reviewed shape; the K4 example stays a devDependency', t => {
  const { f, dir, path, manifest } = k8Fixture(t);
  f.write(path, manifest);
  assert.ok(selectImpact([path], f).dirs.includes(dir));

  const { '@byok-sdk/example-host-execution-core': k4Edge, ...devDependencies } = manifest.devDependencies;
  for (const [candidate, reason] of [
    [{ ...manifest, dependencies: { ...manifest.dependencies, '@byok-sdk/example-host-execution-core': k4Edge }, devDependencies }, /runtime dependencies/],
    [{ ...manifest, peerDependenciesMeta: { vitest: { optional: true } } }, /optional testing peers/],
    [{ ...manifest, exports: { ...manifest.exports, './internal': './dist/internal.js' } }, /unreviewed shape/],
    [{ ...manifest, files: [...manifest.files, 'src'] }, /unreviewed shape/],
    [{ ...manifest, private: true }, /unreviewed field/],
    [{ ...manifest, devDependencies: { ...manifest.devDependencies, 'left-pad': '1.0.0' } }, /reuse a base dependency spec \(left-pad\)/],
    [{ ...manifest, devDependencies: { ...manifest.devDependencies, '@hono/node-server': '^2.1.6' },
      peerDependencies: { ...manifest.peerDependencies, '@hono/node-server': '^2.1.6' } }, /reuse a base dependency spec \(@hono\/node-server\)/],
    [{ ...manifest, devDependencies: (({ '@byok-sdk/cloud': _cloud, ...rest }) => rest)(manifest.devDependencies) }, /edges differ from the reviewed graph/],
  ]) {
    f.write(path, candidate);
    assert.throws(() => selectImpact([path], f), reason);
  }
});

test('#2420: K8 may move only the existing core workspace dependency to runtime', t => {
  const { f, dir, path, manifest } = k8Fixture(t);
  const { '@byok-sdk/core': core, ...dependencies } = manifest.dependencies;
  const prior = { ...manifest, dependencies, devDependencies: { ...manifest.devDependencies, '@byok-sdk/core': core } };
  f.write(path, prior); rebase(f, 'published K8 with core in devDependencies');
  f.write(path, manifest);
  assert.ok(selectImpact([path], f).dirs.includes(dir));
  f.write(path, { ...manifest, devDependencies: prior.devDependencies });
  assert.throws(() => selectImpact([path], f), /dependency names/);
  f.write(path, { ...manifest, dependencies: { ...manifest.dependencies, '@byok-sdk/core': '^0.28.0' } });
  assert.throws(() => selectImpact([path], f), /runtime dependencies/);
});

test('#2411: the published K8 may remove only its Vitest peer', t => {
  const { f, dir, path, manifest } = k8Fixture(t);
  const legacy = { ...manifest, peerDependencies: { ...manifest.peerDependencies, vitest: '^5.1.0' },
    peerDependenciesMeta: { ...manifest.peerDependenciesMeta, vitest: { optional: true } } };
  f.write(path, legacy); rebase(f, 'published K8 with Vitest peer');
  f.write(path, manifest);
  assert.ok(selectImpact([path], f).dirs.includes(dir));
  for (const candidate of [
    { ...manifest, peerDependencies: {}, peerDependenciesMeta: {} },
    { ...manifest, peerDependencies: { ...manifest.peerDependencies, extra: '^1.0.0' },
      peerDependenciesMeta: { ...manifest.peerDependenciesMeta, extra: { optional: true } } },
  ]) {
    f.write(path, candidate);
    assert.throws(() => selectImpact([path], f), /optional testing peers|dependency names/);
  }
});

test('#2118: published K8 dependency updates keep package identity and a nondecreasing stable registry floor', async t => {
  const { f, dir, path, manifest } = k8Fixture(t);
  manifest.devDependencies['@types/node'] = '^24';
  manifest.devDependencies.typescript = '^7.0.2';
  f.write(path, manifest); rebase(f, 'published K8');
  const candidate = spec => ({ ...manifest,
    devDependencies: { ...manifest.devDependencies, '@hono/node-server': spec },
    peerDependencies: { ...manifest.peerDependencies, '@hono/node-server': spec },
  });
  for (const spec of ['^2.1.3', '~2.1.3', '2.1.3', '^2.1.6', '~2.1.6', '2.1.6', '^2.1.10', '^2.2.0', '^3.0.0']) {
    await t.test(`admits ${spec} from ^2.1.3`, () => {
      f.write(path, candidate(spec));
      const plan = selectImpact([path], f);
      assert.ok(plan.dirs.includes(dir));
      assert.ok(plan.families.includes('npm-release-pack'));
    });
  }
  for (const spec of [
    '^2.1.2', '~2.0.99', '1.99.99', '^2.1.6 || ^1', '>=2.1.6', '<3.0.0', '2.1.3 - 2.1.6',
    '^2.1.6 ', ' ^2.1.6', '^ 2.1.6', '2.1.6\n', '2.1.6\t', '2.1.6-rc.1', '^2.1.6-alpha.1', '~2.1.6-rc.1',
    '2.1.6+build.1', '^2.1', '2.1.x', '*', 'latest', 'v2.1.6', '2.01.6',
    'git+https://github.com/honojs/node-server.git#v2.1.6', 'https://registry.npmjs.org/@hono/node-server/-/node-server-2.1.6.tgz',
    'file:../node-server', 'link:../node-server', 'workspace:*', 'npm:another-package@2.1.6', 'github:honojs/node-server',
    'honojs/node-server', 216, null,
  ]) {
    await t.test(`refuses ${JSON.stringify(spec)}`, () => {
      f.write(path, candidate(spec));
      assert.throws(() => selectImpact([path], f), /stable registry range with a nondecreasing floor/);
    });
  }
  for (const [name, change, reason] of [
    ['new devDependency, even when declared elsewhere in the base', m => { m.devDependencies.x = '1.0.0'; }, /dependency names/],
    ['deleted devDependency', m => { delete m.devDependencies.typescript; }, /dependency names/],
    ['renamed devDependency', m => { delete m.devDependencies.typescript; m.devDependencies.x = '1.0.0'; }, /dependency names/],
    ['changed workspace edge', m => { m.devDependencies['@byok-sdk/cloud'] = '1.0.0'; }, /workspace dependency/],
    ['old abbreviated range', m => { m.devDependencies['@types/node'] = '^24.1.0'; }, /stable registry range/],
    ['unequal optional peer and devDependency', m => { m.peerDependencies['@hono/node-server'] = '^2.1.3'; }, /optional testing peers/],
    ['non-optional peer', m => { m.peerDependenciesMeta = { ...m.peerDependenciesMeta, '@hono/node-server': { optional: false } }; }, /optional testing peers/],
    ['unreviewed manifest shape', m => { m.scripts = { ...m.scripts, test: 'echo pass' }; }, /unreviewed shape/],
  ]) {
    await t.test(`refuses ${name}`, () => {
      const m = candidate('^2.1.6'); change(m); f.write(path, m);
      assert.throws(() => selectImpact([path], f), reason);
    });
  }
  for (const previous of ['~2.1.3', '2.1.3', 'git+https://github.com/honojs/node-server.git#v2.1.3', '^2.1.3 || ^1', '2.1.3-rc.1']) {
    await t.test(`checks the original range ${previous}`, () => {
      f.write(path, candidate(previous)); rebase(f, `base range ${previous}`);
      f.write(path, candidate('^2.1.6'));
      if (previous === '~2.1.3' || previous === '2.1.3') assert.ok(selectImpact([path], f).dirs.includes(dir));
      else assert.throws(() => selectImpact([path], f), /stable registry range with a nondecreasing floor/);
    });
  }
});

test('the MCP server example stays private', t => {
  const f = fixture(t), path = 'examples/byok-mcp-server/package.json';
  const manifest = { name: '@byok-sdk/example-byok-mcp-server', private: true, version: '0.0.1',
    dependencies: { '@byok-sdk/protocol': 'workspace:*' } };
  f.write(path, manifest); rebase(f, 'MCP server without core');
  f.write(path, { ...manifest, dependencies: { ...manifest.dependencies, '@byok-sdk/keys': 'workspace:*' } });
  assert.throws(() => selectImpact([path], f), /more than/, 'another dependency edit');
  f.write(path, { ...manifest, private: false });
  assert.throws(() => selectImpact([path], f), /must stay private/);
});

function rebase(f, message) {
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '.'); git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', message);
  f.base = git('rev-parse', 'HEAD').trim();
}

test('reviewed package manifests admit new #byok- imports into dist', t => {
  const f = fixture(t), path = 'packages/client/package.json';
  const manifest = { ...f.manifest, imports: { '#existing': './dist/existing.js' } };
  f.write(path, manifest); rebase(f, 'client before oar-readers');
  const entry = { types: './dist/runtime/oar-readers.d.ts', default: './dist/runtime/oar-readers.js' };
  const write = (value, extra = {}) => f.write(path, { ...manifest, ...extra, imports: { ...manifest.imports, '#byok-oar-readers': value } });
  write(entry);
  assert.doesNotThrow(() => selectImpact([path], f));
  write({ ...entry, extra: './dist/extra.js' });
  assert.throws(() => selectImpact([path], f), /changes more than the reviewed fields/);
  write(entry, { description: 'unreviewed' });
  assert.throws(() => selectImpact([path], f), /changes more than the reviewed fields/);
  write({ ...entry, default: './dist/old.js' }); rebase(f, 'client with a different oar-readers import');
  write(entry);
  assert.throws(() => selectImpact([path], f), /changes more than the reviewed fields/);
});

test('#2396: client admits its MCP hub bin and private runtime import', t => {
  const f = fixture(t), path = 'packages/client/package.json';
  const manifest = { ...f.manifest, bin: { 'byok-agent-team-mcp': './dist/bin/byok-agent-team-mcp.js' },
    imports: { '#existing': './dist/existing.js' } };
  f.write(path, manifest); rebase(f, 'client before MCP hub');
  const bin = { ...manifest.bin, 'byok-mcp-hub': './dist/bin/byok-mcp-hub.js' };
  const imports = { ...manifest.imports, '#byok-mcp-hub-runtime': {
    types: './dist/bin/mcp-hub-runtime.d.ts', default: './dist/bin/mcp-hub-runtime.js',
  } };
  const write = changes => f.write(path, { ...manifest, bin, imports, ...changes });
  write({});
  assert.ok(selectImpact([path], f).dirs.includes('packages/client'));
  write({ imports: manifest.imports });
  assert.ok(selectImpact([path], f).dirs.includes('packages/client'));
  for (const changes of [
    { bin: { ...bin, 'byok-mcp-hub': './dist/bin/other.js' } },
    { bin: { ...bin, 'byok-other': './dist/bin/other.js' } },
    { imports: { ...imports, '#byok-mcp-hub-runtime': '../other.js' } },
    { description: 'unreviewed' },
  ]) {
    write(changes);
    assert.throws(() => selectImpact([path], f), /changes more than the reviewed fields/);
  }
  write({ bin: { ...bin, 'byok-mcp-hub': './dist/bin/old.js' } });
  rebase(f, 'client with a different MCP hub bin');
  write({});
  assert.throws(() => selectImpact([path], f), /changes more than the reviewed fields/);
});

test('a different package can add its first private import with local dist targets', t => {
  const f = fixture(t), path = 'packages/core/package.json';
  const manifest = { name: '@byok-sdk/core', version: '0.43.0' };
  f.write(path, manifest); rebase(f, 'core with no imports');
  const write = imports => f.write(path, { ...manifest, imports });
  const name = '#byok-local';
  write({ [name]: './dist/local.js', '#byok-local/tool': { types: './dist/tool.d.ts', node: { import: './dist/tool.js' } } });
  assert.ok(selectImpact([path], f).dirs.includes('packages/core'));
  for (const target of ['../dist/local.js', './dist/../local.js', './dist/sub/../local.js',
    './dist/%2e%2e/local.js', './dist/..\\local.js', './dist/Node_Modules/local.js', './dist/',
    '/dist/local.js', 'C:/dist/local.js', '@byok-sdk/client', './src/local.js', './dist/../../client/dist/local.js',
    { types: './dist/local.d.ts', node: { import: '../client/dist/local.js' }, default: './dist/local.js' },
    {}, ['./dist/local.js'], null]) {
    write({ [name]: target });
    assert.throws(() => selectImpact([path], f), /changes more than the reviewed fields/, JSON.stringify(target));
  }
  for (const key of ['#other-local', '#byok-', '#byok-foo/*']) {
    write({ [key]: './dist/local.js' });
    assert.throws(() => selectImpact([path], f), /changes more than the reviewed fields/, key);
  }
});

test('published K8 applies the same private import rule while keeping its fixed exports', t => {
  const { f, dir, path, manifest } = k8Fixture(t);
  f.write(path, manifest); rebase(f, 'published K8');
  const imports = { '#byok-local': './dist/local.js' };
  f.write(path, { ...manifest, imports });
  assert.ok(selectImpact([path], f).dirs.includes(dir));
  f.write(path, { ...manifest, imports: { '#byok-local': '../client/dist/local.js' } });
  assert.throws(() => selectImpact([path], f), /unreviewed imports/);
  f.write(path, { ...manifest, imports, exports: { ...manifest.exports, './local': './dist/local.js' } });
  assert.throws(() => selectImpact([path], f), /unreviewed shape/);
});

test('#2286: core admits exactly its sqlite-node entry', t => {
  const f = fixture(t), path = 'packages/core/package.json';
  const manifest = { name: '@byok-sdk/core', version: '0.43.0', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } };
  f.write(path, manifest); rebase(f, 'core before sqlite-node');
  const entry = { types: './dist/sqlite-node.d.ts', default: './dist/sqlite-node.js' };
  const write = value => f.write(path, { ...manifest, exports: { ...manifest.exports, './sqlite-node': value } });
  write(entry);
  assert.doesNotThrow(() => selectImpact([path], f));
  // Part A shipped a node-only shape first; exactly that shape may move to this one.
  const partA = { types: entry.types, node: { import: './dist/sqlite-node.js' } };
  write(partA); rebase(f, 'core with the part A entry');
  write(entry);
  assert.doesNotThrow(() => selectImpact([path], f));
  for (const invalid of [{ ...entry, types: './dist/other.d.ts' }, { ...entry, default: './dist/other.js' }, { ...partA, default: entry.default }]) {
    write(invalid);
    assert.throws(() => selectImpact([path], f), /changes more than the reviewed fields/);
  }
});

test('#2419: core admits only the exact new provider-model entry', t => {
  const f = fixture(t), path = 'packages/core/package.json';
  const manifest = { name: '@byok-sdk/core', version: '0.44.1', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } };
  f.write(path, manifest); rebase(f, 'core before provider-model');
  const entry = { types: './dist/provider-model.d.ts', import: './dist/provider-model.js' };
  const write = (value, extra = {}) => f.write(path, { ...manifest, exports: { ...manifest.exports, './provider-model': value, ...extra } });
  write(entry);
  assert.ok(selectImpact([path], f).dirs.includes('packages/core'));
  for (const invalid of [{ ...entry, types: './dist/other.d.ts' }, { ...entry, import: './dist/other.js' }, { ...entry, default: entry.import }]) {
    write(invalid);
    assert.throws(() => selectImpact([path], f), /changes more than the reviewed fields/);
  }
  write(entry, { './other': './dist/other.js' });
  assert.throws(() => selectImpact([path], f), /changes more than the reviewed fields/);
  write({ ...entry, import: './dist/other.js' }); rebase(f, 'core with a different provider-model entry');
  write(entry);
  assert.throws(() => selectImpact([path], f), /changes more than the reviewed fields/);
});

test('the K4 example stays private', t => {
  const f = fixture(t), path = 'examples/host-execution-core/package.json';
  const manifest = { name: '@byok-sdk/example-host-execution-core', private: true, version: '0.0.1',
    exports: { './test-support': './src/test-support.ts' } };
  f.write(path, manifest); rebase(f, 'K4 demo');
  f.write(path, { ...manifest, private: false });
  assert.throws(() => selectImpact([path], f), /must stay private/);
});

test('the server lock ranges must match its manifest', t => {
  const f = fixture(t), path = 'packages/server/package.json';
  const manifest = { name: '@byok-sdk/server', version: '0.31.0', devDependencies: { tsx: '^4.19.2' } };
  f.write(path, manifest);
  f.lock.workspaces['packages/server'] = { ...manifest };
  f.write('bun.lock', f.lock); rebase(f, 'server manifest and lock');
  f.lock.workspaces['packages/server'].devDependencies = { tsx: '^4.20.0' }; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /differs from manifest/, 'a lock range the manifest does not declare');
});

test('keys generated defaults and split modules retain their consumers and Windows custody checks', () => {
  const defaults = selectImpact(['packages/keys/src/pi-runtime-defaults.generated.ts']);
  assert.ok(defaults.dirs.includes('packages/keys') && defaults.dirs.includes('packages/client'));
  // The modules split from provider-profile.ts and secret-store.ts keep their Windows custody family.
  for (const path of ['packages/keys/src/provider-profile-binding.ts', 'packages/keys/src/secret-value.ts']) {
    assert.ok(selectImpact([path]).families.includes('adapter-lifecycle-smoke'), path);
  }
});

test('setup documentation admits only exact additive generator commands and its test', t => {
  const f = fixture(t);
  f.write('scripts/docs/device-setup.test.mjs', '');
  f.write('scripts/docs/device-setup.mjs', '');
  const scripts = {
    ...f.rootManifest.scripts,
    'docs:device-setup': 'node scripts/docs/device-setup.mjs --write',
    'check:device-setup': 'node scripts/docs/device-setup.mjs',
    'test:scripts': f.rootManifest.scripts['test:scripts'] + ' scripts/docs/device-setup.test.mjs',
  };
  f.write('package.json', { ...f.rootManifest, scripts });
  assert.equal(selectImpact(['package.json'], f).reason, 'root-ci-scripts');
  for (const name of ['docs:device-setup', 'check:device-setup']) {
    f.write('package.json', { ...f.rootManifest, scripts: { ...scripts, [name]: scripts[name] + ' ; echo bypass' } });
    assert.throws(() => selectImpact(['package.json'], f));
  }
});

test('the client host-layout retains consumer and packed checks', t => {
  const f = fixture(t), path = 'packages/client/package.json';
  const entry = { types: './dist/host-layout.d.ts', import: './dist/host-layout.js' };
  f.write(path, { ...f.manifest, exports: { './host-layout': entry } }); rebase(f, 'client with host-layout');
  const source = 'packages/client/src/host-layout.ts';
  const plan = selectImpact([path, source], f);
  assert.deepEqual(plan.dirs, selectImpact([source], f).dirs);
  assert.deepEqual(plan.families, ['dataplane', 'npm-release-pack']);
  for (const invalid of [{ ...entry, types: './dist/other.d.ts' }, { ...entry, import: './dist/other.js' },
    { ...entry, require: './dist/host-layout.cjs' }]) {
    f.write(path, { ...f.manifest, exports: { './host-layout': invalid } });
    assert.throws(() => selectImpact([path], f), /changes more than the reviewed fields/);
  }
});

test('the packaging example stays private and its lock ranges match its manifest', t => {
  const f = fixture(t), dir = 'examples/packaging';
  const manifest = { name: '@byok-sdk/example-packaging', private: true, version: '0.0.1',
    scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' }, devDependencies: { esbuild: '^0.27.7', vitest: '^4.1.10' } };
  f.write(`${dir}/package.json`, manifest);
  f.lock.workspaces[dir] = { name: manifest.name, version: manifest.version, devDependencies: manifest.devDependencies };
  f.write('bun.lock', f.lock); rebase(f, 'packaging example with its bundle test');
  for (const [candidate, reason] of [
    [{ ...manifest, scripts: { ...manifest.scripts, test: 'vitest run --passWithNoTests' } }, 'another test command'],
    [{ ...manifest, dependencies: { x: '1.0.0' } }, 'a dependency change'],
  ]) {
    f.write(`${dir}/package.json`, candidate);
    assert.throws(() => selectImpact([`${dir}/package.json`], f), /more than/, reason);
  }
  f.write(`${dir}/package.json`, { ...manifest, private: false });
  assert.throws(() => selectImpact([`${dir}/package.json`], f), /must stay private/);
  f.write(`${dir}/package.json`, manifest);
  f.lock.workspaces[dir].devDependencies = { ...manifest.devDependencies, vitest: '^5.0.0' }; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f));
});

for (const name of ['capability-matrix', 'another-projection']) test(`manifest-owned documentation check: ${name}`, t => {
  const f = fixture(t);
  const source = `scripts/docs/${name}.mjs`, drift = `scripts/docs/${name}.test.mjs`;
  f.write(source, ''); f.write(drift, '');
  const scripts = { ...f.rootManifest.scripts,
    [`docs:${name}`]: `node ${source} --write`, [`check:${name}`]: `node ${source}`,
    'test:scripts': `${f.rootManifest.scripts['test:scripts']} ${drift}` };
  f.write('package.json', { ...f.rootManifest, scripts });
  assert.equal(selectImpact(['package.json', source, drift], f).reason, 'root-ci-scripts');
  for (const input of ['packages/client/package.json', 'packages/client/src/adapters/pi/pi-capabilities.ts',
    'packages/client/src/adapters/claude/claude-version.ts', 'docs/adapter-capabilities.md', source, drift]) {
    assert.deepEqual(documentationTestsForPaths([input], f.cwd), [drift]);
  }
  for (const bad of [
    { ...scripts, [`docs:${name}`]: `node ${source} --write ; echo bypass` },
    { ...scripts, [`check:${name}`]: undefined },
    { ...scripts, 'test:scripts': f.rootManifest.scripts['test:scripts'] },
  ]) {
    f.write('package.json', { scripts: bad });
    assert.throws(() => selectImpact(['package.json', source], f), /Documentation check/);
  }
  f.write('package.json', { scripts });
  assert.throws(() => selectImpact(['scripts/docs/unregistered.mjs'], f), /unmapped/);
});

test('generic example manifest upgrades include the basic workspace', t => {
  const f = fixture(t), path = 'examples/basic/package.json';
  const manifest = { name: '@byok-sdk/example-basic', private: true, version: '0.0.1', devDependencies: { tooling: '1.0.0' } };
  f.write(path, manifest); rebase(f, 'existing basic dependency');
  f.write(path, { ...manifest, devDependencies: { tooling: '2.0.0' } });
  const plan = selectImpact([path], f);
  assert.ok(plan.dirs.includes('examples/basic'));
  assert.ok(plan.families.includes('npm-release-pack'));
  for (const bad of [{ ...manifest, private: false }, { ...manifest, scripts: { test: 'echo bypass' } }, { ...manifest, dependencies: { newEdge: '1.0.0' } }]) {
    f.write(path, bad); assert.throws(() => selectImpact([path], f));
  }
});


test('CI helper precedes rh normalization', t => {
  const f = fixture(t);
  const previous = f.rootManifest.scripts['test:scripts'];
  for (const helper of ['rh --help', 'rh run no-such-check || true']) {
    for (const command of [previous, 'bun run test:scripts:ci && ' + previous]) {
      f.write('package.json', { scripts: { 'test:scripts:ci': helper, 'test:scripts': command } });
      assert.throws(() => selectImpact(['package.json'], f), /Unreviewed CI test composition/);
    }
  }
  f.write('package.json', { scripts: {
    'test:scripts:ci': 'node --test scripts/ci/*.test.mjs', 'test:scripts': previous,
  } });
  assert.throws(() => selectImpact(['package.json'], f), /Unreviewed CI test composition/);
});

test('root CI composition admits only the exact helper and prefix, retaining the ordered list guard', t => {
  const f = fixture(t);
  const previous = f.rootManifest.scripts['test:scripts'];
  const helper = 'node --test scripts/ci/*.test.mjs';
  const prefix = 'bun run test:scripts:ci && ';
  const valid = { 'test:scripts:ci': helper, 'test:scripts': prefix + previous };
  f.write('package.json', { scripts: valid });
  assert.equal(selectImpact(['package.json'], f).reason, 'root-ci-scripts');
  for (const scripts of [
    { 'test:scripts': prefix + previous },
    ...['node --test scripts/**/*.test.mjs', helper + ' --test-only', helper + ' scripts/extra.test.mjs'].map(command => ({ ...valid, 'test:scripts:ci': command })),
    { ...valid, 'test:scripts': prefix + previous + ' && true' },
    { ...valid, 'test:scripts': prefix + 'echo bypass && ' + previous },
    { ...valid, 'test:scripts': previous + ' && bun run test:scripts:ci' },
    { ...valid, 'test:scripts': previous },
    { ...valid, 'test:scripts': prefix + previous.replace('scripts/old.test.mjs', 'scripts/ci/new.test.mjs') },
  ]) {
    f.write('package.json', { scripts });
    assert.throws(() => selectImpact(['package.json'], f), undefined, JSON.stringify(scripts));
  }
  f.write('package.json', { scripts: valid }); rebase(f, 'shared CI helper is required');
  f.write('package.json', { scripts: { ...valid, 'test:scripts': prefix + previous + ' scripts/ci/new.test.mjs' } });
  assert.equal(selectImpact(['package.json'], f).reason, 'root-ci-scripts');
  for (const scripts of [{ 'test:scripts': previous }, { ...valid, 'test:scripts': previous }, { 'test:scripts': prefix + previous }]) {
    f.write('package.json', { scripts });
    assert.throws(() => selectImpact(['package.json'], f), /Unreviewed CI test composition/);
  }
});

test('the desktop browser command is admitted exactly and an altered command is refused', t => {
  const f = fixture(t), dir = 'examples/desktop-bot-app', path = `${dir}/package.json`;
  const app = JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
  const { 'test:keys-browser': browser, ...scripts } = app.scripts;
  assert.equal(browser, 'node --test scripts/keys-submit.browser.mjs');
  for (const name of Object.keys(app.dependencies).filter(name => name.startsWith('@byok-sdk/'))) {
    f.write(`packages/${name.slice('@byok-sdk/'.length)}/package.json`, { name, version: '0.41.0' });
  }
  f.write(path, { ...app, scripts }); rebase(f, 'desktop before browser command');
  f.write(path, app);
  const plan = selectImpact([path], f);
  assert.ok(plan.dirs.includes(dir));
  assert.ok(plan.families.includes('desktop'));
  f.write(path, { ...app, scripts: { ...app.scripts, 'test:keys-browser': 'node --test scripts/other.browser.mjs' } });
  assert.throws(() => selectImpact([path], f), /changes more than the reviewed fields/);
});

test('new graph-registered private workspaces and matching lock rows are admitted; unregistered additions fail', t => {
  const f = fixture(t);
  // #1808: the desktop example's ui-runtime edge needs ui-runtime declared in the base.
  for (const id of ['core', 'protocol', 'server', 'keys', 'ui-runtime']) {
    const manifest = { name: `@byok-sdk/${id}`, version: '0.28.0' };
    f.write(`packages/${id}/package.json`, manifest); f.lock.workspaces[`packages/${id}`] = manifest;
  }
  // #1806: the desktop example's K8 edge needs K8 declared in the base.
  const k8 = { name: '@byok-sdk/bot-collaboration', version: '0.0.1', private: true };
  f.write('packages/bot-collaboration/package.json', k8); f.lock.workspaces['packages/bot-collaboration'] = k8;
  f.write('bun.lock', f.lock); rebase(f, 'base dependency declarations');
  const dir = 'examples/basic';
  const manifest = { name: '@byok-sdk/example-basic', version: '0.0.1', private: true, type: 'module',
    scripts: { dev: 'tsx server.ts', typecheck: 'tsc --noEmit', test: 'vitest run' },
    dependencies: { '@byok-sdk/client': 'workspace:*', '@byok-sdk/core': 'workspace:*', '@byok-sdk/protocol': 'workspace:*', '@byok-sdk/server': 'workspace:*' } };
  f.write(`${dir}/package.json`, manifest);
  f.lock.workspaces[dir] = { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies };
  f.lock.packages[manifest.name] = [`${manifest.name}@workspace:${dir}`];
  f.write('bun.lock', f.lock);
  assert.ok(selectImpact([`${dir}/package.json`, 'bun.lock'], f).dirs.includes(dir));
  for (const change of [{ private: false }, { name: 'unregistered-name' }, { scripts: { typecheck: 'tsc --noEmit' } }, { dependencies: { '@byok-sdk/client': 'workspace:*' } }, { devDependencies: { unapproved: '1.0.0' } }]) {
    f.write(`${dir}/package.json`, { ...manifest, ...change });
    assert.throws(() => selectImpact([`${dir}/package.json`], f));
  }
  f.write(`${dir}/package.json`, manifest);
  f.lock.workspaces[dir].version = '0.0.2'; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /lock rows differ/);
  const unknown = 'examples/unregistered';
  f.write(`${unknown}/package.json`, manifest);
  assert.throws(() => selectImpact([`${unknown}/package.json`], f), /graph-registered/);
  delete f.lock.workspaces[dir]; delete f.lock.packages[manifest.name];
  f.lock.workspaces[unknown] = { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies };
  f.lock.packages[manifest.name] = [`${manifest.name}@workspace:${unknown}`]; f.write('bun.lock', f.lock);
  assert.throws(() => selectImpact(['bun.lock'], f), /graph-registered/);
  // #1804: the desktop example's exact additions, and the new lock rows they declare.
  delete f.lock.workspaces[unknown]; delete f.lock.packages[manifest.name];
  const desktop = 'examples/desktop-bot-app';
  // The fixture base declares none of the shared tool specs, so only the two additions stay.
  const { devDependencies: { electron, '@electron/fuses': fuses }, ...shape } = JSON.parse(readFileSync(new URL(`../../${desktop}/package.json`, import.meta.url), 'utf8'));
  const app = { ...shape, devDependencies: { electron, '@electron/fuses': fuses } };
  f.write(`${desktop}/package.json`, app);
  f.lock.workspaces[desktop] = { name: app.name, version: app.version, dependencies: app.dependencies, devDependencies: app.devDependencies };
  f.lock.packages[app.name] = [`${app.name}@workspace:${desktop}`];
  f.lock.packages.electron = ['electron@45.3.0', '', {}, 'sha512-x'];
  f.write('bun.lock', f.lock);
  assert.ok(selectImpact([`${desktop}/package.json`, 'bun.lock'], f).dirs.includes(desktop));
  f.write(`${desktop}/package.json`, { ...app, devDependencies: { ...app.devDependencies, electron: '45.3.1' } });
  assert.throws(() => selectImpact([`${desktop}/package.json`], f), /reuse a base dependency spec \(electron\)/);
  // #1805: the existing desktop example gains its reviewed edges and an exact registered addition, and nothing else.
  const { dependencies: edges, devDependencies: { '@electron/fuses': _fuses, ...withoutFuses }, ...bare } = app;
  f.write(`${desktop}/package.json`, { ...bare, devDependencies: withoutFuses }); rebase(f, 'desktop example without edges and fuses');
  f.write(`${desktop}/package.json`, app);
  assert.ok(selectImpact([`${desktop}/package.json`], f).dirs.includes(desktop));
  f.write(`${desktop}/package.json`, { ...app, devDependencies: { ...app.devDependencies, '@electron/fuses': '2.1.4' } });
  assert.throws(() => selectImpact([`${desktop}/package.json`], f), /reuse a base dependency spec \(@electron\/fuses\)/);
  f.write(`${desktop}/package.json`, { ...app, dependencies: { ...edges, '@byok-sdk/cloud': 'workspace:*' } });
  assert.throws(() => selectImpact([`${desktop}/package.json`], f), /edges differ from reviewed graph/);
});
