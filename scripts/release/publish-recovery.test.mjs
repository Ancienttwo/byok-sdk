import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertPublishedMatchFrozen,
  assertTrustedPublishingEnvironment,
  describeReleasePlan,
  parseArguments,
  publishLandedDelaysMs,
  publishPlan,
  readbackRetryDelaysMs,
  registryVisibilityDelaysMs,
  readbackWithRetry,
  waitForRegistryVisibility,
} from './publish.mjs';

const TRAIN = '0.14.0';

function planEntry(name, version = TRAIN) {
  const slug = name.replace('@', '').replace('/', '-');
  return { name, version, file: `${slug}-${version}.tgz`, sha256: 'a'.repeat(64), sha512Integrity: `sha512-${slug}` };
}

/**
 * An in-memory registry with npm's two failure shapes this driver has to survive:
 * a write that is accepted but stays invisible (E404) for `lagReads` reads, and a
 * write whose client reports failure although the upload landed. `failOn` makes the
 * named package's upload fail; `landsAnyway` decides whether that failed upload was
 * stored. `uploads` records every upload attempt, so a test can prove nothing is
 * uploaded twice.
 */
function fakeRegistry({ lagReads = 0, failOn = new Set(), landsAnyway = false, preloaded = [] } = {}) {
  const stored = new Map(preloaded.map(([key, integrity]) => [key, { integrity, hiddenReads: 0 }]));
  const uploads = [];
  const read = (name, version) => {
    const record = stored.get(`${name}@${version}`);
    if (!record) return undefined;
    if (record.hiddenReads > 0) {
      record.hiddenReads -= 1;
      return undefined;
    }
    return record.integrity;
  };
  return {
    uploads,
    failOn,
    readIntegrity: (entry) => read(entry.name, entry.version),
    isPublished: (name, version) => read(name, version) !== undefined,
    publishTarball(entry) {
      uploads.push(entry.name);
      if (failOn.has(entry.name)) {
        if (landsAnyway) stored.set(`${entry.name}@${entry.version}`, { integrity: entry.sha512Integrity, hiddenReads: lagReads });
        throw new Error(`npm publish ${entry.file} failed (1)`);
      }
      stored.set(`${entry.name}@${entry.version}`, { integrity: entry.sha512Integrity, hiddenReads: lagReads });
    },
  };
}

function recorder() {
  const slept = [];
  const lines = [];
  return { slept, lines, sleep: async (milliseconds) => { slept.push(milliseconds); }, log: (line) => { lines.push(line); } };
}

const plan = ['@byok-sdk/core', '@byok-sdk/protocol', '@byok-sdk/cloud', '@byok-sdk/server'].map((name) => planEntry(name));

test('--dry-run, --execute and --trusted-publishing parse into one explicit mode', () => {
  assert.deepEqual(parseArguments(['--dry-run', '--artifacts', 'ci-pack']), {
    execute: false, otp: undefined, outDir: undefined, artifacts: 'ci-pack', tag: undefined, trustedPublishing: false,
  });
  assert.deepEqual(parseArguments(['--execute', '--trusted-publishing', '--ci-run-id', '123',
    '--ci-artifact-id', '456', '--ci-artifact-digest', `sha256:${'a'.repeat(64)}`, '--tag', 'rc']), {
    execute: true, otp: undefined, outDir: undefined, artifacts: undefined, tag: 'rc', trustedPublishing: true,
    ciRunId: '123', ciArtifactId: '456', ciArtifactDigest: `sha256:${'a'.repeat(64)}`,
  });
  assert.throws(() => parseArguments(['--dry-run', '--execute']), /--dry-run and --execute are mutually exclusive/);
  assert.throws(() => parseArguments(['--execute', '--dry-run']), /--dry-run and --execute are mutually exclusive/);
  assert.throws(() => parseArguments(['--dry-run', '--dry-run']), /--dry-run may be provided only once/);
  assert.throws(() => parseArguments(['--trusted-publishing', '--trusted-publishing']), /--trusted-publishing may be provided only once/);
  assert.throws(
    () => parseArguments(['--execute', '--trusted-publishing', '--otp', '123456']),
    /--otp has no meaning with --trusted-publishing/,
  );
});

test('a failed prerelease upload says it cannot resume, and a failed follow-up read keeps the npm error', async () => {
  const registry = fakeRegistry({ failOn: new Set(['@byok-sdk/core']) });
  const { sleep, log } = recorder();
  await assert.rejects(
    publishPlan({ plan, sleep, log, prerelease: true, readIntegrity: registry.readIntegrity, publishTarball: registry.publishTarball }),
    /registry\); a partially published prerelease does not resume; prepare a new exact prerelease version\nnpm publish byok-sdk-core-0\.14\.0\.tgz failed \(1\)/,
  );
  let reads = 0;
  await assert.rejects(
    publishPlan({
      plan,
      sleep,
      log,
      publishTarball: registry.publishTarball,
      readIntegrity: (entry) => {
        reads += 1;
        if (reads > 1) throw new Error('npm view @byok-sdk/core@0.14.0 failed (1, ETIMEDOUT)');
        return registry.readIntegrity(entry);
      },
    }),
    /npm publish failed and the registry read that followed failed too \(npm view @byok-sdk\/core@0\.14\.0 failed \(1, ETIMEDOUT\)\)\nnpm publish byok-sdk-core-0\.14\.0\.tgz failed \(1\)/,
  );
});

test('the trusted-publishing gate and the empty-plan branch both sit before the first publish', () => {
  const source = readFileSync(fileURLToPath(new URL('./publish.mjs', import.meta.url)), 'utf8');
  const main = source.indexOf('async function main()');
  const trustedGate = source.indexOf('assertTrustedPublishingEnvironment({\n', main);
  const emptyPlanGate = source.indexOf('registry auth gate skipped', main);
  const firstPublish = source.indexOf("'publish',", main);
  const readback = source.indexOf("'scripts/release/registry-readback.mjs'", main);
  const createTag = source.indexOf("['tag', '-a'", main);
  assert.ok(main > 0 && trustedGate > main && emptyPlanGate > main, 'main() calls the trusted-publishing gate and names the empty-plan branch');
  assert.ok(trustedGate < firstPublish, 'the trusted-publishing gate must precede the first publish');
  assert.ok(emptyPlanGate < firstPublish, 'the empty-plan branch is decided before the first publish');
  assert.ok(firstPublish < readback && readback < createTag, 'an empty plan still reaches the tag only through the readback');
});

test('a clean run publishes the plan once, in order', async () => {
  const registry = fakeRegistry();
  const { sleep, log, slept } = recorder();
  const outcome = await publishPlan({ plan, sleep, log, readIntegrity: registry.readIntegrity, publishTarball: registry.publishTarball });
  assert.deepEqual(registry.uploads, plan.map((entry) => entry.name));
  assert.deepEqual(outcome, { published: plan.map((entry) => entry.name), skipped: [] });
  assert.deepEqual(slept, []);
});

test('a mid-run failure stops at that package and the re-run resumes there without re-uploading', async () => {
  const failing = fakeRegistry({ failOn: new Set(['@byok-sdk/cloud']) });
  const first = recorder();
  await assert.rejects(
    publishPlan({ plan, ...first, readIntegrity: failing.readIntegrity, publishTarball: failing.publishTarball }),
    /@byok-sdk\/cloud@0\.14\.0: npm publish failed and the registry does not hold this version \(2 of 4 planned package\(s\) are on the registry\); re-run the same command to resume from @byok-sdk\/cloud\nnpm publish byok-sdk-cloud-0\.14\.0\.tgz failed \(1\)/,
  );
  assert.deepEqual(failing.uploads, ['@byok-sdk/core', '@byok-sdk/protocol', '@byok-sdk/cloud']);
  // Before giving up, the driver looked for an upload that landed on the bounded schedule.
  assert.deepEqual(first.slept, [...publishLandedDelaysMs]);

  // The re-run meets the same registry with the transient failure gone.
  failing.failOn.delete('@byok-sdk/cloud');
  const second = recorder();
  const outcome = await publishPlan({ plan, ...second, readIntegrity: failing.readIntegrity, publishTarball: failing.publishTarball });
  assert.deepEqual(failing.uploads, ['@byok-sdk/core', '@byok-sdk/protocol', '@byok-sdk/cloud', '@byok-sdk/cloud', '@byok-sdk/server']);
  assert.deepEqual(outcome, { published: ['@byok-sdk/cloud', '@byok-sdk/server'], skipped: ['@byok-sdk/core', '@byok-sdk/protocol'] });
  assert.deepEqual(second.slept, []);
  assert.ok(second.lines.includes('skipped @byok-sdk/core@0.14.0: already on the registry with the frozen integrity'));
});

test('a failed upload that landed anyway is accepted on the frozen integrity after the registry shows it', async () => {
  const registry = fakeRegistry({ failOn: new Set(['@byok-sdk/protocol']), landsAnyway: true, lagReads: 2 });
  const { sleep, log, slept, lines } = recorder();
  const outcome = await publishPlan({ plan, sleep, log, readIntegrity: registry.readIntegrity, publishTarball: registry.publishTarball });
  assert.deepEqual(registry.uploads, plan.map((entry) => entry.name), 'no package is uploaded twice');
  assert.deepEqual(outcome.published, plan.map((entry) => entry.name));
  assert.deepEqual(slept, publishLandedDelaysMs.slice(0, 2), 'two E404 reads, then the landed version');
  assert.ok(lines.includes('@byok-sdk/protocol@0.14.0: npm publish reported a failure, but the registry holds the frozen bytes'));
});

test('registry bytes that are not the frozen tarball abort before any further upload', async () => {
  const registry = fakeRegistry({ preloaded: [['@byok-sdk/protocol@0.14.0', 'sha512-someone-else']] });
  const { sleep, log } = recorder();
  await assert.rejects(
    publishPlan({ plan, sleep, log, readIntegrity: registry.readIntegrity, publishTarball: registry.publishTarball }),
    /@byok-sdk\/protocol@0\.14\.0: the registry holds integrity "sha512-someone-else", the frozen artifact is sha512-byok-sdk-protocol — these are not the frozen bytes/,
  );
  assert.deepEqual(registry.uploads, ['@byok-sdk/core']);

  const landedWrong = fakeRegistry({ failOn: new Set(['@byok-sdk/core']), landsAnyway: true });
  const original = landedWrong.publishTarball;
  landedWrong.publishTarball = (entry) => original({ ...entry, sha512Integrity: 'sha512-tampered' });
  await assert.rejects(
    publishPlan({ plan, sleep, log, readIntegrity: landedWrong.readIntegrity, publishTarball: landedWrong.publishTarball }),
    /@byok-sdk\/core@0\.14\.0: the registry holds integrity "sha512-tampered"/,
  );
  assert.deepEqual(landedWrong.uploads, ['@byok-sdk/core']);
});

test('a package counts as already released only when the registry holds its frozen bytes', async () => {
  const frozenManifest = { packages: plan.map((entry) => ({ package: entry.name, version: entry.version, sha512Integrity: entry.sha512Integrity })) };
  const published = plan.slice(0, 2);
  const matching = fakeRegistry({ preloaded: published.map((entry) => [`${entry.name}@${entry.version}`, entry.sha512Integrity]) });
  const { sleep, slept } = recorder();
  await assertPublishedMatchFrozen({ entries: published, frozenManifest, readIntegrity: matching.readIntegrity, sleep });
  assert.deepEqual(slept, []);

  // An unbumped train: the registry holds another build of the same version.
  const otherBuild = fakeRegistry({ preloaded: [['@byok-sdk/core@0.14.0', 'sha512-released-build']] });
  await assert.rejects(
    assertPublishedMatchFrozen({ entries: [plan[0]], frozenManifest, readIntegrity: otherBuild.readIntegrity, sleep }),
    /@byok-sdk\/core@0\.14\.0: the registry holds integrity "sha512-released-build", the frozen artifact is sha512-byok-sdk-core — these are not the frozen bytes/,
  );
  await assert.rejects(
    assertPublishedMatchFrozen({ entries: [planEntry('@byok-sdk/keys', '0.4.0')], frozenManifest, readIntegrity: matching.readIntegrity, sleep }),
    /@byok-sdk\/keys@0\.4\.0 is on the registry but the frozen artifacts carry no 0\.4\.0 entry for it/,
  );
  const vanished = fakeRegistry();
  const waits = recorder();
  await assert.rejects(
    assertPublishedMatchFrozen({ entries: [plan[0]], frozenManifest, readIntegrity: vanished.readIntegrity, sleep: waits.sleep }),
    /stopped serving a version it reported as published/,
  );
  assert.deepEqual(waits.slept, [...publishLandedDelaysMs]);
});

test('the readback waits out E404 propagation lag on the backoff schedule', async () => {
  const registry = fakeRegistry({ lagReads: 3 });
  for (const entry of plan) registry.publishTarball(entry);
  const { sleep, log, slept, lines } = recorder();
  const probes = await waitForRegistryVisibility({ entries: plan, isPublished: registry.isPublished, sleep, log });
  assert.equal(probes, 4);
  assert.deepEqual(slept, registryVisibilityDelaysMs.slice(0, 3));
  assert.match(lines[0], /^waiting 5s for registry propagation of @byok-sdk\/core@0\.14\.0, @byok-sdk\/protocol@0\.14\.0/);
});

test('a version that never becomes visible fails the readback and names the resume path', async () => {
  const registry = fakeRegistry();
  for (const entry of plan.slice(0, 3)) registry.publishTarball(entry);
  const { sleep, log, slept } = recorder();
  await assert.rejects(
    waitForRegistryVisibility({ entries: plan, isPublished: registry.isPublished, sleep, log }),
    new RegExp(
      `the registry still answers E404 for @byok-sdk/server@0\\.14\\.0 after ${registryVisibilityDelaysMs.length + 1} probe\\(s\\); ` +
        'nothing was tagged — re-run the same command later to resume from the readback',
    ),
  );
  assert.deepEqual(slept, [...registryVisibilityDelaysMs]);
});

test('the full readback is retried on its own schedule and its last failure is reported', async () => {
  let calls = 0;
  const flaky = recorder();
  const attempts = await readbackWithRetry({
    ...flaky,
    readback: () => {
      calls += 1;
      if (calls < 3) throw new Error('npm install failed (1)\nnpm error code ETARGET');
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(flaky.slept, readbackRetryDelaysMs.slice(0, 2));
  assert.equal(flaky.lines[0], 'readback attempt 1 failed (npm install failed (1)); retrying in 15s');

  const broken = recorder();
  await assert.rejects(
    readbackWithRetry({ ...broken, readback: () => { throw new Error('@byok-sdk/core: registry tarball integrity differs from frozen artifact'); } }),
    new RegExp(
      `registry readback failed after ${readbackRetryDelaysMs.length + 1} attempt\\(s\\); nothing was tagged — re-run the same command ` +
        'to resume from the readback\\n@byok-sdk/core: registry tarball integrity differs from frozen artifact',
    ),
  );
  assert.deepEqual(broken.slept, [...readbackRetryDelaysMs]);
});

test('an interrupted release converges: publish, crash, resume, wait out E404, read back', async () => {
  // One registry across both runs, as on npm: the first run's uploads persist.
  const registry = fakeRegistry({ lagReads: 1, failOn: new Set(['@byok-sdk/server']) });
  const run = recorder();
  await assert.rejects(publishPlan({ plan, ...run, readIntegrity: registry.readIntegrity, publishTarball: registry.publishTarball }), /resume from @byok-sdk\/server/);

  // The failure was transient. The re-run's step 1 probe is fooled by propagation
  // lag and keeps every package in the publish set; the per-package integrity read
  // in publishPlan sees the landed versions and skips them, so only server uploads.
  registry.failOn.clear();
  const remaining = plan.filter((entry) => !registry.isPublished(entry.name, entry.version));
  assert.deepEqual(remaining.map((entry) => entry.name), plan.map((entry) => entry.name));
  const outcome = await publishPlan({ plan: remaining, ...run, readIntegrity: registry.readIntegrity, publishTarball: registry.publishTarball });
  assert.deepEqual(outcome, { published: ['@byok-sdk/server'], skipped: ['@byok-sdk/core', '@byok-sdk/protocol', '@byok-sdk/cloud'] });
  assert.deepEqual(registry.uploads, ['@byok-sdk/core', '@byok-sdk/protocol', '@byok-sdk/cloud', '@byok-sdk/server', '@byok-sdk/server']);

  run.slept.length = 0;
  await waitForRegistryVisibility({ entries: plan, isPublished: registry.isPublished, ...run });
  assert.deepEqual(run.slept, [registryVisibilityDelaysMs[0]], 'the last upload is still invisible for one read');
  let readbacks = 0;
  assert.equal(await readbackWithRetry({ ...run, readback: () => { readbacks += 1; } }), 1);
  assert.equal(readbacks, 1);
});

test('the dry-run plan names every package, the auth mode, provenance, dist-tag, readback and tag', () => {
  const keys = { name: '@byok-sdk/keys', version: '0.4.0' };
  const entries = [...plan, keys];
  const registryState = new Map(entries.map((entry) => [entry.name, entry === keys]));
  const lines = describeReleasePlan({
    entries, plan, registryState, tag: 'v0.14.0', distTag: undefined, trustedPublishing: true, provenance: true,
  });
  assert.deepEqual(lines, [
    'publish 4 package(s) in this order:',
    `  1. @byok-sdk/core@0.14.0  byok-sdk-core-0.14.0.tgz  sha256:${'a'.repeat(64)}`,
    `  2. @byok-sdk/protocol@0.14.0  byok-sdk-protocol-0.14.0.tgz  sha256:${'a'.repeat(64)}`,
    `  3. @byok-sdk/cloud@0.14.0  byok-sdk-cloud-0.14.0.tgz  sha256:${'a'.repeat(64)}`,
    `  4. @byok-sdk/server@0.14.0  byok-sdk-server-0.14.0.tgz  sha256:${'a'.repeat(64)}`,
    'skip 1 package(s) already on the registry:',
    '  - @byok-sdk/keys@0.4.0',
    'auth: npm trusted publishing (GitHub Actions OIDC); no token, no OTP',
    'provenance: attached (--provenance)',
    'dist-tag: latest (npm default)',
    'readback: wait up to 195s for all 5 exact versions, then the full readback with up to 4 retries',
    'tag: annotated v0.14.0 at HEAD, created only after the readback passes',
  ]);

  const resume = describeReleasePlan({
    entries,
    plan: [],
    registryState: new Map(entries.map((entry) => [entry.name, true])),
    tag: 'v0.14.0-rc.1',
    distTag: 'rc',
    trustedPublishing: false,
    provenance: false,
  });
  assert.equal(resume[0], 'nothing to publish: every package is already on the registry; this run resumes with the readback and tag v0.14.0-rc.1');
  assert.ok(resume.includes('auth: the local npm session; tfa.mode auth-and-writes is required'));
  assert.ok(resume.includes('provenance: not attached (not a GitHub Actions run)'));
  assert.ok(resume.includes('dist-tag: rc'));
});

test('trusted publishing accepts only a GitHub-hosted OIDC job with a new enough npm and no token', () => {
  const hosted = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
  };
  for (const npmVersion of ['11.5.1', '11.19.0\n', '12.0.0']) {
    assert.doesNotThrow(() => assertTrustedPublishingEnvironment({ env: hosted, npmVersion }), npmVersion);
  }
  const refusals = [
    [{ ...hosted, GITHUB_ACTIONS: undefined }, '11.19.0', /needs a GitHub Actions run/],
    [{ ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' }, '11.19.0', /needs a GitHub-hosted runner, this runner reports RUNNER_ENVIRONMENT="self-hosted"; npm does not accept OIDC publishing from self-hosted runners/],
    [{ ...hosted, RUNNER_ENVIRONMENT: undefined }, '11.19.0', /RUNNER_ENVIRONMENT=null/],
    [{ ...hosted, ACTIONS_ID_TOKEN_REQUEST_URL: undefined }, '11.19.0', /needs `permissions: id-token: write`/],
    [{ ...hosted, ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }, '11.19.0', /needs `permissions: id-token: write`/],
    [{ ...hosted, NODE_AUTH_TOKEN: 'npm_long_lived' }, '11.19.0', /refuses a long-lived npm token in the environment \(NODE_AUTH_TOKEN\)/],
    [{ ...hosted, NPM_TOKEN: 'npm_long_lived' }, '11.19.0', /\(NPM_TOKEN\)/],
    [hosted, '11.5.0', /needs npm 11\.5\.1 or later, found "11\.5\.0"/],
    [hosted, '10.9.2', /needs npm 11\.5\.1 or later, found "10\.9\.2"/],
    [hosted, 'not-a-version', /needs npm 11\.5\.1 or later/],
    [hosted, undefined, /found null/],
  ];
  for (const [env, npmVersion, message] of refusals) {
    assert.throws(() => assertTrustedPublishingEnvironment({ env, npmVersion }), message);
  }
});
