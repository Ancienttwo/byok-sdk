import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { DshAdapter } from '../adapters/dsh/dsh-adapter';
import { ApprovalRegistry } from '../daemon/approvals';
import type { ToolReminder } from '../tool-authorization';
import { createControlMethods } from '../daemon/create-daemon/control-methods';
import type { DaemonScope } from '../daemon/create-daemon/scope';
import { connectControlClient } from '../daemon/control-client';
import { exportPrivateKeyPem, generateDeviceKeyPair } from '../daemon/device-keys';
import { startControlServer } from '../daemon/control-server';
import { SEARCH_RUNTIME_EVIDENCE } from '../daemon/search-runtime-evidence';
import type { SearchRuntimeEvidence } from '../daemon/search-runtime-qualification';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { hostFor } from '../daemon/task-runner/host';
import { McpToolsetRegistry } from '../daemon/toolset-registry';
import { MCP_HUB_CONTEXT_ACTIVE_METHOD, type McpHubContext } from '../sdk-reserved-helper-context';
import { freezeRuntimeAdapterDescriptor, type McpStdioServerConfig, type RuntimeAdapter, type RuntimeAdapterPrepareInput, type RuntimeOperationStartInput } from '../types';
import { acceptClaimSettlement, testHarnesses, testIngressBudget } from './fixtures/activity-ingress';
import { reservedMcpToken, testScratchOwner, testScratchRoot } from './fixtures/execution-scratch';
import { FRESH_OFFER, freshOfferEgressDeps } from './fixtures/fresh-offer';
import { observationOf } from './fixtures/mcp-observation';
import { testRuntimeEnvironment } from './fixtures/runtime-env';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';

const inner = fileURLToPath(new URL('./fixtures/mcp-hub-inner.mjs', import.meta.url));
const hubBin = fileURLToPath(new URL('../../dist/bin/byok-mcp-hub.js', import.meta.url));
const connectorToken = 'synthetic-inner-connector-credential';
const replyTool = { name: 'echo', description: 'Return the input', inputSchema: { type: 'object' } };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

class FixtureAdapter extends StubRuntimeAdapter {
  declare readonly descriptor: StubRuntimeAdapter['descriptor'];
  readonly starting = Promise.withResolvers<RuntimeOperationStartInput>();
  input?: RuntimeOperationStartInput;
  constructor(id = 'pi', version = 'fixture-1', durableLane = false) {
    super(id, { kind: 'available', version }, {
      steer: false, resume: true, mcpToolsets: true, approvalInteractive: false, toolAuthorizationAuto: true, durableLane,
    });
    this.descriptor = freezeRuntimeAdapterDescriptor({ ...this.descriptor, mcpToolApprovals: true });
  }

  override async prepare(input: RuntimeAdapterPrepareInput) {
    const result = await super.prepare(input);
    if (result.kind === 'reject') return result;
    return { kind: 'prepared' as const, operation: { start: (start: RuntimeOperationStartInput) => {
      this.input = start;
      this.starting.resolve(start);
      return result.operation.start(start);
    } } };
  }

  override async runtimeEnvironment() {
    // Synthetic base has no real credential, service, or user configuration.
    return testRuntimeEnvironment({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      OPENAI_API_KEY: 'synthetic-provider-key', byok_control: 'synthetic-control',
      PI_CODING_AGENT_DIR: 'private-pi-home', HUB_CONNECTOR_TOKEN: connectorToken, HUB_REGION: 'loopback',
    });
  }
}

function setup(adapters: RuntimeAdapter[] = [new FixtureAdapter()], extra: Partial<TaskRunnerDeps> = {}) {
  const storeDir = testScratchRoot();
  const configFile = path.join(storeDir, 'inner.json');
  const receiptFile = path.join(storeDir, 'inner.jsonl');
  const registry = new McpToolsetRegistry({
    host: { exposure: 'search', mcpServers: { inner: { command: process.execPath, args: [inner, configFile, receiptFile], approveTools: ['echo'] } } },
    direct: { mcpServers: { native: { command: process.execPath, approveTools: ['other'] } } },
    collision: { mcpServers: { byoktools: { command: process.execPath } } },
  });
  const mixed = registry.snapshot().toolsets;
  const productId = 'mcp-search-test';
  const sent: Envelope[] = [];
  const probe = vi.fn(async (name: string) => observationOf({ [name]: ['other'] })[name]!);
  const row: SearchRuntimeEvidence = {
    runtimeId: 'pi', variant: 'fixture', lane: 'ordinary', platform: process.platform, arch: process.arch,
    helper: 'dist-script', version: 'fixture-1', executableSource: 'sdk-entry', receipt: 'test fixture', innerAttempts: true,
  };
  const runner = new TaskRunner({
    ...testAgentHomeDeps(), ...freshOfferEgressDeps(), adapters, storeDir, productId,
    send: envelope => sent.push(envelope), deviceId: 'fixture-device', approvalRegistry: new ApprovalRegistry(),
    blobClient: {
      async resolveInstruction() { throw new Error('not used'); },
      async uploadArtifact() { throw new Error('not used'); },
    },
    getIngressBudget: testIngressBudget, awaitClaimSettlement: acceptClaimSettlement,
    advertisedCapabilities: advertiseEveryDeviceFlag, advertisedHarnesses: () => testHarnesses(adapters), scratchRoot: testScratchOwner(),
    getMcpToolsetSnapshot: () => registry.snapshot(), mcpToolsetToolsProbe: probe,
    hostTaskContextAvailable: () => true,
    mcpSearch: { bin: { command: process.execPath, args: [hubBin] }, candidates: () => [row] },
    ...extra,
  });
  cleanup.push(() => runner.shutdownActiveTasks('test cleanup'));
  const { publicKeyBase64Url, privateKey } = generateDeviceKeyPair();
  const daemonState = {
    runner: runner as TaskRunner | undefined, shuttingDown: false,
    auth: { isRevoked: () => false, readCurrent: async () => ({
      deviceId: 'fixture-device', tenantId: 'fixture-tenant', devicePublicKey: publicKeyBase64Url,
      devicePrivateKeyPem: exportPrivateKeyPem(privateKey),
    }) },
  };
  const startControl = async () => {
    const methods = createControlMethods({
      daemonState, adapters, config: { serverUrl: 'https://fixture.example', productId },
      observer: { noteDeviceAssertion() {} }, taskContextCapabilityAvailable: () => true,
      deviceAssertionAudiences: new Set(['connector']), deviceAssertionTtlMs: 60_000,
    } as unknown as DaemonScope);
    const control = await startControlServer({ storeDir, productId, methods });
    cleanup.push(() => control.close());
    return control;
  };
  const connectControl = async () => {
    const result = await connectControlClient({ storeDir, productId });
    if (!result.ok) throw new Error(result.reason);
    cleanup.push(async () => { result.client.close(); });
    return result.client;
  };
  const proof = async () => {
    const client = await connectControl();
    return (contextToken: string) => client.request<boolean>(MCP_HUB_CONTEXT_ACTIVE_METHOD, { contextToken });
  };
  const configure = (options: Record<string, unknown> = {}) => writeFile(configFile, JSON.stringify({ pages: [[replyTool]], ...options }));
  const receipts = async () => (await readFile(receiptFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  type Offer = Extract<Envelope, { type: 'task.offer' }>['payload'];
  const offer = (taskId = 'search-task', requiredToolsets = ['host'], target: Offer['target'] = { lane: 'auto' }, extra: Pick<Offer, 'terminalProjection'> = {}) =>
    runner.handleEnvelope(createEnvelope('task.offer', { ...FRESH_OFFER, agentRef: freshTestAgentRef(), instruction: 'Test the connector', target, requiredToolsets, ...extra }, { taskId, seq: 1 }));
  const cancel = (taskId = 'search-task') => runner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId, seq: 2 }));
  return { runner, startControl, connectControl, proof, daemonState, registry, mixed, storeDir, configure, receipts, sent, probe, offer, cancel };
}

async function connectHub(spec: McpStdioServerConfig) {
  const transport = new StdioClientTransport({ command: spec.command, args: [...spec.args!], stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'fixture-runtime', version: '1' });
  cleanup.push(() => client.close());
  await client.connect(transport);
  return {
    client, stderr: () => stderr,
    search: () => client.callTool({ name: 'tool_search', arguments: { query: 'echo' } }),
    call: (text = 'hello', signal?: AbortSignal) => client.callTool({
      name: 'call_tool', arguments: { server: 'inner', tool: 'echo', arguments: { text } },
    }, { signal }),
  };
}

async function readContext(server: McpStdioServerConfig): Promise<McpHubContext> {
  const file = server.args!.at(-1)!;
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  return JSON.parse(await readFile(file, 'utf8'));
}

it('projects mixed tools and proves the sealed cwd, filtered env, inner authorization and private replies through a real hub', async () => {
  const adapter = new FixtureAdapter();
  const setupTask = setup([adapter], {
    tenantId: 'fixture-tenant',
    agentResultMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-result-mcp.js'] },
    toolAuthorization: () => ({ default: 'auto', rules: {
      alwaysAsk: [{ id: 'inner-review', match: { mcpServer: 'inner', mcpTool: 'echo' } }],
    } }),
  });
  const { configure, startControl, offer, receipts, sent, probe, proof, runner } = setupTask;
  await configure();
  await startControl();
  const release = adapter.blockStart();
  const offered = offer('search-task', ['host', 'direct'], { lane: 'auto' }, {
    terminalProjection: { mode: 'result-document', contract: 'result.v1', schema: { type: 'object' } },
  });
  try {
    const { mcpServers, mcpToolsetTools, mcpToolApprovals, toolAuthorization, manifest } = await Promise.race([
      adapter.starting.promise, offered.then(() => { throw new Error('The runtime did not start'); }),
    ]);
    expect(Object.keys(mcpServers!)).toEqual(['native', 'byoktools', 'byokagentresult']);
    expect(probe.mock.calls.map(([name]) => name)).toEqual(['native']);
    expect(mcpToolApprovals).toEqual({ native: ['other'] });
    expect(mcpToolsetTools?.byoktools?.tools.map(tool => tool.name)).toEqual(['tool_search', 'call_tool']);
    const spec = mcpServers!.byoktools!;
    const context = await readContext(spec);
    expect(spec.args).toEqual([hubBin, expect.stringContaining('byoktools-context.json')]);
    const innerSpec = context.binding.mcpServers.inner!;
    const innerFile = innerSpec.args!.at(-1)!;
    if (process.platform !== 'win32') expect((await stat(innerFile)).mode & 0o777).toBe(0o600);
    const innerNonce = reservedMcpToken(innerSpec);
    expect(new Set([innerNonce, context.contextToken, reservedMcpToken(mcpServers!.native)]).size).toBe(3);
    expect(runner.hostToolsetContext(innerNonce)).toMatchObject({ status: 'active', toolsetId: 'host' });
    const active = await proof();
    expect(await active(innerNonce)).toBe(false);
    const hub = await connectHub(spec);
    expect((await hub.client.listTools()).tools.map(tool => tool.name)).toEqual(['tool_search', 'call_tool']);
    release();
    await offered;
    expect(await active(context.contextToken)).toBe(true);
    const expectedCwd = await realpath(manifest.workspace.workspaceDir);
    await configure({ pages: [[{ ...replyTool, description: `echo ${connectorToken}` }]] });
    const search = await hub.search();
    expect(search.isError).not.toBe(true);
    expect(JSON.stringify(search)).toContain(connectorToken);
    const receipt = (await receipts())[0];
    expect(receipt.cwd).toBe(expectedCwd);
    expect(receipt.env).toMatchObject({ HUB_CONNECTOR_TOKEN: connectorToken, HUB_REGION: 'loopback' });
    for (const name of ['OPENAI_API_KEY', 'byok_control', 'PI_CODING_AGENT_DIR']) expect(receipt.env).not.toHaveProperty(name);
    const decide = async (type: 'task.approve' | 'task.reject', seq: number, text?: string) => {
      const prior = sent.filter(envelope => envelope.type === 'task.await_approval').length;
      const result = hub.call(text);
      void result.catch(() => undefined);
      await Promise.race([
        vi.waitFor(() => expect(sent.filter(envelope => envelope.type === 'task.await_approval')).toHaveLength(prior + 1)),
        result.then(() => { throw new Error('Hub replied before D requested authorization'); }),
      ]);
      const approval = sent.filter(envelope => envelope.type === 'task.await_approval').at(-1)!;
      await runner.handleEnvelope(createEnvelope(type, { approvalId: approval.payload.approvalId }, { taskId: 'search-task', seq }));
      return result;
    };
    expect(await decide('task.reject', 2)).toMatchObject({ isError: true, content: [{ text: 'MCP tool call is not authorized.' }] });
    expect((await receipts()).filter(entry => entry.method === 'tools/call')).toHaveLength(0);
    await expect(toolAuthorization!.authorize({ toolName: 'mcp__byoktools__call_tool', toolCallId: 'inner-attempt',
      cwd: manifest.workspace.workspaceDir, input: { server: 'inner', tool: 'echo', arguments: { text: 'hello' } } }))
      .resolves.toMatchObject({ decision: 'allow' });
    expect(sent.filter(envelope => envelope.type === 'task.await_approval')).toHaveLength(1);
    await configure({ behavior: 'echo-launch-secrets', pages: [[{ ...replyTool, description: `echo ${connectorToken}` }]] });
    const rejectedNonce = await decide('task.approve', 3);
    expect(rejectedNonce).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('private launch data') }] });
    await configure({ pages: [[{ ...replyTool, description: `echo ${connectorToken}` }]] });
    const rejectedToken = await decide('task.approve', 4, `echo ${context.contextToken}`);
    expect(rejectedToken).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('private launch data') }] });
    expect(await decide('task.approve', 5, connectorToken)).toMatchObject({ structuredContent: { text: connectorToken } });
    expect((await receipts()).filter(entry => entry.method === 'tools/call')).toHaveLength(3);
    for (const secret of [innerNonce, context.contextToken]) {
      expect(JSON.stringify([mcpServers, mcpToolsetTools, search, rejectedNonce, rejectedToken, sent]) + hub.stderr()).not.toContain(secret);
    }
  } finally {
    release();
    await offered;
  }
});

it('projects an inner attempt and reminder before progress without attributing its result or claiming execution', async () => {
  const adapter = new FixtureAdapter();
  const reminders: ToolReminder[] = [];
  const { configure, startControl, offer, receipts, sent } = setup([adapter], {
    toolAuthorization: () => ({ default: 'all', rules: {
      alwaysAsk: [{ id: 'review-inner', match: { toolName: 'mcp__inner__echo', pathGlob: path.resolve(path.parse(process.cwd()).root, '**/fixture.txt') } }],
    } }),
    onToolReminder: reminder => reminders.push(reminder),
  });
  await configure();
  await startControl();
  await offer();
  const hub = await connectHub(adapter.input!.mcpServers!.byoktools!);
  expect((await hub.search()).isError).not.toBe(true);
  const session = adapter.sessions[0]!;
  const mcp = { server: 'byoktools', tool: 'call_tool' };
  const tool = 'mcp__byoktools__call_tool';
  session.emit({ type: 'tool_use', tool, mcp, toolCallId: 'a', input: { server: 'inner', tool: 'echo', arguments: { path: 'fixture.txt' } } });
  session.emit({ type: 'tool_result', tool, mcp, toolCallId: 'a', isError: true, output: {
    content: [{ type: 'text', text: 'hub call failed' }],
  } });
  session.emit({ type: 'turn_end' });
  await vi.waitFor(() => expect(sent.some(row => row.type === 'task.complete')).toBe(true));
  expect(reminders).toMatchObject([{ toolName: 'mcp__inner__echo', toolCallId: 'a', authorization: { ruleIds: ['review-inner'] } }]);
  const progress = sent.flatMap(row => row.type === 'task.progress' && 'events' in row.payload ? row.payload.events : []);
  expect(progress.filter(event => event.type !== 'turn_end')).toMatchObject([
    { type: 'tool_use', tool, mcp: { server: 'inner', tool: 'echo' }, toolCallId: 'a' },
    { type: 'tool_result', tool, mcp, toolCallId: 'a', isError: true },
  ]);
  expect((await receipts()).filter(row => row.method === 'tools/call')).toHaveLength(0);
});

it('freezes the catalog across hub restart and reload, then uses a fresh snapshot and proof on the next Attempt', async () => {
  const adapter = new FixtureAdapter();
  const { configure, startControl, offer, cancel, receipts, proof, registry, mixed, storeDir, daemonState } = setup([adapter]);
  await configure();
  const control = await startControl();
  await offer();
  const spec = adapter.input!.mcpServers!.byoktools!;
  expect(Object.keys(adapter.input!.mcpServers!)).toEqual(['byoktools']);
  const firstContext = await readContext(spec);
  const firstHub = await connectHub(spec);
  expect(JSON.stringify(await firstHub.search())).toContain('inner');
  await firstHub.client.close();
  const changed = path.join(storeDir, 'changed.json');
  await writeFile(changed, JSON.stringify({ pages: [[replyTool]] }));
  const { inner: old } = mixed.get('host')!.mcpServers;
  registry.reload({ ...Object.fromEntries(mixed), host: { exposure: 'search', mcpServers: { inner: { ...old!, args: [inner, changed, old!.args![2]!] } } } }, registry.status().revision);
  const restarted = await connectHub(spec);
  expect(JSON.stringify(await restarted.search())).toContain('inner');
  expect((await receipts()).filter(entry => entry.method === 'tools/list')).toHaveLength(1);
  const active = await proof();
  const retiring = cancel();
  expect(await active(firstContext.contextToken)).toBe(false);
  expect(await restarted.call()).toMatchObject({ isError: true });
  await retiring;
  await offer('new-attempt');
  const next = await readContext(adapter.input!.mcpServers!.byoktools!);
  expect(next.binding.mcpServers.inner?.args?.[1]).toBe(changed);
  expect(next.binding.attemptId).not.toBe(firstContext.binding.attemptId);
  expect(await active(firstContext.contextToken)).toBe(false);
  expect(await active(next.contextToken)).toBe(true);
  const nextHub = await connectHub(adapter.input!.mcpServers!.byoktools!);
  expect((await nextHub.search()).isError).not.toBe(true);
  await control.close();
  expect(await nextHub.call()).toMatchObject({ isError: true });
  daemonState.runner = undefined;
  await startControl();
  const afterRestart = await proof();
  expect(await afterRestart(next.contextToken)).toBe(false);
  expect(await nextHub.search()).toMatchObject({ isError: true });
});

it.each(['idle', 'in-flight'] as const)('reclaims a %s inner process on control disconnect', async (state) => {
  const adapter = new FixtureAdapter();
  const { configure, offer, receipts, startControl } = setup([adapter]);
  await configure();
  const control = await startControl();
  await offer();
  const hub = await connectHub(adapter.input!.mcpServers!.byoktools!);
  expect((await hub.search()).isError).not.toBe(true);
  expect(await hub.call()).toMatchObject({ structuredContent: { text: 'hello' } });
  const pid = (await receipts()).find(entry => entry.method === 'tools/call').pid;
  expect(process.kill(pid, 0)).toBe(true);
  let pending: ReturnType<typeof hub.call> | undefined;
  if (state === 'in-flight') {
    await configure({ behavior: 'hang' });
    pending = hub.call();
    void pending.catch(() => undefined);
    await vi.waitFor(async () => expect((await receipts()).filter(entry => entry.method === 'tools/call')).toHaveLength(2));
  }
  await control.close();
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })));
  if (pending !== undefined) expect(await pending).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('result unknown') }] });
  expect(await hub.call()).toMatchObject({ isError: true });
  expect((await receipts()).filter(entry => entry.method === 'tools/call')).toHaveLength(state === 'idle' ? 1 : 2);
});

it('retires the spilled token before retrying the same task ID after a claim journal failure', async () => {
  const adapter = new FixtureAdapter();
  let previous: McpHubContext | undefined;
  const prepare = adapter.prepare.bind(adapter);
  let helper: McpStdioServerConfig;
  vi.spyOn(adapter, 'prepare').mockImplementation(input => {
    helper = input.mcpServers!.byoktools!;
    return prepare(input);
  });
  const { startControl, offer, proof, sent } = setup([adapter], {
    async beforeClaim() {
      if (previous !== undefined) return;
      previous = await readContext(helper);
      throw new Error('synthetic claim journal failure');
    },
  });
  await startControl();
  await offer();
  expect(sent.map(envelope => envelope.type)).toEqual(['task.decline']);
  const active = await proof();
  expect(await active(previous!.contextToken)).toBe(false);
  await offer();
  expect(sent.map(envelope => envelope.type)).toEqual(['task.decline', 'task.claim', 'task.started']);
  const current = await readContext(adapter.input!.mcpServers!.byoktools!);
  expect(await active(current.contextToken)).toBe(true);
  expect(await active(previous!.contextToken)).toBe(false);
});

it.each(['ended', 'start-failed', 'shutdown'] as const)('revokes the Attempt before cleanup when %s', async (outcome) => {
  const adapter = new FixtureAdapter();
  const { runner, offer, startControl, proof, sent } = setup([adapter]);
  await startControl();
  const active = await proof();
  const release = adapter.blockStart();
  const offered = offer();
  let context: McpHubContext;
  try {
    const input = await Promise.race([
      adapter.starting.promise, offered.then(() => { throw new Error('The runtime did not start'); }),
    ]);
    context = await readContext(input.mcpServers!.byoktools!);
    release(outcome === 'start-failed' ? new Error('synthetic start failure') : undefined);
  } finally {
    release();
    await offered;
  }
  if (outcome !== 'start-failed') {
    expect(await active(context.contextToken)).toBe(true);
    const close = adapter.sessions[0]!.blockClose();
    try {
      if (outcome === 'ended') adapter.sessions[0]!.emit({ type: 'turn_end' });
      else runner.stopAcceptingOffers();
      await vi.waitFor(async () => expect(await active(context.contextToken)).toBe(false));
    } finally { close(); }
  } else expect(sent.some(envelope => envelope.type === 'task.fail')).toBe(true);
  expect(await active(context.contextToken)).toBe(false);
});

it.each(['start', 'activation'] as const)('revokes direct and inner nonces while %s failure waits for terminal persistence', async (failure) => {
  const adapter = new FixtureAdapter();
  const home = testAgentHomeDeps();
  const writingTerminal = Promise.withResolvers<void>();
  const releaseTerminal = Promise.withResolvers<void>();
  if (failure === 'activation') {
    vi.spyOn(home.agentSessionHandoffs, 'record').mockRejectedValueOnce(new Error('synthetic activation failure'));
  }
  const recordTerminal = home.agentSessionHandoffs.recordTaskTerminal.bind(home.agentSessionHandoffs);
  vi.spyOn(home.agentSessionHandoffs, 'recordTaskTerminal').mockImplementation(async input => {
    writingTerminal.resolve();
    await releaseTerminal.promise;
    return recordTerminal(input);
  });
  const { startControl, connectControl, offer, sent } = setup([adapter], home);
  await startControl();
  const control = await connectControl();
  const issue = (contextToken: string) => control.request('task_assertion.issue', { contextToken, audience: 'connector' });
  const release = adapter.blockStart();
  const offered = offer('search-task', ['host', 'direct']);
  try {
    const { mcpServers } = await Promise.race([
      adapter.starting.promise, offered.then(() => { throw new Error('The runtime did not start'); }),
    ]);
    const context = await readContext(mcpServers!.byoktools!);
    const nonces = [reservedMcpToken(mcpServers!.native), reservedMcpToken(context.binding.mcpServers.inner)];
    for (const nonce of nonces) await expect(issue(nonce)).resolves.toHaveProperty('assertion');
    release(failure === 'start' ? new Error('synthetic start failure') : undefined);
    await writingTerminal.promise;
    expect(sent.some(envelope => envelope.type === 'task.fail')).toBe(false);
    for (const nonce of nonces) await expect(issue(nonce)).rejects.toMatchObject({ code: 'context_revoked' });
  } finally {
    release();
    releaseTerminal.resolve();
    await offered;
  }
  expect(sent.some(envelope => envelope.type === 'task.fail')).toBe(true);
});

it.skipIf(process.platform === 'win32')('declines search when a fresh DSH prepare probe captures a newly published unqualified installation', async () => {
  const root = testScratchRoot();
  const fixture = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url));
  const version = '0.2.2-rc.1';
  const generation = 'generation-00000000-0000-4000-8000-000000000001';
  const executable = 'dsh';
  const managedRoot = path.join(root, 'runtimes', 'dsh');
  await mkdir(path.join(managedRoot, generation), { recursive: true });
  await copyFile(fixture, path.join(managedRoot, generation, executable));
  const spawnFn = vi.fn(() => { throw new Error('unexpected DSH session spawn'); });
  const adapter = new DshAdapter({
    home: path.join(root, 'home'), runtimeInstallRoot: root, spawnFn,
    model: { provider: 'custom', providerId: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'loop-model' },
    resolveKey: async () => 'dsh-search-fixture-provider-key',
    runtimeEnvironment: { base: 'allowlist' },
  });
  const detect = vi.spyOn(adapter, 'detect');
  // With this offer's admission observation, prepare() launches the installation admission verified (#2469).
  // Without it, prepare() probes afresh, and a different installation must still fail the search evidence.
  const freshPrepare = adapter.prepare.bind(adapter);
  const prepare = vi.spyOn(adapter, 'prepare').mockImplementation(({ detected: _admitted, ...input }) => freshPrepare(input));
  const { offer, sent } = setup([adapter], {
    mcpSearch: {
      bin: { command: process.execPath, args: [hubBin] },
      candidates: descriptor => SEARCH_RUNTIME_EVIDENCE.filter(row => row.runtimeId === descriptor.id),
    },
    async prepareHostTaskContext() {
      await writeFile(path.join(managedRoot, 'current.json'), JSON.stringify({ generation, executable, version }));
    },
  });
  vi.stubEnv('BYOK_DSH_BIN', fixture);
  try {
    await offer('search-dsh', ['host'], {
      lane: 'harness', harnessId: 'dsh', selection: { mode: 'byok', providerId: 'openai', modelId: 'byok-custom/loop-model' },
    });
    await expect(detect.mock.results[0]?.value).resolves.toMatchObject({ kind: 'available', version, executableSource: 'env' });
    await expect(prepare.mock.results[0]?.value).resolves.toMatchObject({
      kind: 'prepared', detected: { version, executableSource: 'managed' },
    });
    expect(sent.map(envelope => envelope.type)).toEqual(['task.decline']);
    expect(sent[0]?.payload).toMatchObject({
      retryable: true, reason: 'MCP search exposure is unavailable on this device for the requested runtime or version',
    });
    expect(spawnFn).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('skips version mismatches and the durable lane in auto, and admits a direct-only byoktools', async () => {
  const old = new FixtureAdapter('claude', 'fixture-0');
  const durable = new FixtureAdapter('codex', 'fixture-1', true);
  const selected = new FixtureAdapter();
  const { offer, sent, cancel, probe } = setup([old, durable, selected], { runtimePreference: ['claude', 'codex', 'pi'] });
  const detectDurable = vi.spyOn(durable, 'detect');
  await offer('unqualified', ['host'], { lane: 'harness', harnessId: 'claude', selection: { mode: 'device-default' } });
  expect(sent.map(envelope => envelope.type)).toEqual(['task.decline']);
  await offer('collision', ['host', 'collision']);
  expect(sent.at(-1)?.payload).toMatchObject({ reason: expect.stringContaining('conflicts with the search hub name') });
  expect(probe).not.toHaveBeenCalled();
  await offer();
  expect(selected.input?.mcpServers?.byoktools?.args?.[0]).toBe(hubBin);
  expect(old.startCalls).toHaveLength(0);
  expect(detectDurable).not.toHaveBeenCalled();
  await cancel();
  await offer('direct', ['collision'], { lane: 'harness', harnessId: 'claude', selection: { mode: 'device-default' } });
  expect(old.input?.mcpServers?.byoktools?.args).toEqual([expect.stringContaining('host-toolset-')]);
});

it('searches and enforces D while starting, then denies calls after cancellation', async () => {
  const adapter = new FixtureAdapter();
  const onDecision = vi.fn();
  const { configure, startControl, offer, cancel, proof, sent, receipts } = setup([adapter], {
    toolAuthorization: () => ({ default: 'auto', rules: {
      alwaysAsk: [{ id: 'startup-review', match: { mcpServer: 'inner', mcpTool: 'echo' } }],
    } }),
    onToolAuthorizationDecision: onDecision,
  });
  await configure();
  await startControl();
  const active = await proof();
  const release = adapter.blockStart();
  const offered = offer();
  try {
    const { mcpServers } = await Promise.race([
      adapter.starting.promise, offered.then(() => { throw new Error('The runtime did not start'); }),
    ]);
    const context = await readContext(mcpServers!.byoktools!);
    const hub = await connectHub(mcpServers!.byoktools!);
    expect(sent.map(row => row.type)).toEqual(['task.claim']);
    expect(await active(context.contextToken)).toBe(true);
    expect(JSON.stringify(await hub.search())).toContain('inner');
    expect(await hub.call()).toMatchObject({ isError: true, content: [{ text: 'MCP tool call is not authorized.' }] });
    expect(onDecision).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      toolName: 'mcp__inner__echo', decision: 'deny', code: 'tool_authorization_unavailable',
      authorization: { source: 'rule', ruleIds: ['startup-review'] },
    }));
    expect(sent.map(row => row.type)).toEqual(['task.claim']);
    await cancel();
    expect(await active(context.contextToken)).toBe(false);
    expect(await hub.search()).toMatchObject({ isError: true });
    expect(await hub.call()).toMatchObject({ isError: true });
    expect((await receipts()).filter(entry => entry.method === 'tools/call')).toHaveLength(0);
  } finally {
    release();
    await offered;
  }
  expect(sent.map(row => row.type)).toEqual(['task.claim', 'task.cancelled']);
});

it.each(['MCP cancellation', 'stdio close'] as const)('withdraws a pending search tool approval on %s', async (how) => {
  const adapter = new FixtureAdapter();
  const approvalRegistry = new ApprovalRegistry();
  const stale = vi.fn();
  const { configure, startControl, offer, receipts, runner, sent } = setup([adapter], {
    approvalRegistry, onStaleApprovalDecision: stale,
    toolAuthorization: () => ({ default: 'auto', rules: {
      alwaysAsk: [{ id: 'inner-review', match: { mcpServer: 'inner', mcpTool: 'echo' } }],
    } }),
  });
  await configure();
  await startControl();
  await offer();
  const spec = adapter.input!.mcpServers!.byoktools!;
  const hub = await connectHub(spec);
  expect((await hub.search()).isError).not.toBe(true);

  const cancel = new AbortController();
  const cancelled = hub.call('cancelled', cancel.signal);
  void cancelled.catch(() => undefined);
  await vi.waitFor(() => expect(approvalRegistry.list()).toHaveLength(1));
  const { approvalId } = approvalRegistry.list()[0]!;
  expect(sent).toContainEqual(expect.objectContaining({ type: 'task.await_approval', payload: expect.objectContaining({ approvalId }) }));
  expect((await receipts()).filter(entry => entry.method === 'tools/call')).toHaveLength(0);

  const liveHub = how === 'MCP cancellation' ? hub : await connectHub(spec);
  const next = liveHub.call('approved');
  void next.catch(() => undefined);
  await vi.waitFor(() => expect(hostFor(runner).current('search-task')?.approval.queue).toHaveLength(1));

  if (how === 'MCP cancellation') cancel.abort();
  else await hub.client.close();
  await expect(cancelled).rejects.toThrow();
  await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
    type: 'task.approval_resolved', task_id: 'search-task',
    payload: expect.objectContaining({ approvalId, decision: 'reject', resolvedBy: 'local' }),
  })));
  await vi.waitFor(() => expect(sent.filter(envelope => envelope.type === 'task.await_approval')).toHaveLength(2));
  const nextApproval = sent.filter(envelope => envelope.type === 'task.await_approval').at(-1)!.payload.approvalId;
  expect(approvalRegistry.list().map(approval => approval.approvalId)).toEqual([nextApproval]);

  await runner.handleEnvelope(createEnvelope('task.approve', { approvalId }, { taskId: 'search-task', seq: 2 }));
  expect(stale).toHaveBeenCalledWith('search-task', 'approve', expect.stringContaining(approvalId));
  expect((await receipts()).filter(entry => entry.method === 'tools/call')).toHaveLength(0);
  await runner.handleEnvelope(createEnvelope('task.approve', { approvalId: nextApproval }, { taskId: 'search-task', seq: 3 }));
  expect(await next).toMatchObject({ structuredContent: { text: 'approved' } });
  expect((await receipts()).filter(entry => entry.method === 'tools/call').map(entry => entry.params.arguments)).toEqual([{ text: 'approved' }]);
});
