// #1104: the embedded Host (server + daemon + Pi adapter in one process) that the
// packaging consistency lane bundles as single-file ESM, single-file CJS and a
// Node SEA, relocates next to only the manifest's files, and runs.
//
// One executable, three roles, decided by argv before anything else runs:
//   __byok_sdk_helper <kind>  the SDK-reserved helpers (Pi host lanes, MCP helpers)
//   pi-provider-launcher ...  the keys custody launcher, re-entered as the Host's own command
//   host                      pair, start, dispatch one Pi task to an offline model, report
//
// The SDK assets ship beside the bundle or executable, as copySdkPackagingAssets
// writes them. The model is an OpenAI-compatible endpoint inside this process.
// The provider profile has auth_mode 'none', so no OS credential store is read.
import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createByokServer, listenLoopback } from '@byok-sdk/server';
import { bundledSdkHelperHost, createDaemon, runSdkReservedHelperCommand, sdkPackagingAssetLayout } from '@byok-sdk/client';
import { InMemorySecretStore, parseModelProviderProfile, parsePiProviderLauncherOptions, runPiProviderLauncher, SqliteProviderProfileStore } from '@byok-sdk/keys';
import { InMemoryDeviceCredentialStore } from '../../scripts/testing/device-credentials.mjs';

const MARKER = 'BYOK_EMBEDDED_HOST';
const PRODUCT_ID = 'byok-packaging-embedded';
const LAUNCHER_COMMAND = 'pi-provider-launcher';
const MODEL_REPLY = 'embedded host packaging reply';
const AGENT = { agentId: 'packaging-agent', profileRevision: '1' } as const;
const EGRESS_POLICY = {
  policyRevision: 'default-v1',
  activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 256 * 1024 },
  reliable: { maxPendingEventsPerAgent: 256, maxPendingBytesPerAgent: 4 * 1024 * 1024, maxPendingBytesPerTenant: 16 * 1024 * 1024 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
} as const;

/** One streamed chat completion: the reply text, then stop. */
function fakeModel(requests: string[]): Server {
  return createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push(`${request.method} ${request.url}`);
      const base = { id: 'packaging', object: 'chat.completion.chunk', created: 0, model: 'packaging-model' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: MODEL_REPLY }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
      ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
  });
}

async function until<T>(read: () => T | undefined | Promise<T | undefined>, what: string, ms = 60_000): Promise<T> {
  for (const deadline = Date.now() + ms; ;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** The product's asset root: the directory of the bundle, or of the SEA executable. */
function assetRoot(): string {
  const helperHost = bundledSdkHelperHost();
  return path.dirname(helperHost.entry ?? helperHost.executable);
}

async function host(): Promise<void> {
  const assets = assetRoot();
  const native = process.platform === 'darwin' || process.platform === 'win32';
  const root = await realpath(await mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'byok-emb-')));
  const requests: string[] = [];
  const model = fakeModel(requests);
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const modelPort = (model.address() as { port: number }).port;
  const byok = createByokServer({ productId: PRODUCT_ID, storage: { kind: 'sqlite', path: path.join(root, 'server.sqlite') } });
  // One run, one identity: the port store lives in memory.
  let port: number | null = null;
  const listener = await listenLoopback({ portStore: { read: async () => port, claim: async candidate => (port ??= candidate) },
    createHandler: () => request => byok.hono.fetch(request) });
  const serverUrl = listener.serverUrl;
  const profileDbPath = path.join(root, 'providers.sqlite');
  const profiles = new SqliteProviderProfileStore({ path: profileDbPath });
  const now = new Date().toISOString();
  await profiles.save(parseModelProviderProfile({
    adapter: 'openai_compatible', auth_mode: 'none', base_url: `http://127.0.0.1:${modelPort}/v1`, capabilities: [],
    created_at: now, updated_at: now, display_name: 'Packaging fixture', enabled: true, kind: 'model', model: 'packaging-model',
    profile_ref: 'packaging', provider_kind: 'custom',
    pi_model: { contextWindow: 8192, maxTokens: 1024, reasoning: false, thinkingLevel: 'off',
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsUsageInStreaming: true, maxTokensField: 'max_tokens' } },
  }));
  await profiles.close();
  const helperHost = bundledSdkHelperHost();
  const daemon = createDaemon({
    localAgentRelease: { version: '0.0.0-packaging' }, productName: 'BYOK Packaging', productId: PRODUCT_ID, serverUrl,
    storeDir: path.join(root, 'store'), storage: { scratchRoot: path.join(root, 'scratch') },
    agentHome: { hostStorageRoot: path.join(root, 'home') }, agentEgress: { policy: EGRESS_POLICY },
    runtimeAllowlist: ['pi'], sdkHelperHost: helperHost,
    // Windows Pi launches own their process tree with a Job Object, through koffi from this root.
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
    const { taskId } = await byok.executions.submit({
      taskId: randomUUID(), deviceId,
      payload: { instruction: 'reply once', runtime: 'pi', session: { mode: 'fresh' }, agentRef: AGENT, egressPolicy: EGRESS_POLICY,
        terminalProjection: { mode: 'none' }, dispatchSelection: { lane: 'byok', runtimeId: 'pi', providerId: 'packaging', modelId: 'packaging-model' } },
    });
    const task = await until(async () => {
      const snapshot = await byok.tasks.get(taskId);
      return snapshot && ['Complete', 'Failed', 'Cancelled'].includes(snapshot.state) ? snapshot : undefined;
    }, 'task terminal state');
    const reply = task.result && 'finalMessage' in task.result ? task.result.finalMessage : undefined;
    console.log(`${MARKER} ${JSON.stringify({ ok: task.state === 'Complete' && reply === MODEL_REPLY, state: task.state, result: task.result,
      modelRequests: requests, helperHost: helperHost.entry === undefined ? 'executable' : 'node-entry',
      agentMemoryMcp: daemon.status().agentMemoryMcp })}`);
    if (task.state !== 'Complete' || reply !== MODEL_REPLY) process.exitCode = 1;
  } finally {
    await daemon.stop();
    await listener.close();
    await byok.close();
    model.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  // The Pi host, in this process and in every re-entered child, reads its assets here.
  process.env.PI_PACKAGE_DIR = path.join(assetRoot(), sdkPackagingAssetLayout.pi);
  if (await runSdkReservedHelperCommand()) return;
  // A SEA repeats its executable as argv[1], so product arguments start at 2 in every format.
  const args = process.argv.slice(2);
  if (args[0] === LAUNCHER_COMMAND) {
    process.exitCode = await runPiProviderLauncher(parsePiProviderLauncherOptions(args.slice(1)), { createSecretStore: () => new InMemorySecretStore() });
    return;
  }
  if (args[0] === 'host') return host();
  throw new Error(`unknown command ${JSON.stringify(args[0])}`);
}

main().catch((error: unknown) => {
  console.log(`${MARKER} ${JSON.stringify({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) })}`);
  // A failed smoke may leave listeners open; the report is already written.
  process.exit(1);
});
