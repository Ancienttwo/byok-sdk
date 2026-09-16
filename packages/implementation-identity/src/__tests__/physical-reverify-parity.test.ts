import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { reverifyToolImplementationIdentity, assertDescendantSpawn, RUNTIME_DESCENDANT_EDGES, type ToolImplementationFsProbe } from '../identity';
import type { DescendantLaunchV1 } from '../descendant-launch';
const data=JSON.parse(readFileSync(path.resolve(import.meta.dirname,'../../../../tests/fixtures/c07-runtime-record/canonical-revision.v1.json'),'utf8'));
const vector=data.descendantLaunchVectors[0];const launch=vector.launch as DescendantLaunchV1;
const id=(()=>{const value=launch.template.identity;if(value.kind!=='attested')throw Error('fixture');return value;})();
const expected={template:launch.template,policy:launch.policy,edges:RUNTIME_DESCENDANT_EDGES,inheritedCredentialNames:[],
 parent:{kind:launch.perLaunch.edge.parent,rootTaskId:launch.perLaunch.rootTaskId,instancePath:[],depth:0,effectiveLimits:launch.perLaunch.effectiveLimits}};
function makeProbe(subject:'artifact'|'interpreter'|'asset',mode:'stat'|'digest'){
 const files=new Map<string,{digest:string;stat:typeof id.installStat}>([[id.installPath,{digest:id.closureDigest,stat:id.installStat}]]);
 files.set(id.interpreter!.path,{digest:id.interpreter!.digest,stat:id.interpreterStat!});
 id.assets!.forEach((a,n)=>files.set(path.join(id.assetRoot!,a.path),{digest:a.digest,stat:id.assetStats![n]!}));
 const target=subject==='artifact'?id.installPath:subject==='interpreter'?id.interpreter!.path:path.join(id.assetRoot!,id.assets![0]!.path);
 return {realpath:vi.fn(async p=>p),lstat:vi.fn(async p=>({...files.get(p)?.stat??id.installStat,...(p===target&&mode==='stat'?{ino:999}:{}),isFile:true,isSymbolicLink:false})),
 digest:vi.fn(async p=>p===target&&mode==='digest'?'0'.repeat(64):files.get(p)!.digest)} satisfies ToolImplementationFsProbe;
}
describe('one private physical reverify preserves old fixed results',()=>{
 for(const subject of ['artifact','interpreter','asset'] as const)for(const mode of ['stat','digest'] as const){
  it(`${subject}/${mode} has unchanged reason and ordering`,async()=>{
   const oldProbe=makeProbe(subject,mode),newProbe=makeProbe(subject,mode);
   const result=await reverifyToolImplementationIdentity(id,{},oldProbe);
   expect(result).toEqual({reason:mode==='stat'?'install_record_mismatch':'reverify_failed',subject});
   if(result==='ok')throw Error('physical failure vector unexpectedly passed');
   const t=launch.template;
   await expect(assertDescendantSpawn(launch,expected,{command:t.command,entry:t.entry,cwd:t.cwd,fixedArgv:t.fixedArgv,env:vector.actualEnv},newProbe)).rejects.toMatchObject(result);
   expect(newProbe.realpath.mock.calls).toEqual(oldProbe.realpath.mock.calls);
   expect(newProbe.lstat.mock.calls).toEqual(oldProbe.lstat.mock.calls);
   expect(newProbe.digest.mock.calls).toEqual(oldProbe.digest.mock.calls);
  });
 }
});
