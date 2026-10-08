import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
// Reuse sigstore's verifier with its npm-distributed trust root. No TUF,
// transparency service or auth endpoints are contacted during collection.
const require = createRequire(import.meta.url);
const sigstoreRequire = createRequire(require.resolve('sigstore'));
const { bundleFromJSON } = sigstoreRequire('@sigstore/bundle');
const { Verifier, toTrustMaterial, toSignedEntity } = sigstoreRequire('@sigstore/verify');
const { TrustedRoot } = sigstoreRequire('@sigstore/protobuf-specs');
const seeds = sigstoreRequire(join(dirname(sigstoreRequire.resolve('@sigstore/tuf')), '../seeds.json'));
const trustedRoot = TrustedRoot.fromJSON(JSON.parse(Buffer.from(seeds['https://tuf-repo-cdn.sigstore.dev'].targets['trusted_root.json'], 'base64')));
const verifier = new Verifier(toTrustMaterial(trustedRoot), { ctlogThreshold: 1, tlogThreshold: 1 });
const verifySigstore = (bundle, options) => verifier.verify(toSignedEntity(bundleFromJSON(bundle)), {
 subjectAlternativeName: options.certificateIdentityURI, extensions: { issuer: options.certificateIssuer },
});
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const output=fileURLToPath(new URL('../../packages/client/src/adapters/pi/official-pi-closure.json', import.meta.url));
const [evidence,version,commit]=process.argv.slice(2);
const usage='usage: node scripts/release/collect-official-pi-closure.mjs <evidence-directory> <exact x.y.z version> <40-hex upstream commit>';
if (!evidence) throw new Error(usage);
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version??'')) throw new Error(`${usage}\nversion must be one exact x.y.z, got ${String(version)}`);
if (!/^[0-9a-f]{40}$/.test(commit??'')) throw new Error(`${usage}\nupstream commit must be 40 lowercase hex characters, got ${String(commit)}`);
mkdirSync(evidence, {recursive:true});
const names=['chord','pi-agent-core','pi-ai','pi-codemode','pi-coding-agent','pi-durable','pi-mcp','pi-telemetry','pi-tui'].map(x=>'@earendil-works/'+x);
const keys=(await (await fetch('https://registry.npmjs.org/-/npm/v1/keys')).json()).keys;
const sha=(bytes,algorithm='sha256')=>createHash(algorithm).update(bytes).digest('hex');
const records=[];
for (const name of names) {
 const metadata=await(await fetch(`https://registry.npmjs.org/${name}/${version}`)).json();
 assert.equal(metadata.name,name); assert.equal(metadata.version,version); // npm may omit gitHead; the verified SLSA resolved dependency below is authoritative.
 if (metadata.gitHead !== undefined) assert.equal(metadata.gitHead,commit);
 const integrity=metadata.dist.integrity;
 assert.ok(metadata.dist.signatures.some(sig=>{const key=keys.find(k=>k.keyid===sig.keyid);return key&&verify('sha256',Buffer.from(`${name}@${version}:${integrity}`),createPublicKey({key:Buffer.from(key.key,'base64'),format:'der',type:'spki'}),Buffer.from(sig.sig,'base64'));}));
 const attestations=await(await fetch(metadata.dist.attestations.url)).json();
 const attestation=attestations.attestations.find(a=>a.predicateType==='https://slsa.dev/provenance/v1');
 assert.ok(attestation);
 await verifySigstore(attestation.bundle,{certificateIssuer:'https://token.actions.githubusercontent.com',certificateIdentityURI:`https://github.com/earendil-works/pi/.github/workflows/build-binaries.yml@refs/tags/v${version}`});
 const statement=JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload,'base64'));
 assert.equal(statement.subject.length,1);assert.equal(statement.subject[0].name,`pkg:npm/%40earendil-works/${name.split('/')[1]}@${version}`);
 assert.equal(statement.subject[0].digest.sha512,Buffer.from(integrity.slice(7),'base64').toString('hex'));
 assert.equal(statement.predicate.buildDefinition.externalParameters.workflow.repository,'https://github.com/earendil-works/pi');
 assert.ok(statement.predicate.buildDefinition.resolvedDependencies.some(d=>d.digest.gitCommit===commit));
 const tarball=Buffer.from(await(await fetch(metadata.dist.tarball)).arrayBuffer());
 assert.equal('sha512-'+createHash('sha512').update(tarball).digest('base64'),integrity);
 const bundle=JSON.stringify(attestation.bundle);
 writeFileSync(join(evidence,name.split('/')[1]+'-provenance.json'),bundle+'\n');
 records.push({name,version,tarballIntegrity:integrity,upstreamCommit:commit,provenanceDigest:sha(bundle),provenanceBundle:attestation.bundle,
  provenance:{predicateType:statement.predicateType,repository:'https://github.com/earendil-works/pi',workflow:'.github/workflows/build-binaries.yml',ref:`refs/tags/v${version}`,certificateIssuer:'https://token.actions.githubusercontent.com',verifiedBy:'@sigstore/verify (offline npm-bundled trusted root)',attestationUrl:metadata.dist.attestations.url}});
 console.log(`${name}@${version}: registry signature, Sigstore provenance, tarball integrity verified`);
}
writeFileSync(output,JSON.stringify({format:'byok.official-pi-closure',version:1,packages:records},null,2)+'\n');
console.log('Wrote '+output);
