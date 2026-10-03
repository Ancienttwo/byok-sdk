import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import { mkdirSync, readFileSync, existsSync, symlinkSync, renameSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { sixthEdgeKit } from './fixtures/sixth-edge-kit';
const kits:Awaited<ReturnType<typeof sixthEdgeKit>>[]=[];
afterEach(()=>{for(const k of kits.splice(0))k.dispose();});
function claims(k:Awaited<ReturnType<typeof sixthEdgeKit>>){return readdirSync(path.join(k.budget.directory,'claims')).filter(n=>/^\d{6}\.json$/.test(n)).length;}
it('refuses an absolute output path outside the declared async root before any probe',async()=>{
 const k=await sixthEdgeKit({native:true});kits.push(k);const asyncDir=path.join(k.dir,'async');mkdirSync(asyncDir);
 const r={...k.request(),asyncDir},before=claims(k);
 await expect(k.authority.prepare(r)).rejects.toThrow('external_cli_output_scope_mismatch');expect(claims(k)).toBe(before);expect(k.tasks()).toEqual([]);
});
it('accepts legitimate asyncDir separate from task cwd and writes only its step-scoped output',async()=>{
 const k=await sixthEdgeKit({native:true});kits.push(k);const asyncDir=path.join(k.dir,'async');mkdirSync(asyncDir);
 const r={...k.request(),asyncDir},args=[...r.args],file=path.join(asyncDir,`external-${r.stepIndex}.final-message.txt`);args[args.indexOf('--output-last-message')+1]=file;
 const request={...r,args},a=await k.authority.prepare(request),child=await k.authority.spawn(a,{command:request.command,args,cwd:k.dir,prompt:'',env:a.env});
 const close=once(child,'close');child.stdin.end('');await close;await k.authority.settled(child);expect(k.tasks()).toHaveLength(1);expect(readFileSync(file,'utf8')).toBe('{}');expect(claims(k)).toBe(5);
});
it.each(['root','leaf'])('refuses prepared output %s substitution at the final native boundary',async change=>{
 const k=await sixthEdgeKit({native:true});kits.push(k);const asyncDir=path.join(k.dir,'async'),outside=path.join(k.dir,'elsewhere');mkdirSync(asyncDir);mkdirSync(outside);
 const r={...k.request(),asyncDir},args=[...r.args],file=path.join(asyncDir,`external-${r.stepIndex}.final-message.txt`);args[args.indexOf('--output-last-message')+1]=file;
 const request={...r,args},a=await k.authority.prepare(request),before=claims(k);
 if(change==='root'){renameSync(asyncDir,asyncDir+'.old');symlinkSync(outside,asyncDir);}else symlinkSync(path.join(outside,'victim'),file);
 let failure:unknown;try{const child=await k.authority.spawn(a,{command:request.command,args,cwd:k.dir,prompt:'',env:a.env});const close=once(child,'close');child.stdin.end('');await close;await k.authority.settled(child);}catch(error){failure=error;}
 expect(failure).toBeInstanceOf(Error);expect((failure as Error).message).toContain('external_cli_output_scope_changed');expect(k.tasks()).toEqual([]);expect(claims(k)).toBe(before);expect(existsSync(path.join(outside,'victim'))).toBe(false);
});
