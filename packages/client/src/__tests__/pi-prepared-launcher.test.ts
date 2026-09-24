import { projectPiMcpEnvironment } from '../adapters/pi/mcp-environment';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { promises as fs, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionPolicy, TaskOfferPayload } from '@byok-sdk/protocol';
import {
  getDocsPath,
  getExamplesPath,
  getReadmePath,
} from '@earendil-works/pi-coding-agent';
import {
  INPUT_PREPARATION_ARTIFACT_FORMAT,
  INPUT_PREPARATION_VERSION,
  type InputPreparationCompiledPromptSnapshotV1,
  type InputPreparationModelV1,
  type InputPreparationToolV1,
} from '../input-preparation';
import {
  sealRuntimeOperationManifest,
  type RuntimePreparedLaunchV1,
  type Session,
} from '../types';
import { classifyMcpToolsetServerObservation, type McpToolsetServerObservation } from '../mcp/observation';
import { probeMcpServer } from '../daemon/mcp-tools-probe';
import { McpToolsetRegistry } from '../daemon/toolset-registry';
import { createPreparedToolSurfaceAssembler } from '../daemon/prepared-tool-surface';
import { TOOL_IMPLEMENTATION_RESOLVER_UNCONFIGURED } from '../daemon/tool-implementation-identity';
import { PiAdapter, type PiAdapterOptions } from '../adapters/pi/pi-adapter';
import { PREPARED_PROJECTION_COMPARED_MODEL_FIELDS } from '../bin/pi-prepared-host';
import { resolveInstalledPiRuntimeIdentity, createPiInputPreparationCompiler } from '../adapters/pi/input-preparation';
import { canonicalPreparedValue } from '../adapters/pi/prepared-request';
import { trustedLaunchBinding } from './fixtures/launch-cwd';
import { parsePiMcpEnvironment } from '../adapters/pi/mcp-environment';
import {
  toolImplementationLaunchEnvNamesDigest, toolImplementationLoaderEnvValuesDigest,
} from '@byok-sdk/implementation-identity';
import { parseModelProviderProfile, type ModelProviderProfile } from '../../../keys/src/provider-profile';
import { buildPiPreparedArgs, buildPiProviderProjection } from '../../../keys/src/pi-provider-projection';
import {
  buildPiProviderChildEnvironment, parsePiProviderLauncherOptions,
} from '../../../keys/src/pi-provider-launcher-core';
import { PI_MODEL_FIXTURE } from '../../../keys/src/fixtures/pi-model-config';

/**
 * The SDK's OWN prepared canonicalization (`adapters/pi/prepared-request.ts`),
 * not a local one.
 *
 * The cases below that rebuild a consistent envelope have to hash exactly what
 * the verifier hashes; a key-sorted serializer written here could agree today
 * and diverge on the first value where the two definitions differ.
 */
async function nativeDigest(value: unknown): Promise<string> {
  return createHash('sha256').update(canonicalPreparedValue(value), 'utf8').digest('hex');
}

/**
 * The SDK-owned prepared launch entry (`bin/byok-pi-prepared.ts`), driven
 * end to end: the REAL pi adapter, the REAL shipped bin, the REAL official session,
 * a REAL MCP server child in the REAL launch boundary of this machine, and a
 * REAL provider endpoint this suite runs and reads the request bytes off.
 *
 * Nothing about the pi adapter or its SDK-owned host is stubbed:
 * the prepared branch must not need the extension resolution the ordinary lane
 * uses, and stubbing it would hide a prepared launch that quietly depended on
 * it.
 *
 * The properties:
 *
 * - The bytes that reach the provider are D — the exact request body the A1'
 *   compile produced, byte for byte. Not "equivalent", not "recompiled": the
 *   comparison is `===` against the artifact's own `requestBody`.
 * - Every drift the prepared host detects is reported as its typed code and is
 *   detected BEFORE the transport: the provider endpoint records zero requests
 *   in each of those cases, which is asserted, not assumed.
 * - While the prepared run is in flight, an ordinary `prompt` is refused (the
 *   official session is busy) and a `steer` never reaches the provider (the
 *   byte gate refuses the next request as `prepared_context_drift`); `get_state`
 *   reports the same session id the admission did.
 * - A sealed `sessionRef` and a prepared reference are refused together.
 * - An MCP tool call made by the prepared session reaches a real server child,
 *   started in the trusted launch directory, through the shared pool.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));
const RUNTIME_IDENTITY_TOOLSET = 'team';

const dirs: string[] = [];
const servers: Server[] = [];
const sessions: Session[] = [];

afterEach(async () => {
  while (sessions.length > 0) await sessions.pop()?.close().catch(() => {});
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(dirs.splice(0).map(
    (dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  ));
});

async function tempDir(prefix: string): Promise<string> {
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

async function providerEndpoint(): Promise<ProviderEndpoint> {
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

const POLICY: PermissionPolicy = { mode: 'auto', allowTools: [] };

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

const BINDING = {
  inputIdentity: 'src-rev-1:src-digest-1',
  runtimeIdentity: 'runtime-1',
  policyIdentity: 'policy-rev-1',
  profileRevision: 'profile-rev-1',
} as const;

interface Prepared {
  readonly workspaceDir: string;
  readonly homeDir: string;
  readonly artifactPath: string;
  readonly requestBody: string;
  readonly preparation: RuntimePreparedLaunchV1;
  readonly mcpServers: Readonly<Record<string, { command: string; args: string[] }>>;
  readonly observation: Readonly<Record<string, McpToolsetServerObservation>>;
  readonly launchCwd: string;
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
async function prepareOnThisDevice(
  endpoint: ProviderEndpoint,
  mutate: (snapshot: {
    prompt: InputPreparationCompiledPromptSnapshotV1;
    tools: readonly InputPreparationToolV1[];
    model: InputPreparationModelV1;
  }) => void = () => {},
): Promise<Prepared> {
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
      readOnlyTools: { teamserver: ['echo'] },
    },
  });
  const launchBinding = await trustedLaunchBinding();
  const compiler = createPiInputPreparationCompiler(resolveInstalledPiRuntimeIdentity());
  const runtimeIdentity =
    `${compiler.runtime.packageName}@${compiler.runtime.packageVersion}`
    + `+${compiler.runtime.upstreamCommit}.${String(compiler.runtime.forkBuild)}`;

  const assembled = await createPreparedToolSurfaceAssembler({
    toolsetRegistry: toolsets,
    runtimeEnv: () => ({ PATH: process.env.PATH ?? '' }),
  }).assemble({
    requiredToolsets: [RUNTIME_IDENTITY_TOOLSET],
    permissionMode: POLICY.mode,
    runtimeIdentity,
  });
  if (!assembled.ok) throw new Error(`the device refused to count this preparation: ${assembled.detail}`);
  const surface = assembled.surface;

  const observed = await probeMcpServer('teamserver', server, {
    label: 'MCP toolset server "teamserver"',
    env: { PATH: process.env.PATH ?? '' },
    cwd: surface.launch.launchCwd,
    timeoutMs: 10_000,
  });
  const observation = Object.freeze({
    teamserver: classifyMcpToolsetServerObservation(observed, {
      toolsetId: RUNTIME_IDENTITY_TOOLSET,
      readOnlyTools: ['echo'],
    }),
  });

  // The Host owns the WHOLE system message on official Pi: `customPrompt` is
  // the system message verbatim, and every renderer input stays empty (a
  // non-empty one is refused as `prompt_render_input_unsupported`).
  const snapshot = {
    // Stated in full: every prompt input that decides the bytes is named here.
    // `cwd` and `docsPaths` are renderer inputs and reach nothing.
    prompt: {
      cwd: workspaceDir,
      selectedTools: surface.tools.map((tool) => tool.name),
      customPrompt: 'You are the prepared BYOK test agent. Use the echo tool when asked.',
      toolSnippets: {},
      toolGuidelines: {},
      promptGuidelines: [],
      contextFiles: [],
      skills: [],
      docsPaths: { readmePath: getReadmePath(), docsPath: getDocsPath(), examplesPath: getExamplesPath() },
    } satisfies InputPreparationCompiledPromptSnapshotV1,
    tools: surface.tools,
    model: model(endpoint.baseUrl),
  };
  mutate(snapshot);

  const compiled = await compiler.compile({
    snapshot: {
      prompt: { ...snapshot.prompt, selectedTools: snapshot.prompt.selectedTools },
      messages: [{ role: 'user', content: 'echo the word prepared', timestamp: 1_700_000_000_000 }],
      tools: snapshot.tools,
    },
    model: snapshot.model,
    options: { cacheRetention: 'none', maxTokens: 4_096 },
    binding: BINDING,
    toolExecutors: surface.toolExecutors,
  });

  const recordId = 'record-prepared-launch-1';
  const artifactPath = path.join(await tempDir('byok-pi-prepared-artifact-'), 'artifact.json');
  await fs.writeFile(artifactPath, JSON.stringify({
    format: INPUT_PREPARATION_ARTIFACT_FORMAT,
    version: INPUT_PREPARATION_VERSION,
    recordId,
    requestDigest: compiled.requestDigest,
    envelopeDigest: compiled.envelopeDigest,
    toolManifestDigest: compiled.toolManifestDigest,
    requestBody: compiled.requestBody,
    counterProjection: compiled.counterProjection,
    projection: compiled.projection,
    residual: [...compiled.residual],
    envelope: compiled.envelope,
  }), { mode: 0o600 });

  return {
    workspaceDir,
    homeDir,
    artifactPath,
    requestBody: compiled.requestBody,
    recordPath,
    launchCwd: launchBinding.cwd,
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
      reference: { scopeId: 'scope-1', agentRef: 'agent-1', requestId: 'prep-1', recordId },
      artifactPath,
      expected: {
        envelopeDigest: compiled.envelopeDigest,
        toolManifestDigest: compiled.toolManifestDigest,
        model: snapshot.model,
        binding: BINDING,
      },
      permissionMode: POLICY.mode,
      toolBindingDigest: surface.toolBindingDigest,
      observationDigest: surface.observationDigest,
      launch: { cwd: surface.launch.launchCwd },
      toolImplementations: { teamserver: TOOL_IMPLEMENTATION_RESOLVER_UNCONFIGURED },
      toolsetDefinitionRevisions: surface.toolsetDefinitionRevisions,
    },
  };
}

interface StartOverrides {
  preparation?: RuntimePreparedLaunchV1;
  sessionRef?: string;
  spawnFn?: PiAdapterOptions['spawnFn'];
  /** Receives the resolved launch so a case can assert its projection lifecycle. */
  captureLaunch?: (resources: { env: Readonly<Record<string, string>>; release: () => Promise<void> }) => void;
  /** Everything a BYOK-profile prepared launch adds, and nothing else. */
  byok?: {
    selection: NonNullable<TaskOfferPayload['dispatchSelection']>;
    launcher?: PiAdapterOptions['byokLauncher'];
    projectionRoot: string;
  };
}

/** Start the prepared operation through the REAL adapter, with nothing stubbed. */
async function startPrepared(
  prepared: Prepared,
  overrides: StartOverrides = {},
): Promise<Session> {
  const byok = overrides.byok;
  const adapter = new PiAdapter({
    ...(byok?.launcher === undefined ? {} : { byokLauncher: byok.launcher }),
    ...(overrides.spawnFn === undefined ? {} : { spawnFn: overrides.spawnFn }),
  });
  const offer: TaskOfferPayload = {
    taskId: 'prepared-launch-test',
    instruction: 'unused on the prepared lane',
    policy: POLICY,
    ...(byok === undefined ? {} : { dispatchSelection: byok.selection }),
  } as unknown as TaskOfferPayload;
  const result = await adapter.prepare({
    offer,
    policy: POLICY,
    descriptor: adapter.descriptor,
    requiredToolsetIds: [RUNTIME_IDENTITY_TOOLSET],
    mcpServers: prepared.mcpServers,
    mcpToolsetTools: prepared.observation,
  });
  if (result.kind === 'reject') throw new Error(`the pi adapter refused the prepared operation: ${result.reason}`);
  const manifest = sealRuntimeOperationManifest({
    taskId: 'prepared-launch-test',
    runtimeId: 'pi',
    descriptor: adapter.descriptor,
    policy: POLICY,
    requiredToolsetIds: [RUNTIME_IDENTITY_TOOLSET],
    ...(byok === undefined ? {} : { dispatchSelection: byok.selection }),
    ...(overrides.sessionRef === undefined ? {} : { sessionRef: overrides.sessionRef }),
    workspace: { workspaceDir: prepared.workspaceDir },
    forwardedEnvironmentNames: Object.keys(prepared.childEnv).sort(),
  });
  const runtimeLaunch = await result.operation.resolveRuntimeLaunch!({
    kind: 'prepared', cwd: prepared.workspaceDir, env: prepared.childEnv,
    projectionRoot: byok?.projectionRoot ?? path.join(prepared.workspaceDir, '.unused-projections'),
  });
  overrides.captureLaunch?.(runtimeLaunch);
  try {
    const session = await result.operation.start({
      runtimeLaunch,
      kind: 'prepared',
      mcpEnv: projectPiMcpEnvironment(prepared.childEnv),
      manifest,
      env: prepared.childEnv,
      mcpServers: prepared.mcpServers,
      mcpToolsetTools: prepared.observation,
      mcpLaunch: { cwd: prepared.launchCwd },
      mcpToolImplementations: { teamserver: TOOL_IMPLEMENTATION_RESOLVER_UNCONFIGURED },
      preparation: overrides.preparation ?? prepared.preparation,
    });
    sessions.push(session);
    return session;
  } catch (error) {
    await runtimeLaunch.release();
    throw error;
  }
}

/** Rewrite the artifact in place so the envelope no longer matches the device. */
async function tamper(prepared: Prepared, mutate: (envelope: Record<string, unknown>) => void): Promise<void> {
  const artifact = JSON.parse(await fs.readFile(prepared.artifactPath, 'utf8')) as Record<string, unknown>;
  mutate(artifact.envelope as Record<string, unknown>);
  await fs.writeFile(prepared.artifactPath, JSON.stringify(artifact));
}

describe('the prepared pi launch entry', () => {
  it('registers only counted MCP tools under auto+[] and sends D verbatim', async () => {
    const endpoint = await providerEndpoint();
    const prepared = await prepareOnThisDevice(endpoint);
    const session = await startPrepared(prepared);

    expect(session.sessionRef.length).toBeGreaterThan(0);
    for await (const event of session.events) {
      if (event.type === 'turn_end') break;
    }
    // The bytes that reached the provider are D, not a recompilation of it.
    expect(endpoint.bodies).toHaveLength(1);
    expect(endpoint.bodies[0]).toBe(prepared.requestBody);
    const wire = JSON.parse(endpoint.bodies[0]!);
    expect(wire.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['mcp__teamserver__echo', 'mcp__teamserver__find_leads']);
  }, 60_000);

  // Official `runRpcMode` has no prepared reservation (WP2 deviation 2): there
  // is no `prepared_session_reserved` code. The two in-flight inputs are still
  // kept out of the counted run, by different owners: the official session
  // refuses a concurrent `prompt` as busy, and a `steer` is accepted by the RPC
  // loop but the byte gate refuses the request it would ride on.
  it('refuses the ordinary prompt while the prepared run is in flight, and sends nothing for it', async () => {
    const endpoint = await providerEndpoint();
    // The response is held open, so the run is still streaming when the
    // ordinary prompt arrives — the exact window the refusal exists for.
    let release: (() => void) | undefined;
    endpoint.respond = (_req, res) => {
      release = () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse(completion('done')));
      };
    };
    const prepared = await prepareOnThisDevice(endpoint);
    const session = await startPrepared(prepared);
    const refusal = await (session as unknown as {
      rpc: { send(command: Record<string, unknown> & { type: string }): Promise<Record<string, unknown>> };
    }).rpc.send({ type: 'prompt', message: 'a second turn nobody counted' });

    expect(refusal.success).toBe(false);
    expect(String(refusal.error)).toMatch(/already processing/u);
    release?.();
    for await (const event of session.events) {
      if (event.type === 'turn_end') break;
    }
    expect(endpoint.bodies).toEqual([prepared.requestBody]);
  }, 60_000);

  it('never sends a steer: the byte gate refuses the request it would ride on', async () => {
    const endpoint = await providerEndpoint();
    let release: (() => void) | undefined;
    endpoint.respond = (_req, res) => {
      release = () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse(completion('done')));
      };
    };
    const prepared = await prepareOnThisDevice(endpoint);
    const session = await startPrepared(prepared);
    const rpc = (session as unknown as {
      rpc: { send(command: Record<string, unknown> & { type: string }): Promise<Record<string, unknown>> };
    }).rpc;
    const steered = await rpc.send({ type: 'steer', message: 'an instruction nobody counted' });
    expect(steered.success).toBe(true);
    release?.();
    const seen: string[] = [];
    for await (const event of session.events) {
      seen.push(JSON.stringify(event));
      if (event.type === 'turn_end') break;
    }
    // Request 1 is D. The steer made the session issue request 2, and the gate
    // refused it before any transport: the provider saw D alone, and the
    // session recorded the refusal as a failed assistant turn. The typed reason
    // (`prepared_context_drift`, the context handler saw a user message this
    // run did not produce) is run-scoped gate state; upstream surfaces the
    // throw as a generic connection error, so the RPC readback cannot name it.
    expect(endpoint.bodies).toEqual([prepared.requestBody]);
    expect(seen.join('\n')).not.toContain('an instruction nobody counted');
    const readback = await rpc.send({ type: 'get_messages' });
    const messages = (readback.data as { messages: { role: string; content: unknown; stopReason?: string }[] }).messages;
    expect(messages.slice(-2).map((message) => [message.role, message.stopReason])).toEqual([
      ['user', undefined],
      ['assistant', 'error'],
    ]);
    expect(JSON.stringify(messages.at(-2)?.content)).toContain('an instruction nobody counted');
  }, 60_000);

  it('reports the same session id from get_state that admitted the prepared request', async () => {
    const endpoint = await providerEndpoint();
    const prepared = await prepareOnThisDevice(endpoint);
    const session = await startPrepared(prepared);
    const state = await (session as unknown as {
      rpc: { send(command: Record<string, unknown> & { type: string }): Promise<Record<string, unknown>> };
    }).rpc.send({ type: 'get_state' });
    expect((state.data as { sessionId?: string } | undefined)?.sessionId).toBe(session.sessionRef);
  }, 60_000);

  it('refuses a prepared operation that also carries a sealed sessionRef', async () => {
    const endpoint = await providerEndpoint();
    const prepared = await prepareOnThisDevice(endpoint);
    await expect(startPrepared(prepared, { sessionRef: 'pi-session-from-an-earlier-turn' }))
      .rejects.toThrow(/never resumes/u);
    expect(endpoint.bodies).toHaveLength(0);
  }, 60_000);

  // WP2 deviation 6: `verifyPreparedPiInput` checks the envelope digests
  // before it recompiles the transcript, so a bare edit is a digest mismatch.
  it('reports a tampered transcript as prepared_digest_mismatch, before any transport', async () => {
    const endpoint = await providerEndpoint();
    const prepared = await prepareOnThisDevice(endpoint);
    await tamper(prepared, (envelope) => {
      const transcript = envelope.transcript as { systemPrompt: string };
      transcript.systemPrompt = `${transcript.systemPrompt}\na guideline nobody counted`;
    });
    await expect(startPrepared(prepared)).rejects.toThrow(/prepared_digest_mismatch/u);
    expect(endpoint.bodies).toHaveLength(0);
  }, 60_000);

  it('reports a re-digested tampered transcript as prepared_context_drift, before any transport', async () => {
    const endpoint = await providerEndpoint();
    const prepared = await prepareOnThisDevice(endpoint);
    // Internally CONSISTENT: the envelope digest and the expectation agree with
    // the edited transcript. Only the recompile disagrees — the transcript no
    // longer compiles to the frozen D it travels with.
    const artifact = JSON.parse(await fs.readFile(prepared.artifactPath, 'utf8')) as Record<string, unknown>;
    const envelope = artifact.envelope as Record<string, unknown>;
    const transcript = envelope.transcript as { systemPrompt: string };
    transcript.systemPrompt = `${transcript.systemPrompt}\na guideline nobody counted`;
    const { digest: _discarded, ...body } = envelope as { digest: string };
    envelope.digest = await nativeDigest(body);
    artifact.envelopeDigest = envelope.digest;
    await fs.writeFile(prepared.artifactPath, JSON.stringify(artifact));
    const rebound: RuntimePreparedLaunchV1 = {
      ...prepared.preparation,
      expected: { ...prepared.preparation.expected, envelopeDigest: envelope.digest as string },
    };
    await expect(startPrepared(prepared, { preparation: rebound })).rejects.toThrow(/prepared_context_drift/u);
    expect(endpoint.bodies).toHaveLength(0);
  }, 60_000);

  // `prepared_model_drift` is a LATER check: it is what the host reports when
  // the model the runtime registered disagrees with the projection. The
  // expectation handed in here is checked first, against the model the
  // envelope itself carries (`pi-prepared-host.ts` and `verifyPreparedPiInput`),
  // so an expectation nobody counted is reported as
  // `prepared_expectation_mismatch` and never reaches the registration
  // comparison. The single code is pinned rather than an alternation, so a
  // change that moves this case to the other check fails here instead of
  // passing quietly.
  it('reports a model expectation the counted envelope does not carry as prepared_expectation_mismatch, before any transport', async () => {
    const endpoint = await providerEndpoint();
    const prepared = await prepareOnThisDevice(endpoint);
    const drifted: RuntimePreparedLaunchV1 = {
      ...prepared.preparation,
      expected: {
        ...prepared.preparation.expected,
        model: { ...prepared.preparation.expected.model, name: 'a model nobody counted' },
      },
    };
    await expect(startPrepared(prepared, { preparation: drifted }))
      .rejects.toThrow(/prepared_expectation_mismatch/u);
    expect(endpoint.bodies).toHaveLength(0);
  }, 60_000);

  it('reports an envelope bound to another executable as prepared_registry_drift, before any transport', async () => {
    const endpoint = await providerEndpoint();
    const prepared = await prepareOnThisDevice(endpoint);
    // The whole envelope is re-digested after the edit, so it is internally
    // CONSISTENT: the manifest digest, the envelope digest and the expectations
    // all agree with each other. The only thing that disagrees is the device —
    // the tool it actually authorized has a different observation fingerprint
    // than the one this manifest binds. Schema equality does not prove the same
    // executable closure, and this is the case that says so.
    const artifact = JSON.parse(await fs.readFile(prepared.artifactPath, 'utf8')) as Record<string, unknown>;
    const envelope = artifact.envelope as Record<string, unknown>;
    const manifest = envelope.toolManifest as { order: string[]; executors: string[]; digest: string };
    manifest.executors = manifest.executors.map(() => 'e'.repeat(64));
    manifest.digest = await nativeDigest({ order: manifest.order, executors: manifest.executors });
    const { digest: _discarded, ...body } = envelope as { digest: string };
    envelope.digest = await nativeDigest(body);
    artifact.envelopeDigest = envelope.digest;
    artifact.toolManifestDigest = manifest.digest;
    await fs.writeFile(prepared.artifactPath, JSON.stringify(artifact));

    const rebound: RuntimePreparedLaunchV1 = {
      ...prepared.preparation,
      expected: {
        ...prepared.preparation.expected,
        envelopeDigest: envelope.digest as string,
        toolManifestDigest: manifest.digest,
      },
    };
    await expect(startPrepared(prepared, { preparation: rebound }))
      .rejects.toThrow(/prepared_registry_drift/u);
    expect(endpoint.bodies).toHaveLength(0);
  }, 60_000);

  it('reaches a real MCP server child in the trusted launch directory', async () => {
    const endpoint = await providerEndpoint();
    let turn = 0;
    endpoint.respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (turn++ === 0) {
        const base = { id: 'cmpl-1', object: 'chat.completion.chunk', created: 0, model: 'glm-4.6' };
        res.end(sse([
          {
            ...base,
            choices: [{
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [{
                  index: 0,
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'mcp__teamserver__echo', arguments: '{"text":"prepared"}' },
                }],
              },
              finish_reason: null,
            }],
          },
          {
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ]));
        return;
      }
      res.end(sse(completion('done')));
    };
    const prepared = await prepareOnThisDevice(endpoint);
    const session = await startPrepared(prepared);
    for await (const event of session.events) {
      if (event.type === 'turn_end') break;
    }

    const recorded = (await fs.readFile(prepared.recordPath, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // The preparation probe and the prepared session's own call are separate
    // spawns; the LAST start entry is the session's, and it started in the
    // proven directory rather than in the agent home.
    const starts = recorded.filter((entry) => entry.event === 'start');
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(starts.at(-1)?.cwd).toBe(prepared.launchCwd);
    // The SDK's own Pi control variables never reach a toolset server child.
    expect(starts.at(-1)?.byokEnv).toEqual([]);
    expect(recorded.some((entry) => entry.method === 'tools/call')).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The BYOK-profile prepared lane
// ---------------------------------------------------------------------------

/**
 * Obviously synthetic, and the only credential value anywhere in this file's
 * BYOK cases. Every assertion below that says "the secret never surfaces" is
 * an assertion about this exact string.
 */
const SYNTHETIC_SECRET = 'sk-synthetic-prepared-byok-000000000001';
const BYOK_PROFILE_REF = 'prepared-byok';
const BYOK_PROVIDER_ID = `byok-sdk-${BYOK_PROFILE_REF}`;

function byokProfile(baseUrl: string): ModelProviderProfile {
  return parseModelProviderProfile({
    created_at: '2026-09-21T00:00:00.000Z',
    updated_at: '2026-09-21T00:00:00.000Z',
    adapter: 'openai_compatible',
    auth_mode: 'bearer',
    base_url: baseUrl,
    capabilities: [],
    display_name: 'GLM 4.6',
    enabled: true,
    kind: 'model',
    model: 'glm-4.6',
    profile_ref: BYOK_PROFILE_REF,
    provider_kind: 'custom',
    pi_model: {
      contextWindow: 200_000,
      maxTokens: 8_192,
      reasoning: false,
      thinkingLevel: 'off',
      thinkingLevelMap: PI_MODEL_FIXTURE.thinkingLevelMap,
      compat: PI_MODEL_FIXTURE.compat,
    },
  });
}

type ProjectionShape = {
  providers: Record<string, { baseUrl: string; api: string; models: Record<string, unknown>[] }>;
};

/**
 * The wire model built FROM the device projection, not alongside it.
 *
 * Every compared field is read out of `buildPiProviderProjection`'s own output,
 * so a case that passes the consent gate passes it because the two really are
 * the same declaration — not because the fixture restated it consistently.
 */
function byokModel(profile: ModelProviderProfile): InputPreparationModelV1 {
  const projection = buildPiProviderProjection(profile) as ProjectionShape;
  const provider = projection.providers[BYOK_PROVIDER_ID]!;
  const entry = provider.models[0]!;
  return {
    id: entry.id as string,
    name: entry.name as string,
    api: 'openai-completions',
    provider: BYOK_PROVIDER_ID,
    baseUrl: provider.baseUrl,
    reasoning: entry.reasoning as boolean,
    input: entry.input as ('text' | 'image')[],
    // Accounting metadata the Host states; the device profile declares none and
    // the consent gate excludes it for exactly that reason.
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow as number,
    maxTokens: entry.maxTokens as number,
    thinkingLevelMap: entry.thinkingLevelMap as InputPreparationModelV1['thinkingLevelMap'],
    compat: entry.compat as InputPreparationModelV1['compat'],
  };
}

/**
 * One projection mutation per field the consent gate compares, keyed BY that
 * field name.
 *
 * The key type is the gate's own constant, so a field added to
 * `PREPARED_PROJECTION_COMPARED_MODEL_FIELDS` without a mutation case here
 * fails to typecheck, and the key-set assertion below fails the suite for the
 * same reason — the negative table cannot fall behind the comparison it exists
 * to pin.
 */
const PROJECTION_FIELD_MUTATIONS: Record<
  (typeof PREPARED_PROJECTION_COMPARED_MODEL_FIELDS)[number],
  (projection: ProjectionShape) => void
> = {
  api: (p) => { p.providers[BYOK_PROVIDER_ID]!.api = 'anthropic-messages'; },
  baseUrl: (p) => { p.providers[BYOK_PROVIDER_ID]!.baseUrl = 'http://127.0.0.1:9/v1'; },
  compat: (p) => {
    p.providers[BYOK_PROVIDER_ID]!.models[0]!.compat = { ...PI_MODEL_FIXTURE.compat, thinkingFormat: 'openai' };
  },
  contextWindow: (p) => { p.providers[BYOK_PROVIDER_ID]!.models[0]!.contextWindow = 100_000; },
  id: (p) => { p.providers[BYOK_PROVIDER_ID]!.models[0]!.id = 'glm-4.5'; },
  input: (p) => { p.providers[BYOK_PROVIDER_ID]!.models[0]!.input = ['text', 'image']; },
  maxTokens: (p) => { p.providers[BYOK_PROVIDER_ID]!.models[0]!.maxTokens = 4_096; },
  name: (p) => { p.providers[BYOK_PROVIDER_ID]!.models[0]!.name = 'GLM 4.6 (relabelled)'; },
  provider: (p) => {
    p.providers['byok-sdk-other'] = p.providers[BYOK_PROVIDER_ID]!;
    delete p.providers[BYOK_PROVIDER_ID];
  },
  reasoning: (p) => { p.providers[BYOK_PROVIDER_ID]!.models[0]!.reasoning = true; },
  thinkingLevelMap: (p) => {
    p.providers[BYOK_PROVIDER_ID]!.models[0]!.thinkingLevelMap = {
      ...PI_MODEL_FIXTURE.thinkingLevelMap, medium: 'medium',
    };
  },
};

/** Refusals about the projection's SHAPE, which no single compared field names. */
const PROJECTION_STRUCTURAL_MUTATIONS: readonly (readonly [string, (projection: ProjectionShape) => void])[] = [
  ['two projected providers', (p) => {
    p.providers['byok-sdk-other'] = { ...p.providers[BYOK_PROVIDER_ID]! };
  }],
  ['an extra model entry', (p) => {
    const entry = p.providers[BYOK_PROVIDER_ID]!.models[0]!;
    p.providers[BYOK_PROVIDER_ID]!.models = [entry, { ...entry, id: 'glm-4.5' }];
  }],
];

interface LauncherRecord {
  launcherCommand?: string;
  launcherArgs?: string[];
  options?: ReturnType<typeof parsePiProviderLauncherOptions>;
  childArgs?: string[];
  childEnv?: Record<string, string>;
  projectionDir?: string;
  configBytes?: string;
  logs: string[];
}

/**
 * The keys launcher, run in this process, from the keys package's own
 * functions.
 *
 * It is not a second implementation: `parsePiProviderLauncherOptions`,
 * `buildPiPreparedArgs`, `buildPiProviderProjection` and
 * `buildPiProviderChildEnvironment` are the REAL ones, composed in the order
 * `startPiProvider` composes them. What is left out is `startPiProvider`'s
 * async half — the two spawn-binding assertions, the projection-directory
 * layout assertion and the SecretStore read — because `PiRpcClient` hands a
 * spawn function that must return a child synchronously. Those four are
 * covered directly, against the real code, in
 * `packages/keys/src/pi-provider-launcher-core.test.ts`; what this stand-in
 * exists for is everything ABOVE and BELOW the launcher: the argv the adapter
 * hands it, and the prepared host it parents.
 */
function launcherSpawn(options: {
  profile: ModelProviderProfile;
  record: LauncherRecord;
  secret?: string;
  mutateProjection?: (projection: ProjectionShape) => void;
  /** Stand in for a launcher whose projection write never landed. */
  omitProjection?: boolean;
}): PiAdapterOptions['spawnFn'] {
  const { record } = options;
  return ((command: string, args: string[], spawnOptions: Record<string, unknown>) => {
    record.launcherCommand = command;
    record.launcherArgs = [...args];
    const parsed = parsePiProviderLauncherOptions([...args]);
    record.options = parsed;
    const delegated = buildPiPreparedArgs(parsed.piArgs);
    const env = buildPiProviderChildEnvironment({
      ambient: spawnOptions.env as NodeJS.ProcessEnv,
      binding: parsed.launchBinding!,
      sessionDir: parsed.sessionDir,
      secret: options.secret,
    });
    const projection = buildPiProviderProjection(options.profile) as ProjectionShape;
    options.mutateProjection?.(projection);
    const projectionDir = env.PI_CODING_AGENT_DIR!;
    record.projectionDir = projectionDir;
    mkdirSync(parsed.sessionDir, { recursive: true, mode: 0o700 });
    if (options.omitProjection !== true) {
      writeFileSync(path.join(projectionDir, 'models.json'), `${JSON.stringify(projection)}\n`, { mode: 0o600 });
    }
    record.configBytes = readFileSync(delegated[1]!, 'utf8');
    const childArgs = [
      ...(parsed.piEntry === undefined ? [] : [parsed.piEntry]),
      ...parsed.piFixedArgs!,
      `--config-digest=${parsed.piConfigDigest}`,
      ...delegated,
    ];
    record.childArgs = childArgs;
    record.childEnv = env;
    const child = nodeSpawn(parsed.piBin, childArgs, { ...spawnOptions, env, cwd: parsed.piCwd! } as never);
    // A second listener alongside the RPC client's own: every byte the host
    // writes to stderr is captured so the secret can be looked for in it.
    child.stderr?.on('data', (chunk: Buffer) => record.logs.push(chunk.toString('utf8')));
    return child;
  }) as PiAdapterOptions['spawnFn'];
}

async function byokFixture(endpoint: ProviderEndpoint): Promise<{
  prepared: Prepared;
  profile: ModelProviderProfile;
  launcher: NonNullable<PiAdapterOptions['byokLauncher']>;
  projectionRoot: string;
  selection: NonNullable<TaskOfferPayload['dispatchSelection']>;
}> {
  const profile = byokProfile(endpoint.baseUrl);
  const prepared = await prepareOnThisDevice(endpoint, (snapshot) => {
    snapshot.model = byokModel(profile);
  });
  const custody = await tempDir('byok-pi-prepared-custody-');
  return {
    prepared,
    profile,
    launcher: {
      // Never executed: `launcherSpawn` stands in for the process this names.
      command: path.join(custody, 'byok-pi-provider-launcher'),
      profileDbPath: path.join(custody, 'providers.sqlite'),
      sessionDir: path.join(custody, 'sessions'),
    },
    projectionRoot: await tempDir('byok-pi-prepared-projections-'),
    selection: {
      lane: 'byok', runtimeId: 'pi', providerId: BYOK_PROFILE_REF, modelId: 'glm-4.6',
    } as unknown as NonNullable<TaskOfferPayload['dispatchSelection']>,
  };
}

describe('the prepared pi launch entry under a BYOK profile', () => {
  it('is parented by the credential launcher, states the prepared entry and delegates only --config', async () => {
    const endpoint = await providerEndpoint();
    const f = await byokFixture(endpoint);
    const record: LauncherRecord = { logs: [] };
    const session = await startPrepared(f.prepared, {
      spawnFn: launcherSpawn({ profile: f.profile, record, secret: SYNTHETIC_SECRET }),
      byok: { selection: f.selection, launcher: f.launcher, projectionRoot: f.projectionRoot },
    });
    expect(session.sessionRef.length).toBeGreaterThan(0);

    expect(record.launcherCommand).toBe(f.launcher.command);
    const args = record.launcherArgs!;
    const separator = args.indexOf('--');
    expect(args.slice(separator + 1)).toEqual(['--config', expect.any(String)]);
    // The SAME six binding flags the rpc lane passes, plus the entry.
    for (const flag of ['--pi-bin', '--pi-entry', '--pi-cwd', '--pi-fixed-args', '--launch-binding', '--pi-config-digest']) {
      expect(args.slice(0, separator)).toContain(flag);
    }
    expect(record.options!.runtimeEntry).toBe('pi-prepared');
    expect(args.slice(0, separator)).not.toContain('--mode');
    // Nothing appended: the host's own parser accepts exactly two arguments.
    expect(record.childArgs!.slice(-2)).toEqual(['--config', expect.any(String)]);
    expect(JSON.parse(record.configBytes!).credentialSource).toBe('keys-profile');
  }, 60_000);

  it('sends the counted body verbatim to the profile endpoint with the launcher-delivered key', async () => {
    const endpoint = await providerEndpoint();
    const f = await byokFixture(endpoint);
    const record: LauncherRecord = { logs: [] };
    const session = await startPrepared(f.prepared, {
      spawnFn: launcherSpawn({ profile: f.profile, record, secret: SYNTHETIC_SECRET }),
      byok: { selection: f.selection, launcher: f.launcher, projectionRoot: f.projectionRoot },
    });
    for await (const event of session.events) {
      if (event.type === 'turn_end') break;
    }
    expect(endpoint.bodies).toHaveLength(1);
    expect(endpoint.bodies[0]).toBe(f.prepared.requestBody);
    // The endpoint this suite runs IS the profile's declared `base_url`, so
    // receiving the request at all is the endpoint assertion.
    expect(f.profile.base_url).toBe(endpoint.baseUrl);
    expect(endpoint.calls[0]?.url).toBe('/v1/chat/completions');
    expect(endpoint.calls[0]?.headers.authorization).toBe(`Bearer ${SYNTHETIC_SECRET}`);
  }, 60_000);

  it('keeps the synthetic secret out of the config, the argv, the logs and the artifact', async () => {
    const endpoint = await providerEndpoint();
    const f = await byokFixture(endpoint);
    const record: LauncherRecord = { logs: [] };
    const session = await startPrepared(f.prepared, {
      spawnFn: launcherSpawn({ profile: f.profile, record, secret: SYNTHETIC_SECRET }),
      byok: { selection: f.selection, launcher: f.launcher, projectionRoot: f.projectionRoot },
    });
    for await (const event of session.events) {
      if (event.type === 'turn_end') break;
    }
    expect(record.configBytes).not.toContain(SYNTHETIC_SECRET);
    expect(JSON.stringify(record.launcherArgs)).not.toContain(SYNTHETIC_SECRET);
    expect(JSON.stringify(record.childArgs)).not.toContain(SYNTHETIC_SECRET);
    expect(record.logs.join('')).not.toContain(SYNTHETIC_SECRET);
    expect(await fs.readFile(f.prepared.artifactPath, 'utf8')).not.toContain(SYNTHETIC_SECRET);
    expect(JSON.stringify(f.prepared.preparation)).not.toContain(SYNTHETIC_SECRET);
    // The projection names the credential; it never carries it.
    const projection = await fs.readFile(path.join(record.projectionDir!, 'models.json'), 'utf8');
    expect(projection).toContain('$PI_PROVIDER_API_KEY');
    expect(projection).not.toContain(SYNTHETIC_SECRET);
    // The one place it does exist is the child environment, and that name is
    // projected out of every identity digest.
    expect(record.childEnv!.PI_PROVIDER_API_KEY).toBe(SYNTHETIC_SECRET);
    const withoutKey = { ...record.childEnv! };
    delete withoutKey.PI_PROVIDER_API_KEY;
    expect(toolImplementationLaunchEnvNamesDigest(record.childEnv!))
      .toBe(toolImplementationLaunchEnvNamesDigest(withoutKey));
    expect(toolImplementationLoaderEnvValuesDigest(record.childEnv!))
      .toBe(toolImplementationLoaderEnvValuesDigest(withoutKey));
    // And no MCP descendant may inherit it.
    expect(projectPiMcpEnvironment(record.childEnv!).PI_PROVIDER_API_KEY).toBeUndefined();
    expect(() => parsePiMcpEnvironment({ PI_PROVIDER_API_KEY: SYNTHETIC_SECRET }))
      .toThrow(/private Pi or credential name/);
  }, 60_000);

  it('has a projection mutation for every field the consent gate compares', () => {
    expect(Object.keys(PROJECTION_FIELD_MUTATIONS).sort())
      .toEqual([...PREPARED_PROJECTION_COMPARED_MODEL_FIELDS].sort());
  });

  it.each([
    ...Object.entries(PROJECTION_FIELD_MUTATIONS)
      .map(([field, mutate]) => [`a projection differing on ${field}`, mutate] as const),
    ...PROJECTION_STRUCTURAL_MUTATIONS,
  ])('refuses %s as prepared_provider_projection_mismatch, before any session or transport', async (_label, mutate) => {
    const endpoint = await providerEndpoint();
    const f = await byokFixture(endpoint);
    const record: LauncherRecord = { logs: [] };
    await expect(startPrepared(f.prepared, {
      spawnFn: launcherSpawn({ profile: f.profile, record, secret: SYNTHETIC_SECRET, mutateProjection: mutate }),
      byok: { selection: f.selection, launcher: f.launcher, projectionRoot: f.projectionRoot },
    })).rejects.toThrow(/prepared_provider_projection_mismatch/u);
    expect(endpoint.bodies).toHaveLength(0);
    expect(record.logs.join('')).not.toContain(SYNTHETIC_SECRET);
    expect(record.logs.join('')).not.toContain('$PI_PROVIDER_API_KEY');
  }, 60_000);

  it('refuses a launch whose projection the launcher never wrote', async () => {
    const endpoint = await providerEndpoint();
    const f = await byokFixture(endpoint);
    const record: LauncherRecord = { logs: [] };
    await expect(startPrepared(f.prepared, {
      spawnFn: launcherSpawn({ profile: f.profile, record, secret: SYNTHETIC_SECRET, omitProjection: true }),
      byok: { selection: f.selection, launcher: f.launcher, projectionRoot: f.projectionRoot },
    })).rejects.toThrow(/prepared_provider_projection_missing/u);
    expect(endpoint.bodies).toHaveLength(0);
  }, 60_000);

  it('refuses a launch the launcher delivered no credential for', async () => {
    const endpoint = await providerEndpoint();
    const f = await byokFixture(endpoint);
    const record: LauncherRecord = { logs: [] };
    await expect(startPrepared(f.prepared, {
      spawnFn: launcherSpawn({ profile: f.profile, record }),
      byok: { selection: f.selection, launcher: f.launcher, projectionRoot: f.projectionRoot },
    })).rejects.toThrow(/prepared_provider_credential_unavailable/u);
    expect(endpoint.bodies).toHaveLength(0);
  }, 60_000);

  it('refuses a prepared BYOK selection with no configured credential launcher', async () => {
    const endpoint = await providerEndpoint();
    const f = await byokFixture(endpoint);
    await expect(startPrepared(f.prepared, {
      byok: { selection: f.selection, projectionRoot: f.projectionRoot },
    })).rejects.toThrow(/credential-custody launcher/u);
    expect(endpoint.bodies).toHaveLength(0);
  }, 60_000);

  it('keeps the built-in-provider entry a direct spawn that declares the auth-store source', async () => {
    const endpoint = await providerEndpoint();
    const prepared = await prepareOnThisDevice(endpoint);
    let captured: { command: string; args: string[]; config: string } | undefined;
    const session = await startPrepared(prepared, {
      spawnFn: ((command: string, args: string[], spawnOptions: Record<string, unknown>) => {
        captured = { command, args: [...args], config: readFileSync(args.at(-1)!, 'utf8') };
        return nodeSpawn(command, args, spawnOptions as never);
      }) as PiAdapterOptions['spawnFn'],
    });
    expect(session.sessionRef.length).toBeGreaterThan(0);
    expect(captured!.command).toBe(process.execPath);
    expect(captured!.args.at(-2)).toBe('--config');
    expect(captured!.args).not.toContain('--runtime-entry');
    expect(captured!.args).not.toContain('--launch-binding');
    expect(JSON.parse(captured!.config).credentialSource).toBe('pi-auth-store');
  }, 60_000);

  it('gives each launch its own projection directory and removes it on release', async () => {
    const endpoint = await providerEndpoint();
    const f = await byokFixture(endpoint);
    const launched: { env: Readonly<Record<string, string>>; release: () => Promise<void> }[] = [];
    const records = [new Array<string>(), new Array<string>()].map((logs) => ({ logs } as LauncherRecord));
    const sessionsStarted = await Promise.all(records.map((record) => startPrepared(f.prepared, {
      spawnFn: launcherSpawn({ profile: f.profile, record, secret: SYNTHETIC_SECRET }),
      byok: { selection: f.selection, launcher: f.launcher, projectionRoot: f.projectionRoot },
      captureLaunch: (resources) => { launched.push(resources); },
    })));
    expect(sessionsStarted).toHaveLength(2);
    const dirs2 = launched.map((entry) => entry.env.PI_CODING_AGENT_DIR!);
    expect(new Set(dirs2).size).toBe(2);
    expect(new Set(records.map((record) => record.projectionDir)).size).toBe(2);
    for (const dir of dirs2) expect(await fs.readdir(dir)).toContain('models.json');
    for (const entry of launched) await entry.release();
    for (const dir of dirs2) await expect(fs.lstat(dir)).rejects.toMatchObject({ code: 'ENOENT' });

    // The refusal path releases the same way: the caller owns one cleanup
    // authority whether the child ran, refused, or died.
    const refused: { env: Readonly<Record<string, string>>; release: () => Promise<void> }[] = [];
    const record: LauncherRecord = { logs: [] };
    await expect(startPrepared(f.prepared, {
      spawnFn: launcherSpawn({ profile: f.profile, record }),
      byok: { selection: f.selection, launcher: f.launcher, projectionRoot: f.projectionRoot },
      captureLaunch: (resources) => { refused.push(resources); },
    })).rejects.toThrow(/prepared_provider_credential_unavailable/u);
    await expect(fs.lstat(refused[0]!.env.PI_CODING_AGENT_DIR!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(f.projectionRoot)).toEqual([]);
  }, 90_000);
});
