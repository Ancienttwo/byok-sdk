import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import * as bridge from '../custody/custody-vendor-bridge.js';
import { externalCliConfigRefusal } from '../custody/external-cli-admission';
import { resolveOfficialExternalCliInstall } from '@byok-sdk/implementation-identity';
import { sixthEdgeKit, ownershipProbe } from './fixtures/sixth-edge-kit';
vi.mock('node:child_process', async original => {
  const actual=await original<typeof import('node:child_process')>();
  return {...actual,spawn:vi.fn(actual.spawn)};
});
vi.mock('../custody/custody-vendor-bridge.js', async original => {
  const actual=await original<typeof import('../custody/custody-vendor-bridge.js')>();
  return {...actual,claimWorkflowChildPermit:vi.fn(actual.claimWorkflowChildPermit),consumeWorkflowChildPermit:vi.fn(actual.consumeWorkflowChildPermit)};
});
const kits: Awaited<ReturnType<typeof sixthEdgeKit>>[]=[];
async function kit(options?:{ignoreTerm?:boolean}) {const k=await sixthEdgeKit({native:true,...options});kits.push(k);return k;}
afterEach(()=>{vi.restoreAllMocks();vi.clearAllMocks();for(const k of kits.splice(0))k.dispose();});
function ledgers(k:Awaited<ReturnType<typeof kit>>) {return readdirSync(path.join(k.budget.directory,'custody-external')).map(name=>JSON.parse(readFileSync(path.join(k.budget.directory,'custody-external',name),'utf8')));}
function slotFiles(directory:string):string[] {
  if(!existsSync(directory))return [];
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?slotFiles(path.join(directory,entry.name)):[path.join(directory,entry.name)]).sort();
}
function claims(k:Awaited<ReturnType<typeof kit>>) {return readdirSync(path.join(k.budget.directory,'claims')).filter(name=>/^\d{6}\.json$/u.test(name)).length;}
async function run(k:Awaited<ReturnType<typeof kit>>,request:ReturnType<typeof k.request>,auth:Awaited<ReturnType<typeof k.authority.prepare>>) {
  const child=await k.authority.spawn(auth,{command:request.command,args:request.args,cwd:request.cwd,prompt:request.prompt,env:auth.env});
  const close=once(child,'close');child.stdin.end('');await close;await k.authority.settled(child);
}
describe('sixth edge: definite failure rollback and uncertain child retention',()=>{
  it.each(['claim','consume','spawn'] as const)('%s failure releases all live slots without reusable authorization',async failure=>{
    const k=await kit(),first=k.request(true),next=k.request(true);
    const auth=await k.authority.prepare(first),nextAuth=await k.authority.prepare(next),before=claims(k);
    if(failure==='claim')vi.mocked(bridge.claimWorkflowChildPermit).mockReturnValueOnce('injected claim refusal');
    if(failure==='consume'){
      const consume=vi.mocked(bridge.consumeWorkflowChildPermit).getMockImplementation()!;
      vi.mocked(bridge.consumeWorkflowChildPermit).mockImplementationOnce((...args)=>{expect(consume(...args)).toBeUndefined();return 'injected post-consume refusal';});
    }
    if(failure==='spawn')vi.mocked(spawn).mockImplementationOnce(()=>{throw new Error('injected synchronous spawn failure');});
    const spawnCalls=vi.mocked(spawn).mock.calls.length,slotsBefore=slotFiles(path.join(k.budget.directory,'custody-caps'));
    expect(slotsBefore.length).toBeGreaterThan(0); // Real parent slots form the baseline, not an empty directory stub.
    await expect(run(k,first,auth)).rejects.toThrow(failure==='claim'?'external_cli_permit_invalid':failure==='consume'?'external_cli_permit_reused':'injected synchronous spawn failure');
    expect(k.tasks()).toEqual([]);expect(vi.mocked(spawn).mock.calls.length-spawnCalls).toBe(failure==='spawn'?1:0);
    expect(slotFiles(path.join(k.budget.directory,'custody-caps'))).toEqual(slotsBefore);
    const failed=ledgers(k).find(v=>v.kind==='task');
    if(failure==='spawn'){
      expect(failed.state).toBe('not-spawned');expect(failed.pid).toBeUndefined();expect(failed.slots).toHaveLength(4);
      expect(failed.slots.every((slot:string)=>!existsSync(slot))).toBe(true);expect(claims(k)).toBe(before+1);
    }else{expect(failed).toBeUndefined();expect(claims(k)).toBe(before);}
    await expect(run(k,first,auth)).rejects.toThrow('external_cli_permit_reused');expect(claims(k)).toBe(before+(failure==='spawn'?1:0));
    await run(k,next,nextAuth);expect(k.tasks()).toHaveLength(1);expect(claims(k)).toBe(before+(failure==='spawn'?2:1));
    expect(ledgers(k).filter(v=>v.kind==='task')).toHaveLength(failure==='spawn'?2:1);
  });
  it('retains genuinely uncertain live child slots, then recovers only after PID and group are absent',async()=>{
    const k=await kit({ignoreTerm:true}),first=k.request(true),next=k.request(true),control=new AbortController();
    const auth=await k.authority.prepare(first,{signal:control.signal}),nextAuth=await k.authority.prepare(next);
    const spy=vi.spyOn(control.signal,'addEventListener').mockImplementationOnce(()=>{const limit=Date.now()+3000;while(!existsSync(path.join(k.dir,'native-ready'))){if(Date.now()>limit)throw Error('native fixture did not become ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);}throw new Error('injected post-spawn setup failure');});
    await expect(run(k,first,auth)).rejects.toThrow('injected post-spawn setup failure');spy.mockRestore();
    const child=vi.mocked(spawn).mock.results.at(-1)!.value,uncertain=ledgers(k).find(v=>v.kind==='task');
    try{
      expect(child.pid).toBe(uncertain.pid);expect(uncertain.state).toBe('uncertain');expect(uncertain.slots).toHaveLength(4);
      expect(uncertain.slots.every((slot:string)=>existsSync(slot))).toBe(true);expect(()=>process.kill(uncertain.pid,0)).not.toThrow();
      const before=claims(k);await expect(run(k,next,nextAuth)).rejects.toThrow('external_cli_J_exhausted');expect(claims(k)).toBe(before);
      const close=once(child,'close');process.kill(-uncertain.pid,'SIGKILL');await close;
      await run(k,next,nextAuth);expect(k.tasks()).toHaveLength(1);expect(claims(k)).toBe(before+1);
      expect(ledgers(k).find(v=>v.launchId===uncertain.launchId).state).toBe('terminated');
    }finally{if(child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{}}}
  });
});
it.each(['cursor-agent','cursor-agent-writer'] as const)('refuses clean %s without any override or external probe',async adapter=>{
  const k=await kit(),before=claims(k),steps=[{agent:'fixture',task:'task',runner:{type:'external-cli',adapter,command:k.command}}];
  expect(externalCliConfigRefusal({steps},'initial',k.installations)).toBe(`official external-cli admission refused: runner config initial declares runner.type 'external-cli' at steps[0] with adapter '${adapter}'`);
  await expect(k.authority.prepare({...k.request(),adapter})).rejects.toThrow('external_cli_installation_unavailable');
  expect(await resolveOfficialExternalCliInstall({resolve:async()=>k.declaration(adapter)},adapter,ownershipProbe)).toBeUndefined();
  expect(claims(k)).toBe(before);expect(k.tasks()).toEqual([]);
});
it('refuses Windows installation and native admission before any additional claim',async()=>{
  const k=await kit(),request=k.request(),auth=await k.authority.prepare(request),before=claims(k),resolver=vi.fn();
  const platform=vi.spyOn(process,'platform','get').mockReturnValue('win32');
  try{
    expect(await resolveOfficialExternalCliInstall({resolve:resolver},'codex-exec',ownershipProbe)).toBeUndefined();expect(resolver).not.toHaveBeenCalled();
    expect(()=>k.authority.prepare(k.request())).toThrow('external_cli_platform_unavailable');
    await expect(run(k,request,auth)).rejects.toThrow('external_cli_platform_unavailable');expect(claims(k)).toBe(before);expect(k.tasks()).toEqual([]);
  }finally{platform.mockRestore();}
});
it('keeps sixth-edge counters derivation-only with no money, token, spend or user-quota wiring',async()=>{
  const k=await kit(),request=k.request(true),auth=await k.authority.prepare(request);await run(k,request,auth);
  expect(Object.keys(ledgers(k).find(v=>v.kind==='task')).sort()).toEqual(['attempt','depth','kind','launchId','operation','parent','pid','record','slots','state','version','writer']);
  const client=path.resolve(import.meta.dirname,'../..');
  const paths=['src/custody/external-cli-custody.ts','src/custody/external-cli-admission.ts','src/custody/external-cli-authority.ts',
    'vendor/pi-subagents/0.60.0/src/runs/shared/external-cli-runner.ts','vendor/pi-subagents/0.60.0/src/runs/shared/run-fanout-budget.ts'];
  const forbidden=/\b(?:billing|money|metering|tokenUsage|tokenCount|totalTokens|inputTokens|outputTokens|spendCap|spendLimit|spend_cap|spend_limit|quotaProjection)\b/i;
  for(const file of paths)expect(readFileSync(path.join(client,file),'utf8'),file).not.toMatch(forbidden);
  for(const file of ['src/daemon/task-runner.ts','../core/src/quota.ts','../cloud/src/tenant-stores.ts'])expect(readFileSync(path.join(client,file),'utf8'),file).not.toMatch(/custody-external|custody-caps|external-cli-custody/);
});
