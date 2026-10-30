import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const releaseRepository = 'Ancienttwo/byok-sdk';
const digest = (algorithm, bytes, encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const archiveLimit = 512 * 1024 * 1024;
const positiveId = value => Number.isSafeInteger(value) && value > 0;

export function validateReleaseRequest(request) {
  if (!/^[a-f0-9]{40}$/.test(request.sourceSha ?? '') || !positiveId(request.runId)
    || !positiveId(request.artifactId) || !/^sha256:[a-f0-9]{64}$/.test(request.artifactDigest ?? '')) {
    throw new Error('Release evidence requires the exact source SHA, CI run ID, artifact ID and sha256 artifact digest');
  }
}

/** GitHub API metadata, not a local receipt, owns the accepted build identity. */
export function verifyReleaseIdentity(run, workflow, artifact, request) {
  validateReleaseRequest(request);
  if (!positiveId(workflow.id) || workflow.path !== '.github/workflows/ci.yml'
    || run.workflow_id !== workflow.id || run.path !== workflow.path || run.id !== request.runId
    || run.head_sha !== request.sourceSha || !/^(main|release\/.+)$/.test(run.head_branch ?? '')
    || run.event !== 'workflow_dispatch' || run.status !== 'completed' || run.conclusion !== 'success'
    || run.repository?.full_name !== releaseRepository || run.head_repository?.full_name !== releaseRepository
    || !positiveId(run.repository?.id) || run.repository.id !== run.head_repository?.id) {
    throw new Error('Release CI must be a successful ci.yml workflow_dispatch for this exact source on main or release/*');
  }
  if (artifact.id !== request.artifactId || artifact.name !== `release-pack-${request.sourceSha}`
    || artifact.expired !== false || artifact.digest !== request.artifactDigest
    || artifact.workflow_run?.id !== request.runId || artifact.workflow_run?.head_sha !== request.sourceSha
    || artifact.workflow_run?.head_branch !== run.head_branch
    || artifact.workflow_run?.repository_id !== run.repository.id
    || artifact.workflow_run?.head_repository_id !== run.repository.id) {
    throw new Error('Release artifact identity/digest does not belong to the accepted CI run');
  }
}

/**
 * Read the flat artifact ZIP without extracting archive-controlled paths or links.
 * GitHub upload-artifact emits ZIP32 stored/deflated entries; other formats fail closed.
 */
export function readReleaseZip(archive) {
  if (!Buffer.isBuffer(archive) || archive.length < 22 || archive.length > archiveLimit) throw new Error('Invalid release ZIP size');
  let end = archive.length - 22;
  for (; end >= Math.max(0, archive.length - 65557); end -= 1) {
    if (archive.readUInt32LE(end) === 0x06054b50 && end + 22 + archive.readUInt16LE(end + 20) === archive.length) break;
  }
  if (end < Math.max(0, archive.length - 65557)) throw new Error('Missing release ZIP directory');
  const count = archive.readUInt16LE(end + 10);
  const offset = archive.readUInt32LE(end + 16);
  if (archive.readUInt16LE(end + 4) !== 0 || archive.readUInt16LE(end + 6) !== 0
    || count === 0 || count > 128 || archive.readUInt16LE(end + 8) !== count
    || offset + archive.readUInt32LE(end + 12) !== end) throw new Error('Unsupported release ZIP directory');
  const files = new Map();
  let cursor = offset;
  let expanded = 0;
  const ranges = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid release ZIP entry');
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameSize = archive.readUInt16LE(cursor + 28);
    const next = cursor + 46 + nameSize + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
    const mode = (archive.readUInt32LE(cursor + 38) >>> 16) & 0xf000;
    const local = archive.readUInt32LE(cursor + 42);
    if (next > end || archive.readUInt16LE(cursor + 34) !== 0 || (flags & ~0x0808) !== 0
      || ![0, 8].includes(method) || ![0, 0x8000].includes(mode) || size === 0
      || size > 256 * 1024 * 1024 || (expanded += size) > archiveLimit) throw new Error('Unsupported release ZIP entry');
    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameSize);
    const name = nameBytes.toString('utf8');
    if (!/^(release-manifest\.json|[a-z0-9][a-z0-9._-]*\.tgz)$/.test(name)
      || !nameBytes.equals(Buffer.from(name)) || files.has(name)) throw new Error('Unsafe or duplicate release ZIP filename');
    if (local + 30 > offset || archive.readUInt32LE(local) !== 0x04034b50
      || archive.readUInt16LE(local + 6) !== flags || archive.readUInt16LE(local + 8) !== method
      || archive.readUInt16LE(local + 26) !== nameSize) throw new Error('Invalid release ZIP local entry');
    const start = local + 30 + nameSize + archive.readUInt16LE(local + 28);
    if (start + compressedSize > offset || !archive.subarray(local + 30, local + 30 + nameSize).equals(nameBytes)
      || ranges.some(([a, b]) => local < b && start + compressedSize > a)) throw new Error('Overlapping or truncated release ZIP entry');
    ranges.push([local, start + compressedSize]);
    const data = archive.subarray(start, start + compressedSize);
    const bytes = method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: size });
    if (bytes.length !== size) throw new Error('Release ZIP expanded size mismatch');
    files.set(name, bytes);
    cursor = next;
  }
  if (cursor !== end) throw new Error('Invalid release ZIP directory length');
  return files;
}

export function verifyReleaseArchive(archive, request) {
  validateReleaseRequest(request);
  // Authenticate all ZIP bytes before parsing any archive-controlled metadata.
  if (`sha256:${digest('sha256', archive)}` !== request.artifactDigest) throw new Error('Release artifact archive digest mismatch');
  const files = readReleaseZip(archive);
  const manifestBytes = files.get('release-manifest.json');
  if (!manifestBytes || manifestBytes.length > 1024 * 1024) throw new Error('Missing or oversized release manifest');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schemaVersion !== 3 || manifest.sourceGitSha !== request.sourceSha
    || typeof manifest.releaseVersion !== 'string' || !Array.isArray(manifest.packages) || manifest.packages.length === 0) {
    throw new Error('Release manifest identity/schema mismatch');
  }
  const names = new Set();
  const filenames = new Set(['release-manifest.json']);
  for (const entry of manifest.packages) {
    if (typeof entry.package !== 'string' || !entry.package.startsWith('@byok-sdk/') || names.has(entry.package)
      || entry.version !== manifest.releaseVersion || typeof entry.file !== 'string'
      || !/^[a-z0-9][a-z0-9._-]*\.tgz$/.test(entry.file) || filenames.has(entry.file)) {
      throw new Error('Unsafe or duplicate release manifest package/file');
    }
    names.add(entry.package);
    filenames.add(entry.file);
    const bytes = files.get(entry.file);
    if (!bytes || digest('sha256', bytes) !== entry.sha256
      || `sha512-${digest('sha512', bytes, 'base64')}` !== entry.sha512Integrity) {
      throw new Error(`Release tarball integrity mismatch: ${entry.package}`);
    }
  }
  if (files.size !== filenames.size) throw new Error('Release ZIP has unlisted tarballs');
  return { files, manifest, manifestSha256: digest('sha256', manifestBytes) };
}

function githubApi(endpoint) {
  return execFileSync('gh', ['api', `repos/${releaseRepository}/${endpoint}`], { maxBuffer: archiveLimit });
}

/** Always re-query GitHub and download the authenticated archive in this process. */
export function fetchReleaseArtifact(request, api = githubApi) {
  validateReleaseRequest(request);
  const workflow = JSON.parse(api('actions/workflows/ci.yml'));
  const run = JSON.parse(api(`actions/runs/${request.runId}`));
  const artifact = JSON.parse(api(`actions/artifacts/${request.artifactId}`));
  verifyReleaseIdentity(run, workflow, artifact, request);
  const verified = verifyReleaseArchive(api(`actions/artifacts/${request.artifactId}/zip`), request);
  return {
    ...verified,
    evidence: { repository: releaseRepository, sourceSha: request.sourceSha, runId: request.runId,
      runAttempt: run.run_attempt, branch: run.head_branch, event: run.event, workflow: run.path,
      conclusion: run.conclusion, artifactId: request.artifactId, artifactDigest: request.artifactDigest,
      manifestSha256: verified.manifestSha256 },
  };
}
