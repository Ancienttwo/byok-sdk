import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { startPreparedOperation } from './fixtures/prepared-operation';
import { createAutoToolAuthorizationGate, type ToolAuthorizationGate, type ToolAuthorizationRules, type ToolAuthorizationVerdict, type ToolCall } from '../tool-authorization';
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
  // A pi-subagents session start runs `npm root -g`; its child can outlive the host briefly.
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

async function fixture(delegated = false, childAgent = 'hook-child', background = false, command?: string) {
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
    // An external CLI runner executes outside Pi's tool pipeline; the command does not exist.
    await fs.writeFile(path.join(agentDir, 'agents', 'external-child.md'), '---\nname: external-child\ndescription: External CLI child the auto gate cannot see\nrunner:\n  type: external-cli\n  adapter: codex-exec\n  command: byok-absent-external-cli\n  promptDelivery: stdin\n---\nComplete the delegated file operation.');
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
      // An external CLI runner takes no model override and runs only in the background.
      ? { name: 'subagent', arguments: JSON.stringify(childAgent === 'hook-child'
        ? { agent: childAgent, task: 'Write the target file', model: 'hook-loopback/probe', async: background, context: 'fresh', output: false, artifacts: false, timeoutMs: 20000 }
        : { agent: childAgent, task: 'Write the target file' }) }
      : childFirst || (!delegated && turn % 2 === 1)
        ? command === undefined
          ? { name: 'write', arguments: JSON.stringify({ path: target, content: 'actual file content' }) }
          : { name: 'bash', arguments: JSON.stringify({ command }) }
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

const execFileAsync = promisify(execFile);
async function localPushFixture(root: string, workspace: string, env: NodeJS.ProcessEnv) {
  const remote = path.join(root, 'origin.git');
  const options = { cwd: workspace, env: { ...env, GIT_CONFIG_NOSYSTEM: '1' } };
  await execFileAsync('git', ['init', '--bare', remote], options);
  await execFileAsync('git', ['init', '-b', 'main'], options);
  await fs.writeFile(path.join(workspace, 'tracked.txt'), 'local push fixture');
  await execFileAsync('git', ['add', 'tracked.txt'], options);
  await execFileAsync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], options);
  await execFileAsync('git', ['remote', 'add', 'origin', remote], options);
  const target = path.join(workspace, 'chain-target');
  await fs.mkdir(target);
  const marker = path.join(target, 'keep.txt');
  await fs.writeFile(marker, 'must survive the denied shell chain');
  return { target, marker, pushedRef: path.join(remote, 'refs', 'heads', 'main') };
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
function gate(
  workspace: string,
  decide: (summary: string) => { approved: boolean; reason?: string } = () => ({ approved: false, reason: 'owner authorization required' }),
  options: { rules?: ToolAuthorizationRules; home?: string } = {},
) {
  const calls: ToolCall[] = [];
  const summaries: string[] = [];
  const verdicts: ToolAuthorizationVerdict[] = [];
  const inner = createAutoToolAuthorizationGate({ workspace, timeoutMs: 5_000, ...options, requestAuthorization: async summary => { summaries.push(summary); return decide(summary); } });
  const toolAuthorization: ToolAuthorizationGate = { timeoutMs: inner.timeoutMs, authorize: async call => {
    calls.push(call);
    const verdict = await inner.authorize(call);
    verdicts.push(verdict);
    return verdict;
  } };
  return { toolAuthorization, calls, summaries, verdicts };
}


describe('Pi auto gate through the real Pi tool pipeline (zero-cost loopback provider)', () => {
  it('F1: does not let a push allow rule execute a chained real shell deletion', async () => {
    const command = 'git push origin main && rm -rf chain-target';
    const f = await fixture(false, 'hook-child', false, command);
    const local = await localPushFixture(f.root, f.cwd, f.env);
    const g = gate(f.cwd, undefined, { home: f.root, rules: { allowWithoutAsking: [
      { id: 'allow-push', match: { toolName: 'bash', commandGlob: 'git push origin *' } },
    ] } });
    const session = await startPreparedOperation(adapter(), { instruction: 'Run the requested shell command, then finish.' }, {
      workspaceDir: f.cwd, agentHome: f.cwd, env: f.env, toolAuthorization: g.toolAuthorization,
    });
    sessions.push(session);
    await finish(session);
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]).toMatchObject({ toolName: 'bash', input: { command } });
    expect(await fs.readFile(local.marker, 'utf8')).toBe('must survive the denied shell chain');
    expect((await fs.stat(local.target)).isDirectory()).toBe(true);
    await expect(fs.stat(local.pushedRef)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(g.summaries).toHaveLength(1);
    expect(g.summaries[0]).toContain('recursive-delete');
    expect(g.summaries[0]).toContain('destructive-git');
    expect(g.verdicts).toEqual([{ decision: 'deny', code: 'tool_authorization_denied', reason: 'owner authorization required',
      authorization: { source: 'built-in', ruleIds: [] } }]);
    expect(JSON.stringify(f.requests)).toContain('tool_authorization_denied: owner authorization required');
  }, 30_000);

  it.each(['ask', 'allow', 'floor'] as const)('custom rules %s: enforce the decision before the real write', async mode => {
    const f = await fixture();
    f.target = mode === 'ask' ? path.join(f.cwd, 'notes.md')
      : mode === 'floor' ? path.join(f.root, '.ssh', 'fixture-key') : f.target;
    if (mode === 'floor') await fs.mkdir(path.dirname(f.target));
    const rule = { id: `owner-${mode}`, description: 'Host display text only', match: { toolName: 'write', pathGlob: f.target } };
    const g = gate(f.cwd, undefined, { home: f.root, rules: mode === 'ask'
      ? { alwaysAsk: [rule] } : { allowWithoutAsking: [rule] } });
    const session = await startPreparedOperation(adapter(), { instruction: 'write the file' }, {
      workspaceDir: f.cwd, agentHome: f.cwd, env: f.env, toolAuthorization: g.toolAuthorization,
    });
    sessions.push(session);
    await finish(session);
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]).toMatchObject({ toolName: 'write', input: { path: f.target } });
    if (mode === 'allow') {
      expect(await fs.readFile(f.target, 'utf8')).toBe('actual file content');
      expect(g.summaries).toEqual([]);
      expect(g.verdicts).toEqual([{ decision: 'allow', authorization: { source: 'rule', ruleIds: ['owner-allow'] } }]);
    } else {
      await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(g.summaries).toHaveLength(1);
      expect(JSON.stringify(f.requests)).toContain('tool_authorization_denied: owner authorization required');
      expect(g.verdicts).toEqual([{ decision: 'deny', code: 'tool_authorization_denied', reason: 'owner authorization required',
        authorization: { source: mode === 'floor' ? 'floor' : 'rule', ruleIds: mode === 'floor' ? [] : ['owner-ask'] } }]);
      if (mode === 'floor') {
        expect(g.summaries[0]).toContain('sensitive-path');
        expect(g.summaries[0]).toMatch(/^Protected-path tool call/);
      }
    }
  }, 30_000);

  it('applies a newly selected Always Ask rule when a previously allowed native session resumes', async () => {
    const f = await fixture();
    const runtime = adapter();
    const allowed = gate(f.cwd, undefined, { rules: { allowWithoutAsking: [
      { id: 'allow-first-write', match: { toolName: 'write', pathGlob: f.target } },
    ] } });
    const first = await startPreparedOperation(runtime, { instruction: 'write the file' }, {
      workspaceDir: f.cwd, agentHome: f.cwd, env: f.env, toolAuthorization: allowed.toolAuthorization,
    });
    sessions.push(first);
    await finish(first);
    expect(await fs.readFile(f.target, 'utf8')).toBe('actual file content');
    expect(allowed.summaries).toEqual([]);
    const sessionRef = first.sessionRef;
    await first.close();
    await fs.rm(f.target);

    const ask = gate(f.cwd, undefined, { rules: { alwaysAsk: [
      { id: 'ask-resumed-write', match: { toolName: 'write', pathGlob: f.target } },
    ] } });
    const resumed = await startPreparedOperation(runtime, { instruction: 'write the file again', sessionRef }, {
      workspaceDir: f.cwd, agentHome: f.cwd, env: f.env, toolAuthorization: ask.toolAuthorization,
    });
    sessions.push(resumed);
    await finish(resumed);
    expect(resumed.sessionRef).toBe(sessionRef);
    await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(ask.summaries).toHaveLength(1);
    expect(ask.verdicts).toEqual([{ decision: 'deny', code: 'tool_authorization_denied', reason: 'owner authorization required',
      authorization: { source: 'rule', ruleIds: ['ask-resumed-write'] } }]);
    expect(allowed.calls).toHaveLength(1);
    expect(JSON.stringify(f.requests)).toContain('tool_authorization_denied: owner authorization required');
  }, 60_000);

  it('denies a high-risk write before execution, gates resume, and runs it once the user approves', async () => {
    const f = await fixture();
    let approved = false;
    const g = gate(f.cwd, () => approved ? { approved } : { approved, reason: 'owner authorization required' });
    const snapshotPath = path.join(f.root, 'gate-env.json');
    await fs.mkdir(path.join(f.agentDir, 'extensions'));
    await fs.writeFile(path.join(f.agentDir, 'extensions', 'capture-env.js'),
      `import { writeFileSync } from 'node:fs'; export default () => { writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify(process.env)); };`);
    const runtime = adapter();
    const first = await startPreparedOperation(runtime, { instruction: 'write the file' }, { workspaceDir: f.cwd, agentHome: f.cwd, env: f.env, toolAuthorization: g.toolAuthorization });
    sessions.push(first);
    await finish(first);
    await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(f.requests)).toContain('tool_authorization_denied: owner authorization required');
    expect(g.calls[0]).toMatchObject({ toolName: 'write', cwd: f.cwd, input: { path: f.target } });
    expect(g.summaries[0]).toContain('write-outside-workspace');
    const childEnv = JSON.parse(await fs.readFile(snapshotPath, 'utf8')) as Record<string, string>;
    const gatePath = childEnv[TOOL_AUTHORIZATION_GATE_ENV]!;
    expect(path.isAbsolute(gatePath)).toBe(true);
    const config = JSON.parse(await fs.readFile(gatePath, 'utf8'));
    expect(JSON.stringify(childEnv)).not.toContain(config.token);
    if (process.platform !== 'win32') {
      expect((await fs.stat(gatePath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(gatePath))).mode & 0o777).toBe(0o700);
    }
    vi.stubEnv(TOOL_AUTHORIZATION_GATE_ENV, gatePath);
    expect(readToolAuthorizationGateEnv()).toEqual(config);
    const sessionRef = first.sessionRef;
    await first.close();
    await expect(fs.stat(gatePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(readToolAuthorizationGateEnv).toThrow();
    expect(await requestToolAuthorization(config, g.calls[0]!)).toMatchObject({ decision: 'deny', code: 'tool_authorization_unavailable' });
    vi.unstubAllEnvs();
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

  it('carries the parent gate into a background child in the pi-subagents runner process', async () => {
    const f = await fixture(true, 'hook-child', true);
    const g = gate(f.cwd);
    const session = await startPreparedOperation(adapter(), { instruction: 'Delegate the file operation to hook-child in the background' }, { workspaceDir: f.cwd, agentHome: f.cwd, env: f.env, toolAuthorization: g.toolAuthorization });
    sessions.push(session);
    await finish(session);
    // The background runner outlives the parent turn; wait for its gated write.
    const deadline = Date.now() + 30_000;
    while (!g.calls.some(call => call.toolName === 'write') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    const childCall = g.calls.find(call => call.toolName === 'write');
    expect(childCall).toMatchObject({ input: { path: f.target } });
    expect(childCall?.nativeAgentId).toMatch(/^pi-subagent:/);
    await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it('rejects malformed gate files and the replaced inline environment format', async () => {
    const f = await fixture();
    const gatePath = path.join(f.root, 'malformed-gate.json');
    await fs.writeFile(gatePath, '{}');
    vi.stubEnv(TOOL_AUTHORIZATION_GATE_ENV, gatePath);
    expect(readToolAuthorizationGateEnv).toThrow('invalid tool authorization gate config');
    vi.stubEnv(TOOL_AUTHORIZATION_GATE_ENV, JSON.stringify({ url: 'http://127.0.0.1:1/authorize-tool', token: 'a'.repeat(64), timeoutMs: 1000 }));
    expect(readToolAuthorizationGateEnv).toThrow();
  });

  it('refuses an external CLI subagent runner before it starts while the parent gate is present', async () => {
    const f = await fixture(true, 'external-child');
    const g = gate(f.cwd);
    const session = await startPreparedOperation(adapter(), { instruction: 'Delegate the file operation to external-child' }, { workspaceDir: f.cwd, agentHome: f.cwd, env: f.env, toolAuthorization: g.toolAuthorization });
    sessions.push(session);
    await finish(session);
    expect(g.calls.some(call => call.toolName === 'subagent')).toBe(true);
    // pi-subagents refuses the launch from the SDK's required-for-all-runners registration.
    expect(JSON.stringify(f.requests)).toMatch(/cannot run on runner\.type='external-cli': the host requires child extensions \(byok-tool-authorization\)/);
    expect(g.calls.some(call => call.toolName === 'write')).toBe(false);
  }, 45_000);

  it('declares no auto support on the durable lane', () => {
    expect(new PiAdapter({ durablePi: true }).descriptor.capabilities.toolAuthorizationAuto).toBe(false);
  });
});
