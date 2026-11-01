import { testExecutionScratch } from "./fixtures/execution-scratch";
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { execFileSync, spawn as nativeSpawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import type { AgentEvent } from '@byok-sdk/protocol';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { sealRuntimeOperationManifest, type Session, type MessageDraftDelta } from '../types';
import { parseModelProviderProfile } from '../../../keys/src/provider-profile';
import { PI_MODEL_FIXTURE } from '../../../keys/src/fixtures/pi-model-config';
import { buildPiPreparedArgs, buildPiProviderProjection } from '../../../keys/src/pi-provider-projection';
import { parsePiProviderLauncherOptions, buildPiProviderChildEnvironment } from '../../../keys/src/pi-provider-launcher-core';
import { projectPiMcpEnvironment } from '../adapters/pi/mcp-environment';
import { testRuntimeEnv } from './fixtures/runtime-env';
import type { ToolAuthorizationGate, ToolCall, ToolFileScope } from '../tool-authorization';
import { resolveFileScopeGrant } from '../file-scope-guard';
import { bindFileScopeGate } from '../file-scope-gate-binding';
import type { ScopedFileDenial } from '../file-scope-tools';
const ownedGroups=new Set<number>();
const roots: string[] = [], servers: Server[] = [], sessions: Session[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const session of sessions.splice(0)) await session.close();
  for(const group of ownedGroups){try{process.kill(-group,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}ownedGroups.clear();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function finish(res: import('node:http').ServerResponse, content: string) {
  const base = { id: 'cmpl-test', object: 'chat.completion.chunk', created: 0, model: 'test' };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end([ { ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
}
function tool(res: import('node:http').ServerResponse, command: string, name = 'bash') {
  const args = name === 'bash' ? {command} : name === 'find' ? {pattern:'*',path:command} : name === 'grep' ? {pattern:'REPLICA_MARKER',path:command} : name === 'edit' ? {path:command,edits:[{oldText:'ORIGINAL_DENIED_DATA',newText:'CHANGED'}]} : name === 'write' ? {path:command,content:'CHANGED'} : {path:command};
  const base = { id: 'cmpl-tool', object: 'chat.completion.chunk', created: 0, model: 'test' };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end([
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-test', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
}
async function fixture(respond: (res: import('node:http').ServerResponse, ordinal: number, body: string, paths: {home:string;store:string}) => void, lifecycle?: {ownsLease?():boolean; record?(kind:string,n:number):Promise<void>}, gateFor?: (home: string) => Promise<ToolAuthorizationGate>) {
const __executionScratch = await testExecutionScratch();

  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'byok-durable-launch-'))); roots.push(root);
  const home = path.join(root, 'home'), store = path.join(root, 'store'); await mkdir(home); await mkdir(store);
  let calls = 0; const bodies: string[] = [], authorizations: unknown[] = [];
  const server = createServer((req,res) => { let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => { bodies.push(body); authorizations.push(req.headers.authorization); respond(res, ++calls, body,{home,store}); }); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no provider port');
  const profile = parseModelProviderProfile({ adapter: 'openai_compatible', auth_mode: 'bearer', base_url: `http://127.0.0.1:${address.port}/v1`, capabilities: [], created_at: '2026-09-10T00:00:00.000Z', updated_at: '2026-09-10T00:00:00.000Z', display_name: 'Synthetic', enabled: true, kind: 'model', model: 'test', profile_ref: 'probe', provider_kind: 'custom', pi_model: { ...PI_MODEL_FIXTURE, contextWindow: 4096, maxTokens: 64, reasoning: false, thinkingLevel: 'off' } });
  const children: ChildProcess[] = [];
  const adapter = new PiAdapter({ durableLane: true, byokLauncher: { command: 'synthetic-custody-launcher', profileDbPath: path.join(root,'profiles'), sessionDir: path.join(root,'sessions') },
    spawnFn: ((_cmd, args, options) => {
      const parsed = parsePiProviderLauncherOptions(args as string[]); expect(parsed.runtimeEntry).toBe('pi-durable');
      const delegated = buildPiPreparedArgs(parsed.piArgs);
      const env = buildPiProviderChildEnvironment({ ambient: options!.env!, projectionDir: parsed.piProjectionDir!, sessionDir: parsed.sessionDir, secret: undefined });
      writeFileSync(path.join(env.PI_CODING_AGENT_DIR!, 'models.json'), JSON.stringify(buildPiProviderProjection(profile, parsed.runtimeEntry)), { mode: 0o600 });
      const child = nativeSpawn(parsed.piBin, [...(parsed.piEntry ? [parsed.piEntry] : []), `--config-digest=${parsed.piConfigDigest}`, ...delegated], { ...options, env, cwd: parsed.piCwd!, stdio: ['pipe','pipe','pipe','ipc'], serialization: 'json' } as never);
      expect(env.PI_PROVIDER_API_KEY).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain('DURABLE_PROVIDER_SENTINEL');
      child.once('message', value => {
        expect(value).toEqual({ type: 'byok.pi.durable.credential-request', configDigest: parsed.piConfigDigest });
        child.send({ type: 'byok.pi.durable.credential', configDigest: parsed.piConfigDigest, secret: 'DURABLE_PROVIDER_SENTINEL' });
      });
      children.push(child); return child;
    }) as typeof nativeSpawn,
  });
  const selection = { lane: 'byok' as const, runtimeId: 'pi' as const, providerId: 'probe', modelId: 'test' };
  const offer = { instruction: 'Host authority input\nHost context second line', dispatchSelection: selection };
  const prepared = await adapter.prepare({ offer } as never);
  if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
  const env = testRuntimeEnv();
  const launch = await prepared.operation.resolveRuntimeLaunch!({ scratch: __executionScratch,  kind: 'instruction', cwd: home, env,  });
  const manifest = sealRuntimeOperationManifest({ taskId: 'task', runtimeId: 'pi', descriptor: adapter.descriptor, dispatchSelection: selection, requiredToolsetIds: [], cwd: home, workspace: { workspaceDir: home }, agentRef: { agentId: 'agent', profileRevision: 'revision' }, lease: { leaseId: 'lease', canonicalHome: home }, forwardedEnvironmentNames: Object.keys(env) });
  const journal: string[] = [];
  const toolAuthorization = await gateFor?.(home);
  const session = await prepared.operation.start({ ...(toolAuthorization === undefined ? {} : { toolAuthorization }), scratch: (launch).scratch,  kind: 'instruction', instruction: 'Host authority input\nHost context second line', manifest, env, runtimeLaunch: launch, mcpEnv: projectPiMcpEnvironment(env), durableContext: { replicaRoot: path.join(store, 'durable-replicas'), tenantId: 'tenant', lifecycle: { ownsLease: () => lifecycle?.ownsLease?.() ?? true, record: async (kind,n) => { journal.push(`${kind}:${n}`); await lifecycle?.record?.(kind,n); } } } }); sessions.push(session);
  return { session, children, calls: () => calls, bodies, authorizations, home, journal };
}
/** A recording auto gate bound to a resolved grant; it denies bash and allows the rest. */
async function scopedGate(home: string, fileScope: ToolFileScope, asked: string[], denials: ScopedFileDenial[]): Promise<ToolAuthorizationGate> {
  const gate: ToolAuthorizationGate = { timeoutMs: 5_000, authorize: async (call: ToolCall) => {
    asked.push(call.toolName);
    return call.toolName === 'bash' ? { decision: 'deny', code: 'tool_authorization_denied', reason: 'synthetic denial' } : { decision: 'allow' };
  } };
  const identity = await stat(home, { bigint: true });
  const grant = await resolveFileScopeGrant({ fileScope, home: { path: home, identity: { dev: identity.dev, ino: identity.ino } } });
  bindFileScopeGate(gate, { grant, taskId: 'task', lane: 'durable', homeAccess: 'writer', onDeny: denial => denials.push(denial) });
  return gate;
}
function liveGroup(pgid:number):number[] {return execFileSync('ps',['-eo','pid=,pgid=,stat='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().split(/\s+/u)).filter(([,group,stat])=>Number(group)===pgid&&!stat!.startsWith('Z')).map(([pid])=>Number(pid));}
// Windows durable execution is fail-closed pending a validated parent-death Job Object design.
describe.skipIf(process.platform === 'win32')('durable ordinary worker through custody argv', () => {
  it('real worker sends Host input and reports completion and ordinary usage', async () => {
    const f = await fixture(res => finish(res, 'complete'));
    const events:Array<AgentEvent | MessageDraftDelta> = []; for await (const event of f.session.events) events.push(event);
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 3, cachedInputTokens: 0, outputTokens: 2, totalTokens: 5 }]);
    // Wire v3: no in-replica result document; a result-document outcome goes through submit_result.
    expect(f.session).not.toHaveProperty('resultDocument'); expect(events.some(event => event.type === 'artifact')).toBe(false);
    expect(f.bodies[0]).toContain('Host authority input'); expect(JSON.parse(f.bodies[0]!).messages.some((message: {content:unknown}) => typeof message.content === 'string' && message.content.includes('Host context second line'))).toBe(true); expect(f.authorizations).toEqual(['Bearer DURABLE_PROVIDER_SENTINEL']);
    expect(f.bodies.join('')).not.toContain('DURABLE_PROVIDER_SENTINEL'); expect(f.calls()).toBe(1);
  });
  it('real bash cannot inherit launcher credentials; durable tool ids and committed receipts agree', async () => {
    vi.stubEnv('BYOK_TEST_ENV_MARKER', '1');
    expect(process.env.BYOK_TEST_ENV_MARKER).toBe('1');
    const command = `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify({key:process.env.PI_PROVIDER_API_KEY,control:process.env.BYOK_TEST_ENV_MARKER}))'`;
    const f = await fixture((res,n) => { if (n === 1) tool(res, command); else finish(res, 'isolated'); });
    const events:Array<AgentEvent | MessageDraftDelta> = []; for await (const event of f.session.events) events.push(event);
    expect(events.some(event => event.type === 'error')).toBe(false); expect(f.calls()).toBe(2);
    const use = events.find(event => event.type === 'tool_use'), result = events.find(event => event.type === 'tool_result');
    expect(use?.type).toBe('tool_use'); expect(result?.type).toBe('tool_result');
    if (use?.type !== 'tool_use' || result?.type !== 'tool_result') throw new Error('tool events missing');
    expect(use.toolCallId).not.toBe('call-test'); expect(result.toolCallId).toBe(use.toolCallId);
    const output = result.output as { content: Array<{ type: string; text?: string }> };
    expect(output.content.filter(block => block.type === 'text').map(block => block.text).join('').trim()).toBe('{}');
    expect(f.bodies.join('')).not.toContain('DURABLE_PROVIDER_SENTINEL');
    expect(f.journal).toEqual(['tool-intent:0', 'tool-committed:0']);
  });
  // The SDK adds no workspace containment: a structured file tool reaches a
  // path outside the workspace, as the local agent itself would.
  it.each(['read','write','edit'])('real %s reaches an @ path outside the workspace', async name => {
    const dir = await mkdtemp(path.join(os.tmpdir(),'byok-path-outside-')); roots.push(dir);
    const outside = path.join(dir,'outside.txt'); await writeFile(outside,'ORIGINAL_DENIED_DATA\nOUTSIDE_FILE_MARKER');
    const f = await fixture((res,n) => { if (n === 1) tool(res,`@${outside}`,name); else finish(res,'reached'); });
    const events:Array<AgentEvent | MessageDraftDelta> = []; for await (const event of f.session.events) events.push(event);
    const result = events.find(event => event.type === 'tool_result');
    expect(result?.type).toBe('tool_result'); if (result?.type !== 'tool_result') throw new Error('result missing');
    expect(result.isError).toBe(false);
    if (name === 'read') expect(JSON.stringify(result.output)).toContain('OUTSIDE_FILE_MARKER');
    else expect(await readFile(outside,'utf8')).toContain('CHANGED');
  });
  // The durable replica store stays private to the SDK.
  it.each(['read','write','edit'])('real %s rejects a path inside the durable replica store before file access', async name => {
    let target = '';
    const f = await fixture((res,n,_body,paths) => { target = path.join(paths.store,'durable-replicas','probe.txt'); if (n === 1) tool(res,target,name); else finish(res,'denied'); });
    const events:Array<AgentEvent | MessageDraftDelta> = []; for await (const event of f.session.events) events.push(event);
    const result = events.find(event => event.type === 'tool_result');
    expect(result?.type).toBe('tool_result'); if (result?.type !== 'tool_result') throw new Error('result missing');
    expect(result.isError).toBe(true); expect(JSON.stringify(result.output)).toContain('structured tool path inside replica store');
    await expect(readFile(target,'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('credential never enters the real worker initial environment, including OS process introspection from bash', async () => {
    const command = process.platform === 'darwin' ? 'ps eww -p "$PPID"' : process.platform === 'linux' ? 'cat /proc/$PPID/environ' : 'env';
    const f = await fixture((res,n) => { if (n === 1) tool(res, command); else finish(res, 'introspection complete'); });
    const events:Array<AgentEvent | MessageDraftDelta> = []; for await (const event of f.session.events) events.push(event);
    expect(events.some(event => event.type === 'error')).toBe(false);
    const result = events.find(event => event.type === 'tool_result');
    expect(result?.type).toBe('tool_result');
    if (result?.type !== 'tool_result') throw new Error('introspection tool result missing');
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.output)).not.toContain('DURABLE_PROVIDER_SENTINEL');
    expect(f.bodies.join('')).not.toContain('DURABLE_PROVIDER_SENTINEL');
    expect(f.authorizations).toEqual(['Bearer DURABLE_PROVIDER_SENTINEL','Bearer DURABLE_PROVIDER_SENTINEL']);
    if (process.platform === 'darwin') expect(execFileSync('ps', ['eww','-p',String(f.children[0]!.pid)], {encoding:'utf8'})).not.toContain('DURABLE_PROVIDER_SENTINEL');
    else if (process.platform === 'linux') expect(await readFile(`/proc/${f.children[0]!.pid}/environ`, 'utf8')).not.toContain('DURABLE_PROVIDER_SENTINEL');
    expect(f.children[0]!.connected).toBe(false);
  });
  it('crash during unsafe tool ends the execution without replay or model resume', async () => {
    // Write tool-pid before marker: the wait below watches only marker, then reads tool-pid.
    const f = await fixture((res,n) => { if (n === 1) tool(res, 'echo $$ > tool-pid; printf once >> marker; sleep 60'); else finish(res, 'should never happen'); });
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      try { if ((await readFile(path.join(f.home, 'marker'), 'utf8')) === 'once') break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(await readFile(path.join(f.home, 'marker'), 'utf8')).toBe('once');
    const group=Number(execFileSync('ps',['-p',(await readFile(path.join(f.home,'tool-pid'),'utf8')).trim(),'-o','pgid='],{encoding:'utf8'}).trim());ownedGroups.add(group);expect(liveGroup(group).length).toBeGreaterThan(0);
    f.children[0]!.kill('SIGKILL');
    const events:Array<AgentEvent | MessageDraftDelta> = []; await expect((async()=>{for await (const event of f.session.events) events.push(event);})()).rejects.toMatchObject({phase:'run',retry:'non-retryable'});
    expect(events.at(-1)?.type).toBe('error'); expect(events.some(event => event.type === 'turn_end')).toBe(false);
    expect(f.calls()).toBe(1); expect(f.journal).toEqual(['tool-intent:0']);
    await vi.waitFor(()=>expect(liveGroup(group)).toEqual([]),{timeout:4_000,interval:20});
    expect(await readFile(path.join(f.home, 'marker'), 'utf8')).toBe('once');
  });
  it('checkpoint recovery resends the model even with maxRetries zero and preserves M9', async () => {
    let kill: (() => void) | undefined;
    const f = await fixture((res,n) => { if (n === 1) { setTimeout(() => kill?.(), 20); return; } finish(res, 'resumed'); });
    kill = () => { f.children[0]!.kill('SIGKILL'); };
    const events:Array<AgentEvent | MessageDraftDelta> = []; for await (const event of f.session.events) events.push(event);
    expect(f.calls()).toBe(2); expect(f.journal).toEqual(['respawn-intent:1']);
    expect(events.some(event => event.type === 'error')).toBe(false); expect(events.at(-1)).toEqual({ type: 'turn_end' });
    expect(f.session).not.toHaveProperty('resultDocument');
    expect(events.filter(event => event.type === 'usage')).toHaveLength(1); // interrupted attempt supplied no usage
  });
  it('third respawn is refused after two checkpoint recoveries without more model activity', async () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    f=await fixture((_res,n)=>{setTimeout(()=>f.children[n-1]?.kill('SIGKILL'),50);});
    const events:Array<AgentEvent | MessageDraftDelta>=[];await expect((async()=>{for await(const event of f.session.events)events.push(event);})()).rejects.toMatchObject({phase:'run',retry:'non-retryable'});
    expect(f.children).toHaveLength(3);expect(f.calls()).toBe(3);expect(f.journal).toEqual(['respawn-intent:1','respawn-intent:2']);
    expect(events.at(-1)?.type).toBe('error');expect(events.some(event=>event.type==='turn_end')).toBe(false);
    await new Promise(resolve=>setTimeout(resolve,150));expect(f.calls()).toBe(3);
  },30_000);
  it('lease loss while respawn intent is being committed refuses a replacement worker', async () => {
    let owned=true;let f:Awaited<ReturnType<typeof fixture>>;
    f=await fixture(()=>{setTimeout(()=>f.children[0]?.kill('SIGKILL'),50);},{ownsLease:()=>owned,record:async kind=>{if(kind==='respawn-intent')owned=false;}});
    const events:Array<AgentEvent | MessageDraftDelta>=[];await expect((async()=>{for await(const event of f.session.events)events.push(event);})()).rejects.toMatchObject({phase:'run',retry:'non-retryable'});
    expect(f.children).toHaveLength(1);expect(f.calls()).toBe(1);expect(f.journal).toEqual(['respawn-intent:1']);expect(events.at(-1)?.type).toBe('error');
    await new Promise(resolve=>setTimeout(resolve,150));expect(f.calls()).toBe(1);
  },30_000);
  it.each(['model','tool'])('interrupt during %s disposes the worker and tool group without further effects', async phase=>{
    const f=await fixture((res,n)=>{if(phase==='tool'&&n===1)tool(res,`echo $$ > tool-pid; while true; do printf tick >> cancel-effects; sleep 0.05; done`);});
    await vi.waitFor(()=>expect(f.calls()).toBe(1),{timeout:4_000,interval:20});
    let group:number|undefined;
    if(phase==='tool'){await vi.waitFor(async()=>expect((await readFile(path.join(f.home,'cancel-effects'),'utf8')).length).toBeGreaterThan(0),{timeout:4_000,interval:20});group=Number(execFileSync('ps',['-p',(await readFile(path.join(f.home,'tool-pid'),'utf8')).trim(),'-o','pgid='],{encoding:'utf8'}).trim());ownedGroups.add(group);expect(liveGroup(group).length).toBeGreaterThan(0);}
    await f.session.interrupt();await f.session.close();
    expect(f.children.every(child=>child.exitCode!==null||child.signalCode!==null)).toBe(true);
    if(group!==undefined)expect(liveGroup(group)).toEqual([]);
    const effects=phase==='tool'?await readFile(path.join(f.home,'cancel-effects'),'utf8'):undefined;
    await new Promise(resolve=>setTimeout(resolve,250));expect(f.calls()).toBe(1);
    if(effects!==undefined)expect(await readFile(path.join(f.home,'cancel-effects'),'utf8')).toBe(effects);
    expect(f.journal.filter(row=>row.startsWith('respawn'))).toEqual([]);
  },30_000);
  it('same-turn bash symlink followed by write is denied across the parent ACK window', async()=>{
    let home='';let intents=0;
    const f=await fixture((res,n,_body,paths)=>{home=paths.home;if(n!==1){finish(res,'denied');return;}
      const base={id:'race',object:'chat.completion.chunk',created:0,model:'test'};
      const calls=[{name:'bash',args:{command:`sleep 0.1; ln -s ${JSON.stringify(path.join(paths.store,"durable-replicas"))} race-link; printf ready > race-ready`}},{name:'write',args:{path:'race-link/forbidden.txt',content:'RACE_WRITE'}}];
      res.writeHead(200,{'content-type':'text/event-stream'});res.end([{...base,choices:[{index:0,delta:{role:'assistant',tool_calls:calls.map((call,index)=>({index,id:`race-${index}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}))},finish_reason:null}]},{...base,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}}].map(value=>`data: ${JSON.stringify(value)}\n\n`).join('')+'data: [DONE]\n\n');
    },{record:async kind=>{if(kind==='tool-intent'&&++intents===2)await vi.waitFor(async()=>expect(await readFile(path.join(home,'race-ready'),'utf8')).toBe('ready'),{timeout:4_000,interval:20});}});
    const events:Array<AgentEvent | MessageDraftDelta>=[];for await(const event of f.session.events)events.push(event);
    const results=events.filter(event=>event.type==='tool_result');expect(results).toHaveLength(2);expect(results[1]?.isError).toBe(true);expect(JSON.stringify(results[1])).toContain('structured tool path');
    await expect(readFile(path.join(home,'race-link/forbidden.txt'))).rejects.toThrow();expect(await readFile(path.join(home,'race-ready'),'utf8')).toBe('ready');
  },30_000);
  it('a file-scoped auto task gets the SDK scoped file tools, denies out-of-scope paths and asks the gate for the rest (#1061)', async () => {
    const outside = path.join(await realpath(await mkdtemp(path.join(os.tmpdir(), 'byok-durable-scope-outside-'))), 'outside.txt'); roots.push(path.dirname(outside));
    const asked: string[] = [], denials: ScopedFileDenial[] = [];
    const f = await fixture((res, n) => {
      if (n === 1) tool(res, outside, 'write'); else if (n === 2) tool(res, 'inside.txt', 'write'); else if (n === 3) tool(res, 'printf x > bash.txt'); else finish(res, 'scoped');
    }, undefined, home => scopedGate(home, { mode: 'home' }, asked, denials));
    const events:Array<AgentEvent | MessageDraftDelta> = []; for await (const event of f.session.events) events.push(event);
    expect(events.some(event => event.type === 'error')).toBe(false);
    const tools = (JSON.parse(f.bodies[0]!) as { tools: { function: { name: string } }[] }).tools.map(entry => entry.function.name).sort();
    expect(tools).toEqual(['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write']);
    expect(events.filter(event => event.type === 'tool_result').map(event => event.type === 'tool_result' && event.isError)).toEqual([true, false, true]);
    // The scope denies the outside write before the gate; the gate decides the in-scope write and the shell.
    expect(denials).toEqual([expect.objectContaining({ toolName: 'write', code: 'file_scope_denied' })]);
    expect(asked).toEqual(['write', 'bash']);
    await expect(readFile(outside)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(f.home, 'inside.txt'), 'utf8')).toBe('CHANGED');
    await expect(readFile(path.join(f.home, 'bash.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);
  // A granted root that contains the daemon store still cannot list the replica store.
  it.each(['ls','find'])('scoped %s rejects the durable replica store inside a granted root', async name => {
    const asked: string[] = [], denials: ScopedFileDenial[] = [];
    const f = await fixture((res,n,_body,paths) => { if (n === 1) tool(res,path.join(paths.store,'durable-replicas'),name); else finish(res,'denied'); },
      undefined, home => scopedGate(home, { mode: 'workspaces', roots: [{ id: 'all', path: path.dirname(home), access: 'read' }] }, asked, denials));
    const events:Array<AgentEvent | MessageDraftDelta> = []; for await (const event of f.session.events) events.push(event);
    const result = events.find(event => event.type === 'tool_result');
    expect(result?.type).toBe('tool_result'); if (result?.type !== 'tool_result') throw new Error('result missing');
    expect(result.isError).toBe(true); expect(JSON.stringify(result.output)).toContain('structured tool path inside replica store');
    expect(asked).toEqual([]); expect(denials).toEqual([]);
  }, 30_000);
  it.each(['find','grep'])('scoped %s started at a granted root that contains the store never walks into the replica store', async name => {
    const asked: string[] = [], denials: ScopedFileDenial[] = [];
    const f = await fixture((res,n,_body,paths) => {
      if (n !== 1) { finish(res,'walked'); return; }
      writeFileSync(path.join(paths.store,'durable-replicas','probe.txt'),'REPLICA_MARKER'); writeFileSync(path.join(paths.home,'visible.txt'),'REPLICA_MARKER');
      tool(res,path.dirname(paths.home),name);
    }, undefined, home => scopedGate(home, { mode: 'workspaces', roots: [{ id: 'all', path: path.dirname(home), access: 'read' }] }, asked, denials));
    const events:Array<AgentEvent | MessageDraftDelta> = []; for await (const event of f.session.events) events.push(event);
    const result = events.find(event => event.type === 'tool_result');
    expect(result?.type).toBe('tool_result'); if (result?.type !== 'tool_result') throw new Error('result missing');
    expect(result.isError).toBe(false); expect(asked).toEqual([name]);
    expect(JSON.stringify(result.output)).toContain('visible.txt'); expect(JSON.stringify(result.output)).not.toContain('durable-replicas');
  }, 30_000);
});
