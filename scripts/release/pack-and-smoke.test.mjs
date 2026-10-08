import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  parsePiRuntimeIdentity, PI_DEPENDENCY_SPECIFIER, PI_DIRECT_CLOSURE, PI_RUNTIME_CLOSURE, readInstalledPiClosure, readLockedPiClosure,
} from './pi-runtime-identity.mjs';

const releasePackSource = readFileSync(
  fileURLToPath(new URL('./pack-and-smoke.mjs', import.meta.url)),
  'utf8',
);

test('release pack includes keys and verifies its packed core edge', () => {
  assert.match(
    releasePackSource,
    /name:\s*'@byok-sdk\/keys',\s*directory:\s*'packages\/keys'/,
    'the release pack must include the independently versioned keys package',
  );
  assert.match(
    releasePackSource,
    /packed\.dependencies\?\.\['@byok-sdk\/core'\]\s*!==\s*releaseVersion/,
    'the packed keys manifest must declare the aligned core release directly',
  );
  assert.match(
    releasePackSource,
    /keysVersion/,
    'the pack manifest must retain keys as an independently versioned artifact',
  );
});

test('release pack accepts exact prerelease versions while Pi remains a stable pin', () => {
  assert.match(
    releasePackSource,
    /const exactReleaseVersion = \/\^\(0\|\[1-9\]\\d\*\)/,
    'SDK artifact versions must admit canonical SemVer prereleases',
  );
  assert.match(
    releasePackSource,
    /exactReleaseVersion\.test\(releaseVersion\)/,
    'the release train must use the prerelease-aware validator',
  );
  assert.match(
    releasePackSource,
    /parsePiRuntimeIdentity\(/,
    'Pi must stay pinned through the one shared runtime identity authority',
  );
  assert.match(
    releasePackSource,
    /assertInstalledPiRuntime\(smokeDir, piRuntime, lockedPiClosure, 'release-pack', npmInvocation\)/,
    'the isolated install must be proven to hold exactly the locked official Pi closure',
  );
});

const PI_INDIRECT = ['@earendil-works/pi-tui', '@earendil-works/pi-telemetry', '@earendil-works/pi-codemode', '@earendil-works/pi-mcp'];
const PI_DIRECT = PI_RUNTIME_CLOSURE.filter((name) => !PI_INDIRECT.includes(name));
assert.deepEqual(PI_DIRECT_CLOSURE, PI_DIRECT);
const exactClosure = (version) => Object.fromEntries(PI_DIRECT.map((name) => [name, version]));

test('the Pi runtime identity authority admits only an exact official closure', () => {
  assert.deepEqual(parsePiRuntimeIdentity({ dependencies: exactClosure('1.0.4') }), {
    specifier: PI_DEPENDENCY_SPECIFIER,
    spec: '1.0.4',
    packageName: PI_DEPENDENCY_SPECIFIER,
    version: '1.0.4',
    closure: PI_RUNTIME_CLOSURE,
  });
  for (const rejected of ['npm:@byok-sdk/pi-coding-agent@0.86.1001', 'npm:@earendil-works/pi-coding-agent@1.0.4', '^1.0.4', '0.99', 'latest', '']) {
    assert.throws(
      () => parsePiRuntimeIdentity({ dependencies: { ...exactClosure('1.0.4'), [PI_DEPENDENCY_SPECIFIER]: rejected } }),
      /must be pinned to one exact official x\.y\.z version/,
      `${rejected} must be rejected`,
    );
  }
  assert.throws(() => parsePiRuntimeIdentity({ dependencies: {} }), /must be a required dependency/);
  for (const name of PI_INDIRECT) {
    assert.throws(
      () => parsePiRuntimeIdentity({ dependencies: { ...exactClosure('1.0.4'), [name]: '1.0.4' } }),
      new RegExp(`${name.replace('/', '\\/')} is not a direct client dependency; it must reach the install only through`),
      `${name} must not be a direct dependency`,
    );
  }
  for (const name of PI_DIRECT.slice(1)) {
    for (const drift of [undefined, '^1.0.4', '0.99.1']) {
      assert.throws(
        () => parsePiRuntimeIdentity({ dependencies: { ...exactClosure('1.0.4'), [name]: drift } }),
        new RegExp(`${name.replace('/', '\\/')} must be a required dependency pinned exactly to 1\\.0\\.4`),
      );
    }
  }
});

test('the locked closure is exact, integrity-bearing and fork-free', () => {
  const entry = (name, version, integrity = `sha512-${'A'.repeat(86)}==`) => `    "${name}": ["${name}@${version}", "", {}, "${integrity}"],\n`;
  const lock = (body) => `{\n  "lockfileVersion": 1,\n  "packages": {\n${body}  },\n}\n`;
  const identity = { version: '1.0.4' };
  const good = PI_RUNTIME_CLOSURE.map((name) => entry(name, '1.0.4')).join('');
  assert.equal(readLockedPiClosure(lock(good), identity).size, PI_RUNTIME_CLOSURE.length);
  assert.throws(() => readLockedPiClosure(lock(good + entry('pi-subagents/@earendil-works/pi-tui', '0.85.1').replace('"pi-subagents/@earendil-works/pi-tui@0.85.1"', '"@earendil-works/pi-tui@0.85.1"')), identity),
    /resolves to @earendil-works\/pi-tui@0\.85\.1, but the Pi closure is pinned to 1\.0\.4/);
  assert.throws(() => readLockedPiClosure(lock(good + `    "@earendil-works/pi-agent-core": ["@byok-sdk/pi-agent-core@0.86.1001", "", {}, "sha512-${'B'.repeat(86)}=="],\n`), identity),
    /retired fork/);
  assert.throws(() => readLockedPiClosure(lock(good.replace(`sha512-${'A'.repeat(86)}==`, '')), identity), /carries no sha512 integrity/);
  for (const name of ['@earendil-works/chord', '@earendil-works/pi-codemode', '@earendil-works/pi-mcp']) {
    assert.throws(() => readLockedPiClosure(lock(good.replace(entry(name, '1.0.4'), '')), identity),
      new RegExp(`${name.replace('/', '\\/')}@1\\.0\\.4 is not locked`));
  }
});

test('the repo pins the official Pi closure the release gates verify', () => {
  const clientManifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../packages/client/package.json', import.meta.url)), 'utf8'),
  );
  const identity = parsePiRuntimeIdentity(clientManifest);
  assert.equal(identity.packageName, '@earendil-works/pi-coding-agent');
  assert.equal(identity.version, '1.0.4');
  assert.deepEqual(
    [...identity.closure].sort(),
    ['chord', 'pi-agent-core', 'pi-ai', 'pi-codemode', 'pi-coding-agent', 'pi-durable', 'pi-mcp', 'pi-telemetry', 'pi-tui'].map((name) => `@earendil-works/${name}`),
  );
  const locked = readLockedPiClosure(readFileSync(fileURLToPath(new URL('../../bun.lock', import.meta.url)), 'utf8'), identity);
  assert.equal(locked.get(PI_DEPENDENCY_SPECIFIER), 'sha512-+956nfMFHr5lDUVY/2Q4k+YzojzBuCaBXFgj0eSlXVGr7QVliVddKdc1Pz6yVg1dOlJQmb67doOVrlMsIcIdaw==');
  assert.equal(clientManifest.optionalDependencies?.[PI_DEPENDENCY_SPECIFIER], undefined);
});

/**
 * One isolated npm install: `node_modules/<name>/package.json` per installed
 * package and the `package-lock.json` npm writes beside it.
 */
function npmInstallFixture(packages) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'byok-pi-installed-closure-'));
  const lockPackages = { '': { name: 'fixture' } };
  for (const { name, version, integrity } of packages) {
    const dir = path.join(root, 'node_modules', ...name.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
    lockPackages[`node_modules/${name}`] = { version, ...(integrity === undefined ? {} : { integrity }) };
  }
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: lockPackages }));
  return root;
}

test('the installed closure gates the direct pins and reports newer indirect packages', () => {
  const identity = { packageName: PI_DEPENDENCY_SPECIFIER, version: '1.0.4' };
  const integrityOf = (name) => `sha512-${Buffer.from(name).toString('base64')}`;
  const locked = new Map(PI_RUNTIME_CLOSURE.map((name) => [name, integrityOf(name)]));
  const direct = PI_DIRECT.map((name) => ({ name, version: '1.0.4', integrity: integrityOf(name) }));
  // A fresh install after upstream published 1.1.0: the caret ranges of the
  // coding agent and pi-ai take the newer indirect packages.
  const newerIndirect = PI_INDIRECT.map((name) => ({ name, version: '1.1.0', integrity: `sha512-${'C'.repeat(86)}==` }));
  const read = (packages) => {
    const root = npmInstallFixture(packages);
    try {
      return readInstalledPiClosure(root, identity, locked, 'fixture');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  const fresh = read([...direct, ...newerIndirect]);
  assert.equal(fresh.pi.manifest.name, PI_DEPENDENCY_SPECIFIER);
  assert.deepEqual(fresh.unproven, []);
  assert.deepEqual(fresh.indirect, PI_INDIRECT.map((name) => `${name}@1.1.0`));
  assert.deepEqual(read(direct).indirect, PI_INDIRECT.map((name) => `${name} absent`));

  // A wrong direct pin, as installed or as npm recorded it, still fails.
  for (const name of PI_DIRECT) {
    const drifted = direct.map((entry) => (entry.name === name ? { ...entry, version: '1.1.0' } : entry));
    assert.throws(() => read([...drifted, ...newerIndirect]),
      new RegExp(`expected (?:exactly one|only) installed ${name.replace('/', '\\/')}@1\\.0\\.4, found 1\\.1\\.0`));
    const forged = direct.map((entry) => (entry.name === name ? { ...entry, integrity: `sha512-${'D'.repeat(86)}==` } : entry));
    assert.throws(() => read([...forged, ...newerIndirect]), /with integrity sha512-D+==, bun\.lock records/);
  }
  assert.throws(() => read(direct.filter((entry) => entry.name !== '@earendil-works/chord')),
    /expected only installed @earendil-works\/chord@1\.0\.4, found none/);
  // A direct copy without a recorded npm integrity is left for the content proof.
  const withoutIntegrity = direct.map((entry) => (entry.name === '@earendil-works/pi-ai' ? { ...entry, integrity: undefined } : entry));
  assert.deepEqual(read(withoutIntegrity).unproven, [{ key: 'node_modules/@earendil-works/pi-ai', name: '@earendil-works/pi-ai' }]);
  // The retired fork scope is refused wherever it appears.
  assert.throws(() => read([...direct, { name: '@byok-sdk/pi-tui', version: '0.85.1' }]), /the retired Pi fork is installed/);
});
