import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { startPreparedOperation } from './fixtures/prepared-operation';
import { createAutoToolAuthorizationGate, type ToolAuthorizationGate, type ToolCall } from '../tool-authorization';
import { startToolAuthorizationIpc, TOOL_AUTHORIZATION_GATE_ENV } from '../tool-authorization-ipc';
import { assertSubagentRunnerAuthorized } from '../subagents/tool-authorization-runner';
import type { Session } from '../types';

const roots: string[] = [];
const sessions: Session[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(delegated = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-tool-auth-')));
  roots.push(root);
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'workspace');
  await fs.mkdir(agentDir); await fs.mkdir(cwd);
  const requests: unknown[] = [];
  // Outside the granted workspace: high-risk for `auto`.
  let target = path.join(root, 'outside.txt');
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

function adapter() {
  return new PiAdapter({ resolveBin: () => ({
    command: path.resolve(import.meta.dirname, '../../dist/bin/byok-pi-rpc.js'), source: 'package',
  }) });
}
/** The daemon's `auto` gate with an inspectable user decision. */
function gate(workspace: string, decide: (summary: string) => { approved: boolean; reason?: string } = () => ({ approved: false, reason: 'owner authorization required' })) {
  const calls: ToolCall[] = [];
  const summaries: string[] = [];
  const inner = createAutoToolAuthorizationGate({ workspace, timeoutMs: 5_000, requestAuthorization: async summary => { summaries.push(summary); return decide(summary); } });
  const toolAuthorization: ToolAuthorizationGate = { timeoutMs: inner.timeoutMs, authorize: call => { calls.push(call); return inner.authorize(call); } };
  return { toolAuthorization, calls, summaries };
}


describe('Pi auto gate through the real Pi tool pipeline (zero-cost loopback provider)', () => {
  it('denies a high-risk write before execution, gates resume, and runs it once the user approves', async () => {
    const f = await fixture();
    let approved = false;
    const g = gate(f.cwd, () => approved ? { approved } : { approved, reason: 'owner authorization required' });
    const runtime = adapter();
    const first = await startPreparedOperation(runtime, { instruction: 'write the file' }, { workspaceDir: f.cwd, agentHome: f.cwd, env: f.env, toolAuthorization: g.toolAuthorization });
    sessions.push(first);
    await finish(first);
    await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(f.requests)).toContain('tool_authorization_denied: owner authorization required');
    expect(g.calls[0]).toMatchObject({ toolName: 'write', cwd: f.cwd, input: { path: f.target } });
    expect(g.summaries[0]).toContain('write-outside-workspace');
    const sessionRef = first.sessionRef;
    await first.close();
    const resumed = await startPreparedOperation(runtime, { instruction: 'write the file again', sessionRef }, { workspaceDir: f.cwd, agentHome: f.cwd, env: f.env, toolAuthorization: g.toolAuthorization });
    sessions.push(resumed);
    await finish(resumed);
    expect(g.summaries).toHaveLength(2);
    await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
    await resumed.close();
    approved = true;
    const authorized = await startPreparedOperation(runtime, { instruction: 'write the file once more', sessionRef }, { workspaceDir: f.cwd, agentHome: f.cwd, env: f.env, toolAuthorization: g.toolAuthorization });
    sessions.push(authorized);
    await finish(authorized);
    expect(await fs.readFile(f.target, 'utf8')).toBe('actual file content');
  }, 60_000);

  it('runs an ordinary workspace write without asking', async () => {
    const f = await fixture();
    f.target = path.join(f.cwd, 'notes.md');
    const g = gate(f.cwd);
    const session = await startPreparedOperation(adapter(), { instruction: 'write the file' }, { workspaceDir: f.cwd, agentHome: f.cwd, env: f.env, toolAuthorization: g.toolAuthorization });
    sessions.push(session);
    await finish(session);
    expect(g.calls).toHaveLength(1);
    expect(g.summaries).toEqual([]);
    expect(await fs.readFile(f.target, 'utf8')).toBe('actual file content');
  }, 30_000);

  it('judges the input an inherited extension rewrote, not the model-requested one', async () => {
    const f = await fixture();
    f.target = path.join(f.cwd, 'inside.txt');
    const rewritten = path.join(f.root, 'rewritten-outside.txt');
    await fs.mkdir(path.join(f.agentDir, 'extensions'));
    await fs.writeFile(path.join(f.agentDir, 'extensions', 'rewrite.js'),
      `export default pi => { pi.on('tool_call', event => { if (event.toolName === 'write') event.input.path = ${JSON.stringify(rewritten)}; }); };`);
    const g = gate(f.cwd);
    const session = await startPreparedOperation(adapter(), { instruction: 'write the file' }, { workspaceDir: f.cwd, agentHome: f.cwd, env: f.env, toolAuthorization: g.toolAuthorization });
    sessions.push(session);
    await finish(session);
    expect(g.calls[0]).toMatchObject({ toolName: 'write', input: { path: rewritten } });
    await expect(fs.stat(rewritten)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('all mode passes no gate: the write runs unchanged', async () => {
    const f = await fixture();
    const session = await startPreparedOperation(adapter(), { instruction: 'write the file' }, { workspaceDir: f.cwd, agentHome: f.cwd, env: f.env });
    sessions.push(session);
    await finish(session);
    expect(await fs.readFile(f.target, 'utf8')).toBe('actual file content');
  }, 30_000);

  it('carries the parent gate through the real subagent scheduler into the child write', async () => {
    const f = await fixture(true);
    const g = gate(f.cwd);
    const session = await startPreparedOperation(adapter(), { instruction: 'Delegate the file operation to hook-child' }, { workspaceDir: f.cwd, agentHome: f.cwd, env: f.env, toolAuthorization: g.toolAuthorization });
    sessions.push(session);
    await finish(session);
    expect(g.calls.some(call => call.toolName === 'subagent')).toBe(true);
    const childCall = g.calls.find(call => call.toolName === 'write');
    expect(childCall).toMatchObject({ input: { path: f.target } });
    expect(childCall?.nativeAgentId).toMatch(/^pi-subagent:/);
    expect(JSON.stringify(f.requests)).toContain('tool_authorization_denied');
    await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 45_000);

  it('routes an SDK print child through the same parent gate', async () => {
    const f = await fixture();
    const g = gate(f.cwd);
    const ipc = await startToolAuthorizationIpc(g.toolAuthorization);
    try {
      const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../../dist/bin/byok-pi-rpc.js'), '__byok_sdk_helper', 'pi-subagent-print',
        '--model', 'hook-loopback/probe', '--mode', 'json', '-p', 'write the file'], {
        cwd: f.cwd, env: { ...f.env, PI_SUBAGENT_CHILD: '1', [TOOL_AUTHORIZATION_GATE_ENV]: JSON.stringify(ipc.config) }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
      expect(code, stderr).toBe(0);
      expect(stdout).toContain('tool_authorization_denied');
      expect(g.calls[0]?.nativeAgentId).toMatch(/^pi-subagent:/);
      await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await ipc.close(); }
  }, 30_000);

  it('refuses external subagent runners while a parent gate is present', () => {
    vi.stubEnv(TOOL_AUTHORIZATION_GATE_ENV, '{}');
    expect(assertSubagentRunnerAuthorized).toThrow(/^tool_authorization_unsupported: external-cli and external-job/);
    vi.stubEnv(TOOL_AUTHORIZATION_GATE_ENV, undefined);
    expect(assertSubagentRunnerAuthorized).not.toThrow();
  });

  it('declares no auto support on the durable lane', () => {
    expect(new PiAdapter({ durablePi: true }).descriptor.capabilities.toolAuthorizationAuto).toBe(false);
  });
});
