import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalRegistry } from '../daemon/approvals';
import { createControlMethods } from '../daemon/create-daemon/control-methods';
import type { DaemonScope } from '../daemon/create-daemon/scope';
import { connectControlClient } from '../daemon/control-client';
import { startControlServer } from '../daemon/control-server';
import type { SearchRuntimeEvidence } from '../daemon/search-runtime-qualification';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { McpToolsetRegistry } from '../daemon/toolset-registry';
import { MCP_HUB_CONTEXT_ACTIVE_METHOD, type McpHubContext } from '../sdk-reserved-helper-context';
import { freezeRuntimeAdapterDescriptor, type McpStdioServerConfig, type RuntimeAdapterPrepareInput, type RuntimeOperationStartInput } from '../types';
import { acceptClaimSettlement, testIngressBudget } from './fixtures/activity-ingress';
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

function setup(adapters = [new FixtureAdapter()], extra: Partial<TaskRunnerDeps> = {}) {
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
    helper: 'dist-script', version: 'fixture-1', executableSource: 'sdk-entry', receipt: 'test fixture',
  };
  const runner = new TaskRunner({
    ...testAgentHomeDeps(), ...freshOfferEgressDeps(), adapters, storeDir, productId,
    send: envelope => sent.push(envelope), deviceId: 'fixture-device', approvalRegistry: new ApprovalRegistry(),
    blobClient: {
      async resolveInstruction() { throw new Error('not used'); },
      async uploadArtifact() { throw new Error('not used'); },
    },
    getIngressBudget: testIngressBudget, awaitClaimSettlement: acceptClaimSettlement,
    advertisedCapabilities: advertiseEveryDeviceFlag, scratchRoot: testScratchOwner(),
    getMcpToolsetSnapshot: () => registry.snapshot(), mcpToolsetToolsProbe: probe,
    hostTaskContextAvailable: () => true,
    mcpSearch: { bin: { command: process.execPath, args: [hubBin] }, candidates: () => [row] },
    ...extra,
  });
  cleanup.push(() => runner.shutdownActiveTasks('test cleanup'));
  const daemonState = { runner: runner as TaskRunner | undefined, shuttingDown: false };
  const startControl = async () => {
    const methods = createControlMethods({ daemonState, adapters } as unknown as DaemonScope);
    const control = await startControlServer({ storeDir, productId, methods });
    cleanup.push(() => control.close());
    return control;
  };
  const proof = async () => {
    const result = await connectControlClient({ storeDir, productId });
    if (!result.ok) throw new Error(result.reason);
    cleanup.push(async () => { result.client.close(); });
    return (contextToken: string) => result.client.request<boolean>(MCP_HUB_CONTEXT_ACTIVE_METHOD, { contextToken });
  };
  const configure = (options: Record<string, unknown> = {}) => writeFile(configFile, JSON.stringify({ pages: [[replyTool]], ...options }));
  const receipts = async () => (await readFile(receiptFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  type Offer = Extract<Envelope, { type: 'task.offer' }>['payload'];
  const offer = (taskId = 'search-task', requiredToolsets = ['host'], target: Offer['target'] = { lane: 'auto' }, extra: Pick<Offer, 'terminalProjection'> = {}) =>
    runner.handleEnvelope(createEnvelope('task.offer', { ...FRESH_OFFER, agentRef: freshTestAgentRef(), instruction: 'Test the connector', target, requiredToolsets, ...extra }, { taskId, seq: 1 }));
  const cancel = (taskId = 'search-task') => runner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId, seq: 2 }));
  return { runner, startControl, proof, daemonState, registry, mixed, storeDir, configure, receipts, sent, probe, offer, cancel };
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
    call: () => client.callTool({ name: 'call_tool', arguments: { server: 'inner', tool: 'echo', arguments: { text: 'hello' } } }),
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
    expect(await hub.search()).toMatchObject({ isError: true });
    release();
    await offered;
    expect(await active(context.contextToken)).toBe(true);
    const expectedCwd = await realpath(manifest.workspace.workspaceDir);
    await configure({ pages: [[{ ...replyTool, description: connectorToken }]] });
    const rejectedMetadata = await hub.search();
    expect(rejectedMetadata).toMatchObject({ isError: true });
    await expect(stat(context.binding.catalogPath)).rejects.toHaveProperty('code', 'ENOENT');
    await configure();
    const search = await hub.search();
    expect(JSON.stringify(search)).toContain('inner');
    const receipt = (await receipts())[0];
    expect(receipt.cwd).toBe(expectedCwd);
    expect(receipt.env).toMatchObject({ HUB_CONNECTOR_TOKEN: connectorToken, HUB_REGION: 'loopback' });
    for (const name of ['OPENAI_API_KEY', 'byok_control', 'PI_CODING_AGENT_DIR']) expect(receipt.env).not.toHaveProperty(name);
    const authorization = toolAuthorization!.authorize({ toolName: 'mcp__byoktools__call_tool', toolCallId: 'inner-attempt',
      cwd: manifest.workspace.workspaceDir, input: { server: 'inner', tool: 'echo', arguments: { text: 'fixture' } } });
    await vi.waitFor(() => expect(sent.find(envelope => envelope.type === 'task.await_approval')).toBeDefined());
    const approval = sent.find(envelope => envelope.type === 'task.await_approval')!;
    await runner.handleEnvelope(createEnvelope('task.reject', { approvalId: approval.payload.approvalId }, { taskId: 'search-task', seq: 2 }));
    expect(await authorization).toMatchObject({ decision: 'deny' });
    expect((await receipts()).some(entry => entry.method === 'tools/call')).toBe(false);
    await configure({ behavior: 'echo-launch-secrets' });
    const rejectedReply = await hub.call();
    expect(rejectedReply).toMatchObject({ isError: true });
    await configure();
    expect(await hub.call()).toMatchObject({ structuredContent: { text: 'hello' } });
    expect((await receipts()).filter(entry => entry.method === 'tools/call')).toHaveLength(2);
    for (const secret of [connectorToken, innerNonce, context.contextToken]) {
      expect(JSON.stringify([mcpServers, mcpToolsetTools, rejectedMetadata, search, rejectedReply, sent]) + hub.stderr()).not.toContain(secret);
    }
  } finally {
    release();
    await offered;
  }
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

it('skips version mismatches and the durable lane in auto, and admits a direct-only byoktools', async () => {
  const old = new FixtureAdapter('claude', 'fixture-0');
  const durable = new FixtureAdapter('codex', 'fixture-1', true);
  const selected = new FixtureAdapter();
  const { offer, sent, cancel, probe } = setup([old, durable, selected], { runtimePreference: ['claude', 'codex', 'pi'] });
  const detectDurable = vi.spyOn(durable, 'detect');
  await offer('unqualified', ['host'], { lane: 'runtime', runtimeId: 'claude' });
  expect(sent.map(envelope => envelope.type)).toEqual(['task.decline']);
  await offer('collision', ['host', 'collision']);
  expect(sent.at(-1)?.payload).toMatchObject({ reason: expect.stringContaining('conflicts with the search hub name') });
  expect(probe).not.toHaveBeenCalled();
  await offer();
  expect(selected.input?.mcpServers?.byoktools?.args?.[0]).toBe(hubBin);
  expect(old.startCalls).toHaveLength(0);
  expect(detectDurable).not.toHaveBeenCalled();
  await cancel();
  await offer('direct', ['collision'], { lane: 'runtime', runtimeId: 'claude' });
  expect(old.input?.mcpServers?.byoktools?.args).toEqual([expect.stringContaining('host-toolset-')]);
});
