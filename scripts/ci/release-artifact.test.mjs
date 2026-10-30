import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { fetchReleaseArtifact, readReleaseZip, releaseRepository, validateReleaseRequest, verifyReleaseArchive, verifyReleaseIdentity } from './release-artifact.mjs';

const sha = 'a'.repeat(40);
const hash = (algorithm, bytes, encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const workflow = { id: 123, path: '.github/workflows/ci.yml' };
const run = { id: 456, workflow_id: workflow.id, path: workflow.path, head_sha: sha, head_branch: 'main',
  event: 'workflow_dispatch', status: 'completed', conclusion: 'success', run_attempt: 2,
  repository: { id: 42, full_name: releaseRepository }, head_repository: { id: 42, full_name: releaseRepository } };

function zip(entries, { method = 8, mode = 0x8000 } = {}) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const nameBytes = Buffer.from(name);
    const compressed = method === 8 ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(mode * 65536, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function fixture(mutate = manifest => manifest, mutateFiles = files => files) {
  const bytes = Buffer.from('exact CI package bytes');
  const manifest = mutate({ schemaVersion: 3, releaseVersion: '0.32.0', sourceGitSha: sha,
    packages: [{ package: '@byok-sdk/core', version: '0.32.0', file: 'core.tgz',
      sha256: hash('sha256', bytes), sha512Integrity: `sha512-${hash('sha512', bytes, 'base64')}` }] });
  const archive = zip(mutateFiles([['release-manifest.json', Buffer.from(JSON.stringify(manifest))], ['core.tgz', bytes]]));
  const request = { sourceSha: sha, runId: run.id, artifactId: 789, artifactDigest: `sha256:${hash('sha256', archive)}` };
  const artifact = { id: request.artifactId, name: `release-pack-${sha}`, expired: false, digest: request.artifactDigest,
    workflow_run: { id: run.id, head_sha: sha, head_branch: 'main', repository_id: 42, head_repository_id: 42 } };
  return { archive, request, artifact, manifest, bytes };
}

test('CI acceptance binds the repository, exact workflow/run/source/event and artifact identity', () => {
  const { request, artifact } = fixture();
  assert.doesNotThrow(() => verifyReleaseIdentity(run, workflow, artifact, request));
  assert.doesNotThrow(() => verifyReleaseIdentity({ ...run, head_branch: 'release/0.32' }, workflow,
    { ...artifact, workflow_run: { ...artifact.workflow_run, head_branch: 'release/0.32' } }, request));
  for (const mutation of [
    { id: 1 }, { workflow_id: 1 }, { path: '.github/workflows/other.yml' }, { head_sha: 'b'.repeat(40) },
    { head_branch: 'feature/x' }, { head_branch: 'release/' }, { event: 'push' }, { event: 'pull_request' },
    { event: 'schedule' }, { status: 'in_progress' }, { conclusion: 'failure' }, { conclusion: 'cancelled' },
    { conclusion: 'skipped' }, { repository: { id: 42, full_name: 'other/repo' } },
    { head_repository: { id: 43, full_name: releaseRepository } }, { head_repository: { id: 42, full_name: 'fork/repo' } },
  ]) assert.throws(() => verifyReleaseIdentity({ ...run, ...mutation }, workflow, artifact, request), /Release CI/);
  for (const mutation of [{ id: 1 }, { path: '.github/workflows/fake.yml' }]) {
    assert.throws(() => verifyReleaseIdentity(run, { ...workflow, ...mutation }, artifact, request), /Release CI/);
  }
  for (const mutation of [{ id: 1 }, { name: 'other' }, { expired: true }, { digest: `sha256:${'b'.repeat(64)}` }]) {
    assert.throws(() => verifyReleaseIdentity(run, workflow, { ...artifact, ...mutation }, request), /artifact identity/);
  }
  for (const mutation of [{ id: 1 }, { head_sha: 'b'.repeat(40) }, { head_branch: 'release/other' },
    { repository_id: 1 }, { head_repository_id: 1 }]) {
    assert.throws(() => verifyReleaseIdentity(run, workflow,
      { ...artifact, workflow_run: { ...artifact.workflow_run, ...mutation } }, request), /artifact identity/);
  }
});

test('invalid or partial evidence fails before a GitHub API request', () => {
  const { request } = fixture();
  for (const mutation of [{ sourceSha: 'short' }, { runId: 0 }, { runId: '456' }, { artifactId: -1 },
    { artifactId: Number.MAX_SAFE_INTEGER + 1 }, { artifactDigest: 'sha256:bad' }, { artifactDigest: undefined }]) {
    assert.throws(() => fetchReleaseArtifact({ ...request, ...mutation }, () => assert.fail('API called')), /Release evidence requires/);
  }
  assert.doesNotThrow(() => validateReleaseRequest(request));
});

test('downloader verifies live metadata then returns only authenticated CI bytes and evidence', () => {
  const f = fixture();
  const calls = [];
  const api = endpoint => {
    calls.push(endpoint);
    return endpoint === 'actions/workflows/ci.yml' ? JSON.stringify(workflow)
      : endpoint === `actions/runs/${run.id}` ? JSON.stringify(run)
      : endpoint === `actions/artifacts/${f.request.artifactId}` ? JSON.stringify(f.artifact)
      : endpoint === `actions/artifacts/${f.request.artifactId}/zip` ? f.archive : assert.fail(endpoint);
  };
  const verified = fetchReleaseArtifact(f.request, api);
  assert.deepEqual(calls, ['actions/workflows/ci.yml', 'actions/runs/456', 'actions/artifacts/789', 'actions/artifacts/789/zip']);
  assert.deepEqual(verified.files.get('core.tgz'), f.bytes);
  assert.equal(verified.evidence.repository, releaseRepository);
  assert.equal(verified.evidence.sourceSha, sha);
  assert.equal(verified.evidence.artifactDigest, f.request.artifactDigest);
  assert.equal(verified.evidence.manifestSha256, hash('sha256', verified.files.get('release-manifest.json')));
  assert.equal(verified.evidence.runAttempt, 2);
  // A forged local receipt is neither an API response nor a valid archive.
  assert.throws(() => fetchReleaseArtifact(f.request, endpoint => endpoint.endsWith('/zip')
    ? Buffer.from(JSON.stringify(verified.evidence)) : api(endpoint)), /archive digest/);
  assert.throws(() => fetchReleaseArtifact(f.request, endpoint => {
    if (endpoint.endsWith('/zip')) assert.fail('invalid run downloaded');
    return endpoint === 'actions/runs/456' ? JSON.stringify({ ...run, event: 'push' }) : api(endpoint);
  }), /Release CI/);
  assert.throws(() => fetchReleaseArtifact(f.request, () => { throw new Error('GitHub unavailable'); }), /GitHub unavailable/);
});

test('archive digest is checked before any ZIP or manifest parsing', () => {
  const { request } = fixture();
  assert.throws(() => verifyReleaseArchive(Buffer.from('replacement, not a ZIP'), request), /archive digest/);
});

test('manifest identity, every tarball hash and unique complete file set are mandatory', () => {
  for (const mutate of [
    m => ({ ...m, schemaVersion: 2 }), m => ({ ...m, sourceGitSha: 'b'.repeat(40) }),
    m => ({ ...m, packages: [] }), m => ({ ...m, packages: [m.packages[0], m.packages[0]] }),
    m => ({ ...m, packages: [{ ...m.packages[0], file: '../core.tgz' }] }),
    m => ({ ...m, packages: [{ ...m.packages[0], file: 'release-manifest.json' }] }),
    m => ({ ...m, packages: [{ ...m.packages[0], version: '0.1.0' }] }),
    m => ({ ...m, packages: [{ ...m.packages[0], sha256: 'b'.repeat(64) }] }),
    m => ({ ...m, packages: [{ ...m.packages[0], sha512Integrity: 'sha512-fake' }] }),
  ]) {
    const f = fixture(mutate);
    assert.throws(() => verifyReleaseArchive(f.archive, f.request), /manifest|integrity/);
  }
  for (const mutateFiles of [files => files.slice(1), files => files.slice(0, 1),
    files => [...files, ['extra.tgz', Buffer.from('extra')]],
    files => files.map(([name, bytes]) => [name, name === 'core.tgz' ? Buffer.from('replaced') : bytes])]) {
    const f = fixture(undefined, mutateFiles);
    assert.throws(() => verifyReleaseArchive(f.archive, f.request), /manifest|integrity|unlisted/);
  }
});

test('ZIP reader rejects paths, links, duplicate entries, inconsistent headers and truncation', () => {
  const bytes = Buffer.from('{}');
  for (const name of ['../release-manifest.json', '/tmp/core.tgz', 'sub/core.tgz', 'sub\\core.tgz', 'core.tgz\0x', 'other.json']) {
    assert.throws(() => readReleaseZip(zip([[name, bytes]])), /filename/);
  }
  assert.throws(() => readReleaseZip(zip([['core.tgz', bytes]], { mode: 0xa000 })), /Unsupported/);
  assert.throws(() => readReleaseZip(zip([['core.tgz', bytes], ['core.tgz', bytes]])), /duplicate/);
  const valid = zip([['release-manifest.json', bytes]], { method: 0 });
  assert.deepEqual(readReleaseZip(valid).get('release-manifest.json'), bytes);
  const inconsistent = Buffer.from(valid);
  inconsistent[30] = 'x'.charCodeAt(0);
  assert.throws(() => readReleaseZip(inconsistent), /truncated/);
  assert.throws(() => readReleaseZip(valid.subarray(0, -1)), /directory/);
});

test('release workflow keeps protected hosted OIDC and explicit CI identity with pinned actions', () => {
  const workflowSource = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflowSource, /environment: npm-release/);
  assert.match(workflowSource, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(workflowSource, /runs-on: ubuntu-latest/);
  assert.match(workflowSource, /id-token: write/);
  assert.match(workflowSource, /actions: read/);
  assert.match(workflowSource, /if \[ "\$GITHUB_SHA" != "\$APPROVED_SHA" \]/);
  assert.match(workflowSource, /--trusted-publishing --ci-run-id "\$CI_RUN_ID" --ci-artifact-id "\$CI_ARTIFACT_ID" --ci-artifact-digest "\$CI_ARTIFACT_DIGEST"/);
  assert.doesNotMatch(workflowSource, /source-sha|accepted-release|GITHUB_SHA:|export GITHUB_SHA|bun run build|--artifacts/);
  for (const action of workflowSource.matchAll(/uses: ([^\n]+)/g)) assert.match(action[1], /@[a-f0-9]{40}(?: |$)/);
});
