import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assertDescendantSpawn, reverifyToolImplementationIdentity, toolImplementationLaunchEnvNamesDigest, RUNTIME_DESCENDANT_EDGES, type ToolImplementationFsProbe } from '../identity';
import { descendantTemplateDigest, parseDescendantLaunch, type DescendantLaunchV1, type DescendantSpawnExpectationV1, DescendantLaunchError, validateDescendantSpawn } from '../descendant-launch';
const root = path.resolve(import.meta.dirname,'../../../../tests/fixtures/c07-runtime-record');
const positive = JSON.parse(readFileSync(path.join(root,'official-pi-087.v1.json'),'utf8'));
const negative = JSON.parse(readFileSync(path.join(root,'official-pi-087-rejections.v1.json'),'utf8'));
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
  await expect(assertDescendantSpawn(v.launch,expectation(reference.launch),{...actual(reference),env:v.actualEnv},fs)).rejects.toMatchObject({reason:v.expectedReason});
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


describe('all frozen M0 context and transition vectors',()=>{
 it.each(negative.contextCases as {id:string;context:DescendantLaunchV1['perLaunch'];expectedReason:string;actualProjectedEnvNames?:string[]}[])('rejects context $id with frozen reason',async v=>{
  const reference=vectors[0]!, launch={...reference.launch,perLaunch:v.context};
  // Deliberately let forged envValues agree with the actual environment: the
  // independent typed context, not pairwise env equality, must catch the drift.
  const env={...reference.actualEnv};
  for(const [name,value] of Object.entries(v.context.envValues)) {
   if(value===null)delete env[name];else env[name]=value;
  }
  if(v.actualProjectedEnvNames)expect(Object.keys(env).sort()).toEqual(v.actualProjectedEnvNames);
  const fs=probe(reference.launch);
  await expect(assertDescendantSpawn(launch,expectation(reference.launch),{...actual(reference),env},fs)).rejects.toMatchObject({reason:v.expectedReason});
  expect(fs.digest).not.toHaveBeenCalled();
 });
 it.each(negative.transitionCases as {id:string;configured?:number;granted?:number;recordSessionCap?:number;effectiveMaxDepth?:number;currentDepth?:number;proposedEdge?:string;parentDepth?:number;edge?:string;expectedChildDepth?:number;measuredNames?:string[];declaredNames?:string[];expectedReason?:string;expected?:string}[])('executes transition $id',async v=>{
  if(v.id==='exact-env-names-do-not-retarget-identity') {
   const reference=vectors[0]!, identity=reference.launch.template.identity;
   if(identity.kind!=='attested')throw Error('fixture');
   const measured=Object.fromEntries(v.measuredNames!.map(name=>[name,'synthetic']));
   const declared=Object.fromEntries(v.declaredNames!.map(name=>[name,'synthetic']));
   const result=await reverifyToolImplementationIdentity({...identity,launchEnvNamesDigest:toolImplementationLaunchEnvNamesDigest(measured)},declared,probe(reference.launch));
   expect(result).toEqual({reason:v.expectedReason,subject:'launch-env'});
   return;
  }
  const edge=v.edge??v.proposedEdge??vectors[0]!.id;
  const reference=vectors.find(item=>item.id===edge)!;
  expect(reference).toBeDefined();
  const launch: { -readonly [K in keyof DescendantLaunchV1]: DescendantLaunchV1[K] }=structuredClone(reference.launch);
  const expected: { -readonly [K in keyof DescendantSpawnExpectationV1]: DescendantSpawnExpectationV1[K] }=structuredClone(expectation(reference.launch));
  if(v.configured!==undefined) {
   // Frozen arithmetic scenario only: no grant issuance is invented by this test.
   launch.perLaunch={...launch.perLaunch,effectiveLimits:{...launch.perLaunch.effectiveLimits,sessionCap:v.configured+v.granted!}};
   launch.policy={...launch.policy,sessionCap:v.recordSessionCap!};expected.policy=launch.policy;
   expected.parent={...expected.parent,effectiveLimits:{...expected.parent.effectiveLimits,sessionCap:v.recordSessionCap!}};
  } else if(v.effectiveMaxDepth!==undefined) {
   launch.policy={...launch.policy,maxDepth:v.effectiveMaxDepth};expected.policy=launch.policy;
   expected.parent={...expected.parent,depth:v.currentDepth!,effectiveLimits:{...expected.parent.effectiveLimits,maxDepth:v.effectiveMaxDepth}};
   launch.perLaunch={...launch.perLaunch,effectiveLimits:{...launch.perLaunch.effectiveLimits,maxDepth:v.effectiveMaxDepth},depth:v.currentDepth!,remainingDepth:0,
    envValues:{...launch.perLaunch.envValues,PI_SUBAGENT_DEPTH:String(v.currentDepth),PI_SUBAGENT_MAX_DEPTH:String(v.effectiveMaxDepth)}};
  } else if(v.parentDepth!==undefined) {
   expected.parent={...expected.parent,depth:v.parentDepth};expect(launch.perLaunch.depth).toBe(v.expectedChildDepth);
  } else throw Error('unhandled frozen transition');
  const env={...reference.actualEnv,...Object.fromEntries(Object.entries(launch.perLaunch.envValues).filter((pair):pair is [string,string]=>pair[1]!==null))};
  const fs=probe(launch), pending=assertDescendantSpawn(launch,expected,{...actual(reference),env},fs);
  if(v.expectedReason){await expect(pending).rejects.toMatchObject({reason:v.expectedReason});expect(fs.digest).not.toHaveBeenCalled();}
  else {await expect(pending).resolves.toBeUndefined();expect(fs.digest).toHaveBeenCalled();}
 });
});


describe('depth refusal partition and optional projection semantics',()=>{
 it.each([0,1,3])('uses actual parent charge budget at cap %i, even for an over-cap declaration',cap=>{
  const reference=vectors.find(v=>v.id==='pi-subagent-print->pi-subagent-runner')!;
  const child={...reference.launch,perLaunch:{...reference.launch.perLaunch,depth:cap+1,
   effectiveLimits:{...reference.launch.perLaunch.effectiveLimits,maxDepth:cap}}};
  const base=expectation(reference.launch);
  const atParent=(depth:number)=>({...base,parent:{...base.parent,depth}});
  // The very same over-cap candidate selects one exact reason. In particular,
  // an exhausted parent must never be reported as merely an invalid declaration.
  const reason=(depth:number)=>{
   try {validateDescendantSpawn(child,atParent(depth),actual(reference));throw Error('accepted invalid depth');}
   catch(error){expect(error).toBeInstanceOf(DescendantLaunchError);return (error as DescendantLaunchError).reason;}
  };
  expect(reason(cap)).toBe('descendant_depth_exhausted');
  expect(reason(cap)).not.toBe('descendant_depth_exceeded');
  if(cap>0) {
   expect(reason(cap-1)).toBe('descendant_depth_exceeded');
   expect(reason(cap-1)).not.toBe('descendant_depth_exhausted');
  }
 });
 it('allows the zero-charge runner to print transition at the cap',async()=>{
  const reference=vectors.find(v=>v.id==='pi-subagent-runner->pi-subagent-print')!;
  const cap=reference.launch.perLaunch.depth;
  const launch={...reference.launch,perLaunch:{...reference.launch.perLaunch,remainingDepth:0,
   effectiveLimits:{...reference.launch.perLaunch.effectiveLimits,maxDepth:cap},
   envValues:{...reference.launch.perLaunch.envValues,PI_SUBAGENT_MAX_DEPTH:String(cap)}}};
  const env={...reference.actualEnv,PI_SUBAGENT_MAX_DEPTH:String(cap)};
  await expect(assertDescendantSpawn(launch,expectation(launch),{...actual(reference),env},probe(launch))).resolves.toBeUndefined();
 });
 it.each([
  ['PI_SUBAGENT_DEPTH','01'],['PI_SUBAGENT_DEPTH','1.0'],['PI_SUBAGENT_MAX_DEPTH','2'],['PI_SUBAGENT_MAX_DEPTH','03'],
 ])('rejects matching forged env pairs %s=%s against typed authority',async(name,value)=>{
  const reference=vectors[0]!;
  const launch={...reference.launch,perLaunch:{...reference.launch.perLaunch,envValues:{...reference.launch.perLaunch.envValues,[name]:value}}};
  const fs=probe(launch);
  await expect(assertDescendantSpawn(launch,expectation(reference.launch),{...actual(reference),env:{...reference.actualEnv,[name]:value}},fs))
   .rejects.toMatchObject({reason:'descendant_depth_projection_mismatch'});
  expect(fs.digest).not.toHaveBeenCalled();
 });
 it.each(['absent','null'] as const)('preserves %s optional depth names without synthesizing defaults',async state=>{
  const reference=vectors[0]!,envValues={...reference.launch.perLaunch.envValues},env={...reference.actualEnv};
  const projected=['PI_SUBAGENT_DEPTH','PI_SUBAGENT_MAX_DEPTH'];
  for(const name of projected){delete env[name];if(state==='null')envValues[name]=null;else delete envValues[name];}
  const launch={...reference.launch,perLaunch:{...reference.launch.perLaunch,envValues,
   exactNames:reference.launch.perLaunch.exactNames.filter(name=>!projected.includes(name))}};
  const parsed=parseDescendantLaunch(launch);
  expect(parsed.perLaunch.envValues).toEqual(envValues);
  expect(JSON.stringify(parsed)).toBe(JSON.stringify(launch));
  await expect(assertDescendantSpawn(launch,expectation(reference.launch),{...actual(reference),env},probe(launch))).resolves.toBeUndefined();
  for(const name of projected)expect(Object.hasOwn(env,name)).toBe(false);
 });
});
