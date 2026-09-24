/**
 * Official Pi 0.87.1 conformance — A1' amended (compile with the real
 * projected model): transport scoping on a real endpoint (d') and the sink-URL
 * compat hazard (g). The injected fetch is the only transport; a
 * `globalThis.fetch` spy fails the test if anything reaches the global one.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, normalizeContext } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { InputPreparationModelV1 } from '../../../input-preparation';
import {
  createPiInputPreparationCompiler,
  resolveInstalledPiRuntimeIdentity,
  type CompilePreparedInputRequest,
} from '../input-preparation';
import {
  buildPreparedTranscriptMessages,
  compilePreparedProviderRequest,
  PREPARED_COMPILE_API_KEY,
  PREPARED_PROVIDER_SESSION_ID,
  preparedProviderStreamOptions,
  projectPreparedModel,
  type PreparedRequestOptionsV1,
  type PreparedTranscriptV1,
} from '../prepared-request';
import {
  createPreparedGate,
  createPreparedPiSession,
  PREPARED_TRIGGER_TEXT,
  registerPreparedProvider,
} from '../prepared-session';
import { byteLength, installGlobalFetchSpy, sha256, SINK_BASE_URL, textResponse, type GlobalFetchSpy } from './official-pi-fixture';

const TIMEOUT_MS = 30_000;
const REAL_BASE_URL = 'https://api.z.ai/api/paas/v4';

/** The wire `compat` subset: every key the SDK's model record can carry. */
const WIRE_COMPAT = Object.freeze({
  thinkingFormat: 'zai',
  supportsDeveloperRole: false,
  supportsStore: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  maxTokensField: 'max_tokens',
  zaiToolStream: false,
});

function model(provider: string, baseUrl: string, compat: object | null = WIRE_COMPAT): InputPreparationModelV1 {
  return {
    id: 'glm-conformance',
    name: 'glm-conformance',
    api: 'openai-completions',
    provider,
    baseUrl,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
    ...(compat === null ? {} : { compat }),
  } as InputPreparationModelV1;
}

const TRANSCRIPT: PreparedTranscriptV1 = Object.freeze({
  systemPrompt: 'HOST FRAMING: you are the Host bot.',
  tools: [{
    name: 'byok_observe',
    description: 'Observation-only tool declaration.',
    parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
  }],
  messages: [
    { role: 'user', content: 'earlier user turn', timestamp: 1 },
    { role: 'assistant', origin: 'host_canonical', content: 'earlier Host-canonical assistant text', timestamp: 2 },
    { role: 'user', content: 'INPUT DOCUMENT: current request', timestamp: 3 },
  ],
}) as PreparedTranscriptV1;

const OPTIONS: PreparedRequestOptionsV1 = Object.freeze({
  cacheRetention: 'none',
  maxTokens: 4_096,
  reasoningEffort: 'medium',
  sessionId: PREPARED_PROVIDER_SESSION_ID,
});

let globalFetch: GlobalFetchSpy;
beforeEach(() => {
  globalFetch = installGlobalFetchSpy();
});
afterEach(() => {
  globalFetch.restore();
});

describe('official Pi 0.87.1: A1\' amended transport scoping', () => {
  test('(d\') compile against a real non-loopback endpoint: capture fetch called exactly once, global fetch never', async () => {
    const real = projectPreparedModel(model('zai-byok', REAL_BASE_URL));
    // The exact construction the SDK compile uses, with a counting capture.
    const captured: { url: string; body: unknown }[] = [];
    const stream = streamSimple(real, normalizeContext({ messages: buildPreparedTranscriptMessages(TRANSCRIPT) }), {
      ...preparedProviderStreamOptions(OPTIONS),
      apiKey: PREPARED_COMPILE_API_KEY,
      maxRetries: 0,
      fetch: (async (resource: string | URL | Request, init?: RequestInit) => {
        captured.push({ url: resource instanceof Request ? resource.url : String(resource), body: init?.body });
        throw new Error('capture only');
      }) as typeof fetch,
    });
    for await (const _event of stream) { /* drain */ }
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe(`${REAL_BASE_URL}/chat/completions`);
    expect(typeof captured[0]!.body).toBe('string');

    // The SDK entry itself: it refuses unless exactly one capture happened, so
    // success is the same assertion made from the inside.
    const compiled = await compilePreparedProviderRequest({ model: real, messages: buildPreparedTranscriptMessages(TRANSCRIPT), options: OPTIONS });
    expect(compiled.body).toBe(captured[0]!.body);
    expect(compiled.endpoint).toBe(`${REAL_BASE_URL}/chat/completions`);
    expect(globalFetch.calls).toEqual([]);
    console.info('[conformance d\'] D', byteLength(compiled.body), sha256(compiled.body));
  });
});

describe('official Pi 0.87.1: compat is endpoint-detected (g)', () => {
  test('(g) sink-URL vs real-URL compile differ under the wire compat subset; real vs gated real is identical', async () => {
    const messages = buildPreparedTranscriptMessages(TRANSCRIPT);
    // Same provider id on both sides, so only the endpoint differs.
    const sink = await compilePreparedProviderRequest({ model: projectPreparedModel(model('openai', SINK_BASE_URL)), messages, options: OPTIONS });
    const realOpenAi = await compilePreparedProviderRequest({
      model: projectPreparedModel(model('openai', 'https://api.openai.com/v1')), messages, options: OPTIONS,
    });
    // With retention `none` and this compat record the two agree: nothing
    // endpoint-detected reaches the body.
    expect(realOpenAi.body).toBe(sink.body);
    // api.openai.com is detected as prompt-cache capable: with any retention
    // other than `none` it adds `prompt_cache_key`, which no wire compat key
    // can pin. A sink compile would miss it.
    const sinkShort = await compilePreparedProviderRequest({
      model: projectPreparedModel(model('openai', SINK_BASE_URL)), messages, options: { ...OPTIONS, cacheRetention: 'short' },
    });
    const realOpenAiShort = await compilePreparedProviderRequest({
      model: projectPreparedModel(model('openai', 'https://api.openai.com/v1')), messages, options: { ...OPTIONS, cacheRetention: 'short' },
    });
    expect(realOpenAiShort.body).not.toBe(sinkShort.body);
    expect(JSON.parse(realOpenAiShort.body).prompt_cache_key).toBe(PREPARED_PROVIDER_SESSION_ID);
    expect(JSON.parse(sinkShort.body).prompt_cache_key).toBeUndefined();

    // z.ai with the wire compat subset: recorded, whichever way it falls.
    const zaiSink = await compilePreparedProviderRequest({ model: projectPreparedModel(model('zai-byok', SINK_BASE_URL)), messages, options: OPTIONS });
    const zaiReal = await compilePreparedProviderRequest({ model: projectPreparedModel(model('zai-byok', REAL_BASE_URL)), messages, options: OPTIONS });
    // Equal for z.ai: every body-affecting compat key z.ai detection would set
    // is pinned explicitly by the wire subset here. Coincidental to this
    // endpoint and this compat record; the api.openai.com case above is not.
    expect(zaiReal.body).toBe(zaiSink.body);
    // Without a declared compat record, z.ai's thinking format is detected
    // from the endpoint, so the sink compile is a different request.
    const zaiSinkBare = await compilePreparedProviderRequest({
      model: projectPreparedModel(model('byok-opaque', SINK_BASE_URL, null)), messages, options: OPTIONS,
    });
    const zaiRealBare = await compilePreparedProviderRequest({
      model: projectPreparedModel(model('byok-opaque', REAL_BASE_URL, null)), messages, options: OPTIONS,
    });
    expect(zaiRealBare.body).not.toBe(zaiSinkBare.body);
    console.info('[conformance g] openai sink/real none', byteLength(sink.body), sha256(sink.body), byteLength(realOpenAi.body), sha256(realOpenAi.body),
      '| short', byteLength(sinkShort.body), sha256(sinkShort.body), byteLength(realOpenAiShort.body), sha256(realOpenAiShort.body),
      '| zai sink/real', byteLength(zaiSink.body), sha256(zaiSink.body), byteLength(zaiReal.body), sha256(zaiReal.body),
      '| zai no-compat sink/real', byteLength(zaiSinkBare.body), sha256(zaiSinkBare.body), byteLength(zaiRealBare.body), sha256(zaiRealBare.body));

    // Real vs gated real: the SDK compiler's D for the real model is exactly
    // the first body the live registered gate sees.
    const request: CompilePreparedInputRequest = {
      snapshot: {
        prompt: {
          customPrompt: TRANSCRIPT.systemPrompt, cwd: '/agent', selectedTools: ['byok_observe'], toolSnippets: {},
          toolGuidelines: {}, promptGuidelines: [], contextFiles: [], skills: [],
          docsPaths: { readmePath: '', docsPath: '', examplesPath: '' },
        },
        messages: TRANSCRIPT.messages,
        tools: TRANSCRIPT.tools,
      },
      model: model('openai', 'https://api.openai.com/v1'),
      options: { cacheRetention: 'short', maxTokens: 4_096, reasoningEffort: 'medium' },
      binding: { inputIdentity: 'i', runtimeIdentity: 'r', policyIdentity: 'p', profileRevision: 'v' },
      toolExecutors: { byok_observe: 'b'.repeat(64) },
    };
    const compiled = await createPiInputPreparationCompiler(resolveInstalledPiRuntimeIdentity()).compile(request);
    expect(compiled.requestBody).toBe(realOpenAiShort.body);
    expect(compiled.residual).toContainEqual({ key: 'prompt_cache_key', valueClass: 'constant' });

    const root = mkdtempSync(path.join(tmpdir(), 'byok-conformance-g-'));
    const sends: string[] = [];
    const gate = createPreparedGate({
      transport: (async (_resource: unknown, init?: RequestInit) => {
        sends.push(String(init?.body));
        return textResponse('done', true);
      }) as typeof fetch,
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
    });
    const registered = registerPreparedProvider(modelRuntime, request.model, { apiKey: 'synthetic-not-a-secret' }, gate);
    const verdicts: unknown[] = [];
    gate.arm(compiled.envelope, (refusal) => verdicts.push(refusal));
    const tool = {
      name: 'byok_observe', label: 'observe', description: 'Observation-only tool declaration.',
      parameters: TRANSCRIPT.tools[0]!.parameters as never,
      execute: async () => ({ content: [{ type: 'text' as const, text: 'observed' }], details: {} }),
    };
    const { session } = await createPreparedPiSession({
      envelope: compiled.envelope, gate, model: registered, cwd: path.join(root, 'cwd'), agentDir: path.join(root, 'agent'),
      modelRuntime, tools: [{ name: 'byok_observe', identity: 'b'.repeat(64), tool: tool as never }],
    });
    try {
      await session.prompt(PREPARED_TRIGGER_TEXT);
      await session.waitForIdle();
    } finally {
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
    expect(verdicts).toEqual([undefined]);
    expect(sends).toEqual([compiled.requestBody]);
    expect(globalFetch.calls).toEqual([]);
  }, TIMEOUT_MS);
});
