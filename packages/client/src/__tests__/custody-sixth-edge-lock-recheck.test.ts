import { afterEach, expect, it, vi } from 'vitest';
import fs, { readFileSync, writeFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import childProcess, { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { ExternalCliCustodyAuthority } from '../custody/external-cli-custody';
import { sixthEdgeKit, ownershipProbe } from './fixtures/sixth-edge-kit';
const kits: Awaited<ReturnType<typeof sixthEdgeKit>>[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const k of kits.splice(0))k.dispose();});
const claims=(k:Awaited<ReturnType<typeof sixthEdgeKit>>)=>readdirSync(path.join(k.budget.directory,'claims')).filter(n=>/^\d{6}\.json$/.test(n)).length;

it.each(['artifact','artifact-symlink','config','interpreter','asset','parent'] as const)('rejects %s replacement during REAL admission-lock wait after full byte proof',async subject=>{
 const k=await sixthEdgeKit(subject==='interpreter'?{copyInterpreter:true}:{native:true});kits.push(k);
 const signal=path.join(k.dir,'lock-wait-observed'),proof=path.join(k.dir,'full-proof-complete'),mutated=path.join(k.dir,'replacement-observed');
 const lastAsset=k.installations[0]!.identity.assets!.at(-1)!;
 const lastPath=path.join(k.installations[0]!.identity.assetRoot!,lastAsset.path);
 let armed=false;
 const probe={...ownershipProbe,async digest(target:string){const value=await ownershipProbe.digest(target);if(armed&&target===lastPath)writeFileSync(proof,'complete');return value;}};
 const authority=new ExternalCliCustodyAuthority(k.parent,k.budget,k.installations,{},probe,k.recordPath);
 const request=k.request(true),auth=await authority.prepare(request),before=claims(k);
 const target=subject==='interpreter'?k.command:subject==='asset'?path.join(k.dir,'fixture-resource.txt'):subject==='config'?k.configDir:subject==='parent'?k.recordPath:k.entry;
 const previous=subject==='config'?undefined:statSync(target);
 const lock=path.join(realpathSync(k.budget.directory),'admission.lock'),script=path.join(k.dir,'lock-holder.mjs');
 writeFileSync(script,`
 import fs from 'node:fs';
 const [lock,signal,proof,mutated,target,subject]=process.argv.slice(2),token='test-real-lock-holder';
 fs.mkdirSync(lock,{mode:0o700});fs.writeFileSync(lock+'/owner.json',JSON.stringify({pid:process.pid,token}));
 const release=()=>{try{if(JSON.parse(fs.readFileSync(lock+'/owner.json','utf8')).token===token)fs.rmSync(lock,{recursive:true});}catch{}};
 const timeout=setTimeout(()=>{release();process.exit(2)},5000);
 const timer=setInterval(()=>{
  if(!fs.existsSync(signal))return;
  if(!fs.existsSync(proof)){release();process.exit(3)}
  if(subject==='parent'){const record=JSON.parse(fs.readFileSync(target,'utf8'));record.testLockReplacement=true;fs.writeFileSync(target,JSON.stringify(record));}
  else if(subject==='config'){fs.renameSync(target,target+'.old');fs.mkdirSync(target,{mode:0o700});}
  else {const stat=fs.statSync(target);fs.renameSync(target,target+'.old');if(subject==='artifact-symlink')fs.symlinkSync(target+'.old',target);else{fs.copyFileSync(target+'.old',target);fs.chmodSync(target,stat.mode&0o777);fs.utimesSync(target,stat.atime,stat.mtime);}}
  fs.writeFileSync(mutated,'replaced');clearInterval(timer);clearTimeout(timeout);release();process.exit(0);
 },1);
 process.stdout.write('ready\\n');
 `);
 const holder=spawn(process.execPath,[script,lock,signal,proof,mutated,target,subject],{stdio:['ignore','pipe','pipe']});
 const holderClose=once(holder,'close');let stderr='';holder.stderr.on('data',data=>stderr+=data);
 const mkdir=fs.mkdirSync;
 let waited=false;
 let restore=()=>{};
 try{
  const [ready]=await once(holder.stdout,'data');expect(String(ready)).toBe('ready\n');
  const owner=JSON.parse(readFileSync(path.join(lock,'owner.json'),'utf8'));expect(owner.pid).toBe(holder.pid);expect(()=>process.kill(owner.pid,0)).not.toThrow();
  const observer=vi.spyOn(fs,'mkdirSync').mockImplementation(((...args:Parameters<typeof fs.mkdirSync>)=>{
   try{return Reflect.apply(mkdir,fs,args);}catch(error){if(String(args[0])===lock&&(error as NodeJS.ErrnoException).code==='EEXIST'){waited=true;writeFileSync(signal,'waiting');}throw error;}
  }) as typeof fs.mkdirSync);
  syncBuiltinESMExports();restore=()=>{observer.mockRestore();syncBuiltinESMExports();};
  armed=true;
  const launched=async()=>{
   const child=await authority.spawn(auth,{command:request.command,args:request.args,cwd:request.cwd,prompt:request.prompt,env:auth.env});
   const close=once(child,'close');child.stdin.end('');await close;await authority.settled(child);
  };
  let failure:unknown;try{await launched();}catch(error){failure=error;}
  expect(waited).toBe(true);expect(readFileSync(proof,'utf8')).toBe('complete');expect(readFileSync(mutated,'utf8')).toBe('replaced');
  const [code]=await holderClose;expect(code,stderr).toBe(0);
  if(previous&&subject!=='parent'&&subject!=='artifact-symlink'){expect(statSync(target).mtimeMs).toBe(previous.mtimeMs);expect(statSync(target).ino).not.toBe(previous.ino);}
  expect(failure).toBeInstanceOf(Error);expect((failure as Error).message).toContain(subject==='config'?'external_cli_config_directory_changed':subject==='parent'?'external_cli_parent_record_changed':'external_cli_identity_install_record_mismatch');
  expect(k.tasks()).toEqual([]);expect(claims(k)).toBe(before);
  const tasks=readdirSync(path.join(k.budget.directory,'custody-external')).map(n=>JSON.parse(readFileSync(path.join(k.budget.directory,'custody-external',n),'utf8'))).filter(row=>row.kind==='task');
  expect(tasks).toEqual([]);
 }finally{restore();if(holder.exitCode===null)holder.kill('SIGKILL');await holderClose;}
});

it('checks cancellation again after locked tuple I/O before consuming a permit or spawning',async()=>{
 const k=await sixthEdgeKit({native:true});kits.push(k);const control=new AbortController();let armed=false,checked=false;
 const probe={...ownershipProbe,lstatSync(target:string){const stat=ownershipProbe.lstatSync!(target);if(armed){checked=true;control.abort();}return stat;}};
 const authority=new ExternalCliCustodyAuthority(k.parent,k.budget,k.installations,{},probe,k.recordPath),request=k.request(true);
 const auth=await authority.prepare(request,{signal:control.signal}),before=claims(k);armed=true;
 await expect(authority.spawn(auth,{command:request.command,args:request.args,cwd:request.cwd,prompt:request.prompt,env:auth.env})).rejects.toThrow('external_cli_cancelled');
 expect(checked).toBe(true);expect(k.tasks()).toEqual([]);expect(claims(k)).toBe(before);
 const tasks=readdirSync(path.join(k.budget.directory,'custody-external')).map(n=>JSON.parse(readFileSync(path.join(k.budget.directory,'custody-external',n),'utf8'))).filter(row=>row.kind==='task');
 expect(tasks).toEqual([]);
});


it('refuses prepare-time abort during locked tuple I/O before creating any probe child or claim',async()=>{
 const k=await sixthEdgeKit({native:true});kits.push(k);const control=new AbortController();let checked=false;
 const probe={...ownershipProbe,lstatSync(target:string){const stat=ownershipProbe.lstatSync!(target);checked=true;control.abort();return stat;}};
 const authority=new ExternalCliCustodyAuthority(k.parent,k.budget,k.installations,{},probe,k.recordPath),before=claims(k);
 const native=vi.spyOn(childProcess,'spawn');syncBuiltinESMExports();
 try{
  await expect(authority.prepare(k.request(true),{signal:control.signal})).rejects.toThrow('external_cli_cancelled');
  expect(checked).toBe(true);expect(native).not.toHaveBeenCalled();expect(claims(k)).toBe(before);expect(k.tasks()).toEqual([]);
  expect(readdirSync(path.join(k.budget.directory,'custody-external'))).toEqual([]);
 }finally{native.mockRestore();syncBuiltinESMExports();}
});
