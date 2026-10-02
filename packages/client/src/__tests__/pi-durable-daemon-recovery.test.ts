import { afterEach, expect, it, vi } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { createServer, type ServerResponse, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { sealRuntimeOperationManifest, type Session } from '../types';
import { buildRuntimeEnv } from '../daemon/environment';
import { projectPiMcpEnvironment } from '../adapters/pi/mcp-environment';
import { resolveBunBin } from './support/test-bun-bin';
import { TestServer } from './fixtures/test-server';
import { PI_MODEL_FIXTURE } from '../../../keys/src/fixtures/pi-model-config';
const BUN_BIN = resolveBunBin();
const PROCESS_WAIT = { timeout: 5_000, interval: 50 };
const SENTINEL = 'BYOK_KNIFE3_PROVIDER_SECRET_SENTINEL';
const clientRoot = path.resolve(import.meta.dirname,'../..');
const sessions: Session[] = [];
const roots: string[] = [], children: ChildProcess[] = [];
let server: TestServer | undefined, provider: Server | undefined;
const secretCleanup: Array<() => Promise<void>> = [];
let launcherPids: number[] = [];
const logs: string[] = [];
const ownedPids = new Set<number>();
function processTree(seeds: number[]): number[] {
  if (process.platform === 'win32') {
    const data=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json'],{encoding:'utf8'})) as Array<{ProcessId:number;ParentProcessId:number}>;
    const found=new Set(seeds);for(const pid of found)for(const row of data)if(row.ParentProcessId===pid)found.add(row.ProcessId);return [...found];
  }
  const data=execFileSync('ps',['-eo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().split(/\s+/u).map(Number));
  const found=new Set(seeds);for(const pid of found)for(const [child,parent] of data)if(parent===pid)found.add(child!);return [...found];
}
function live(pid: number): boolean {
  try { process.kill(pid,0); } catch {return false;}
  if(process.platform !== 'win32') {try{return !execFileSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8'}).trim().startsWith('Z');}catch{return false;}}
  return true;
}
function kill(pid: number, group = false) { try { process.kill(group && process.platform !== 'win32' ? -pid : pid,'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
afterEach(async () => {
  for(const child of children)if(child.pid && child.exitCode===null && child.signalCode===null)for(const pid of processTree([child.pid]))ownedPids.add(pid);
  for (const session of sessions.splice(0)) await session.close();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit',resolve)); }
  for (const root of roots) for (const entry of await rows(path.join(root,'control','launches.jsonl'))) launcherPids.push(Number(entry.launcherPid));
  for (const pid of new Set(launcherPids.splice(0))) {for(const child of processTree([pid]))ownedPids.add(child);kill(pid,true);}
  for(const pid of ownedPids)kill(pid);ownedPids.clear();
  for(const cleanup of secretCleanup.splice(0))await cleanup();
  await server?.close(); provider?.closeAllConnections(); if (provider) await new Promise<void>(resolve => provider!.close(() => resolve()));
  server=undefined; provider=undefined; logs.length=0;
  for (const root of roots.splice(0)) await fs.rm(root,{recursive:true,force:true});
});
async function run(command: string,args: string[]) {
  const child = spawn(command,args,{stdio:['ignore','pipe','pipe']}); let output=''; child.stdout.on('data',chunk=>output+=chunk); child.stderr.on('data',chunk=>output+=chunk);
  const code = await new Promise<number|null>(resolve => child.once('close',resolve)); if (code !== 0) throw new Error(output);
}
function auditPrelude(file: string, actor: string) {
  return `import * as _auditFs from 'node:fs';
import {createRequire as _auditRequire,syncBuiltinESMExports as _auditSync} from 'node:module';
const _auditSqlite = _auditRequire(import.meta.url)('node:sqlite');
const _auditNative = _auditSqlite.DatabaseSync;
_auditSqlite.DatabaseSync = class extends _auditNative { constructor(file,options) { _auditFs.appendFileSync(${JSON.stringify(file)},JSON.stringify({actor:${JSON.stringify(actor)},pid:process.pid,file:String(file)})+${JSON.stringify('\n')}); super(file,...(options === undefined ? [] : [options])); } };
_auditSync();\n`;
}
// The complete SIGKILL scenario uses the existing 30s integration-test budget.
// Event waiting rejects on fixture exit; it does not change TestServer/product deadlines.
async function waitEnvelope(predicate:(event:Envelope)=>boolean, child:ChildProcess):Promise<Envelope> {
  return new Promise((resolve,reject)=>{
    const finish=(event?:Envelope)=>{clearInterval(timer);child.off('exit',exited);if(event)resolve(event);else reject(new Error(logs.join('')||'daemon exited before event'));};
    const exited=()=>finish();
    const timer=setInterval(()=>{const event=server!.received.find(predicate);if(event)finish(event);},10);
    child.once('exit',exited);
    const event=server!.received.find(predicate);if(event)finish(event);
  });
}
async function rows(file: string): Promise<Array<Record<string,any>>> { try { return (await fs.readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)); } catch (error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return []; throw error; } }
async function files(root: string): Promise<string[]> { const entries=await fs.readdir(root,{withFileTypes:true}); const result:string[]=[]; for (const entry of entries) { const file=path.join(root,entry.name); if (entry.isDirectory()) result.push(...await files(file)); else if (entry.isFile()) result.push(file); } return result; }
function reply(res: ServerResponse, content: string, command?: string) {
  const base={id:'recovery-completion',object:'chat.completion.chunk',created:0,model:'probe'};
  const delta=command ? {role:'assistant',tool_calls:[{index:0,id:'old-tool',type:'function',function:{name:'bash',arguments:JSON.stringify({command})}}]} : {role:'assistant',content};
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end([{...base,choices:[{index:0,delta,finish_reason:null}]},{...base,choices:[{index:0,delta:{},finish_reason:command?'tool_calls':'stop'}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}}].map(value=>`data: ${JSON.stringify(value)}\n\n`).join('')+'data: [DONE]\n\n');
}
async function recoveryScenario(daemonOnly: boolean, interpreter = process.execPath, waitingModel = false) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'byok-durable-restart-'))); roots.push(root);
  // Isolated package copy: no shared dist mutation. Product modules are byte-identical; only entry audit and test-authority export are added.
  const isolated=await fs.mkdtemp(path.join(clientRoot,'node_modules/.cache/byok-durable-recovery-')); roots.push(isolated);
  await fs.cp(path.join(clientRoot,'dist'),path.join(isolated,'dist'),{recursive:true});
  await fs.copyFile(path.join(clientRoot,'package.json'),path.join(isolated,'package.json'));
  await fs.symlink(path.join(clientRoot,'node_modules'),path.join(isolated,'node_modules'),'junction');
  const control=path.join(root,'control'); await fs.mkdir(control);
  const audit=path.join(control,'sqlite-opens.jsonl');
  const index=path.join(isolated,'dist/index.js'), worker=path.join(isolated,'dist/bin/byok-pi-durable.js');
  const originalIndex=await fs.readFile(index), originalWorker=await fs.readFile(worker,'utf8');
  await fs.writeFile(index,auditPrelude(audit,'daemon')+originalIndex.toString()+'\nexport {DeviceStore as FixtureDeviceStore};\n');
  await fs.writeFile(worker,auditPrelude(audit,'worker')+originalWorker.replace(/^#![^\n]*\n/u,''));
  // Assert the real execution modules remain unchanged by the observational fixture.
  for (const relative of ['dist/bin/pi-runtime-host.js','dist/adapters/index.js']) {
    expect(createHash('sha256').update(await fs.readFile(path.join(isolated,relative))).digest('hex')).toBe(createHash('sha256').update(await fs.readFile(path.join(clientRoot,relative))).digest('hex'));
  }
  const launcherRoot=await fs.mkdtemp(path.resolve(clientRoot,'../keys/node_modules/.cache/byok-durable-recovery-')); roots.push(launcherRoot);
  const launcher=path.join(launcherRoot,'launcher.mjs');
  await run(BUN_BIN!,['build',path.resolve(import.meta.dirname,'fixtures/pi-durable-recovery-launcher.ts'),'--target=node','--packages=external','--outfile',launcher]);
  const requests:Array<{body:string;authorization:unknown}>=[];
  const command=`${JSON.stringify(process.execPath)} -e 'const fs=require("fs");fs.appendFileSync("old-effect.log","once\\n");${daemonOnly ? 'setInterval(()=>{fs.appendFileSync("orphan-writes.log","tick\\n");console.log("tick");},50);' : ''}console.log(JSON.stringify(process.env));setInterval(()=>{},1000)'`;
  provider=createServer((req,res)=>{ let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{requests.push({body,authorization:req.headers.authorization}); const old=body.includes('OLD_HOST_CONTEXT');if(old&&waitingModel)return;reply(res,old?'':'fresh result',old?command:undefined);});});
  await new Promise<void>(resolve=>provider!.listen(0,'127.0.0.1',resolve)); const address=provider.address(); if (!address || typeof address==='string') throw new Error('missing provider port');
  const profilePath=path.join(root,'profile.json');
  await fs.writeFile(profilePath,JSON.stringify({controlDir:control,profile:{adapter:'openai_compatible',auth_mode:'bearer',base_url:`http://127.0.0.1:${address.port}/v1`,capabilities:[],created_at:'2026-10-02T00:00:00.000Z',updated_at:'2026-10-02T00:00:00.000Z',display_name:'Fixture',enabled:true,kind:'model',model:'probe',profile_ref:'probe',provider_kind:'custom',pi_model:{...PI_MODEL_FIXTURE,reasoning:false,thinkingLevel:'off'}}}));
  server=await TestServer.start(); const config={clientEntry:index,launcherEntry:launcher,serverUrl:server.url,productId:`durable-restart-${randomUUID()}`,storeDir:path.join(root,'store'),workspaceRoot:path.join(root,'workspace'),homeRoot:path.join(root,'home'),profilePath,sessionDir:path.join(root,'sessions')};
  const configPath=path.join(root,'daemon.json'); await fs.writeFile(configPath,JSON.stringify(config));
  let enrollment:unknown;
  const start=async () => {
    const child=spawn(interpreter,[path.resolve(import.meta.dirname,'fixtures/pi-durable-recovery-daemon.mjs'),configPath],{env:{...process.env,BYOK_TEST_DEVICE_CREDENTIAL_STORE:'1'},stdio:['pipe','pipe','pipe','ipc']});children.push(child);
    let stdout='';child.stdout!.on('data',chunk=>{stdout+=chunk;logs.push(String(chunk));});child.stderr!.on('data',chunk=>logs.push(String(chunk)));
    child.on('message',value=>{enrollment=(value as {record:unknown}).record;});child.send({record:enrollment});
    await vi.waitFor(()=>{if(child.exitCode!==null) throw new Error(logs.join(''));expect(stdout).toContain('"ready":true');},PROCESS_WAIT);return child;
  };
  const first=await start();
  const offer=(taskId:string,instruction:string)=>createEnvelope('task.offer_for_agent',{instruction,policy:{mode:'auto'},runtime:'pi',agentRef:{agentId:'recovery-agent',profileRevision:'1'},dispatchSelection:{lane:'byok',runtimeId:'pi',providerId:'probe',modelId:'probe'}},{taskId,seq:server!.nextSeq()});
  server.send(offer('old-task','OLD_HOST_CONTEXT'));
  await waitEnvelope(event=>event.type==='task.started'&&event.task_id==='old-task',first);
  let oldLaunch:Record<string,any> | undefined;
  await vi.waitFor(async()=>{oldLaunch=(await rows(path.join(control,'launches.jsonl')))[0];expect(oldLaunch).toBeDefined();},PROCESS_WAIT);
  launcherPids.push(oldLaunch!.launcherPid);
  const launchConfig=JSON.parse(await fs.readFile(oldLaunch!.configPath,'utf8'));
  const home=launchConfig.replica.canonicalHome;
  if(!waitingModel)await vi.waitFor(async()=>expect(await fs.readFile(path.join(home,'old-effect.log'),'utf8')).toBe('once\n'),PROCESS_WAIT);else await vi.waitFor(()=>expect(requests).toHaveLength(1),PROCESS_WAIT);
  const opened=await rows(audit); const oldReplica=String(opened.find(row=>row.actor==='worker'&&String(row.file).endsWith('durable-old-task.sqlite'))?.file);expect(oldReplica).not.toBe('undefined');
  expect(requests).toHaveLength(1);expect(requests[0]!.authorization).toBe(`Bearer ${SENTINEL}`);
  const launchesBefore=await rows(path.join(control,'launches.jsonl'));expect(JSON.stringify(launchesBefore)).not.toContain(SENTINEL);
  if(process.platform==='darwin')expect(execFileSync('ps',['eww','-p',String(oldLaunch!.workerPid)],{encoding:'utf8'})).not.toContain(SENTINEL);
  else if(process.platform==='linux')expect(await fs.readFile(`/proc/${oldLaunch!.workerPid}/environ`,'utf8')).not.toContain(SENTINEL);
  if(daemonOnly&&!waitingModel)await vi.waitFor(async()=>expect((await fs.readFile(path.join(home,'orphan-writes.log'),'utf8')).length).toBeGreaterThan(0),PROCESS_WAIT);
  if(daemonOnly&&!waitingModel)expect((await rows(path.join(control,'ipc-events.jsonl'))).filter(row=>row.phase==='before-tool')).toEqual([{phase:'before-tool',ipcClosed:true}]);
  const interruptedTree=processTree([first.pid!,oldLaunch!.launcherPid]);for(const pid of interruptedTree)ownedPids.add(pid);
  first.kill('SIGKILL'); await new Promise(resolve=>first.once('exit',resolve));expect(first.signalCode).toBe('SIGKILL');
  if(!daemonOnly) { kill(oldLaunch!.launcherPid,true); for(const pid of interruptedTree)if(pid!==first.pid)kill(pid); }
  await vi.waitFor(()=>expect(interruptedTree.filter(live)).toEqual([]),PROCESS_WAIT);
  for(const pid of interruptedTree)ownedPids.delete(pid);launcherPids=launcherPids.filter(pid=>!interruptedTree.includes(pid));
  if(daemonOnly&&!waitingModel) {const writes=await fs.readFile(path.join(home,'orphan-writes.log'),'utf8');const count=requests.length;await new Promise(resolve=>setTimeout(resolve,250));expect(await fs.readFile(path.join(home,'orphan-writes.log'),'utf8')).toBe(writes);expect(requests.length).toBe(count);}
  const oldBytes=await fs.readFile(oldReplica);const oldHash=createHash('sha256').update(oldBytes).digest('hex');const auditCut=(await rows(audit)).length;
  // Kill was not graceful: residue really exists and includes old execution input, but never the provider key.
  expect(JSON.stringify(launchConfig)).toContain('OLD_HOST_CONTEXT');
  const residue=[...(await files(config.storeDir)),...(await files(config.sessionDir))];
  expect(residue).toContain(oldReplica);expect(residue).toContain(oldLaunch!.configPath);
  for(const file of residue)expect((await fs.readFile(file)).includes(Buffer.from(SENTINEL)),file).toBe(false);
  expect(logs.join('')).not.toContain(SENTINEL);
  for(const file of await files(control))expect((await fs.readFile(file)).includes(Buffer.from(SENTINEL)),file).toBe(false);
  const second=await start();
  const failed=await waitEnvelope(event=>event.type==='task.fail'&&event.task_id==='old-task',second);expect(failed.payload).toMatchObject({reason:'daemon_interrupted',retryable:false,agentRef:{agentId:'recovery-agent',profileRevision:'1'}});
  expect((await rows(audit)).slice(auditCut).some(row=>row.file===oldReplica)).toBe(false);
  expect(await rows(path.join(control,'launches.jsonl'))).toHaveLength(1);expect(requests).toHaveLength(1);
  server.send(offer('new-task','NEW_HOST_CONTEXT_ONLY'));
  await waitEnvelope(event=>event.type==='task.complete'&&event.task_id==='new-task',second);
  expect(requests).toHaveLength(2);expect(requests[1]!.body).toContain('NEW_HOST_CONTEXT_ONLY');expect(requests[1]!.body).not.toContain('OLD_HOST_CONTEXT');expect(requests[1]!.body).not.toContain('old-effect.log');
  if(!waitingModel)expect(await fs.readFile(path.join(home,'old-effect.log'),'utf8')).toBe('once\n');else await expect(fs.readFile(path.join(home,'old-effect.log'))).rejects.toThrow();
  expect((await rows(audit)).slice(auditCut).some(row=>row.file===oldReplica)).toBe(false);
  expect(createHash('sha256').update(await fs.readFile(oldReplica)).digest('hex')).toBe(oldHash);
  const launchesAfter=await rows(path.join(control,'launches.jsonl'));expect(launchesAfter.map(row=>row.taskId)).toEqual(['old-task','new-task']);launcherPids.push(launchesAfter[1]!.launcherPid);
  const db=new DatabaseSync(path.join(config.storeDir,'daemon.db'),{readOnly:true});try{const row=db.prepare('SELECT bytes FROM journal_terminal WHERE task_id=?').get('old-task') as {bytes:string};expect(JSON.parse(row.bytes).payload).toMatchObject({reason:'daemon_interrupted',retryable:false});expect(row.bytes).not.toContain(SENTINEL);}finally{db.close();}
  second.stdin!.write('{"command":"stop"}\n');await new Promise(resolve=>second.once('exit',resolve));expect(second.exitCode).toBe(0);
  expect(logs.join('')).not.toContain(SENTINEL);
 }

it.skipIf(BUN_BIN === undefined || process.platform === 'win32')('SIGKILL real durable execution never reopens old replica, restarts from Host only, and leaves no provider key', () => recoveryScenario(false),30_000);
// Durable parent-death guarantees are POSIX-only until a Windows Job Object design is validated.
const RECOVERY_INTERPRETERS=[{name:'node-current',binary:process.execPath},...(BUN_BIN ? [{name:'bun',binary:BUN_BIN}] : []),...['/opt/homebrew/opt/node@24/bin/node','/opt/homebrew/opt/node@22/bin/node'].filter(existsSync).map(binary=>({name:binary,binary}))];
it.skipIf(BUN_BIN === undefined || process.platform === 'win32').each(RECOVERY_INTERPRETERS)('daemon-only SIGKILL stops launcher worker detached tools through $name', ({binary}) => recoveryScenario(true,binary),30_000);
it.skipIf(BUN_BIN === undefined || process.platform === 'win32').each(RECOVERY_INTERPRETERS)('daemon-only SIGKILL cancels in-flight model through $name', ({binary}) => recoveryScenario(true,binary,true),30_000);


it.skipIf(BUN_BIN === undefined || process.platform === 'win32')('N1 real custody startPiProvider and unmodified built worker agree on private IPC and keep key out of env', async () => {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'byok-durable-ipc-real-'))); roots.push(root);
  const launcherRoot=await fs.mkdtemp(path.resolve(clientRoot,'../keys/node_modules/.cache/byok-durable-recovery-'));roots.push(launcherRoot);
  const launcher=path.join(launcherRoot,'launcher.mjs');
  await run(BUN_BIN!,['build',path.resolve(import.meta.dirname,'fixtures/pi-durable-recovery-launcher.ts'),'--target=node','--packages=external','--outfile',launcher]);
  const control=path.join(root,'control'),home=path.join(root,'home'),store=path.join(root,'store');await Promise.all([control,home,store].map(dir=>fs.mkdir(dir)));
  const received:Array<{authorization:unknown;body:string}>=[];
  provider=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{received.push({authorization:req.headers.authorization,body});reply(res,'real IPC result');});});
  await new Promise<void>(resolve=>provider!.listen(0,'127.0.0.1',resolve)); const address=provider.address();if(!address||typeof address==='string')throw new Error('missing port');
  const profilePath=path.join(root,'profile.json');await fs.writeFile(profilePath,JSON.stringify({controlDir:control,profile:{adapter:'openai_compatible',auth_mode:'bearer',base_url:`http://127.0.0.1:${address.port}/v1`,capabilities:[],created_at:'2026-10-02T00:00:00.000Z',updated_at:'2026-10-02T00:00:00.000Z',display_name:'Fixture',enabled:true,kind:'model',model:'probe',profile_ref:'probe',provider_kind:'custom',pi_model:{...PI_MODEL_FIXTURE,reasoning:false,thinkingLevel:'off'}}}));
  const adapter=new PiAdapter({durablePi:{replicaRoot:path.join(store,'durable')},byokLauncher:{command:process.execPath,args:[launcher],profileDbPath:profilePath,sessionDir:path.join(root,'sessions')}});
  const selection={lane:'byok' as const,runtimeId:'pi' as const,providerId:'probe',modelId:'probe'};
  const prepared=await adapter.prepare({offer:{instruction:'N1 fresh Host context',dispatchSelection:selection},policy:{mode:'auto'}} as never);if(prepared.kind!=='prepared')throw new Error(prepared.reason);
  const env=buildRuntimeEnv({ambient:process.env,requirements:{credentialNames:[]}});
  const launch=await prepared.operation.resolveRuntimeLaunch!({kind:'instruction',cwd:home,env,projectionRoot:path.join(store,'projections')});
  const manifest=sealRuntimeOperationManifest({taskId:'ipc-task',runtimeId:'pi',descriptor:adapter.descriptor,policy:{mode:'auto'},dispatchSelection:selection,requiredToolsetIds:[],cwd:home,workspace:{workspaceDir:home},agentRef:{agentId:'ipc-agent',profileRevision:'1'},lease:{leaseId:'ipc-lease',canonicalHome:home},forwardedEnvironmentNames:Object.keys(env)});
  const session=await prepared.operation.start({kind:'instruction',instruction:'N1 fresh Host context',manifest,env,runtimeLaunch:launch,mcpEnv:projectPiMcpEnvironment(env),durableContext:{tenantId:'tenant-test',lifecycle:{ownsLease:()=>true,record:async()=>{}}}});sessions.push(session);
  const events=[];for await(const event of session.events)events.push(event);
  expect(events.some(event=>event.type==='error')).toBe(false);expect(events.at(-1)).toEqual({type:'turn_end'});
  expect(received).toHaveLength(1);expect(received[0]!.authorization).toBe(`Bearer ${SENTINEL}`);expect(received[0]!.body).not.toContain(SENTINEL);
  const [started]=await rows(path.join(control,'launches.jsonl'));expect(started).toBeDefined();launcherPids.push(started!.launcherPid);
  expect(started!.args[0]).toBe(path.join(clientRoot,'dist/bin/byok-pi-durable.js'));expect(JSON.stringify(started!.env)).not.toContain(SENTINEL);expect(started!.env.PI_PROVIDER_API_KEY).toBeUndefined();
  if(process.platform==='darwin')expect(execFileSync('ps',['eww','-p',String(started!.workerPid)],{encoding:'utf8'})).not.toContain(SENTINEL);
  else if(process.platform==='linux')expect(await fs.readFile(`/proc/${started!.workerPid}/environ`,'utf8')).not.toContain(SENTINEL);
});

// This actual bin uses a temporary, namespaced macOS OS-credential entry; Linux lacks this keys CLI backend.
it.skipIf(process.platform !== 'darwin')('real built keys launcher bin completes durable IPC with OS custody and inherit stdio', async () => {
  const {SqliteProviderProfileStore,parseModelProviderProfile,MacOsKeychainSecretStore,modelProviderSecretName}=await import('../../../keys/src/index');
  const servicePrefix=`byok-knife5-${randomUUID()}`;const secrets=new MacOsKeychainSecretStore({servicePrefix});const secretName=modelProviderSecretName('probe');
  secretCleanup.push(async()=>{await secrets.delete(secretName);});await secrets.set(secretName,SENTINEL);
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'byok-durable-real-bin-')));roots.push(root);
  const home=path.join(root,'home'),store=path.join(root,'store');await Promise.all([home,store].map(dir=>fs.mkdir(dir)));
  const headers:unknown[]=[];provider=createServer((req,res)=>{req.resume();req.on('end',()=>{headers.push(req.headers.authorization);reply(res,'real CLI result');});});
  await new Promise<void>(resolve=>provider!.listen(0,'127.0.0.1',resolve));const address=provider.address();if(!address||typeof address==='string')throw new Error('no port');
  const profilePath=path.join(root,'profiles.db');const profiles=new SqliteProviderProfileStore({path:profilePath});
  try{await profiles.save(parseModelProviderProfile({adapter:'openai_compatible',auth_mode:'bearer',base_url:`http://127.0.0.1:${address.port}/v1`,capabilities:[],created_at:'2026-10-03T00:00:00.000Z',updated_at:'2026-10-03T00:00:00.000Z',display_name:'OS custody fixture',enabled:true,kind:'model',model:'probe',profile_ref:'probe',provider_kind:'custom',pi_model:{...PI_MODEL_FIXTURE,reasoning:false,thinkingLevel:'off'}}));}finally{await profiles.close();}
  const adapter=new PiAdapter({durablePi:{replicaRoot:path.join(store,'durable')},byokLauncher:{command:process.execPath,args:[path.resolve(clientRoot,'../keys/dist/bin/pi-provider-launcher.js')],profileDbPath:profilePath,sessionDir:path.join(root,'sessions'),secretServicePrefix:servicePrefix}});
  const selection={lane:'byok' as const,runtimeId:'pi' as const,providerId:'probe',modelId:'probe'};const prepared=await adapter.prepare({offer:{instruction:'real bin',dispatchSelection:selection},policy:{mode:'auto'}} as never);if(prepared.kind!=='prepared')throw new Error(prepared.reason);
  const env=buildRuntimeEnv({ambient:process.env,requirements:{credentialNames:[]}});const launch=await prepared.operation.resolveRuntimeLaunch!({kind:'instruction',cwd:home,env,projectionRoot:path.join(store,'projections')});
  const manifest=sealRuntimeOperationManifest({taskId:'real-bin',runtimeId:'pi',descriptor:adapter.descriptor,policy:{mode:'auto'},dispatchSelection:selection,requiredToolsetIds:[],cwd:home,workspace:{workspaceDir:home},agentRef:{agentId:'real-bin-agent',profileRevision:'1'},lease:{leaseId:'real-bin-lease',canonicalHome:home},forwardedEnvironmentNames:Object.keys(env)});
  const session=await prepared.operation.start({kind:'instruction',instruction:'real bin',manifest,env,runtimeLaunch:launch,mcpEnv:projectPiMcpEnvironment(env),durableContext:{tenantId:'tenant-test',lifecycle:{ownsLease:()=>true,record:async()=>{}}}});sessions.push(session);
  const events=[];for await(const event of session.events)events.push(event);expect(events.some(event=>event.type==='error')).toBe(false);expect(events.at(-1)).toEqual({type:'turn_end'});expect(headers).toEqual([`Bearer ${SENTINEL}`]);
});
