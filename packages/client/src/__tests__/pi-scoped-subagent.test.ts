import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { startPreparedOperation } from './fixtures/prepared-operation';
import { createPiSubagentGateExtension } from '../adapters/pi/subagent-gate';
import { createPiSubagentFileScopeExtension } from '../adapters/pi/subagent-file-scope';
import { bindFileScopeGate } from '../file-scope-gate-binding';
import {
  resolveFileScopeGrant, type FileScopeGrant, type FileScopeIdentity,
} from '../file-scope-guard';
import { serializeFileScopeGrant, type SerializedFileScopeGrant } from '../file-scope-serialization';
import {
  createAutoToolAuthorizationGate, type ToolAuthorizationRules, type ToolCall,
} from '../tool-authorization';
import type { ToolAuthorizationIpcConfig } from '../tool-authorization-ipc';
import type { Session } from '../types';

const roots: string[] = [];
const sessions: Session[] = [];
const servers: Server[] = [];
afterEach(async () => {
  delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('byok.pi-subagent.file-scope.tool-source')];
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

function gateConfig(fileScope?: SerializedFileScopeGrant, required = true): ToolAuthorizationIpcConfig {
  return {
    url: 'http://127.0.0.1:9/authorize-tool', token: 'a'.repeat(64), timeoutMs: 100,
    ...(required ? { fileScopeRequired: true as const } : {}),
    ...(fileScope === undefined ? {} : { fileScope }),
  };
}

interface FakeToolInfo {
  readonly name: string;
  readonly sourceInfo: { readonly path: string };
}

type Handler = (event: { readonly toolName: string; readonly toolCallId?: string }, context: { readonly cwd: string }) => unknown;

interface FakePi {
  readonly pi: {
    on(event: string, handler: Handler): void;
    registerTool(tool: { readonly name: string }): void;
    getAllTools(): readonly FakeToolInfo[];
  };
  readonly handlers: Handler[];
  /** The tool names this fake registered through the real scope extension. */
  readonly registered: readonly { readonly name: string }[];
  setTools(tools: readonly FakeToolInfo[]): void;
}

const SDK_SOURCE = '/sdk/pi-subagent-file-scope.js';

/** The real child factory against a minimal Pi surface; builtins stand in for an unloaded scope extension. */
function fakePi(options: {
  readonly builtin?: readonly string[];
  readonly tools?: readonly FakeToolInfo[];
} = {}): FakePi {
  const handlers: Handler[] = [];
  const registered: { readonly name: string }[] = [];
  let override = options.tools;
  return {
    handlers, registered,
    setTools: (tools) => { override = tools; },
    pi: {
      on: (_event, handler) => { handlers.push(handler); },
      registerTool: (tool) => { registered.push(tool); },
      getAllTools: () => override ?? [
        ...registered.map(tool => ({ name: tool.name, sourceInfo: { path: SDK_SOURCE } })),
        ...(options.builtin ?? []).map(name => ({ name, sourceInfo: { path: 'builtin:' + name } })),
      ],
    },
  };
}

async function callHandler(
  fake: FakePi, index: number, toolName: string, cwd: string, input: Record<string, unknown> = {},
): Promise<unknown> {
  return fake.handlers[index]?.({ toolName, toolCallId: 'call-' + toolName, input } as never, { cwd });
}

function registeredSnapshot(fake: FakePi): FakeToolInfo[] {
  return fake.registered.map(tool => ({ name: tool.name, sourceInfo: { path: SDK_SOURCE } }));
}

describe('file-scoped native Pi subagent children (#1061 D11)', () => {
  it('fails closed when the gate requires a scope but the serialized grant is missing', async () => {
    const fake = fakePi({ builtin: ['read', 'write', 'edit', 'find', 'grep', 'ls'] });
    createPiSubagentGateExtension(gateConfig())(fake.pi as never);
    // The first handler is the scope blocker; the authorization hook stays last.
    expect(await callHandler(fake, 0, 'read', '/tmp')).toMatchObject({ block: true, reason: expect.stringContaining('file_scope_unavailable') });
    expect(await callHandler(fake, 0, 'write', '/tmp')).toMatchObject({ block: true, reason: expect.stringContaining('file_scope_unavailable') });

    const scope = fakePi();
    await createPiSubagentFileScopeExtension(gateConfig(), { sourcePath: SDK_SOURCE })(scope.pi as never);
    expect(scope.registered).toEqual([]);
    expect(await callHandler(scope, 0, 'read', '/tmp')).toMatchObject({ block: true, reason: expect.stringContaining('missing grant') });
    // bash is not a scoped file tool: the scope extension never inspects it.
    for (let index = 0; index < scope.handlers.length; index += 1) {
      expect(await callHandler(scope, index, 'bash', '/tmp')).toBeUndefined();
    }
  });

  it('fails closed when the grant digest does not match the re-resolved roots', async () => {
    const home = await tmpDir('byok-subagent-home-');
    const grant = await homeGrant(home);
    const mismatched: SerializedFileScopeGrant = Object.freeze({
      ...serializeFileScopeGrant(grant),
      digest: 'f'.repeat(64),
    });
    const config = gateConfig(mismatched);
    const scope = fakePi();
    await createPiSubagentFileScopeExtension(config, { sourcePath: SDK_SOURCE })(scope.pi as never);
    expect(scope.registered).toEqual([]);
    const reason = await callHandler(scope, 0, 'read', home);
    expect(reason).toMatchObject({ block: true, reason: expect.stringContaining('file_scope_unavailable') });
    expect((reason as { reason: string }).reason).toContain('root_identity_changed');

    const gate = fakePi({ builtin: ['read'] });
    createPiSubagentGateExtension(config)(gate.pi as never);
    expect(await callHandler(gate, 0, 'read', home)).toMatchObject({ block: true, reason: expect.stringContaining('file_scope_unavailable') });
  });

  it('registers the scoped tools only after the parent grant re-resolves', async () => {
    const home = await tmpDir('byok-subagent-home-');
    await fs.writeFile(path.join(home, 'inside.txt'), 'inside');
    const grant = await homeGrant(home);
    const config = gateConfig(serializeFileScopeGrant(grant));
    const scope = fakePi();
    await createPiSubagentFileScopeExtension(config, { sourcePath: SDK_SOURCE })(scope.pi as never);
    expect(scope.registered.map(tool => tool.name)).toEqual(['read', 'write', 'edit', 'find', 'grep', 'ls']);
    // The scope extension verifies the exact definitions and publishes the source path.
    expect(await callHandler(scope, 0, 'read', home)).toBeUndefined();
    const gate = fakePi({ tools: registeredSnapshot(scope) });
    createPiSubagentGateExtension(config)(gate.pi as never);
    expect(await callHandler(gate, 0, 'read', home)).toBeUndefined();
    expect(await callHandler(scope, 1, 'read', home, { path: path.join(home, 'inside.txt') })).toBeUndefined();
  });

  it('rejects a shadowing non-builtin registration and duplicate registrations', async () => {
    const home = await tmpDir('byok-subagent-home-');
    await fs.writeFile(path.join(home, 'inside.txt'), 'inside');
    const grant = await homeGrant(home);
    const config = gateConfig(serializeFileScopeGrant(grant));
    const scope = fakePi();
    await createPiSubagentFileScopeExtension(config, { sourcePath: SDK_SOURCE })(scope.pi as never);
    expect(await callHandler(scope, 0, 'read', home)).toBeUndefined();
    const snapshot = registeredSnapshot(scope);
    const read = snapshot.find(tool => tool.name === 'read')!;
    const gate = fakePi({ tools: snapshot });
    createPiSubagentGateExtension(config)(gate.pi as never);
    expect(await callHandler(gate, 0, 'read', home)).toBeUndefined();

    // A same-named non-builtin shadow replaces the SDK definition: the gate must refuse it.
    const shadowed = [...snapshot.filter(tool => tool.name !== 'read'), { name: 'read', sourceInfo: { path: '/other/read.js' } }];
    gate.setTools(shadowed);
    expect(await callHandler(gate, 0, 'read', home)).toMatchObject({ block: true, reason: expect.stringContaining('file_scope_unavailable') });
    // The scope extension's own re-check refuses it too.
    scope.setTools(shadowed);
    expect(await callHandler(scope, 0, 'read', home)).toMatchObject({ block: true, reason: expect.stringContaining('file_scope_registry_drift') });

    // Two non-builtin registrations of the same name are ambiguous, not a pass.
    gate.setTools([...snapshot, read]);
    expect(await callHandler(gate, 0, 'read', home)).toMatchObject({ block: true, reason: expect.stringContaining('file_scope_unavailable') });
    scope.setTools([...snapshot, read]);
    expect(await callHandler(scope, 0, 'read', home)).toMatchObject({ block: true, reason: expect.stringContaining('file_scope_registry_drift') });

    // A builtin entry beside the SDK one must not brick a correctly scoped child.
    gate.setTools([{ name: 'read', sourceInfo: { path: 'builtin:read' } }, ...snapshot]);
    scope.setTools([{ name: 'read', sourceInfo: { path: 'builtin:read' } }, ...snapshot]);
    expect(await callHandler(scope, 0, 'read', home)).toBeUndefined();
    expect(await callHandler(gate, 0, 'read', home)).toBeUndefined();

    // A child tool allowlist may register only some of the six; present names
    // are still checked and a called name that is absent stays refused.
    scope.setTools(snapshot.filter(tool => tool.name === 'read' || tool.name === 'write'));
    expect(await callHandler(scope, 0, 'read', home)).toBeUndefined();
    expect(await callHandler(scope, 0, 'find', home)).toMatchObject({ block: true, reason: expect.stringContaining('file_scope_registry_drift') });
  });
});

interface ScriptedTool { readonly name: string; readonly arguments: Record<string, unknown> }

async function scriptedSubagentProvider(childScript: readonly ScriptedTool[]) {
  const requests: unknown[] = [];
  let parentTurns = 0;
  let childTurns = 0;
  const server = createServer(async (request, response) => {
    let bytes = '';
    for await (const chunk of request) bytes += chunk;
    const body = JSON.parse(bytes) as { tools?: { function?: { name?: string } }[] };
    requests.push(body);
    const parent = body.tools?.some(tool => tool.function?.name === 'subagent') === true;
    let call: ScriptedTool | undefined;
    if (parent) {
      parentTurns += 1;
      if (parentTurns === 1) {
        call = { name: 'subagent', arguments: {
          agent: 'scope-child', task: 'Read and write the scripted paths, then finish.',
          model: 'scope-loopback/probe', async: false, context: 'fresh', output: false, artifacts: false, timeoutMs: 20000,
        } };
      }
    } else {
      call = childScript[childTurns];
      childTurns += 1;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = call === undefined
      ? { role: 'assistant', content: 'finished' }
      : { role: 'assistant', tool_calls: [{
        index: 0, id: 'call-' + (parent ? 'parent-' : 'child-') + (parent ? parentTurns : childTurns), type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }] };
    response.end(
      'data: ' + JSON.stringify({ id: 'response-' + requests.length, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] }) +
      '\n\n' + 'data: ' + JSON.stringify({ id: 'response-' + requests.length, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: call === undefined ? 'stop' : 'tool_calls' }] }) +
      '\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return { requests, address: server.address() as { port: number } };
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

describe('a scoped parent through the real Pi subagent scheduler (#1061 D11/S1)', () => {
  it('gives the child the same grant, refuses an outside read/write, and still asks for child bash', async () => {
    const root = await tmpDir('byok-scoped-subagent-');
    const agentDir = path.join(root, 'agent');
    const cwd = path.join(root, 'workspace');
    await fs.mkdir(agentDir);
    await fs.mkdir(cwd);
    const outsideFile = path.join(root, 'outside.txt');
    await fs.writeFile(outsideFile, 'outside scope secret');
    const insideFile = path.join(cwd, 'inside.txt');
    await fs.mkdir(path.join(agentDir, 'agents'));
    await fs.writeFile(path.join(agentDir, 'agents', 'scope-child.md'), [
      '---', 'name: scope-child', 'description: Child for the scoped-subagent boundary', 'model: scope-loopback/probe',
      'tools: read, write, bash', '---', 'Run the scripted calls, then finish.',
    ].join('\n'));
    const provider = await scriptedSubagentProvider([
      { name: 'write', arguments: { path: outsideFile, content: 'must not be written' } },
      { name: 'read', arguments: { path: outsideFile } },
      { name: 'write', arguments: { path: insideFile, content: 'scoped child write' } },
      { name: 'bash', arguments: { command: 'cat ' + outsideFile } },
    ]);
    await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'scope-loopback': {
      baseUrl: 'http://127.0.0.1:' + provider.address.port + '/v1', api: 'openai-completions', apiKey: 'synthetic-not-a-secret',
      models: [{ id: 'probe', name: 'probe', contextWindow: 8192, maxTokens: 64, input: ['text'], reasoning: false }],
    } } }));
    await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'scope-loopback', defaultModel: 'probe' }));
    const env = { HOME: root, PATH: process.env.PATH!, PI_CODING_AGENT_DIR: agentDir };

    const grant = await homeGrant(cwd);
    const summaries: string[] = [];
    const denials: string[] = [];
    const calls: ToolCall[] = [];
    const rules: ToolAuthorizationRules = { allowWithoutAsking: [{ id: 'allow-subagent', match: { toolName: 'subagent' } }] };
    const inner = createAutoToolAuthorizationGate({
      workspace: cwd, timeoutMs: 5_000, rules,
      onDecision: (decision) => { calls.push(decision.call); },
      requestAuthorization: async (summary) => { summaries.push(summary); return { approved: false, reason: 'owner authorization required' }; },
    });
    // Bind the exact gate object the adapter receives: the IPC server reads
    // this binding for the child grant, and the gate's own scoped floor reads
    // the brand for the six in-boundary tools.
    bindFileScopeGate(inner, {
      grant, taskId: 'scoped-subagent', lane: 'rpc', homeAccess: 'writer',
      onDeny: (denial) => { denials.push(denial.toolName + ':' + denial.reason); },
    });

    const session = await startPreparedOperation(adapter(), { instruction: 'Delegate the scripted calls to scope-child' }, {
      workspaceDir: cwd, agentHome: cwd, env, toolAuthorization: inner,
    });
    sessions.push(session);
    await finish(session);

    // The scoped parent offered the subagent tool at all; the rule admitted the delegation.
    expect(calls.some(call => call.toolName === 'subagent')).toBe(true);
    expect(calls.some(call => call.toolName === 'subagent' && call.nativeAgentId !== undefined)).toBe(false);
    // The child re-verified the grant, wrote inside the scope, and refused both outside calls.
    expect(await fs.readFile(insideFile, 'utf8')).toBe('scoped child write');
    await expect(fs.stat(outsideFile)).resolves.toBeDefined();
    expect(await fs.readFile(outsideFile, 'utf8')).toBe('outside scope secret');
    expect(JSON.stringify(provider.requests)).toContain('file_scope_denied');
    expect(JSON.stringify(provider.requests)).toContain('outside_scope');
    expect(denials).toEqual(expect.arrayContaining(['write:outside_scope', 'read:outside_scope']));
    // The child shell stays outside the file boundary: it asked and was denied before execution.
    const bashCall = calls.find(call => call.toolName === 'bash');
    expect(bashCall).toMatchObject({ input: { command: 'cat ' + outsideFile } });
    expect(bashCall?.nativeAgentId).toMatch(/^pi-subagent:/);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain('outside-file-scope');
    expect(summaries[0]).toContain('cat ' + outsideFile);
    expect(JSON.stringify(provider.requests)).not.toContain('outside scope secret');
  }, 90_000);
});