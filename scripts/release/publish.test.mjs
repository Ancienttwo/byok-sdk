import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertRegistryAccountPolicy, parseArguments, verifyFrozenArtifacts } from './publish.mjs';

const publishSource = fileURLToPath(new URL('./publish.mjs', import.meta.url));

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const TRAIN = '0.14.0';

/**
 * Builds an artifact directory shaped exactly like the one pack-and-smoke writes:
 * one tarball per entry plus a release-manifest.json describing them. `mutate` edits
 * the manifest after the digests were computed, which is how every failure mode in
 * this file is produced — the bytes on disk stay honest, the manifest stops being.
 */
function fabricateArtifacts(entries, mutate = (manifest) => manifest) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'byok-publish-artifacts-'));
  const packages = entries.map(({ name, version, body, omitFile }) => {
    const file = `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
    const bytes = Buffer.from(body ?? `${name}@${version} tarball bytes`);
    if (!omitFile) writeFileSync(path.join(directory, file), bytes);
    return { package: name, version, file, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const manifest = mutate({ schemaVersion: 2, releaseVersion: TRAIN, sourceGitSha: HEAD, packages });
  writeFileSync(path.join(directory, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

function publishEntry(name, version = TRAIN) {
  return { name, version, directory: `packages/${name.split('/').pop()}`, manifest: { name, version } };
}

test('--artifacts and --out-dir are mutually exclusive and the existing flags keep their rules', () => {
  assert.deepEqual(parseArguments(['--artifacts', 'ci-pack']), {
    execute: false,
    otp: undefined,
    outDir: undefined,
    artifacts: 'ci-pack',
    tag: undefined,
  });
  assert.deepEqual(parseArguments(['--execute', '--otp', '123456', '--artifacts', 'ci-pack']), {
    execute: true,
    otp: '123456',
    outDir: undefined,
    artifacts: 'ci-pack',
    tag: undefined,
  });
  assert.throws(
    () => parseArguments(['--artifacts', 'ci-pack', '--out-dir', 'fresh']),
    /--artifacts and --out-dir are mutually exclusive/,
  );
  assert.throws(
    () => parseArguments(['--out-dir', 'fresh', '--artifacts', 'ci-pack']),
    /--artifacts and --out-dir are mutually exclusive/,
  );
  assert.throws(() => parseArguments(['--artifacts', 'a', '--artifacts', 'b']), /--artifacts may be provided only once/);
  assert.throws(() => parseArguments(['--artifacts']), /--artifacts requires a value/);
  assert.throws(() => parseArguments(['--execute', '--execute']), /--execute may be provided only once/);
  assert.throws(() => parseArguments(['--unknown']), /unknown flag --unknown/);
});

test('a frozen artifact set matching the manifest, HEAD and the publish set produces the plan', () => {
  const directory = fabricateArtifacts([
    { name: '@byok-sdk/core', version: TRAIN },
    { name: '@byok-sdk/keys', version: '0.4.0' },
  ]);
  try {
    const plan = verifyFrozenArtifacts({
      artifactsDir: directory,
      headSha: HEAD,
      trainVersion: TRAIN,
      publishSet: [publishEntry('@byok-sdk/core'), publishEntry('@byok-sdk/keys', '0.4.0')],
    });
    assert.equal(plan.length, 2);
    assert.deepEqual(plan.map((entry) => entry.name), ['@byok-sdk/core', '@byok-sdk/keys']);
    assert.equal(plan[0].file, 'byok-sdk-core-0.14.0.tgz');
    assert.equal(plan[0].version, TRAIN);
    assert.equal(plan[1].version, '0.4.0');
    for (const entry of plan) {
      const bytes = readFileSync(path.join(directory, entry.file));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an artifact for an already-published package is ignored instead of published again', () => {
  const directory = fabricateArtifacts([
    { name: '@byok-sdk/core', version: TRAIN },
    { name: '@byok-sdk/protocol', version: TRAIN },
  ]);
  try {
    const plan = verifyFrozenArtifacts({
      artifactsDir: directory,
      headSha: HEAD,
      trainVersion: TRAIN,
      publishSet: [publishEntry('@byok-sdk/protocol')],
    });
    assert.deepEqual(plan.map((entry) => entry.name), ['@byok-sdk/protocol']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('frozen artifacts are refused when the manifest stops describing the bytes or the commit', () => {
  const cases = [
    {
      label: 'sha256 mismatch',
      entries: [{ name: '@byok-sdk/core', version: TRAIN }],
      mutate: (manifest) => ({
        ...manifest,
        packages: manifest.packages.map((entry) => ({ ...entry, sha256: 'f'.repeat(64) })),
      }),
      publishSet: [publishEntry('@byok-sdk/core')],
      message: /@byok-sdk\/core: byok-sdk-core-0\.14\.0\.tgz hashes to sha256 [0-9a-f]{64}, the frozen manifest records f{64}/,
    },
    {
      label: 'tarball missing from the directory',
      entries: [{ name: '@byok-sdk/core', version: TRAIN, omitFile: true }],
      publishSet: [publishEntry('@byok-sdk/core')],
      message: /@byok-sdk\/core: frozen tarball is missing:/,
    },
    {
      label: 'packed from another commit',
      entries: [{ name: '@byok-sdk/core', version: TRAIN }],
      mutate: (manifest) => ({ ...manifest, sourceGitSha: 'a'.repeat(40) }),
      publishSet: [publishEntry('@byok-sdk/core')],
      message: /frozen artifacts were packed from a{40}, HEAD is 0123456789abcdef0123456789abcdef01234567/,
    },
    {
      label: 'packed for another release version',
      entries: [{ name: '@byok-sdk/core', version: TRAIN }],
      mutate: (manifest) => ({ ...manifest, releaseVersion: '0.13.0' }),
      publishSet: [publishEntry('@byok-sdk/core')],
      message: /frozen artifacts are 0\.13\.0, the manifests say 0\.14\.0/,
    },
    {
      label: 'no artifact for an unpublished package',
      entries: [{ name: '@byok-sdk/core', version: TRAIN }],
      publishSet: [publishEntry('@byok-sdk/core'), publishEntry('@byok-sdk/server')],
      message: /@byok-sdk\/server@0\.14\.0 is unpublished but the frozen artifacts contain nothing for it/,
    },
    {
      label: 'artifact version disagrees with the workspace manifest',
      entries: [{ name: '@byok-sdk/keys', version: '0.4.0' }],
      mutate: (manifest) => ({
        ...manifest,
        packages: manifest.packages.map((entry) => ({ ...entry, version: '0.3.10' })),
      }),
      publishSet: [publishEntry('@byok-sdk/keys', '0.4.0')],
      message: /@byok-sdk\/keys: frozen artifact is 0\.3\.10, the manifest says 0\.4\.0/,
    },
    {
      label: 'manifest written against another schema version',
      entries: [{ name: '@byok-sdk/core', version: TRAIN }],
      mutate: (manifest) => ({ ...manifest, schemaVersion: 1 }),
      publishSet: [publishEntry('@byok-sdk/core')],
      message: /release-manifest\.json declares schemaVersion 1; this script and scripts\/release\/registry-readback\.mjs both read schemaVersion 2/,
    },
    {
      label: 'manifest declaring no schema version at all',
      entries: [{ name: '@byok-sdk/core', version: TRAIN }],
      mutate: ({ schemaVersion, ...manifest }) => manifest,
      publishSet: [publishEntry('@byok-sdk/core')],
      message: /release-manifest\.json declares schemaVersion null; this script and scripts\/release\/registry-readback\.mjs both read schemaVersion 2/,
    },
    {
      label: 'file escaping the artifacts directory with ..',
      entries: [{ name: '@byok-sdk/core', version: TRAIN }],
      mutate: (manifest) => ({
        ...manifest,
        packages: manifest.packages.map((entry) => ({ ...entry, file: '../outside.tgz' })),
      }),
      publishSet: [publishEntry('@byok-sdk/core')],
      message: /@byok-sdk\/core: frozen artifact file must be a bare filename inside the artifacts directory, got "\.\.\/outside\.tgz"/,
    },
    {
      label: 'file reaching into a subdirectory',
      entries: [{ name: '@byok-sdk/core', version: TRAIN }],
      mutate: (manifest) => ({
        ...manifest,
        packages: manifest.packages.map((entry) => ({ ...entry, file: 'sub/inner.tgz' })),
      }),
      publishSet: [publishEntry('@byok-sdk/core')],
      message: /@byok-sdk\/core: frozen artifact file must be a bare filename inside the artifacts directory, got "sub\/inner\.tgz"/,
    },
    {
      label: 'file given as an absolute path',
      entries: [{ name: '@byok-sdk/core', version: TRAIN }],
      mutate: (manifest) => ({
        ...manifest,
        packages: manifest.packages.map((entry) => ({ ...entry, file: '/etc/outside.tgz' })),
      }),
      publishSet: [publishEntry('@byok-sdk/core')],
      message: /@byok-sdk\/core: frozen artifact file must be a bare filename inside the artifacts directory, got "\/etc\/outside\.tgz"/,
    },
  ];

  for (const { label, entries, mutate, publishSet, message } of cases) {
    const directory = fabricateArtifacts(entries, mutate);
    try {
      assert.throws(
        () => verifyFrozenArtifacts({ artifactsDir: directory, headSha: HEAD, trainVersion: TRAIN, publishSet }),
        message,
        label,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('a directory without a release manifest is refused before anything is hashed', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'byok-publish-empty-'));
  try {
    assert.throws(
      () => verifyFrozenArtifacts({
        artifactsDir: directory,
        headSha: HEAD,
        trainVersion: TRAIN,
        publishSet: [publishEntry('@byok-sdk/core')],
      }),
      /carries no release-manifest\.json/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the registry account gate requires an authenticated account with two factors on writes', () => {
  assert.doesNotThrow(() => assertRegistryAccountPolicy({
    whoami: 'byok-releaser',
    profile: { name: 'byok-releaser', tfa: { pending: false, mode: 'auth-and-writes' } },
  }));

  assert.throws(
    () => assertRegistryAccountPolicy({ whoami: '', profile: { tfa: { mode: 'auth-and-writes' } } }),
    /npm reported no authenticated account/,
  );
  assert.throws(
    () => assertRegistryAccountPolicy({ whoami: undefined, profile: { tfa: { mode: 'auth-and-writes' } } }),
    /npm reported no authenticated account/,
  );
  assert.throws(
    () => assertRegistryAccountPolicy({ whoami: 'byok-releaser', profile: { tfa: { mode: 'auth-only' } } }),
    /reports tfa\.mode "auth-only".*requires\s+tfa\.mode "auth-and-writes"/s,
  );
  assert.throws(
    () => assertRegistryAccountPolicy({ whoami: 'byok-releaser', profile: { name: 'byok-releaser' } }),
    /reports tfa\.mode null.*requires\s+tfa\.mode "auth-and-writes"/s,
  );
  assert.throws(
    () => assertRegistryAccountPolicy({ whoami: 'byok-releaser', profile: { tfa: 'auth-and-writes' } }),
    /reports tfa\.mode null.*requires\s+tfa\.mode "auth-and-writes"/s,
  );
  assert.throws(
    () => assertRegistryAccountPolicy({ whoami: 'byok-releaser', profile: null }),
    /reports tfa\.mode null.*requires\s+tfa\.mode "auth-and-writes"/s,
  );
});

test('the execute path checks the tag precondition first and creates the tag last', () => {
  // The order is the whole point of the release driver, and it is a property of the
  // source itself rather than of any value a unit test can observe: nothing may run
  // before the tag-exists precondition, and the annotated tag may only be created
  // after the registry has confirmed every published package.
  const source = readFileSync(publishSource, 'utf8');
  const tagPrecondition = source.indexOf('refs/tags/');
  const firstPublish = source.indexOf("'publish',");
  const readback = source.indexOf("'scripts/release/registry-readback.mjs'");
  const createTag = source.indexOf("['tag', '-a'");
  const whoami = source.indexOf("'whoami'");
  const profile = source.indexOf("'profile'");

  assert.ok(tagPrecondition > 0, 'publish.mjs must check refs/tags/<tag> before releasing');
  assert.ok(firstPublish > 0, 'publish.mjs must invoke npm publish');
  assert.ok(readback > 0, 'publish.mjs must run registry-readback.mjs');
  assert.ok(createTag > 0, 'publish.mjs must create an annotated tag');
  assert.ok(whoami > 0, 'publish.mjs must ask npm who the authenticated account is');
  assert.ok(profile > 0, 'publish.mjs must read the npm account profile for its 2FA mode');

  assert.ok(tagPrecondition < whoami, 'the tag-exists precondition must precede the npm whoami check');
  assert.ok(tagPrecondition < profile, 'the tag-exists precondition must precede the npm profile check');
  assert.ok(whoami < firstPublish, 'the npm whoami check must precede the first publish');
  assert.ok(profile < firstPublish, 'the npm profile check must precede the first publish');
  assert.ok(tagPrecondition < firstPublish, 'the tag-exists precondition must precede the first publish');
  assert.ok(firstPublish < readback, 'npm publish must precede the registry readback');
  assert.ok(readback < createTag, 'the registry readback must precede git tag -a');
});
