import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Owner-approved 0.28.1 artifact reuse. This is not a general alternate-CI bypass.
export const acceptedRelease = Object.freeze({
  "sourceSha": "d9bb034a8b559726e3b3f8bfea8799eebf8ebecc",
  "runId": 39582733414,
  "artifactId": 12337876870,
  "artifactDigest": "sha256:1c55a417ff521072416c97f72d056be918eb3f5e7a411892253d7d8edeedf98b",
  "manifestSha256": "af7fc9a288963e3dd9331dfa17e1e3033dc7aa3969cc4c0b259f53c02ad17d6e"
});
const repo = 'Ancienttwo/byok-sdk';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function verifyAcceptedIdentity(run, artifact, sourceSha) {
  const p = acceptedRelease;
  if (sourceSha !== p.sourceSha || run.id !== p.runId || run.head_sha !== p.sourceSha
    || run.head_branch !== 'main' || run.event !== 'workflow_dispatch'
    || run.status !== 'completed' || run.conclusion !== 'success'
    || run.path !== '.github/workflows/ci.yml' || run.workflow_id !== 314973088
    || run.repository?.full_name !== repo || run.head_repository?.full_name !== repo) {
    throw new Error('Accepted release run identity or success does not match the approved source');
  }
  if (artifact.id !== p.artifactId || artifact.expired !== false
    || artifact.name !== `release-pack-${p.sourceSha}` || artifact.digest !== p.artifactDigest
    || artifact.workflow_run?.id !== p.runId || artifact.workflow_run?.head_sha !== p.sourceSha
    || artifact.workflow_run?.repository_id !== 1302582322
    || artifact.workflow_run?.head_repository_id !== 1302582322) {
    throw new Error('Accepted release artifact identity does not match the approved run');
  }
}
export function verifyAcceptedBytes(archive, manifestBytes, readTarball) {
  const p = acceptedRelease;
  if (`sha256:${sha256(archive)}` !== p.artifactDigest) throw new Error('Artifact archive digest mismatch');
  if (sha256(manifestBytes) !== p.manifestSha256) throw new Error('Accepted manifest digest mismatch');
  const m = JSON.parse(manifestBytes);
  if (m.sourceGitSha !== p.sourceSha || m.releaseVersion !== '0.28.1' || m.packages.length !== 9) throw new Error('Accepted release identity mismatch');
  for (const entry of m.packages) {
    if (!/^[a-z0-9.-]+\.tgz$/.test(entry.file)) throw new Error('Unsafe package filename');
    const bytes = readTarball(entry.file);
    if (sha256(bytes) !== entry.sha256 || `sha512:${createHash('sha512').update(bytes).digest('base64')}` !== entry.sha512Integrity.replace('sha512-', 'sha512:')) throw new Error(`Tarball integrity mismatch: ${entry.package}`);
  }
  return m;
}
async function main() {
  const sourceSha = process.env.RELEASE_SOURCE_SHA;
  const workflowSha = process.env.GITHUB_SHA;
  if (process.env.GITHUB_REPOSITORY !== repo || process.env.GITHUB_REF !== 'refs/heads/main'
    || !/^[a-f0-9]{40}$/.test(workflowSha ?? '')) throw new Error('Release must run from this repository main');
  const p = acceptedRelease;
  const api = path => execFileSync('gh', ['api', `repos/${repo}/${path}`], { maxBuffer: 64 * 1024 * 1024 });
  const run = JSON.parse(api(`actions/runs/${p.runId}`));
  const artifact = JSON.parse(api(`actions/artifacts/${p.artifactId}`));
  verifyAcceptedIdentity(run, artifact, sourceSha);
  execFileSync('git', ['merge-base', '--is-ancestor', sourceSha, workflowSha]);
  const archive = api(`actions/artifacts/${p.artifactId}/zip`);
  if (`sha256:${sha256(archive)}` !== p.artifactDigest) throw new Error('Artifact archive digest mismatch');
  const dir = join(process.env.RUNNER_TEMP, 'release-pack');
  mkdirSync(dir); // Refuse reuse of any earlier directory/partial extraction.
  const zip = join(process.env.RUNNER_TEMP, 'accepted-release.zip');
  writeFileSync(zip, archive);
  execFileSync('unzip', ['-q', zip, '-d', dir]);
  const m = verifyAcceptedBytes(archive, readFileSync(join(dir, 'release-manifest.json')), name => readFileSync(join(dir, name)));
  const evidence = { workflowSha, sourceSha, runId: p.runId, artifactId: p.artifactId,
    artifactDigest: p.artifactDigest, manifestSha256: p.manifestSha256,
    packages: m.packages, provenance: 'npm provenance identifies this release workflow; original build source and accepted CI are recorded separately here' };
  writeFileSync(join(process.env.RUNNER_TEMP, 'accepted-release-evidence.json'), JSON.stringify(evidence, null, 2));
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Accepted original release artifact\n\nSource: ${sourceSha}\n\nCI: https://github.com/${repo}/actions/runs/${p.runId}\n\nArtifact: ${p.artifactId} (${p.artifactDigest})\n\nWorkflow: ${workflowSha}\n\n${evidence.provenance}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `source-sha=${sourceSha}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
