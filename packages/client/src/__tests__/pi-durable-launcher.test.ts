import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { execFileSync, spawn as nativeSpawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import type { AgentEvent } from '@byok-sdk/protocol';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { sealRuntimeOperationManifest, type Session } from '../types';
import { parseModelProviderProfile } from '../../../keys/src/provider-profile';
import { PI_MODEL_FIXTURE } from '../../../keys/src/fixtures/pi-model-config';
import { buildPiPreparedArgs, buildPiProviderProjection } from '../../../keys/src/pi-provider-projection';
import { parsePiProviderLauncherOptions, buildPiProviderChildEnvironment } from '../../../keys/src/pi-provider-launcher-core';
import { projectPiMcpEnvironment } from '../adapters/pi/mcp-environment';
import { buildRuntimeEnv } from '../daemon/environment';
const ownedGroups=new Set<number>();
const roots: string[] = [], servers: Server[] = [], sessions: Session[] = [];
afterEach(async () => {
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
  const args = name === 'bash' ? {command} : name === 'edit' ? {path:command,edits:[{oldText:'ORIGINAL_DENIED_DATA',newText:'CHANGED'}]} : name === 'write' ? {path:command,content:'CHANGED'} : {path:command};
  const base = { id: 'cmpl-tool', object: 'chat.completion.chunk', created: 0, model: 'test' };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end([
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-test', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
}
async function fixture(respond: (res: import('node:http').ServerResponse, ordinal: number, body: string, paths: {home:string;store:string}) => void, lifecycle?: {ownsLease?():boolean; record?(kind:string,n:number):Promise<void>}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'byok-durable-launch-'))); roots.push(root);
  const home = path.join(root, 'home'), store = path.join(root, 'store'); await mkdir(home); await mkdir(store);
  let calls = 0; const bodies: string[] = [], authorizations: unknown[] = [];
  const server = createServer((req,res) => { let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => { bodies.push(body); authorizations.push(req.headers.authorization); respond(res, ++calls, body,{home,store}); }); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no provider port');
  const profile = parseModelProviderProfile({ adapter: 'openai_compatible', auth_mode: 'bearer', base_url: `http://127.0.0.1:${address.port}/v1`, capabilities: [], created_at: '2026-09-10T00:00:00.000Z', updated_at: '2026-09-10T00:00:00.000Z', display_name: 'Synthetic', enabled: true, kind: 'model', model: 'test', profile_ref: 'probe', provider_kind: 'custom', pi_model: { ...PI_MODEL_FIXTURE, contextWindow: 4096, maxTokens: 64, reasoning: false, thinkingLevel: 'off' } });
  const children: ChildProcess[] = [];
  const adapter = new PiAdapter({ durablePi: { replicaRoot: path.join(store, 'durable') }, byokLauncher: { command: 'synthetic-custody-launcher', profileDbPath: path.join(root,'profiles'), sessionDir: path.join(root,'sessions') },
    spawnFn: ((_cmd, args, options) => {
      const parsed = parsePiProviderLauncherOptions(args as string[]); expect(parsed.runtimeEntry).toBe('pi-durable');
      const delegated = buildPiPreparedArgs(parsed.piArgs);
      const env = buildPiProviderChildEnvironment({ ambient: options!.env!, binding: parsed.launchBinding!, sessionDir: parsed.sessionDir, secret: undefined });
      writeFileSync(path.join(env.PI_CODING_AGENT_DIR!, 'models.json'), JSON.stringify(buildPiProviderProjection(profile, parsed.runtimeEntry)), { mode: 0o600 });
      const child = nativeSpawn(parsed.piBin, [...(parsed.piEntry ? [parsed.piEntry] : []), ...parsed.piFixedArgs!, `--config-digest=${parsed.piConfigDigest}`, ...delegated], { ...options, env, cwd: parsed.piCwd!, stdio: ['pipe','pipe','pipe','ipc'], serialization: 'json' } as never);
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
  const env = buildRuntimeEnv({ ambient: process.env });
  const launch = await prepared.operation.resolveRuntimeLaunch!({ kind: 'instruction', cwd: home, env, projectionRoot: path.join(store,'projections') });
  const manifest = sealRuntimeOperationManifest({ taskId: 'task', runtimeId: 'pi', descriptor: adapter.descriptor, dispatchSelection: selection, requiredToolsetIds: [], cwd: home, workspace: { workspaceDir: home }, agentRef: { agentId: 'agent', profileRevision: 'revision' }, lease: { leaseId: 'lease', canonicalHome: home }, forwardedEnvironmentNames: Object.keys(env) });
  const journal: string[] = [];
  const session = await prepared.operation.start({ kind: 'instruction', instruction: 'Host authority input\nHost context second line', manifest, env, runtimeLaunch: launch, mcpEnv: projectPiMcpEnvironment(env), durableContext: { tenantId: 'tenant', lifecycle: { ownsLease: () => lifecycle?.ownsLease?.() ?? true, record: async (kind,n) => { journal.push(`${kind}:${n}`); await lifecycle?.record?.(kind,n); } } } }); sessions.push(session);
  return { session, children, calls: () => calls, bodies, authorizations, home, journal };
}
function liveGroup(pgid:number):number[] {return execFileSync('ps',['-eo','pid=,pgid=,stat='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().split(/\s+/u)).filter(([,group,stat])=>Number(group)===pgid&&!stat!.startsWith('Z')).map(([pid])=>Number(pid));}
// Windows durable execution is fail-closed pending a validated parent-death Job Object design.
describe.skipIf(process.platform === 'win32')('durable ordinary worker through custody argv', () => {
  it('real worker sends Host input and reports selected result and ordinary usage', async () => {
    const f = await fixture(res => finish(res, 'complete'));
    const events:AgentEvent[] = []; for await (const event of f.session.events) events.push(event);
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 3, cachedInputTokens: 0, outputTokens: 2, totalTokens: 5 }]);
    expect(f.session.resultDocument!()).toEqual({ text: 'complete' });
    expect(f.bodies[0]).toContain('Host authority input'); expect(JSON.parse(f.bodies[0]!).messages.some((message: {content:unknown}) => typeof message.content === 'string' && message.content.includes('Host context second line'))).toBe(true); expect(f.authorizations).toEqual(['Bearer DURABLE_PROVIDER_SENTINEL']);
    expect(f.bodies.join('')).not.toContain('DURABLE_PROVIDER_SENTINEL'); expect(f.calls()).toBe(1);
  });
  it('real bash cannot inherit launcher credentials; durable tool ids and committed receipts agree', async () => {
    const command = `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify({key:process.env.PI_PROVIDER_API_KEY,control:process.env.BYOK_TEST_DEVICE_CREDENTIAL_STORE}))'`;
    const f = await fixture((res,n) => { if (n === 1) tool(res, command); else finish(res, 'isolated'); });
    const events:AgentEvent[] = []; for await (const event of f.session.events) events.push(event);
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
  it.each(['read','write','edit'])('real %s rejects an @ outside path before file access', async name => {
    const dir = await mkdtemp(path.join(os.tmpdir(),'byok-path-outside-')); roots.push(dir);
    const outside = path.join(dir,'outside.txt'); await writeFile(outside,'ORIGINAL_DENIED_DATA\nPRIVATE_FILE_ONLY_MARKER');
    const f = await fixture((res,n) => { if (n === 1) tool(res,`@${outside}`,name); else finish(res,'denied'); });
    const events:AgentEvent[] = []; for await (const event of f.session.events) events.push(event);
    const result = events.find(event => event.type === 'tool_result');
    expect(result?.type).toBe('tool_result'); if (result?.type !== 'tool_result') throw new Error('result missing');
    expect(result.isError).toBe(true); expect(JSON.stringify(result.output)).toContain('structured tool path');
    expect(await readFile(outside,'utf8')).toBe('ORIGINAL_DENIED_DATA\nPRIVATE_FILE_ONLY_MARKER');
    expect(f.bodies.join('')).not.toContain('PRIVATE_FILE_ONLY_MARKER');
  });
  it('credential never enters the real worker initial environment, including OS process introspection from bash', async () => {
    const command = process.platform === 'darwin' ? 'ps eww -p "$PPID"' : process.platform === 'linux' ? 'cat /proc/$PPID/environ' : 'env';
    const f = await fixture((res,n) => { if (n === 1) tool(res, command); else finish(res, 'introspection complete'); });
    const events:AgentEvent[] = []; for await (const event of f.session.events) events.push(event);
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
    const f = await fixture((res,n) => { if (n === 1) tool(res, 'printf once >> marker; echo $$ > tool-pid; sleep 60'); else finish(res, 'should never happen'); });
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      try { if ((await readFile(path.join(f.home, 'marker'), 'utf8')) === 'once') break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(await readFile(path.join(f.home, 'marker'), 'utf8')).toBe('once');
    const group=Number(execFileSync('ps',['-p',(await readFile(path.join(f.home,'tool-pid'),'utf8')).trim(),'-o','pgid='],{encoding:'utf8'}).trim());ownedGroups.add(group);expect(liveGroup(group).length).toBeGreaterThan(0);
    f.children[0]!.kill('SIGKILL');
    const events:AgentEvent[] = []; await expect((async()=>{for await (const event of f.session.events) events.push(event);})()).rejects.toMatchObject({phase:'run',retry:'non-retryable'});
    expect(events.at(-1)?.type).toBe('error'); expect(events.some(event => event.type === 'turn_end')).toBe(false);
    expect(f.calls()).toBe(1); expect(f.journal).toEqual(['tool-intent:0']);
    await vi.waitFor(()=>expect(liveGroup(group)).toEqual([]),{timeout:4_000,interval:20});
    expect(await readFile(path.join(f.home, 'marker'), 'utf8')).toBe('once');
  });
  it('checkpoint recovery resends the model even with maxRetries zero and preserves M9', async () => {
    let kill: (() => void) | undefined;
    const f = await fixture((res,n) => { if (n === 1) { setTimeout(() => kill?.(), 20); return; } finish(res, 'resumed'); });
    kill = () => { f.children[0]!.kill('SIGKILL'); };
    const events:AgentEvent[] = []; for await (const event of f.session.events) events.push(event);
    expect(f.calls()).toBe(2); expect(f.journal).toEqual(['respawn-intent:1']);
    expect(events.some(event => event.type === 'error')).toBe(false); expect(events.at(-1)).toEqual({ type: 'turn_end' });
    expect(f.session.resultDocument!()).toEqual({ text: 'resumed' });
    expect(events.filter(event => event.type === 'usage')).toHaveLength(1); // interrupted attempt supplied no usage
  });
  it('third respawn is refused after two checkpoint recoveries without more model activity', async () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    f=await fixture((_res,n)=>{setTimeout(()=>f.children[n-1]?.kill('SIGKILL'),50);});
    const events:AgentEvent[]=[];await expect((async()=>{for await(const event of f.session.events)events.push(event);})()).rejects.toMatchObject({phase:'run',retry:'non-retryable'});
    expect(f.children).toHaveLength(3);expect(f.calls()).toBe(3);expect(f.journal).toEqual(['respawn-intent:1','respawn-intent:2']);
    expect(events.at(-1)?.type).toBe('error');expect(events.some(event=>event.type==='turn_end')).toBe(false);
    await new Promise(resolve=>setTimeout(resolve,150));expect(f.calls()).toBe(3);
  },30_000);
  it('lease loss while respawn intent is being committed refuses a replacement worker', async () => {
    let owned=true;let f:Awaited<ReturnType<typeof fixture>>;
    f=await fixture(()=>{setTimeout(()=>f.children[0]?.kill('SIGKILL'),50);},{ownsLease:()=>owned,record:async kind=>{if(kind==='respawn-intent')owned=false;}});
    const events:AgentEvent[]=[];await expect((async()=>{for await(const event of f.session.events)events.push(event);})()).rejects.toMatchObject({phase:'run',retry:'non-retryable'});
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
      const calls=[{name:'bash',args:{command:`sleep 0.1; ln -s ${JSON.stringify(paths.store)} race-link; printf ready > race-ready`}},{name:'write',args:{path:'race-link/forbidden.txt',content:'RACE_WRITE'}}];
      res.writeHead(200,{'content-type':'text/event-stream'});res.end([{...base,choices:[{index:0,delta:{role:'assistant',tool_calls:calls.map((call,index)=>({index,id:`race-${index}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}))},finish_reason:null}]},{...base,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}}].map(value=>`data: ${JSON.stringify(value)}\n\n`).join('')+'data: [DONE]\n\n');
    },{record:async kind=>{if(kind==='tool-intent'&&++intents===2)await vi.waitFor(async()=>expect(await readFile(path.join(home,'race-ready'),'utf8')).toBe('ready'),{timeout:4_000,interval:20});}});
    const events:AgentEvent[]=[];for await(const event of f.session.events)events.push(event);
    const results=events.filter(event=>event.type==='tool_result');expect(results).toHaveLength(2);expect(results[1]?.isError).toBe(true);expect(JSON.stringify(results[1])).toContain('structured tool path');
    await expect(readFile(path.join(home,'race-link/forbidden.txt'))).rejects.toThrow();expect(await readFile(path.join(home,'race-ready'),'utf8')).toBe('ready');
  },30_000);
});
