import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { sixthEdgeKit } from './fixtures/sixth-edge-kit';
const kits:Awaited<ReturnType<typeof sixthEdgeKit>>[]=[];
afterEach(()=>{for(const k of kits.splice(0))k.dispose();});
const claims=(k:Awaited<ReturnType<typeof sixthEdgeKit>>)=>readdirSync(path.join(k.budget.directory,'claims')).filter(n=>/^\d{6}\.json$/.test(n)).length;
async function run(k:Awaited<ReturnType<typeof sixthEdgeKit>>,request:ReturnType<typeof k.request>,auth?:Awaited<ReturnType<typeof k.authority.prepare>>){
 const a=auth??await k.authority.prepare(request),child=await k.authority.spawn(a,{command:request.command,args:request.args,cwd:request.cwd,prompt:request.prompt,env:a.env});
 const close=once(child,'close');child.stdin.end('');await close;await k.authority.settled(child);
}
it.each([['E',16,false],['W',4,true]] as const)('refuses exhausted %s in prepare before a physical probe',async(cap,count,writer)=>{
 const k=await sixthEdgeKit({native:true});kits.push(k);for(let n=0;n<count;n++)await run(k,k.request(writer));const before=claims(k);
 let error:unknown;try{await k.authority.prepare(k.request(writer));}catch(e){error=e;}
 expect(error).toBeInstanceOf(Error);expect((error as Error).message).toContain(`external_cli_${cap}_exhausted`);expect(claims(k)).toBe(before);expect(k.tasks()).toHaveLength(count);
});
it('refuses a new depth charge in prepare without spending a root claim',async()=>{
 const k=await sixthEdgeKit({native:true,maxDepth:1});kits.push(k);await run(k,k.request());const before=claims(k);
 let error:unknown;try{await k.authority.prepare(k.request());}catch(e){error=e;}
 expect(error).toBeInstanceOf(Error);expect((error as Error).message).toContain('external_cli_depth_exhausted');expect(claims(k)).toBe(before);expect(k.tasks()).toHaveLength(1);
});
it('retains final authoritative admission when several writers prepared before exhaustion',async()=>{
 const k=await sixthEdgeKit({native:true});kits.push(k);const requests=Array.from({length:5},()=>k.request(true));const handles=[];
 for(const r of requests)handles.push(await k.authority.prepare(r));for(let n=0;n<3;n++)await run(k,requests[n]!,handles[n]!);const before=claims(k);
 const raced=await Promise.allSettled([run(k,requests[3]!,handles[3]!),run(k,requests[4]!,handles[4]!)]);
 expect(raced.filter(v=>v.status==='fulfilled')).toHaveLength(1);const rejected=raced.filter(v=>v.status==='rejected');expect(rejected).toHaveLength(1);expect(rejected[0]!.reason.message).toContain('external_cli_W_exhausted');
 expect(claims(k)).toBe(before+1);expect(k.tasks()).toHaveLength(4);
});
