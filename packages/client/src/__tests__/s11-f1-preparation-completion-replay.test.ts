import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentInputPreparationPayloadSchema, createEnvelope, type AgentInputPreparationPayload, type InputPreparationCompletionRequest } from '@byok-sdk/protocol';
import { validateInputPreparationLimits, type InputPreparationAuthorityResolver, type InputPreparationCounterRequestV1, type InputPreparationCounterResultV1, type InputPreparationLimitsPolicyV1 } from '../input-preparation';
import { createInputPreparationService } from '../daemon/input-preparation-service';
import { createRemoteInputPreparationHandler } from '../daemon/input-preparation-remote';
import { InputPreparationCompletionClient } from '../daemon/input-preparation-completion-client';
import type { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';
import { recordingToolSurface } from './fixtures/prepared-tool-surface';
import type { CompilePreparedInputRequest, CompiledPreparedInput, InputPreparationCompiler } from '../adapters/pi/input-preparation';
import { createHarness, TENANT_A } from '../../../cloud/src/__tests__/support/harness';
import { inputPreparationRequestKey, inputPreparationCompletionKey } from '../../../cloud/src/input-preparations';

// Real service/filesystem, completion HTTP client, authenticated cloud handlers,
// first-write-wins receipt store, and cumulative cursor. Only native compilation,
// counting, transport, and the clock are fixtures. No network or provider calls.
const REQUEST_ID = '10000000-0000-4000-8000-000000000501';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); vi.restoreAllMocks(); });

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
  prompt: { systemPrompt: 'Host fixture instructions' },
  messages: [{ role: 'user', content: 'prepare this turn', timestamp: 1_700_000_000_000 }],
};

const CONTEXT_JSON = JSON.stringify(CONTEXT_DOCUMENT);
const CONTEXT_HASH = `sha256:${createHash('sha256').update(CONTEXT_JSON, 'utf8').digest('hex')}`;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

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
    agentMemory: 'none', requiredToolsets: ['team'],
    permissionMode: 'auto',
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
      tarballIntegrity: 'sha512-'+ 'YQ=='.repeat(1),
      upstreamCommit: 'd981de1229ef899957bbe968bc8dcda02a21f477',
      provenanceDigest: 'a'.repeat(64), closureDigest: 'b'.repeat(64),
      envelopeFormat: 'pi.session.prepared-input',
      requestFormat: 'pi.openai-completions.prepared',
      compilerVersion: 2,
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
        projection: {
          version: 3,
          kind: 'content_complete',
          digest: sha256Hex(JSON.stringify({ model: request.model.id })),
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
        value: 123,
        coverage: { covered: true },
        providerEvidence: {
          projectionDigest: sha256Hex(request.counterProjection),
          endpoint: request.target.endpoint,
          modelId: request.target.modelId,
          asserted: { httpStatus: 200, usageFields: { prompt_tokens: 123 }, responseDigest: 'e'.repeat(64) },
        },
      };
    },
  };
}

const ALWAYS_AUTHORIZED: InputPreparationAuthorityResolver = {
  async resolveSource({ source }) { return { authorized: true, source }; },
  async resolveScope(claim) {
    return { authorized: true, grant: { agentMemory: 'none', scopeId: `scope:${claim.deviceId}`, ...claim } };
  },
};


async function harness(requestOverrides: Record<string, unknown> = {}) {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-s11-f1-'));
  cleanups.push(() => fs.rm(storeDir, { recursive: true, force: true }));
  const cloud = createHarness();
  const device = await cloud.pairDevice(TENANT_A);
  const request = payload(requestOverrides);
  await cloud.stores.receipts.record(TENANT_A, {
    key: inputPreparationRequestKey(device.deviceId, request.agentRef, request.requestId),
    body: JSON.stringify(request),
  });
  const auth = { getValidAccessToken: async () => device.accessToken } as AuthManager;
  const compiler = stubCompiler();
  const counter = fixtureCounter();
  const toolSurface = recordingToolSurface();
  let time = Date.now();
  let dropResponse = true;
  const puts: InputPreparationCompletionRequest[] = [];
  const statuses: number[] = [];
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('http://cloud.test');
    if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body)));
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${device.accessToken}`);
    if (init?.method === 'GET') {
      expect(url.searchParams.get('agentId')).toBe(request.agentRef.agentId);
      expect(url.searchParams.get('profileRevision')).toBe(request.agentRef.profileRevision);
    }
    const response = await cloud.request(url.pathname + url.search, init);
    if (init?.method === 'PUT') {
      statuses.push(response.status);
      if (response.ok && dropResponse) {
        dropResponse = false;
        throw new Error('committed cloud receipt, dropped response');
      }
    }
    return response;
  });
  const createClient = () => new InputPreparationCompletionClient({ serverUrl: 'http://cloud.test', tenantId: TENANT_A, deviceId: device.deviceId, auth });
  let client = createClient();
  const createService = () => createInputPreparationService({ storeDir, limits: LIMITS, authorityResolver: ALWAYS_AUTHORIZED, compiler, counter, toolSurface, now: () => time });
  let service = createService();
  await service.open();
  cleanups.push(async () => { await service.stop(); });
  const createHandler = () => createRemoteInputPreparationHandler({ deviceId: device.deviceId, service, limits: LIMITS, completion: client, now: () => time, resolveBlobText: async () => { throw new Error('unexpected blob lookup'); } });
  let handle = createHandler();
  return {
    request, compiler, counter, toolSurface, puts, statuses, fetchMock, cloud, device, storeDir, auth,
    get client() { return client; },
    handle: (input = request) => handle(input),
    advance: (ms: number) => { time += ms; },
    keepResponse: () => { dropResponse = false; },
    async restart() { await service.stop(); service = createService(); await service.open(); client = createClient(); handle = createHandler(); },
    async completionBody() { return (await cloud.stores.receipts.get(TENANT_A, inputPreparationCompletionKey(device.deviceId, request.agentRef, request.requestId)))?.body; },
    get service() { return service; },
  };
}

describe('S11-F1 authoritative preparation completion replay', () => {
  it('recovers commit-then-drop across restart after deadline and local record GC', async () => {
    const h = await harness();
    await expect(h.handle()).rejects.toThrow('transport failed');
    const committed = await h.completionBody();
    expect(h.puts[0]?.outcome).toBe('prepared');
    h.advance(LIMITS.retentionMs + LIMITS.retryHorizonMs + 1);
    await h.restart();
    expect(h.service.store.list()).toHaveLength(0);
    await expect(h.handle()).resolves.toEqual(JSON.parse(committed!));
    expect(await h.completionBody()).toBe(committed);
    expect(h.compiler.calls).toHaveLength(1);
    expect(h.counter.calls).toHaveLength(1);
    expect(h.toolSurface.assembleCalls).toHaveLength(1);
    expect(h.puts).toHaveLength(1);
  });

  it('replays unchanged after artifact expiry while the Host deadline and tombstone remain live', async () => {
    const h = await harness({ deadlineAt: new Date(Date.now() + 600_000).toISOString() });
    await expect(h.handle()).rejects.toThrow('transport failed');
    const committed = await h.completionBody();
    h.advance(LIMITS.retentionMs + 1);
    await h.restart();
    expect(h.service.store.list()).toHaveLength(1);
    expect(h.service.store.list()[0]?.artifactBytes).toBe(0);
    await expect(h.handle()).resolves.toEqual(JSON.parse(committed!));
    expect(h.puts).toHaveLength(1);
    expect(h.compiler.calls).toHaveLength(1);
    expect(h.counter.calls).toHaveLength(1);
  });

  it('can discharge a recorded completion when the local preparation lane is now unavailable', async () => {
    const h = await harness();
    await expect(h.handle()).rejects.toThrow('transport failed');
    const committed = await h.completionBody();
    const unavailable = createRemoteInputPreparationHandler({
      deviceId: h.device.deviceId, service: undefined, limits: undefined,
      unavailableReason: 'input_preparation_record_log_unsupported', completion: h.client,
      resolveBlobText: async () => { throw new Error('must not resolve context'); },
    });
    await expect(unavailable(h.request)).resolves.toEqual(JSON.parse(committed!));
    expect(h.puts).toHaveLength(1);
  });

  it('replays the original rejection when assembly failed after durable reserve', async () => {
    const h = await harness();
    const assemble = h.toolSurface.assemble.bind(h.toolSurface);
    h.toolSurface.assemble = async input => {
      await assemble(input);
      return { ok: false, code: 'launch_boundary_unavailable', detail: 'assembly_failed', message: 'fixture refusal' };
    };
    await expect(h.handle()).rejects.toThrow('transport failed');
    const committed = await h.completionBody();
    expect(h.puts[0]).toMatchObject({ outcome: 'rejected', reason: 'launch_boundary_unavailable' });
    await h.restart();
    await expect(h.handle()).resolves.toEqual(JSON.parse(committed!));
    expect(h.puts).toHaveLength(1);
    expect(h.toolSurface.assembleCalls).toHaveLength(1);
    expect(h.compiler.calls).toHaveLength(0);
    expect(h.counter.calls).toHaveLength(0);
  });

  it('replays after binding drift without revalidating consumption readiness', async () => {
    const h = await harness();
    await expect(h.handle()).rejects.toThrow('transport failed');
    const committed = await h.completionBody();
    h.toolSurface.toolBindingDigest = 'binding-digest-changed';
    await expect(h.handle()).resolves.toEqual(JSON.parse(committed!));
    expect(h.puts).toHaveLength(1);
  });

  it('unblocks the actual cumulative cursor past the failed preparation and successful tail', async () => {
    const h = await harness();
    const cursorStore = new CursorStore(h.storeDir);
    const connection = new ConnectionManager({ serverUrl: 'http://cloud.test', deviceId: h.device.deviceId, productId: 'test-product', capabilities: [], runtimes: [], auth: h.auth, cursorStore,
      onEnvelope: async envelope => { if (envelope.type === 'agent.input.preparation') await h.handle(envelope.payload); },
    });
    // Feed the production delivery/cursor path without starting a live transport.
    const delivery = connection as unknown as { deliver: (e: ReturnType<typeof createEnvelope>) => boolean; processingChain: Promise<void> };
    const envelope = createEnvelope('agent.input.preparation', h.request, { seq: 1 });
    const tail = createEnvelope('task.offer', { instruction: 'tail', policy: { mode: 'auto' } }, { seq: 2, taskId: 'tail' });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    delivery.deliver(envelope);
    await delivery.processingChain;
    delivery.deliver(tail);
    await delivery.processingChain;
    expect(await cursorStore.load('http://cloud.test', h.device.deviceId)).toBe(0);
    h.advance(120_000);
    await h.restart();
    delivery.deliver(envelope);
    await delivery.processingChain;
    expect(await cursorStore.load('http://cloud.test', h.device.deviceId)).toBe(2);
    expect(h.puts).toHaveLength(1);
    consoleError.mockRestore();
    await connection.stop();
  });

  it.each(['transport', '404', '503', 'invalid-json', 'invalid-shape', 'missing-completedAt', 'pending-with-completion'])('keeps unknown status retryable: %s', async fault => {
    const h = await harness();
    await expect(h.handle()).rejects.toThrow('transport failed');
    const committed = await h.completionBody();
    const transport = h.fetchMock.getMockImplementation()!;
    h.fetchMock.mockImplementation(async (input, init) => {
      if (init?.method !== 'GET') return transport(input, init);
      if (fault === 'transport') throw new Error('status unavailable');
      if (fault === '404' || fault === '503') return new Response('', { status: Number(fault) });
      if (fault === 'invalid-json') return new Response('{');
      if (fault === 'invalid-shape') return Response.json({ status: 'prepared' });
      const response = await transport(input, init);
      const body = await response.json() as Record<string, unknown>;
      if (fault === 'missing-completedAt') delete body.completedAt;
      else body.status = 'pending';
      return Response.json(body);
    });
    await expect(h.handle()).rejects.toThrow(/input preparation status/);
    expect(h.puts).toHaveLength(1);
    expect(h.compiler.calls).toHaveLength(1);
    h.fetchMock.mockImplementation(transport);
    await expect(h.handle()).resolves.toEqual(JSON.parse(committed!));
  });

  it.each(['tenantId', 'deviceId', 'requestId', 'agentId', 'profileRevision', 'profileId', 'policyRevision'])('refuses readback for a different %s even with valid terminal bytes', async field => {
    const h = await harness();
    await expect(h.handle()).rejects.toThrow('transport failed');
    const transport = h.fetchMock.getMockImplementation()!;
    h.fetchMock.mockImplementation(async (input, init) => {
      const response = await transport(input, init);
      if (init?.method !== 'GET') return response;
      const body = await response.json() as Record<string, unknown>;
      if (field === 'agentId' || field === 'profileRevision') {
        body.agentRef = { ...(body.agentRef as object), [field]: 'other' };
      } else body[field] = field === 'requestId' ? '10000000-0000-4000-8000-000000000999' : 'other';
      return Response.json(body);
    });
    await expect(h.handle()).rejects.toThrow('does not exactly match the authenticated request');
    expect(h.puts).toHaveLength(1);
    expect(h.compiler.calls).toHaveLength(1);
  });

  it('does no local work on unavailable or mismatched pending readback', async () => {
    const h = await harness();
    const transport = h.fetchMock.getMockImplementation()!;
    h.fetchMock.mockImplementation(async (input, init) => {
      const response = await transport(input, init);
      const body = await response.json() as Record<string, unknown>;
      body.profileId = 'other-profile';
      return Response.json(body);
    });
    await expect(h.handle()).rejects.toThrow('does not exactly match the authenticated request');
    expect(h.compiler.calls).toHaveLength(0);
    expect(h.toolSurface.assembleCalls).toHaveLength(0);
    expect(h.puts).toHaveLength(0);
  });

  it('preserves a pending-to-concurrent-terminal conflict and recovers the winner only on redelivery', async () => {
    const h = await harness();
    h.keepResponse();
    const transport = h.fetchMock.getMockImplementation()!;
    let compete = true;
    const winner: InputPreparationCompletionRequest = {
      requestId: h.request.requestId, agentRef: h.request.agentRef, profileId: h.request.profileId,
      policyRevision: h.request.policyRevision, outcome: 'rejected', reason: 'deadline_elapsed',
    };
    h.fetchMock.mockImplementation(async (input, init) => {
      const response = await transport(input, init);
      if (init?.method === 'GET' && compete) {
        compete = false;
        expect(await response.clone().json()).toMatchObject({ status: 'pending' });
        // Another authenticated handler wins after our GET snapshot but before
        // our PUT. Exercise the real route/store, never synthesize acceptance.
        const competing = await h.cloud.request(`/byok/input-preparations/${h.request.requestId}/completion`, {
          method: 'PUT', headers: { ...h.device.authorization, 'content-type': 'application/json' }, body: JSON.stringify(winner),
        });
        expect(competing.status).toBe(200);
      }
      return response;
    });
    await expect(h.handle()).rejects.toThrow('HTTP 409');
    expect(h.puts[0]?.outcome).toBe('prepared');
    expect(JSON.parse((await h.completionBody())!)).toEqual(winner);
    await expect(h.handle()).resolves.toEqual(winner);
    expect(h.puts).toHaveLength(1);
    expect(h.compiler.calls).toHaveLength(1);
    // A direct contradictory PUT remains a conflict, even after reconciliation.
    await expect(h.client.complete(h.puts[0]!)).rejects.toThrow('HTTP 409');
  });

  it('does not invent acceptance when the PUT failed before cloud commit', async () => {
    const h = await harness();
    h.keepResponse();
    const transport = h.fetchMock.getMockImplementation()!;
    h.fetchMock.mockImplementation(async (input, init) => init?.method === 'PUT' ? new Response('', { status: 503 }) : transport(input, init));
    await expect(h.handle()).rejects.toThrow('HTTP 503');
    expect(await h.completionBody()).toBeUndefined();
    h.advance(120_000);
    h.fetchMock.mockImplementation(transport);
    await expect(h.handle()).resolves.toMatchObject({ outcome: 'rejected', reason: 'deadline_elapsed' });
    expect(JSON.parse((await h.completionBody())!)).toMatchObject({ outcome: 'rejected', reason: 'deadline_elapsed' });
    expect(h.compiler.calls).toHaveLength(1);
  });

});
