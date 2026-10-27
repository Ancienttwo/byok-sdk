import { PASS_INSPECTIONS, runtimeReclaimedBytes } from '../daemon/retention/runtime-accounting';
import { acquirePathMutationGate, PathMutationGateBusyError } from '../daemon/path-mutation-gate';
import { projectSkillPack } from '../daemon/skill-pack-installer';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentHomeManager } from '../agent-home';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal';
import { journalHash, type JournalIdentity } from '../daemon/journal/journal';
import { acquireReplicaLock } from '../adapters/pi-durable/replica';
import { defaultScratchRoot, ScratchRoot, ScratchRootPathError, validateScratchRoot } from '../daemon/retention/scratch';
import { createRetentionRegistry } from '../daemon/retention/producers';
import { RetentionSweeper } from '../daemon/retention/sweeper';
import { StoragePressure } from '../daemon/retention/pressure';
import { resolveStorageConfig, type StorageBudgetInput } from '../daemon/retention/config';
import { EXPIRING_CLASS_IDS, PROTECTED_CLASS_IDS, RetentionRegistry, type SweepBudget, type RetentionClassId, type ClassUsage, type ClassAuthority } from '../daemon/retention/registry';
import { createDaemonWithAdapters } from '../daemon/create-daemon';
import { createSupportBundle } from '../diagnostics/support-bundle';
import { testScratchRoot, testExecutionScratch } from './fixtures/execution-scratch';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';
const cleanups: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();vi.restoreAllMocks();});
const DAY=86_400_000;
const identity:JournalIdentity={productId:'retention',tenantId:'tenant',deviceId:'device'};
async function fixture(input:{max?:number;journal?:SqliteLocalTaskJournal;home?:AgentHomeManager;store?:string;budget?:StorageBudgetInput;freeBytes?:number;usageScanLimit?:number}={}) {
 const store=input.store??testScratchRoot();let time=Date.parse('2026-10-14T00:00:00.000Z');const clock=()=>new Date(time);
 const config=resolveStorageConfig(store,{scratchRoot:testScratchRoot(),retention:{maxDeletionsPerPass:input.max??256},...(input.budget?{budget:input.budget}:{})});
 const scratch=new ScratchRoot(config.scratchRoot,clock);await scratch.open(store);
 const registry=createRetentionRegistry({storeDir:store,scratch,config,clock,journal:()=>input.journal,identity:()=>identity,preparation:()=>undefined,
  ...(input.home?{home:input.home,handoffs:new AgentSessionHandoffStore()}:{}),...(input.usageScanLimit===undefined?{}:{usageScanLimit:input.usageScanLimit})});
 const pressure=new StoragePressure(config.budget),failures:string[]=[];
 const sweeper=new RetentionSweeper({registry,config,clock,pressure,freeBytes:async()=>input.freeBytes??1_000_000_000,jitter:(_s,ms)=>ms,onFailure:(_t,id,code)=>{failures.push(`${id}:${code}`);}});
 cleanups.push(()=>sweeper.stop());return {store,scratch,sweeper,registry,pressure,failures,config,clock,advance:(ms:number)=>{time+=ms;}};
}
const usage=(f:{sweeper:RetentionSweeper},id:RetentionClassId)=>f.sweeper.snapshot().classes.find(entry=>entry.classId===id)!;
const resultName=(n:number)=>`result-${n.toString(16).padStart(64,'0')}.json`;
async function stamp(file:string,iso:string){const when=new Date(iso);await fs.utimes(file,when,when);}
async function idleHome(files=0){
 const home=new AgentHomeManager({hostStorageRoot:testScratchRoot()}),binding=await home.prepare({agentId:'agent',profileRevision:'1'}),directory=binding.resolution.canonicalHome;
 for(let index=0;index<files;index++)await fs.writeFile(path.join(directory,`file-${index}`),'x');
 return {home,binding,directory,results:path.join(directory,'.byok','results')};
}
const exists=(file:string)=>fs.lstat(file).then(()=>true,(error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return false;throw error;});
async function old(file:string){const when=new Date('2026-10-01T00:00:00Z');await fs.utimes(file,when,when);}
async function terminal(journal:SqliteLocalTaskJournal,taskId:string,state:'pending'|'confirmed',at='2026-09-01T00:00:00.000Z') {
 const bytes=JSON.stringify({taskId});await journal.appendEnvelope({identity,taskId,envelopeId:taskId,seq:1,bytes,bytesHash:journalHash(bytes),receivedAt:at,opensTask:true});
 await journal.recordTerminal({taskId,terminalType:'complete',bytes,payloadHash:journalHash(bytes),truthState:state,attempt:1,recordedAt:at});
}
it('disposal deletes SDK secrets before receipt and runtime residue expires exactly at its TTL',async()=>{
 const f=await fixture(),s=await f.scratch.create();expect(s.token).toMatch(/^[a-f0-9]{12}$/u);expect(s.env).toEqual({TMPDIR:s.runtimeDir,TEMP:s.runtimeDir,TMP:s.runtimeDir});
 await fs.writeFile(path.join(s.sdkDir,'mcp-config.json'),'secret');await fs.writeFile(path.join(s.runtimeDir,'output'),'output');
 await f.sweeper.runPass('periodic');expect(await exists(s.sdkDir)).toBe(true);await s.release();expect(await exists(s.sdkDir)).toBe(false);
 f.advance(DAY-1);await f.sweeper.runPass('periodic');expect(await exists(s.runtimeDir)).toBe(true);
 f.advance(1);await f.sweeper.runPass('periodic');expect(await exists(s.runtimeDir)).toBe(false);
});
it('crash residue begins runtime TTL at restart, regardless of its old directory mtime',async()=>{
 const f=await fixture(),s=await f.scratch.create();f.scratch.abandon(s.token);f.advance(3*DAY);
 await f.sweeper.runPass('startup');expect(await exists(s.sdkDir)).toBe(false);expect(await exists(s.runtimeDir)).toBe(true);
 f.advance(DAY-1);await f.sweeper.runPass('periodic');expect(await exists(s.runtimeDir)).toBe(true);
 f.advance(1);await f.sweeper.runPass('periodic');expect(await exists(s.runtimeDir)).toBe(false);
});
it('cleanup failure stays typed and keeps live ownership until retry completes',async()=>{
 const f=await fixture(),s=await f.scratch.create(),original=fs.rm;
 const spy=vi.spyOn(fs,'rm').mockImplementationOnce(async()=>{throw Object.assign(new Error('busy'),{code:'EBUSY'});});
 await expect(s.release()).rejects.toMatchObject({name:'RuntimeDisposalFailure',stage:'cleanup'});expect(f.scratch.isLive(s.token)).toBe(true);
 spy.mockImplementation(original);await s.release();expect(f.scratch.isLive(s.token)).toBe(false);
});
it('bounded startup refuses capability publication when any secret-bearing SDK directory remains',async()=>{
 const f=await fixture({max:1}),a=await f.scratch.create(),b=await f.scratch.create();f.scratch.abandon(a.token);f.scratch.abandon(b.token);
 await expect(f.sweeper.runPass('startup')).rejects.toThrow('retention_startup_incomplete');expect(f.sweeper.snapshot().lastSweep).toMatchObject({truncated:true,failures:1});
});
it('external-root ownership and symlink checks preserve unrelated data',async()=>{
 const f=await fixture(),s=await f.scratch.create();await expect(new ScratchRoot(f.scratch.root).open(testScratchRoot())).rejects.toThrow(ScratchRootPathError);
 const alias=path.join(testScratchRoot(),'alias');await fs.symlink(f.scratch.root,alias);await expect(new ScratchRoot(alias).create()).rejects.toThrow(ScratchRootPathError);
 expect(await exists(s.sdkDir)).toBe(true);await s.release();
});
it.skipIf(process.getuid===undefined)('refuses a different reported UID before chmod in an isolated child',async()=>{
 const root=testScratchRoot();await fs.chmod(root,0o755);
 // Only the child-reported UID is injected. The OS identity and filesystem
 // metadata stay real; this proves mutation order, not OS multi-user isolation.
 const script=`
  import {promises as fs,readFileSync} from 'node:fs';
  import {createRequire,registerHooks} from 'node:module';
  // Node 26 removed native TS transforms. Use the build tool's existing
  // compiler to load real source, including constructor parameter properties.
  const {transformSync}=createRequire(import.meta.resolve('tsup'))('esbuild');
  registerHooks({load(url,context,nextLoad){
   if(!url.endsWith('.ts'))return nextLoad(url,context);
   return {format:'module',shortCircuit:true,source:transformSync(readFileSync(new URL(url),'utf8'),{loader:'ts',format:'esm',sourcefile:url}).code};
  }});
  const {ScratchRoot}=await import(${JSON.stringify(new URL('../daemon/retention/scratch.ts',import.meta.url).href)});
  const root=${JSON.stringify(root)},uid=process.getuid();process.getuid=()=>uid+1;
  const chmod=fs.chmod;let chmodCalls=0;fs.chmod=async(...args)=>{chmodCalls++;return chmod(...args);};
  let error;try{await new ScratchRoot(root).create();}catch(cause){error={name:cause.name,message:cause.message};}
  console.log(JSON.stringify({error,chmodCalls,mode:(await fs.lstat(root)).mode&0o777}));
 `;
 const {stdout}=await promisify(execFile)(process.execPath,['--import',new URL('./fixtures/ts-source-resolve-hook.mjs',import.meta.url).href,'--input-type=module','-e',script]);
 expect(JSON.parse(stdout)).toEqual({error:{name:'ScratchRootPathError',message:'DaemonConfig.storage.scratchRoot is owned by another user'},chmodCalls:0,mode:0o755});
 expect((await fs.lstat(root)).mode&0o777).toBe(0o755);expect(await exists(path.join(root,'owner.json'))).toBe(false);
});
it('claims an existing store-owned tmp namespace using canonical filesystem ancestry',async()=>{
 const store=testScratchRoot();
 await fs.mkdir(path.join(store,'tmp','daemon'),{recursive:true});
 await fs.writeFile(path.join(store,'tmp','daemon','diagnostic'),'protected startup artifact');
 const configuredStore=process.platform==='win32'?store.toUpperCase():store;
 const scratch=new ScratchRoot(path.join(configuredStore,'tmp'));await scratch.open(store);
 const execution=await scratch.create();await execution.release();
 expect(await fs.readFile(path.join(store,'tmp','daemon','diagnostic'),'utf8')).toBe('protected startup artifact');
});
it('default journal retention discovers old confirmed rows and protects unconfirmed and recovery-marked closure',async()=>{
 const store=testScratchRoot(),journal=new SqliteLocalTaskJournal({storeDir:store});cleanups.push(()=>journal.close());
 await terminal(journal,'expired','confirmed');await terminal(journal,'pending','pending');await terminal(journal,'marked','confirmed');await journal.markRecovered('marked',{disposition:'interrupted'});
 await terminal(journal,'recent','confirmed','2026-10-13T00:00:00.000Z');const f=await fixture({store,journal});await f.sweeper.runPass('startup');
 expect(await journal.readTask('expired',identity)).toBeUndefined();for(const id of ['pending','marked','recent'])expect(await journal.readTask(id,identity)).toBeDefined();
 expect(await journal.pruneConfirmedJournalTask('marked')).toBe(false);
});
it('locked and unknown replicas survive; journal-terminal replicas require an exclusive lock before deletion',async()=>{
 const store=testScratchRoot(),journal=new SqliteLocalTaskJournal({storeDir:store});cleanups.push(()=>journal.close());await terminal(journal,'locked','pending');await terminal(journal,'closed','pending');
 const root=path.join(store,'durable-replicas','a'.repeat(64));await fs.mkdir(root,{recursive:true});const files=Object.fromEntries(['locked','closed','unknown'].map(id=>[id,path.join(root,`durable-${id}.sqlite`)]));
 for(const file of Object.values(files))await fs.writeFile(file,'transcript');const lock=await acquireReplicaLock(files.locked!,'test');cleanups.push(async()=>lock.release());
 const f=await fixture({store,journal});await f.sweeper.runPass('startup');expect(await exists(files.locked!)).toBe(true);expect(await exists(files.unknown!)).toBe(true);expect(await exists(files.closed!)).toBe(false);
});
it('home maintenance shares the Attempt base lease, preserves tombstones and releases reservations on corrupt-marker refusal',async()=>{
 const home=new AgentHomeManager({hostStorageRoot:testScratchRoot()}),binding=await home.prepare({agentId:'agent',profileRevision:'1'}),directory=binding.resolution.canonicalHome;
 const temp=path.join(directory,'.byok-memory-12345678-1234-1234-1234-123456789012.tmp'),tombstone=path.join(directory,'.byok-memory-delete-12345678-1234-1234-1234-123456789012.tmp');
 await fs.writeFile(temp,'pending');await fs.writeFile(tombstone,'evidence');await old(temp);await old(tombstone);const f=await fixture({home});
 await f.sweeper.runPass('periodic');expect(await exists(temp)).toBe(true);await binding.lease.release();await f.sweeper.runPass('periodic');expect(await exists(temp)).toBe(false);expect(await exists(tombstone)).toBe(true);
 await fs.writeFile(temp,'pending');await old(temp);const marker=path.join(directory,'.byok','agent-home.lease');await fs.writeFile(marker,'invalid');
 expect((await f.sweeper.runPass('periodic')).failures).toBeGreaterThan(0);expect(await exists(temp)).toBe(true);await fs.rm(marker);expect(await home.withIdleHomeLease('agent',async()=>{})).toBe(true);await f.sweeper.runPass('periodic');await f.sweeper.runPass('periodic');expect(await exists(temp)).toBe(false);
});
it('idle homes lose result records past the TTL or the 256-record bound; a leased home and other names keep theirs',async()=>{
 const {home,binding,results}=await idleHome();await fs.mkdir(results,{recursive:true});
 const expired=path.join(results,resultName(0)),expiredTemp=path.join(results,`${resultName(1)}.123-4.tmp`),freshTemp=path.join(results,`${resultName(2)}.123-5.tmp`);
 const other=path.join(results,'notes.json'),nested=path.join(results,resultName(3)),link=path.join(results,resultName(4)),outside=path.join(testScratchRoot(),'outside.json');
 await fs.writeFile(expired,'{malformed');await fs.writeFile(expiredTemp,'partial');await fs.writeFile(freshTemp,'partial');await fs.writeFile(other,'{}');
 await fs.mkdir(nested);await fs.writeFile(path.join(nested,'inner'),'x');await fs.writeFile(outside,'{}');await fs.symlink(outside,link);
 for(const file of [expired,expiredTemp,other,nested,outside])await old(file);
 const fresh=Array.from({length:258},(_,index)=>path.join(results,resultName(16+index)));
 for(const [index,file] of fresh.entries()){await fs.writeFile(file,'{}');await stamp(file,new Date(Date.parse('2026-10-13T00:00:00Z')+index*1000).toISOString());}
 await stamp(freshTemp,'2026-10-13T00:00:00Z');
 const f=await fixture({home});
 expect(f.registry.classes.find(entry=>entry.id==='agent-result')!.authority).toMatchObject({owner:'sdk',scope:'agent-home',ttlMs:7*DAY,maxEntries:256});
 await f.sweeper.runPass('periodic');expect(usage(f,'agent-result')).toMatchObject({measured:true,truncated:false,entries:261});
 for(const file of [expired,expiredTemp,fresh[0]!])expect(await exists(file)).toBe(true);
 await binding.lease.release();for(let pass=0;pass<3;pass++)await f.sweeper.runPass('periodic');
 for(const file of [expired,expiredTemp,fresh[0]!,fresh[1]!])expect(await exists(file)).toBe(false);
 for(const file of [freshTemp,other,nested,link,outside,...fresh.slice(2)])expect(await exists(file)).toBe(true);
 expect(usage(f,'agent-result')).toMatchObject({entries:257});expect(f.failures).toEqual([]);
});
it('result retention keeps sweeping under pressure while old home temps wait',async()=>{
 const {binding,directory,results,home}=await idleHome();await binding.lease.release();await fs.mkdir(results,{recursive:true});
 const record=path.join(results,resultName(0)),temp=path.join(directory,'.byok-memory-12345678-1234-1234-1234-123456789012.tmp');
 await fs.writeFile(record,'{}');await fs.writeFile(temp,'pending');await old(record);await old(temp);
 const f=await fixture({home,budget:{maxStoreBytes:1_000_000_000,minFreeBytes:100_000,ackCriticalReserveBytes:10_000},freeBytes:150_000});
 await f.sweeper.runPass('periodic');expect(f.pressure.state).toBe('pressure');expect(await exists(record)).toBe(false);expect(await exists(temp)).toBe(true);
});
it.skipIf(process.platform==='win32')('a result directory replaced by a symbolic link fails the sweep and removes nothing behind it',async()=>{
 const {binding,results,home}=await idleHome();await binding.lease.release();
 const target=testScratchRoot(),record=path.join(target,resultName(0));await fs.writeFile(record,'{}');await old(record);
 await fs.rm(results,{recursive:true,force:true});await fs.symlink(target,results);
 const f=await fixture({home});await f.sweeper.runPass('periodic');expect(f.failures).toContain('agent-result:sweep_failed');expect(await exists(record)).toBe(true);
});
it('a usage walk past its entry limit reports lower bounds per root without failing startup or latching emergency',async()=>{
 const budget={maxStoreBytes:1_000_000,minFreeBytes:100_000,ackCriticalReserveBytes:10_000};
 const store=testScratchRoot();await fs.writeFile(path.join(store,'daemon.db'),'x'.repeat(2000));
 const {binding,home}=await idleHome(40);await binding.lease.release();
 const f=await fixture({store,home,budget,usageScanLimit:20});
 expect((await f.sweeper.runPass('startup')).failures).toBe(0);expect(f.failures).toEqual([]);expect(f.pressure.state).toBe('normal');
 expect(usage(f,'journal')).toMatchObject({measured:true,truncated:false,bytes:2000});expect(usage(f,'exec-sdk')).toMatchObject({measured:true,truncated:false});
 expect(usage(f,'agent-content')).toMatchObject({truncated:true});expect(usage(f,'agent-content').entries).toBeLessThan(20);
 expect(usage(f,'agent-result')).toMatchObject({measured:true,truncated:true});
 const early=testScratchRoot();await fs.writeFile(path.join(early,'daemon.db'),'x');
 const other=await idleHome(1);await other.binding.lease.release();
 const g=await fixture({store:early,home:other.home,budget,usageScanLimit:1});expect((await g.sweeper.runPass('startup')).failures).toBe(0);
 expect(usage(g,'journal')).toMatchObject({measured:true,truncated:true,bytes:0});expect(usage(g,'store-authority')).toMatchObject({measured:true,truncated:true});
 for(const id of ['exec-sdk','agent-result','agent-content','reader-run'] as const)expect(usage(g,id)).toMatchObject({measured:false,truncated:true});
 expect(usage(g,'confirmed-journal')).toMatchObject({truncated:false});
});
it('a skill-pack listing past the entry limit leaves every walked class unreached while old revisions still expire',async()=>{
 const f=await fixture({usageScanLimit:1}),root=path.join(f.store,'skill-packs','known'),current=path.join(root,'a'.repeat(64)),prior=path.join(root,'b'.repeat(64));
 await fs.mkdir(current,{recursive:true});await fs.mkdir(prior);await fs.writeFile(path.join(current,'current'),'keep');await fs.writeFile(path.join(prior,'old'),'remove');await old(prior);
 await fs.writeFile(path.join(root,'lock.json'),JSON.stringify({schema:'byok-skill-pack-lock-v1',name:'known',content_hash:'sha256:'+'a'.repeat(64),files:[]}));
 await fs.mkdir(path.join(f.store,'skill-packs','unknown'));
 expect((await f.sweeper.runPass('startup')).failures).toBe(0);expect(f.failures).toEqual([]);
 for(const id of ['skill-pack-current','skill-pack-old','journal','exec-sdk'] as const)expect(usage(f,id)).toMatchObject({measured:false,truncated:true,bytes:0});
 expect(await exists(prior)).toBe(false);expect(await exists(current)).toBe(true);
});
it('a truncated lower bound above the hard watermark still refuses admission',async()=>{
 const store=testScratchRoot();await fs.writeFile(path.join(store,'big'),'x'.repeat(2000));
 const {binding,home}=await idleHome(40);await binding.lease.release();
 const f=await fixture({store,home,budget:{maxStoreBytes:1000,minFreeBytes:100_000,ackCriticalReserveBytes:10_000},usageScanLimit:20});
 await f.sweeper.runPass('startup');expect(usage(f,'agent-content').truncated).toBe(true);expect(f.pressure.state).toBe('hard-pressure');expect(f.pressure.admissionGuard().admit).toBe(false);
});
it.skipIf(process.platform==='win32'||process.getuid?.()===0)('a real walk error still latches emergency and fails startup; a later truncated measurement clears the latch',async()=>{
 const store=testScratchRoot(),locked=path.join(store,'locked');await fs.mkdir(locked);await fs.chmod(locked,0o000);cleanups.push(()=>fs.chmod(locked,0o700));
 const {binding,home}=await idleHome(40);await binding.lease.release();
 const f=await fixture({store,home,budget:{maxStoreBytes:1_000_000,minFreeBytes:100_000,ackCriticalReserveBytes:10_000},usageScanLimit:20});
 await expect(f.sweeper.runPass('startup')).rejects.toMatchObject({code:'EACCES'});expect(f.pressure.state).toBe('emergency');expect(f.failures).toContain('store-authority:measurement_failed');
 await fs.chmod(locked,0o700);await f.sweeper.runPass('periodic');expect(usage(f,'agent-content').truncated).toBe(true);expect(f.pressure.state).toBe('normal');
});
it('agent-result TTL defaults to seven days and accepts any non-negative integer',()=>{
 const store=testScratchRoot();expect(resolveStorageConfig(store).ttlMs['agent-result']).toBe(7*DAY);
 expect(resolveStorageConfig(store,{retention:{ttlMs:{'agent-result':0}}}).ttlMs['agent-result']).toBe(0);
 for(const value of [-1,1.5])expect(()=>resolveStorageConfig(store,{retention:{ttlMs:{'agent-result':value}}})).toThrow('DaemonConfig.storage.retention.ttlMs.agent-result is invalid');
});
it('a daemon runs a jittered retention timer and reports path-free classes in status and support bundle',async()=>{
 const server=await TestServer.start();cleanups.push(()=>server.close());let handler:(()=>void)|undefined;const delays:number[]=[];
 const config={localAgentRelease:{version:'0.0.0-test'},productName:'Retention',productId:'retention',serverUrl:server.url,storeDir:testScratchRoot(),storage:{scratchRoot:testScratchRoot()}};
 const daemon=createDaemonWithAdapters(config,[new StubRuntimeAdapter()],{retention:{timers:{setTimeout:(h,ms)=>{handler=h;delays.push(ms);return 'timer';},clearTimeout:()=>{}}}});
 cleanups.push(()=>daemon.stop());await daemon.pair('pairing-code');await daemon.start();expect(delays[0]).toBeGreaterThanOrEqual(675_000);expect(delays[0]).toBeLessThanOrEqual(1_125_000);
 expect(daemon.status().storage.classes).toHaveLength(23);handler!();await vi.waitFor(()=>expect(daemon.status().storage.lastSweep?.trigger).toBe('periodic'));
 const bundle=await createSupportBundle(config,config.storeDir);expect(bundle.storage.classes).toHaveLength(23);expect(bundle.storage.lastSweep?.trigger).toBe('periodic');
 expect(JSON.stringify(bundle.storage)).not.toContain(config.storeDir);expect(JSON.stringify(bundle.storage)).not.toContain(config.storage.scratchRoot);
});
it('uses newly measured pressure for maintenance even when the timer fired as periodic',async()=>{
 const prepare=vi.fn(async()=>{}),measure=async(id:RetentionClassId):Promise<ClassUsage>=>({classId:id,protected:PROTECTED_CLASS_IDS.includes(id as never),measured:true,truncated:false,bytes:0,entries:0,oldestAgeMs:null});
 const authority:ClassAuthority={roots:[],owner:'sdk',scope:'store'};
 const registry=new RetentionRegistry([...EXPIRING_CLASS_IDS.map(id=>({id,authority,measure:()=>measure(id),sweep:async()=>{}})),...PROTECTED_CLASS_IDS.map(id=>({id,authority,measure:()=>measure(id)}))],async()=>{},()=>{},prepare);
 const config=resolveStorageConfig(testScratchRoot(),{budget:{maxStoreBytes:1_000_000,minFreeBytes:100_000,ackCriticalReserveBytes:10_000}});
 const sweeper=new RetentionSweeper({registry,config,pressure:new StoragePressure(config.budget),freeBytes:async()=>50_000,jitter:(_s,ms)=>ms});
 await sweeper.runPass('periodic');expect(prepare).toHaveBeenCalledWith(expect.objectContaining({trigger:'periodic'}),true);await sweeper.stop();
});
it('passes serialize and stop waits for an in-flight pass before releasing maintenance resources',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const order:string[]=[];
 const measure=async(id:RetentionClassId):Promise<ClassUsage>=>{await gate;return {classId:id,protected:PROTECTED_CLASS_IDS.includes(id as never),measured:true,truncated:false,bytes:0,entries:0,oldestAgeMs:null};};
 const authority: ClassAuthority={roots:[],owner:'sdk',scope:'store'};
 const registry=new RetentionRegistry([...EXPIRING_CLASS_IDS.map(id=>({id,authority,measure:()=>measure(id),sweep:async()=>{}})),...PROTECTED_CLASS_IDS.map(id=>({id,authority,measure:()=>measure(id)}))],async()=>{order.push('closed');});
 const sweeper=new RetentionSweeper({registry,config:resolveStorageConfig(testScratchRoot()),pressure:new StoragePressure(),freeBytes:async()=>1_000_000,jitter:(_s,ms)=>ms});
 const pass=sweeper.runPass('periodic');expect(sweeper.runPass('pressure')).toBe(pass);let stopped=false;const stop=sweeper.stop().then(()=>{stopped=true;});await Promise.resolve();expect(stopped).toBe(false);
 release();await pass;await stop;expect(order).toEqual(['closed']);
});
it('real pinned Pi bash writes truncated output under the managed runtime directory',async()=>{
 const s=await testExecutionScratch(),entry=await fs.realpath(path.resolve(import.meta.dirname,'../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js'));
 const command=`${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(100000))"`;
 const script=`import {createBashTool} from ${JSON.stringify(entry)};const result=await createBashTool(process.cwd()).execute('truncation',{command:${JSON.stringify(command)}});console.log(JSON.stringify(result.details));`;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env:{...process.env,...s.env},maxBuffer:1_000_000});
 const detail=JSON.parse(stdout);expect(detail.fullOutputPath.startsWith(s.runtimeDir+path.sep)).toBe(true);expect((await fs.stat(detail.fullOutputPath)).size).toBe(100_000);
 await s.release();expect(await exists(detail.fullOutputPath)).toBe(true);
});
it('old skill revisions expire while the authoritative current lock and unknown packs stay protected',async()=>{
 const f=await fixture(),root=path.join(f.store,'skill-packs','known'),current=path.join(root,'a'.repeat(64)),prior=path.join(root,'b'.repeat(64));
 await fs.mkdir(current,{recursive:true});await fs.mkdir(prior);await fs.writeFile(path.join(current,'current'),'keep');await fs.writeFile(path.join(prior,'old'),'remove');await old(prior);
 await fs.writeFile(path.join(root,'lock.json'),JSON.stringify({schema:'byok-skill-pack-lock-v1',name:'known',content_hash:'sha256:'+'a'.repeat(64),files:[]}));
 const unknown=path.join(f.store,'skill-packs','unknown','c'.repeat(64));await fs.mkdir(unknown,{recursive:true});await old(unknown);
 await f.sweeper.runPass('periodic');expect(await exists(prior)).toBe(false);expect(await exists(current)).toBe(true);expect(await exists(unknown)).toBe(true);
});
it('projection and maintenance honor the same skill publication gate',async()=>{
 const f=await fixture(),root=path.join(f.store,'skill-packs');await fs.mkdir(root);
 const gate=await acquirePathMutationGate({scope:'skill-pack-store',targetPath:root});
 try { await expect(projectSkillPack(f.store,'known',testScratchRoot())).rejects.toBeInstanceOf(PathMutationGateBusyError);expect((await f.sweeper.runPass('periodic')).failures).toBe(0); }
 finally { await gate.release(); }
});
it('default scratch root leaves an application-data storeDir that is too long for runtime sockets',async()=>{
 const short='/byok-missing-root/p',long='/byok-missing-root/Library/Application Support/Product/Local Agent/'+'a'.repeat(64)+'/device';
 expect(defaultScratchRoot(short,'darwin')).toBe('/byok-missing-root/p/tmp');expect(defaultScratchRoot(long,'win32')).toBe(path.join(long,'tmp'));
 const darwin=defaultScratchRoot(long,'darwin'),linux=defaultScratchRoot(long,'linux');
 expect(darwin).toMatch(/^\/private\/tmp\/byok-scratch-[0-9a-f]{16}$/u);expect(linux).toBe(darwin.replace('/private/tmp','/tmp'));
 expect(defaultScratchRoot(long+'/','darwin')).toBe(darwin);expect(defaultScratchRoot(long+'2','darwin')).not.toBe(darwin);
 expect(validateScratchRoot(darwin,'darwin')).toBe(darwin);expect(validateScratchRoot(linux,'linux')).toBe(linux);
 expect(()=>validateScratchRoot(path.join(long,'tmp'),'darwin')).toThrow(/: \d+ bytes, darwin allows at most 61;/u);
 expect(()=>validateScratchRoot('/'+'r'.repeat(65),'linux')).toThrow(/66 bytes, linux allows at most 65;/u);
 expect(validateScratchRoot('/'+'r'.repeat(64),'linux')).toBe('/'+'r'.repeat(64));
});
it.skipIf(process.platform==='win32')('every alias of a long store selects the same default scratch root',async()=>{
 const base=testScratchRoot(),store=path.join(base,'Application Support','Product','Local Agent','a'.repeat(64),'device'),alias=path.join(base,'alias'),longAlias=path.join(base,'a'.repeat(64));
 await fs.mkdir(store,{recursive:true});await fs.symlink(store,alias);await fs.symlink(store,longAlias);
 const expected=defaultScratchRoot(store);expect(expected).toMatch(/byok-scratch-[0-9a-f]{16}$/u);
 expect(defaultScratchRoot(alias)).toBe(expected);expect(defaultScratchRoot(longAlias)).toBe(expected);expect(defaultScratchRoot(await fs.realpath(store))).toBe(expected);
 expect(defaultScratchRoot(path.join(alias,'later'))).toBe(defaultScratchRoot(path.join(store,'later')));
});
it.skipIf(process.platform==='win32')('a short canonical store keeps its natural root and refuses an overlong alias',async()=>{
 const store=testScratchRoot(),alias=path.join(testScratchRoot(),'a'.repeat(64));await fs.symlink(store,alias);
 expect(defaultScratchRoot(store)).toBe(path.join(store,'tmp'));
 expect(()=>defaultScratchRoot(alias)).toThrow(/is too long for runtime Unix sockets/u);
 const shortAlias=path.join(testScratchRoot(),'alias');await fs.symlink(store,shortAlias);
 await expect(new ScratchRoot(defaultScratchRoot(shortAlias)).open(shortAlias)).rejects.toThrow(/symbolic link/u);
});
it.skipIf(process.platform==='win32')('restart through a long store alias reclaims the original scratch secrets and runtime residue',async()=>{
 const store=path.join(testScratchRoot(),'s'.repeat(64)),alias=path.join(testScratchRoot(),'alias');await fs.mkdir(store);await fs.symlink(store,alias);
 let time=Date.parse('2026-10-14T00:00:00Z');const clock=()=>new Date(time),config=resolveStorageConfig(store),scratch=new ScratchRoot(config.scratchRoot,clock);
 cleanups.push(()=>fs.rm(config.scratchRoot,{recursive:true,force:true}));await scratch.open(store);const execution=await scratch.create();
 await fs.writeFile(path.join(execution.sdkDir,'mcp-config.json'),'secret');await fs.writeFile(path.join(execution.runtimeDir,'output'),'residue');scratch.abandon(execution.token);
 const restartConfig=resolveStorageConfig(alias),restart=new ScratchRoot(restartConfig.scratchRoot,clock);await restart.open(alias);
 const registry=createRetentionRegistry({storeDir:alias,scratch:restart,config:restartConfig,clock,journal:()=>undefined,identity:()=>undefined,preparation:()=>undefined});
 const sweeper=new RetentionSweeper({registry,config:restartConfig,clock,pressure:new StoragePressure(),freeBytes:async()=>1_000_000_000,jitter:(_s,ms)=>ms});cleanups.push(()=>sweeper.stop());
 expect((await sweeper.runPass('startup')).failures).toBe(0);expect(await exists(execution.sdkDir)).toBe(false);expect(await exists(execution.runtimeDir)).toBe(true);
 time+=DAY;expect((await sweeper.runPass('periodic')).failures).toBe(0);expect(await exists(execution.runtimeDir)).toBe(false);
});
it('a daemon store with a long path claims and uses its short default scratch root',async()=>{
 const store=path.join(testScratchRoot(),'Application Support','Product','Local Agent','a'.repeat(64),'device');await fs.mkdir(store,{recursive:true});
 const config=resolveStorageConfig(store);expect(config.scratchRoot).not.toBe(path.join(store,'tmp'));
 cleanups.push(()=>fs.rm(config.scratchRoot,{recursive:true,force:true}));
 const scratch=new ScratchRoot(config.scratchRoot);await scratch.open(store);const s=await scratch.create();
 expect(s.runtimeDir.startsWith(config.scratchRoot+path.sep)).toBe(true);await s.release();
 await new ScratchRoot(resolveStorageConfig(store).scratchRoot).open(store);
});

// Cleanup removes one entry per budgeted inspection across 16k+ entries: 2.8 s measured on CI, against the default 10 s limit, so this test keeps its own headroom.
it('reclaims a released runtime larger than the measurement limit across periodic passes', async () => {
 const f=await fixture(),large=await f.scratch.create(),small=await f.scratch.create();
 for(let start=0;start<16_384;start+=128) await Promise.all(Array.from({length:128},(_,offset)=>fs.writeFile(path.join(large.runtimeDir,`empty-${start+offset}`),'')));
 await fs.writeFile(path.join(small.runtimeDir,'small'),'small');
 await large.release();await small.release();f.advance(DAY+1);
 const observations=[];
 for(let pass=0;pass<5;pass++) {
  await f.sweeper.runPass('periodic');
  observations.push({pass,largeExists:await exists(large.runtimeDir),largeFiles:await fs.readdir(large.runtimeDir).then(x=>x.length,()=>0),smallExists:await exists(small.runtimeDir),errors:f.failures.filter(x=>x==='exec-runtime:sweep_failed').length});
 }
 expect(observations.some(item=>item.largeFiles<16_384)).toBe(true);
 // The first pass makes progress but spends at most the runtime share of the pass budget.
 expect(observations[0]!.largeFiles).toBeLessThan(16_384);expect(observations[0]!.largeFiles).toBeGreaterThanOrEqual(16_384-PASS_INSPECTIONS/2);
 expect(f.failures).not.toContain('exec-runtime:sweep_failed');
 expect(await exists(small.runtimeDir)).toBe(false);
 expect(await exists(large.runtimeDir)).toBe(false);
}, 30_000);

it('accounts partial runtime bytes and resumes after registry restart without counting partial tokens',async()=>{
 const f=await fixture(),s=await f.scratch.create();
 for(let i=0;i<12;i++)await fs.writeFile(path.join(s.runtimeDir,`file-${i}`),'abc');
 await s.release();f.advance(DAY);
 const marker=path.join(path.dirname(s.runtimeDir),'released'),released=await fs.readFile(marker,'utf8');
 let deleted=0,bytes=0,steps=0;
 const budget: SweepBudget={now:f.clock(),trigger:'periodic',available:()=>++steps<=5,remaining:()=>1-deleted,removed:n=>{deleted++;bytes+=n;},truncate:()=>{}};
 await f.registry.sweep('exec-runtime',budget);
 expect(deleted).toBe(0);expect(runtimeReclaimedBytes.get(budget)).toBeGreaterThan(0);expect(runtimeReclaimedBytes.get(budget)).toBeLessThan(36);
 expect(await fs.readFile(marker,'utf8')).toBe(released);
 await f.registry.close();
 const restart=createRetentionRegistry({storeDir:f.store,scratch:f.scratch,config:f.config,clock:f.clock,journal:()=>undefined,identity:()=>identity,preparation:()=>undefined});
 cleanups.push(()=>restart.close());
 for(let pass=0;pass<20&&deleted===0;pass++){steps=0;await restart.sweep('exec-runtime',budget);}
 expect(deleted).toBe(1);expect(bytes+(runtimeReclaimedBytes.get(budget)??0)).toBe(36+Buffer.byteLength(released));expect(await exists(path.dirname(s.runtimeDir))).toBe(false);
});
it('rechecks release eligibility before resuming a partial runtime cleanup',async()=>{
 const f=await fixture(),s=await f.scratch.create();
 for(let i=0;i<12;i++)await fs.writeFile(path.join(s.runtimeDir,`file-${i}`),'abc');
 await s.release();f.advance(DAY);
 let steps=0;const budget: SweepBudget={now:f.clock(),trigger:'periodic',available:()=>++steps<=5,remaining:()=>1,removed:()=>{},truncate:()=>{}};
 await f.registry.sweep('exec-runtime',budget);
 const remaining=await fs.readdir(s.runtimeDir);
 await fs.writeFile(path.join(path.dirname(s.runtimeDir),'released'),f.clock().toISOString());
 steps=0;await f.registry.sweep('exec-runtime',budget);
 expect(await fs.readdir(s.runtimeDir)).toEqual(remaining);
});
it('retains release eligibility when final token removal fails and accounts its retry once',async()=>{
 const f=await fixture(),s=await f.scratch.create();await fs.writeFile(path.join(s.runtimeDir,'payload'),'abc');await s.release();f.advance(DAY);
 const target=path.dirname(s.runtimeDir),marker=path.join(target,'released'),released=await fs.readFile(marker,'utf8');
 const realRemove=fs.rm.bind(fs);let refused=false;
 vi.spyOn(fs,'rm').mockImplementation(async(file,options)=>{
  if(file===target&&!refused){refused=true;throw Object.assign(new Error('synthetic refusal'),{code:'EACCES'});}
  return realRemove(file,options);
 });
 const first=await f.sweeper.runPass('periodic');expect(refused).toBe(true);expect(first.deleted).toBe(0);expect(first.bytesReclaimed).toBe(3);expect(first.failures).toBe(1);
 expect(await fs.readFile(marker,'utf8')).toBe(released);
 let deleted=0,bytes=0;
 for(let pass=0;pass<3;pass++){const report=await f.sweeper.runPass('periodic');deleted+=report.deleted;bytes+=report.bytesReclaimed;}
 expect(deleted).toBe(1);expect(bytes).toBe(Buffer.byteLength(released));expect(await exists(target)).toBe(false);
});
const runtimeBudget=(f:{clock:()=>Date},tally:{deleted:number;bytes:number}):SweepBudget=>({now:f.clock(),trigger:'periodic',available:()=>true,remaining:()=>1-tally.deleted,removed:n=>{tally.deleted++;tally.bytes+=n;},truncate:()=>{}});
it.skipIf(process.platform==='win32')('unlinks a symlink inside a released runtime without touching its target',async()=>{
 const f=await fixture(),s=await f.scratch.create(),outside=testScratchRoot(),keep=path.join(outside,'keep');
 await fs.writeFile(keep,'protected');const link=path.join(s.runtimeDir,'link');await fs.symlink(outside,link);const linkBytes=(await fs.lstat(link)).size;
 await s.release();f.advance(DAY);
 const target=path.dirname(s.runtimeDir),released=await fs.readFile(path.join(target,'released'),'utf8'),tally={deleted:0,bytes:0},budget=runtimeBudget(f,tally);
 await f.registry.sweep('exec-runtime',budget);
 expect(tally.deleted).toBe(1);expect((runtimeReclaimedBytes.get(budget)??0)+tally.bytes).toBe(linkBytes+Buffer.byteLength(released));
 expect(await exists(target)).toBe(false);expect(await fs.readFile(keep,'utf8')).toBe('protected');
});
it('refuses whole-token removal when payload appears after the leaf walk, then removes it on retry',async()=>{
 const f=await fixture(),s=await f.scratch.create();await fs.writeFile(path.join(s.runtimeDir,'output'),'12345');await s.release();f.advance(DAY);
 const target=path.dirname(s.runtimeDir),marker=path.join(target,'released'),released=await fs.readFile(marker,'utf8'),late=path.join(target,'late');
 const realOpendir=fs.opendir.bind(fs);let injected=false;
 const opendir=vi.spyOn(fs,'opendir').mockImplementation(async(directory,options)=>{
  const handle=await realOpendir(directory,options);
  if(directory!==target)return handle;
  // The payload lands after the token's final empty read, just before the capped whole-token removal.
  const read=handle.read.bind(handle);
  handle.read=(async()=>{const entry=await read();if(entry===null&&!injected&&!await exists(s.runtimeDir)){injected=true;await fs.writeFile(late,'new payload');}return entry;}) as typeof handle.read;
  return handle;
 });
 const rm=vi.spyOn(fs,'rm'),tally={deleted:0,bytes:0},first=runtimeBudget(f,tally);
 await expect(f.registry.sweep('exec-runtime',first)).rejects.toThrow('retention_usage_scan_limit');
 expect(injected).toBe(true);expect(rm.mock.calls.some(([file])=>file===target)).toBe(false);
 expect(runtimeReclaimedBytes.get(first)).toBe(5);expect(tally.deleted).toBe(0);
 expect(await fs.readFile(late,'utf8')).toBe('new payload');expect(await fs.readFile(marker,'utf8')).toBe(released);
 opendir.mockRestore();
 let retried=0;for(let pass=0;pass<3&&tally.deleted===0;pass++){const retry=runtimeBudget(f,tally);await f.registry.sweep('exec-runtime',retry);retried+=runtimeReclaimedBytes.get(retry)??0;}
 expect(tally.deleted).toBe(1);expect(retried+tally.bytes).toBe(Buffer.byteLength('new payload')+Buffer.byteLength(released));
 expect(await exists(target)).toBe(false);
});
it('keeps bytes already removed when a later unlink fails mid-pass, then completes on retry',async()=>{
 const f=await fixture(),s=await f.scratch.create();
 for(const name of ['one','two','three'])await fs.writeFile(path.join(s.runtimeDir,name),'12345');
 await s.release();f.advance(DAY);
 const target=path.dirname(s.runtimeDir),marker=path.join(target,'released'),released=await fs.readFile(marker,'utf8');
 const realUnlink=fs.unlink.bind(fs);let calls=0;
 const unlink=vi.spyOn(fs,'unlink').mockImplementation(async file=>{if(++calls===2)throw Object.assign(new Error('busy'),{code:'EBUSY'});return realUnlink(file);});
 const tally={deleted:0,bytes:0},first=runtimeBudget(f,tally);
 await expect(f.registry.sweep('exec-runtime',first)).rejects.toThrow('busy');
 expect(runtimeReclaimedBytes.get(first)).toBe(5);expect(tally.deleted).toBe(0);
 expect(await fs.readdir(s.runtimeDir)).toHaveLength(2);expect(await fs.readFile(marker,'utf8')).toBe(released);
 unlink.mockRestore();
 let retried=0;for(let pass=0;pass<3&&tally.deleted===0;pass++){const retry=runtimeBudget(f,tally);await f.registry.sweep('exec-runtime',retry);retried+=runtimeReclaimedBytes.get(retry)??0;}
 expect(tally.deleted).toBe(1);expect(5+retried+tally.bytes).toBe(15+Buffer.byteLength(released));
 expect(await exists(target)).toBe(false);
});
it('a large expired runtime backlog leaves pass budget for agent-result in the same pass',async()=>{
 const {home,binding,results}=await idleHome();await fs.mkdir(results,{recursive:true});
 const record=path.join(results,resultName(0));await fs.writeFile(record,'{}');await old(record);await binding.lease.release();
 const f=await fixture({home}),s=await f.scratch.create();
 for(let start=0;start<9_216;start+=128) await Promise.all(Array.from({length:128},(_,offset)=>fs.writeFile(path.join(s.runtimeDir,`empty-${start+offset}`),'')));
 await s.release();f.advance(DAY);
 const report=await f.sweeper.runPass('periodic');
 expect(report.truncated).toBe(true);expect(await exists(record)).toBe(false);
 expect((await fs.readdir(s.runtimeDir)).length).toBeGreaterThan(0);
 expect(f.failures).toEqual([]);
});
const ledgerHex=(c:string)=>c.repeat(64);
async function sessionLedgers(directory:string,files:Record<string,string>){
 const root=path.join(directory,'.byok','runtime-sessions');await fs.mkdir(root,{recursive:true});
 for(const [name,when] of Object.entries(files)){const file=path.join(root,name);await fs.writeFile(file,`{"entry":"${name}"}\n`);await stamp(file,when);}
 return root;
}
const EXPIRED='2026-09-01T00:00:00Z',FRESH='2026-10-13T00:00:00Z';
it('session ledgers expire by last append; task evidence, task-suffixed names, directories and symlinks stay',async()=>{
 const {home,binding,directory}=await idleHome();await binding.lease.release();
 const root=await sessionLedgers(directory,{[`pi-${ledgerHex('a')}.jsonl`]:EXPIRED,[`pi-${ledgerHex('b')}.jsonl`]:FRESH,[`my-task-runner-${ledgerHex('c')}.jsonl`]:EXPIRED,
  [`pi-task-${ledgerHex('d')}.jsonl`]:EXPIRED,[`x-task-${ledgerHex('e')}.jsonl`]:EXPIRED,['notes.txt']:EXPIRED});
 await fs.writeFile(path.join(root,`corrupt-${ledgerHex('f')}.jsonl`),'{not json');await stamp(path.join(root,`corrupt-${ledgerHex('f')}.jsonl`),EXPIRED);
 await fs.mkdir(path.join(root,`dir-${ledgerHex('1')}.jsonl`));
 const outside=path.join(testScratchRoot(),'outside.jsonl');await fs.writeFile(outside,'keep');
 if(process.platform!=='win32')await fs.symlink(outside,path.join(root,`link-${ledgerHex('2')}.jsonl`));
 const f=await fixture({home});
 expect(f.registry.classes.find(entry=>entry.id==='session-ledger')!.authority).toEqual(expect.objectContaining({owner:'sdk',scope:'agent-home',ttlMs:30*DAY}));
 expect(f.registry.classes.find(entry=>entry.id==='session-ledger')!.authority).not.toHaveProperty('maxEntries');
 const report=await f.sweeper.runPass('periodic');
 expect(usage(f,'session-ledger')).toMatchObject({measured:true,entries:4});
 expect(usage(f,'terminal-evidence')).toMatchObject({entries:2});
 const removed=[`pi-${ledgerHex('a')}.jsonl`,`my-task-runner-${ledgerHex('c')}.jsonl`,`corrupt-${ledgerHex('f')}.jsonl`];
 for(const name of removed)expect(await exists(path.join(root,name))).toBe(false);
 for(const name of [`pi-${ledgerHex('b')}.jsonl`,`pi-task-${ledgerHex('d')}.jsonl`,`x-task-${ledgerHex('e')}.jsonl`,'notes.txt',`dir-${ledgerHex('1')}.jsonl`])expect(await exists(path.join(root,name))).toBe(true);
 expect(await fs.readFile(outside,'utf8')).toBe('keep');
 expect(report.deleted).toBe(3);expect(report.bytesReclaimed).toBe(removed.reduce((sum,name)=>sum+(name.startsWith('corrupt')?9:`{"entry":"${name}"}\n`.length),0));
 // These fixtures are not valid handoff records, so reader-run reports them; session-ledger never parses them.
 expect(f.failures.filter(failure=>failure.startsWith('session-ledger:'))).toEqual([]);
});
it('session ledgers wait while the home is busy and keep expiring under pressure',async()=>{
 const busy=await idleHome(),ledger=`pi-${ledgerHex('a')}.jsonl`;
 const busyRoot=await sessionLedgers(busy.directory,{[ledger]:EXPIRED});
 const f=await fixture({home:busy.home});await f.sweeper.runPass('periodic');expect(await exists(path.join(busyRoot,ledger))).toBe(true);
 const idle=await idleHome();await idle.binding.lease.release();const idleRoot=await sessionLedgers(idle.directory,{[ledger]:EXPIRED});
 const g=await fixture({home:idle.home,budget:{maxStoreBytes:1_000_000_000,minFreeBytes:100_000,ackCriticalReserveBytes:10_000},freeBytes:150_000});
 await g.sweeper.runPass('periodic');expect(g.pressure.state).toBe('pressure');expect(await exists(path.join(idleRoot,ledger))).toBe(false);
});
it('session ledgers sweep last: earlier classes spend the pass first and a large ledger directory drains across passes',async()=>{
 const {home,binding,directory,results}=await idleHome();await binding.lease.release();await fs.mkdir(results,{recursive:true});
 const record=path.join(results,resultName(0));await fs.writeFile(record,'{}');await old(record);
 const names=Array.from({length:5},(_,index)=>`pi-${index.toString(16).repeat(64)}.jsonl`);
 const root=await sessionLedgers(directory,Object.fromEntries(names.map(name=>[name,EXPIRED])));
 const f=await fixture({home,max:1});
 await f.sweeper.runPass('periodic');expect(await exists(record)).toBe(false);expect(await fs.readdir(root)).toHaveLength(5);
 for(let pass=0;pass<10&&(await fs.readdir(root)).length>0;pass++)await f.sweeper.runPass('periodic');
 expect(await fs.readdir(root)).toEqual([]);expect(f.failures.filter(failure=>failure.startsWith('session-ledger:'))).toEqual([]);
});
it('removing an expired corrupt ledger lets reader-run retention run again in that home',async()=>{
 const {home,binding,directory}=await idleHome();await binding.lease.release();
 const root=await sessionLedgers(directory,{});const corrupt=path.join(root,`pi-${ledgerHex('a')}.jsonl`);await fs.writeFile(corrupt,'{not json');await stamp(corrupt,EXPIRED);
 const f=await fixture({home});
 await f.sweeper.runPass('periodic');expect(f.failures).toContain('reader-run:sweep_failed');expect(await exists(corrupt)).toBe(false);
 const before=f.failures.length;await f.sweeper.runPass('periodic');expect(f.failures.slice(before)).toEqual([]);
});
it('session-ledger TTL defaults to thirty days and accepts any non-negative integer',()=>{
 const store=testScratchRoot();expect(resolveStorageConfig(store).ttlMs['session-ledger']).toBe(30*DAY);
 expect(resolveStorageConfig(store,{retention:{ttlMs:{'session-ledger':0}}}).ttlMs['session-ledger']).toBe(0);
 for(const value of [-1,1.5])expect(()=>resolveStorageConfig(store,{retention:{ttlMs:{'session-ledger':value}}})).toThrow('DaemonConfig.storage.retention.ttlMs.session-ledger is invalid');
});
