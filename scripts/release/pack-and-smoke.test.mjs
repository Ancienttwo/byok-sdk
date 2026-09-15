import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePiRuntimeIdentity, PI_DEPENDENCY_SPECIFIER, PI_FORK_UPSTREAM_COMMIT } from './pi-runtime-identity.mjs';

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
    'Pi must stay pinned through the one shared fork-alias authority',
  );
  assert.match(
    releasePackSource,
    /assertInstalledPiRuntime\(smokeDir, piRuntime, 'release-pack'\)/,
    'the isolated install must be proven to hold exactly one Pi runtime',
  );
});

test('the Pi runtime identity authority admits only an exact fork alias', () => {
  assert.deepEqual(
    parsePiRuntimeIdentity({ dependencies: { [PI_DEPENDENCY_SPECIFIER]: 'npm:@byok-sdk/pi-coding-agent@0.85.1002' } }),
    {
      specifier: PI_DEPENDENCY_SPECIFIER,
      spec: 'npm:@byok-sdk/pi-coding-agent@0.85.1002',
      packageName: '@byok-sdk/pi-coding-agent',
      version: '0.85.1002',
    },
  );
  for (const rejected of ['0.85.1', 'npm:@byok-sdk/pi-coding-agent@^0.85.1002', 'npm:@byok-sdk/pi-coding-agent@latest', 'npm:@byok-sdk/pi-coding-agent', '']) {
    assert.throws(
      () => parsePiRuntimeIdentity({ dependencies: { [PI_DEPENDENCY_SPECIFIER]: rejected } }),
      /must be pinned to an exact npm:<name>@x\.y\.z fork alias/,
      `${rejected} must be rejected`,
    );
  }
  assert.throws(() => parsePiRuntimeIdentity({ dependencies: {} }), /must be a required dependency/);
});

test('the repo pins Pi to the published fork the release gates verify', () => {
  const clientManifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../packages/client/package.json', import.meta.url)), 'utf8'),
  );
  const identity = parsePiRuntimeIdentity(clientManifest);
  assert.equal(identity.packageName, '@byok-sdk/pi-coding-agent');
  assert.equal(PI_FORK_UPSTREAM_COMMIT, 'd981de1229ef899957bbe968bc8dcda02a21f477');
  assert.equal(clientManifest.optionalDependencies?.[PI_DEPENDENCY_SPECIFIER], undefined);
});
