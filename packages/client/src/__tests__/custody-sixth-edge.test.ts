import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { readFileSync, readdirSync, writeFileSync, utimesSync, statSync, renameSync, symlinkSync, chmodSync } from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { dispatchCustodyPiSubagentSpawn } from '../custody/custody-dispatcher';
import { encodeRunFanoutBudgetDescriptor } from '../custody/custody-vendor-bridge.js';
import { parseDescendantLaunch, parseExternalCliDescendantLaunch, externalCliCommitment } from '@byok-sdk/implementation-identity';
import { ExternalCliCustodyAuthority, officialExternalCliLoginProven, buildOfficialExternalCliEnvironment,
  type ExternalCliLaunchRequest, type ExternalCliAuthorization } from '../custody/external-cli-custody';
import { externalCliConfigRefusal, readAdmittedRunnerConfig } from '../custody/external-cli-admission';
import { configureCustodyExternalInstallations, activateVerifiedCustodyRunner } from '../custody/external-cli-authority';
import { claimRunFanoutBatchWithCommit } from '../custody/custody-vendor-bridge.js';
import { sixthEdgeKit, SECRET, SECRET_NAMES, ownershipProbe, importVendor } from './fixtures/sixth-edge-kit';
const kits: Awaited<ReturnType<typeof sixthEdgeKit>>[] = [];
async function kit(options?: Parameters<typeof sixthEdgeKit>[0]) { const k = await sixthEdgeKit(options); kits.push(k); return k; }
afterEach(() => { vi.unstubAllEnvs(); configureCustodyExternalInstallations([]); for (const k of kits.splice(0)) k.dispose(); });
function claims(k: Awaited<ReturnType<typeof kit>>) { return readdirSync(path.join(k.budget.directory,'claims')).filter(n => /^\d{6}\.json$/u.test(n)).length; }
function ledgers(k: Awaited<ReturnType<typeof kit>>) {
  try { return readdirSync(path.join(k.budget.directory,'custody-external')).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(path.join(k.budget.directory,'custody-external',n),'utf8'))); }
  catch { return []; }
}
function noLeaks(k: Awaited<ReturnType<typeof kit>>) {
  for (const dir of ['custody-records','custody-external']) {
    try { for (const file of readdirSync(path.join(k.budget.directory,dir))) expect(readFileSync(path.join(k.budget.directory,dir,file),'utf8')).not.toContain(SECRET); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}
async function spawnTask(k: Awaited<ReturnType<typeof kit>>, request: ExternalCliLaunchRequest, auth?: ExternalCliAuthorization) {
  const authorization = auth ?? await k.authority.prepare(request);
  const child = await k.authority.spawn(authorization,{command:request.command,args:request.args,cwd:request.cwd,prompt:request.prompt,env:authorization.env});
  const close = once(child,'close').then(async result => { await k.authority.settled(child); return result; });
  child.stdin.end(request.prompt);
  return {child,close,authorization};
}

describe('sixth edge: official login and secret-free final child', () => {
  it.each(['unknown','key'])('refuses %s auth before task spawn and redacts probe output', async auth => {
    const k = await kit({auth});
    const request = k.request();
    await expect(k.authority.prepare(request)).rejects.toThrow('external_cli_auth_mode_unavailable');
    expect(k.tasks()).toEqual([]);
    expect(claims(k)).toBe(4); // runner + version + help + auth; task count is zero.
    expect(ledgers(k).filter(v => v.kind === 'task')).toEqual([]);
    noLeaks(k);
  });
  it.each([['codex',false],['codex',true],['claude',false],['claude',true]] as const)('runs approved %s mode writer=%s through the real streaming runner, strips keys even when explicitly allowed', async (family,writer) => {
    const k = await kit({family});
    const request = k.request(writer);
    const {runExternalCli} = await importVendor<{runExternalCli(input: Record<string,unknown>, authority: ExternalCliCustodyAuthority): Promise<{exitCode:number;output:string}>}>('runs/shared/external-cli-runner.ts');
    const output = await runExternalCli({...request,args:[...request.args],asyncDir:k.dir,stepIndex:0,
      environment:{allowlist:[...SECRET_NAMES,'HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','PATH']}},k.authority);
    expect(output.exitCode).toBe(0);
    expect(k.tasks()).toHaveLength(1);
    expect(k.tasks()[0]!.observed).toEqual(Object.fromEntries(SECRET_NAMES.map(n => [n,false])));
    expect(k.tasks()[0]!.home).toBe(k.dir);
    expect(k.tasks()[0]!.config).toBe(k.configDir);
    expect(output.output).not.toContain(SECRET);
    expect(claims(k)).toBe(family==='claude'?6:5); // Claude includes the final charged mode proof.
    const record = ledgers(k).find(v => v.kind === 'task').record;
    expect(parseExternalCliDescendantLaunch(record)).toBeDefined();
    expect(record.edge.inheritsCredential).toBe(false);
    expect(record.installation.identity.installPath).toBe(k.entry);
    expect(k.parent.template.identity.kind).toBe('attested');
    if (k.parent.template.identity.kind !== 'attested') throw Error('fixture parent is unproven');
    expect(record.installation.identity.installPath).not.toBe(k.parent.template.identity.installPath);
    noLeaks(k);
  });
  it.each(['CODEX_API_KEY','CURSOR_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','AWS_SECRET_ACCESS_KEY','BYOK_UNKNOWN','NODE_OPTIONS'])('refuses explicit %s value override with zero task/probe children', async name => {
    const k = await kit();
    const request = {...k.request(),environment:{allowlist:[name],values:{[name]:SECRET}}};
    await expect(k.authority.prepare(request)).rejects.toThrow('external_cli_env_override_forbidden');
    expect(claims(k)).toBe(1); expect(k.tasks()).toEqual([]); noLeaks(k);
  });
  it.each([['--api-key',SECRET],['-c',`api_key="${SECRET}"`],['--settings',`{"apiKeyHelper":"${SECRET}"}`],['--endpoint',SECRET]])('refuses argv/config override %s without a task/probe spawn', async (...extra) => {
    const k = await kit(), request = k.request();
    await expect(k.authority.prepare({...request,args:[...request.args,...extra.flat()]})).rejects.toThrow('external_cli_argv_override_forbidden');
    expect(k.tasks()).toEqual([]); expect(claims(k)).toBe(1); noLeaks(k);
  });
  it('requires a mode-specific login signal, including subscription and API-source evidence for Claude', () => {
    expect(officialExternalCliLoginProven('claude-code',JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',apiKeySource:null,subscriptionType:'max'}))).toBe(true);
    for (const status of [{loggedIn:true},{loggedIn:true,authMethod:'api_key',apiKeySource:null,subscriptionType:'max'},
      {loggedIn:true,authMethod:'claude.ai',apiKeySource:'helper',subscriptionType:'max'},
      {loggedIn:true,authMethod:'claude.ai',apiKeySource:null,subscriptionType:'console'}]) {
      expect(officialExternalCliLoginProven('claude-code',JSON.stringify(status))).toBe(false);
    }
    for (const adapter of ['cursor-agent','cursor-agent-writer']) expect(officialExternalCliLoginProven(adapter,'Logged in')).toBe(false);
  });
});

describe('sixth edge: attestation and launch commitments', () => {
  it.each(['bytes','rename','symlink'])('refuses %s substitution between auth probe and final spawn', async mutation => {
    const k = await kit(), request = k.request(), auth = await k.authority.prepare(request);
    const stat = statSync(k.entry);
    if (mutation === 'bytes') { const original=readFileSync(k.entry,'utf8'); chmodSync(k.entry,0o755); writeFileSync(k.entry,original.replace('codex-cli 9.0.0','codex-cli 8.0.0')); chmodSync(k.entry,0o555); utimesSync(k.entry,stat.atime,stat.mtime); expect(statSync(k.entry).mtimeMs).toBe(stat.mtimeMs); }
    if (mutation === 'rename') { renameSync(k.entry,`${k.entry}.old`); writeFileSync(k.entry,readFileSync(`${k.entry}.old`),{mode:0o555}); }
    if (mutation === 'symlink') { renameSync(k.entry,`${k.entry}.old`); symlinkSync(`${k.entry}.old`,k.entry); }
    await expect(spawnTask(k,request,auth)).rejects.toThrow('external_cli_identity_');
    expect(k.tasks()).toEqual([]); expect(ledgers(k).filter(v => v.kind === 'task')).toEqual([]); expect(claims(k)).toBe(4); noLeaks(k);
  });
  it.each(['args','cwd','env','prompt'])('refuses final %s drift without spawning or charging task', async field => {
    const k = await kit(), request = k.request(), auth = await k.authority.prepare(request);
    const actual = {command:request.command,args:request.args,cwd:request.cwd,prompt:request.prompt,env:auth.env};
    const changed = {...actual,[field]: field==='args' ? [...request.args,'--api-key',SECRET] : field==='env' ? {...auth.env,CODEX_API_KEY:SECRET} : field==='cwd' ? path.dirname(request.cwd) : SECRET};
    await expect(k.authority.spawn(auth,changed)).rejects.toThrow('external_cli_invocation_changed');
    expect(k.tasks()).toEqual([]); expect(claims(k)).toBe(4); noLeaks(k);
  });
  it('binds parent bytes, root, installation mode and authority instance', async () => {
    const k = await kit(), request = k.request(), auth = await k.authority.prepare(request);
    const other = new ExternalCliCustodyAuthority(k.parent,k.budget,k.installations,{},ownershipProbe);
    await expect(other.spawn(auth,{command:request.command,args:request.args,cwd:request.cwd,prompt:request.prompt,env:auth.env})).rejects.toThrow('external_cli_permit_reused');
    const changed = {...k.parent,perLaunch:{...k.parent.perLaunch,rootTaskId:'different-root'}};
    expect(() => new ExternalCliCustodyAuthority(changed,k.budget,k.installations,{},ownershipProbe)).toThrow('external_cli_parent_binding_invalid');
    expect(() => new ExternalCliCustodyAuthority(k.parent,k.budget,[k.installations[1]!],{},ownershipProbe)).toThrow('external_cli_installation_parent_mismatch');
    writeFileSync(k.recordPath,JSON.stringify({...k.parent,policy:{...k.parent.policy,maxDepth:7}}));
    await expect(spawnTask(k,request,auth)).rejects.toThrow('external_cli_parent_record_changed');
    expect(k.tasks()).toEqual([]); expect(claims(k)).toBe(4); noLeaks(k);
  });
  it('rejects old Pi records in the V2 cohort', async () => {
    const k = await kit();
    expect(() => parseDescendantLaunch({...k.parent,version:1})).toThrow('descendant_invalid_shape');
  });
});

describe('sixth edge: one shared derivation table and single-use permits', () => {
  it('charges each operation/attempt once, retries use a new attempt, and permit replay adds no claims', async () => {
    const k = await kit(), request = k.request(false,'same-operation',0);
    const [a,b] = await Promise.all([k.authority.prepare(request),k.authority.prepare(request)]);
    expect(a).toBe(b); expect(claims(k)).toBe(4);
    const first = await spawnTask(k,request,a); await first.close;
    await expect(spawnTask(k,request,a)).rejects.toThrow('external_cli_permit_reused');
    expect(claims(k)).toBe(5); expect(k.tasks()).toHaveLength(1);
    const retry = k.request(false,'same-operation',1), second = await spawnTask(k,retry); await second.close;
    const tasks = ledgers(k).filter(v => v.kind === 'task').sort((a,b)=>a.attempt-b.attempt);
    expect(tasks.map(v => [v.attempt,v.depth])).toEqual([[0,1],[1,2]]);
    expect(tasks.map(v => v.record.depth)).toEqual([1,2]);
    expect(claims(k)).toBe(9); noLeaks(k);
  });
  it.each([['E',16,false],['W',4,true]] as const)('exhausts cumulative %s after %s actual task spawns, with no refund at close', async (cap,count,writer) => {
    const k = await kit({native:true});
    for (let i=0;i<count;i++) { const running=await spawnTask(k,k.request(writer));await running.close; }
    const request=k.request(writer), auth=await k.authority.prepare(request), before=claims(k);
    await expect(spawnTask(k,request,auth)).rejects.toThrow(`external_cli_${cap}_exhausted`);
    expect(k.tasks()).toHaveLength(count); expect(claims(k)).toBe(before);
    expect(ledgers(k).filter(v=>v.kind==='task')).toHaveLength(count);
    expect(ledgers(k).filter(v=>v.kind==='task').every(v=>v.state==='terminated')).toBe(true); noLeaks(k);
  });
  it.each([['Q',2,false],['J',1,true]] as const)('exhausts live %s across independent authorities sharing the same root', async (cap,count,writer) => {
    const k = await kit({hold:true});
    const requests = Array.from({length:count+1},()=>k.request(writer));
    const handles: ExternalCliAuthorization[]=[];
    for (const request of requests) handles.push(await k.authority.prepare(request));
    const sibling = new ExternalCliCustodyAuthority(k.parent,k.budget,k.installations,{},ownershipProbe);
    const siblingRequest = {...requests[count]!,operation:'sibling'};
    const siblingHandle = await sibling.prepare(siblingRequest);
    const active = [];
    try {
      for (let i=0;i<count;i++) active.push(await spawnTask(k,requests[i]!,handles[i]!));
      await expect(sibling.spawn(siblingHandle,{command:siblingRequest.command,args:siblingRequest.args,cwd:siblingRequest.cwd,prompt:siblingRequest.prompt,env:siblingHandle.env})).rejects.toThrow(`external_cli_${cap}_exhausted`);
      const before=claims(k);
      await expect(spawnTask(k,requests[count]!,handles[count]!)).rejects.toThrow(`external_cli_${cap}_exhausted`);
      expect(claims(k)).toBe(before); expect(ledgers(k).filter(v=>v.kind==='task')).toHaveLength(count); noLeaks(k);
    } finally { for (const item of active) item.child.kill('SIGTERM'); await Promise.all(active.map(v=>v.close)); }
  });
  it('physical root claims bound probes plus tasks in the worst case', async () => {
    const k=await kit({limit:5}); const first=await spawnTask(k,k.request());await first.close;
    expect(claims(k)).toBe(5);
    await expect(k.authority.prepare(k.request())).rejects.toThrow('Run fan-out limit reached');
    expect(claims(k)).toBe(5); expect(k.tasks()).toHaveLength(1); noLeaks(k);
  });
  it('first handoff is legal at depth cap; a second operation cannot reuse it', async () => {
    const k=await kit({maxDepth:1}); const first=await spawnTask(k,k.request());await first.close;
    const r=k.request(), a=await k.authority.prepare(r), before=claims(k);
    await expect(spawnTask(k,r,a)).rejects.toThrow('external_cli_depth_exhausted');
    expect(claims(k)).toBe(before);expect(k.tasks()).toHaveLength(1);noLeaks(k);
  });
});

it('all readonly/writer adapters consume one shared writer table rather than adapter pools',async()=>{
 const a=await kit({native:true}), b=await kit({family:'claude',native:true});
 const installations=[...a.installations,...b.installations];configureCustodyExternalInstallations(installations);
 vi.stubEnv('BYOK_SDK_CUSTODY_LAUNCH_RECORD',undefined);vi.stubEnv('PI_SUBAGENT_RUN_FANOUT_BUDGET',encodeRunFanoutBudgetDescriptor(a.budget));
 vi.stubEnv('PI_CODING_AGENT_SESSION_DIR',a.dir);vi.stubEnv('PI_SUBAGENT_MAX_DEPTH','8');vi.stubEnv('PI_SUBAGENT_MAX_SPAWNS_PER_SESSION','128');
 const dispatch=dispatchCustodyPiSubagentSpawn({child:'pi-subagent-runner',cwd:a.dir,runnerConfigPath:a.config});
 const parent=parseDescendantLaunch(JSON.parse(readFileSync(dispatch.recordPath,'utf8')));
 const authority=new ExternalCliCustodyAuthority(parent,a.budget,installations,{},ownershipProbe,dispatch.recordPath);
 const merged={...a,authority};
 for(let i=0;i<4;i++) {const request={...(i%2===0?a:b).request(true),cwd:a.dir,stepIndex:i,operation:`mixed-${i}`};const run=await spawnTask(merged,request);await run.close;}
 const request={...b.request(true),cwd:a.dir,stepIndex:4,operation:'mixed-overflow'}, auth=await authority.prepare(request),before=claims(a);
 await expect(spawnTask(merged,request,auth)).rejects.toThrow('external_cli_W_exhausted');
 expect(claims(a)).toBe(before+1);expect(a.tasks()).toHaveLength(4); // Charged final Claude proof, no fifth task.expect(ledgers(a).filter(v=>v.kind==='task').map(v=>v.record.installation.adapter).sort()).toEqual(['claude-code-writer','claude-code-writer','codex-exec-writer','codex-exec-writer']);noLeaks(a);
});
it.each(['claude-code','claude-code-writer','codex-exec','codex-exec-writer','cursor-agent','cursor-agent-writer'])('shared input authority refuses %s key/config injection before any external child',async adapter=>{
 const k=await kit();const steps=[{agent:'fixture',task:'task',runner:{type:'external-cli',adapter,command:k.command,args:['--api-key',SECRET]}}];
 const reason=externalCliConfigRefusal({steps},'initial',k.installations);expect(reason).toBe('external_cli_override_forbidden');
 expect(reason).not.toContain(SECRET);expect(k.tasks()).toEqual([]);expect(claims(k)).toBe(1);noLeaks(k);
});

describe('sixth edge: closure/config and independent parent instances', () => {
  it.each(['resource','interpreter','config-directory'] as const)('rejects %s drift before any task child', async mutation => {
    const k=await kit({copyInterpreter:mutation==='interpreter'}), request=k.request(), auth=await k.authority.prepare(request);
    if (mutation==='resource') {const file=path.join(k.dir,'fixture-resource.txt');chmodSync(file,0o644);writeFileSync(file,'tampered');chmodSync(file,0o444);}
    if (mutation==='interpreter') {const bytes=readFileSync(k.command);bytes[bytes.length-1]=bytes[bytes.length-1]!^1;chmodSync(k.command,0o755);writeFileSync(k.command,bytes);chmodSync(k.command,0o555);}
    if (mutation==='config-directory') {renameSync(k.configDir,`${k.configDir}.old`);symlinkSync(`${k.configDir}.old`,k.configDir);}
    await expect(spawnTask(k,request,auth)).rejects.toThrow(mutation==='config-directory'?'external_cli_config_directory_changed':'external_cli_identity_');
    expect(k.tasks()).toEqual([]);expect(ledgers(k).filter(v=>v.kind==='task')).toEqual([]);expect(claims(k)).toBe(4);noLeaks(k);
  });
  it('each independently minted runner has its own first handoff, even with identical config bytes and index', async () => {
    const k=await kit({maxDepth:1});
    vi.stubEnv('PI_SUBAGENT_RUN_FANOUT_BUDGET',encodeRunFanoutBudgetDescriptor(k.budget));
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR',k.dir);vi.stubEnv('PI_SUBAGENT_MAX_DEPTH','1');vi.stubEnv('PI_SUBAGENT_MAX_SPAWNS_PER_SESSION','128');
    vi.stubEnv('BYOK_SDK_CUSTODY_LAUNCH_RECORD',undefined);configureCustodyExternalInstallations(k.installations);
    const dispatch=dispatchCustodyPiSubagentSpawn({child:'pi-subagent-runner',cwd:k.dir,runnerConfigPath:k.config});
    const parent=parseDescendantLaunch(JSON.parse(readFileSync(dispatch.recordPath,'utf8')));
    expect(parent.perLaunch.mcp.metadata['byok.custody.runnerConfigDigest']).toBe(k.parent.perLaunch.mcp.metadata['byok.custody.runnerConfigDigest']);
    expect(parent.perLaunch.mcp.metadata['byok.custody.launchId']).not.toBe(k.parent.perLaunch.mcp.metadata['byok.custody.launchId']);
    expect(externalCliCommitment(parent)).not.toBe(externalCliCommitment(k.parent));
    const second=new ExternalCliCustodyAuthority(parent,k.budget,k.installations,{},ownershipProbe,dispatch.recordPath);
    const first=await spawnTask(k,k.request(false,'same-operation'));await first.close;
    const request={...k.request(false,'same-operation'),stepIndex:0};const auth=await second.prepare(request);
    const child=await second.spawn(auth,{command:request.command,args:request.args,cwd:request.cwd,prompt:request.prompt,env:auth.env});
    const close=once(child,'close');child.stdin.end('');await close;await second.settled(child);
    expect(ledgers(k).filter(v=>v.kind==='task').map(v=>v.depth)).toEqual([1,1]);expect(k.tasks()).toHaveLength(2);noLeaks(k);
  });
  it('a later first external step and a retry cannot reclaim the initial logical charge at depth cap', async () => {
    const k=await kit({maxDepth:1});
    for (const change of [{stepIndex:1,attempt:0},{stepIndex:0,attempt:1}]) {
      const request={...k.request(),...change};const auth=await k.authority.prepare(request), before=claims(k);
      await expect(spawnTask(k,request,auth)).rejects.toThrow('external_cli_depth_exhausted');expect(claims(k)).toBe(before);
    }
    expect(k.tasks()).toEqual([]);expect(ledgers(k).filter(v=>v.kind==='task')).toEqual([]);noLeaks(k);
  });
  it('normal completion at root cap creates no ps/taskkill helper', async () => {
    const k=await kit({limit:5});
    const spy=vi.spyOn(childProcess,'spawnSync');
    try {
      const {runExternalCli}=await importVendor<{runExternalCli(input:Record<string,unknown>,authority:ExternalCliCustodyAuthority):Promise<{exitCode:number}>}>('runs/shared/external-cli-runner.ts');
      const request=k.request();const result=await runExternalCli({...request,asyncDir:k.dir,stepIndex:0},k.authority);
      expect(result.exitCode).toBe(0);expect(spy).not.toHaveBeenCalled();expect(claims(k)).toBe(5);expect(k.tasks()).toHaveLength(1);noLeaks(k);
    } finally {spy.mockRestore();}
  });
});

describe('sixth edge: cancellation at the actual child boundary', () => {
  it.each(['stop','timeout'] as const)('receives %s during prepare and refuses before a task PID or task claim exists', async reason => {
    const k=await kit(), request=k.request();
    const {runExternalCli}=await importVendor<{runExternalCli(input: Record<string,unknown>, authority: ExternalCliCustodyAuthority): Promise<unknown>}>('runs/shared/external-cli-runner.ts');
    let interrupt: (()=>void)|undefined, arrived=false, taskPids=0;
    const registration = (fn:(()=>void)|undefined) => { interrupt=fn; };
    const pending = runExternalCli({...request,args:[...request.args],asyncDir:k.dir,stepIndex:0,
      ...(reason==='stop'?{registerStop:registration}:{registerTimeout:registration}),
      onProcess:(process:{pid?:number})=>{if(process.pid)taskPids++;}},k.authority);
    const timer=setTimeout(()=>{arrived=true;interrupt?.();},0);
    try { await expect(pending).rejects.toThrow('external_cli_cancelled'); } finally {clearTimeout(timer);}
    expect(arrived).toBe(true);expect(taskPids).toBe(0);expect(k.tasks()).toEqual([]);
    expect(ledgers(k).filter(v=>v.kind==='task')).toEqual([]);noLeaks(k);
  });
  it('checks a cancellation after probes again at the final gate', async () => {
    const k=await kit(), request=k.request(), controller=new AbortController();
    const auth=await k.authority.prepare(request,{signal:controller.signal});
    expect(claims(k)).toBe(4);controller.abort();
    await expect(spawnTask(k,request,auth)).rejects.toThrow('external_cli_cancelled');
    expect(claims(k)).toBe(4);expect(ledgers(k).filter(v=>v.kind==='task')).toEqual([]);expect(k.tasks()).toEqual([]);noLeaks(k);
  });
  it('refuses an expired absolute deadline before a probe/task is created', async () => {
    const k=await kit(), request=k.request();
    expect(()=>k.authority.prepare(request,{deadlineAt:Date.now()-1})).toThrow('external_cli_deadline_exceeded');
    expect(claims(k)).toBe(1);expect(ledgers(k)).toEqual([]);expect(k.tasks()).toEqual([]);noLeaks(k);
  });
});

describe('sixth edge: unified input authority', () => {
  it('binds initial config bytes at payload/vendor read and refuses config mutation', async () => {
    const k=await kit(); vi.stubEnv('BYOK_SDK_CUSTODY_LAUNCH_RECORD',k.recordPath); activateVerifiedCustodyRunner(k.parent);
    expect(readAdmittedRunnerConfig(k.config)).toBeDefined();
    writeFileSync(k.config,JSON.stringify({steps:[{agent:'pi',task:'changed'}]}));
    expect(()=>readAdmittedRunnerConfig(k.config)).toThrow('external_cli_config_commitment_mismatch');
    expect(k.tasks()).toEqual([]);expect(claims(k)).toBe(1);noLeaks(k);
  });
  it('whole append batch refuses/acks a clean prefix plus an override, including hand-written files and replay', async () => {
    const k=await kit(); vi.stubEnv('BYOK_SDK_CUSTODY_LAUNCH_RECORD',k.recordPath); activateVerifiedCustodyRunner(k.parent);
    const append=await importVendor<{enqueueChainAppendRequest(input: Record<string,unknown>):unknown;consumeChainAppendRequests(dir:string):unknown[]}>('runs/background/chain-append.ts');
    writeFileSync(path.join(k.dir,'status.json'),JSON.stringify({runId:'append',mode:'chain',state:'running',steps:[{status:'running'}]}));
    const legal={agent:'fixture',task:'task',runner:{type:'external-cli',adapter:'codex-exec',command:k.command}};
    expect(externalCliConfigRefusal({steps:[legal]},'initial',k.installations)).toBeUndefined();
    append.enqueueChainAppendRequest({asyncDir:k.dir,runId:'append',steps:[legal],now:1});
    const invalid={...legal,runner:{...legal.runner,args:['--api-key',SECRET]}};
    append.enqueueChainAppendRequest({asyncDir:k.dir,runId:'append',steps:[invalid],now:2});
    expect(externalCliConfigRefusal({steps:[invalid]},'initial',k.installations)).toBe('external_cli_override_forbidden');
    expect(()=>append.consumeChainAppendRequests(k.dir)).toThrow('external_cli_override_forbidden');
    expect(readdirSync(path.join(k.dir,'append-requests'))).toEqual([]);
    expect(readdirSync(path.join(k.dir,'append-acks'))).toHaveLength(2);
    for (const f of readdirSync(path.join(k.dir,'append-acks'))) expect(readFileSync(path.join(k.dir,'append-acks',f),'utf8')).not.toContain(SECRET);
    expect(append.consumeChainAppendRequests(k.dir)).toEqual([]);
    writeFileSync(path.join(k.dir,'append-requests','manual.json'),JSON.stringify({id:'manual',createdAt:3,steps:[legal]}));
    expect(append.consumeChainAppendRequests(k.dir)).toHaveLength(1);
    writeFileSync(path.join(k.dir,'append-requests','manual.json'),JSON.stringify({id:'manual',createdAt:3,steps:[legal]}));
    expect(()=>append.consumeChainAppendRequests(k.dir)).toThrow('external_cli_append_replay');
    expect(k.tasks()).toEqual([]);expect(claims(k)).toBe(1);noLeaks(k);
  });
});
