import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  exactReleaseVersion,
  exactStableVersion,
  isPrereleaseVersion,
  assertNoPartialPrereleaseRegistryState,
  readPublicManifests,
  resolveReleaseDistTag,
} from './publish.mjs';

const releaseDirectory = fileURLToPath(new URL('.', import.meta.url));

test('release tooling accepts an exact prerelease and retains Pi stable-pin semantics', () => {
  assert.equal(exactReleaseVersion.test('0.8.0-beta.0'), true);
  assert.equal(exactReleaseVersion.test('0.8.0-01'), false);
  assert.equal(exactReleaseVersion.test('0.8'), false);
  assert.equal(exactStableVersion.test('0.84.2'), true);
  assert.equal(exactStableVersion.test('0.84.2-beta.0'), false);
  assert.equal(isPrereleaseVersion('0.8.0-beta.0'), true);
  assert.equal(isPrereleaseVersion('0.8.0+build.7'), false);
});

test('prerelease channel requires a safe non-latest tag and stable releases retain their default', () => {
  assert.equal(resolveReleaseDistTag('0.8.0-beta.0', 'beta'), 'beta');
  assert.equal(resolveReleaseDistTag('0.8.0', undefined), undefined);
  assert.throws(() => resolveReleaseDistTag('0.8.0-beta.0', undefined), /requires a npm-safe non-latest --tag/);
  assert.throws(() => resolveReleaseDistTag('0.8.0-beta.0', 'latest'), /requires a npm-safe non-latest --tag/);
  assert.throws(() => resolveReleaseDistTag('0.8.0-beta.0', 'Beta'), /requires a npm-safe non-latest --tag/);
  assert.throws(() => resolveReleaseDistTag('0.8.0', 'beta'), /stable release .* must not set --tag/);
});

test('beta releases reject partial registry state while stable releases retain resumable behavior', () => {
  const entries = [{ name: '@byok-sdk/core' }, { name: '@byok-sdk/keys' }];
  const partial = new Map([['@byok-sdk/core', true], ['@byok-sdk/keys', false]]);
  assert.throws(
    () => assertNoPartialPrereleaseRegistryState(entries, partial, 'beta'),
    /partially published.*refuse automatic continuation/,
  );
  assert.doesNotThrow(() => assertNoPartialPrereleaseRegistryState(entries, partial, undefined));
});

test('publish and readback reject a missing or latest prerelease tag before registry I/O', () => {
  // Both drivers take the release version from the repo manifests, so the
  // missing/latest-tag rejection runs against an isolated prerelease train
  // instead of whatever version the repo itself currently carries.
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'byok-beta-tag-gate-'));
  try {
    const fixtureScripts = path.join(fixtureRoot, 'scripts', 'release');
    mkdirSync(fixtureScripts, { recursive: true });
    for (const entry of readdirSync(releaseDirectory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.mjs')) {
        copyFileSync(path.join(releaseDirectory, entry.name), path.join(fixtureScripts, entry.name));
      }
    }
    for (const [name, version] of [['core', '0.8.0-beta.0'], ['keys', '0.3.0'], ['client', '0.8.0-beta.0']]) {
      const fixturePackage = path.join(fixtureRoot, 'packages', name);
      mkdirSync(fixturePackage, { recursive: true });
      const manifest = { name: `@byok-sdk/${name}`, version };
      if (name === 'client') manifest.dependencies = { '@earendil-works/pi-coding-agent': '0.84.2' };
      writeFileSync(path.join(fixturePackage, 'package.json'), `${JSON.stringify(manifest)}\n`);
    }

    const publishMissingTag = spawnSync(process.execPath, ['scripts/release/publish.mjs'], {
      cwd: fixtureRoot,
      encoding: 'utf8',
    });
    assert.notEqual(publishMissingTag.status, 0);
    assert.match(publishMissingTag.stderr, /requires a npm-safe non-latest --tag/);

    const readbackLatestTag = spawnSync(
      process.execPath,
      ['scripts/release/registry-readback.mjs', '--manifest', '/definitely/not/a/manifest.json', '--tag', 'latest'],
      { cwd: fixtureRoot, encoding: 'utf8' },
    );
    assert.notEqual(readbackLatestTag.status, 0);
    assert.match(readbackLatestTag.stderr, /requires a npm-safe non-latest --tag/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('publish manifest reader admits prerelease package identities exactly', () => {
  const packagesDirectory = mkdtempSync(path.join(os.tmpdir(), 'byok-beta-release-test-'));
  try {
    const packageDirectory = path.join(packagesDirectory, 'core');
    mkdirSync(packageDirectory);
    writeFileSync(
      path.join(packageDirectory, 'package.json'),
      `${JSON.stringify({ name: '@byok-sdk/core', version: '0.8.0-beta.0' })}\n`,
    );
    const manifests = readPublicManifests(packagesDirectory);
    assert.deepEqual(manifests.get('@byok-sdk/core')?.version, '0.8.0-beta.0');
  } finally {
    rmSync(packagesDirectory, { recursive: true, force: true });
  }
});

test('graph and readback use the same prerelease gate and readback checks a requested dist-tag', () => {
  const graphSource = readFileSync(path.join(releaseDirectory, 'check-package-graph.mjs'), 'utf8');
  const readbackSource = readFileSync(path.join(releaseDirectory, 'registry-readback.mjs'), 'utf8');
  assert.match(graphSource, /exactReleaseVersion\.test\(releaseVersion\)/);
  assert.match(graphSource, /exactStableVersion\.test\(piVersion\)/);
  assert.match(graphSource, /const testkit = \['packages\/testkit', '@byok-sdk\/testkit'\]/);
  assert.match(readbackSource, /const distTag = resolveReleaseDistTag\(expectedVersion, requestedTag\)/);
  assert.match(readbackSource, /'dist-tags', '--json'/);
  assert.match(readbackSource, /distTags\[distTag\] !== packageVersion/);
  assert.match(readbackSource, /packages\.map\(\(packageName\) => \[packageName, packageName === '@byok-sdk\/keys' \? '0\.3\.0' : '0\.7\.0'\]\)/);
  assert.match(readbackSource, /distTags\.latest !== expectedLatestVersion/);
});
