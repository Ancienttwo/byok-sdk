import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { sixthEdgeKit } from './fixtures/sixth-edge-kit';
const kits:Awaited<ReturnType<typeof sixthEdgeKit>>[]=[];
afterEach(()=>{for(const k of kits.splice(0))k.dispose();});
function claims(k:Awaited<ReturnType<typeof sixthEdgeKit>>){return readdirSync(path.join(k.budget.directory,'claims')).filter(n=>/^\d{6}\.json$/.test(n)).length;}
async function run(k:Awaited<ReturnType<typeof sixthEdgeKit>>,request:ReturnType<typeof k.request>,auth:Awaited<ReturnType<typeof k.authority.prepare>>){
 const child=await k.authority.spawn(auth,{command:request.command,args:request.args,cwd:request.cwd,prompt:request.prompt,env:auth.env});
 const close=once(child,'close');child.stdin.end('');await close;await k.authority.settled(child);
}
it.each(['key','console','unknown'])('refuses changed Claude %s mode after preparation, without a task PID or task reservation',async authMode=>{
 const k=await sixthEdgeKit({family:'claude'});kits.push(k);const request=k.request(true),auth=await k.authority.prepare(request),before=claims(k);
 writeFileSync(k.statePath,JSON.stringify({auth:authMode}));
 let error:unknown;try{await run(k,request,auth);}catch(e){error=e;}
 expect(error).toBeInstanceOf(Error);expect((error as Error).message).toContain('external_cli_auth_mode_unavailable');
 expect(k.tasks()).toEqual([]);expect(claims(k)).toBe(before+1);
 const ledgers=readdirSync(path.join(k.budget.directory,'custody-external')).map(n=>JSON.parse(readFileSync(path.join(k.budget.directory,'custody-external',n),'utf8')));
 expect(ledgers.filter(row=>row.kind==='task')).toEqual([]);expect(ledgers.filter(row=>row.kind==='probe')).toHaveLength(4);
});
it('charges a final Claude mode proof and one task, but replay creates neither',async()=>{
 const k=await sixthEdgeKit({family:'claude'});kits.push(k);const request=k.request(true),auth=await k.authority.prepare(request);
 await run(k,request,auth);expect(k.tasks()).toHaveLength(1);expect(claims(k)).toBe(6);
 await expect(run(k,request,auth)).rejects.toThrow('external_cli_permit_reused');expect(claims(k)).toBe(6);
});
