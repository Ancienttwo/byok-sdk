import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createEnvelope, type AgentEvent, type Envelope } from '@byok-sdk/protocol';
import { TaskRunner } from '../daemon/task-runner';
import { AgentHomeManager } from '../agent-home';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import { FRESH_OFFER, freshOfferRunnerDeps } from './fixtures/fresh-offer';
import { testExecutionScratch, testScratchOwner } from './fixtures/execution-scratch';
import { testIngressBudget } from './fixtures/activity-ingress';
import { projectRuntimeBoundaryFailure, RuntimeDisposalFailure, RuntimeStartupDisposalFailure } from '../runtime-failure';
import * as processTree from '../adapters/process-tree';
import { OpenCodeAdapter } from '../adapters/opencode/opencode-adapter';
import { OPENCODE_RUNTIME_CAPABILITIES } from '../adapters/opencode/opencode-capabilities';
import { opencodeVersionToken } from '../adapters/opencode/opencode-version';
import { resolveOpenCodeBin } from '../adapters/opencode/resolve-bin';
import { createRuntimeAdapters } from '../adapters/runtime-adapters';
import { resolveRuntimeInvocation } from '../adapters/runtime-invocation';
import { npmNodeShim } from './fixtures/npm-node-shim';
import { check, defineRuntimeCases } from './runtime-contract/contract';
import { opencodeSession, opencodeV2RefusedSessionOptions } from '../../vendor/oar/95c6547/runtimes/opencode/session';
import { spawnOwnedLineProcess } from '../runtime/owned-line-process';
import { createOwnedTerminalSpawn, spawnOwnedTerminalProcess } from '../runtime/owned-terminal-process';
import { startPreparedOperation } from './fixtures/prepared-operation';
import { validateRuntimeDetectResult } from '../runtime-detection';
import type { MessageDraftDelta, Session } from '../types';

const fake = path.join(import.meta.dirname, 'fixtures/fake-acp-agent.mjs');
const models = ['fixture/first', 'fixture/next', 'fixture/third'];
const sessions: Session[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function setup(version = '1.18.35', extra: Record<string, string> = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'oc-'));
  dirs.push(cwd);
  const log = path.join(cwd, 'log');
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', FAKE_ACP_VERSION: version, FAKE_ACP_OPENCODE: '1', FAKE_ACP_SESSION_ID: 'ses_opencode_fixture', FAKE_ACP_LOG: log, FAKE_ACP_LISTED_CWD: cwd, ...extra };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const adapter = new OpenCodeAdapter({ models, resolveBin: () => ({ command: fake, source: 'env' }), runtimeEnvironment: { base: 'allowlist', pass: ['FAKE_ACP_*'] } });
  const facts = (): Array<Record<string, any>> => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const start = async (instruction: string, sessionRef?: string, mcpServers?: { host: { command: string } }) => {
    const session = await startPreparedOperation(adapter, { instruction, ...(sessionRef === undefined ? {} : { sessionRef }) }, { workspaceDir: cwd, env, ...(mcpServers === undefined ? {} : { mcpServers }) });
    sessions.push(session);
    return session;
  };
  return { cwd, env, log, adapter, facts, start };
}
async function collect(session: Session) {
  const events: AgentEvent[] = [];
  for await (const event of session.events) events.push(event as AgentEvent);
  return events;
}

it.each([
  ['1.18.35', '1.18.35'], ['opencode v2.0.26', '2.0.26'], ['1.19.5', '1.19.5'], ['opencode v2.2.6', '2.2.6'],
  ['1.18.34', undefined], ['2.0.25', undefined], ['2.0.26-rc.1', undefined], ['opencode v3.0.0', undefined], ['garbage 1.18.35', undefined], ['1.18.35\n2.0.26', undefined],
])('normalizes only a complete supported release token %s', (raw, expected) => expect(opencodeVersionToken(raw)).toBe(expected));

for (const version of ['1.18.35', 'opencode v2.0.26']) {
  defineRuntimeCases(`OpenCode ${version} replay contract`, {
    'open.model.resume': ['passes the Host model, checks readback and resumes only in the original cwd', check(async () => {
      const box = setup(version);
      const first = await box.start('hello');
      expect((await collect(first)).at(-1)).toEqual({ type: 'turn_end' });
      await first.close();
      const second = await box.start('hello', first.sessionRef);
      expect(second.sessionRef).toBe('ses_opencode_fixture');
      expect(second.sessionRef).toBe(first.sessionRef);
      expect(await collect(second)).not.toContainEqual({ type: 'progress', text: 'historical replay' });
      expect(box.facts().filter(fact => fact.kind === 'config').map(fact => fact.params.value)).toEqual([models[0], models[0]]);
      expect(box.facts().find(fact => fact.kind === 'open' && fact.method === 'session/resume')).toBeDefined();
      const wrong = path.join(box.cwd, 'elsewhere');
      box.env.FAKE_ACP_LISTED_CWD = wrong;
      await expect(box.start('hello', first.sessionRef)).rejects.toMatchObject({
        name: 'RuntimeExecutionFailure', phase: 'start', retry: 'non-retryable',
      });
      expect(box.facts().filter(fact => fact.kind === 'open' && fact.method === 'session/resume')).toHaveLength(1);
      expect(box.facts().filter(fact => fact.kind === 'prompt')).toHaveLength(2);
    })],
    'model.mismatch': ['refuses a differing native readback before any prompt', check(async () => {
      const box = setup(version, { FAKE_ACP_MODEL_READBACK: 'fixture/wrong' });
      await expect(box.start('hello')).rejects.toThrow(/readback/);
      expect(box.facts().some(fact => fact.kind === 'prompt')).toBe(false);
    })],
    'model.fallback': ['retries only the next Host candidate and records the switch', check(async () => {
      const box = setup(version);
      const gate = path.join(box.cwd, 'release-rate-limit');
      box.env.FAKE_ACP_SESSION_STORE = path.join(box.cwd, 'native-session.json');
      box.env.FAKE_ACP_RATE_GATE = gate;
      const session = await box.start('opencode-limit', undefined, { host: { command: 'fixture-mcp' } });
      const published = session.sessionRef;
      writeFileSync(gate, 'release');
      const events = await collect(session);
      expect(session.sessionRef).toBe(published);
      expect(box.facts().filter(fact => fact.kind === 'native-session').map(fact => fact.sessionId)).toEqual([published]);
      expect(box.facts().filter(fact => fact.kind === 'open' && fact.method === 'session/resume').map(fact => fact.params.sessionId)).toEqual([published]);
      expect(box.facts().filter(fact => fact.kind === 'open').map(fact => fact.params.mcpServers)).toEqual([
        [{ name: 'host', command: 'fixture-mcp', args: [], env: [] }], [{ name: 'host', command: 'fixture-mcp', args: [], env: [] }],
      ]);
      const switchEvent = events.find(event => event.type === 'error');
      expect(switchEvent?.type === 'error' && JSON.parse(switchEvent.message)).toEqual({ event: 'model_switch', from: models[0], to: models[1], reason: 'rate_limited' });
      expect(events).toContainEqual({ type: 'progress', text: 'fallback reply' });
      expect(box.facts().filter(fact => fact.kind === 'config').map(fact => fact.params.value)).toEqual(models.slice(0, 2));
    })],
    'permissions.cancel': ['declines unsupported permission requests and cancellation settles', check(async () => {
      const box = setup(version);
      await collect(await box.start('permission'));
      expect(box.facts().find(fact => fact.kind === 'permission')?.reply).toEqual({ outcome: { outcome: 'cancelled' } });
      const held = await box.start('hold');
      await expect(held.steer('no')).rejects.toThrow(/unsupported/);
      await held.interrupt();
      expect((await collect(held)).at(-1)).toEqual({ type: 'turn_end' });
      await held.close();
    })],
  });
}

it.each(['opencode-limit-always', 'opencode-limit-after-output', 'opencode-limit-after-thought'])('bounds fallback for %s', async instruction => {
  const box = setup();
  await expect(collect(await box.start(instruction))).rejects.toThrow();
  expect(box.facts().filter(fact => fact.kind === 'config')).toHaveLength(instruction === 'opencode-limit-always' ? 2 : 1);
});

it('keeps v2 child calls distinct and execute opaque, and emits only native usage', async () => {
  const box = setup('opencode v2.0.26');
  const events = await collect(await box.start('opencode-child'));
  expect(events.filter(event => event.type === 'tool_use')).toEqual([
    { type: 'tool_use', tool: 'shell', toolCallId: 'same-id', input: { code: 'host.lookup()' } },
    { type: 'tool_use', tool: 'execute', toolCallId: 'native-child:same-id', input: { code: 'host.lookup()' } },
  ]);
  expect(events).toContainEqual({ type: 'usage', contextTokens: 321, contextWindow: 1000 });
  expect(events.filter(event => event.type === 'progress')).toEqual([{ type: 'progress', text: 'done' }]);
});

it.each(['appendSystemPrompt', 'systemPrompt'] as const)('refuses v2 %s before launch', async option => {
  const box = setup('opencode v2.0.26');
  const spawn = vi.fn(spawnOwnedLineProcess);
  await expect(opencodeSession(spawn, spawnOwnedTerminalProcess, { kind: 'available', via: 'executable', command: fake, version: '2.0.26' },
    { cwd: box.cwd, env: box.env, [option]: 'required persona' })).rejects.toThrow(opencodeV2RefusedSessionOptions[option]);
  expect(spawn).not.toHaveBeenCalled();
});

it('cleans a detached descendant before reporting success', async () => {
  const box = setup();
  const pidFile = path.join(box.cwd, 'daemon.pid');
  await collect(await box.start(`agy-daemon:${pidFile}`));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
});

it('registers an opt-in adapter with truthful capabilities', async () => {
  const box = setup();
  const [adapter] = createRuntimeAdapters({ runtimeAllowlist: ['opencode'], runtimes: { opencode: { models, executable: fake } } });
  expect(adapter!.descriptor).toEqual(expect.objectContaining({ id: 'opencode', platforms: ['darwin', 'win32'], capabilities: OPENCODE_RUNTIME_CAPABILITIES, versionPolicy: { qualifiedVersion: '2.2.6', unqualified: 'warn' } }));
  expect(validateRuntimeDetectResult(await box.adapter.detect())).toMatchObject({ kind: 'available', version: '1.18.35', rawVersion: '1.18.35\n', executableSource: 'config' });
  expect(OPENCODE_RUNTIME_CAPABILITIES.mcpToolsets).toBe(true);
});

it.each(['1.19.5', 'opencode v2.2.6'])('passes admitted MCP servers on new and resumed %s sessions', async version => {
  const box = setup(version);
  const server = { command: '/fixture/mcp', args: ['--stdio'], env: { TASK_SECRET: 'fixture-secret' } };
  const resources = { workspaceDir: box.cwd, env: box.env, mcpServers: { host: server } };
  const first = await startPreparedOperation(box.adapter, { instruction: 'hello' }, resources); sessions.push(first);
  await collect(first); await first.close();
  const second = await startPreparedOperation(box.adapter, { instruction: 'hello', sessionRef: first.sessionRef }, resources); sessions.push(second);
  await collect(second);
  const opens = box.facts().filter(fact => fact.kind === 'open');
  expect(opens.map(fact => fact.method)).toEqual(['session/new', 'session/resume']);
  for (const open of opens) expect(open.params.mcpServers).toEqual([{ name: 'host', command: server.command, args: server.args, env: [{ name: 'TASK_SECRET', value: 'fixture-secret' }] }]);
});

it.each(['1.19.5', 'opencode v2.2.6'])('uses MCP servers supplied at start on %s', async version => {
  const box = setup(version);
  const prepare = box.adapter.prepare.bind(box.adapter);
  vi.spyOn(box.adapter, 'prepare').mockImplementation(async input => {
    const prepared = await prepare(input);
    if (prepared.kind === 'reject') return prepared;
    const start = prepared.operation.start;
    return { ...prepared, operation: { ...prepared.operation, start: input => start({ ...input,
      mcpServers: { late: { command: 'late-mcp', env: { TOKEN: 'late-secret' } } },
    }) } };
  });
  const session = await startPreparedOperation(box.adapter, { instruction: 'hello' }, {
    workspaceDir: box.cwd, env: box.env, mcpServers: { admitted: { command: 'admitted-mcp' } },
  });
  sessions.push(session); await collect(session);
  expect(box.facts().find(fact => fact.kind === 'open')?.params.mcpServers).toEqual([
    { name: 'late', command: 'late-mcp', args: [], env: [{ name: 'TOKEN', value: 'late-secret' }] },
  ]);
});

it.each([{ '': { command: 'server' } }, { host: { command: '' } }, { host: { command: 'server', env: { KEY: null } } }])('rejects malformed MCP authority during preparation', async mcpServers => {
  const box = setup(); const result = await box.adapter.prepare({ offer: { instruction: 'hello' }, descriptor: box.adapter.descriptor, requiredToolsetIds: [], mcpServers: mcpServers as any });
  expect(result).toMatchObject({ kind: 'reject', retryable: false }); expect(existsSync(box.log)).toBe(false);
});

it('resolves a PATH executable, then the installer location, without configuration reads', () => {
  const box = setup();
  const bin = path.join(box.cwd, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  writeFileSync(bin, '', { mode: 0o700 });
  expect(resolveOpenCodeBin({ PATH: box.cwd, HOME: box.cwd }).command).toBe(bin);
});

it('uses the exact npm command-shim entry and node through the owned-process invocation contract', () => {
  const shim = 'C:\\npm\\opencode.cmd';
  const node = 'C:\\npm\\node.exe';
  expect(resolveRuntimeInvocation(shim, { platform: 'win32', env: {}, isFile: file => [shim, node].includes(file), isExecutable: () => false, readFile: () => npmNodeShim('node_modules\\@opencode\\cli\\bin\\opencode.js') })).toEqual({
    command: node, args: ['C:\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.js'], executable: shim,
  });
});


it('retains the v1 appended-persona overlay and removes its private instruction file on disposal', async () => {
  const box = setup();
  const raw = await opencodeSession(spawnOwnedLineProcess, spawnOwnedTerminalProcess,
    { kind: 'available', via: 'executable', command: fake, version: '1.18.35' },
    { cwd: box.cwd, env: box.env, appendSystemPrompt: 'required persona {env:UNCHANGED}' });
  try {
    const env = box.facts().find(fact => fact.kind === 'start')!.env;
    const file = JSON.parse(env.OPENCODE_CONFIG_CONTENT).instructions[0];
    expect(readFileSync(file, 'utf8')).toBe('required persona {env:UNCHANGED}');
    await raw.dispose();
    expect(existsSync(file)).toBe(false);
  } finally { await raw.dispose(); }
});

it('refuses a v2 Agent-memory reader before launching ACP', async () => {
  const box = setup('opencode v2.0.26');
  await expect(startPreparedOperation(box.adapter, { instruction: 'reader' }, {
    workspaceDir: box.cwd, env: box.env, reader: { canonicalHome: box.cwd },
  })).rejects.toThrow(/transient instruction channel/);
  expect(existsSync(box.log)).toBe(false);
});


it('keeps the admitted native identity in task.complete and persisted terminal evidence after fallback', async () => {
  const box = setup();
  const gate = path.join(box.cwd, 'release-rate-limit');
  vi.stubEnv('FAKE_ACP_SESSION_STORE', path.join(box.cwd, 'native-session.json'));
  vi.stubEnv('FAKE_ACP_RATE_GATE', gate);
  const descriptor = box.adapter.descriptor;
  vi.spyOn(box.adapter, 'descriptor', 'get').mockReturnValue({ ...descriptor, platforms: [process.platform] });
  const sent: Envelope[] = [];
  const handoffs = new AgentSessionHandoffStore();
  const recorded = vi.spyOn(handoffs, 'recordTerminal');
  const runner = new TaskRunner({ ...freshOfferRunnerDeps(), getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [box.adapter], agentHome: new AgentHomeManager({ hostStorageRoot: path.join(box.cwd, 'homes') }), agentSessionHandoffs: handoffs,
    deviceId: 'device-1', productId: 'opencode-test', storeDir: path.join(box.cwd, 'store'),
    send: envelope => { sent.push(envelope); }, approvalRegistry: new ApprovalRegistry(),
    blobClient: { resolveInstruction: async () => { throw new Error('unused'); }, uploadArtifact: async () => { throw new Error('unused'); } },
  });
  try {
    await runner.handleEnvelope(createEnvelope('task.offer', { harnessId: 'opencode', agentRef: { agentId: 'opencode-agent', profileRevision: 'r1' },
      instruction: 'opencode-limit', agentMemory: 'none', ...FRESH_OFFER }, { taskId: 'identity-fallback', seq: 1 }));
    expect(sent.some(envelope => envelope.type === 'task.started')).toBe(true);
    const published = box.facts().find(fact => fact.kind === 'native-session')!.sessionId;
    writeFileSync(gate, 'release');
    await vi.waitFor(() => expect(sent.some(envelope => envelope.type === 'task.complete')).toBe(true));
    const terminal = sent.find(envelope => envelope.type === 'task.complete')!;
    expect(terminal.payload).toMatchObject({ sessionRef: published, finalMessage: 'fallback reply' });
    expect(recorded).toHaveBeenCalledTimes(1);
    expect(recorded.mock.calls[0]![0].sessionRef).toBe(published);
    await expect(handoffs.get(recorded.mock.calls[0]![0])).resolves.toMatchObject({ sessionRef: published, terminalCause: 'complete' });
  } finally { await runner.shutdownActiveTasks('test cleanup'); }
});


it.each([
  ['1.18.35', 'resume'], ['1.18.35', 'model'],
  ['opencode v2.0.26', 'resume'], ['opencode v2.0.26', 'model'],
] as const)('preserves the original rate-limit failure when %s fallback %s RPC is refused', async (version, refusal) => {
  const box = setup(version, refusal === 'resume' ? { FAKE_ACP_REFUSE_RESUME: '1' } : { FAKE_ACP_REFUSE_MODEL: models[1]! });
  box.env.FAKE_ACP_SESSION_STORE = path.join(box.cwd, 'native-session.json');
  const events: AgentEvent[] = [];
  const session = await box.start('opencode-limit');
  const admitted = session.sessionRef;
  await expect((async () => { for await (const event of session.events) events.push(event as AgentEvent); })()).rejects.toMatchObject({
    message: 'Rate limit exceeded', phase: 'run', retry: 'non-retryable', failure: { class: 'rate_limited' },
  });
  expect(events).toEqual([]);
  expect(session.sessionRef).toBe(admitted);
  expect(box.facts().filter(fact => fact.kind === 'native-session').map(fact => fact.sessionId)).toEqual([admitted]);
  expect(box.facts().filter(fact => fact.kind === 'prompt')).toHaveLength(1);
});

// The class comes from data.errorName; a failure classified from its words is reported unknown and never switches models.
it.each([
  ['opencode-limit-text', 'Rate limit exceeded', 'unknown'],
  ['opencode-error:provider.free-limit|Free usage exceeded', 'Internal error: Free usage exceeded', 'quota'],
  ['opencode-error:provider.something-new|Rate limit exceeded', 'Internal error: Rate limit exceeded', 'unknown'],
  ['opencode-error:APIError|invalid x-api-key', 'Internal error: invalid x-api-key', 'unknown'],
] as const)('opencode %s fails as %s without switching models', async (prompt, message, failureClass) => {
  const box = setup('1.18.35');
  const session = await box.start(prompt);
  await expect((async () => { for await (const _event of session.events); })()).rejects.toMatchObject({
    message, phase: 'run', retry: 'non-retryable', failure: { class: failureClass },
  });
  expect(box.facts().filter(fact => fact.kind === 'prompt')).toHaveLength(1);
  expect(box.facts().some(fact => fact.kind === 'open' && fact.method === 'session/resume')).toBe(false);
});


it('classifies OpenCode process exits during start and a turn', async () => {
  const opening = setup('1.18.35', { FAKE_ACP_INITIALIZE: 'exit' });
  await expect(opening.start('hello')).rejects.toMatchObject({
    phase: 'start', retry: 'retryable', failure: { class: 'runtime_exited' },
  });
  vi.unstubAllEnvs();
  const running = setup();
  const session = await running.start('exit');
  await expect(collect(session)).rejects.toMatchObject({
    phase: 'run', retry: 'non-retryable', failure: { class: 'runtime_exited' },
  });
});

it('validates the shared session limits', () => {
  expect(() => new OpenCodeAdapter({ models, interruptTimeoutMs: 0.5 })).not.toThrow();
  expect(() => new OpenCodeAdapter({ models, maxRetainedBytes: 0 })).toThrow('invalid opencode retention budget');
});

it('normalizes startup failures to start while retaining native classification', async () => {
  for (const { env, failure } of [
    { env: { FAKE_ACP_INITIALIZE: 'error' }, failure: 'unknown' },
    { env: { FAKE_ACP_INITIALIZE: 'auth' }, failure: 'auth' },
    { env: { FAKE_ACP_MODEL_READBACK: 'fixture/wrong' }, failure: 'unknown' },
  ]) {
    const box = setup('1.18.35', env as Record<string, string>);
    const error = await box.start('hello').then(() => undefined, error => error);
    expect(error).toMatchObject({ phase: 'start', failure: { class: failure } });
    expect(projectRuntimeBoundaryFailure(error, 'start')).toMatchObject({ contractViolation: false, failure: { class: failure } });
  }
});

it('settles an opening budget kill before disposing the native session', async () => {
  const box = setup();
  const adapter = new OpenCodeAdapter({ models, maxRetainedBytes: 1, resolveBin: () => ({ command: fake, source: 'env' }) });
  const error = await startPreparedOperation(adapter, { instruction: 'hello' }, { workspaceDir: box.cwd, env: box.env })
    .then(() => undefined, error => error);
  expect(error).toMatchObject({ name: 'RuntimeExecutionFailure', phase: 'start',
    message: 'opencode retained record byte budget exceeded' });
  expect(box.facts().some(fact => fact.kind === 'prompt' || fact.kind === 'close')).toBe(false);
  const started = box.facts().find(fact => fact.kind === 'start')!;
  expect(() => process.kill(started.pid, 0)).toThrow();
});

it('retries a halt whose cleanup failed before signalling without retaining its rejected exit receipt', async () => {
  const box = setup();
  const scratch = await testExecutionScratch();
  const release = vi.fn(() => scratch.release());
  const real = processTree.disposeOwnedProcessTree;
  let blocked = true;
  let owned: Parameters<typeof real>[0] | undefined;
  const spy = vi.spyOn(processTree, 'disposeOwnedProcessTree').mockImplementation(async options => {
    if (options.label === 'opencode acp') {
      owned = options;
      if (blocked) throw new RuntimeDisposalFailure({ stage: 'signal', reason: 'injected signal failure' });
    }
    return real(options);
  });
  const adapter = new OpenCodeAdapter({ models, maxRetainedBytes: 1, resolveBin: () => ({ command: fake, source: 'env' }) });
  let error: unknown;
  const opening = startPreparedOperation(adapter, { instruction: 'hello' }, { workspaceDir: box.cwd, env: box.env, scratch: { ...scratch, release } })
    .catch(value => { error = value; });
  try {
    await vi.waitFor(() => expect(error).toBeInstanceOf(RuntimeStartupDisposalFailure), { timeout: 1000 });
    expect(() => process.kill(owned!.child.pid!, 0)).not.toThrow();
    expect(release).not.toHaveBeenCalled();
    // External recovery closes the root while the transport's own cleanup still fails.
    await real(owned!);
    blocked = false;
    await (error as RuntimeStartupDisposalFailure).retryDisposal();
    expect(release).toHaveBeenCalledTimes(1);
    expect(box.facts().some(fact => fact.kind === 'close')).toBe(false);
    expect(() => process.kill(owned!.child.pid!, 0)).toThrow();
  } finally {
    blocked = false;
    spy.mockRestore();
    if (owned) await real(owned);
    await opening;
    if (error instanceof RuntimeStartupDisposalFailure) await error.retryDisposal().catch(() => {});
    await scratch.release();
  }
});

it('retries failed v1 prompt cleanup and shares concurrent and successful disposal', async () => {
  const box = setup();
  const owned = createOwnedTerminalSpawn();
  const gate = Promise.withResolvers<void>();
  let terminal: ReturnType<typeof spawnOwnedTerminalProcess> | undefined;
  let reclaims = 0;
  const raw = await opencodeSession(spawnOwnedLineProcess, (command, args, options) => {
    terminal = owned(command, args, options);
    const current = terminal;
    return { ...current, dispose: async () => {
      reclaims += 1;
      if (reclaims === 1) await gate.promise;
      await current.dispose();
    } };
  }, { kind: 'available', via: 'executable', command: fake, version: '1.18.35' },
  { cwd: box.cwd, env: box.env, appendSystemPrompt: 'required reader persona' });
  try {
    await raw.prompt('opencode-terminal-hang');
    await vi.waitFor(() => expect(box.facts().some(fact => fact.kind === 'terminal')).toBe(true));
    const concurrent = Promise.allSettled([raw.dispose(), raw.dispose()]);
    await vi.waitFor(() => expect(reclaims).toBe(1));
    gate.reject(new Error('temporary terminal reclaim failure'));
    expect((await concurrent).map(result => result.status)).toEqual(['rejected', 'rejected']);
    await raw.dispose();
    expect(reclaims).toBe(2);
    await raw.dispose();
    expect(reclaims).toBe(2);
  } finally {
    gate.resolve();
    await raw.dispose().catch(() => {});
    await terminal?.dispose();
  }
});

it.each(['status', 'input', 'completion'] as const)('buffers ACP tool input until %s', async branch => {
  const { OpenCodeProjection } = await import('../adapters/opencode/projection');
  const { GrokProjection } = await import('../adapters/grok/projection');
  const { AgyProjection } = await import('../adapters/antigravity/projection');
  for (const projection of [new OpenCodeProjection('root'), new GrokProjection('root'), new AgyProjection('root', new Map())]) {
    const events: AgentEvent[] = [];
    const send = (update: Record<string, unknown>, derived: object[]) => projection.consume({ kind: 'frame', sessionId: 'root', agentPath: [], body: { native: { update }, events: derived } } as never, event => events.push(event as AgentEvent), () => {});
    send({ toolCallId: 'c', status: 'pending', rawInput: { cwd: '/repo' } }, [{ kind: 'tool_call_started', callId: 'c', tool: 'shell' }]);
    expect(events).toEqual([]);
    const input = { command: 'pwd', cwd: '/repo' };
    if (branch === 'input') send({ toolCallId: 'c', rawInput: input }, [{ kind: 'tool_call_input', callId: 'c', input: JSON.stringify(input) }]);
    else if (branch === 'status') send({ toolCallId: 'c', status: 'in_progress', rawInput: input }, []);
    else send({ toolCallId: 'c', status: 'completed', rawInput: input }, [{ kind: 'tool_call_input', callId: 'c', input: JSON.stringify(input) }, { kind: 'tool_call_ended', callId: 'c', result: 'ok' }]);
    expect(events[0]).toEqual({ type: 'tool_use', tool: 'shell', toolCallId: 'c', input });
    if (branch !== 'completion') send({ toolCallId: 'c', status: 'completed' }, [{ kind: 'tool_call_ended', callId: 'c', result: 'ok' }]);
    expect(events.map(event => event.type)).toEqual(['tool_use', 'tool_result']);
  }
});

it('emits dsh tool use when complete native arguments arrive', async () => {
  const { DshProjection } = await import('../adapters/dsh/projection');
  const projection = new DshProjection('root', 'model');
  const events: AgentEvent[] = [];
  projection.consume({ kind: 'frame', sessionId: 'root', agentPath: [], body: {
    native: { data: { arguments: '{"command":"sleep 600"}' } },
    events: [{ kind: 'tool_call_started', callId: 'c', tool: 'shell' }],
  } } as never, event => events.push(event), () => {});
  expect(events).toEqual([{ type: 'tool_use', tool: 'shell', toolCallId: 'c', input: { command: 'sleep 600' } }]);
});

it.each(['aborted', 'failed', 'completed'])('drains pending ACP calls once with their latest input when a turn is %s', async kind => {
  const { OpenCodeProjection } = await import('../adapters/opencode/projection');
  const { GrokProjection } = await import('../adapters/grok/projection');
  const { AgyProjection } = await import('../adapters/antigravity/projection');
  for (const projection of [new OpenCodeProjection('root'), new GrokProjection('root'), new AgyProjection('root', new Map())]) {
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent | MessageDraftDelta) => { if (event.type !== 'message_draft_delta') events.push(event); };
    const send = (update: object, derived: object[]) => projection.consume({ kind: 'frame', sessionId: 'root', agentPath: [], body: { native: { update }, events: derived } } as never, emit,
      () => { expect(events.filter(event => event.type === 'tool_use')).toHaveLength(2); });
    send({ toolCallId: 'pending', status: 'pending', rawInput: {} }, [{ kind: 'tool_call_started', callId: 'pending', tool: 'shell' }]);
    const input = { command: 'pwd', cwd: '/repo' };
    send({ toolCallId: 'pending', status: 'pending', rawInput: input }, []);
    send({ toolCallId: 'running', status: 'in_progress', rawInput: input }, [{ kind: 'tool_call_started', callId: 'running', tool: 'shell' }]);
    send({}, [{ kind: 'turn_ended', outcome: { kind } }]);
    send({}, [{ kind: 'turn_ended', outcome: { kind } }]);
    expect(events.filter(event => event.type === 'tool_use')).toEqual([
      { type: 'tool_use', tool: 'shell', toolCallId: 'running', input },
      { type: 'tool_use', tool: 'shell', toolCallId: 'pending', input },
    ]);
  }
});

it('flushes pending text before a directly completed ACP call', async () => {
  const { GrokProjection } = await import('../adapters/grok/projection');
  const { AgyProjection } = await import('../adapters/antigravity/projection');
  for (const projection of [new GrokProjection('root'), new AgyProjection('root', new Map())]) {
    const events: Array<{ type: string }> = [];
    const send = (update: object, derived: object[]) => projection.consume({ kind: 'frame', sessionId: 'root', agentPath: [], body: { native: { update }, events: derived } } as never, event => events.push(event), () => {});
    send({ toolCallId: 'c', status: 'pending', rawInput: { cwd: '/repo' } }, [{ kind: 'tool_call_started', callId: 'c', tool: 'shell' }]);
    send({}, [{ kind: 'text_delta', text: 'waiting' }]);
    send({ toolCallId: 'c', status: 'completed', rawInput: { command: 'pwd', cwd: '/repo' } }, [{ kind: 'tool_call_input', callId: 'c' }, { kind: 'tool_call_ended', callId: 'c', result: 'ok' }]);
    expect(events.filter(event => event.type !== 'message_draft_delta').map(event => event.type)).toEqual(['progress', 'tool_use', 'tool_result']);
  }
});
