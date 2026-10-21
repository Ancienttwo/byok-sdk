import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acceptedRelease as p, verifyAcceptedIdentity, verifyAcceptedBytes } from './accepted-release.mjs';
const run = { id:p.runId,head_sha:p.sourceSha,head_branch:'main',event:'workflow_dispatch',status:'completed',conclusion:'success',path:'.github/workflows/ci.yml',workflow_id:314973088,repository:{full_name:'Ancienttwo/byok-sdk'},head_repository:{full_name:'Ancienttwo/byok-sdk'} };
const artifact = {id:p.artifactId,name:`release-pack-${p.sourceSha}`,expired:false,digest:p.artifactDigest,workflow_run:{id:p.runId,head_sha:p.sourceSha,repository_id:1302582322,head_repository_id:1302582322}};
test('only the exact owner-approved successful CI run and artifact are accepted', () => {
  assert.doesNotThrow(()=>verifyAcceptedIdentity(run,artifact,p.sourceSha));
  assert.throws(()=>verifyAcceptedIdentity(run,artifact,'a'.repeat(40)));
  for (const mutation of [{id:1},{head_sha:'a'.repeat(40)},{head_branch:'other'},{event:'pull_request'},{status:'in_progress'},{conclusion:'failure'},{conclusion:'cancelled'},{path:'.github/workflows/other.yml'},{workflow_id:1},{repository:{full_name:'other/repo'}},{head_repository:{full_name:'other/repo'}}]) assert.throws(()=>verifyAcceptedIdentity({...run,...mutation},artifact,p.sourceSha));
  for(const mutation of [{id:1},{name:'other'},{expired:true},{digest:'sha256:bad'},{workflow_run:{...artifact.workflow_run,id:1}},{workflow_run:{...artifact.workflow_run,head_sha:'a'.repeat(40)}},{workflow_run:{...artifact.workflow_run,head_repository_id:1}}]) assert.throws(()=>verifyAcceptedIdentity(run,{...artifact,...mutation},p.sourceSha));
});
test('replacement archive is rejected before its manifest or package bytes are consumed', () => {
  let read=false;
  assert.throws(()=>verifyAcceptedBytes(Buffer.from('replacement'),Buffer.from('{}'),()=>{read=true;}),/archive digest/);
  assert.equal(read,false);
});
test('release preserves owner gate and workflow SHA while consuming verified source without rebuild', () => {
  const workflow=readFileSync(new URL('../../.github/workflows/release.yml',import.meta.url),'utf8');
  assert.match(workflow,/environment: npm-release/);
  assert.match(workflow,/if: github.ref == 'refs\/heads\/main'/);
  assert.match(workflow,/if \[ "\$GITHUB_SHA" != "\$APPROVED_SHA" \]/);
  assert.match(workflow,/node scripts\/ci\/accepted-release.mjs/);
  assert.match(workflow,/git checkout --detach "\$SOURCE_SHA"/);
  assert.ok(workflow.indexOf('node scripts/ci/accepted-release.mjs') < workflow.indexOf('git checkout --detach'));
  assert.match(workflow,/--trusted-publishing --artifacts/);
  assert.doesNotMatch(workflow,/GITHUB_SHA:|export GITHUB_SHA|bun run build|npm trust github/);
  assert.match(workflow,/provenance describes this release workflow SHA/);
});
