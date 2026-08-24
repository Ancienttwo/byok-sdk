import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
    /exactStableVersion\.test\(piVersion\)/,
    'Pi must stay pinned to an exact stable version',
  );
});
