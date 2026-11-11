// The packaged-app smoke Host (#1811, after the #1803 D0 probe): built as a SEA
// with the app's own recipe and run from inside the packaged resources/host/, so
// Pi, the Agent memory helper and (on Windows) koffi all load from the shipped
// asset root. Two Pi dispatches against an OpenAI-compatible endpoint inside this
// process, no provider key and no OS credential store:
//
// 1. Keys launcher lane (dispatchSelection pinned): the model calls memory_recall,
//    then replies. Under a BYOK keys profile Pi registers no subagent tool.
// 2. Pi auth store lane (no dispatchSelection, PI_CODING_AGENT_DIR passed): the
//    model asks for a background subagent, which the SEA refuses with
//    pi_background_unavailable (#1499 R2); the task still completes.
//
// The last stdout line is `BYOK_DESKTOP_SMOKE <json>`; ok needs both tasks
// complete with the reply, the memory_recall result and the refusal.
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createByokServer, listenLoopback } from '@byok-sdk/server';
import { bundledSdkHelperHost, createDaemon, runSdkReservedHelperCommand, sdkPackagingAssetLayout } from '@byok-sdk/client';
import { InMemorySecretStore, parseModelProviderProfile, parsePiProviderLauncherOptions, runPiProviderLauncher, SqliteProviderProfileStore } from '@byok-sdk/keys';
import { InMemoryDeviceCredentialStore } from '../../../../scripts/testing/device-credentials.mjs';

const MARKER = 'BYOK_DESKTOP_SMOKE';
const PRODUCT_ID = 'byok-desktop-smoke';
const LAUNCHER_COMMAND = 'pi-provider-launcher';
const MODEL = 'smoke-model';
const MODEL_REPLY = 'desktop package smoke reply';
const AGENT = { agentId: 'smoke-agent', profileRevision: '1' } as const;
const EGRESS_POLICY = {
  policyRevision: 'default-v1',
  activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 256 * 1024 },
  reliable: { maxPendingEventsPerAgent: 256, maxPendingBytesPerAgent: 4 * 1024 * 1024, maxPendingBytesPerTenant: 16 * 1024 * 1024 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
} as const;

interface ChatRequest {
  readonly tools?: readonly { readonly function?: { readonly name?: string } }[];
  readonly messages?: readonly { readonly role?: string; readonly content?: unknown }[];
}

const text = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? '').join('') : JSON.stringify(content);

/**
 * A request that carries a tool result gets the reply. Otherwise the first tool
 * the D0 probe exercised wins: subagent (async, refused in a SEA), then memory_recall.
 */
function fakeModel(log: { requests: string[]; offeredTools: string[][]; toolResults: string[] }): Server {
  return createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      log.requests.push(`${request.method} ${request.url}`);
      const chat = JSON.parse(body) as ChatRequest;
      const tools = (chat.tools ?? []).map(tool => tool.function?.name ?? '');
      log.offeredTools.push(tools);
      const results = (chat.messages ?? []).filter(message => message.role === 'tool').map(message => text(message.content));
      const call = results.length ? undefined
        : tools.includes('subagent') ? { name: 'subagent', arguments: { agent: 'worker', task: 'reply once', async: true, context: 'fresh' } }
          : tools.includes('memory_recall') ? { name: 'memory_recall', arguments: { path: 'MEMORY.md' } } : undefined;
      log.toolResults.push(...results);
      const base = { id: 'smoke', object: 'chat.completion.chunk', created: 0, model: MODEL };
      const chunks = call
        ? [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${log.requests.length}`, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]
        : [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: MODEL_REPLY }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
}

async function until<T>(read: () => T | undefined | Promise<T | undefined>, what: string, ms = 120_000): Promise<T> {
  for (const deadline = Date.now() + ms; ;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function smoke(): Promise<void> {
  const helperHost = bundledSdkHelperHost();
  const assets = path.dirname(helperHost.entry ?? helperHost.executable);
  const native = process.platform === 'darwin' || process.platform === 'win32';
  const root = await realpath(await mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'byok-desk-')));
  const log = { requests: [] as string[], offeredTools: [] as string[][], toolResults: [] as string[] };
  const model = fakeModel(log);
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
  // The Pi auth store lane: Pi's own models.json and settings name the endpoint.
  const agentDir = path.join(root, 'pi-agent');
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { smoke: { api: 'openai-completions', baseUrl, apiKey: 'synthetic-loopback-only',
    models: [{ id: MODEL, name: 'Smoke model', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] } } }));
  await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'smoke', defaultModel: MODEL, retry: { enabled: false } }));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const byok = createByokServer({ productId: PRODUCT_ID, storage: { kind: 'sqlite', path: path.join(root, 'server.sqlite') } });
  let port: number | null = null;
  const listener = await listenLoopback({ portStore: { read: async () => port, claim: async candidate => (port ??= candidate) },
    createHandler: () => request => byok.hono.fetch(request) });
  const profileDbPath = path.join(root, 'providers.sqlite');
  const profiles = new SqliteProviderProfileStore({ path: profileDbPath });
  const now = new Date().toISOString();
  await profiles.save(parseModelProviderProfile({
    adapter: 'openai_compatible', auth_mode: 'none', base_url: baseUrl, capabilities: [],
    created_at: now, updated_at: now, display_name: 'Desktop smoke', enabled: true, kind: 'model', model: MODEL,
    profile_ref: 'smoke', provider_kind: 'custom',
    pi_model: { contextWindow: 8192, maxTokens: 1024, reasoning: false, thinkingLevel: 'off',
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsUsageInStreaming: true, maxTokensField: 'max_tokens' } },
  }));
  await profiles.close();
  const daemon = createDaemon({
    localAgentRelease: { version: '0.0.0-desktop-smoke' }, productName: 'BYOK Desktop Smoke', productId: PRODUCT_ID, serverUrl: listener.serverUrl,
    storeDir: path.join(root, 'store'), storage: { scratchRoot: path.join(root, 'scratch') },
    agentHome: { hostStorageRoot: path.join(root, 'home') }, agentEgress: { policy: EGRESS_POLICY },
    runtimeAllowlist: ['pi'], sdkHelperHost: helperHost,
    runtimes: { pi: { packageDir: path.join(assets, sdkPackagingAssetLayout.pi), runtimeEnvironment: { pass: ['PI_CODING_AGENT_DIR'] } } },
    ...(process.platform === 'win32' ? { nativeAssetRoot: path.join(assets, sdkPackagingAssetLayout.native) } : {}),
    ...(native ? { agentMemoryHelperAssetRoot: path.join(assets, sdkPackagingAssetLayout.agentMemoryHelper) } : {}),
    piByokLauncher: { command: helperHost.executable, args: [...(helperHost.entry === undefined ? [] : [helperHost.entry]), LAUNCHER_COMMAND],
      profileDbPath, sessionDir: path.join(root, 'sessions') },
  }, { deviceCredentials: new InMemoryDeviceCredentialStore() });
  try {
    const { code } = await byok.pairing.createPairingCode({ productId: PRODUCT_ID });
    const { deviceId } = await daemon.pair(code);
    await daemon.start();
    await until(() => {
      const lifecycle = daemon.status().lifecycle;
      return lifecycle.phase === 'running' && lifecycle.connection === 'open' ? true : undefined;
    }, 'daemon connection');
    const run = async (dispatch: object) => {
      const { taskId } = await byok.executions.submit({
        taskId: randomUUID(), deviceId,
        payload: { instruction: 'reply once', runtime: 'pi', session: { mode: 'fresh' }, agentRef: AGENT, egressPolicy: EGRESS_POLICY,
          terminalProjection: { mode: 'none' }, ...dispatch },
      });
      const task = await until(async () => {
        const snapshot = await byok.tasks.get(taskId);
        return snapshot && ['Complete', 'Failed', 'Cancelled'].includes(snapshot.state) ? snapshot : undefined;
      }, 'task terminal state');
      const reply = task.result && 'finalMessage' in task.result ? task.result.finalMessage : undefined;
      return task.state === 'Complete' ? { state: task.state, reply } : { state: task.state, result: task.result };
    };
    const keys = await run({ dispatchSelection: { lane: 'byok', runtimeId: 'pi', providerId: 'smoke', modelId: MODEL } });
    const piAuth = await run({});
    const memory = log.toolResults.some(result => result.includes('"revision"'));
    const refused = log.toolResults.some(result => result.includes('pi_background_unavailable'));
    const ok = [keys, piAuth].every(task => task.state === 'Complete' && task.reply === MODEL_REPLY) && memory && refused;
    console.log(`${MARKER} ${JSON.stringify({ ok, keys, piAuth, memory, refused, agentMemoryMcp: daemon.status().agentMemoryMcp,
      helperHost: helperHost.entry === undefined ? 'executable' : 'node-entry', execPath: process.execPath,
      modelRequests: log.requests.length, offeredTools: log.offeredTools, toolResults: log.toolResults })}`);
    if (!ok) process.exitCode = 1;
  } finally {
    await daemon.stop();
    await listener.close();
    await byok.close();
    model.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (await runSdkReservedHelperCommand()) return;
  const args = process.argv.slice(2);
  if (args[0] === LAUNCHER_COMMAND) {
    process.exitCode = await runPiProviderLauncher(parsePiProviderLauncherOptions(args.slice(1)), { createSecretStore: () => new InMemorySecretStore() });
    return;
  }
  if (args.length === 0) return smoke();
  throw new Error(`unknown command ${JSON.stringify(args[0])}`);
}

main().catch((error: unknown) => {
  console.log(`${MARKER} ${JSON.stringify({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) })}`);
  // A failed smoke may leave listeners open; the report is already written.
  process.exit(1);
});
