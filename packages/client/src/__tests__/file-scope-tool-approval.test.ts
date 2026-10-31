import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { startPreparedOperation } from './fixtures/prepared-operation';
import { observationOf } from './fixtures/mcp-observation';
import {
  classifyToolCall, createAutoToolAuthorizationGate,
  type ToolAuthorizationGate, type ToolAuthorizationRules, type ToolCall,
} from '../tool-authorization';
import { bindFileScopeGate } from '../file-scope-gate-binding';
import { resolveFileScopeGrant, type FileScopeGrant, type FileScopeIdentity } from '../file-scope-guard';
import type { Session } from '../types';

const roots: string[] = [];
const sessions: Session[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

async function identityOf(filePath: string): Promise<FileScopeIdentity> {
  const value = await fs.stat(filePath, { bigint: true });
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

async function homeGrant(home: string): Promise<FileScopeGrant> {
  return resolveFileScopeGrant({ fileScope: { mode: 'home' }, home: { path: home, identity: await identityOf(home) } });
}

interface GateHarness {
  readonly toolAuthorization: ToolAuthorizationGate;
  readonly summaries: string[];
  readonly decisions: GateDecision[];
  readonly denials: string[];
}

type GateDecision = Parameters<NonNullable<Parameters<typeof createAutoToolAuthorizationGate>[0]['onDecision']>>[0];

function scopedGate(options: {
  readonly workspace: string;
  readonly grant?: FileScopeGrant;
  readonly rules?: ToolAuthorizationRules;
  readonly decide?: (summary: string) => { approved: boolean; reason?: string };
  readonly mcpIdentities?: ReadonlyMap<string, { readonly server: string; readonly tool: string }>;
}): GateHarness {
  const summaries: string[] = [];
  const decisions: GateDecision[] = [];
  const denials: string[] = [];
  const inner = createAutoToolAuthorizationGate({
    workspace: options.workspace,
    ...(options.rules === undefined ? {} : { rules: options.rules }),
    ...(options.mcpIdentities === undefined ? {} : { mcpIdentities: options.mcpIdentities }),
    timeoutMs: 5_000,
    onDecision: (decision) => { decisions.push(decision); },
    requestAuthorization: async (summary) => {
      summaries.push(summary);
      return options.decide === undefined
        ? { approved: false, reason: 'owner authorization required' }
        : options.decide(summary);
    },
  });
  if (options.grant !== undefined) {
    bindFileScopeGate(inner, {
      grant: options.grant, taskId: 'scope-approval', lane: 'rpc', homeAccess: 'writer',
      onDeny: (denial) => { denials.push(denial.toolName + ':' + denial.reason); },
    });
  }
  return { toolAuthorization: inner, summaries, decisions, denials };
}

const call = (toolName: string, input: Record<string, unknown>, cwd: string): ToolCall =>
  ({ toolCallId: 'call-' + toolName, toolName, input, cwd });

describe('scoped-session per-call approval floor (#1061 slice 4)', () => {
  it('asks for ordinary bash even though the risk heuristic calls it normal', async () => {
    const home = await tmpDir('byok-floor-home-');
    const outside = await tmpDir('byok-floor-outside-');
    const outsideFile = path.join(outside, 'secret.txt');
    await fs.writeFile(outsideFile, 'secret');
    const g = scopedGate({ workspace: home, grant: await homeGrant(home) });
    const command = 'cat ' + outsideFile;
    // The classifier alone would let this through; the scoped floor is what asks.
    expect(classifyToolCall(call('bash', { command }, home), home)).toMatchObject({ level: 'normal' });
    await expect(g.toolAuthorization.authorize(call('bash', { command }, home))).resolves.toMatchObject({
      decision: 'deny', code: 'tool_authorization_denied', reason: 'owner authorization required',
    });
    expect(g.summaries).toHaveLength(1);
    expect(g.summaries[0]).toContain('Tool call outside the file scope (outside-file-scope): bash');
    expect(g.summaries[0]).toContain(command);
    await expect(g.toolAuthorization.authorize(call('bash', { command: 'ls ' + outside }, home)))
      .resolves.toMatchObject({ decision: 'deny' });
    expect(g.summaries).toHaveLength(2);
    expect(g.summaries[1]).toContain('ls ' + outside);
  });

  it('asks for an MCP tool and shows its trusted server/tool identity', async () => {
    const home = await tmpDir('byok-floor-home-');
    const g = scopedGate({
      workspace: home, grant: await homeGrant(home),
      mcpIdentities: new Map([['mcp__sales__echo', { server: 'sales', tool: 'echo' }]]),
    });
    await expect(g.toolAuthorization.authorize(call('mcp__sales__echo', {}, home))).resolves.toMatchObject({
      decision: 'deny', code: 'tool_authorization_denied',
    });
    expect(g.summaries).toEqual([expect.stringContaining('mcp__sales__echo [mcp sales/echo]')]);
    expect(g.summaries[0]).toContain('outside-file-scope');
  });

  it('asks for a user-extension tool and for the SDK web/todo style tools outside the boundary', async () => {
    const home = await tmpDir('byok-floor-home-');
    const g = scopedGate({ workspace: home, grant: await homeGrant(home) });
    await expect(g.toolAuthorization.authorize(call('probe_tool', {}, home))).resolves.toMatchObject({ decision: 'deny' });
    await expect(g.toolAuthorization.authorize(call('web_fetch', { url: 'https://example.invalid' }, home)))
      .resolves.toMatchObject({ decision: 'deny' });
    expect(g.summaries).toHaveLength(2);
    expect(g.summaries[0]).toContain('probe_tool');
    expect(g.summaries[1]).toContain('web_fetch');
  });

  it('keeps the six SDK file tools inside the boundary and does not ask for them', async () => {
    const home = await tmpDir('byok-floor-home-');
    const g = scopedGate({ workspace: home, grant: await homeGrant(home) });
    for (const toolName of ['read', 'write', 'edit']) {
      await expect(g.toolAuthorization.authorize(call(toolName, { path: path.join(home, 'notes.txt') }, home)))
        .resolves.toMatchObject({ decision: 'allow' });
    }
    for (const toolName of ['find', 'grep', 'ls']) {
      await expect(g.toolAuthorization.authorize(call(toolName, toolName === 'ls' ? {} : { pattern: '*', path: home }, home)))
        .resolves.toMatchObject({ decision: 'allow' });
    }
    expect(g.summaries).toEqual([]);
  });

  it('executes an explicitly allowed tool/command and never asks for it', async () => {
    const home = await tmpDir('byok-floor-home-');
    const rules: ToolAuthorizationRules = {
      allowWithoutAsking: [{ id: 'allow-cat', match: { toolName: 'bash', commandGlob: 'cat *' } }],
    };
    const g = scopedGate({ workspace: home, grant: await homeGrant(home), rules });
    await expect(g.toolAuthorization.authorize(call('bash', { command: 'cat ' + path.join(home, 'notes.txt') }, home)))
      .resolves.toEqual({ decision: 'allow', authorization: { source: 'rule', ruleIds: ['allow-cat'] } });
    expect(g.summaries).toEqual([]);
    // The same explicit opt-out works per extension tool name and per MCP identity.
    const perTool = scopedGate({ workspace: home, grant: await homeGrant(home), rules: {
      allowWithoutAsking: [{ id: 'allow-probe', match: { toolName: 'probe_tool' } }],
    } });
    await expect(perTool.toolAuthorization.authorize(call('probe_tool', {}, home))).resolves.toMatchObject({ decision: 'allow' });
    const perMcp = scopedGate({
      workspace: home, grant: await homeGrant(home),
      mcpIdentities: new Map([['mcp__sales__echo', { server: 'sales', tool: 'echo' }]]),
      rules: { allowWithoutAsking: [{ id: 'allow-mcp', match: { mcpServer: 'sales', mcpTool: 'echo' } }] },
    });
    await expect(perMcp.toolAuthorization.authorize(call('mcp__sales__echo', {}, home))).resolves.toMatchObject({ decision: 'allow' });
    expect(perTool.summaries).toEqual([]);
    expect(perMcp.summaries).toEqual([]);
  });

  it('audits every scope-floor denial with a closed reason and denies by default', async () => {
    const home = await tmpDir('byok-floor-home-');
    const g = scopedGate({ workspace: home, grant: await homeGrant(home) });
    await expect(g.toolAuthorization.authorize(call('bash', { command: 'cat ' + path.join(home, 'notes.txt') }, home)))
      .resolves.toMatchObject({ decision: 'deny', code: 'tool_authorization_denied' });
    expect(g.decisions).toHaveLength(1);
    expect(g.decisions[0]).toMatchObject({
      call: { toolName: 'bash' },
      risk: { level: 'high', reasons: ['outside-file-scope'], authorization: { source: 'floor', ruleIds: [] } },
      verdict: { decision: 'deny', code: 'tool_authorization_denied' },
    });
    expect(g.denials).toEqual([]);
  });

  it('leaves an unscoped gate exactly as before', async () => {
    const home = await tmpDir('byok-floor-home-');
    const unscoped = scopedGate({ workspace: home });
    await expect(unscoped.toolAuthorization.authorize(call('bash', { command: 'cat /etc/hosts' }, home)))
      .resolves.toMatchObject({ decision: 'allow' });
    await expect(unscoped.toolAuthorization.authorize(call('probe_tool', {}, home))).resolves.toMatchObject({ decision: 'allow' });
    expect(unscoped.summaries).toEqual([]);
    expect(unscoped.decisions).toHaveLength(2);
    expect(unscoped.decisions.every(decision => decision.risk?.level === 'normal')).toBe(true);
  });
});

interface ScriptedTool { readonly name: string; readonly arguments: Record<string, unknown> }

/** A zero-cost loopback provider that emits one scripted tool call per request. */
async function scriptedProvider(script: readonly ScriptedTool[]) {
  const requests: unknown[] = [];
  let count = 0;
  const server = createServer(async (request, response) => {
    let bytes = '';
    for await (const chunk of request) bytes += chunk;
    requests.push(JSON.parse(bytes));
    const turn = ++count;
    const next = script[turn - 1];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = next === undefined
      ? { role: 'assistant', content: 'finished' }
      : { role: 'assistant', tool_calls: [{
        index: 0, id: 'call-' + turn, type: 'function',
        function: { name: next.name, arguments: JSON.stringify(next.arguments) },
      }] };
    response.end(
      'data: ' + JSON.stringify({ id: 'response-' + turn, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] }) +
      '\n\n' + 'data: ' + JSON.stringify({ id: 'response-' + turn, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: next === undefined ? 'stop' : 'tool_calls' }] }) +
      '\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return { requests, address: server.address() as { port: number } };
}

async function realPiFixture(script: readonly ScriptedTool[]) {
  const root = await tmpDir('byok-scope-approval-');
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'workspace');
  await fs.mkdir(agentDir);
  await fs.mkdir(cwd);
  const provider = await scriptedProvider(script);
  await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'scope-loopback': {
    baseUrl: 'http://127.0.0.1:' + provider.address.port + '/v1', api: 'openai-completions', apiKey: 'synthetic-not-a-secret',
    models: [{ id: 'probe', name: 'probe', contextWindow: 8192, maxTokens: 64, input: ['text'], reasoning: false }],
  } } }));
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'scope-loopback', defaultModel: 'probe' }));
  return {
    root, cwd, agentDir, requests: provider.requests,
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

describe('the scoped approval floor through the real Pi tool pipeline (#1061 slice 4)', () => {
  it('asks before ordinary shell/MCP-style/extension tools, blocks a deny, and runs an explicit allow', async () => {
    const root = await tmpDir('byok-scope-approval-root-');
    const cwd = path.join(root, 'workspace');
    const agentDir = path.join(root, 'agent');
    await fs.mkdir(cwd);
    await fs.mkdir(agentDir);
    const outsideFile = path.join(root, 'outside.txt');
    await fs.writeFile(outsideFile, 'outside secret');
    const deniedFile = path.join(root, 'denied-marker.txt');
    const allowedFile = path.join(root, 'allowed-marker.txt');
    const probeMarker = path.join(root, 'probe-executed.txt');
    const inScopeFile = path.join(cwd, 'inside.txt');

    await fs.mkdir(path.join(agentDir, 'extensions'));
    await fs.writeFile(path.join(agentDir, 'extensions', 'probe.js'), [
      "import { writeFileSync } from 'node:fs';",
      'export default pi => {',
      '  pi.registerTool({',
      "    name: 'probe_tool', label: 'Probe', description: 'Writes a marker when executed.',",
      "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
      '    async execute() {',
      '      writeFileSync(' + JSON.stringify(probeMarker) + ", 'executed');",
      "      return { content: [{ type: 'text', text: 'executed' }] };",
      '    },',
      '  });',
      '};',
    ].join('\n'));

    const provider = await scriptedProvider([
      { name: 'bash', arguments: { command: 'cat ' + outsideFile } },
      { name: 'bash', arguments: { command: 'touch ' + deniedFile } },
      { name: 'bash', arguments: { command: 'touch ' + allowedFile } },
      { name: 'write', arguments: { path: inScopeFile, content: 'scoped write' } },
      { name: 'probe_tool', arguments: {} },
    ]);
    await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'scope-loopback': {
      baseUrl: 'http://127.0.0.1:' + provider.address.port + '/v1', api: 'openai-completions', apiKey: 'synthetic-not-a-secret',
      models: [{ id: 'probe', name: 'probe', contextWindow: 8192, maxTokens: 64, input: ['text'], reasoning: false }],
    } } }));
    await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'scope-loopback', defaultModel: 'probe' }));

    const g = scopedGate({
      workspace: cwd, grant: await homeGrant(cwd),
      rules: { allowWithoutAsking: [{ id: 'allow-touch', match: { toolName: 'bash', commandGlob: 'touch ' + allowedFile } }] },
    });
    const session = await startPreparedOperation(adapter(), { instruction: 'Run the scripted calls, then finish.' }, {
      workspaceDir: cwd, agentHome: cwd,
      env: { HOME: root, PATH: process.env.PATH!, PI_CODING_AGENT_DIR: agentDir },
      toolAuthorization: g.toolAuthorization,
    });
    sessions.push(session);
    await finish(session);

    // The ordinary shell read asked and was denied before execution; the
    // summary a human sees names the concrete command.
    expect(g.summaries).toHaveLength(3);
    expect(g.summaries[0]).toContain('Tool call outside the file scope (outside-file-scope): bash');
    expect(g.summaries[0]).toContain('cat ' + outsideFile);
    expect(g.summaries[1]).toContain('touch ' + deniedFile);
    expect(g.summaries[2]).toContain('probe_tool');
    const denials = g.decisions.filter(decision => decision.verdict.decision === 'deny');
    expect(denials).toHaveLength(3);
    for (const denial of denials) {
      expect(denial.risk).toMatchObject({
        level: 'high', reasons: ['outside-file-scope'], authorization: { source: 'floor', ruleIds: [] },
      });
      expect(denial.verdict).toMatchObject({ decision: 'deny', code: 'tool_authorization_denied' });
    }
    expect(g.decisions.some(decision => decision.verdict.decision === 'allow')).toBe(true);
    expect(JSON.stringify(provider.requests)).toContain('tool_authorization_denied');

    // Denied calls never executed; the explicit allow did; the in-scope SDK
    // write did not ask.
    await expect(fs.stat(deniedFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(probeMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(allowedFile, 'utf8')).toBe('');
    expect(await fs.readFile(inScopeFile, 'utf8')).toBe('scoped write');
  }, 60_000);

  it('asks before a real Pi MCP tool and never starts its server on a deny', async () => {
    const f = await realPiFixture([{ name: 'mcp__salesko__echo', arguments: {} }]);
    const recordTo = path.join(f.root, 'mcp-records.jsonl');
    const fixture = path.resolve(import.meta.dirname, 'fixtures/mcp-fixture-server.mjs');
    const mcpServers = { salesko: { command: process.execPath, args: [fixture, JSON.stringify({ recordTo })] } };
    const mcpToolsetTools = observationOf({ salesko: ['echo'] });
    const g = scopedGate({
      workspace: f.cwd, grant: await homeGrant(f.cwd),
      mcpIdentities: new Map([['mcp__salesko__echo', { server: 'salesko', tool: 'echo' }]]),
    });
    const session = await startPreparedOperation(adapter(), { instruction: 'Run the scripted call, then finish.' }, {
      workspaceDir: f.cwd, agentHome: f.cwd, env: f.env,
      mcpServers, mcpToolsetTools, toolAuthorization: g.toolAuthorization,
    });
    sessions.push(session);
    await finish(session);
    expect(g.summaries).toHaveLength(1);
    expect(g.summaries[0]).toContain('mcp__salesko__echo [mcp salesko/echo]');
    expect(g.summaries[0]).toContain('outside-file-scope');
    expect(g.decisions[0]).toMatchObject({
      risk: { reasons: ['outside-file-scope'], authorization: { source: 'floor' } },
      verdict: { decision: 'deny', code: 'tool_authorization_denied' },
    });
    // The tool never executed, so its lazy MCP server never started.
    await expect(fs.stat(recordTo)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(f.requests)).toContain('tool_authorization_denied');
  }, 45_000);

  it('keeps an unscoped ordinary shell command running without asking', async () => {
    const marker = path.join(await tmpDir('byok-scope-unscoped-'), 'marker.txt');
    const f = await realPiFixture([{ name: 'bash', arguments: { command: 'touch ' + marker } }]);
    const g = scopedGate({ workspace: f.cwd });
    const session = await startPreparedOperation(adapter(), { instruction: 'Run the scripted call, then finish.' }, {
      workspaceDir: f.cwd, agentHome: f.cwd, env: f.env, toolAuthorization: g.toolAuthorization,
    });
    sessions.push(session);
    await finish(session);
    expect(g.summaries).toEqual([]);
    expect(await fs.readFile(marker, 'utf8')).toBe('');
  }, 45_000);
});
