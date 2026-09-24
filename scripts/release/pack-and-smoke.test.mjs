import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePiRuntimeIdentity, PI_DEPENDENCY_SPECIFIER, PI_RUNTIME_CLOSURE, readLockedPiClosure } from './pi-runtime-identity.mjs';

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

const PI_DIRECT = PI_RUNTIME_CLOSURE.filter((name) => name !== '@earendil-works/pi-tui');
const exactClosure = (version) => Object.fromEntries(PI_DIRECT.map((name) => [name, version]));

test('the Pi runtime identity authority admits only an exact official closure', () => {
  assert.deepEqual(parsePiRuntimeIdentity({ dependencies: exactClosure('0.87.1') }), {
    specifier: PI_DEPENDENCY_SPECIFIER,
    spec: '0.87.1',
    packageName: PI_DEPENDENCY_SPECIFIER,
    version: '0.87.1',
    closure: PI_RUNTIME_CLOSURE,
  });
  for (const rejected of ['npm:@byok-sdk/pi-coding-agent@0.86.1001', 'npm:@earendil-works/pi-coding-agent@0.87.1', '^0.87.1', '0.87', 'latest', '']) {
    assert.throws(
      () => parsePiRuntimeIdentity({ dependencies: { ...exactClosure('0.87.1'), [PI_DEPENDENCY_SPECIFIER]: rejected } }),
      /must be pinned to one exact official x\.y\.z version/,
      `${rejected} must be rejected`,
    );
  }
  assert.throws(() => parsePiRuntimeIdentity({ dependencies: {} }), /must be a required dependency/);
  assert.throws(
    () => parsePiRuntimeIdentity({ dependencies: { ...exactClosure('0.87.1'), '@earendil-works/pi-tui': '0.87.1' } }),
    /pi-tui ships native addons and must reach the install only through/,
  );
  for (const name of PI_DIRECT.slice(1)) {
    for (const drift of [undefined, '^0.87.1', '0.87.2']) {
      assert.throws(
        () => parsePiRuntimeIdentity({ dependencies: { ...exactClosure('0.87.1'), [name]: drift } }),
        new RegExp(`${name.replace('/', '\\/')} must be a required dependency pinned exactly to 0\\.87\\.1`),
      );
    }
  }
});

test('the locked closure is exact, integrity-bearing and fork-free', () => {
  const entry = (name, version, integrity = `sha512-${'A'.repeat(86)}==`) => `    "${name}": ["${name}@${version}", "", {}, "${integrity}"],\n`;
  const lock = (body) => `{\n  "lockfileVersion": 1,\n  "packages": {\n${body}  },\n}\n`;
  const identity = { version: '0.87.1' };
  const good = PI_RUNTIME_CLOSURE.map((name) => entry(name, '0.87.1')).join('');
  assert.equal(readLockedPiClosure(lock(good), identity).size, PI_RUNTIME_CLOSURE.length);
  assert.throws(() => readLockedPiClosure(lock(good + entry('pi-subagents/@earendil-works/pi-tui', '0.85.1').replace('"pi-subagents/@earendil-works/pi-tui@0.85.1"', '"@earendil-works/pi-tui@0.85.1"')), identity),
    /resolves to @earendil-works\/pi-tui@0\.85\.1, but the Pi closure is pinned to 0\.87\.1/);
  assert.throws(() => readLockedPiClosure(lock(good + `    "@earendil-works/pi-agent-core": ["@byok-sdk/pi-agent-core@0.86.1001", "", {}, "sha512-${'B'.repeat(86)}=="],\n`), identity),
    /retired fork/);
  assert.throws(() => readLockedPiClosure(lock(good.replace(`sha512-${'A'.repeat(86)}==`, '')), identity), /carries no sha512 integrity/);
  assert.throws(() => readLockedPiClosure(lock(good.replace(entry('@earendil-works/chord', '0.87.1'), '')), identity),
    /@earendil-works\/chord@0\.87\.1 is not locked/);
});

test('the repo pins the official Pi closure the release gates verify', () => {
  const clientManifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../packages/client/package.json', import.meta.url)), 'utf8'),
  );
  const identity = parsePiRuntimeIdentity(clientManifest);
  assert.equal(identity.packageName, '@earendil-works/pi-coding-agent');
  assert.equal(identity.version, '0.87.1');
  const locked = readLockedPiClosure(readFileSync(fileURLToPath(new URL('../../bun.lock', import.meta.url)), 'utf8'), identity);
  assert.equal(locked.get(PI_DEPENDENCY_SPECIFIER), 'sha512-m8ArJUtVcQMSe1lLE/Ei7vX/JV7O39sWmWBsXV2NOU70F0qCp8GubA24pT3LnwTmM6LL2xV80/h6sQg85n69ew==');
  assert.equal(clientManifest.optionalDependencies?.[PI_DEPENDENCY_SPECIFIER], undefined);
});
