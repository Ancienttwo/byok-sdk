import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../src/adapters/codex/codex-adapter.ts';
import { createCodexMcpHubCallPolicy } from '../src/adapters/codex/hub-tool-grants.ts';
import { createExecutionScratch } from '../src/daemon/retention/scratch.ts';
import { HUB_CALL_TOOL, HUB_SEARCH_TOOL, MCP_HUB_SERVER_NAME, serveMcpHub } from '../src/mcp/hub/index.ts';
import { sealRuntimeOperationManifest } from '../src/types.ts';
import { CONTRACT_REPLY_CHUNKS, mcpTool, startLoopbackProvider } from '../src/__tests__/runtime-contract/loopback.ts';

const fixture = fileURLToPath(new URL('../src/__tests__/fixtures/mcp-hub-inner.mjs', import.meta.url));
const tool = 'record_note';
const targets = ['alpha', 'beta'];
const approvals = { alpha: [tool] };
const hints = {
  absent: undefined,
  readOnly: { readOnlyHint: true },
  destructive: { readOnlyHint: false, destructiveHint: true },
};

// This arm is only launched by the isolated loopback probe. Its synthetic
// liveness proof and transport grant cannot qualify a daemon-installed hub.
if (import.meta.main && process.argv[2] === '--stdio-fixture') {
  try {
    const { binding, approvals } = JSON.parse(await readFile(process.argv[3], 'utf8'));
    serveMcpHub({ binding, isActive: () => true, authorizeCall: createCodexMcpHubCallPolicy(binding, approvals) });
  } catch (cause) {
    throw new Error('Could not start the loopback hub fixture', { cause });
  }
}

async function receipts(path) {
  const raw = await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  try {
    return raw.split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(frame => frame.method === 'tools/call').map(frame => frame.params);
  } catch (cause) {
    throw new Error(`Invalid MCP receipt in ${path}`, { cause });
  }
}

function toolEvents(events, server, tool) {
  return events.filter(event => event.mcp?.server === server && event.mcp.tool === tool);
}

async function runPair({ root, command, arm, annotations, interactive, cases }) {
  const id = `${arm}-${annotations}-${interactive ? 'interactive' : 'headless'}`;
  const dir = join(root, id);
  const workspace = join(dir, 'workspace');
  const codexHome = join(dir, 'codex');
  const home = join(dir, 'home');
  await Promise.all([workspace, codexHome, home].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  // detect() also resolves this throwaway home. The operation uses the same env.
  Object.assign(process.env, { HOME: home, CODEX_HOME: codexHome });
  const env = { ...process.env };
  const interactionRequests = [];
  const adapter = new CodexAdapter({
    resolveBin: () => ({ command, source: 'path' }), sandbox: 'inherit', agentUserMcpServers: 'excluded', operationTimeoutMs: 20_000,
    ...(interactive ? { nativeInteractions: { timeoutMs: 1000, onRequest: request => interactionRequests.push(request.kind) } } : {}),
  });
  let sessionRef;
  for (const phase of ['start', 'resume']) {
    const turnId = `${id}-${phase}`;
    const steps = [
      ...(arm === 'hub' ? [{ server: MCP_HUB_SERVER_NAME, tool: HUB_SEARCH_TOOL, args: { query: 'record note' } }] : []),
      ...targets.map(server => {
        const args = { text: `${turnId}-${server}` };
        return arm === 'hub' ? { server: MCP_HUB_SERVER_NAME, tool: HUB_CALL_TOOL, args: { server, tool, arguments: args } }
          : { server, tool, args };
      }),
    ];
    const sent = [];
    const providerErrors = [];
    let directNamespace;
    const provider = await startLoopbackProvider('openai-responses', request => {
      const step = steps[sent.length];
      if (step === undefined) return { kind: 'text', chunks: CONTRACT_REPLY_CHUNKS };
      let selected = mcpTool(step.server, step.tool)(request.tools);
      if (arm === 'native' && step.server === 'alpha') directNamespace = selected?.namespace;
      if (arm === 'native' && step.server === 'beta') {
        if (selected !== undefined) providerErrors.push('Codex advertised the ungranted beta tool');
        // Send a synthetic call even though beta was absent from the model's tool catalog.
        selected ??= directNamespace === undefined ? { name: `mcp__beta__${tool}` } : { name: tool, namespace: 'mcp__beta' };
      }
      if (selected === undefined || request.toolResults < sent.length) {
        providerErrors.push(`Missing ${step.server}/${step.tool} or preceding result at step ${sent.length + 1}`);
        return { kind: 'text', chunks: CONTRACT_REPLY_CHUNKS };
      }
      sent.push(step);
      return { kind: 'tool', tool: selected, args: step.args };
    }, 'contract-model');
    let scratch;
    let session;
    let timer;
    const events = [];
    const before = interactionRequests.length;
    try {
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: env.OPENAI_API_KEY, tokens: null, last_refresh: null }), { mode: 0o600 });
      await writeFile(join(codexHome, 'config.toml'), [
        'cli_auth_credentials_store = "file"', 'model = "contract-model"', 'model_provider = "contract"',
        '[features]', 'plugins = false', 'memories = false', '[model_providers.contract]', 'name = "contract"',
        `base_url = ${JSON.stringify(provider.baseUrl)}`, 'wire_api = "responses"', 'env_key = "OPENAI_API_KEY"', 'supports_websockets = false', '',
      ].join('\n'), { mode: 0o600 });
      const receiptPaths = Object.fromEntries(targets.map(server => [server, join(dir, `${phase}-${server}.jsonl`)]));
      const config = join(dir, `${phase}-inner.json`);
      await writeFile(config, JSON.stringify({ pages: [[{
        name: tool, description: 'Record a synthetic note', annotations: hints[annotations],
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      }]] }));
      const innerServers = Object.fromEntries(targets.map(server => [server, {
        command: process.execPath, args: [fixture, config, receiptPaths[server]],
      }]));
      let mcpServers = innerServers;
      let mcpToolApprovals = approvals;
      if (arm === 'hub') {
        const binding = { catalogPath: join(dir, `${phase}-catalog.json`), attemptId: turnId, launchCwd: workspace, mcpEnv: {}, mcpServers: innerServers };
        const context = join(dir, `${phase}-context.json`);
        await writeFile(context, JSON.stringify({ binding, approvals }), { mode: 0o600 });
        mcpServers = { [MCP_HUB_SERVER_NAME]: { command: process.execPath, args: [import.meta.path, '--stdio-fixture', context] } };
        mcpToolApprovals = { [MCP_HUB_SERVER_NAME]: [HUB_SEARCH_TOOL, HUB_CALL_TOOL] };
      }
      const instruction = `Follow the synthetic contract ${turnId}.`;
      const offer = { target: { lane: 'harness', harnessId: 'codex', selection: { mode: 'device-default' } }, instruction, sessionRef };
      const prepared = await adapter.prepare({ offer, descriptor: adapter.descriptor, requiredToolsetIds: [], mcpServers });
      if (prepared.kind !== 'prepared') throw new Error(`Codex refused preparation: ${prepared.reason}`);
      scratch = await createExecutionScratch({ root: join(dir, 'scratch') });
      const manifest = sealRuntimeOperationManifest({ taskId: turnId, runtimeId: adapter.descriptor.id, descriptor: adapter.descriptor,
        sessionRef, requiredToolsetIds: [], agentRef: { agentId: id, profileRevision: 'r1' }, cwd: workspace,
        lease: { leaseId: turnId, canonicalHome: workspace }, workspace: { workspaceDir: workspace }, forwardedEnvironmentNames: Object.keys(env).sort(),
      });
      session = await prepared.operation.start({ scratch, kind: 'instruction', instruction, env, manifest, mcpServers, mcpToolApprovals });
      if (sessionRef !== undefined && session.sessionRef !== sessionRef) throw new Error('Codex resumed a different thread');
      sessionRef = session.sessionRef;
      await Promise.race([
        (async () => { for await (const event of session.events) { events.push(event); if (event.type === 'turn_end') return; } throw new Error('Codex ended without turn_end'); })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('loopback turn exceeded 30 seconds')), 30_000); }),
      ]);
      const mcpEvents = events.filter(event => event.mcp !== undefined);
      const search = toolEvents(mcpEvents, MCP_HUB_SERVER_NAME, HUB_SEARCH_TOOL);
      const searchResult = search.find(event => event.type === 'tool_result')?.output;
      const searched = arm !== 'hub' || (search.length === 2 && targets.every(server => JSON.stringify(searchResult ?? '').includes(server)));
      const calls = await Promise.all(targets.map(async (server) => {
        const source = arm === 'hub' ? toolEvents(mcpEvents, MCP_HUB_SERVER_NAME, HUB_CALL_TOOL) : toolEvents(mcpEvents, server, tool);
        const uses = source.filter(event => event.type === 'tool_use' && (arm !== 'hub' || event.input?.server === server));
        const result = uses.length === 1 ? source.find(event => event.type === 'tool_result' && event.toolCallId === uses[0].toolCallId) : undefined;
        const received = await receipts(receiptPaths[server]);
        const wireInput = uses[0]?.input;
        const args = arm === 'hub' ? wireInput?.arguments : wireInput;
        const complete = received.length === (server === 'alpha' ? 1 : 0)
          && received.every(call => call.name === tool && call.arguments?.text === `${turnId}-${server}`)
          && (arm === 'native' && server === 'beta' || (
            uses.length === 1 && result !== undefined && args?.text === `${turnId}-${server}`
          ));
        return { server, tool, granted: server === 'alpha', attempts: uses.length, callId: uses[0]?.toolCallId,
          wireInput, output: result?.output, receipts: received, complete };
      }));
      cases.push({ annotations, interactive, phase, arm, sessionRef, interactionRequests: interactionRequests.slice(before), searched,
        providerRequests: provider.requests.filter(request => request.model).length, providerErrors, calls,
        complete: sent.length === steps.length && providerErrors.length === 0 && searched && calls.every(call => call.complete),
      });
    } finally {
      clearTimeout(timer);
      try { await session?.close(); } finally {
        try { await scratch?.release(); } finally { await provider.close(); }
      }
    }
  }
}

export async function compareCodexMcpHub({ root, command }) {
  const cases = [];
  const errors = [];
  for (const annotations of Object.keys(hints)) {
    for (const interactive of [false, true]) {
      for (const arm of ['native', 'hub']) {
        try { await runPair({ root, command, arm, annotations, interactive, cases }); }
        catch (error) { errors.push({ arm, annotations, interactive, error: String(error) }); }
      }
    }
  }
  const complete = errors.length === 0 && cases.length === 24 && cases.every(row => row.complete);
  const executionDifferences = cases.filter(row => row.arm === 'native').flatMap(native => {
    const hub = cases.find(row => row.arm === 'hub' && row.annotations === native.annotations && row.interactive === native.interactive && row.phase === native.phase);
    if (hub === undefined) return [];
    return native.calls.flatMap((call, index) => call.receipts.length === hub.calls[index].receipts.length ? [] : [{
      phase: native.phase, annotations: native.annotations, interactive: native.interactive, server: call.server,
      nativeReceipts: call.receipts.length, hubReceipts: hub.calls[index].receipts.length,
    }]);
  });
  return { status: complete ? 'comparison-complete' : 'comparison-incomplete', cases, errors, executionDifferences };
}
