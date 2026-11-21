import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { arch, platform, release } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AgentEventSchema, createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalRegistry } from '../../daemon/approvals';
import { connectControlClient } from '../../daemon/control-client';
import { startControlServer } from '../../daemon/control-server';
import { createControlMethods } from '../../daemon/create-daemon/control-methods';
import type { DaemonScope } from '../../daemon/create-daemon/scope';
import { TaskRunner } from '../../daemon/task-runner';
import { searchRuntimeCandidates } from '../../daemon/search-runtime-qualification';
import { McpToolsetRegistry } from '../../daemon/toolset-registry';
import { HUB_CALL_TOOL, HUB_SEARCH_TOOL, MCP_HUB_SERVER_NAME } from '../../mcp/hub/protocol';
import { MCP_HUB_CONTEXT_ACTIVE_METHOD, type McpHubContext } from '../../sdk-reserved-helper-context';
import type { ExecutionTarget } from '@byok-sdk/protocol';
import type { McpStdioServerConfig, RuntimeAdapter, RuntimeDetectResult } from '../../types';
import { acceptClaimSettlement, testHarnesses, testIngressBudget } from '../fixtures/activity-ingress';
import { hostToolsetToken, testScratchOwner } from '../fixtures/execution-scratch';
import { FRESH_OFFER, freshOfferRunnerDeps } from '../fixtures/fresh-offer';
import { testRuntimeEnvironment } from '../fixtures/runtime-env';
import { freshTestAgentRef, testAgentHomeDeps } from '../fixtures/test-agent';
import { isProcessLive } from '../support/process-liveness';
import { contractMode, createSandbox, fileEgress, readReceipt, withProcessEnv, writeSubmitResultServer, type ContractRuntime, type Sandbox } from './contract';
import { CONTRACT_REPLY_CHUNKS, mcpTool, startLoopbackProvider, type LoopbackProvider, type ProviderRequest, type ProviderStep, type ProviderTool, type ProviderWire } from './loopback';

const hubBin = path.resolve(import.meta.dirname, '../../../dist/bin/byok-mcp-hub.js');
const hubTrace = path.resolve(import.meta.dirname, '../fixtures/mcp-hub-trace.mjs');
const innerBin = path.resolve(import.meta.dirname, '../fixtures/mcp-hub-inner.mjs');
const outputDir = process.env.BYOK_SEARCH_RECEIPT_DIR;
const sandboxProfile = process.env.BYOK_SEARCH_SANDBOX;
const exact = 'submit_result';
const longName = `long_${'x'.repeat(59)}`;
const longServer = `long-${'s'.repeat(59)}`;
const tool = (name: string) => ({ name, description: 'Record a synthetic receipt', inputSchema: { type: 'object' } });
const text = { kind: 'text', chunks: CONTRACT_REPLY_CHUNKS } as const;
const spawnProbe = promisify(execFile);
const terminalTypes = new Set(['task.complete', 'task.fail', 'task.decline', 'task.cancelled']);

type Scenario = 'mixed' | 'qualified-launch' | 'native-deny-control' | 'native-deny-search' | 'all' | 'name-boundary' | 'parallel' | 'collision-dash' | 'collision-underscore' | 'collision-exact' | 'hub-idle' | 'hub-in-flight'
  | 'inner-idle' | 'inner-in-flight' | 'drift' | 'outer-slow' | 'slow-below' | 'slow-above' | 'call-budget' | 'maximum' | 'cancel';
const scenarios: readonly Scenario[] = ['mixed', 'qualified-launch', 'native-deny-control', 'native-deny-search', 'all', 'name-boundary', 'parallel', 'collision-dash', 'collision-underscore', 'collision-exact', 'hub-idle', 'hub-in-flight',
  'inner-idle', 'inner-in-flight', 'drift', 'outer-slow', 'slow-below', 'slow-above', 'call-budget', 'maximum', 'cancel'];

interface ProbeOptions {
  runtime: ContractRuntime;
  variant: string;
  target?: ExecutionTarget;
  wire: ProviderWire;
  model?: string;
  configure(box: Sandbox, provider: LoopbackProvider, capture: typeof spawn, scenario: Scenario): Promise<{ adapter: RuntimeAdapter; env: NodeJS.ProcessEnv }>;
  projectEnvironment?: (env: Readonly<Record<string, string>>, box: Sandbox) => Readonly<Record<string, string>>;
}

/** Pi is bundled instead of taken from an external contract wrapper. */
export const spawnContractPi: typeof spawn = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
  if (sandboxProfile === undefined) return spawn(command, args, options);
  return spawn('/usr/bin/sandbox-exec', ['-f', sandboxProfile, command, ...args], options);
}) as typeof spawn;

function captureRuntime(frames: unknown[], useSpawn: typeof spawn): typeof spawn {
  return ((command: string, args: string[], options: Parameters<typeof spawn>[2]): ChildProcess => {
    const child = useSpawn(command, args, options);
    if (child.stdout !== null) {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (frames.length >= 48 || !/byoktools|tool_execution_start|tool_execution_end/.test(line)) return;
        try { frames.push(JSON.parse(line)); } catch { /* native diagnostics may be plain text */ }
      });
    }
    return child;
  }) as typeof spawn;
}

interface Action { server: string; tool: string; args: Record<string, unknown> }
const search: Action = { server: MCP_HUB_SERVER_NAME, tool: HUB_SEARCH_TOOL, args: { query: 'submit result' } };
const call = (server: string, summary: string, name = exact): Action => ({ server: MCP_HUB_SERVER_NAME, tool: HUB_CALL_TOOL,
  args: { server, tool: name, arguments: { summary } } });

function selectTool(request: ProviderRequest, action: Action, bridges: Set<string>, runtime: ContractRuntime): ProviderStep | undefined {
  const { server, tool, args } = action;
  const picked = mcpTool(server, tool)(request.tools);
  if (picked !== undefined) return { kind: 'tool', tool: picked, args };
  const nativeName = `mcp__${server}__${tool}`;
  if (runtime === 'dsh' && nativeName.length > 64) {
    const shortened = request.tools.find(candidate => candidate.name.startsWith(nativeName.slice(0, 45))
      && /_[a-z0-9]{12}$/.test(candidate.name));
    if (shortened !== undefined) return { kind: 'tool', tool: shortened, args };
  }
  const claude = request.tools.find(candidate => candidate.name === 'ToolSearch');
  if (claude !== undefined && !bridges.has(nativeName) && request.text.includes(nativeName)) {
    bridges.add(nativeName);
    return { kind: 'tool', tool: claude, args: { query: `select:${nativeName}`, max_results: 1 } };
  }
  const grokSearch = request.tools.find(candidate => candidate.name === 'search_tool');
  const grokCall = request.tools.find(candidate => candidate.name === 'use_tool');
  const grokName = `${server}__${tool}`;
  if (grokCall !== undefined && request.text.includes(`\\"${grokName}\\"`)) {
    return { kind: 'tool', tool: grokCall, args: { tool_name: grokName, tool_input: args } };
  }
  if (grokSearch !== undefined && !bridges.has(grokName)) {
    bridges.add(grokName);
    return { kind: 'tool', tool: grokSearch, args: { query: `${server} ${tool}` } };
  }
  const execute = request.tools.find(candidate => candidate.name === 'execute');
  if (execute !== undefined && request.text.includes(`tools.${server}.${tool}(`)) {
    const code = `return await tools[${JSON.stringify(server)}][${JSON.stringify(tool)}](${JSON.stringify(args)})`;
    return { kind: 'tool', tool: execute, args: { code } };
  }
  return undefined;
}

const waitFor = <T>(read: () => Promise<T>, label: string) => vi.waitFor(async () => {
  const value = await read();
  if (!value) throw new Error(`Timed out waiting for ${label}`);
  return value;
}, { timeout: 30_000, interval: 20 });

function shutdownPid(pid: number): void {
  try { process.kill(pid, 'SIGKILL'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function probe(options: ProbeOptions, scenario: Scenario) {
  const box = await createSandbox(`search-${options.runtime}`);
  const recorder = await fileEgress();
  const sent: Envelope[] = [];
  const lifecycleClock: Array<{ type: string; ms: number }> = [];
  const nativeFrames: unknown[] = [];
  const attempted: Array<{ action: Action; native: ProviderTool }> = [];
  const providerSteps: ProviderStep[] = [];
  const bridges = new Set<string>();
  const receiptPaths = new Map<string, string>();
  const configPaths = new Map<string, string>();
  const hubReceipt = path.join(box.root, 'hub.jsonl');
  const collisionNames: Partial<Record<Scenario, string>> = {
    'collision-dash': 'byok-tools', 'collision-underscore': 'byok_tools', 'collision-exact': 'byoktools',
  };
  const collision = collisionNames[scenario];
  const names = scenario === 'maximum'
    ? Array.from({ length: 256 }, (_, index) => `s${String(index).padStart(3, '0')}`)
    : ['alpha', 'beta', 'blocked'];
  const qualifiedLaunch = scenario === 'qualified-launch';
  const nativeDenyControl = scenario === 'native-deny-control';
  const nativeDenySearch = scenario === 'native-deny-search';
  const paired = scenario === 'mixed' || qualifiedLaunch || scenario === 'all' || scenario === 'name-boundary' || collision !== undefined;
  const longDirectServer = options.runtime === 'dsh' ? longServer.slice(0, 32) : longServer;
  const first = call(names[0]!, 'first');
  const actions = paired ? [search, first, call('beta', 'second'), call('alpha', 'long-name', longName), call('blocked', 'denied'),
    call('outside', 'not-in-attempt'), { server: 'native', tool: exact, args: { summary: 'direct' } },
    ...(collision === undefined ? [] : [{ server: collision, tool: HUB_CALL_TOOL, args: { summary: 'collision-control' } }]),
    ...(scenario === 'name-boundary' ? [{ server: longDirectServer, tool: longName, args: { summary: 'long-native' } }] : [])]
    : nativeDenyControl ? [{ server: 'alpha', tool: exact, args: { summary: 'first' } }]
      : nativeDenySearch ? [search, first]
        : scenario === 'parallel' ? [search, first, call('beta', 'parallel-second')]
      : ['cancel', 'slow-above', 'outer-slow'].includes(scenario) ? [search]
        : [search, first, ...(scenario.includes('idle') || scenario.includes('flight') || scenario === 'drift' ? [call('alpha', 'explicit-next')] : [])];
  let step = 0;
  let requestsAfterLastStep = 0;
  let killed = false;
  let cancel: (() => Promise<void>) | undefined;
  let cancelTask: Promise<void> | undefined;
  let fault: Promise<void> | undefined;
  let faultError: string | undefined;
  let nextTaskActive: boolean | undefined;
  let nextTask = false;
  const releaseNextTask = Promise.withResolvers<void>();
  let frozenCatalog: Buffer | undefined;
  let staleActive: boolean | undefined;
  let staleNonce: string | undefined;
  let firstNonce: string | undefined;
  let hubFdPeak: number | undefined;
  let fdSample: NodeJS.Timeout | undefined;
  let fdPending: Promise<void> | undefined;
  let staleCall: boolean | undefined;
  let innerAuthority: boolean | undefined;
  let mode: RuntimeDetectResult | undefined;
  let context: McpHubContext | undefined;
  let helperArgs: readonly string[] | undefined;
  let elapsedMs = 0;
  let error: string | undefined;
  let startedAt = 0;
  let offeredAt = 0;
  const track = (run: Promise<void>) => run.catch(cause => { faultError = String(cause); });
  const innerReads = (server: string) => readReceipt(receiptPaths.get(server)!);
  const kill = async (where: 'hub' | 'inner') => {
    const frames = await (where === 'hub' ? readReceipt(hubReceipt) : innerReads('alpha'));
    const frame = frames.findLast(item => item.method === 'start');
    if (typeof frame?.pid !== 'number') throw new Error(`No ${where} PID in fixture receipt`);
    shutdownPid(frame.pid);
    killed = true;
  };
  const provider = await startLoopbackProvider(options.wire, async request => {
    if (nextTask) { await releaseNextTask.promise; return text; }
    if (startedAt === 0) startedAt = Date.now();
    if (scenario === 'mixed' && step === 1 && context !== undefined) {
      frozenCatalog ??= await fs.readFile(context.binding.catalogPath).catch(() => undefined);
    }
    if (step === 2 && !killed && scenario.includes('idle')) await kill(scenario.startsWith('hub') ? 'hub' : 'inner');
    if (step === 2 && scenario === 'drift' && !killed) {
      await kill('inner');
      await fs.writeFile(configPaths.get('alpha')!, JSON.stringify({ pages: [[tool('changed_schema')]] }));
    }
    const action = actions[step];
    if (action === undefined || requestsAfterLastStep++ >= 4) return text;
    let picked = selectTool(request, action, bridges, options.runtime);
    if (picked === undefined && killed && scenario.startsWith('hub') && step === 2) {
      const prior = attempted.at(-1);
      if (prior !== undefined) picked = { kind: 'tool', tool: prior.native, args: action.args };
    }
    if (picked?.kind !== 'tool') return text;
    const selected = options.runtime === 'agy' ? { ...picked, args: { ...picked.args, toolSummary: 'Synthetic contract call' } } : picked;
    if (selected.tool.name === 'ToolSearch' || selected.tool.name === 'search_tool') { providerSteps.push(selected); return selected; }
    if (scenario === 'parallel' && step === 1 && options.wire === 'openai-chat') {
      const second = actions[2]!;
      const parallel = selectTool(request, second, bridges, options.runtime);
      if (parallel?.kind === 'tool') {
        attempted.push({ action, native: selected.tool }, { action: second, native: parallel.tool });
        const response = { ...selected, parallel: [parallel] };
        providerSteps.push(response);
        step += 2;
        return response;
      }
    }
    providerSteps.push(selected);
    attempted.push({ action, native: selected.tool });
    requestsAfterLastStep = 0;
    step++;
    if (scenario === 'cancel' && step === 1) {
      cancelTask = track((async () => {
        await waitFor(async () => (await innerReads('alpha')).some(frame => frame.method === 'list-wait'), 'blocked discovery');
        await cancel?.();
      })());
    }
    if (scenario.includes('flight') && step === 2) {
      fault = track((async () => {
        await waitFor(async () => (await innerReads('alpha')).some(frame => frame.method === 'tools/call'), 'in-flight write receipt');
        await kill(scenario.startsWith('hub') ? 'hub' : 'inner');
        await fs.writeFile(configPaths.get('alpha')!, JSON.stringify({ pages: [[tool(exact), tool(longName)]] }));
      })());
    }
    return selected;
  }, options.model);

  try {
    const { adapter, env } = await options.configure(box, provider, captureRuntime(nativeFrames, options.runtime === 'pi' ? spawnContractPi : spawn), scenario);
    await withProcessEnv({ ...env, ...recorder.env, HUB_CONTRACT_MARKER: 'loopback' }, async () => {
      vi.spyOn(adapter, 'runtimeEnvironment').mockImplementation(async () => testRuntimeEnvironment(process.env));
      mode = await adapter.detect();
      if (mode.kind !== 'available' || mode.version === undefined) throw new Error(`Runtime detect: ${JSON.stringify(mode)}`);
      const directFile = path.join(box.root, 'direct.jsonl');
      const native = await writeSubmitResultServer(box.root, directFile);
      receiptPaths.set('native', directFile);
      if (paired) receiptPaths.set('outside', path.join(box.root, 'outside.jsonl'));
      const servers: Array<readonly [string, McpStdioServerConfig]> = [];
      for (const name of names) {
        const receipt = path.join(box.root, `${name}.jsonl`);
        const config = path.join(box.root, `${name}.json`);
        receiptPaths.set(name, receipt);
        configPaths.set(name, config);
        await fs.writeFile(config, JSON.stringify({ pages: [[tool(exact), tool(longName)]],
          ...(name !== names[0] ? {} : {
            ...(scenario === 'slow-below' ? { listDelayMs: 700 } : {}),
            ...(scenario === 'slow-above' ? { listDelayMs: 12_000 } : {}),
            ...(scenario === 'cancel' ? { waitForList: path.join(box.root, 'never') } : {}),
            ...(scenario === 'parallel' ? { callDelayMs: 500 } : {}),
            ...(scenario.includes('flight') || scenario === 'call-budget' ? { behavior: 'hang' } : {}),
          }),
        }));
        servers.push([name, { command: process.execPath, args: [innerBin, config, receipt] }] as const);
      }
      const searchSets = Array.from({ length: Math.ceil(servers.length / 16) }, (_, index) => [`search${index}`, {
        exposure: 'search' as const, mcpServers: Object.fromEntries(servers.slice(index * 16, index * 16 + 16)),
      }] as const);
      const collisionFile = path.join(box.root, 'collision.jsonl');
      if (collision !== undefined) receiptPaths.set(collision, collisionFile);
      const boundaryReceipt = path.join(box.root, 'long-native.jsonl');
      if (scenario === 'name-boundary') receiptPaths.set(longDirectServer, boundaryReceipt);
      const directServers = { native,
        ...(collision === undefined ? {} : { [collision]: await writeSubmitResultServer(box.root, collisionFile, HUB_CALL_TOOL) }),
        ...(scenario === 'name-boundary' ? { [longDirectServer]: await writeSubmitResultServer(box.root, boundaryReceipt, longName) } : {}),
      };
      const registry = new McpToolsetRegistry(nativeDenyControl ? { nativecontrol: { mcpServers: Object.fromEntries(servers) } } : {
        ...Object.fromEntries(searchSets), ...(paired ? {
        direct: { mcpServers: directServers },
        unselected: { exposure: 'search', mcpServers: { outside: { command: process.execPath, args: [innerBin, configPaths.get('alpha')!, receiptPaths.get('outside')!] } } },
      } : {}) });
      const productId = 'runtime-search-contract';
      const taskId = 'search-contract';
      const auto = scenario !== 'all' && adapter.descriptor.capabilities.toolAuthorizationAuto === true;
      const cancellations: Promise<void>[] = [];
      const terminal = Promise.withResolvers<Envelope>();
      const isolation: Readonly<Record<string, string>> = options.runtime === 'dsh' ? { sandbox: 'danger-full-access' } : { agentUserContext: 'inherit' };
      const productionCandidates = searchRuntimeCandidates({}, [{
        id: adapter.descriptor.id, source: 'sdk-built', toolAuthorizationAuto: auto, isolation,
      }]);
      const runner = new TaskRunner({
        ...testAgentHomeDeps(), ...freshOfferRunnerDeps(), advertisedHarnesses: () => testHarnesses([adapter]), adapters: [adapter], storeDir: box.root, productId,
        send: envelope => {
          sent.push(envelope);
          if (envelope.task_id === taskId && (terminalTypes.has(envelope.type) || envelope.type === 'task.claim' || envelope.type === 'task.started')) {
            lifecycleClock.push({ type: envelope.type, ms: Date.now() });
          }
          if (envelope.type === 'task.await_approval') {
            cancellations.push(track(new Promise<void>(resolve => setImmediate(resolve)).then(() =>
              runner.handleEnvelope(createEnvelope('task.reject', { approvalId: envelope.payload.approvalId }, { taskId, seq: 2 })))));
          }
          if (envelope.task_id === taskId && terminalTypes.has(envelope.type)) terminal.resolve(envelope);
        },
        deviceId: 'runtime-contract-device', approvalRegistry: new ApprovalRegistry(),
        blobClient: { async resolveInstruction() { throw new Error('unused'); }, async uploadArtifact() { throw new Error('unused'); } },
        getIngressBudget: testIngressBudget, awaitClaimSettlement: acceptClaimSettlement,
        scratchRoot: testScratchOwner(), getMcpToolsetSnapshot: () => registry.snapshot(), hostTaskContextAvailable: () => true,
        mcpSearch: {
          bin: { command: process.execPath, args: qualifiedLaunch ? [hubBin] : [hubTrace, hubReceipt, hubBin, scenario === 'outer-slow' ? '12000' : '0'] },
          candidates: qualifiedLaunch ? productionCandidates : descriptor => [{ runtimeId: descriptor.id, variant: options.variant, lane: 'ordinary', platform: platform(), arch: arch(),
            helper: 'dist-script', version: mode!.kind === 'available' ? mode!.version! : '',
            executableSource: mode!.kind === 'available' ? mode!.executableSource ?? 'sdk-entry' : 'sdk-entry', receipt: 'current probe',
            ...(options.runtime === 'pi' || options.runtime === 'claude' ? { innerAttempts: true as const } : {}),
          }],
          projectEnvironment: options.projectEnvironment === undefined ? undefined : (_runtime, env) => options.projectEnvironment!(env, box),
        },
        ...(auto ? { toolAuthorization: () => ({ default: 'auto' as const, rules: { alwaysAsk: [{ id: 'probe-deny', match: { mcpServer: 'blocked', mcpTool: exact } }] } }) } : {}),
      });
      // Capture the SDK's real per-Attempt context without substituting its liveness authority.
      const prepare = adapter.prepare.bind(adapter);
      vi.spyOn(adapter, 'prepare').mockImplementation(async input => {
        const args = input.mcpServers?.[MCP_HUB_SERVER_NAME]?.args;
        if (args?.[0] === hubTrace || args?.[0] === hubBin) helperArgs = args;
        const prepared = await prepare(input);
        if (prepared.kind !== 'prepared' || args === undefined || args !== helperArgs) return prepared;
        const start = prepared.operation.start.bind(prepared.operation);
        return { kind: 'prepared', operation: { ...prepared.operation, async start(input) {
          context ??= JSON.parse(await fs.readFile(args.at(-1)!, 'utf8')) as McpHubContext;
          firstNonce ??= hostToolsetToken(context.binding.mcpServers[names[0]!]);
          innerAuthority ??= firstNonce !== undefined && runner.hostToolsetContext(firstNonce)?.status === 'active';
          return start(input);
        } } };
      });
      const control = await startControlServer({ storeDir: box.root, productId,
        methods: createControlMethods({ daemonState: { runner, shuttingDown: false }, adapters: [adapter] } as unknown as DaemonScope) });
      try {
        cancel = () => runner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId, seq: 3 }));
        const requiredToolsets = nativeDenyControl ? ['nativecontrol'] : [...searchSets.map(([id]) => id), ...(paired ? ['direct'] : [])].slice(0, 16);
        const makeOffer = (id: string, sets = requiredToolsets) => createEnvelope('task.offer', {
          ...FRESH_OFFER, agentRef: freshTestAgentRef(), instruction: 'Run the synthetic MCP fixture.',
          target: options.target ?? { lane: 'auto' }, requiredToolsets: sets,
        }, { taskId: id, seq: 1 });
        offeredAt = Date.now();
        if (process.platform === 'darwin' && (scenario === 'mixed' || scenario === 'maximum')) {
          fdSample = setInterval(() => {
            fdPending ??= (async () => {
              const current = (await readReceipt(hubReceipt)).findLast(row => row.method === 'start');
              if (typeof current?.pid !== 'number') return;
              const { stdout } = await spawnProbe('/usr/sbin/lsof', ['-p', String(current.pid), '-Fn'], { timeout: 1000 });
              hubFdPeak = Math.max(hubFdPeak ?? 0, stdout.split('\n').filter(line => /^f\d/.test(line)).length);
            })().catch(() => {}).finally(() => { fdPending = undefined; });
          }, 180);
        }
        await runner.handleEnvelope(makeOffer(taskId));
        let timer: NodeJS.Timeout | undefined;
        const terminalBudgetMs = scenario === 'call-budget' ? 150_000 : 45_000;
        try {
          await Promise.race([terminal.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`No terminal after ${terminalBudgetMs} ms`)), terminalBudgetMs); })]);
        } finally { clearTimeout(timer); }
        elapsedMs = Date.now() - offeredAt;
        await Promise.all([...cancellations, cancelTask, fault]);
        if (context !== undefined) {
          const token = context.contextToken;
          staleNonce = firstNonce === undefined ? 'missing' : runner.hostToolsetContext(firstNonce).status;
          const connection = await connectControlClient({ storeDir: box.root, productId });
          if (!connection.ok) throw new Error(connection.reason);
          try {
            const proof = (contextToken: string) => connection.client.request<boolean>(MCP_HUB_CONTEXT_ACTIVE_METHOD, { contextToken });
            staleActive = await proof(token);
            if (scenario === 'mixed' && helperArgs !== undefined) {
              // Restore only the retired context file. A new task has a fresh
              // Attempt even if its helper is still starting.
              const retired = path.join(box.root, 'retired-context.json');
              const catalogPath = path.join(box.root, 'retired-catalog.json');
              if (frozenCatalog !== undefined) await fs.writeFile(catalogPath, frozenCatalog, { mode: 0o600 });
              await fs.writeFile(retired, JSON.stringify({ ...context, binding: { ...context.binding, catalogPath } }), { mode: 0o600 });
              context = undefined;
              nextTask = true;
              await runner.handleEnvelope(makeOffer('next-task'));
              if (context !== undefined) nextTaskActive = await proof((context as McpHubContext).contextToken);
              const client = new Client({ name: 'retired-contract', version: '1' });
              try {
                await client.connect(new StdioClientTransport({ command: process.execPath, args: [hubBin, retired], stderr: 'pipe' }));
                const rejectedSearch = await client.callTool({ name: HUB_SEARCH_TOOL, arguments: search.args });
                const rejectedCall = await client.callTool({ name: HUB_CALL_TOOL, arguments: first.args });
                staleCall = [rejectedSearch, rejectedCall].every(reply => reply.isError === true);
              } finally { await client.close(); }
              expect(await proof(token)).toBe(false);
            }
          } finally { connection.client.close(); }
        }
      } finally {
        clearInterval(fdSample);
        await fdPending;
        releaseNextTask.resolve();
        try { await runner.shutdownActiveTasks('runtime contract cleanup'); } finally { await control.close(); }
      }
    });
  } catch (cause) { error = String(cause); }
  finally { await provider.close(); }

  const receipts = await Promise.all([...receiptPaths].map(async ([server, file]) => [server, await readReceipt(file)] as const));
  const hub = await readReceipt(hubReceipt);
  const pids = [...new Set([hub, ...receipts.map(([, rows]) => rows)].flatMap(rows => rows
    .flatMap(frame => frame.method === 'start' && typeof frame.pid === 'number' ? [frame.pid] : [])))];
  const liveChildren = new Set<number>();
  let innerPeak = 0;
  const lifecycle = receipts.flatMap(([, rows]) => rows).filter(frame => typeof frame.ms === 'number' && typeof frame.pid === 'number')
    .sort((a, b) => Number(a.ms) - Number(b.ms));
  for (const frame of lifecycle) {
    if (frame.method === 'start') liveChildren.add(Number(frame.pid));
    if (frame.method === 'exit') liveChildren.delete(Number(frame.pid));
    innerPeak = Math.max(innerPeak, liveChildren.size);
  }
  await vi.waitFor(() => expect(pids.filter(isProcessLive)).toEqual([]), { timeout: 3000 }).catch(() => undefined);
  const leaks = pids.filter(isProcessLive);
  const progress = sent.flatMap(envelope => envelope.type === 'task.progress' && envelope.task_id === 'search-contract'
    && 'events' in envelope.payload ? envelope.payload.events : []);
  const toolEvents = progress.flatMap(event => {
    const parsed = AgentEventSchema.safeParse(event);
    return parsed.success && (parsed.data.type === 'tool_use' || parsed.data.type === 'tool_result') ? [parsed.data] : [];
  });
  const completion = sent.find((envelope): envelope is Extract<Envelope, { type: 'task.complete' }> =>
    envelope.task_id === 'search-contract' && envelope.type === 'task.complete');
  const observedSession = sent.find(envelope => envelope.task_id === 'search-contract' && envelope.session_ref !== undefined)?.session_ref
    ?? completion?.payload.sessionRef;
  return {
    runtime: options.runtime, variant: options.variant, detected: mode, platform: platform(), arch: arch(), release: release(),
    observedSession,
    sdk: process.env.BYOK_SEARCH_SDK_COMMIT, lane: 'ordinary', scenario, elapsedMs, offerToFirstModelMs: startedAt === 0 ? undefined : startedAt - offeredAt,
    error, faultError, killed, staleActive, staleNonce, staleCall, nextTaskActive, innerAuthority,
    modelRequests: provider.requests.filter(request => request.model).length,
    tools: [...new Set(provider.requests.flatMap(request => request.tools.map(tool => [tool.namespace, tool.name].filter(Boolean).join('/'))))],
    attempted, providerSteps, nativeFrames, toolEvents, hub, leaks, hubFdPeak, innerPeak,
    terminals: sent.filter(envelope => envelope.task_id === 'search-contract' && terminalTypes.has(envelope.type)).map(({ type, payload }) => ({ type, payload })),
    order: sent.filter(envelope => envelope.task_id === 'search-contract').map(envelope => envelope.type), lifecycleClock,
    servers: Object.fromEntries(receipts.map(([name, rows]) => [name, {
      starts: rows.filter(frame => frame.method === 'start').length,
      lists: rows.filter(frame => frame.method === 'tools/list').length,
      writes: rows.filter(frame => frame.method === 'tools/call' || frame.name !== undefined).map(frame => frame.params ?? frame),
      cwd: rows.find(frame => frame.method === 'start')?.cwd,
      launchContext: rows.filter(frame => frame.method === 'start').map(frame => ({
        cwd: frame.cwd, envKeys: Object.keys((frame.env ?? {}) as object).sort(),
      })),
      firstWriteAtMs: rows.find(frame => frame.method === 'tools/call')?.ms,
    }])),
  };
}

function assertPiReceipt(result: Awaited<ReturnType<typeof probe>>): void {
  expect(result.error).toBeUndefined();
  const scenario = result.scenario;
  const terminal = result.terminals[0];
  if (scenario === 'collision-exact') {
    expect(result.order).toEqual(['task.decline']);
    expect(terminal?.payload).toMatchObject({ reason: expect.stringContaining('conflicts with the search hub name') });
    return;
  }
  expect(result.order.slice(0, 2)).toEqual(['task.claim', 'task.started']);
  expect(terminal?.type).toBe(scenario === 'cancel' ? 'task.cancelled' : 'task.complete');
  expect(result.staleNonce).toMatch(/^(revoked|unknown)$/);
  expect(result.staleActive).toBe(false);
  expect(result.innerAuthority).toBe(true);
  const summaries = (server: string) => result.servers[server]?.writes.map(call => (call as { arguments?: { summary?: string } }).arguments?.summary);
  const failedResults = result.toolEvents.filter(event => event.type === 'tool_result' && event.isError === true);
  const starts = result.hub.filter(frame => frame.method === 'start');
  const hubCalls = result.hub.filter(frame => frame.method === 'tools/call');
  const replies = result.hub.filter(frame => frame.method === 'reply' && frame.request === 'tools/call');
  const lastReply = replies.at(-1);
  switch (scenario) {
    case 'mixed':
    case 'qualified-launch':
    case 'all':
    case 'name-boundary':
    case 'collision-dash':
    case 'collision-underscore': {
      expect(result.attempted).toHaveLength(['mixed', 'qualified-launch', 'all'].includes(scenario) ? 7 : 8);
      expect(summaries('alpha')).toEqual(['first', 'long-name']);
      expect(summaries('beta')).toEqual(['second']);
      expect(summaries('blocked')).toEqual(scenario === 'all' ? ['denied'] : []);
      expect(summaries('native')).toEqual(['direct']);
      expect(failedResults).toHaveLength(scenario === 'all' ? 1 : 2);
      const attempts = result.toolEvents.filter(event => event.type === 'tool_use');
      const variantServer = { 'name-boundary': longServer, 'collision-dash': 'byok-tools', 'collision-underscore': 'byok_tools' }[scenario as 'name-boundary' | 'collision-dash' | 'collision-underscore'];
      expect(attempts.map(event => event.mcp?.server)).toEqual([
        'byoktools', 'alpha', 'beta', 'alpha', 'blocked', 'byoktools', 'native',
        ...(variantServer === undefined ? [] : [variantServer]),
      ]);
      if (scenario === 'mixed') {
        expect(result.staleCall).toBe(true);
        expect(result.nextTaskActive).toBe(true);
      } else if (variantServer !== undefined) {
        expect(summaries(variantServer)).toEqual([scenario === 'name-boundary' ? 'long-native' : 'collision-control']);
      }
      break;
    }
    case 'parallel': {
      expect(summaries('alpha')).toEqual(['first']);
      expect(summaries('beta')).toEqual(['parallel-second']);
      const uses = result.toolEvents.filter(event => event.type === 'tool_use' && event.mcp?.server !== 'byoktools');
      expect(uses.map(event => event.mcp?.server)).toEqual(['alpha', 'beta']);
      expect(new Set(uses.map(event => event.toolCallId)).size).toBe(2);
      expect(Number(hubCalls[2]?.ms)).toBeLessThan(Number(replies[1]?.ms));
      break;
    }
    case 'hub-idle':
    case 'hub-in-flight':
      expect(result.killed).toBe(true);
      expect(starts).toHaveLength(1);
      expect(summaries('alpha')).toEqual(['first']);
      expect(failedResults).toHaveLength(scenario === 'hub-idle' ? 1 : 2);
      break;
    case 'inner-idle':
    case 'inner-in-flight':
      expect(result.killed).toBe(true);
      expect(summaries('alpha')).toEqual(['first', 'explicit-next']);
      if (scenario === 'inner-in-flight') expect(failedResults).toHaveLength(1);
      break;
    case 'drift':
      expect(result.killed).toBe(true);
      expect(summaries('alpha')).toEqual(['first']);
      expect(JSON.stringify(lastReply)).toContain('changed since search');
      expect(failedResults).toHaveLength(1);
      break;
    case 'outer-slow':
      expect(hubCalls).toHaveLength(0);
      expect(failedResults).toHaveLength(1);
      break;
    case 'slow-below':
      expect(summaries('alpha')).toEqual(['first']);
      expect(failedResults).toHaveLength(0);
      break;
    case 'slow-above':
      expect(JSON.stringify(lastReply)).toContain('exceeded its 10-second budget');
      expect(failedResults).toHaveLength(1);
      break;
    case 'call-budget':
      expect(summaries('alpha')).toEqual(['first']);
      const cancelled = result.hub.find(frame => frame.method === 'notifications/cancelled');
      expect(Number(cancelled?.ms) - Number(hubCalls.at(-1)?.ms)).toBeGreaterThan(115_000);
      expect(failedResults).toHaveLength(1);
      expect(JSON.stringify(failedResults[0])).toContain('Request timed out');
      break;
    case 'maximum':
      expect(Object.keys(result.servers).filter(server => server !== 'native' && result.servers[server]!.lists > 0)).toHaveLength(256);
      expect(summaries('s000')).toEqual(['first']);
      expect(result.innerPeak).toBeLessThanOrEqual(8);
      break;
    case 'cancel':
      expect(summaries('alpha')).toEqual([]);
      expect(hubCalls).toHaveLength(1);
      expect(replies).toHaveLength(0);
      break;
  }
}

function assertDshReceipt(result: Awaited<ReturnType<typeof probe>>): void {
  expect(result.error).toBeUndefined();
  expect(result.detected).toMatchObject({ kind: 'available', version: '0.2.2-rc.1', executableSource: 'env' });
  if (result.scenario === 'collision-exact') {
    expect(result.order).toEqual(['task.decline']);
    expect(result.terminals[0]?.payload).toMatchObject({ reason: expect.stringContaining('conflicts with the search hub name') });
    expect(result.attempted).toHaveLength(0);
    return;
  }
  expect(result.order.slice(0, 2)).toEqual(['task.claim', 'task.started']);
  expect(result.terminals[0]?.type).toBe(result.scenario === 'cancel' ? 'task.cancelled' : 'task.complete');
  expect(result.staleActive).toBe(false);
  expect(result.staleNonce).toMatch(/^(revoked|unknown)$/);
  const calls = (server: string) => result.servers[server]?.writes.length ?? 0;
  const resultErrors = result.toolEvents.filter(event => event.type === 'tool_result' && event.isError === true);
  const outer = result.toolEvents.filter(event => event.tool.startsWith('mcp__byoktools__'));
  expect(outer.every(event => event.mcp === undefined && Boolean(event.toolCallId))).toBe(true);
  switch (result.scenario) {
    case 'mixed':
    case 'qualified-launch':
    case 'all':
    case 'name-boundary':
    case 'collision-dash':
    case 'collision-underscore': {
      expect([calls('alpha'), calls('beta'), calls('blocked'), calls('native')]).toEqual([2, 1, 1, 1]);
      expect(resultErrors).toHaveLength(1);
      const firstCall = outer.find(event => event.tool.endsWith('__call_tool') && event.type === 'tool_use');
      expect(firstCall?.type === 'tool_use' ? firstCall.input : undefined)
        .toEqual({ server: 'alpha', tool: exact, arguments: { summary: 'first' } });
      if (result.scenario === 'mixed') {
        expect(result.staleCall).toBe(true);
        expect(result.nextTaskActive).toBe(true);
      } else if (result.scenario === 'name-boundary') {
        expect(calls(longServer.slice(0, 32))).toBe(1);
      } else if (result.scenario === 'collision-dash' || result.scenario === 'collision-underscore') {
        expect(calls(result.scenario === 'collision-dash' ? 'byok-tools' : 'byok_tools')).toBe(1);
      }
      break;
    }
    case 'parallel':
      expect([calls('alpha'), calls('beta')]).toEqual([1, 1]);
      expect(result.providerSteps.some(step => step.kind === 'tool' && step.parallel?.length === 1)).toBe(true);
      break;
    case 'hub-idle':
    case 'hub-in-flight':
      expect(result.killed).toBe(true);
      expect(result.attempted).toHaveLength(3);
      expect(calls('alpha')).toBe(1);
      expect(resultErrors).toHaveLength(result.scenario === 'hub-idle' ? 1 : 2);
      break;
    case 'inner-idle':
    case 'inner-in-flight':
      expect(result.killed).toBe(true);
      expect(calls('alpha')).toBe(2);
      expect(resultErrors).toHaveLength(result.scenario === 'inner-idle' ? 0 : 1);
      break;
    case 'drift':
      expect(result.killed).toBe(true);
      expect(calls('alpha')).toBe(1);
      expect(JSON.stringify(resultErrors)).toContain('changed since search');
      break;
    case 'outer-slow':
      expect(result.attempted).toHaveLength(1);
      expect(resultErrors).toHaveLength(0);
      expect(JSON.stringify(outer)).toContain('submit_result');
      break;
    case 'slow-below':
      expect(calls('alpha')).toBe(1);
      expect(resultErrors).toHaveLength(0);
      break;
    case 'slow-above':
      expect(JSON.stringify(resultErrors)).toContain('exceeded its 10-second budget');
      break;
    case 'call-budget': {
      expect(calls('alpha')).toBe(1);
      const dispatch = result.hub.findLast(frame => frame.method === 'tools/call');
      const cancel = result.hub.find(frame => frame.method === 'notifications/cancelled');
      const elapsed = Number(cancel?.ms) - Number(dispatch?.ms);
      expect(elapsed).toBeGreaterThan(55_000);
      expect(elapsed).toBeLessThan(90_000);
      expect(JSON.stringify(resultErrors)).toContain('Request timed out');
      break;
    }
    case 'maximum':
      expect(Object.values(result.servers).filter(server => server.lists > 0)).toHaveLength(256);
      expect(calls('s000')).toBe(1);
      expect(result.innerPeak).toBeLessThanOrEqual(8);
      break;
    case 'cancel':
      expect(result.attempted).toHaveLength(1);
      expect(calls('alpha')).toBe(0);
      expect(outer.some(event => event.type === 'tool_result')).toBe(false);
      break;
  }
}

function assessReceipt(runtime: ContractRuntime, result: Awaited<ReturnType<typeof probe>>) {
  if (runtime !== 'pi' && runtime !== 'dsh') return { status: 'observation' as const };
  try {
    if (result.scenario === 'qualified-launch' && result.order[0] === 'task.decline') {
      expect(result.order).toEqual(['task.decline']);
      expect(result.terminals[0]?.payload).toMatchObject({ reason: expect.stringContaining('MCP search exposure is unavailable') });
      expect(result.attempted).toHaveLength(0);
      return { status: 'closed' as const };
    }
    if (runtime === 'pi') assertPiReceipt(result);
    else assertDshReceipt(result);
    return { status: 'pass' as const };
  } catch (error) {
    return { status: 'fail' as const, reason: String(error) };
  }
}

export function defineMcpSearchProbes(options: ProbeOptions): void {
  if (outputDir === undefined || contractMode() !== 'qualified') return;
  const requested = process.env.BYOK_SEARCH_SCENARIOS;
  const selected = requested === '*' ? scenarios : requested?.split(',') ?? ['mixed'];
  if (selected.some(entry => !scenarios.includes(entry as Scenario))) throw new Error(`Unknown MCP search scenario: ${selected.join(', ')}`);
  describe(`${options.runtime} MCP search qualification`, () => {
    for (const scenario of scenarios.filter(entry => selected.includes(entry)
      && (entry !== 'qualified-launch' || options.runtime === 'pi' || options.runtime === 'dsh')
      && (!entry.startsWith('native-deny') || options.runtime.startsWith('opencode')))) {
      it(scenario, async () => {
        const result = await probe(options, scenario);
        const acceptance = assessReceipt(options.runtime, result);
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(path.join(outputDir, `${options.runtime}-${scenario}.json`), `${JSON.stringify({ ...result, acceptance }, null, 2)}\n`);
        // A closed runtime can supply a negative observation. These invariants
        // apply even if it registered no hub tools or aborted the turn.
        expect(result.leaks).toEqual([]);
        expect(result.staleActive).not.toBe(true);
        expect(result.staleCall).not.toBe(false);
        expect(result.servers.outside?.writes ?? []).toEqual([]);
        expect(result.servers.outside?.starts ?? 0).toBe(0);
        expect(result.faultError).toBeUndefined();
        expect(result.toolEvents.filter(event => event.type === 'tool_result' && event.mcp !== undefined
          && ['alpha', 'beta', 'blocked'].includes(event.mcp.server))).toEqual([]);
        const writes = Object.values(result.servers).flatMap(server => server.writes.map(frame => JSON.stringify(frame)));
        expect(new Set(writes).size).toBe(writes.length);
        if (process.env.BYOK_SEARCH_REQUIRE_PASS === '1') expect(acceptance).toEqual({ status: 'pass' });
      }, scenario === 'call-budget' ? 180_000 : 120_000);
    }
  });
}
