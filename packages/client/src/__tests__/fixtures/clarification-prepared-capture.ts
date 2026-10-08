// Test-only native capture fixture adapted from pi-prepared-launcher.test.ts.
// No production authority: receipt remains ready=false/test_fixture. HTTP only loopback.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskOfferPayload } from '@byok-sdk/protocol';
import { validateInputPreparationLimits, INPUT_PREPARATION_REQUEST_FORMAT, INPUT_PREPARATION_VERSION,
  type InputPreparationRequestV1, type InputPreparationReceiptV1, type InputPreparationCompiledPromptSnapshotV1,
  type InputPreparationModelV1 } from '../../input-preparation';
import { createInputPreparationService, type InputPreparationService } from '../../daemon/input-preparation-service';
import { sealRuntimeOperationManifest, type RuntimePreparedLaunchV1, type Session } from '../../types';
import { bindMcpToolsetServerObservation, type McpToolsetServerObservation } from '../../mcp/observation';
import { probeMcpServer } from '../../daemon/mcp-tools-probe';
import { McpToolsetRegistry } from '../../daemon/toolset-registry';
import { createPreparedToolSurfaceAssembler } from '../../daemon/prepared-tool-surface';
import { PiAdapter } from '../../adapters/pi/pi-adapter';
import { resolvePinnedPiRuntimeIdentity, createPiInputPreparationCompiler } from '../../adapters/pi/input-preparation';
import { projectPiMcpEnvironment } from '../../adapters/pi/mcp-environment';

const FIXTURE = fileURLToPath(new URL('./mcp-fixture-server.mjs', import.meta.url));
const RUNTIME_IDENTITY_TOOLSET = 'team';

const dirs: string[] = [];
const servers: Server[] = [];
const sessions: Session[] = [];
const services: InputPreparationService[] = [];

export async function cleanupCapture(): Promise<void> {
  while (services.length > 0) await services.pop()?.stop();
  while (sessions.length > 0) await sessions.pop()?.close().catch(() => {});
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(dirs.splice(0).map(
    (dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  ));
}

export async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function fixtureServer(recordTo?: string): { command: string; args: string[] } {
  return { command: process.execPath, args: [FIXTURE, JSON.stringify(recordTo === undefined ? {} : { recordTo })] };
}

// ---------------------------------------------------------------------------
// A real provider endpoint
// ---------------------------------------------------------------------------

interface ProviderEndpoint {
  readonly baseUrl: string;
  readonly bodies: string[];
  /** The request line and headers of every call, alongside `bodies` by index. */
  readonly calls: { url: string; headers: Readonly<Record<string, string | string[] | undefined>> }[];
  /** Replaces the default single-chunk completion for one case. */
  respond: (req: IncomingMessage, res: ServerResponse) => void;
}

function sse(chunks: readonly unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
}

function completion(content: string): readonly unknown[] {
  const base = { id: 'cmpl-1', object: 'chat.completion.chunk', created: 0, model: 'glm-4.6' };
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
}

export async function providerEndpoint(): Promise<ProviderEndpoint> {
  const bodies: string[] = [];
  const calls: { url: string; headers: Readonly<Record<string, string | string[] | undefined>> }[] = [];
  const endpoint: ProviderEndpoint = {
    baseUrl: '',
    bodies,
    calls,
    respond(_req, res) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(completion('done')));
    },
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      calls.push({ url: req.url ?? '', headers: { ...req.headers } });
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      endpoint.respond(req, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the provider endpoint has no port');
  return Object.assign(endpoint, { baseUrl: `http://127.0.0.1:${address.port}/v1` });
}

// ---------------------------------------------------------------------------
// One real preparation, compiled by the native compiler
// ---------------------------------------------------------------------------

function model(baseUrl: string): InputPreparationModelV1 {
  return {
    id: 'glm-4.6',
    name: 'GLM 4.6',
    api: 'openai-completions',
    provider: 'zai',
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

export interface Prepared {
  readonly receipt: InputPreparationReceiptV1;
  readonly service: InputPreparationService;
  readonly workspaceDir: string;
  readonly homeDir: string;
  readonly artifactPath: string;
  readonly requestBody: string;
  readonly preparation: RuntimePreparedLaunchV1;
  readonly mcpServers: Readonly<Record<string, { command: string; args: string[] }>>;
  readonly observation: Readonly<Record<string, McpToolsetServerObservation>>;
  readonly childEnv: Record<string, string>;
  readonly recordPath: string;
}

/**
 * Produce exactly what a counted preparation leaves behind on this device.
 *
 * The daemon's own assembler observes the servers and counts the manifest; the
 * native compiler then compiles the snapshot the prepared session will project
 * for itself. Nothing here re-implements either one — a test that hand-built
 * either half would prove the launch agrees with the test, not with the device.
 */
export async function prepareOnThisDevice(endpoint: ProviderEndpoint, input: {
  storeDir: string; requestId: string; sourceRevision: string; message: string;
}): Promise<Prepared> {
  const workspaceDir = await tempDir('byok-pi-prepared-cwd-');
  const homeDir = await tempDir('byok-pi-prepared-home-');
  const recordPath = path.join(await tempDir('byok-pi-prepared-record-'), 'calls.jsonl');
  await fs.mkdir(path.join(homeDir, '.pi', 'agent'), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, '.pi', 'agent', 'auth.json'),
    JSON.stringify({ zai: { type: 'api_key', key: 'prepared-launch-test-key' } }),
    { mode: 0o600 },
  );

  const server = fixtureServer(recordPath);
  const toolsets = new McpToolsetRegistry({
    [RUNTIME_IDENTITY_TOOLSET]: {
      mcpServers: { teamserver: server },
    },
  });
  const compiler = createPiInputPreparationCompiler(resolvePinnedPiRuntimeIdentity());
  const runtimeIdentity =
    `${compiler.runtime.packageName}@${compiler.runtime.packageVersion}`
    + `+${compiler.runtime.closureDigest}.compiler-${compiler.runtime.compilerVersion}`;

  const assembled = await createPreparedToolSurfaceAssembler({
    toolsetRegistry: toolsets,
    runtimeEnv: () => ({ PATH: process.env.PATH ?? '' }),
  }).assemble({
    agentMemory: 'none',
    requiredToolsets: [RUNTIME_IDENTITY_TOOLSET],
    runtimeIdentity,
  });
  if (!assembled.ok) throw new Error(`the device refused to count this preparation: ${assembled.detail}`);
  const surface = assembled.surface;

  const observed = await probeMcpServer('teamserver', server, {
    label: 'MCP toolset server "teamserver"',
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 10_000,
  });
  const observation = Object.freeze({
    teamserver: bindMcpToolsetServerObservation(observed, RUNTIME_IDENTITY_TOOLSET),
  });

  // The Host owns the WHOLE system message on official Pi: `customPrompt` is
  // the system message verbatim, and every renderer input stays empty (a
  // non-empty one is refused as `prompt_render_input_unsupported`).
  const snapshot = {
    // Stated in full: every prompt input that decides the bytes is named here.
    // `cwd` and `docsPaths` are renderer inputs and reach nothing.
    prompt: { systemPrompt: 'You are the prepared BYOK test agent. Use the echo tool when asked.' } satisfies InputPreparationCompiledPromptSnapshotV1,
    tools: surface.tools,
    model: model(endpoint.baseUrl),
  };


  let compiled: Awaited<ReturnType<typeof compiler.compile>> | undefined;
  const limits = validateInputPreparationLimits({ revision: 'capture-limits-v1',maxRequestBytes: 64_000,maxArtifactBytes: 512_000,
    maxScopeAggregateBytes: 1_024_000,maxInFlight: 4,maxCounterCallsPerScope: 8,counterTimeoutMs: 5_000,
    preparationDeadlineMs: 30_000,retentionMs: 300_000,retryHorizonMs: 300_000 });
  const scope = { deviceId: 'offline-device',agentRef: 'offline-agent',profileId: 'offline-profile',profileRevision: '1' };
  const request: InputPreparationRequestV1 = { format: INPUT_PREPARATION_REQUEST_FORMAT,version: INPUT_PREPARATION_VERSION,
    requestId: input.requestId,policyRevision: limits.revision,scope,
    source: { revision: input.sourceRevision,digest: createHash('sha256').update(input.message).digest('hex') },
    selection: { model: snapshot.model,options: { cacheRetention: 'none',maxTokens: 4096 } },
    snapshot: { prompt: snapshot.prompt,messages: [{ role: 'user',content: input.message,timestamp: 1_700_000_000_000 }] },
    agentMemory: 'none',requiredToolsets: [RUNTIME_IDENTITY_TOOLSET] };
  const service = createInputPreparationService({ storeDir: input.storeDir,limits,
    compiler: { runtime: compiler.runtime,async compile(request) { compiled = await compiler.compile(request); return compiled; } },
    toolSurface: createPreparedToolSurfaceAssembler({ toolsetRegistry: toolsets,runtimeEnv: () => ({ PATH: process.env.PATH ?? '' }) }),
    authorityResolver: {
      async resolveScope(claim) { return { authorized: true,grant: { scopeId: 'offline-capture',agentMemory: 'none',...claim } }; },
      async resolveSource({ source }) { return { authorized: true,source }; },
    },
    counter: { async count(request) { return { authority: 'test_fixture',method: 'offline.capture',methodVersion: '1',value: 1,
      coverage: { covered: false,reason: 'offline fixture, not provider authority' },providerEvidence: {
        projectionDigest: createHash('sha256').update(request.counterProjection).digest('hex'),endpoint: request.target.endpoint,modelId: request.target.modelId,
        asserted: { httpStatus: 200,usageFields: { prompt_tokens: 1 },responseDigest: 'e'.repeat(64) } } }; } },
  });
  services.push(service); await service.open();
  const receipt = await service.prepare(request);
  if (!compiled || !receipt.artifact) throw new Error('Missing compiled capture artifact');
  const recordId = receipt.reference;
  const artifactPath = path.join(input.storeDir,'input-preparation','artifacts',`${recordId}.json`);
  // The receipt is genuinely not ready. Launching its artifact directly here
  // deliberately bypasses cloud/task admission, solely to inspect native bytes.
  // No fake provider authority or ready marker is inserted into its store.
  const binding = { inputIdentity: `${receipt.binding.source.revision}:${receipt.binding.source.digest}`,
    runtimeIdentity,policyIdentity: limits.revision,profileRevision: scope.profileRevision };
  return {
    receipt,service,workspaceDir,
    homeDir,
    artifactPath,
    requestBody: compiled.requestBody,
    recordPath,
    mcpServers: { teamserver: server },
    observation,
    childEnv: {
      PATH: process.env.PATH ?? '',
      HOME: homeDir,
      // pi's own agent-directory variable, so this case never touches the
      // developer's real `~/.pi`.
      PI_CODING_AGENT_DIR: path.join(homeDir, '.pi', 'agent'),
    },
    preparation: {
      agentMemory: 'none',
      memory: null,
      reference: { scopeId: receipt.binding.scopeId,agentRef: scope.agentRef,requestId: input.requestId,recordId },
      artifactPath,
      expected: {
        envelopeDigest: compiled.envelopeDigest,
        toolManifestDigest: compiled.toolManifestDigest,
        model: snapshot.model,
        binding,
      },
      toolBindingDigest: surface.toolBindingDigest,
      observationDigest: surface.observationDigest,
      toolsetDefinitionRevisions: surface.toolsetDefinitionRevisions,
    },
  };
}

/** Direct native boundary probe. It never pins/claims a non-ready receipt. */
export async function startPrepared(prepared: Prepared, overrides: { taskId: string; preparation?: RuntimePreparedLaunchV1 }): Promise<Session> {
  const adapter = new PiAdapter();
  const offer: TaskOfferPayload = {
    taskId: overrides.taskId,
    instruction: 'unused on the prepared lane',
  } as unknown as TaskOfferPayload;
  const result = await adapter.prepare({
    offer,
    descriptor: adapter.descriptor,
    requiredToolsetIds: [RUNTIME_IDENTITY_TOOLSET],
    mcpServers: prepared.mcpServers,
    mcpToolsetTools: prepared.observation,
  });
  if (result.kind === 'reject') throw new Error(`the pi adapter refused the prepared operation: ${result.reason}`);
  const manifest = sealRuntimeOperationManifest({
    agentMemory: prepared.preparation.agentMemory,
    taskId: overrides.taskId,
    runtimeId: 'pi',
    descriptor: adapter.descriptor,
    requiredToolsetIds: [RUNTIME_IDENTITY_TOOLSET],
    workspace: { workspaceDir: prepared.workspaceDir },
    forwardedEnvironmentNames: Object.keys(prepared.childEnv).sort(),
  });
  const runtimeLaunch = await result.operation.resolveRuntimeLaunch!({
    kind: 'prepared', cwd: prepared.workspaceDir, env: prepared.childEnv,
    projectionRoot: path.join(prepared.workspaceDir, '.unused-projections'),
  });
  try {
    const session = await result.operation.start({
      runtimeLaunch,
      kind: 'prepared',
      mcpEnv: projectPiMcpEnvironment(prepared.childEnv),
      manifest,
      env: prepared.childEnv,
      mcpServers: prepared.mcpServers,
      mcpToolsetTools: prepared.observation,
      preparation: overrides.preparation ?? prepared.preparation,
    });
    sessions.push(session);
    return session;
  } catch (error) {
    await runtimeLaunch.release();
    throw error;
  }
}
