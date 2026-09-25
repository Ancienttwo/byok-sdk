import { fileURLToPath } from 'node:url';
import { verify as verifySigstore } from 'sigstore';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const output=fileURLToPath(new URL('../../packages/client/src/adapters/pi/official-pi-closure.json', import.meta.url));
const evidence=process.argv[2];
if (!evidence) throw new Error('usage: node scripts/release/collect-official-pi-closure.mjs <evidence-directory>');
mkdirSync(evidence, {recursive:true});
const commit='f07218c4d4bbc12bef056a7058c3dd49dfe41abe';
const names=['chord','pi-agent-core','pi-ai','pi-coding-agent','pi-telemetry','pi-tui'].map(x=>'@earendil-works/'+x);
const keys=(await (await fetch('https://registry.npmjs.org/-/npm/v1/keys')).json()).keys;
const sha=(bytes,algorithm='sha256')=>createHash(algorithm).update(bytes).digest('hex');
const records=[];
for (const name of names) {
 const metadata=await(await fetch(`https://registry.npmjs.org/${name}/0.87.1`)).json();
 assert.equal(metadata.name,name); assert.equal(metadata.version,'0.87.1'); assert.equal(metadata.gitHead,commit);
 const integrity=metadata.dist.integrity;
 assert.ok(metadata.dist.signatures.some(sig=>{const key=keys.find(k=>k.keyid===sig.keyid);return key&&verify('sha256',Buffer.from(`${name}@0.87.1:${integrity}`),createPublicKey({key:Buffer.from(key.key,'base64'),format:'der',type:'spki'}),Buffer.from(sig.sig,'base64'));}));
 const attestations=await(await fetch(metadata.dist.attestations.url)).json();
 const attestation=attestations.attestations.find(a=>a.predicateType==='https://slsa.dev/provenance/v1');
 assert.ok(attestation);
 await verifySigstore(attestation.bundle,{certificateIssuer:'https://token.actions.githubusercontent.com',certificateIdentityURI:'https://github.com/earendil-works/pi/.github/workflows/build-binaries.yml@refs/tags/v0.87.1'});
 const statement=JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload,'base64'));
 assert.equal(statement.subject.length,1);assert.equal(statement.subject[0].name,`pkg:npm/%40earendil-works/${name.split('/')[1]}@0.87.1`);
 assert.equal(statement.subject[0].digest.sha512,Buffer.from(integrity.slice(7),'base64').toString('hex'));
 assert.equal(statement.predicate.buildDefinition.externalParameters.workflow.repository,'https://github.com/earendil-works/pi');
 assert.ok(statement.predicate.buildDefinition.resolvedDependencies.some(d=>d.digest.gitCommit===commit));
 const tarball=Buffer.from(await(await fetch(metadata.dist.tarball)).arrayBuffer());
 assert.equal('sha512-'+createHash('sha512').update(tarball).digest('base64'),integrity);
 const temp=mkdtempSync(join(evidence,'official-package-'));const archive=join(temp,'package.tgz');writeFileSync(archive,tarball);
 const entries=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).trim().split('\n');
 assert.ok(entries.every(p=>p.startsWith('package/')&&!p.split('/').includes('..')));
 execFileSync('tar',['-xzf',archive,'-C',temp]);
 const base=join(temp,'package');
 const files=readdirSync(base,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{
  const file=join(e.parentPath,e.name);const bytes=readFileSync(file);return {path:file.slice(base.length+1),bytes:bytes.length,sha256:sha(bytes)};
 }).sort((a,b)=>a.path<b.path?-1:1);
 const bundle=JSON.stringify(attestation.bundle);
 writeFileSync(join(evidence,name.split('/')[1]+'-provenance.json'),bundle+'\n');
 records.push({name,version:'0.87.1',tarballIntegrity:integrity,upstreamCommit:commit,provenanceDigest:sha(bundle),provenanceBundle:attestation.bundle,
  provenance:{predicateType:statement.predicateType,repository:'https://github.com/earendil-works/pi',workflow:'.github/workflows/build-binaries.yml',ref:'refs/tags/v0.87.1',certificateIssuer:'https://token.actions.githubusercontent.com',verifiedBy:'sigstore.verify',attestationUrl:metadata.dist.attestations.url},files});
 console.log(`${name}@0.87.1: registry signature, Sigstore provenance, tarball integrity verified; ${files.length} file digests`);
}
writeFileSync(output,JSON.stringify({format:'byok.official-pi-closure',version:1,packages:records},null,2)+'\n');
console.log('Wrote '+output);
