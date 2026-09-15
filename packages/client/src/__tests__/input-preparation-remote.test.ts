import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentInputPreparationPayloadSchema,
  type AgentInputPreparationPayload,
  type InputPreparationCompletionRequest,
} from '@byok-sdk/protocol';
import {
  validateInputPreparationLimits,
  type InputPreparationAuthorityResolver,
  type InputPreparationCounterRequestV1,
  type InputPreparationCounterResultV1,
  type InputPreparationLimitsPolicyV1,
} from '../input-preparation';
import {
  createInputPreparationService,
  type InputPreparationService,
} from '../daemon/input-preparation-service';
import {
  createRemoteInputPreparationHandler,
  type RemoteInputPreparationDeps,
  type RemoteInputPreparationObservation,
} from '../daemon/input-preparation-remote';
import type { InputPreparationCompletionClient } from '../daemon/input-preparation-completion-client';
import type {
  CompilePreparedInputRequest,
  CompiledPreparedInput,
  InputPreparationCompiler,
} from '../adapters/pi/input-preparation';

/**
 * C07 G4-remote, device half (`input-preparation-remote.ts`).
 *
 * Everything below drives one real `agent.input.preparation` payload through a
 * REAL durable service on a real temporary filesystem, with a stub compiler and
 * a fixture counter — so the assertions are about authority, ordering and
 * idempotency, not about the native compiler.
 *
 * The one thing these tests keep proving structurally is that the remote lane
 * never touches the local control socket: every case asserts that no socket was
 * opened while the envelope was handled.
 */

const LOCAL_DEVICE_ID = 'device-local-record';
const REQUEST_ID = '10000000-0000-4000-8000-000000000501';

const cleanups: (() => Promise<void>)[] = [];
let socketOpens: number;

beforeEach(() => {
  socketOpens = 0;
  // `control-client.ts` reaches the daemon through exactly these two. If the
  // remote lane ever routed a preparation through the control channel instead
  // of calling the service in-process, this counter would be non-zero.
  for (const name of ['connect', 'createConnection'] as const) {
    vi.spyOn(net, name).mockImplementation(((...args: unknown[]) => {
      socketOpens += 1;
      throw new Error(`the remote input-preparation lane must not open a control socket (${name})`);
    }) as never);
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tmpStoreDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-input-prep-remote-'));
  cleanups.push(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const LIMITS: InputPreparationLimitsPolicyV1 = validateInputPreparationLimits({
  revision: 'limits-rev-remote',
  maxRequestBytes: 256_000,
  maxArtifactBytes: 200_000,
  maxScopeAggregateBytes: 400_000,
  maxInFlight: 4,
  maxCounterCallsPerScope: 8,
  counterTimeoutMs: 5_000,
  preparationDeadlineMs: 8_000,
  retentionMs: 60_000,
  retryHorizonMs: 30_000,
});

const CONTEXT_DOCUMENT = {
  prompt: {
    cwd: '/workspace/project',
    selectedTools: ['read'],
    toolSnippets: { read: 'snippet' },
    promptGuidelines: [],
    contextFiles: [],
    formattedSkills: '',
    docsPaths: { readmePath: 'README.md', docsPath: 'docs', examplesPath: 'examples' },
  },
  messages: [{ role: 'user', content: 'prepare this turn', timestamp: 1_700_000_000_000 }],
};

const CONTEXT_JSON = JSON.stringify(CONTEXT_DOCUMENT);
const CONTEXT_HASH = `sha256:${createHash('sha256').update(CONTEXT_JSON, 'utf8').digest('hex')}`;

function payload(overrides: Record<string, unknown> = {}): AgentInputPreparationPayload {
  return AgentInputPreparationPayloadSchema.parse({
    requestId: REQUEST_ID,
    agentRef: { agentId: 'agent-remote', profileRevision: 'profile-rev-1' },
    profileId: 'profile-1',
    policyRevision: LIMITS.revision,
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
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    context: { inline: CONTEXT_JSON },
    requiredToolsets: ['team'],
    ...overrides,
  });
}

interface StubCompiler extends InputPreparationCompiler {
  readonly calls: CompilePreparedInputRequest[];
}

function stubCompiler(): StubCompiler {
  const calls: CompilePreparedInputRequest[] = [];
  return {
    calls,
    runtime: {
      packageName: '@byok-sdk/pi-coding-agent',
      packageVersion: '0.85.1001',
      upstreamBase: '0.85.1',
      upstreamCommit: 'd981de1229ef899957bbe968bc8dcda02a21f477',
      forkBuild: 1,
      envelopeFormat: 'pi.session.prepared-input',
      requestFormat: 'pi.openai-completions.prepared',
      compilerVersion: 1,
    },
    async compile(request: CompilePreparedInputRequest): Promise<CompiledPreparedInput> {
      calls.push(structuredClone(request) as CompilePreparedInputRequest);
      const body = JSON.stringify({ model: request.model.id, tools: request.snapshot.tools.length });
      return {
        requestBody: body,
        counterProjection: JSON.stringify({ model: request.model.id }),
        requestBytes: Buffer.byteLength(body, 'utf8'),
        projectionBytes: 32,
        requestDigest: 'a'.repeat(64),
        envelopeDigest: 'b'.repeat(64),
        toolManifestDigest: 'c'.repeat(64),
        coverage: 'unknown',
        envelope: { format: 'pi.session.prepared-input', version: 1 } as never,
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
        kind: 'count',
        value: 123,
        coverage: { covered: true },
      };
    },
  };
}

const ALWAYS_AUTHORIZED: InputPreparationAuthorityResolver = {
  async resolveScope(claim) {
    return { authorized: true, grant: { scopeId: `scope:${claim.deviceId}`, ...claim } };
  },
};

const OBSERVATION: RemoteInputPreparationObservation = {
  observation: {
    teamserver: {
      serverName: 'teamserver',
      toolsetId: 'team',
      serverInfo: { name: 'team-mcp', version: '1.2.3' },
      protocolVersion: '2025-06-18',
      tools: [
        { name: 'list', description: 'list members', inputSchema: { type: 'object', properties: {} } },
        { name: 'post', description: 'post a note', inputSchema: { type: 'object', properties: {} } },
      ],
    },
  },
  toolsetDefinitionRevisions: { team: `sha256:${'9'.repeat(64)}` },
};

function recordingCompletionClient() {
  const completions: InputPreparationCompletionRequest[] = [];
  const client = {
    async complete(input: InputPreparationCompletionRequest) {
      completions.push(structuredClone(input) as InputPreparationCompletionRequest);
      return {} as never;
    },
  } as unknown as InputPreparationCompletionClient;
  return { client, completions };
}

interface Harness {
  readonly handle: (input: AgentInputPreparationPayload) => Promise<InputPreparationCompletionRequest>;
  readonly completions: InputPreparationCompletionRequest[];
  readonly compiler: StubCompiler;
  readonly counter: ReturnType<typeof fixtureCounter>;
  readonly service: InputPreparationService | undefined;
}

async function makeHarness(overrides: Partial<RemoteInputPreparationDeps> & {
  authorityResolver?: InputPreparationAuthorityResolver;
  configured?: boolean;
} = {}): Promise<Harness> {
  const compiler = stubCompiler();
  const counter = fixtureCounter();
  let service: InputPreparationService | undefined;
  if (overrides.configured !== false) {
    service = createInputPreparationService({
      storeDir: await tmpStoreDir(),
      limits: LIMITS,
      authorityResolver: overrides.authorityResolver ?? ALWAYS_AUTHORIZED,
      counter,
      compiler,
    });
    await service.open();
    cleanups.push(() => service!.stop());
  }
  const { client, completions } = recordingCompletionClient();
  const handle = createRemoteInputPreparationHandler({
    deviceId: LOCAL_DEVICE_ID,
    service,
    limits: overrides.configured === false ? undefined : LIMITS,
    completion: overrides.completion ?? client,
    resolveBlobText: overrides.resolveBlobText ?? (async () => {
      throw new Error('no blob resolver in this test');
    }),
    observeToolsets: overrides.observeToolsets ?? (async () => OBSERVATION),
    ...(overrides.unavailableReason === undefined ? {} : { unavailableReason: overrides.unavailableReason }),
  });
  return { handle, completions, compiler, counter, service };
}

describe('remote input preparation: in-process, never the control socket', () => {
  it('prepares from one envelope and reports a receipt summary with zero control-socket bytes', async () => {
    const harness = await makeHarness();
    const completion = await harness.handle(payload());

    expect(socketOpens).toBe(0);
    expect(harness.compiler.calls).toHaveLength(1);
    expect(harness.counter.calls).toHaveLength(1);
    expect(completion.outcome).toBe('prepared');
    if (completion.outcome !== 'prepared') throw new Error('unreachable');

    // The summary discloses identity, not content.
    expect(completion.receipt.artifact).toMatchObject({ coverage: 'unknown', requestDigest: 'a'.repeat(64) });
    expect(Object.keys(completion.receipt)).not.toContain('request');
    expect(Object.keys(completion.receipt)).not.toContain('snapshot');
    // A fixture counter and an unknown compiler coverage can never be ready.
    expect(completion.receipt.ready).toBe(false);
    expect(completion.receipt.readinessReasons).toContain('counter_authority_not_production');
    expect(completion.receipt.readinessReasons).toContain('compiler_coverage_unknown');
    expect(harness.completions).toEqual([completion]);
  });

  it('binds the LOCAL device record, which the payload has no way to state', async () => {
    const harness = await makeHarness();
    const completion = await harness.handle(payload());
    if (completion.outcome !== 'prepared') throw new Error('unreachable');

    expect(completion.receipt.binding.deviceId).toBe(LOCAL_DEVICE_ID);
    expect(harness.compiler.calls[0]?.binding.profileRevision).toBe('profile-rev-1');

    // And the payload is structurally incapable of naming a device or tenant:
    // the schema is strict, so a sender cannot even attempt the substitution.
    for (const field of ['deviceId', 'tenantId', 'scope']) {
      expect(
        AgentInputPreparationPayloadSchema.safeParse({ ...payload(), [field]: 'attacker-device' }).success,
      ).toBe(false);
    }
  });

  it('compiles the tools it OBSERVED, in the canonical order, never a payload-stated set', async () => {
    const harness = await makeHarness();
    await harness.handle(payload());

    const compiled = harness.compiler.calls[0]!;
    expect(compiled.snapshot.tools.map((tool) => tool.name)).toEqual([
      'mcp__teamserver__list',
      'mcp__teamserver__post',
    ]);
    expect(Object.keys(compiled.toolExecutors)).toEqual(['mcp__teamserver__list', 'mcp__teamserver__post']);
    // The Host-authorized prompt and messages survive verbatim.
    expect(compiled.snapshot.prompt).toEqual(CONTEXT_DOCUMENT.prompt);
    expect(compiled.snapshot.messages).toEqual(CONTEXT_DOCUMENT.messages);
  });

  it('reports a resolver refusal as a rejection, with no artifact and no compile', async () => {
    const harness = await makeHarness({
      authorityResolver: {
        async resolveScope() {
          return { authorized: false, reason: 'unknown_agent' };
        },
      },
    });
    const completion = await harness.handle(payload());

    expect(completion.outcome).toBe('rejected');
    if (completion.outcome !== 'rejected') throw new Error('unreachable');
    expect(completion.reason).toBe('scope_denied');
    expect(completion).not.toHaveProperty('receipt');
    expect(harness.compiler.calls).toHaveLength(0);
    expect(harness.counter.calls).toHaveLength(0);
    expect(socketOpens).toBe(0);
  });

  it('absorbs a re-delivery: one compile, one counter call, two equal completions', async () => {
    const harness = await makeHarness();
    const first = await harness.handle(payload());
    const second = await harness.handle(payload());

    expect(harness.compiler.calls).toHaveLength(1);
    expect(harness.counter.calls).toHaveLength(1);
    expect(second).toEqual(first);
    expect(harness.completions).toHaveLength(2);
    expect(harness.completions[1]).toEqual(harness.completions[0]);
  });

  it('rejects an inline context over the wire bound before anything reaches the device lane', () => {
    // The bound is the wire's, not the handler's: an oversize inline context is
    // not a preparation that fails late, it is an envelope that never parses.
    expect(
      AgentInputPreparationPayloadSchema.safeParse({
        ...payload(),
        context: { inline: 'x'.repeat(64 * 1024 + 1) },
      }).success,
    ).toBe(false);
  });

  it('resolves a BlobRef context whose bytes hash exactly, and refuses one that does not', async () => {
    const blobRef = {
      blobId: 'blob-1',
      contentHash: CONTEXT_HASH,
      size: Buffer.byteLength(CONTEXT_JSON, 'utf8'),
      contentType: 'application/json',
    };
    const good = await makeHarness({ resolveBlobText: async () => CONTEXT_JSON });
    const prepared = await good.handle(payload({ context: { blobRef, contentHash: CONTEXT_HASH } }));
    expect(prepared.outcome).toBe('prepared');
    expect(good.compiler.calls).toHaveLength(1);

    // Same authorized hash, different bytes: the store served something else.
    const bad = await makeHarness({
      resolveBlobText: async () => JSON.stringify({ ...CONTEXT_DOCUMENT, messages: [] }),
    });
    const rejected = await bad.handle(payload({ context: { blobRef, contentHash: CONTEXT_HASH } }));
    expect(rejected.outcome).toBe('rejected');
    if (rejected.outcome !== 'rejected') throw new Error('unreachable');
    expect(rejected.reason).toBe('context_hash_mismatch');
    expect(bad.compiler.calls).toHaveLength(0);
    expect(bad.counter.calls).toHaveLength(0);

    // A resolver that cannot answer at all is a distinct, non-compiling fact.
    const unresolvable = await makeHarness({
      resolveBlobText: async () => {
        throw new Error('blob store unreachable');
      },
    });
    const unresolved = await unresolvable.handle(payload({ context: { blobRef, contentHash: CONTEXT_HASH } }));
    if (unresolved.outcome !== 'rejected') throw new Error('unreachable');
    expect(unresolved.reason).toBe('context_unresolvable');
    expect(unresolvable.compiler.calls).toHaveLength(0);
  });

  it('answers a typed completion when this daemon is not configured for preparation', async () => {
    const harness = await makeHarness({ configured: false });
    const completion = await harness.handle(payload());

    expect(completion.outcome).toBe('rejected');
    if (completion.outcome !== 'rejected') throw new Error('unreachable');
    expect(completion.reason).toBe('input_preparation_unconfigured');
    // Reported, not thrown: throwing would freeze this device's redelivery
    // cursor behind a row it can never discharge.
    expect(harness.completions).toHaveLength(1);
    expect(socketOpens).toBe(0);
  });

  it('distinguishes an unverifiable native closure from an absent section', async () => {
    const harness = await makeHarness({ configured: false, unavailableReason: 'runtime_identity_unavailable' });
    const completion = await harness.handle(payload());
    if (completion.outcome !== 'rejected') throw new Error('unreachable');
    expect(completion.reason).toBe('runtime_identity_unavailable');
  });

  it('refuses an already-elapsed Host deadline before compiling', async () => {
    const harness = await makeHarness();
    const completion = await harness.handle(payload({ deadlineAt: new Date(Date.now() - 1_000).toISOString() }));

    if (completion.outcome !== 'rejected') throw new Error('unreachable');
    expect(completion.reason).toBe('deadline_elapsed');
    expect(harness.compiler.calls).toHaveLength(0);
  });

  it('reports an unobservable toolset instead of preparing a smaller tool set', async () => {
    const harness = await makeHarness({
      observeToolsets: async () => {
        throw new Error('required MCP toolset server "teamserver" could not be observed');
      },
    });
    const completion = await harness.handle(payload());

    if (completion.outcome !== 'rejected') throw new Error('unreachable');
    expect(completion.reason).toBe('toolsets_unobservable');
    expect(harness.compiler.calls).toHaveLength(0);
  });

  it('keeps the mailbox row when the completion itself cannot be recorded', async () => {
    const failing = {
      async complete() {
        throw new Error('completion transport failed');
      },
    } as unknown as InputPreparationCompletionClient;
    const harness = await makeHarness({ completion: failing });

    // Throwing here is the contract: the handler's rejection is what stops the
    // transport from advancing the cursor past an envelope whose outcome the
    // cloud never learned.
    await expect(harness.handle(payload())).rejects.toThrow('completion transport failed');
  });

  it('rejects a policy revision this daemon does not enforce', async () => {
    const harness = await makeHarness();
    const completion = await harness.handle(payload({ policyRevision: 'limits-rev-somewhere-else' }));

    if (completion.outcome !== 'rejected') throw new Error('unreachable');
    expect(completion.reason).toBe('policy_revision_mismatch');
    expect(harness.compiler.calls).toHaveLength(0);
  });
});
