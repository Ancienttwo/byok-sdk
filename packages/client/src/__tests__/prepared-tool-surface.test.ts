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
import {
  assertToolImplementationBeforeSpawn,
  parseToolImplementationIdentity,
  realToolImplementationFsProbe,
  toolImplementationLaunchEnvNamesDigest,
  toolImplementationLoaderEnvValuesDigest,
  type ToolImplementationAttestedV1,
  type ToolImplementationAuthority,
  type ToolImplementationFsProbe,
} from '../daemon/tool-implementation-identity';
import type {
  CompilePreparedInputRequest,
  CompiledPreparedInput,
  InputPreparationCompiler,
} from '../adapters/pi/input-preparation';
import { trustedCwd } from './fixtures/launch-cwd';

/**
 * The environment this assembler hands to every server it spawns — the stand-in
 * for `buildRuntimeEnv`'s output, which carries no loader-affecting name.
 */
const ASSEMBLER_ENV: Readonly<Record<string, string>> = Object.freeze({ PATH: process.env.PATH ?? '' });

/**
 * The ONE prepared-tool-surface entry (`daemon/prepared-tool-surface.ts`),
 * driven against REAL MCP server children, a REAL toolset registry and the
 * REAL launch boundary of the machine the suite runs on.
 *
 * What these cases are for, stated as properties rather than as mechanisms:
 *
 * - The local control path and the remote envelope path produce the SAME tool
 *   manifest for the same `requiredToolsets`, byte for byte, because there is
 *   only one thing that can produce one. A path that grew its own observation
 *   would diverge here on the first schema, order or fingerprint difference.
 * - A preparation's servers start inside the proven launch boundary, so a
 *   `bunfig.toml` `preload` planted in a directory the agent can write never
 *   runs before a probed server's own first statement.
 * - An attested server is re-measured before the probe spawn, so a tampered
 *   install refuses the preparation instead of fingerprinting the replacement.
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
      readOnlyTools: { teamserver: ['echo'] },
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

const PROMPT = {
  cwd: '/workspace/project',
  toolSnippets: {},
  toolGuidelines: {},
  promptGuidelines: [],
  contextFiles: [],
  skills: [],
  docsPaths: { readmePath: 'README.md', docsPath: 'docs', examplesPath: 'examples' },
} as const;

const CONTEXT_JSON = JSON.stringify({
  prompt: PROMPT,
  messages: [{ role: 'user', content: 'prepare this turn', timestamp: 1_700_000_000_000 }],
});

const ALWAYS_AUTHORIZED: InputPreparationAuthorityResolver = {
  async resolveSource({ source }) { return { authorized: true, source }; },
  async resolveScope(claim) {
    return { authorized: true, grant: { scopeId: `scope:${claim.deviceId}`, ...claim } };
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
      upstreamBase: '0.85.1',
      upstreamCommit: 'd981de1229ef899957bbe968bc8dcda02a21f477',
      forkBuild: 1,
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
    permissionMode: 'auto',
    requiredToolsets: ['team'],
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
    requiredToolsets: ['team'],
    permissionMode: 'auto',
    ...overrides,
  });
}

function recordingCompletionClient() {
  const completions: InputPreparationCompletionRequest[] = [];
  return {
    completions,
    client: {
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
    expect(compiled[0]!.snapshot.prompt.selectedTools).toEqual(compiled[0]!.snapshot.tools.map((tool) => tool.name));
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

describe('a preparation observes inside the proven launch boundary', () => {
  it('starts every probed server in the trusted directory, with the planted preload unexecuted', async () => {
    const recordTo = path.join(await tempDir('byok-prepared-surface-record-'), 'record.jsonl');
    // The negative control: a `bunfig.toml` `preload` in a directory the agent
    // can write. It is only ever executed by a child whose cwd is that
    // directory, so the fixture's `preloaded` flag is the observable that
    // separates "started in the trusted directory" from "started in the
    // agent's own home".
    const agentWritable = await tempDir('byok-prepared-surface-home-');
    await fs.writeFile(path.join(agentWritable, 'bunfig.toml'), 'preload = ["./preload.mjs"]\n');
    await fs.writeFile(
      path.join(agentWritable, 'preload.mjs'),
      'globalThis.__BYOK_LAUNCH_CWD_PRELOADED__ = true;\n',
    );

    const result = await assembler(registryWith(recordTo)).assemble({
      requiredToolsets: ['team'],
      permissionMode: 'auto',
      runtimeIdentity: RUNTIME_IDENTITY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const start = JSON.parse((await fs.readFile(recordTo, 'utf8')).split('\n')[0]!) as {
      cwd: string;
      preloaded: boolean;
    };
    expect(start.cwd).toBe(await trustedCwd());
    expect(start.preloaded).toBe(false);
    expect(result.surface.launch.launchCwd).toBe(await trustedCwd());
  });
});

describe('a tampered install refuses the preparation before it is fingerprinted', () => {
  /**
   * The seam that lets a non-root test exercise the ownership rule
   * `resolveToolImplementationIdentity` enforces. Only ownership and the write
   * bits are overridden; the digest, the size and the inode are read off the
   * real file.
   */
  function rootOwnedProbe(): ToolImplementationFsProbe {
    return {
      async lstat(target) {
        const real = await realToolImplementationFsProbe.lstat(target);
        return { ...real, uid: 0, mode: real.mode & ~0o222 };
      },
      realpath: (target) => realToolImplementationFsProbe.realpath(target),
      digest: (target) => realToolImplementationFsProbe.digest(target),
    };
  }

  async function attestReal(installPath: string, probe: ToolImplementationFsProbe): Promise<ToolImplementationAttestedV1> {
    const stats = await probe.lstat(installPath);
    const identity = parseToolImplementationIdentity({
      kind: 'attested',
      authority: 'host-install-record',
      manifestRevision: 'fixture@1',
      form: 'compiled-executable',
      installPath,
      closureDigest: await probe.digest(installPath),
      closureKind: 'artifact',
      launchArgv: [],
      launchCwd: '/',
      // Measured off the same environment the assembler hands to `spawn`
      // (`runtimeEnv` above), because that is the fact an identity binds and
      // the gate re-measures. A fabricated pair would refuse every spawn here
      // for `launch_env_drift` instead of for the tampering under test.
      launchEnvNamesDigest: toolImplementationLaunchEnvNamesDigest(ASSEMBLER_ENV),
      loaderEnvValuesDigest: toolImplementationLoaderEnvValuesDigest(ASSEMBLER_ENV),
      installStat: {
        dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs,
        mode: stats.mode, uid: stats.uid, gid: stats.gid,
      },
    });
    return identity as ToolImplementationAttestedV1;
  }

  it('refuses a server whose attested artifact changed between the attestation and the probe', async () => {
    const probe = rootOwnedProbe();
    const artifact = path.join(await tempDir(), 'teamserver-install');
    await fs.writeFile(artifact, 'original bytes\n');
    const attested = await attestReal(artifact, probe);
    // Tampered AFTER the host attested it. The record still names a real file;
    // its bytes and its stat tuple are no longer the ones that were measured.
    await fs.writeFile(artifact, 'replaced bytes\n');

    const authority: ToolImplementationAuthority = {
      resolve: async () => ({
        kind: 'attested',
        authority: 'host-install-record',
        manifestRevision: attested.manifestRevision,
        form: 'compiled-executable',
        installPath: attested.installPath,
        closureDigest: attested.closureDigest,
        closureKind: 'artifact',
        launchArgv: [],
        launchCwd: '/',
      }),
    };

    const spawns: string[] = [];
    const result = await assembler(registryWith(), {
      toolImplementationAuthority: authority,
      toolImplementationFsProbe: probe,
      probe: async (serverName, server, options) => {
        spawns.push(serverName);
        return probeMcpServer(serverName, server, options);
      },
    }).assemble({ requiredToolsets: ['team'], permissionMode: 'auto', runtimeIdentity: RUNTIME_IDENTITY });

    // Resolution itself refuses to promote the record past the measurement, so
    // the identity that reaches the probe is `unavailable` rather than a claim
    // about a file that changed. The preparation still completes — it simply
    // proves nothing — and the receipt says so through the recorded kind.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(new Set(Object.values(result.surface.toolImplementationKinds))).toEqual(
      new Set(['unavailable:install_record_mismatch']),
    );
    expect(spawns).toEqual(['teamserver']);
  });

  it('refuses the whole preparation when an attested server no longer measures the same at the spawn gate', async () => {
    const probe = rootOwnedProbe();
    const artifact = path.join(await tempDir(), 'teamserver-install');
    await fs.writeFile(artifact, 'original bytes\n');
    const attested = await attestReal(artifact, probe);

    const authority: ToolImplementationAuthority = {
      resolve: async () => ({
        kind: 'attested',
        authority: 'host-install-record',
        manifestRevision: attested.manifestRevision,
        form: 'compiled-executable',
        installPath: attested.installPath,
        closureDigest: attested.closureDigest,
        closureKind: 'artifact',
        launchArgv: [],
        launchCwd: '/',
      }),
    };

    const result = await assembler(registryWith(), {
      toolImplementationAuthority: authority,
      toolImplementationFsProbe: probe,
      // Between resolve and spawn the artifact is replaced, which is what the
      // shared pre-spawn gate exists to catch: the preparation refuses rather
      // than fingerprinting the replacement under the original claim.
      probe: async (serverName, server, options) => {
        await fs.writeFile(artifact, 'replaced between resolve and spawn\n');
        return probeMcpServer(serverName, server, options);
      },
    }).assemble({ requiredToolsets: ['team'], permissionMode: 'auto', runtimeIdentity: RUNTIME_IDENTITY });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('toolsets_unobservable');
    expect(result.message).toMatch(/failed implementation reverification before launch/u);
  });

  it('spawns with the environment stage 1 measured, even when runtimeEnv answers differently the second time', async () => {
    // The two stages are two moments, and `deps.runtimeEnv()` is resolved per
    // call so an operator reload is never shadowed. A reload that lands
    // BETWEEN them must not make stage 2 spawn under an environment stage 1
    // never measured — that is `launch_env_drift` at the gate for a difference
    // the preparation itself introduced.
    const probe = rootOwnedProbe();
    const artifact = path.join(await tempDir(), 'teamserver-install');
    await fs.writeFile(artifact, 'original bytes\n');
    const attested = await attestReal(artifact, probe);

    const authority: ToolImplementationAuthority = {
      resolve: async () => ({
        kind: 'attested',
        authority: 'host-install-record',
        manifestRevision: attested.manifestRevision,
        form: 'compiled-executable',
        installPath: attested.installPath,
        closureDigest: attested.closureDigest,
        closureKind: 'artifact',
        launchArgv: [],
        launchCwd: '/',
      }),
    };

    let envCalls = 0;
    const spawnedEnvs: Readonly<Record<string, string>>[] = [];
    const result = await assembler(registryWith(), {
      // First answer: the environment the identity is measured against.
      // Every later answer carries an extra name, which would move the names
      // digest and refuse the spawn if stage 2 asked again.
      runtimeEnv: () => {
        envCalls += 1;
        return envCalls === 1
          ? { ...ASSEMBLER_ENV }
          : { ...ASSEMBLER_ENV, RELOADED_BETWEEN_STAGES: '1' };
      },
      toolImplementationAuthority: authority,
      toolImplementationFsProbe: probe,
      probe: async (serverName, server, options) => {
        const env = options.env ?? {};
        spawnedEnvs.push(env);
        // The pre-spawn gate `mcp/client.ts` asks before it starts the child,
        // asked here with the ownership seam a non-root test needs —
        // `probeMcpServer` forwards no fs probe, so the real one inside it
        // would refuse every identity this suite attests as root-owned. The
        // identity is then withheld from the real probe so the gate is asked
        // exactly once, on the evidence under test.
        const { implementation, ...withoutIdentity } = options;
        await assertToolImplementationBeforeSpawn(
          `MCP toolset server ${JSON.stringify(serverName)}`,
          implementation,
          env,
          probe,
        );
        return probeMcpServer(serverName, server, withoutIdentity);
      },
    }).assemble({ requiredToolsets: ['team'], permissionMode: 'auto', runtimeIdentity: RUNTIME_IDENTITY });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // The gate passed: the identity stayed attested rather than refusing the
    // preparation for drift the stub's second answer would have produced.
    expect(new Set(Object.values(result.surface.toolImplementationKinds))).toEqual(new Set(['attested']));
    expect(spawnedEnvs).toHaveLength(1);
    expect(spawnedEnvs[0]).not.toHaveProperty('RELOADED_BETWEEN_STAGES');
    expect(toolImplementationLaunchEnvNamesDigest(spawnedEnvs[0]!))
      .toBe(toolImplementationLaunchEnvNamesDigest(ASSEMBLER_ENV));
  });

  it('carries the measured environment on the binding, so stage 1 alone answers it', async () => {
    let envCalls = 0;
    const binding = await assembler(registryWith(), {
      runtimeEnv: () => {
        envCalls += 1;
        return envCalls === 1 ? { ...ASSEMBLER_ENV } : { ...ASSEMBLER_ENV, RELOADED: '1' };
      },
    }).resolveBinding({ requiredToolsets: ['team'] });
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
          readOnlyTools: { teamserver: ['echo'] },
        },
      },
      registry.snapshot().revision,
    );

    await expect(service.prepare(localRequest())).rejects.toMatchObject({ code: 'observation_drift' });
    // Refused on evidence that costs no spawn: the replay never re-observed.
    expect(spawns).toEqual(['teamserver']);
  });
});

describe('the declared permission mode is intent, admitted by the device', () => {
  it('refuses a mode above the operator ceiling instead of narrowing it', async () => {
    // The same merge a task offer goes through (`daemon/policy.ts`'s
    // `computeEffectivePolicy`, which `TaskRunner.handleOffer` calls with this
    // exact ceiling). Parsing the enum is not admission.
    const spawns: string[] = [];
    const result = await assembler(registryWith(), {
      permissionCeiling: { mode: 'readonly' },
      probe: async (serverName, server, options) => {
        spawns.push(serverName);
        return probeMcpServer(serverName, server, options);
      },
    }).assemble({ requiredToolsets: ['team'], permissionMode: 'auto', runtimeIdentity: RUNTIME_IDENTITY });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('permission_mode_denied');
    // Never a downgrade to the ceiling's mode, and never a spawn: an
    // unadmitted preparation observes nothing.
    expect(spawns).toEqual([]);
  });

  it('filters the manifest through the operator classification the admitted mode requires', async () => {
    // `readonly` narrows, and it narrows through the ONE policy filter the
    // ordinary extension registers through. The fixture toolset classifies
    // exactly one of its two tools read-only.
    const result = await assembler(registryWith(), { permissionCeiling: { mode: 'readonly' } }).assemble({
      requiredToolsets: ['team'],
      permissionMode: 'readonly',
      runtimeIdentity: RUNTIME_IDENTITY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    expect(result.surface.tools.map((tool) => tool.name)).toEqual(['mcp__teamserver__echo']);
    // The schemas the model is shown and the executors the manifest binds are
    // the same set — the filter runs once, before both.
    expect(Object.keys(result.surface.toolExecutors)).toEqual(['mcp__teamserver__echo']);
    expect(Object.keys(result.surface.toolImplementationKinds)).toEqual(['mcp__teamserver__echo']);
  });
});

describe('the native tool set is PARTIAL and pinned as such', () => {
  it('compiles the observed MCP half only, and says so', async () => {
    // PARTIAL — the prepared NATIVE tool set is not connected to preparation.
    // Pi's own tools are selected by a runtime policy a task-free preparation
    // never resolves, so the entry passes `nativeTools: []`; the final Main set
    // (Q1 = policy-filtered native + MCP) stays the runtime's decision.
    // Removing that limit must change this test.
    const result = await assembler(registryWith()).assemble({
      requiredToolsets: ['team'],
      permissionMode: 'auto',
      runtimeIdentity: RUNTIME_IDENTITY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    expect(result.surface.tools.length).toBeGreaterThan(0);
    expect(result.surface.tools.every((tool) => tool.name.startsWith('mcp__'))).toBe(true);
    expect(Object.keys(result.surface.toolExecutors).every((name) => name.startsWith('mcp__'))).toBe(true);
  });
});
