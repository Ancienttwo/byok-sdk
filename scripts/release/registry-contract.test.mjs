import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assertFrozenRegistryExpectations,
  assertPrereleaseRegistryBaseline,
  npmDistTags,
  npmPackageExists,
  npmView,
  runtimeDependencyMetadata,
  readRegistryMetadata,
  validateRegistryExpectations,
} from './registry-contract.mjs';
import { assertNoPartialPrereleaseRegistryState, assertPrereleaseReadyToPublish } from './publish.mjs';

const plan = JSON.parse(readFileSync(new URL('./registry-expectations.json', import.meta.url), 'utf8'));
const names = Object.keys(plan.packages);
const fresh = '@byok-sdk/cloud-do';
const old = '@byok-sdk/core';
const rc = '0.24.0-rc.1';
const keysRc = '0.8.1-rc.1';
const good = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
const failure = (code, summary) => ({ status: 1, stdout: JSON.stringify({ error: { code, summary } }), stderr: code });
const absentPackage = () => failure('E404', `Not Found - GET https://registry.fixture/${fresh.replace('/', '%2f')} - Not found`);

/** Routes all reads through the real npm result classifier, with no network/process I/O. */
function mockRegistry(responses) {
  const calls = [];
  const options = { invocation: { command: 'npm', prefix: [] }, cwd: '/unused-offline-fixture' };
  const view = (selector, fields, allowNotFound = false) => npmView({
    ...options, selector, fields, allowNotFound,
    spawn(command, args) {
      calls.push({ command, selector, fields, allowNotFound });
      assert.deepEqual(args, ['view', selector, ...fields, '--json']);
      const key = fields.length === 1 && fields[0] === 'dist-tags' ? selector.slice(0, selector.lastIndexOf('@')) : selector;
      assert.ok(responses.has(key), `unmocked registry request: ${key}`);
      return structuredClone(responses.get(key));
    },
  });
  const packageExists = (name) => npmPackageExists({ ...options, name, spawn(command, args) {
    calls.push({ command, selector: name });
    assert.deepEqual(args, ['view', name, 'name', '--json', '--tag', 'latest']);
    const result = responses.get(name);
    return result.status === 0 ? good(name) : result;
  } });
  const distTags = (name) => npmDistTags({ ...options, name, spawn(command, args) {
    calls.push({ command, selector: name });
    assert.deepEqual(args, ['dist-tag', 'ls', name, '--json']);
    const result = responses.get(name);
    return result.status === 0 ? { ...result, stdout: Object.entries(JSON.parse(result.stdout)).map(([tag, version]) => `${tag}: ${version}`).join('\n') } : result;
  } });
  return { calls, view, packageExists, distTags };
}

function fixture({ stable = false } = {}) {
  const expectedVersion = stable ? '0.24.0' : rc;
  const packageVersions = Object.fromEntries(names.map((name) =>
    [name, name === '@byok-sdk/keys' ? (stable ? '0.8.1' : keysRc) : expectedVersion]));
  const frozenPackages = new Map(names.map((name) =>
    [name, { version: packageVersions[name], sha512Integrity: `sha512-${createHash('sha512').update(name).digest('base64')}`,
      runtimeDependencies: runtimeDependencyMetadata({ dependencies: name === old ? {} : { [old]: expectedVersion } }, name) }]));
  const responses = new Map();
  for (const name of names) {
    responses.set(name + '@' + packageVersions[name], good({
      name, version: packageVersions[name], maintainers: [{ name: 'ancienttwo' }],
      dist: { integrity: frozenPackages.get(name).sha512Integrity },
      dependencies: name === old ? {} : { [old]: expectedVersion },
    }));
    const previousLatest = plan.packages[name].previousLatest;
    responses.set(name, good(stable ? { latest: packageVersions[name] } : {
      rc: packageVersions[name], ...(previousLatest === null ? {} : { latest: previousLatest }),
    }));
  }
  const registry = mockRegistry(responses);
  const options = { packageVersions, frozenPackages, expectedVersion, expectations: plan,
    distTag: stable ? undefined : 'rc', view: registry.view };
  return { ...registry, responses, options, read: () => readRegistryMetadata(options) };
}

function mutateResponse(fixture, selector, change) {
  const value = JSON.parse(fixture.responses.get(selector).stdout);
  change(value);
  fixture.responses.set(selector, good(value));
}

test('the reviewed plan enumerates all ten packages and explicitly distinguishes the first publication', () => {
  assert.equal(names.length, 10);
  assert.equal(validateRegistryExpectations(plan, names), plan);
  assert.deepEqual(plan.packages[fresh], { priorPublication: 'none', previousLatest: null });
  assert.equal(plan.packages[old].previousLatest, '0.23.0');
  assert.equal(plan.packages['@byok-sdk/keys'].previousLatest, '0.8.0');
  for (const change of [
    (p) => { delete p.packages[fresh]; },
    (p) => { p.packages['@byok-sdk/unreviewed'] = p.packages[fresh]; },
    (p) => { delete p.packages[fresh].previousLatest; },
    (p) => { p.packages[fresh].previousLatest = '0.23.0'; },
    (p) => { p.packages[old].previousLatest = rc; },
    (p) => { p.packages[fresh].skipReadback = true; },
  ]) {
    const altered = structuredClone(plan);
    change(altered);
    assert.throws(() => validateRegistryExpectations(altered, names), /expectation/);
  }
});

test('frozen artifacts must bind the complete reviewed baseline, package set and mandatory metadata', () => {
  const f = fixture();
  const manifest = { registryExpectations: structuredClone(plan), packages: [...f.options.frozenPackages].map(([name, entry]) => ({ package: name, ...entry })) };
  const check = (m) => assertFrozenRegistryExpectations(m, plan, f.options.packageVersions);
  assert.doesNotThrow(() => check(manifest));
  assert.throws(() => check({}), /registry expectations/);
  for (const change of [
    (m) => { m.packages.pop(); },
    (m) => { m.packages.push(m.packages[0]); },
    (m) => { m.packages[1] = m.packages[0]; },
    (m) => { m.packages[0].package = '@byok-sdk/unknown'; },
  ]) {
    const altered = structuredClone(manifest); change(altered);
    assert.throws(() => check(altered), /package set mismatch/);
  }
  const changed = structuredClone(manifest);
  changed.registryExpectations.packages[old].previousLatest = null;
  assert.throws(() => check(changed), /differs from the reviewed plan/);
  for (const field of ['sha512Integrity', 'runtimeDependencies']) {
    const altered = structuredClone(manifest); delete altered.packages[0][field];
    assert.throws(() => check(altered), /frozen artifact/);
  }
});

test('prerelease preflight accepts only declared package absence and exact old latest baselines', () => {
  const responses = new Map(names.map((name) => [name, name === fresh
    ? absentPackage() : good({ latest: plan.packages[name].previousLatest })]));
  const registry = mockRegistry(responses);
  const entries = names.map((name) => ({ name }));
  assert.doesNotThrow(() => assertPrereleaseRegistryBaseline(entries, plan, 'rc', registry));
  assert.equal(registry.calls.length, 10);
  responses.set(old, failure('E404'));
  assert.throws(() => assertPrereleaseRegistryBaseline(entries, plan, 'rc', registry), /dist-tag ls.*failed/);
  responses.set(old, good({ latest: '0.23.1' }));
  assert.throws(() => assertPrereleaseRegistryBaseline(entries, plan, 'rc', registry), /expected stable 0.23.0/);
  responses.set(old, good({ latest: '0.23.0' }));
  responses.set(fresh, good({ rc }));
  assert.throws(() => assertPrereleaseRegistryBaseline(entries, plan, 'rc', registry), /first-publication plan requires an absent package/);
});

test('later prerelease-only packages need an explicit existing-without-latest plan, never an automatic fallback', () => {
  const revised = structuredClone(plan);
  revised.packages[fresh].priorPublication = 'existing';
  const responses = new Map(names.map((name) => [name, name === fresh
    ? good({ rc: '0.24.0-rc.0' }) : good({ latest: plan.packages[name].previousLatest })]));
  assert.doesNotThrow(() => assertPrereleaseRegistryBaseline(names.map((name) => ({ name })), revised, 'rc', mockRegistry(responses)));
});

test('structured E404 is absent only when requested; authentication, transient and unreadable failures are never absence', () => {
  const selector = fresh + '@' + rc;
  const responses = new Map([[selector, failure('E404')]]);
  const { view } = mockRegistry(responses);
  assert.deepEqual(view(selector, ['version'], true), { found: false });
  assert.throws(() => view(selector, ['version']), /E404/);
  for (const result of [
    failure('E401'), failure('E403'), failure('E500'), failure('E429'), failure('ECONNRESET'), failure('ETIMEDOUT'),
    { status: 1, stdout: '404 Not Found', stderr: '' },
    { status: 1, stdout: '', stderr: 'E404' },
    { status: null, signal: 'SIGTERM', stdout: failure('E404').stdout },
    { status: 1, error: new Error('spawn ENOENT'), stdout: failure('E404').stdout },
    good({ error: { code: 'E404' } }),
  ]) {
    responses.set(selector, result);
    assert.throws(() => view(selector, ['version'], true), /npm (view|package probe)/);
  }
});

test('auth and transient errors also fail a declared first-publication preflight', () => {
  for (const code of ['E401', 'E403', 'ETIMEDOUT', 'E503']) {
    const responses = new Map(names.map((name) => [name, name === fresh
      ? failure(code) : good({ latest: plan.packages[name].previousLatest })]));
    assert.throws(() => assertPrereleaseRegistryBaseline(names.map((name) => ({ name })), plan, 'rc', mockRegistry(responses)), new RegExp(code));
  }
});

test('mixed old and first-publication RC readback verifies all ten exact artifacts and tags', () => {
  const f = fixture();
  assert.equal(f.read().length, 10);
  assert.equal(f.calls.length, 20);
  assert.ok(f.calls.every((call) => call.allowNotFound === false));
  assert.ok(f.calls.some((call) => call.selector === fresh + '@' + rc));
  assert.ok(f.calls.some((call) => call.selector === '@byok-sdk/keys@' + keysRc));
});

test('a partial publication cannot masquerade as a first publication or resume the prerelease', () => {
  const f = fixture();
  f.responses.set(fresh + '@' + rc, failure('E404'));
  assert.throws(f.read, /E404/);
  const entries = names.map((name) => ({ name }));
  const partial = new Map(names.map((name) => [name, name !== fresh]));
  assert.throws(() => assertNoPartialPrereleaseRegistryState(entries, partial, 'rc'), /partially published/);
  assert.doesNotThrow(() => assertNoPartialPrereleaseRegistryState(entries, partial, undefined));
});

test('post-publish readback never converts absent tags, authentication or transient failures to success', () => {
  for (const code of ['E404', 'E401', 'E403', 'ETIMEDOUT', 'E503']) {
    for (const selector of [fresh, fresh + '@' + rc]) {
      const f = fixture();
      f.responses.set(selector, failure(code));
      assert.throws(f.read, new RegExp(code));
    }
  }
});

test('a first publication retains exact identity, integrity, maintainer and dependency checks', () => {
  for (const [change, expected] of [
    [(v) => { v.name = old; }, /identity\/version mismatch/],
    [(v) => { v.version = '0.24.0'; }, /identity\/version mismatch/],
    [(v) => { v.dist.integrity = 'sha512-wrong'; }, /integrity differs/],
    [(v) => { v.maintainers = []; }, /ancienttwo/],
    [(v) => { v.dependencies[old] = '0.23.0'; }, /published graph is split/],
    [(v) => { v.optionalDependencies = { [old]: '^' + rc }; }, /published graph is split/],
    [(v) => { v.peerDependencies = { [old]: '*' }; }, /published graph is split/],
  ]) {
    const f = fixture();
    mutateResponse(f, fresh + '@' + rc, change);
    assert.throws(f.read, expected);
  }
});

test('wrong/missing RC tags and any accidental latest on the first publication fail closed', () => {
  for (const [name, change, expected] of [
    [fresh, (v) => { delete v.rc; }, /dist-tag rc/],
    [fresh, (v) => { v.rc = '0.24.0-rc.0'; }, /dist-tag rc/],
    [fresh, (v) => { v.latest = rc; }, /expected latest to be absent/],
    [fresh, (v) => { v.latest = '0.23.0'; }, /expected latest to be absent/],
    [fresh, (v) => { v.latest = null; }, /object of version strings/],
    [old, (v) => { delete v.latest; }, /expected stable 0.23.0/],
    [old, (v) => { v.latest = rc; }, /expected stable 0.23.0/],
  ]) {
    const f = fixture();
    mutateResponse(f, name, change);
    assert.throws(f.read, expected);
  }
  for (const malformed of [null, [], 'rc', 42]) {
    const f = fixture();
    f.responses.set(fresh, good(malformed));
    assert.throws(f.read, /dist-tags must be an object/);
  }
});

test('stable release readback requires exact latest for old and new packages, with independent keys version', () => {
  const f = fixture({ stable: true });
  assert.equal(f.read().length, 10);
  mutateResponse(f, fresh, (v) => { delete v.latest; });
  assert.throws(f.read, /dist-tag latest/);
  assert.doesNotThrow(() => assertPrereleaseRegistryBaseline(names.map((name) => ({ name })), plan, undefined,
    () => assert.fail('stable resumability must not use the prerelease baseline gate')));
});

test('package absence requires a package-document HTTP 404, never tag selection, tombstone or generic E404', () => {
  const options = { invocation: { command: 'npm', prefix: [] }, name: fresh, cwd: '/unused-offline-fixture' };
  assert.equal(npmPackageExists({ ...options, spawn: () => absentPackage() }), false);
  for (const response of [good(fresh), { status: 0, stdout: '', stderr: '' }]) {
    assert.equal(npmPackageExists({ ...options, spawn: () => response }), true);
  }
  for (const response of [
    failure('E404'), failure('E404', 'No match found for version next'), failure('E404', 'Unpublished on yesterday'),
    failure('E404', `Not Found - GET https://registry.fixture/-/package/${fresh}/dist-tags - Not found`),
    failure('E404', 'Not Found - GET https://registry.fixture/wrong-package - Not found'),
    failure('E401'), failure('E403'), failure('ECONNRESET'), good({ error: { code: 'E404' } }),
    { status: 0, stdout: '<html>bad gateway</html>', stderr: '' },
  ]) {
    assert.throws(() => npmPackageExists({ ...options, spawn: () => response }), /package probe/);
  }
});

test('maintainer identity accepts exact npm object and string representations, never substring matches', () => {
  for (const maintainers of [[{ name: 'ancienttwo' }], ['ancienttwo'], ['ancienttwo <owner@example.test>']]) {
    const f = fixture();
    mutateResponse(f, fresh + '@' + rc, (v) => { v.maintainers = maintainers; });
    assert.equal(f.read().length, 10);
  }
  for (const maintainers of [[{ name: 'not-ancienttwo' }], [{ name: 'ancienttwo-attacker' }],
    ['not-ancienttwo <owner@example.test>'], ['Someone <ancienttwo@example.test>'], ['ancienttwo attacker']]) {
    const f = fixture();
    mutateResponse(f, fresh + '@' + rc, (v) => { v.maintainers = maintainers; });
    assert.throws(f.read, /ancienttwo is not present/);
  }
});

test('runtime dependency maps are mandatory in frozen metadata and exact in registry readback', () => {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const invalid of [null, [], 'bad', 3, { bad: null }, { bad: [] }, { bad: '' }]) {
      const f = fixture();
      mutateResponse(f, fresh + '@' + rc, (v) => { v[field] = invalid; });
      assert.throws(f.read, /must be an object of dependency ranges/);
    }
    const missing = fixture();
    delete missing.options.frozenPackages.get(fresh).runtimeDependencies[field];
    assert.throws(missing.read, /no complete runtime dependency metadata/);
    const drift = fixture();
    mutateResponse(drift, fresh + '@' + rc, (v) => { v[field] = { 'unexpected-external-package': '1.0.0' }; });
    assert.throws(drift.read, /differs from frozen artifact metadata/);
  }
  const omitted = fixture();
  mutateResponse(omitted, fresh + '@' + rc, (v) => { delete v.dependencies; });
  assert.throws(omitted.read, /differs from frozen artifact metadata/);
  const noFrozenMetadata = fixture();
  delete noFrozenMetadata.options.frozenPackages.get(fresh).runtimeDependencies;
  assert.throws(noFrozenMetadata.read, /no complete runtime dependency metadata/);
});

test('the last prerelease gate refreshes exact version absence and the complete baseline before any write', () => {
  const entries = names.map((name) => ({ name, version: name === '@byok-sdk/keys' ? keysRc : rc }));
  const responses = new Map(names.map((name) => [name, name === fresh
    ? absentPackage() : good({ latest: plan.packages[name].previousLatest })]));
  const registry = { ...mockRegistry(responses), isPublished: () => false };
  assert.doesNotThrow(() => assertPrereleaseReadyToPublish(entries, plan, 'rc', registry));
  registry.isPublished = (name) => name === old;
  assert.throws(() => assertPrereleaseReadyToPublish(entries, plan, 'rc', registry), /registry state changed before publication/);
  registry.isPublished = () => false;
  responses.set(old, good({ latest: '0.23.1' }));
  assert.throws(() => assertPrereleaseReadyToPublish(entries, plan, 'rc', registry), /expected stable 0.23.0/);
  assert.doesNotThrow(() => assertPrereleaseReadyToPublish(entries, plan, undefined, {}));
});
