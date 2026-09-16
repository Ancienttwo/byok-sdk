import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assertDescendantSpawn, RUNTIME_DESCENDANT_EDGES, type ToolImplementationFsProbe } from '../identity';
import { descendantTemplateDigest, parseDescendantLaunch, type DescendantLaunchV1, type DescendantSpawnExpectationV1 } from '../descendant-launch';
const root = path.resolve(import.meta.dirname,'../../../../tests/fixtures/c07-runtime-record');
const positive = JSON.parse(readFileSync(path.join(root,'canonical-revision.v1.json'),'utf8'));
const negative = JSON.parse(readFileSync(path.join(root,'rejections.v1.json'),'utf8'));
const vectors = positive.descendantLaunchVectors as {id:string;launch:DescendantLaunchV1;actualEnv:Record<string,string>}[];
function expectation(launch: DescendantLaunchV1): DescendantSpawnExpectationV1 {
 const c=launch.perLaunch;
 return { template:launch.template,policy:launch.policy,edges:RUNTIME_DESCENDANT_EDGES,inheritedCredentialNames:[],
  parent:{kind:c.edge.parent,rootTaskId:c.rootTaskId,instancePath:c.parentInstancePath,
    depth:c.depth-(c.edge.parent==='pi-subagent-runner'?0:1),effectiveLimits:c.effectiveLimits}};
}
function actual(v: typeof vectors[number]) { const t=v.launch.template;return {command:t.command,entry:t.entry,fixedArgv:t.fixedArgv,cwd:t.cwd,env:v.actualEnv}; }
function probe(launch: DescendantLaunchV1): ToolImplementationFsProbe {
 const i=launch.template.identity;if(i.kind!=='attested')throw Error('fixture');
 const files=new Map<string,{digest:string;stat:typeof i.installStat}>([[i.installPath,{digest:i.closureDigest,stat:i.installStat}]]);
 if(i.interpreter)files.set(i.interpreter.path,{digest:i.interpreter.digest,stat:i.interpreterStat!});
 i.assets?.forEach((a,n)=>files.set(path.join(i.assetRoot!,a.path),{digest:a.digest,stat:i.assetStats![n]!}));
 return {realpath:vi.fn(async p=>p),lstat:vi.fn(async p=>({...files.get(p)?.stat ?? i.installStat,isFile:true,isSymbolicLink:false})),
  digest:vi.fn(async p=>{const f=files.get(p);if(!f)throw Error('unexpected path');return f.digest;})};
}
describe('M0 descendant composition becomes real consistency validation',()=>{
 it.each(vectors)('accepts $id without enabling a process',async v=>{
  expect(descendantTemplateDigest(v.launch.template)).toBe(v.launch.templateDigest);
  expect(JSON.stringify(parseDescendantLaunch(v.launch))).toBe(JSON.stringify(v.launch));
  const fs=probe(v.launch);await assertDescendantSpawn(v.launch,expectation(v.launch),actual(v),fs);
  expect(fs.digest).toHaveBeenCalled();
 });
 it.each((negative.compositionCases as {id:string;expectedDeclarationRef?:string;expectedReason:string;launch:unknown;actualEnv:Record<string,string>}[]).filter(v=>v.expectedDeclarationRef))('rejects frozen $id',async v=>{
  const reference=vectors.find(r=>r.id===v.expectedDeclarationRef)!;
  const fs=probe(reference.launch);
  await expect(assertDescendantSpawn(v.launch,expectation(reference.launch),{...actual(reference),env:v.actualEnv},fs)).rejects.toThrow(v.expectedReason);
  expect(fs.digest).not.toHaveBeenCalled();
 });
 it('keeps credential values out of config/digest while independently checking inherited names',async()=>{
  const v=vectors[0]!,secret='synthetic-not-a-real-credential';
  const expected={...expectation(v.launch),inheritedCredentialNames:['PI_PROVIDER_API_KEY']};
  await assertDescendantSpawn(v.launch,expected,{...actual(v),env:{...v.actualEnv,PI_PROVIDER_API_KEY:secret}},probe(v.launch));
  expect(JSON.stringify(v.launch)).not.toContain(secret);
  await expect(assertDescendantSpawn(v.launch,expectation(v.launch),{...actual(v),env:{...v.actualEnv,PI_PROVIDER_API_KEY:secret}},probe(v.launch))).rejects.toThrow('descendant_credential_custody_mismatch');
 });
 it.each([
  ['unknown top key',(v:any)=>{v.extra=true;}],['unknown context key',(v:any)=>{v.perLaunch.extra=true;}],
  ['old version',(v:any)=>{v.version=0;}],['unavailable template',(v:any)=>{v.template.identity={kind:'unavailable',reason:'resolver_unconfigured'};}],
  ['sparse exact names',(v:any)=>{v.perLaunch.exactNames=Array(1);}],['sparse candidate',(v:any)=>{v.perLaunch.modelCandidates=Array(1);}],
  ['MCP credential',(v:any)=>{v.perLaunch.mcp.env.PI_PROVIDER_API_KEY='fake';}],
 ] as const)('strictly rejects %s',(_name,mutate)=>{
  const v=structuredClone(vectors[0]!.launch);mutate(v);expect(()=>parseDescendantLaunch(v)).toThrow();
 });
 it('does not infer parent custody from the candidate root/path',async()=>{
  const v=vectors[0]!,e=expectation(v.launch);
  await expect(assertDescendantSpawn(v.launch,{...e,parent:{...e.parent,rootTaskId:'different-root'}},actual(v),probe(v.launch))).rejects.toThrow('descendant_parent_transition_mismatch');
 });
});
