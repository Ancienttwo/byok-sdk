import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentInputPreparationPayloadSchema, type AgentInputPreparationPayload, type InputPreparationCompletionRequest } from '@byok-sdk/protocol';
import { INPUT_PREPARATION_REQUEST_FORMAT, INPUT_PREPARATION_VERSION, validateInputPreparationLimits, type InputPreparationRequestV1, type InputPreparationAuthorityResolver, type InputPreparationCounterRequestV1, type InputPreparationCounterResultV1, type InputPreparationLimitsPolicyV1 } from '../input-preparation';
import { createInputPreparationService, type InputPreparationServiceOptions } from '../daemon/input-preparation-service';
import { createRemoteInputPreparationHandler, type RemoteInputPreparationDeps } from '../daemon/input-preparation-remote';
import type { InputPreparationCompletionClient } from '../daemon/input-preparation-completion-client';
import { InputPreparationDurabilityError } from '../daemon/input-preparation-store';
import { BlobClient } from '../daemon/blob-client';
import type { AuthManager } from '../daemon/auth-manager';
import { recordingToolSurface } from './fixtures/prepared-tool-surface';
import type { CompilePreparedInputRequest, CompiledPreparedInput, InputPreparationCompiler } from '../adapters/pi/input-preparation';
const LOCAL_DEVICE_ID = 'device-local-record';
const REQUEST_ID = '10000000-0000-4000-8000-000000000501';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); vi.useRealTimers(); vi.restoreAllMocks(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
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


async function harness(overrides: { authorityResolver?: InputPreparationAuthorityResolver; resolveBlobText?: RemoteInputPreparationDeps['resolveBlobText']; limits?: InputPreparationLimitsPolicyV1; signal?: AbortSignal; open?: boolean; counter?: false } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(1_700_000_000_000);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-s11-f3-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const compiler = stubCompiler(); const counter = fixtureCounter();
  const limits = overrides.limits ?? LIMITS;
  const toolSurface = recordingToolSurface();
  const service = createInputPreparationService({ storeDir: dir, limits, compiler, counter: overrides.counter === false ? undefined : counter, toolSurface, authorityResolver: overrides.authorityResolver ?? ALWAYS_AUTHORIZED });
  if (overrides.open !== false) await service.open();
  cleanups.push(() => service.stop().catch(() => {}));
  const completions: InputPreparationCompletionRequest[] = [];
  const completion = { readCompleted: async () => undefined, complete: async (input: InputPreparationCompletionRequest) => { completions.push(input); return {} as never; } } as unknown as InputPreparationCompletionClient;
  const resolveBlobText = overrides.resolveBlobText ?? (async () => CONTEXT_JSON);
  const handle = createRemoteInputPreparationHandler({ deviceId: LOCAL_DEVICE_ID, service, limits, completion, resolveBlobText, signal: overrides.signal });
  const realReserve = service.store.reserve.bind(service.store);
  const reserve = vi.spyOn(service.store, 'reserve');
  const request = payload({ deadlineAt: new Date(Date.now() + 100).toISOString() });
  const blobRequest = { ...request, context: { blobRef: { blobId: 'blob-1', contentHash: CONTEXT_HASH, size: Buffer.byteLength(CONTEXT_JSON), contentType: 'application/json' }, contentHash: CONTEXT_HASH } };
  return { service, compiler, counter, toolSurface, completion, handle, request, blobRequest, reserve, realReserve, completions };
}

function localRequest(wire: AgentInputPreparationPayload): InputPreparationRequestV1 {
  return { format: INPUT_PREPARATION_REQUEST_FORMAT, version: INPUT_PREPARATION_VERSION, requestId: wire.requestId, policyRevision: wire.policyRevision,
    scope: { deviceId: LOCAL_DEVICE_ID, agentRef: wire.agentRef.agentId, profileRevision: wire.agentRef.profileRevision, profileId: wire.profileId },
    source: wire.source, selection: wire.selection, snapshot: CONTEXT_DOCUMENT as InputPreparationRequestV1['snapshot'], agentMemory: wire.agentMemory, requiredToolsets: wire.requiredToolsets };
}
function observe<T>(promise: Promise<T>) {
  const result: { state: string; value?: T; error?: unknown } = { state: 'pending' };
  void promise.then(value => { result.state = 'resolved'; result.value = value; }, error => { result.state = 'rejected'; result.error = error; });
  return result;
}

describe('S11-F3 absolute preparation deadlines', () => {
  it('does not renew the Host budget after resolving a late blob', async () => {
    const h = await harness({ resolveBlobText: async () => { vi.setSystemTime(Date.now() + 101); return CONTEXT_JSON; } });
    await expect(h.handle(h.blobRequest)).resolves.toMatchObject({ outcome: 'rejected', reason: 'deadline_elapsed' });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.compiler.calls).toHaveLength(0); expect(h.counter.calls).toHaveLength(0);
  });

  it.each(['scope', 'source'])('refuses expired %s authority before durable reserve or compilation', async stage => {
    const entered = deferred(); const gate = deferred();
    const authority: InputPreparationAuthorityResolver = {
      resolveScope: async claim => { if (stage === 'scope') { entered.resolve(); await gate.promise; } return ALWAYS_AUTHORIZED.resolveScope(claim); },
      resolveSource: async request => { if (stage === 'source') { entered.resolve(); await gate.promise; } return ALWAYS_AUTHORIZED.resolveSource(request); },
    };
    const h = await harness({ authorityResolver: authority });
    cleanups.push(async () => { gate.resolve(); });
    const pending = h.handle(h.request);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(101);
    expect(h.completions).toHaveLength(1); // Abort-ignoring authority has not resolved.
    gate.resolve();
    await expect(pending).resolves.toMatchObject({ outcome: 'rejected' });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.compiler.calls).toHaveLength(0); expect(h.counter.calls).toHaveLength(0);
  });

  it.each(['before-commit', 'after-commit'])('settles a reservation crossing the deadline (%s) as cancellation without compiling', async phase => {
    const h = await harness();
    const reserve = h.realReserve;
    const entered = deferred(); const gate = deferred();
    cleanups.push(async () => { gate.resolve(); });
    h.reserve.mockImplementationOnce(async input => {
      const committed = phase === 'after-commit' ? await reserve(input) : undefined;
      entered.resolve(); await gate.promise;
      return committed ?? reserve(input);
    });
    const pending = h.handle(h.request);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(101);
    expect(h.completions).toHaveLength(0); // No receipt while the durable write is unresolved.
    gate.resolve();
    await expect(pending).resolves.toMatchObject({ outcome: 'rejected' });
    expect(h.service.store.list()).toHaveLength(1);
    expect(h.service.store.list()[0]?.state).toBe('cancelled');
    await expect(h.service.prepare(localRequest(h.request), { deadlineAt: Date.now() + 1_000 })).resolves.toMatchObject({ state: 'cancelled' });
    expect(h.compiler.calls).toHaveLength(0); expect(h.counter.calls).toHaveLength(0);
  });

  it.each([[40, 30, 40, 'rejected'], [20, 20, 20, 'prepared']] as const)('shares the budget across blob=%i, authority=%i, compile=%i', async (blobMs, authorityMs, compileMs, outcome) => {
    const h = await harness({
      resolveBlobText: async () => { vi.setSystemTime(Date.now() + blobMs); return CONTEXT_JSON; },
      authorityResolver: { ...ALWAYS_AUTHORIZED, resolveScope: async claim => { vi.setSystemTime(Date.now() + authorityMs); return ALWAYS_AUTHORIZED.resolveScope(claim); } },
    });
    const compile = h.compiler.compile.bind(h.compiler);
    h.compiler.compile = async input => { vi.setSystemTime(Date.now() + compileMs); return compile(input); };
    await expect(h.handle(h.blobRequest)).resolves.toMatchObject({ outcome });
    expect(h.counter.calls).toHaveLength(outcome === 'prepared' ? 1 : 0);
  });

  it('expires while waiting for the same record lock without stealing the first preparation or resuming late', async () => {
    const h = await harness(); const gate = deferred(); const entered = deferred();
    cleanups.push(async () => { gate.resolve(); });
    const compile = h.compiler.compile.bind(h.compiler);
    h.compiler.compile = async input => { entered.resolve(); await gate.promise; return compile(input); };
    const first = h.service.prepare(localRequest(h.request), { deadlineAt: Date.now() + 5_000 });
    await entered.promise;
    const second = observe(h.service.prepare(localRequest(h.request), { deadlineAt: Date.now() + 100 }));
    await vi.advanceTimersByTimeAsync(101);
    expect(second.state).toBe('rejected');
    expect(second.error).toMatchObject({ code: 'cancelled' });
    expect(h.reserve).toHaveBeenCalledTimes(1);
    gate.resolve();
    await expect(first).resolves.toMatchObject({ state: 'prepared' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.reserve).toHaveBeenCalledTimes(1);
    expect(h.compiler.calls).toHaveLength(1); expect(h.counter.calls).toHaveLength(1);
  });

  it('uses the shorter local ceiling from handler entry even when the Host permits longer', async () => {
    const h = await harness({ limits: { ...LIMITS, preparationDeadlineMs: 100 }, resolveBlobText: async () => { vi.setSystemTime(Date.now() + 101); return CONTEXT_JSON; } });
    await expect(h.handle({ ...h.blobRequest, deadlineAt: new Date(Date.now() + 10_000).toISOString() })).resolves.toMatchObject({ outcome: 'rejected', reason: 'deadline_elapsed' });
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it('discards an abort-ignoring blob resolver result after the deadline', async () => {
    const gate = deferred(); const entered = deferred(); let signal!: AbortSignal;
    const h = await harness({ resolveBlobText: async (_ref, inputSignal) => { signal = inputSignal; entered.resolve(); await gate.promise; return CONTEXT_JSON; } });
    cleanups.push(async () => { gate.resolve(); });
    const pending = h.handle(h.blobRequest); await entered.promise;
    await vi.advanceTimersByTimeAsync(101);
    await expect(pending).resolves.toMatchObject({ outcome: 'rejected', reason: 'deadline_elapsed' });
    expect(signal.aborted).toBe(true);
    gate.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.reserve).not.toHaveBeenCalled(); expect(h.completions).toHaveLength(1);
  });

  it('cancels a real BlobClient stalled body at the absolute Host deadline', async () => {
    const entered = deferred(); const cancelled = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({ start: c => { c.enqueue(new TextEncoder().encode(CONTEXT_JSON.slice(0, 10))); }, cancel: cancelled });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).endsWith('/url')) return Response.json({ downloadUrl: 'http://blob.test/content' });
      entered.resolve(); return new Response(stream);
    });
    const client = new BlobClient('http://blob.test', { getValidAccessToken: async () => 'fixture-token' } as AuthManager);
    const h = await harness({ resolveBlobText: (ref, signal) => client.resolveInstruction(ref, { signal }) });
    const pending = h.handle(h.blobRequest); await entered.promise;
    await vi.advanceTimersByTimeAsync(101);
    await expect(pending).resolves.toMatchObject({ outcome: 'rejected', reason: 'deadline_elapsed' });
    expect(cancelled).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false);
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it('cancels a late BlobClient Response even when its header transport ignores abort', async () => {
    const entered = deferred(); let resolve!: (response: Response) => void;
    const headers = new Promise<Response>(done => { resolve = done; });
    const cancelled = vi.fn(() => new Promise<void>(() => {}));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).endsWith('/url')) return Response.json({ downloadUrl: 'http://blob.test/content' });
      entered.resolve(); return headers;
    });
    const client = new BlobClient('http://blob.test', { getValidAccessToken: async () => 'fixture-token' } as AuthManager);
    const h = await harness({ resolveBlobText: (ref, signal) => client.resolveInstruction(ref, { signal }) });
    const pending = h.handle(h.blobRequest); await entered.promise;
    await vi.advanceTimersByTimeAsync(101);
    await expect(pending).resolves.toMatchObject({ outcome: 'rejected', reason: 'deadline_elapsed' });
    resolve(new Response(new ReadableStream({ cancel: cancelled })));
    await new Promise<void>(done => setImmediate(done));
    expect(cancelled).toHaveBeenCalledOnce(); expect(h.reserve).not.toHaveBeenCalled();
  });

  it('cancels the retained BlobClient body if the owner aborts at the header-to-body handoff', async () => {
    const lifecycle = new AbortController(); const cancelled = vi.fn(() => new Promise<void>(() => {}));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).endsWith('/url')) return Response.json({ downloadUrl: 'http://blob.test/content' });
      const response = new Response(new ReadableStream({ cancel: cancelled }));
      Object.defineProperty(response, 'ok', { get() { lifecycle.abort(); return true; } });
      return response;
    });
    const client = new BlobClient('http://blob.test', { getValidAccessToken: async () => 'fixture-token' } as AuthManager);
    const h = await harness({ signal: lifecycle.signal, resolveBlobText: (ref, signal) => client.resolveInstruction(ref, { signal }) });
    await expect(h.handle(h.blobRequest)).resolves.toMatchObject({ outcome: 'rejected', reason: 'cancelled' });
    await new Promise<void>(done => setImmediate(done));
    expect(cancelled).toHaveBeenCalledOnce(); expect(h.reserve).not.toHaveBeenCalled();
  });


  it('checks expiry after owned opportunistic GC before reserving a new request', async () => {
    const h = await harness(); const gate = deferred(); const entered = deferred();
    cleanups.push(async () => { gate.resolve(); });
    const gc = h.service.store.gc.bind(h.service.store);
    vi.spyOn(h.service.store, 'gc').mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; return gc(...args); });
    const pending = h.handle(h.request); await entered.promise;
    await vi.advanceTimersByTimeAsync(101);
    expect(h.completions).toHaveLength(0); // Owned maintenance is not abandoned.
    gate.resolve();
    await expect(pending).resolves.toMatchObject({ outcome: 'rejected' });
    expect(h.reserve).not.toHaveBeenCalled(); expect(h.compiler.calls).toHaveLength(0);
  });

  it('preserves a durable reservation failure instead of masking it with elapsed deadline', async () => {
    const h = await harness(); const gate = deferred(); const entered = deferred();
    cleanups.push(async () => { gate.resolve(); });
    h.reserve.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; throw new InputPreparationDurabilityError('uncertain reservation'); });
    const pending = h.handle(h.request); await entered.promise;
    await vi.advanceTimersByTimeAsync(101);
    expect(h.completions).toHaveLength(0);
    gate.resolve();
    await expect(pending).resolves.toMatchObject({ outcome: 'rejected', reason: 'durable_write_failed' });
    expect(h.compiler.calls).toHaveLength(0); expect(h.counter.calls).toHaveLength(0);
  });

  it('retains spent allowance but places no call when counter reservation crosses the deadline', async () => {
    const h = await harness(); const gate = deferred(); const entered = deferred();
    cleanups.push(async () => { gate.resolve(); });
    const reserve = h.service.store.commitCounterReservation.bind(h.service.store);
    vi.spyOn(h.service.store, 'commitCounterReservation').mockImplementationOnce(async input => { const result = await reserve(input); entered.resolve(); await gate.promise; return result; });
    const pending = h.handle(h.request); await entered.promise;
    await vi.advanceTimersByTimeAsync(101);
    expect(h.completions).toHaveLength(0);
    gate.resolve();
    await expect(pending).resolves.toMatchObject({ outcome: 'rejected', reason: 'cancelled' });
    expect(h.service.store.list()[0]).toMatchObject({ state: 'cancelled', counterCalls: 1 });
    expect(h.counter.calls).toHaveLength(0);
  });

  it('preserves unknown counter outcome after expiry and ignores a late counter response', async () => {
    const h = await harness(); const gate = deferred(); const entered = deferred();
    cleanups.push(async () => { gate.resolve(); });
    const count = h.counter.count.bind(h.counter);
    const countSpy = vi.spyOn(h.counter, 'count').mockImplementationOnce(async input => { entered.resolve(); await gate.promise; return count(input); });
    const pending = h.handle(h.request); await entered.promise;
    await vi.advanceTimersByTimeAsync(101);
    await expect(pending).resolves.toMatchObject({ outcome: 'rejected', reason: 'counter_interrupted' });
    expect(h.service.store.list()[0]).toMatchObject({ state: 'counter_interrupted', counterCalls: 1 });
    gate.resolve(); await new Promise<void>(done => setImmediate(done));
    expect(h.service.store.list()[0]?.state).toBe('counter_interrupted');
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(h.completions).toHaveLength(1);
  });

  it('stops an abort-ignoring authority wait without allowing its late grant to reserve', async () => {
    const gate = deferred(); const entered = deferred();
    const h = await harness({ authorityResolver: { ...ALWAYS_AUTHORIZED, resolveScope: async claim => { entered.resolve(); await gate.promise; return ALWAYS_AUTHORIZED.resolveScope(claim); } } });
    cleanups.push(async () => { gate.resolve(); });
    const pending = h.handle(h.request); await entered.promise;
    await h.service.stop();
    await expect(pending).resolves.toMatchObject({ outcome: 'rejected', reason: 'cancelled' });
    gate.resolve(); await new Promise<void>(done => setImmediate(done));
    expect(h.reserve).not.toHaveBeenCalled(); expect(h.compiler.calls).toHaveLength(0);
  });

  it('bounds a pure compiler that ignores abort and never admits its late result to a counter', async () => {
    const h = await harness(); const gate = deferred(); const entered = deferred();
    cleanups.push(async () => { gate.resolve(); });
    const compile = h.compiler.compile.bind(h.compiler);
    h.compiler.compile = async input => { entered.resolve(); await gate.promise; return compile(input); };
    const pending = h.handle(h.request); await entered.promise;
    await vi.advanceTimersByTimeAsync(101);
    await expect(pending).resolves.toMatchObject({ outcome: 'rejected', reason: 'cancelled' });
    expect(h.service.store.list()[0]?.state).toBe('cancelled');
    gate.resolve(); await new Promise<void>(done => setImmediate(done));
    expect(h.counter.calls).toHaveLength(0);
    expect(h.service.store.list()[0]?.state).toBe('cancelled');
  });


  it('includes pending cloud readback in the local ceiling while keeping terminal replay independent', async () => {
    const h = await harness({ limits: { ...LIMITS, preparationDeadlineMs: 100 } });
    vi.spyOn(h.completion, 'readCompleted').mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 101); return undefined; });
    await expect(h.handle({ ...h.request, deadlineAt: new Date(Date.now() + 10_000).toISOString() })).resolves.toMatchObject({ outcome: 'rejected', reason: 'deadline_elapsed' });
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it('waits for owned assembly cleanup after expiry and never starts the compiler afterward', async () => {
    const h = await harness(); const gate = deferred(); const entered = deferred();
    cleanups.push(async () => { gate.resolve(); });
    const assemble = h.toolSurface.assemble.bind(h.toolSurface);
    let cleaned = false;
    h.toolSurface.assemble = async input => { entered.resolve(); await gate.promise; cleaned = true; return assemble(input); };
    const pending = h.handle(h.request); await entered.promise;
    await vi.advanceTimersByTimeAsync(101);
    expect(h.completions).toHaveLength(0);
    const stopped = observe(h.service.stop());
    await new Promise<void>(done => setImmediate(done));
    expect(stopped.state).toBe('pending');
    gate.resolve();
    await expect(pending).resolves.toMatchObject({ outcome: 'rejected', reason: 'cancelled' });
    await new Promise<void>(done => setImmediate(done));
    expect(stopped.state).toBe('resolved');
    expect(cleaned).toBe(true);
    expect(h.compiler.calls).toHaveLength(0); expect(h.counter.calls).toHaveLength(0);
    expect(h.service.store.list()[0]?.state).toBe('cancelled');
  });

  it.each([NaN, Infinity, -Infinity])('fails closed on a non-finite local absolute deadline %s', async deadlineAt => {
    const h = await harness();
    await expect(h.service.prepare(localRequest(h.request), { deadlineAt })).rejects.toMatchObject({ code: 'bad_request' });
    expect(h.reserve).not.toHaveBeenCalled();
  });


  it('withdraws the caller while shared store initialization remains owned and drained by stop', async () => {
    const h = await harness({ open: false }); const gate = deferred(); const entered = deferred();
    cleanups.push(async () => { gate.resolve(); });
    const open = h.service.store.open.bind(h.service.store);
    vi.spyOn(h.service.store, 'open').mockImplementationOnce(async () => { entered.resolve(); await gate.promise; await open(); });
    const pending = h.handle(h.request); await entered.promise;
    await vi.advanceTimersByTimeAsync(101);
    await expect(pending).resolves.toMatchObject({ outcome: 'rejected', reason: 'cancelled' });
    const stopped = observe(h.service.stop());
    await new Promise<void>(done => setImmediate(done));
    expect(stopped.state).toBe('pending');
    gate.resolve();
    await h.service.stop();
    expect(stopped.state).toBe('resolved');
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.service.store.list()).toHaveLength(0);
  });


  it('does not report a late owned terminal write as in-budget success or rewrite its durable fact', async () => {
    const h = await harness({ counter: false }); const gate = deferred(); const entered = deferred();
    cleanups.push(async () => { gate.resolve(); });
    const commit = h.service.store.commitPreparedArtifact.bind(h.service.store);
    vi.spyOn(h.service.store, 'commitPreparedArtifact').mockImplementationOnce(async input => { const result = await commit(input); entered.resolve(); await gate.promise; return result; });
    const pending = h.handle(h.request); await entered.promise;
    await vi.advanceTimersByTimeAsync(101);
    expect(h.completions).toHaveLength(0);
    gate.resolve();
    await expect(pending).resolves.toMatchObject({ outcome: 'rejected', reason: 'cancelled' });
    // The already committed artifact remains its original immutable local
    // fact. Expiry withdraws this call, not the truth of a completed write.
    expect(h.service.store.list()[0]?.state).toBe('prepared');
    expect(h.compiler.calls).toHaveLength(1); expect(h.counter.calls).toHaveLength(0);
  });


  it('rechecks the absolute clock at admission invocation after synchronous validation consumed the budget', async () => {
    const resolveScope = vi.fn(ALWAYS_AUTHORIZED.resolveScope);
    const limits = { ...LIMITS, get maxRequestBytes() { vi.setSystemTime(Date.now() + 101); return LIMITS.maxRequestBytes; } };
    const h = await harness({ limits, authorityResolver: { ...ALWAYS_AUTHORIZED, resolveScope } });
    await expect(h.handle(h.request)).resolves.toMatchObject({ outcome: 'rejected' });
    expect(resolveScope).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
  });

});

it('R1: fences counter evidence received after absolute deadline without timer delivery', async () => {
  const h = await harness();
  const count = h.counter.count.bind(h.counter);
  vi.spyOn(h.counter, 'count').mockImplementationOnce(async input => {
    const result = await count(input);
    vi.setSystemTime(Date.now() + 101);
    return result;
  });
  await expect(h.handle(h.request)).resolves.toMatchObject({ outcome: 'rejected', reason: 'counter_interrupted' });
  expect(h.service.store.list()[0]).toMatchObject({ state: 'counter_interrupted', counterCalls: 1, detail: 'counter_deadline_elapsed' });
  expect(h.service.store.list()[0]?.counter).toBeUndefined();
  await expect(h.service.prepare(localRequest(h.request), { deadlineAt: Date.now() + 1_000 })).resolves.toMatchObject({ state: 'counter_interrupted' });
  expect(h.counter.calls).toHaveLength(1);
});

it.each([0, 1, 2, 3, 4, 5])('R1: no counter admission after expiry between microtasks %s', async depth => {
  const h = await harness();
  const deadline = Date.parse(h.request.deadlineAt);
  const commit = h.service.store.commitCounterReservation.bind(h.service.store);
  const lateCalls: number[] = [];
  const count = h.counter.count.bind(h.counter);
  vi.spyOn(h.counter, 'count').mockImplementation(input => {
    if (Date.now() >= deadline) lateCalls.push(Date.now());
    return count(input);
  });
  vi.spyOn(h.service.store, 'commitCounterReservation').mockImplementationOnce(async input => {
    const result = await commit(input);
    const advance = (n: number): void => {
      if (n === 0) vi.setSystemTime(deadline + 1);
      else queueMicrotask(() => advance(n - 1));
    };
    queueMicrotask(() => advance(depth));
    return result;
  });
  await h.handle(h.request);
  expect(lateCalls).toHaveLength(0);
});

it.each([0, 1, 2])('R1: no assembly admission after expiry between reservation microtasks %s', async depth => {
  const h = await harness();
  const deadline = Date.parse(h.request.deadlineAt);
  const assemble = h.toolSurface.assemble.bind(h.toolSurface);
  const lateCalls: number[] = [];
  vi.spyOn(h.toolSurface, 'assemble').mockImplementation(input => {
    if (Date.now() >= deadline) lateCalls.push(Date.now());
    return assemble(input);
  });
  h.reserve.mockImplementationOnce(async input => {
    const result = await h.realReserve(input);
    const advance = (n: number): void => {
      if (n === 0) vi.setSystemTime(deadline + 1);
      else queueMicrotask(() => advance(n - 1));
    };
    queueMicrotask(() => advance(depth));
    return result;
  });
  await h.handle(h.request);
  expect(lateCalls).toHaveLength(0);
  expect(h.counter.calls).toHaveLength(0);
});

it('R1: cancels cleanly when counter setup consumes the remaining budget', async () => {
  let advanceClock = false;
  const limits = { ...LIMITS, get counterTimeoutMs() {
    if (advanceClock) vi.setSystemTime(Date.now() + 101);
    return LIMITS.counterTimeoutMs;
  } };
  const h = await harness({ limits });
  const commit = h.service.store.commitCounterReservation.bind(h.service.store);
  vi.spyOn(h.service.store, 'commitCounterReservation').mockImplementationOnce(async input => {
    const result = await commit(input);
    advanceClock = true;
    return result;
  });
  await expect(h.handle(h.request)).resolves.toMatchObject({ outcome: 'rejected', reason: 'cancelled' });
  expect(h.counter.calls).toHaveLength(0);
  expect(h.service.store.list()[0]).toMatchObject({ state: 'cancelled', counterCalls: 1 });
});

it('R1: fences evidence validation that consumes the remaining budget', async () => {
  const h = await harness();
  const count = h.counter.count.bind(h.counter);
  vi.spyOn(h.counter, 'count').mockImplementationOnce(async input => {
    const result = await count(input);
    return { ...result, get value() { vi.setSystemTime(Date.now() + 101); return result.value; } };
  });
  await expect(h.handle(h.request)).resolves.toMatchObject({ outcome: 'rejected', reason: 'counter_interrupted' });
  expect(h.counter.calls).toHaveLength(1);
  expect(h.service.store.list()[0]).toMatchObject({ state: 'counter_interrupted', counterCalls: 1 });
  expect(h.service.store.list()[0]?.counter).toBeUndefined();
});

it('R1: drains an in-budget counter terminal write whose acknowledgement crosses expiry', async () => {
  const h = await harness(); const entered = deferred(); const gate = deferred();
  cleanups.push(async () => { gate.resolve(); });
  const update = h.service.store.update.bind(h.service.store);
  vi.spyOn(h.service.store, 'update').mockImplementation(async (recordId, changes) => {
    const record = await update(recordId, changes);
    if (changes.state === 'prepared') { entered.resolve(); await gate.promise; }
    return record;
  });
  const pending = h.handle(h.request); await entered.promise;
  await vi.advanceTimersByTimeAsync(101);
  expect(h.completions).toHaveLength(0);
  gate.resolve();
  await expect(pending).resolves.toMatchObject({ outcome: 'rejected', reason: 'cancelled' });
  expect(h.counter.calls).toHaveLength(1);
  expect(h.service.store.list()[0]).toMatchObject({ state: 'prepared', counterCalls: 1, counter: { value: 123 } });
});

it.each([false, true])('R1: refuses new artifact commitment after summary work consumes the budget (counter=%s)', async counter => {
  const h = await harness({ counter: counter ? undefined : false });
  const compile = h.compiler.compile.bind(h.compiler);
  vi.spyOn(h.compiler, 'compile').mockImplementationOnce(async input => {
    const compiled = await compile(input);
    return { ...compiled, get requestBytes() { vi.setSystemTime(Date.now() + 101); return compiled.requestBytes; } };
  });
  const commitCounter = vi.spyOn(h.service.store, 'commitCounterReservation');
  const commitPrepared = vi.spyOn(h.service.store, 'commitPreparedArtifact');
  await expect(h.handle(h.request)).resolves.toMatchObject({ outcome: 'rejected', reason: 'cancelled' });
  expect(commitCounter).not.toHaveBeenCalled();
  expect(commitPrepared).not.toHaveBeenCalled();
  expect(h.counter.calls).toHaveLength(0);
  expect(h.service.store.list()[0]).toMatchObject({ state: 'cancelled', counterCalls: 0 });
});
