/**
 * The SDK prepared lane on official Pi 0.87.1: A1' compile through the SDK
 * compiler, consume-side verification, and the registered byte gate in a real
 * official `AgentSession`. Synthetic SSE only; a `globalThis.fetch` spy fails
 * the test if anything reaches the global transport.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ModelRuntime, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { InputPreparationCompiledSnapshotV1, InputPreparationModelV1 } from '../../../input-preparation';
import {
  createPiInputPreparationCompiler,
  InputPreparationCompileError,
  resolveInstalledPiRuntimeIdentity,
  verifyPreparedPiInput,
  type CompilePreparedInputRequest,
  type PreparedPiExpectedV1,
  type PreparedPiInputV1,
} from '../input-preparation';
import {
  canonicalPreparedDigest,
  loadOfficialCompiler,
  PREPARED_HOST_ASSISTANT_PROVENANCE,
  PreparedSessionError,
} from '../prepared-request';
import {
  createPreparedGate,
  createPreparedPiSession,
  PREPARED_TRIGGER_TEXT,
  registerPreparedProvider,
  type PreparedGateRefusal,
} from '../prepared-session';
import { installGlobalFetchSpy, textResponse, toolCallResponse, type GlobalFetchSpy } from './official-pi-fixture';

const TIMEOUT_MS = 30_000;
const TOOL_NAME = 'byok_observe';
const TOOL_IDENTITY = 'a'.repeat(64);

const MODEL: InputPreparationModelV1 = Object.freeze({
  id: 'glm-conformance',
  name: 'glm-conformance',
  api: 'openai-completions',
  provider: 'byok-opaque-test',
  baseUrl: 'https://api.z.ai/api/paas/v4',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
  thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
  compat: { thinkingFormat: 'zai', supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens' },
}) as InputPreparationModelV1;

function snapshot(overrides: Partial<InputPreparationCompiledSnapshotV1['prompt']> = {}): InputPreparationCompiledSnapshotV1 {
  return {
    prompt: { systemPrompt: 'HOST FRAMING: you are the Host bot.', ...overrides },
    messages: [
      { role: 'user', content: 'earlier user turn 你好', timestamp: 1 },
      { role: 'assistant', origin: 'host_canonical', content: 'earlier Host-canonical assistant text', timestamp: 2 },
      { role: 'user', content: 'INPUT DOCUMENT: current request', timestamp: 3 },
    ],
    tools: [{
      name: TOOL_NAME,
      description: 'Observation-only tool declaration.',
      parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
    }],
  };
}

const BINDING = Object.freeze({
  inputIdentity: 'rev:digest',
  runtimeIdentity: 'runtime',
  policyIdentity: 'policy',
  profileRevision: 'profile',
});

function compileRequest(overrides: Partial<CompilePreparedInputRequest> = {}): CompilePreparedInputRequest {
  return {
    snapshot: snapshot(),
    model: MODEL,
    options: { cacheRetention: 'none', maxTokens: 4_096, reasoningEffort: 'medium' },
    binding: BINDING,
    toolExecutors: { [TOOL_NAME]: TOOL_IDENTITY },
    ...overrides,
  };
}

function expectedFor(envelope: PreparedPiInputV1): PreparedPiExpectedV1 {
  return { digest: envelope.digest, model: MODEL, binding: BINDING, toolManifestDigest: envelope.toolManifest.digest };
}

let globalFetch: GlobalFetchSpy;
let root: string;
beforeEach(() => {
  globalFetch = installGlobalFetchSpy();
  root = mkdtempSync(path.join(tmpdir(), 'byok-prepared-lane-'));
});
afterEach(() => {
  globalFetch.restore();
  rmSync(root, { recursive: true, force: true });
});

async function compile(request = compileRequest()) {
  return createPiInputPreparationCompiler(resolveInstalledPiRuntimeIdentity()).compile(request);
}

interface Run {
  readonly verdicts: (PreparedGateRefusal | undefined)[];
  readonly sends: string[];
  readonly gate: ReturnType<typeof createPreparedGate>;
  toolExecutions: number;
}

async function runPrepared(envelope: PreparedPiInputV1, respond: (sequence: number) => Response): Promise<Run> {
  const sends: string[] = [];
  const gate = createPreparedGate({
    transport: (async (_resource: unknown, init?: RequestInit) => {
      sends.push(String(init?.body));
      return respond(sends.length);
    }) as typeof fetch,
  });
  const credentials = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const model = registerPreparedProvider(modelRuntime, MODEL, { apiKey: 'synthetic-not-a-secret' }, gate);
  const run: Run = { verdicts: [], sends, gate, toolExecutions: 0 };
  gate.arm(envelope, (refusal) => run.verdicts.push(refusal));
  const tool: ToolDefinition = {
    name: TOOL_NAME,
    label: 'observe',
    description: 'Observation-only tool declaration.',
    parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } as never,
    execute: async () => {
      run.toolExecutions += 1;
      return { content: [{ type: 'text', text: 'observed' }], details: {} };
    },
  } as ToolDefinition;
  const { session } = await createPreparedPiSession({
    envelope,
    gate,
    model,
    cwd: path.join(root, 'cwd'),
    agentDir: path.join(root, 'agent'),
    modelRuntime,
    tools: envelope.toolManifest.order.length === 0 ? [] : [{ name: TOOL_NAME, identity: TOOL_IDENTITY, tool }],
    sessionId: 'prepared-session-test',
  });
  try {
    await session.prompt(PREPARED_TRIGGER_TEXT);
    await session.waitForIdle();
  } finally {
    session.dispose();
  }
  return run;
}

describe('SDK prepared compile on official Pi 0.87.1', () => {
  test('compiles a Host-authored system message, no sentinel on the wire, and verifies on the consume side', async () => {
    const compiled = await compile();
    const d = JSON.parse(compiled.requestBody) as { messages: { role: string; content: unknown }[]; tools: { function: Record<string, unknown> }[] };
    expect(d.messages[0]).toEqual({ role: 'system', content: 'HOST FRAMING: you are the Host bot.' });
    expect(d.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(d.tools).toHaveLength(1);
    expect(Object.hasOwn(d.tools[0]!.function, 'strict')).toBe(false);
    for (const value of Object.values(PREPARED_HOST_ASSISTANT_PROVENANCE)) {
      expect(compiled.requestBody).not.toContain(value);
      expect(JSON.stringify(compiled.envelope)).not.toContain(value);
    }
    expect(compiled.envelope.providerRequest.endpoint).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    expect(compiled.projection.kind).toBe('content_complete');
    expect(compiled.envelope.version).toBe(4);
    expect(compiled.counterProjection).toBe(compiled.requestBody);
    expect(compiled.residual).toEqual([]);
    expect(compiled.requestBytes).toBe(Buffer.byteLength(compiled.requestBody, 'utf8'));
    const again = await compile();
    expect(again.requestBody).toBe(compiled.requestBody);
    expect(again.envelopeDigest).toBe(compiled.envelopeDigest);
    await expect(verifyPreparedPiInput(compiled.envelope, expectedFor(compiled.envelope))).resolves.toBeDefined();
    expect(globalFetch.calls).toEqual([]);
  });

  test('refuses prompt fields only the retired renderer could render', async () => {
    for (const prompt of [
      { customPrompt: 'retired' },
      { appendSystemPrompt: 'append' },
      { promptGuidelines: ['g'] },
      { contextFiles: [{ path: 'AGENTS.md', content: 'x' }] },
    ] as unknown as Partial<InputPreparationCompiledSnapshotV1['prompt']>[]) {
      const error = await compile(compileRequest({ snapshot: snapshot(prompt) })).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(InputPreparationCompileError);
      expect((error as InputPreparationCompileError).detail).toBe('prompt_render_input_unsupported');
    }
  });

  test('refuses strict: "require" tool declarations', async () => {
    const base = snapshot();
    const strict = { ...base, tools: [{ ...base.tools[0]!, constrainedSampling: { type: 'json_schema', strict: 'require' } }] };
    const error = await compile(compileRequest({ snapshot: strict as never })).catch((cause: unknown) => cause);
    expect((error as InputPreparationCompileError).detail).toBe('tool_constrained_sampling_unsupported');
  });

  test('consume-side verification refuses a tampered transcript, a re-digested drift and a foreign expectation', async () => {
    const { envelope } = await compile();
    const tampered = structuredClone(envelope) as { transcript: { systemPrompt: string } };
    tampered.transcript.systemPrompt = 'drifted';
    await expect(verifyPreparedPiInput(tampered, expectedFor(envelope))).rejects.toMatchObject({ code: 'prepared_digest_mismatch' });

    const { digest: _ignored, ...data } = tampered as unknown as PreparedPiInputV1;
    const redigested = { ...data, digest: canonicalPreparedDigest(data) };
    await expect(verifyPreparedPiInput(redigested, { ...expectedFor(envelope), digest: redigested.digest }))
      .rejects.toMatchObject({ code: 'prepared_context_drift' });

    await expect(verifyPreparedPiInput(envelope, { ...expectedFor(envelope), binding: { ...BINDING, policyIdentity: 'other' } }))
      .rejects.toBeInstanceOf(PreparedSessionError);
  });
});

describe('SDK prepared session on official Pi 0.87.1: byte gate', () => {
  test('request 1 is D byte-for-byte, the tool-result request passes under its own sequence', async () => {
    const { envelope, requestBody } = await compile();
    const run = await runPrepared(envelope, (sequence) => (sequence === 1 ? toolCallResponse() : textResponse('done', true)));
    expect(run.verdicts).toEqual([undefined]);
    expect(run.gate.state.refusal).toBeUndefined();
    expect(run.gate.state.admitted).toEqual([1, 2]);
    expect(run.sends[0]).toBe(requestBody);
    expect(run.sends[1]).not.toBe(requestBody);
    expect(run.toolExecutions).toBe(1);
    expect(globalFetch.calls).toEqual([]);
  }, TIMEOUT_MS);

  test('a body that is not D is refused before any send, with the typed reason written first', async () => {
    const { envelope } = await compile();
    const drifted = structuredClone(envelope) as unknown as { providerRequest: { body: string } };
    drifted.providerRequest.body = drifted.providerRequest.body.replace('current request', 'drifted request');
    const run = await runPrepared(drifted as unknown as PreparedPiInputV1, () => textResponse('never', true));
    expect(run.sends).toEqual([]);
    expect(run.verdicts).toHaveLength(1);
    expect(run.verdicts[0]?.code).toBe('prepared_body_drift');
    expect(run.gate.state.refusal?.code).toBe('prepared_body_drift');
    expect(run.gate.state.sequence).toBe(1);
    expect(globalFetch.calls).toEqual([]);
  }, TIMEOUT_MS);

  test('the context handler refuses to project before arming, a lost system head, or a foreign tail message', async () => {
    const unarmed = createPreparedGate();
    expect(unarmed.projectContext([])).toBeUndefined();
    expect(unarmed.state.contextAnomaly).toMatch(/before the prepared input was armed/u);

    const { envelope } = await compile();
    const trigger = { role: 'user' as const, content: PREPARED_TRIGGER_TEXT, timestamp: 9 };
    const system = { role: 'system' as const, content: 'native', timestamp: 0 };

    const lostHead = createPreparedGate();
    lostHead.arm(envelope, () => {});
    expect(lostHead.projectContext([trigger])).toBeUndefined();
    expect(lostHead.state.contextAnomaly).toMatch(/Host system message would be lost/u);

    const steered = createPreparedGate();
    steered.arm(envelope, () => {});
    expect(steered.projectContext([system, trigger, { role: 'user', content: 'steer', timestamp: 10 }])).toBeUndefined();
    expect(steered.state.contextAnomaly).toMatch(/did not produce/u);
    expect(steered.state.contextProjected).toBe(0);

    const clean = createPreparedGate();
    clean.arm(envelope, () => {});
    const projected = clean.projectContext([system, trigger]);
    expect(projected?.[0]).toMatchObject({ role: 'system', content: envelope.transcript.systemPrompt });
    expect(projected?.[2]).toMatchObject({ role: 'assistant', ...PREPARED_HOST_ASSISTANT_PROVENANCE, stopReason: 'stop' });
    expect(clean.state.contextProjected).toBe(1);
    expect(() => clean.arm(envelope, () => {})).toThrow(PreparedSessionError);
  });
});

const OPENAI_CONSTRUCTOR_ENV = ['OPENAI_ADMIN_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID',
  'OPENAI_WEBHOOK_SECRET', 'OPENAI_LOG', 'OPENAI_CUSTOM_HEADERS'] as const;

test('A1 double-prime: six polluted OpenAI variables do not change D', async () => {
  const baseline = await compile();
  try {
    for (const key of OPENAI_CONSTRUCTOR_ENV) vi.stubEnv(key,
      key === 'OPENAI_LOG' ? 'off' : key === 'OPENAI_CUSTOM_HEADERS' ? 'X-Canary: polluted' : 'synthetic-canary');
    const polluted = await compile();
    expect(polluted.requestBody).toBe(baseline.requestBody);
    expect(polluted.envelopeDigest).toBe(baseline.envelopeDigest);
    expect(globalFetch.calls).toEqual([]);
  } finally { vi.unstubAllEnvs(); }
});

test.each(['OpenAI-Organization', 'OpenAI-Project', 'X-Custom-Canary'])(
  'header gate refuses %s with zero sends', async header => {
    const { envelope } = await compile();
    const transport = vi.fn(async () => textResponse('must not send', true));
    const gate = createPreparedGate({ transport: transport as typeof fetch });
    gate.arm(envelope, () => {});
    const projected = gate.projectContext([{ role: 'system', content: '', timestamp: 0 },
      { role: 'user', content: PREPARED_TRIGGER_TEXT, timestamp: 0 }]);
    const { normalizeContext } = await import('@earendil-works/pi-ai');
    for await (const _ of gate.streamSimple(MODEL as never, normalizeContext({ messages: projected! }),
      { apiKey: 'synthetic-key', headers: { [header]: 'synthetic-value' }, maxRetries: 9 })) {}
    expect(gate.state.refusal?.code).toBe('prepared_headers_invalid');
    expect(transport).not.toHaveBeenCalled();
  });

test('real prepared session never retries a failed admitted transport', async () => {
  const { envelope } = await compile();
  const run = await runPrepared(envelope, () => { throw new Error('synthetic connection error'); });
  expect(run.sends).toEqual([envelope.providerRequest.body]);
  expect(run.gate.state.sequence).toBe(1);
  expect(run.gate.state.admitted).toEqual([1]);
});

test('empty observed tools compile and execute with zero native tools', async () => {
  const request = compileRequest();
  const compiled = await compile({ ...request, snapshot: { ...request.snapshot, tools: [] }, toolExecutors: {} });
  expect(compiled.envelope.toolManifest.order).toEqual([]);
  expect(JSON.parse(compiled.requestBody).tools).toBeUndefined();
  const run = await runPrepared(compiled.envelope, () => textResponse('zero tools', true));
  expect(run.verdicts).toEqual([undefined]);
  expect(run.sends).toEqual([compiled.requestBody]);
  expect(run.toolExecutions).toBe(0);
});

test.each([0, 2])('A1 double-prime refuses capture fetch called %i times', async calls => {
  const official = await loadOfficialCompiler();
  const fake = vi.spyOn(official, 'streamSimple').mockImplementation((async function* (...[_model, _context, options]: Parameters<typeof official.streamSimple>) {
    expect(options?.apiKey).toBe('byok-prepared-compile-placeholder');
    expect(options?.env).toEqual({});
    expect(options?.maxRetries).toBe(0);
    for (let i = 0; i < calls; i++) {
      await expect(options!.fetch!('https://provider.invalid/v1/chat/completions', { body: '{}' }))
        .rejects.toThrow('prepared compile capture: never sent');
    }
    yield { type: 'error' };
  }) as unknown as typeof official.streamSimple);
  try {
    await expect(compile()).rejects.toMatchObject({ detail: 'prepared_compile_capture_failed' });
    expect(globalFetch.calls).toEqual([]);
  } finally { fake.mockRestore(); }
});
