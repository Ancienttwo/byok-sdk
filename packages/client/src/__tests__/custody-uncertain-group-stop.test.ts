import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { sixthEdgeKit } from './fixtures/sixth-edge-kit';
vi.mock('node:child_process',async original=>{const actual=await original<typeof import('node:child_process')>();return {...actual,spawn:vi.fn(actual.spawn)};});
const kits:Awaited<ReturnType<typeof sixthEdgeKit>>[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.clearAllMocks();for(const k of kits.splice(0))k.dispose();});
const claims=(k:Awaited<ReturnType<typeof sixthEdgeKit>>)=>readdirSync(path.join(k.budget.directory,'claims')).filter(n=>/^\d{6}\.json$/.test(n)).length;
it.each([false,true])('stops the uncertain group but retains live/cumulative slots until proven death; ignoresTERM=%s',async ignoreTerm=>{
 const k=await sixthEdgeKit({native:true,ignoreTerm});kits.push(k);const control=new AbortController(),r=k.request(true),r2=k.request(true);
 const a=await k.authority.prepare(r,{signal:control.signal}),a2=await k.authority.prepare(r2),before=claims(k);let close:Promise<unknown>|undefined;
 const fault=vi.spyOn(control.signal,'addEventListener').mockImplementationOnce(()=>{
  const child=vi.mocked(spawn).mock.results.at(-1)!.value;close=once(child,'close');
  const limit=Date.now()+3000;while(!existsSync(path.join(k.dir,'native-ready'))){if(Date.now()>limit)throw Error('fixture did not enter native task');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);}
  throw Error('post-PID setup failure');
 });
 const signals=vi.spyOn(process,'kill');
 await expect(k.authority.spawn(a,{command:r.command,args:r.args,cwd:r.cwd,prompt:r.prompt,env:a.env})).rejects.toThrow('post-PID setup failure');fault.mockRestore();
 const child=vi.mocked(spawn).mock.results.at(-1)!.value;
 try{
  const rows=readdirSync(path.join(k.budget.directory,'custody-external')).map(n=>JSON.parse(readFileSync(path.join(k.budget.directory,'custody-external',n),'utf8'))),row=rows.find(v=>v.kind==='task');
  expect(row.pid).toBe(child.pid);expect(row.state).toBe('uncertain');expect(signals.mock.calls).toContainEqual([-child.pid,'SIGTERM']);
  expect(row.slots).toHaveLength(4);expect(row.slots.every((s:string)=>existsSync(s))).toBe(true);expect(claims(k)).toBe(before+1);
  if(ignoreTerm){expect(()=>process.kill(child.pid,0)).not.toThrow();await expect(k.authority.spawn(a2,{command:r2.command,args:r2.args,cwd:r2.cwd,prompt:r2.prompt,env:a2.env})).rejects.toThrow('external_cli_J_exhausted');expect(claims(k)).toBe(before+1);process.kill(-child.pid,'SIGKILL');}
  await close;
  const next=await k.authority.spawn(a2,{command:r2.command,args:r2.args,cwd:r2.cwd,prompt:r2.prompt,env:a2.env});const nextClose=once(next,'close');next.stdin.end('');await nextClose;await k.authority.settled(next);
  expect(claims(k)).toBe(before+2);expect(k.tasks()).toHaveLength(1);
  const updated=JSON.parse(readFileSync(path.join(k.budget.directory,'custody-external',row.launchId+'.json'),'utf8'));expect(updated.state).toBe('terminated');
 }finally{signals.mockRestore();if(child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{}}await close;}
});
