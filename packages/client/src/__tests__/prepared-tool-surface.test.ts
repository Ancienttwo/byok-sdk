import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentInputPreparationPayloadSchema,
  type AgentInputPreparationPayload,
  type InputPreparationCompletionRequest,
} from '@byok-sdk/protocol';
import {
  INPUT_PREPARATION_REQUEST_FORMAT,
  INPUT_PREPARATION_VERSION,
  validateInputPreparationLimits,
  type InputPreparationAuthorityResolver,
  type InputPreparationCounterRequestV1,
  type InputPreparationCounterResultV1,
  type InputPreparationLimitsPolicyV1,
  type InputPreparationRequestV1,
} from '../input-preparation';
import {
  createInputPreparationService,
  type InputPreparationService,
} from '../daemon/input-preparation-service';
import { createRemoteInputPreparationHandler } from '../daemon/input-preparation-remote';
import type { InputPreparationCompletionClient } from '../daemon/input-preparation-completion-client';
import {
  createPreparedToolSurfaceAssembler,
  type PreparedToolSurfaceAssembler,
  type PreparedToolSurfaceDeps,
} from '../daemon/prepared-tool-surface';
import { McpToolsetRegistry } from '../daemon/toolset-registry';
import { probeMcpServer } from '../daemon/mcp-tools-probe';
import type {
  CompilePreparedInputRequest,
  CompiledPreparedInput,
  InputPreparationCompiler,
} from '../adapters/pi/input-preparation';
import * as preparedAgentMemory from '../daemon/prepared-agent-memory';
import type { PreparedAgentMemoryState } from '../daemon/prepared-agent-memory';
import { validatePreparedAgentMemoryObservation } from '../agent-memory/prepared-capability';
import { AGENT_MEMORY_MCP_SERVER_INFO, AGENT_MEMORY_TOOLS } from '../bin/agent-memory-mcp-server';

/**
 * The environment this assembler hands to every server it spawns — the stand-in
 * for `buildRuntimeEnv`'s output, which carries no loader-affecting name.
 */
const ASSEMBLER_ENV: Readonly<Record<string, string>> = Object.freeze({ PATH: process.env.PATH ?? '' });

/**
 * The ONE prepared-tool-surface entry (`daemon/prepared-tool-surface.ts`),
 * driven against REAL MCP server children and a REAL toolset registry.
 *
 * What these cases are for, stated as properties rather than as mechanisms:
 *
 * - The local control path and the remote envelope path produce the SAME tool
 *   manifest for the same `requiredToolsets`, byte for byte, because there is
 *   only one thing that can produce one. A path that grew its own observation
 *   would diverge here on the first schema, order or fingerprint difference.
 * - One `requestId` yields one observation. A repeat answers from the durable
 *   record without starting anything, and refuses outright if the evidence it
 *   was frozen against moved.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));
const RUNTIME_IDENTITY = '@byok-sdk/pi-coding-agent@0.85.1002+test.1';

const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()?.();
  await Promise.all(dirs.splice(0).map(
    (dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  ));
});

async function tempDir(prefix = 'byok-prepared-surface-'): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function fixtureServer(config: Record<string, unknown> = {}): { command: string; args: string[] } {
  return { command: process.execPath, args: [FIXTURE, JSON.stringify(config)] };
}

function registryWith(recordTo?: string): McpToolsetRegistry {
  return new McpToolsetRegistry({
    team: {
      mcpServers: {
        teamserver: fixtureServer(recordTo === undefined ? {} : { recordTo }),
      },
    },
  });
}

/** The real assembler, with only the seams a non-root test cannot otherwise reach. */
function assembler(
  registry: McpToolsetRegistry,
  extra: Partial<PreparedToolSurfaceDeps> = {},
): PreparedToolSurfaceAssembler {
  return createPreparedToolSurfaceAssembler({
    toolsetRegistry: registry,
    runtimeEnv: () => ({ ...ASSEMBLER_ENV }),
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// One entry, two paths
// ---------------------------------------------------------------------------

const LIMITS: InputPreparationLimitsPolicyV1 = validateInputPreparationLimits({
  revision: 'limits-rev-surface',
  maxRequestBytes: 256_000,
  maxArtifactBytes: 400_000,
  maxScopeAggregateBytes: 800_000,
  maxInFlight: 4,
  maxCounterCallsPerScope: 8,
  counterTimeoutMs: 5_000,
  preparationDeadlineMs: 8_000,
  retentionMs: 60_000,
  retryHorizonMs: 30_000,
});

const PROMPT = { systemPrompt: 'Host fixture instructions' } as const;

const CONTEXT_JSON = JSON.stringify({
  prompt: PROMPT,
  messages: [{ role: 'user', content: 'prepare this turn', timestamp: 1_700_000_000_000 }],
});

const ALWAYS_AUTHORIZED: InputPreparationAuthorityResolver = {
  async resolveSource({ source }) { return { authorized: true, source }; },
  async resolveScope(claim) {
    return { authorized: true, grant: { agentMemory: 'none', scopeId: `scope:${claim.deviceId}`, ...claim } };
  },
};

interface StubCompiler extends InputPreparationCompiler {
  readonly calls: CompilePreparedInputRequest[];
}

/**
 * A stub compiler, because the subject here is the OBSERVATION, not the native
 * compile — `pi-input-preparation.test.ts` owns that. It captures what it was
 * handed so the two paths can be compared field by field.
 */
function stubCompiler(): StubCompiler {
  const calls: CompilePreparedInputRequest[] = [];
  return {
    calls,
    runtime: {
      packageName: '@byok-sdk/pi-coding-agent',
      packageVersion: '0.85.1002',
      tarballIntegrity: 'sha512-'+ 'YQ=='.repeat(1),
      upstreamCommit: 'd981de1229ef899957bbe968bc8dcda02a21f477',
      provenanceDigest: 'a'.repeat(64), closureDigest: 'b'.repeat(64),
      envelopeFormat: 'pi.session.prepared-input',
      requestFormat: 'pi.openai-completions.prepared',
      compilerVersion: 2,
    },
    async compile(request: CompilePreparedInputRequest): Promise<CompiledPreparedInput> {
      calls.push(structuredClone(request) as CompilePreparedInputRequest);
      const body = JSON.stringify({ tools: request.snapshot.tools.length });
      return {
        requestBody: body,
        counterProjection: '{}',
        requestBytes: Buffer.byteLength(body, 'utf8'),
        projectionBytes: 2,
        requestDigest: 'a'.repeat(64),
        envelopeDigest: 'b'.repeat(64),
        toolManifestDigest: 'c'.repeat(64),
        projection: {
          version: 3,
          kind: 'content_complete',
          digest: createHash('sha256').update('{}', 'utf8').digest('hex'),
        },
        residual: [{ key: 'max_tokens', valueClass: 'bounded_integer' }],
        envelope: { format: 'pi.session.prepared-input', version: 3 } as never,
      };
    },
  };
}

function fixtureCounter() {
  const calls: InputPreparationCounterRequestV1[] = [];
  return {
    calls,
    async count(request: InputPreparationCounterRequestV1): Promise<InputPreparationCounterResultV1> {
      calls.push(request);
      return {
        method: 'fixture.tokenizer',
        methodVersion: '0',
        authority: 'test_fixture',
        value: 7,
        coverage: { covered: true },
        providerEvidence: {
          projectionDigest: createHash('sha256').update(request.counterProjection, 'utf8').digest('hex'),
          endpoint: request.target.endpoint,
          modelId: request.target.modelId,
          asserted: { httpStatus: 200, usageFields: { prompt_tokens: 7 }, responseDigest: 'e'.repeat(64) },
        },
      };
    },
  };
}

async function makeService(
  toolSurface: PreparedToolSurfaceAssembler,
  compiler: StubCompiler,
  counter: ReturnType<typeof fixtureCounter>,
): Promise<InputPreparationService> {
  const service = createInputPreparationService({
    storeDir: await tempDir('byok-prepared-surface-store-'),
    limits: LIMITS,
    authorityResolver: ALWAYS_AUTHORIZED,
    counter,
    compiler,
    toolSurface,
  });
  await service.open();
  cleanups.push(() => service.stop());
  return service;
}

function localRequest(overrides: Partial<InputPreparationRequestV1> = {}): InputPreparationRequestV1 {
  return {
    format: INPUT_PREPARATION_REQUEST_FORMAT,
    version: INPUT_PREPARATION_VERSION,
    requestId: 'prep-local-1',
    policyRevision: LIMITS.revision,
    scope: { deviceId: 'device-1', agentRef: 'agent-1', profileId: 'profile-1', profileRevision: 'profile-rev-1' },
    source: { revision: 'src-rev-1', digest: 'src-digest-1' },
    selection: {
      model: {
        id: 'glm-4.6',
        name: 'GLM 4.6',
        api: 'openai-completions',
        provider: 'zai',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        reasoning: false,
        input: ['text'],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
      options: { cacheRetention: 'none', maxTokens: 4_096 },
    },
    agentMemory: 'none', requiredToolsets: ['team'],
    snapshot: JSON.parse(CONTEXT_JSON) as InputPreparationRequestV1['snapshot'],
    ...overrides,
  };
}

function remotePayload(overrides: Record<string, unknown> = {}): AgentInputPreparationPayload {
  const local = localRequest();
  return AgentInputPreparationPayloadSchema.parse({
    requestId: '10000000-0000-4000-8000-000000000901',
    agentRef: { agentId: 'agent-1', profileRevision: 'profile-rev-1' },
    profileId: 'profile-1',
    policyRevision: LIMITS.revision,
    source: local.source,
    selection: local.selection,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    context: { inline: CONTEXT_JSON },
    agentMemory: 'none', requiredToolsets: ['team'],
    ...overrides,
  });
}

function recordingCompletionClient() {
  const completions: InputPreparationCompletionRequest[] = [];
  return {
    completions,
    client: {
      async readCompleted() { return completions.at(-1); },
      async complete(input: InputPreparationCompletionRequest) {
        completions.push(structuredClone(input) as InputPreparationCompletionRequest);
        return {} as never;
      },
    } as unknown as InputPreparationCompletionClient,
  };
}

describe('one assembly entry, consumed by both preparation paths', () => {
  it('gives the local and the remote path a byte-identical tool manifest', async () => {
    const compiled: CompilePreparedInputRequest[] = [];

    const localCompiler = stubCompiler();
    const localCounter = fixtureCounter();
    const localService = await makeService(assembler(registryWith()), localCompiler, localCounter);
    await localService.prepare(localRequest());
    compiled.push(localCompiler.calls[0]!);

    const remoteCompiler = stubCompiler();
    const remoteCounter = fixtureCounter();
    const remoteService = await makeService(assembler(registryWith()), remoteCompiler, remoteCounter);
    const handle = createRemoteInputPreparationHandler({
      deviceId: 'device-1',
      service: remoteService,
      limits: LIMITS,
      completion: recordingCompletionClient().client,
      resolveBlobText: async () => { throw new Error('inline only'); },
    });
    const completion = await handle(remotePayload());
    expect(completion.outcome).toBe('prepared');
    compiled.push(remoteCompiler.calls[0]!);

    // The whole manifest, serialized: names, descriptions, schemas, order, and
    // the executor fingerprint of every one of them. Two paths that each grew
    // their own observation could agree on names and still differ here.
    expect(JSON.stringify(compiled[1]!.snapshot.tools)).toBe(JSON.stringify(compiled[0]!.snapshot.tools));
    expect(JSON.stringify(compiled[1]!.toolExecutors)).toBe(JSON.stringify(compiled[0]!.toolExecutors));
    expect(Object.keys(compiled[0]!.snapshot.prompt)).toEqual(['systemPrompt']);
    expect(Object.keys(compiled[0]!.toolExecutors)).toEqual([
      'mcp__teamserver__echo',
      'mcp__teamserver__find_leads',
    ]);
  });

  it('routes both the local and the remote request through the one injected assembler, once each', async () => {
    // The structural half of the property above. Both paths reach the SAME
    // assembler object, so an observation produced anywhere else is an
    // observation this counter never saw.
    const calls: string[] = [];
    const real = assembler(registryWith());
    const counted: PreparedToolSurfaceAssembler = {
      resolveBinding: (input) => {
        calls.push('resolveBinding');
        return real.resolveBinding(input);
      },
      assemble: (input) => {
        calls.push('assemble');
        return real.assemble(input);
      },
    };
    const compiler = stubCompiler();
    const service = await makeService(counted, compiler, fixtureCounter());

    await service.prepare(localRequest());
    expect(calls).toEqual(['assemble']);

    const handle = createRemoteInputPreparationHandler({
      deviceId: 'device-1',
      service,
      limits: LIMITS,
      completion: recordingCompletionClient().client,
      resolveBlobText: async () => { throw new Error('inline only'); },
    });
    await handle(remotePayload());
    expect(calls).toEqual(['assemble', 'assemble']);
    // Two preparations, two compiles, and every tool in both came from the
    // entry above — the compiler is handed no other source.
    expect(compiler.calls).toHaveLength(2);
  });
});

describe('the two assembly stages share one measured environment', () => {
  it('spawns with the environment stage 1 measured, even when runtimeEnv answers differently the second time', async () => {
    // The two stages are two moments, and `deps.runtimeEnv()` is resolved per
    // call so an operator reload is never shadowed. A reload that lands
    // BETWEEN them must not make stage 2 spawn under an environment stage 1
    // never measured.
    let envCalls = 0;
    const spawnedEnvs: Readonly<Record<string, string>>[] = [];
    const result = await assembler(registryWith(), {
      runtimeEnv: () => {
        envCalls += 1;
        return envCalls === 1
          ? { ...ASSEMBLER_ENV }
          : { ...ASSEMBLER_ENV, RELOADED_BETWEEN_STAGES: '1' };
      },
      probe: async (serverName, server, options) => {
        spawnedEnvs.push(options.env ?? {});
        return probeMcpServer(serverName, server, options);
      },
    }).assemble({ agentMemory: 'none', requiredToolsets: ['team'], runtimeIdentity: RUNTIME_IDENTITY });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(spawnedEnvs).toHaveLength(1);
    expect(spawnedEnvs[0]).not.toHaveProperty('RELOADED_BETWEEN_STAGES');
    expect(Object.keys(spawnedEnvs[0]!).sort()).toEqual(Object.keys(ASSEMBLER_ENV).sort());
  });

  it('carries the measured environment on the binding, so stage 1 alone answers it', async () => {
    let envCalls = 0;
    const binding = await assembler(registryWith(), {
      runtimeEnv: () => {
        envCalls += 1;
        return envCalls === 1 ? { ...ASSEMBLER_ENV } : { ...ASSEMBLER_ENV, RELOADED: '1' };
      },
    }).resolveBinding({ agentMemory: 'none', requiredToolsets: ['team'] });
    expect(binding.ok).toBe(true);
    if (!binding.ok) throw new Error('unreachable');
    expect(envCalls).toBe(1);
    expect(binding.binding.launchEnv).toEqual(ASSEMBLER_ENV);
  });
});

describe('one requestId, one observation', () => {
  it('answers a replay from the durable record without starting a single server', async () => {
    const spawns: string[] = [];
    const registry = registryWith();
    const counting = assembler(registry, {
      probe: async (serverName, server, options) => {
        spawns.push(serverName);
        return probeMcpServer(serverName, server, options);
      },
    });
    const compiler = stubCompiler();
    const counter = fixtureCounter();
    const service = await makeService(counting, compiler, counter);

    const first = await service.prepare(localRequest());
    expect(spawns).toEqual(['teamserver']);

    const replayed = await service.prepare(localRequest());
    // The whole point: no second probe, no second compile, no second count,
    // and the same receipt.
    expect(spawns).toEqual(['teamserver']);
    expect(compiler.calls).toHaveLength(1);
    expect(counter.calls).toHaveLength(1);
    expect(replayed).toEqual(first);
  });

  it('refuses a replay after a toolsets.reload changed the definition the manifest was frozen against', async () => {
    const spawns: string[] = [];
    const registry = registryWith();
    const counting = assembler(registry, {
      probe: async (serverName, server, options) => {
        spawns.push(serverName);
        return probeMcpServer(serverName, server, options);
      },
    });
    const service = await makeService(counting, stubCompiler(), fixtureCounter());
    await service.prepare(localRequest());
    expect(spawns).toEqual(['teamserver']);

    // The operator changes the toolset's server argv. Same toolset id, same
    // requestId — a different definition revision, so the frozen fingerprints
    // no longer describe this device.
    registry.reload(
      {
        team: {
          mcpServers: { teamserver: fixtureServer({ protocolVersion: '2025-06-18' }) },
        },
      },
      registry.snapshot().revision,
    );

    await expect(service.prepare(localRequest())).rejects.toMatchObject({ code: 'observation_drift' });
    // Refused on evidence that costs no spawn: the replay never re-observed.
    expect(spawns).toEqual(['teamserver']);
  });
});

describe('the native tool set is PARTIAL and pinned as such', () => {
  it('compiles the observed MCP half only, and says so', async () => {
    // PARTIAL — the prepared NATIVE tool set is not connected to preparation.
    // Pi's own tools are selected by the runtime, which a task-free preparation
    // never resolves, so the entry passes `nativeTools: []`; the final Main set
    // (Q1 = native + MCP) stays the runtime's decision.
    // Removing that limit must change this test.
    const result = await assembler(registryWith()).assemble({
      agentMemory: 'none', requiredToolsets: ['team'],
      runtimeIdentity: RUNTIME_IDENTITY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    expect(result.surface.tools.length).toBeGreaterThan(0);
    expect(result.surface.tools.every((tool) => tool.name.startsWith('mcp__'))).toBe(true);
    expect(Object.keys(result.surface.toolExecutors).every((name) => name.startsWith('mcp__'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Prepared Agent memory: typed preparation refusals and replay without a probe
// ---------------------------------------------------------------------------

/** An SDK memory descriptor helper whose artifact is a REAL file. `body` is the child's whole behaviour. */
async function memoryHelper(body: string): Promise<{ describe: { command: string; args: readonly string[] } }> {
  const script = path.join(await tempDir('byok-prepared-memory-helper-'), 'agent-memory-helper');
  await fs.writeFile(script, body);
  await fs.chmod(script, 0o755);
  return { describe: { command: script, args: ['__byok_sdk_helper', 'agent-memory-describe'] } };
}

function memoryAssembler(describe: { command: string; args: readonly string[] }, memoryAvailable = true): PreparedToolSurfaceAssembler {
  return assembler(new McpToolsetRegistry({}), {
    memoryAvailable: () => memoryAvailable,
    agentMemoryDescribe: describe,
  });
}

const MEMORY_ONLY = { agentMemory: 'read', requiredToolsets: [], runtimeIdentity: RUNTIME_IDENTITY } as const;

describe('prepared Agent memory refuses a preparation by its typed C5 code', () => {
  it('refuses an unavailable secure platform as unsupported_input / agent_memory_unavailable before any helper is started', async () => {
    const helper = await memoryHelper('#!/bin/sh\nexit 0\n');
    const observe = vi.spyOn(preparedAgentMemory, 'observePreparedMemory');
    const result = await memoryAssembler(helper.describe, false).assemble(MEMORY_ONLY);
    expect(result).toMatchObject({ ok: false, code: 'unsupported_input', detail: 'agent_memory_unavailable' });
    expect(observe).not.toHaveBeenCalled();
  });

  it('refuses a descriptor that cannot be observed as toolsets_unobservable / agent_memory_descriptor_unobservable, never dropping memory', async () => {
    // A real descriptor child that exits before `initialize`.
    const helper = await memoryHelper('#!/bin/sh\nexit 3\n');
    const result = await memoryAssembler(helper.describe).assemble(MEMORY_ONLY);
    expect(result).toMatchObject({ ok: false, code: 'toolsets_unobservable', detail: 'agent_memory_descriptor_unobservable' });
  });
});

describe('a memory preparation replay never probes the descriptor again', () => {
  const OBSERVED: PreparedAgentMemoryState['observation'] = validatePreparedAgentMemoryObservation({
    serverInfo: AGENT_MEMORY_MCP_SERVER_INFO,
    protocolVersion: '2025-03-26',
    tools: AGENT_MEMORY_TOOLS.map(({ name, description, inputSchema, _meta }) => ({ name, description, inputSchema, _meta })),
  });

  async function memoryService(describe: { command: string; args: readonly string[] }) {
    const compiler = stubCompiler();
    const service = createInputPreparationService({
      storeDir: await tempDir('byok-prepared-memory-replay-store-'),
      limits: LIMITS,
      authorityResolver: {
        ...ALWAYS_AUTHORIZED,
        async resolveScope(claim) { return { authorized: true, grant: { agentMemory: 'read', scopeId: `scope:${claim.deviceId}`, ...claim } }; },
      },
      counter: fixtureCounter(),
      compiler,
      toolSurface: memoryAssembler(describe),
    });
    await service.open();
    cleanups.push(() => service.stop());
    return { service, compiler };
  }

  it('answers a replay from the durable record with one descriptor observation in total', async () => {
    const helper = await memoryHelper('#!/bin/sh\nexit 0\n');
    const observe = vi.spyOn(preparedAgentMemory, 'observePreparedMemory')
      .mockImplementation(async () => ({ observation: OBSERVED }));
    const { service, compiler } = await memoryService(helper.describe);
    const request = localRequest({ agentMemory: 'read', requiredToolsets: [] });

    const first = await service.prepare(request);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(compiler.calls[0]!.snapshot.tools.map((tool) => tool.name)).toEqual(['memory_recall']);

    expect(await service.prepare(request)).toEqual(first);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(compiler.calls).toHaveLength(1);
  });
});

describe('a tool-less preparation (requiredToolsets [] and agentMemory none)', () => {
  const TOOLLESS = { agentMemory: 'none', requiredToolsets: [], runtimeIdentity: RUNTIME_IDENTITY } as const;

  it('is counted with an empty manifest and no server probed', async () => {
    const spawns: string[] = [];
    const bound = await assembler(registryWith()).resolveBinding({ agentMemory: 'none', requiredToolsets: [] });
    if (!bound.ok) throw new Error(`${bound.code}: ${bound.detail}`);
    expect(bound.binding.servers).toEqual([]);
    expect(bound.binding.toolsetDefinitionRevisions).toEqual({});

    const result = await assembler(registryWith(), {
      probe: async (serverName, server, options) => {
        spawns.push(serverName);
        return probeMcpServer(serverName, server, options);
      },
    }).assemble(TOOLLESS);
    if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
    expect(result.surface.tools).toEqual([]);
    expect(result.surface.toolExecutors).toEqual({});
    expect(result.surface.toolNames).toEqual([]);
    // The binding digest is the same one stage 1 alone answered.
    expect(result.surface.toolBindingDigest).toBe(bound.binding.toolBindingDigest);
    expect(spawns).toEqual([]);
  });

  it('answers a replay from the durable record, and no longer depends on toolsets it never named', async () => {
    const spawns: string[] = [];
    const registry = registryWith();
    const counting = assembler(registry, {
      probe: async (serverName, server, options) => {
        spawns.push(serverName);
        return probeMcpServer(serverName, server, options);
      },
    });
    const compiler = stubCompiler();
    const counter = fixtureCounter();
    const service = await makeService(counting, compiler, counter);
    const request = localRequest({ requiredToolsets: [] });

    const first = await service.prepare(request);
    expect(compiler.calls).toHaveLength(1);
    expect(compiler.calls[0]!.snapshot.tools).toEqual([]);
    expect(compiler.calls[0]!.toolExecutors).toEqual({});

    // The operator changes a toolset this record never named: same requestId,
    // and the replay is still the same answer from the same record.
    registry.reload(
      { team: { mcpServers: { teamserver: fixtureServer({ protocolVersion: '2025-06-18' }) } } },
      registry.snapshot().revision,
    );
    expect(await service.prepare(request)).toEqual(first);
    expect(compiler.calls).toHaveLength(1);
    expect(counter.calls).toHaveLength(1);
    expect(spawns).toEqual([]);
  });
});
