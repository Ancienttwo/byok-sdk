import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiAdapter, type PiAdapterOptions } from '../adapters/pi/pi-adapter';
import { startPreparedOperation } from './fixtures/prepared-operation';
import type { BeforeToolRequest } from '../tool-execution-hook';
import { startToolExecutionGate } from '../tool-execution-hook';
import { PI_TOOL_EXECUTION_GATE_ENV } from '../adapters/pi/tool-execution-hook';
import { sealRuntimeOperationManifest, type Session } from '../types';

const roots: string[] = [];
const sessions: Session[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(delegated = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-tool-hook-')));
  roots.push(root);
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'workspace');
  await fs.mkdir(agentDir); await fs.mkdir(cwd);
  const requests: unknown[] = [];
  let target = path.join(cwd, 'target.txt');
  let count = 0;
  let parentRequests = 0;
  let childRequests = 0;
  if (delegated) {
    await fs.mkdir(path.join(agentDir, 'agents'));
    await fs.writeFile(path.join(agentDir, 'agents', 'hook-child.md'), '---\nname: hook-child\ndescription: Loopback child for execution-hook propagation\nmodel: hook-loopback/probe\ntools: write\n---\nComplete the delegated file operation.');
  }
  const server = createServer(async (request, response) => {
    let bytes = '';
    for await (const chunk of request) bytes += chunk;
    const body = JSON.parse(bytes) as { tools?: { function?: { name?: string } }[] };
    requests.push(body);
    const turn = ++count;
    const parent = body.tools?.some(tool => tool.function?.name === 'subagent') === true;
    const rootFirst = delegated && parent && ++parentRequests === 1;
    const childFirst = delegated && !parent && ++childRequests === 1;
    const tool = rootFirst
      ? { name: 'subagent', arguments: JSON.stringify({ agent: 'hook-child', task: 'Write the target file', model: 'hook-loopback/probe', async: false, context: 'fresh', output: false, artifacts: false, timeoutMs: 20000 }) }
      : childFirst || (!delegated && turn % 2 === 1)
        ? { name: 'write', arguments: JSON.stringify({ path: target, content: 'actual file content' }) }
        : undefined;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = tool !== undefined
      ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${turn}`, type: 'function', function: tool }] }
      : { role: 'assistant', content: 'finished' };
    response.end(`data: ${JSON.stringify({ id: `response-${turn}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: `response-${turn}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: tool === undefined ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no provider address');
  await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'hook-loopback': {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'synthetic-not-a-secret',
    models: [{ id: 'probe', name: 'probe', contextWindow: 8192, maxTokens: 64, input: ['text'], reasoning: false }],
  } } }));
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'hook-loopback', defaultModel: 'probe' }));
  return { root, cwd, agentDir, requests, get target() { return target; }, set target(value: string) { target = value; },
    env: { HOME: root, PATH: process.env.PATH!, PI_CODING_AGENT_DIR: agentDir },
  };
}

async function finish(session: Session): Promise<void> {
  for await (const event of session.events) if (event.type === 'turn_end') return;
  throw new Error('Pi ended without turn_end');
}

function adapter(beforeTool?: PiAdapterOptions['beforeTool']) {
  return new PiAdapter({ ...(beforeTool === undefined ? {} : { beforeTool }), resolveBin: () => ({
    command: path.resolve(import.meta.dirname, '../../dist/bin/byok-pi-rpc.js'), source: 'package',
  }) });
}

describe('Pi local beforeTool execution boundary (#1061)', () => {
  it('evaluates the actual path after an inherited extension rewrites the tool input', async () => {
    const f = await fixture();
    const rewritten = path.join(f.cwd, 'rewritten.txt');
    await fs.mkdir(path.join(f.agentDir, 'extensions'));
    await fs.writeFile(path.join(f.agentDir, 'extensions', 'rewrite.js'),
      `export default pi => { pi.on('tool_call', event => { if (event.toolName === 'write') event.input.path = ${JSON.stringify(rewritten)}; }); };`);
    const observed: BeforeToolRequest[] = [];
    const runtime = adapter({ onRequest: request => {
      observed.push(request);
      return request.paths.includes(rewritten)
        ? { decision: 'deny', reason: 'rewritten path is not authorized' }
        : { decision: 'allow' };
    } });
    const session = await startPreparedOperation(runtime, { instruction: 'write the file' }, { workspaceDir: f.cwd, agentHome: f.cwd, env: f.env });
    sessions.push(session);
    await finish(session);
    expect(observed[0]).toMatchObject({ toolName: 'write', paths: [rewritten], input: { path: rewritten } });
    expect(JSON.stringify(f.requests)).toContain('rewritten path is not authorized');
    await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(rewritten)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('denies an actual write, preserves task identity, gates resume, and still permits an authorized write', async () => {
    const f = await fixture();
    const observed: BeforeToolRequest[] = [];
    let allow = false;
    const runtime = adapter({ onRequest: request => { observed.push(request); return allow ? { decision: 'allow' } : { decision: 'deny', reason: 'owner authorization required' }; } });
    const first = await startPreparedOperation(runtime, { instruction: 'write the file' }, { workspaceDir: f.cwd, agentHome: f.cwd, env: f.env });
    sessions.push(first);
    await finish(first);
    await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(f.requests)).toContain('tool_policy_denied');
    expect(JSON.stringify(f.requests)).toContain('owner authorization required');
    expect(observed[0]).toMatchObject({ taskId: 'adapter-unit-test', agentRef: { agentId: 'adapter-unit-agent', profileRevision: 'r1' }, toolName: 'write', cwd: f.cwd, paths: [f.target] });
    const sessionRef = first.sessionRef;
    await first.close();
    const resumed = await startPreparedOperation(runtime, { instruction: 'write the file again', sessionRef }, { workspaceDir: f.cwd, agentHome: f.cwd, env: f.env });
    sessions.push(resumed);
    await finish(resumed);
    expect(observed).toHaveLength(2);
    await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
    await resumed.close();
    allow = true;
    f.target = path.join(f.cwd, 'allowed.txt');
    const authorized = await startPreparedOperation(runtime, { instruction: 'write the authorized file', sessionRef }, { workspaceDir: f.cwd, agentHome: f.cwd, env: f.env });
    sessions.push(authorized);
    await finish(authorized);
    expect(await fs.readFile(f.target, 'utf8')).toBe('actual file content');
  }, 60_000);

  it('refuses unsupported durable operation before constructing a runtime', () => {
    expect(() => new PiAdapter({ durablePi: true, beforeTool: { onRequest: () => ({ decision: 'allow' }) } })).toThrow('beforeTool is unavailable for the durable Pi lane');
  });

  it('preserves actual write execution with the hook disabled', async () => {
    const f = await fixture();
    const session = await startPreparedOperation(adapter(), { instruction: 'write the file' }, { workspaceDir: f.cwd, agentHome: f.cwd, env: f.env });
    sessions.push(session);
    await finish(session);
    expect(await fs.readFile(f.target, 'utf8')).toBe('actual file content');
  }, 30_000);

  it.each(['throw', 'timeout'] as const)('blocks the actual write when the callback fails with %s', async failure => {
    const f = await fixture();
    const runtime = adapter({ timeoutMs: 25, onRequest: () => {
      if (failure === 'throw') throw new Error('callback failed');
      return new Promise<never>(() => {});
    } });
    const session = await startPreparedOperation(runtime, { instruction: 'write the file' }, { workspaceDir: f.cwd, agentHome: f.cwd, env: f.env });
    sessions.push(session);
    await finish(session);
    await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(f.requests)).toContain(failure === 'throw' ? 'tool_policy_error' : 'tool_policy_timeout');
  }, 30_000);

  it('carries the parent gate through the real subagent scheduler into the child write', async () => {
    const f = await fixture(true);
    const observed: BeforeToolRequest[] = [];
    const runtime = adapter({ onRequest: request => {
      observed.push(request);
      return request.toolName === 'write' ? { decision: 'deny', reason: 'scheduled child write denied' } : { decision: 'allow' };
    } });
    const session = await startPreparedOperation(runtime, { instruction: 'Delegate the file operation to hook-child' }, { workspaceDir: f.cwd, agentHome: f.cwd, env: f.env });
    sessions.push(session);
    await finish(session);
    expect(observed.find(request => request.toolName === 'subagent')).toMatchObject({
      taskId: 'adapter-unit-test', agentRef: { agentId: 'adapter-unit-agent', profileRevision: 'r1' },
    });
    const childCall = observed.find(request => request.toolName === 'write');
    expect(childCall).toMatchObject({ taskId: 'adapter-unit-test', agentRef: { agentId: 'adapter-unit-agent', profileRevision: 'r1' }, paths: [f.target] });
    expect(childCall?.nativeAgentId).toMatch(/^pi-subagent:/);
    expect(JSON.stringify(f.requests)).toContain('scheduled child write denied');
    await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 45_000);

  it('routes an SDK print child through the same parent gate and rejects the actual child write', async () => {
    const f = await fixture();
    const observed: BeforeToolRequest[] = [];
    const runtime = adapter();
    const manifest = sealRuntimeOperationManifest({ taskId: 'parent-task', runtimeId: 'pi', descriptor: runtime.descriptor, requiredToolsetIds: [],
      cwd: f.cwd, agentRef: { agentId: 'parent-agent', profileRevision: 'r1' }, lease: { leaseId: 'parent-lease', canonicalHome: f.cwd },
      workspace: { workspaceDir: f.cwd }, forwardedEnvironmentNames: [],
    });
    const gate = await startToolExecutionGate({ options: { onRequest: request => { observed.push(request); return { decision: 'deny', reason: 'child write denied' }; } }, manifest, runtimeId: 'pi' });
    try {
      const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../../dist/bin/byok-pi-rpc.js'), '__byok_sdk_helper', 'pi-subagent-print',
        '--model', 'hook-loopback/probe', '--mode', 'json', '-p', 'write the file'], {
        cwd: f.cwd, env: { ...f.env, PI_SUBAGENT_CHILD: '1', [PI_TOOL_EXECUTION_GATE_ENV]: JSON.stringify(gate.config) }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
      expect(code, stderr).toBe(0);
      expect(stdout).toContain('child write denied');
      expect(observed[0]).toMatchObject({ taskId: 'parent-task', agentRef: { agentId: 'parent-agent', profileRevision: 'r1' }, toolName: 'write', paths: [f.target] });
      expect(observed[0]?.nativeAgentId).toMatch(/^pi-subagent:/);
      await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await gate.close(); }
  }, 30_000);
});
