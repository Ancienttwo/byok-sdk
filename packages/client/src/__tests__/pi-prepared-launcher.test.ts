import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionPolicy, TaskOfferPayload } from '@byok-sdk/protocol';
import {
  getDocsPath,
  getExamplesPath,
  getReadmePath,
  projectSystemPromptSnapshot,
} from '@earendil-works/pi-coding-agent';
import {
  INPUT_PREPARATION_ARTIFACT_FORMAT,
  INPUT_PREPARATION_VERSION,
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
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { createPiInputPreparationCompiler } from '../adapters/pi/input-preparation';
import { trustedLaunchBinding } from './fixtures/launch-cwd';

/**
 * The NATIVE canonicalization, not a local one.
 *
 * The one case below that rebuilds a consistent envelope has to hash exactly
 * what the fork hashes; a key-sorted serializer written here could agree today
 * and diverge on the first value where the two definitions differ.
 */
async function nativeDigest(value: unknown): Promise<string> {
  const { canonicalPreparedValue } = await import('@earendil-works/pi-coding-agent/prepared-session-input');
  return createHash('sha256').update(canonicalPreparedValue(value), 'utf8').digest('hex');
}

/**
 * The SDK-owned prepared launch entry (`bin/byok-pi-prepared.ts`), driven
 * end to end: the REAL pi adapter, the REAL shipped bin, the REAL fork session,
 * a REAL MCP server child in the REAL launch boundary of this machine, and a
 * REAL provider endpoint this suite runs and reads the request bytes off.
 *
 * Nothing about the pi adapter is stubbed — `resolveExtensions` least of all:
 * the prepared branch must not need the extension resolution the ordinary lane
 * uses, and stubbing it would hide a prepared launch that quietly depended on
 * it.
 *
 * The properties:
 *
 * - The bytes that reach the provider are D — the exact request body the native
 *   compiler produced, byte for byte. Not "equivalent", not "recompiled": the
 *   comparison is `===` against the artifact's own `requestBody`.
 * - Every drift the native session detects is reported as its typed code and is
 *   detected BEFORE the transport: the provider endpoint records zero requests
 *   in each of those cases, which is asserted, not assumed.
 * - A prepared reservation refuses the ordinary `prompt` rather than queueing
 *   it, and `get_state` reports the same session id the admission did.
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
  const endpoint: ProviderEndpoint = {
    baseUrl: '',
    bodies,
    respond(_req, res) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(completion('done')));
    },
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
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

const POLICY: PermissionPolicy = { mode: 'readonly', allowTools: [] };

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
    prompt: ReturnType<typeof projectSystemPromptSnapshot>;
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
  const compiler = createPiInputPreparationCompiler();
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

  // The prompt the prepared session will project for ITSELF: a zero-resource
  // loader, and `baseToolsOverride` tools carry no prompt snippet or guideline
  // into the registry (`createToolDefinitionFromAgentTool` keeps neither).
  const snapshot = {
    prompt: projectSystemPromptSnapshot({
      cwd: workspaceDir,
      selectedTools: surface.tools.map((tool) => tool.name),
      toolSnippets: {},
      promptGuidelines: [],
      contextFiles: [],
      formattedSkills: '',
      docsPaths: { readmePath: getReadmePath(), docsPath: getDocsPath(), examplesPath: getExamplesPath() },
    }),
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

/** Start the prepared operation through the REAL adapter, with nothing stubbed. */
async function startPrepared(
  prepared: Prepared,
  overrides: { preparation?: RuntimePreparedLaunchV1; sessionRef?: string } = {},
): Promise<Session> {
  const adapter = new PiAdapter();
  const offer: TaskOfferPayload = {
    taskId: 'prepared-launch-test',
    instruction: 'unused on the prepared lane',
    policy: POLICY,
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
    ...(overrides.sessionRef === undefined ? {} : { sessionRef: overrides.sessionRef }),
    workspace: { workspaceDir: prepared.workspaceDir },
    forwardedEnvironmentNames: Object.keys(prepared.childEnv).sort(),
  });
  const session = await result.operation.start({
    kind: 'prepared',
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
}

/** Rewrite the artifact in place so the envelope no longer matches the device. */
async function tamper(prepared: Prepared, mutate: (envelope: Record<string, unknown>) => void): Promise<void> {
  const artifact = JSON.parse(await fs.readFile(prepared.artifactPath, 'utf8')) as Record<string, unknown>;
  mutate(artifact.envelope as Record<string, unknown>);
  await fs.writeFile(prepared.artifactPath, JSON.stringify(artifact));
}

describe('the prepared pi launch entry', () => {
  it('sends the counted request body verbatim and reports the admitted session id', async () => {
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
  }, 60_000);

  it('refuses the ordinary prompt while the prepared reservation holds the session', async () => {
    const endpoint = await providerEndpoint();
    // The response is held open, so the reservation is still live when the
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
    expect(refusal.code).toBe('prepared_session_reserved');
    release?.();
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

  it('reports a tampered snapshot as prepared_context_drift, before any transport', async () => {
    const endpoint = await providerEndpoint();
    const prepared = await prepareOnThisDevice(endpoint);
    await tamper(prepared, (envelope) => {
      const snapshot = envelope.snapshot as { prompt: { promptGuidelines: string[] } };
      snapshot.prompt.promptGuidelines = ['a guideline nobody counted'];
    });
    await expect(startPrepared(prepared)).rejects.toThrow(/prepared_context_drift/u);
    expect(endpoint.bodies).toHaveLength(0);
  }, 60_000);

  // `prepared_model_drift` is a LATER fork: it is what the session reports when
  // its own resolved model disagrees with the expectation. The expectation
  // handed in here is checked first, against the model the envelope itself
  // carries (`verifyPreparedSessionInput`, fork 0.85.1002's
  // `dist/core/prepared-session-input.js`), so an expectation nobody counted is
  // reported as `prepared_expectation_mismatch` and never reaches the session
  // comparison. The single code is pinned rather than an alternation, so a fork
  // bump that moves this case to the other fork fails here instead of passing
  // quietly.
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
