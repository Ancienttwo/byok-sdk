import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INPUT_PREPARATION_REQUEST_FORMAT,
  INPUT_PREPARATION_VERSION,
  InputPreparationPolicyError,
  canonicalInputPreparationJson,
  validateInputPreparationLimits,
  type InputPreparationAuthorityResolver,
  type InputPreparationCounterAdapter,
  type InputPreparationCounterRequestV1,
  type InputPreparationAccountingPolicyRefV1,
  type InputPreparationCounterProviderEvidenceV1,
  type InputPreparationCounterResultV1,
  type InputPreparationLimitsPolicyV1,
  type InputPreparationRequestV1,
} from '../input-preparation';
import { inputPreparationRuntimeIdentityString } from '../input-preparation';
import {
  createInputPreparationService,
  InputPreparationRequestError,
  type InputPreparationService,
} from '../daemon/input-preparation-service';
import { recordingToolSurface, type RecordingToolSurface } from './fixtures/prepared-tool-surface';
import {
  InputPreparationCompileError,
  InputPreparationRuntimeIdentityError,
  SUPPORTED_PREPARED_COMPILER_VERSION,
  preparedRequestContentIsTextOnly,
  verifyCompiledPreparedInput,
  type CompilePreparedInputRequest,
  type CompiledPreparedInput,
  type InputPreparationCompiler,
} from '../adapters/pi/input-preparation';
import {
  buildPreparedPromptCommand,
  PREPARED_PROMPT_COMMAND_ID,
} from '../adapters/pi/prepared-prompt-frame';
import { rpcFrameByteLength, RPC_MAX_FRAME_BYTES } from '../util/rpc-frame';

/**
 * B-P2 §10.5 for the orchestration layer: auth/isolation, purity of the
 * caller's copy, durability/idempotency, cancellation, and the policy/count
 * boundary — against a real durable store on a real temporary filesystem, a
 * stub compiler (so the assertions are about ORDER and AUTHORITY, not about
 * the native compiler, which `pi-input-preparation.test.ts` owns) and a
 * fixture counter that performs no live call.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tmpStoreDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-input-prep-svc-'));
  cleanups.push(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const LIMITS: InputPreparationLimitsPolicyV1 = validateInputPreparationLimits({
  revision: 'limits-rev-1',
  maxRequestBytes: 64_000,
  maxArtifactBytes: 200_000,
  maxScopeAggregateBytes: 400_000,
  maxInFlight: 4,
  maxCounterCallsPerScope: 8,
  counterTimeoutMs: 5_000,
  preparationDeadlineMs: 8_000,
  retentionMs: 60_000,
  retryHorizonMs: 30_000,
});

function request(overrides: Partial<InputPreparationRequestV1> = {}): InputPreparationRequestV1 {
  return {
    format: INPUT_PREPARATION_REQUEST_FORMAT,
    version: INPUT_PREPARATION_VERSION,
    requestId: 'prep-1',
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
    snapshot: {
      prompt: {
        cwd: '/workspace/project',
        toolSnippets: {},
        toolGuidelines: {},
        promptGuidelines: [],
        contextFiles: [],
        skills: [],
        docsPaths: { readmePath: 'README.md', docsPath: 'docs', examplesPath: 'examples' },
      },
      messages: [{ role: 'user', content: 'hello', timestamp: 1_700_000_000_000 }],
    },
    permissionMode: 'auto',
    requiredToolsets: ['team'],
    ...overrides,
  };
}

interface StubCompiler extends InputPreparationCompiler {
  readonly calls: CompilePreparedInputRequest[];
}

/** The exact identity string the service binds, so a Host ruling can name it. */
function runtimeIdentityOf(compiler: InputPreparationCompiler): string {
  return inputPreparationRuntimeIdentityString(compiler.runtime);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Provider evidence bound to the exact projection and target the adapter was handed. */
function fixtureEvidence(counterRequest: InputPreparationCounterRequestV1): InputPreparationCounterProviderEvidenceV1 {
  return {
    projectionDigest: sha256Hex(counterRequest.counterProjection),
    endpoint: counterRequest.target.endpoint,
    modelId: counterRequest.target.modelId,
    asserted: { httpStatus: 200, usageFields: { prompt_tokens: 123 }, responseDigest: 'e'.repeat(64) },
  };
}

/** The Host ruling that makes the stub compiler's one residual key applicable. */
function accountingPolicyRef(
  overrides: Partial<InputPreparationAccountingPolicyRefV1> = {},
): InputPreparationAccountingPolicyRefV1 {
  return {
    revision: 'accounting-rev-1',
    ruledRuntime: '@byok-sdk/pi-coding-agent@0.85.1005+d981de1229ef899957bbe968bc8dcda02a21f477.1',
    ruledTarget: { endpoint: 'https://api.z.ai/api/coding/paas/v4', modelId: 'glm-4.6' },
    ruledResidualKeys: ['max_tokens'],
    ...overrides,
  };
}

function stubCompiler(
  options: {
    fail?: boolean;
    body?: () => string;
    projectionKind?: 'content_complete' | 'unknown';
    residual?: readonly { readonly key: string; readonly valueClass: 'bounded_integer' }[];
    compilerVersion?: number;
  } = {},
): StubCompiler {
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
      // The contract this build prepares against, unless a test states another
      // one on purpose — a fixture that pinned a literal would quietly make
      // every receipt in this file carry `runtime_contract_superseded`.
      compilerVersion: options.compilerVersion ?? SUPPORTED_PREPARED_COMPILER_VERSION,
    },
    async compile(compileRequest: CompilePreparedInputRequest): Promise<CompiledPreparedInput> {
      // Deep-copy at capture time so a later mutation of the service's own
      // object cannot rewrite what this test observed.
      calls.push(structuredClone(compileRequest) as CompilePreparedInputRequest);
      if (options.fail === true) throw new InputPreparationCompileError('stub refuses this input');
      // A chat-completions-shaped D: `messages` is what the text-only rule
      // reads, and a D without it is (correctly) never text-only.
      const body = options.body?.() ?? JSON.stringify({
        model: compileRequest.model.id,
        messages: compileRequest.snapshot.messages.map((message) => ({ role: message.role, content: message.content })),
        snapshot: compileRequest.snapshot,
      });
      const counterProjection = JSON.stringify({ model: compileRequest.model.id });
      return {
        requestBody: body,
        counterProjection,
        requestBytes: Buffer.byteLength(body, 'utf8'),
        projectionBytes: 32,
        requestDigest: 'a'.repeat(64),
        envelopeDigest: 'b'.repeat(64),
        toolManifestDigest: 'c'.repeat(64),
        // The digest a real compiler would have taken over these exact bytes,
        // so a fixture counter's evidence can bind to the same projection the
        // service compares it against.
        projection: {
          version: 3,
          kind: options.projectionKind ?? 'content_complete',
          digest: sha256Hex(counterProjection),
        },
        residual: options.residual ?? [{ key: 'max_tokens', valueClass: 'bounded_integer' }],
        envelope: { format: 'pi.session.prepared-input', version: 3 } as never,
      };
    },
  };
}

/**
 * A compiler that hands the REAL envelope verifier an envelope whose declared
 * projection digest does not describe its own counted bytes.
 *
 * It states the envelope literally and calls `verifyCompiledPreparedInput`
 * itself, so the refusal under test is the product verifier's, not a stub's
 * imitation of one — and no product seam had to be added to reach it.
 */
function tamperedProjectionDigestCompiler(): InputPreparationCompiler {
  const runtime = stubCompiler().runtime;
  const counterProjection = '{"model":"glm-4.6","messages":[],"tools":[]}';
  return {
    runtime,
    async compile(): Promise<CompiledPreparedInput> {
      return verifyCompiledPreparedInput(
        {
          format: runtime.envelopeFormat,
          version: 3,
          snapshot: {},
          context: {},
          providerRequest: {
            format: runtime.requestFormat,
            compilerVersion: runtime.compilerVersion,
            body: '{"model":"glm-4.6","messages":[],"max_tokens":4096}',
            counterProjection,
            // The digest of DIFFERENT bytes than the ones it travels with.
            projection: { version: 3, kind: 'content_complete', digest: sha256Hex(`${counterProjection} `) },
            residual: [{ key: 'max_tokens', valueClass: 'bounded_integer' }],
            digest: 'a'.repeat(64),
          },
          toolManifest: { order: [], executors: [], digest: 'c'.repeat(64) },
          digest: 'b'.repeat(64),
        } as never,
        runtime,
      );
    },
  };
}

interface StubCounter extends InputPreparationCounterAdapter {
  readonly calls: InputPreparationCounterRequestV1[];
}

function fixtureCounter(
  behaviour: (request: InputPreparationCounterRequestV1) => Promise<InputPreparationCounterResultV1> = async (
    counterRequest,
  ) => ({
    method: 'fixture.tokenizer',
    methodVersion: '0',
    authority: 'test_fixture',
    value: 123,
    coverage: { covered: true },
    providerEvidence: fixtureEvidence(counterRequest),
  }),
): StubCounter {
  const calls: InputPreparationCounterRequestV1[] = [];
  return {
    calls,
    async count(counterRequest: InputPreparationCounterRequestV1): Promise<InputPreparationCounterResultV1> {
      calls.push(counterRequest);
      return behaviour(counterRequest);
    },
  };
}

const ALWAYS_AUTHORIZED: InputPreparationAuthorityResolver = {
  async resolveSource({ source }) { return { authorized: true, source }; },
  async resolveScope(claim) {
    return { authorized: true, grant: { scopeId: `scope:${claim.deviceId}`, ...claim } };
  },
};

async function makeService(overrides: {
  storeDir?: string;
  limits?: InputPreparationLimitsPolicyV1;
  authorityResolver?: InputPreparationAuthorityResolver;
  /** `'none'` constructs the service with no counter at all — the optional counter's absent state. */
  counter?: InputPreparationCounterAdapter | 'none';
  compiler?: InputPreparationCompiler;
  toolSurface?: RecordingToolSurface;
  now?: () => number;
} = {}): Promise<InputPreparationService> {
  const counter = overrides.counter ?? fixtureCounter();
  const service = createInputPreparationService({
    storeDir: overrides.storeDir ?? (await tmpStoreDir()),
    limits: overrides.limits ?? LIMITS,
    authorityResolver: overrides.authorityResolver ?? ALWAYS_AUTHORIZED,
    ...(counter === 'none' ? {} : { counter }),
    compiler: overrides.compiler ?? stubCompiler(),
    toolSurface: overrides.toolSurface ?? recordingToolSurface(),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
  await service.open();
  cleanups.push(() => service.stop().catch(() => undefined));
  return service;
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof InputPreparationRequestError) return error.code;
    throw error;
  }
  throw new Error('expected the call to reject');
}

// ---------------------------------------------------------------------------

describe('B-P2 policy: required limits with no defaults', () => {
  it.each([
    ['an absent revision', { maxRequestBytes: 1 }],
    ['a zero byte bound', { revision: 'r', maxRequestBytes: 0, maxArtifactBytes: 1, maxScopeAggregateBytes: 1, maxInFlight: 1, maxCounterCallsPerScope: 1, counterTimeoutMs: 1, preparationDeadlineMs: 1, retentionMs: 1, retryHorizonMs: 1 }],
    ['a non-integer deadline', { revision: 'r', maxRequestBytes: 1, maxArtifactBytes: 1, maxScopeAggregateBytes: 1, maxInFlight: 1, maxCounterCallsPerScope: 1, counterTimeoutMs: 1, preparationDeadlineMs: 1.5, retentionMs: 1, retryHorizonMs: 1 }],
    ['a counter timeout above the whole preparation deadline', { revision: 'r', maxRequestBytes: 1, maxArtifactBytes: 1, maxScopeAggregateBytes: 1, maxInFlight: 1, maxCounterCallsPerScope: 1, counterTimeoutMs: 10, preparationDeadlineMs: 5, retentionMs: 100, retryHorizonMs: 1 }],
    ['a retention shorter than the preparation deadline', { revision: 'r', maxRequestBytes: 1, maxArtifactBytes: 1, maxScopeAggregateBytes: 1, maxInFlight: 1, maxCounterCallsPerScope: 1, counterTimeoutMs: 1, preparationDeadlineMs: 5, retentionMs: 4, retryHorizonMs: 1 }],
    ['a per-artifact allowance above the per-scope aggregate', { revision: 'r', maxRequestBytes: 1, maxArtifactBytes: 10, maxScopeAggregateBytes: 5, maxInFlight: 1, maxCounterCallsPerScope: 1, counterTimeoutMs: 1, preparationDeadlineMs: 1, retentionMs: 1, retryHorizonMs: 1 }],
    ['an unknown field', { revision: 'r', maxRequestBytes: 1, maxArtifactBytes: 1, maxScopeAggregateBytes: 1, maxInFlight: 1, maxCounterCallsPerScope: 1, counterTimeoutMs: 1, preparationDeadlineMs: 1, retentionMs: 1, retryHorizonMs: 1, extra: 1 }],
  ])('refuses enablement for %s', (_label, value) => {
    expect(() => validateInputPreparationLimits(value)).toThrow(InputPreparationPolicyError);
  });

  it('accepts a complete policy and freezes it', () => {
    expect(Object.isFrozen(LIMITS)).toBe(true);
    expect(LIMITS.revision).toBe('limits-rev-1');
  });
});

describe('B-P2 service: auth and isolation', () => {
  it('never compiles, stores or counts when the authority refuses', async () => {
    const compiler = stubCompiler();
    const counter = fixtureCounter();
    const service = await makeService({
      compiler,
      counter,
      authorityResolver: { ...ALWAYS_AUTHORIZED, async resolveScope() { return { authorized: false, reason: 'unknown_device' }; } },
    });
    expect(await codeOf(service.prepare(request()))).toBe('scope_denied');
    expect(compiler.calls).toEqual([]);
    expect(counter.calls).toEqual([]);
    expect(service.store.list()).toEqual([]);
  });

  it('treats an unavailable authority as a refusal, never as permission', async () => {
    const compiler = stubCompiler();
    const service = await makeService({
      compiler,
      authorityResolver: { ...ALWAYS_AUTHORIZED, async resolveScope() { throw new Error('authority store offline'); } },
    });
    expect(await codeOf(service.prepare(request()))).toBe('authority_unavailable');
    expect(compiler.calls).toEqual([]);
  });

  it('refuses a grant that answers about a different subject than the claim', async () => {
    const compiler = stubCompiler();
    const service = await makeService({
      compiler,
      authorityResolver: {
        ...ALWAYS_AUTHORIZED,
        async resolveScope(claim) {
          // A forged/misbehaving resolver substituting another device.
          return { authorized: true, grant: { scopeId: 'scope:other', ...claim, deviceId: 'device-other' } };
        },
      },
    });
    expect(await codeOf(service.prepare(request()))).toBe('scope_denied');
    expect(compiler.calls).toEqual([]);
  });

  it('refuses a request presenting a policy revision this daemon does not enforce', async () => {
    const compiler = stubCompiler();
    const service = await makeService({ compiler });
    expect(await codeOf(service.prepare(request({ policyRevision: 'limits-rev-2' })))).toBe('policy_revision_mismatch');
    expect(compiler.calls).toEqual([]);
  });

  it('keys the durable namespace by the trusted scope, so lookup and cancel cannot cross it', async () => {
    const storeDir = await tmpStoreDir();
    const service = await makeService({ storeDir });
    await service.prepare(request());

    const otherScope = { deviceId: 'device-2', agentRef: 'agent-1', profileId: 'profile-1', profileRevision: 'profile-rev-1' };
    expect(await codeOf(service.lookup({ requestId: 'prep-1', scope: otherScope }))).toBe('not_found');
    expect(await codeOf(service.cancel({ requestId: 'prep-1', scope: otherScope }))).toBe('not_found');
    // The original scope still sees its own record: the refusal above was
    // isolation, not deletion.
    expect((await service.lookup({ requestId: 'prep-1', scope: request().scope })).state).toBe('prepared');
  });
});

describe('B-P2 service: binding authority', () => {
  it('derives runtime, policy and scope binding from trusted facts, never from caller text', async () => {
    const compiler = stubCompiler();
    const service = await makeService({ compiler });
    const receipt = await service.prepare(request());

    expect(receipt.binding.runtime).toEqual(compiler.runtime);
    expect(receipt.binding.policyRevision).toBe(LIMITS.revision);
    expect(receipt.binding.scopeId).toBe('scope:device-1');
    expect(receipt.binding.target).toEqual({ endpoint: 'https://api.z.ai/api/coding/paas/v4', modelId: 'glm-4.6' });
    // The identity handed to the compiler is built here, not echoed from the request.
    expect(compiler.calls[0]?.binding.runtimeIdentity).toBe(
      '@byok-sdk/pi-coding-agent@0.85.1001+d981de1229ef899957bbe968bc8dcda02a21f477.1',
    );
    expect(compiler.calls[0]?.binding.policyIdentity).toBe(LIMITS.revision);
    expect(compiler.calls[0]?.binding.inputIdentity).toBe('src-rev-1:src-digest-1');
  });

  it('copies the caller input before any async work, so later mutation cannot rewrite the artifact', async () => {
    const compiler = stubCompiler();
    const service = await makeService({ compiler });
    const mutable = request();
    const pending = service.prepare(mutable);
    // Mutating the caller's own object while the preparation is in flight.
    (mutable.snapshot.messages[0] as { content: string }).content = 'REWRITTEN';
    (mutable as { requestId: string }).requestId = 'prep-other';
    const receipt = await pending;

    expect(receipt.requestId).toBe('prep-1');
    expect(compiler.calls[0]?.snapshot.messages[0]?.content).toBe('hello');
  });

  it('digests the request independently of wire field order', async () => {
    const ordered = canonicalInputPreparationJson({ b: 1, a: [2, { d: 3, c: 4 }] });
    const shuffled = canonicalInputPreparationJson({ a: [2, { c: 4, d: 3 }], b: 1 });
    expect(shuffled).toBe(ordered);
  });
});

describe('B-P2 service: readiness never reaches ready offline', () => {
  it('returns explicit not-ready reasons for a fixture counter and an unruled residual key', async () => {
    const service = await makeService();
    const receipt = await service.prepare(request());

    expect(receipt.state).toBe('prepared');
    expect(receipt.ready).toBe(false);
    // The projection IS content-complete — the stub compiles what a real one
    // compiles — so what keeps this receipt unready is the missing Host
    // accounting ruling and the fixture counter authority, not a blanket
    // coverage label that could never be cleared.
    expect(receipt.readinessReasons).not.toContain('projection_unknown');
    expect(receipt.readinessReasons).toContain('accounting_policy_missing');
    expect(receipt.readinessReasons).toContain('counter_authority_not_production');
    expect(receipt.counter).toMatchObject({ authority: 'test_fixture', value: 123 });
    expect(receipt.artifact?.projection).toEqual({
      version: 3,
      kind: 'content_complete',
      digest: sha256Hex(JSON.stringify({ model: 'glm-4.6' })),
    });
    expect(receipt.artifact?.residual).toEqual([{ key: 'max_tokens', valueClass: 'bounded_integer' }]);
    // A receipt discloses identities and sizes, never D, P(D) or the snapshot.
    expect(JSON.stringify(receipt)).not.toContain('hello');
    // Nothing here is, or reserves, an Execution.
    expect(receipt.pin).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain('taskId');
  });

  it('clears every projection and accounting reason when the policy rules the compiler\'s residual keys', async () => {
    const compiler = stubCompiler();
    const service = await makeService({ compiler });
    const receipt = await service.prepare(
      request({ accountingPolicyRef: accountingPolicyRef({ ruledRuntime: runtimeIdentityOf(compiler) }) }),
    );

    expect(receipt.readinessReasons).not.toContain('projection_unknown');
    expect(receipt.readinessReasons).not.toContain('residual_not_ruled');
    expect(receipt.readinessReasons).not.toContain('accounting_policy_missing');
    expect(receipt.readinessReasons).not.toContain('accounting_policy_inapplicable');
    expect(receipt.readinessReasons).not.toContain('request_content_not_text');
    // The fixture counter authority is what is left, which is the honest state
    // of an offline suite and is exactly what must never be clearable here.
    expect(receipt.readinessReasons).toContain('counter_authority_not_production');
  });

  it('carries runtime_contract_superseded for a record prepared under another compiler contract', async () => {
    // The ONE path that produces it. `binding.runtime.compilerVersion` is read
    // off the verified install at preparation time and frozen onto the record,
    // and readiness compares it against the single contract this build
    // prepares and consumes against. A record that disagrees is not re-read
    // through the current contract and is not translated: its projection was
    // classified by a table this build does not have.
    const compiler = stubCompiler({ compilerVersion: SUPPORTED_PREPARED_COMPILER_VERSION - 1 });
    const service = await makeService({ compiler });
    const receipt = await service.prepare(
      request({ accountingPolicyRef: accountingPolicyRef({ ruledRuntime: runtimeIdentityOf(compiler) }) }),
    );

    expect(receipt.readinessReasons).toContain('runtime_contract_superseded');
    expect(receipt.ready).toBe(false);
    // It is the CONTRACT that is superseded, not the evidence: nothing about
    // the artifact, the ruling or the count is re-judged because of it.
    expect(receipt.readinessReasons).not.toContain('projection_unknown');
    expect(receipt.readinessReasons).not.toContain('residual_not_ruled');
  });

  it('carries no runtime_contract_superseded for a record prepared under this build\'s contract', async () => {
    const compiler = stubCompiler();
    const service = await makeService({ compiler });
    const receipt = await service.prepare(
      request({ accountingPolicyRef: accountingPolicyRef({ ruledRuntime: runtimeIdentityOf(compiler) }) }),
    );

    expect(receipt.binding.runtime.compilerVersion).toBe(SUPPORTED_PREPARED_COMPILER_VERSION);
    expect(receipt.readinessReasons).not.toContain('runtime_contract_superseded');
  });

  it('carries projection_unknown when the native compiler claims nothing about P(D)', async () => {
    const compiler = stubCompiler({ projectionKind: 'unknown', residual: [] });
    const service = await makeService({ compiler });
    const receipt = await service.prepare(
      request({ accountingPolicyRef: accountingPolicyRef({ ruledRuntime: runtimeIdentityOf(compiler) }) }),
    );

    expect(receipt.artifact?.projection.kind).toBe('unknown');
    expect(receipt.readinessReasons).toContain('projection_unknown');
  });

  it('carries residual_not_ruled for a classified key the Host ruling does not name', async () => {
    const compiler = stubCompiler();
    const service = await makeService({ compiler });
    const receipt = await service.prepare(
      request({
        accountingPolicyRef: accountingPolicyRef({
          ruledRuntime: runtimeIdentityOf(compiler),
          ruledResidualKeys: ['temperature'],
        }),
      }),
    );

    expect(receipt.readinessReasons).toContain('residual_not_ruled');
    expect(receipt.readinessReasons).not.toContain('accounting_policy_inapplicable');
  });

  it.each([
    ['a runtime the ruling was not made for', () => accountingPolicyRef({ ruledRuntime: 'some-other-runtime@1+abc.1' })],
    [
      'a target the ruling was not made for',
      () => accountingPolicyRef({ ruledTarget: { endpoint: 'https://elsewhere.example', modelId: 'glm-4.6' } }),
    ],
  ])('carries accounting_policy_inapplicable for %s', async (_label, build) => {
    const compiler = stubCompiler();
    const service = await makeService({ compiler });
    const receipt = await service.prepare(request({ accountingPolicyRef: build() }));

    expect(receipt.readinessReasons).toContain('accounting_policy_inapplicable');
    // Applicability is decided before the key subset: a ruling about another
    // runtime says nothing about these keys, so claiming they are unruled
    // would be a second, invented verdict.
    expect(receipt.readinessReasons).not.toContain('residual_not_ruled');
  });

  it('refuses counter evidence that names a projection this preparation did not compile', async () => {
    const service = await makeService({
      counter: fixtureCounter(async (counterRequest) => ({
        method: 'fixture.tokenizer',
        methodVersion: '0',
        authority: 'provider',
        value: 11,
        coverage: { covered: true },
        providerEvidence: { ...fixtureEvidence(counterRequest), projectionDigest: 'f'.repeat(64) },
      })),
    });

    expect(await codeOf(service.prepare(request()))).toBe('counter_unavailable');
    const receipt = await service.lookup({ requestId: 'prep-1', scope: request().scope });
    expect(receipt.counter).toBeUndefined();
    expect(receipt.ready).toBe(false);
    expect(receipt.readinessReasons).toContain('counter_interrupted');
  });

  it('hands the counter only P(D), the target and an explicit call policy', async () => {
    const counter = fixtureCounter();
    const service = await makeService({ counter });
    await service.prepare(request());

    expect(counter.calls).toHaveLength(1);
    const call = counter.calls[0]!;
    expect(Object.keys(call).sort()).toEqual(['counterProjection', 'signal', 'target', 'timeoutMs']);
    expect(call.counterProjection).toBe(JSON.stringify({ model: 'glm-4.6' }));
    expect(call.timeoutMs).toBe(LIMITS.counterTimeoutMs);
  });

  it('refuses a counter result outside the accepted shape rather than inventing one', async () => {
    const service = await makeService({
      counter: fixtureCounter(async (counterRequest) => ({
        method: '',
        methodVersion: '',
        authority: 'provider',
        value: -1,
        coverage: { covered: true },
        providerEvidence: fixtureEvidence(counterRequest),
      })),
    });
    // The call WAS placed, so the record is an unknown outcome; the wire code
    // says which half failed. Neither invents a number.
    expect(await codeOf(service.prepare(request()))).toBe('counter_unavailable');
    const receipt = await service.lookup({ requestId: 'prep-1', scope: request().scope });
    expect(receipt.state).toBe('counter_interrupted');
    expect(receipt.counter).toBeUndefined();
  });
});

describe('bounded admission: the counter is optional and byte evidence is the bound', () => {
  /** Everything a ready receipt needs except the counter: a ruled policy and attested executors. */
  async function readyCapable(counter: InputPreparationCounterAdapter | 'none', limits: InputPreparationLimitsPolicyV1 = LIMITS, compiler = stubCompiler()) {
    const service = await makeService({
      compiler,
      counter,
      limits,
      toolSurface: recordingToolSurface({ attested: true }),
    });
    const prepare = (requestId: string) => service.prepare(request({
      requestId,
      accountingPolicyRef: accountingPolicyRef({ ruledRuntime: runtimeIdentityOf(compiler) }),
    }));
    return { service, prepare };
  }

  it('reaches ready with no counter, and consumes zero counter-call reservations', async () => {
    // An allowance of ONE counter call: two preparations can both settle only
    // if neither reserved against it.
    const limits = validateInputPreparationLimits({ ...LIMITS, maxCounterCallsPerScope: 1 });
    const { service, prepare } = await readyCapable('none', limits);

    const first = await prepare('prep-a');
    const second = await prepare('prep-b');

    for (const receipt of [first, second]) {
      expect(receipt.state).toBe('prepared');
      expect(receipt.readinessReasons).toEqual([]);
      expect(receipt.ready).toBe(true);
      expect(receipt.counter).toBeUndefined();
      // The bound evidence is the compiler's exact byte length of D, and it is
      // the only size field the receipt carries.
      expect(receipt.artifact?.requestBytes).toBeGreaterThan(0);
    }
    expect(service.store.list().map((record) => record.counterCalls)).toEqual([0, 0]);
    expect(service.store.scopeUsage(first.binding.scopeId).counterCalls).toBe(0);
    // Never entered `counting`: a restart has nothing to reconcile into
    // `counter_interrupted`.
    expect(service.store.list().every((record) => record.state === 'prepared')).toBe(true);
  });

  it('never reaches ready with a present fixture counter, even when everything else holds', async () => {
    const counter = fixtureCounter();
    const { prepare } = await readyCapable(counter);
    const receipt = await prepare('prep-fixture');

    expect(counter.calls).toHaveLength(1);
    expect(receipt.state).toBe('prepared');
    expect(receipt.ready).toBe(false);
    expect(receipt.readinessReasons).toEqual(['counter_authority_not_production']);
  });

  it('keeps judging a present counter: an uncovered provider count stays unready', async () => {
    const { prepare } = await readyCapable(fixtureCounter(async (counterRequest) => ({
      method: 'provider.tokenizer',
      methodVersion: '1',
      authority: 'provider',
      value: 99,
      coverage: { covered: false, reason: 'tools not covered' },
      providerEvidence: fixtureEvidence(counterRequest),
    })));
    const receipt = await prepare('prep-uncovered');

    expect(receipt.ready).toBe(false);
    expect(receipt.readinessReasons).toEqual(['counter_coverage_incomplete']);
  });

  it('is unchanged with a present provider counter apart from the state name', async () => {
    const counter = fixtureCounter(async (counterRequest) => ({
      method: 'provider.tokenizer',
      methodVersion: '1',
      authority: 'provider',
      value: 99,
      coverage: { covered: true },
      providerEvidence: fixtureEvidence(counterRequest),
    }));
    const { service, prepare } = await readyCapable(counter);
    const receipt = await prepare('prep-provider');

    expect(counter.calls).toHaveLength(1);
    expect(receipt.state).toBe('prepared');
    expect(receipt.ready).toBe(true);
    expect(receipt.counter).toMatchObject({ authority: 'provider', value: 99 });
    expect(receipt.counter).not.toHaveProperty('kind');
    expect(service.store.list()[0]?.counterCalls).toBe(1);
  });

  it('is not ready when D carries a non-text content part', async () => {
    const compiler = stubCompiler({
      body: () => JSON.stringify({
        model: 'glm-4.6',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:,' } }] },
        ],
      }),
    });
    const { prepare } = await readyCapable('none', LIMITS, compiler);
    const receipt = await prepare('prep-image');

    expect(receipt.state).toBe('prepared');
    expect(receipt.ready).toBe(false);
    expect(receipt.readinessReasons).toEqual(['request_content_not_text']);
  });

  it('reads text-only D as text-only, whether its content is a string or text parts', async () => {
    const compiler = stubCompiler({
      body: () => JSON.stringify({
        model: 'glm-4.6',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: [{ type: 'text', text: 'said before' }] },
        ],
      }),
    });
    const { prepare } = await readyCapable('none', LIMITS, compiler);
    expect((await prepare('prep-text')).readinessReasons).toEqual([]);
  });

  it.each([
    ['a body that is not JSON', 'not json'],
    ['a body that is not an object', '[]'],
    ['a body with no messages at all', '{}'],
    ['messages that are not an array', '{"messages":{}}'],
    ['a content part that is not an object', '{"messages":[{"role":"user","content":["text"]}]}'],
    ['a content part with no type', '{"messages":[{"role":"user","content":[{"text":"x"}]}]}'],
    ['an input_audio part', '{"messages":[{"role":"user","content":[{"type":"input_audio"}]}]}'],
  ])('classifies %s as not text-only (fail closed)', (_label, body) => {
    expect(preparedRequestContentIsTextOnly(body)).toBe(false);
  });
});

describe('B-P2 service: idempotency and uncertainty', () => {
  it('reserves and calls the counter exactly once for concurrent duplicates', async () => {
    const compiler = stubCompiler();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const counter = fixtureCounter(async (counterRequest) => {
      await gate;
      return {
        method: 'fixture.tokenizer',
        methodVersion: '0',
        authority: 'test_fixture',
        value: 7,
        coverage: { covered: true },
        providerEvidence: fixtureEvidence(counterRequest),
      };
    });
    const service = await makeService({ compiler, counter });

    const first = service.prepare(request());
    const second = service.prepare(request());
    const third = service.prepare(request());
    release?.();
    const receipts = await Promise.all([first, second, third]);

    expect(counter.calls).toHaveLength(1);
    expect(compiler.calls).toHaveLength(1);
    expect(new Set(receipts.map((receipt) => receipt.reference)).size).toBe(1);
    expect(service.store.list()).toHaveLength(1);
    expect(service.store.list()[0]?.counterCalls).toBe(1);
  });

  it('rereads the existing receipt when the caller lost the response, without a second counter call', async () => {
    const counter = fixtureCounter();
    const service = await makeService({ counter });
    const first = await service.prepare(request());
    const retried = await service.prepare(request());
    const looked = await service.lookup({ requestId: 'prep-1', scope: request().scope });

    expect(counter.calls).toHaveLength(1);
    expect(retried.reference).toBe(first.reference);
    expect(looked.reference).toBe(first.reference);
    expect(looked.counter).toEqual(first.counter);
  });

  it('conflicts when the same requestId carries a different request', async () => {
    const counter = fixtureCounter();
    const service = await makeService({ counter });
    await service.prepare(request());
    expect(await codeOf(service.prepare(request({ source: { revision: 'src-rev-2', digest: 'src-digest-2' } })))).toBe(
      'request_conflict',
    );
    expect(counter.calls).toHaveLength(1);
    // Neither side was overwritten.
    expect((await service.lookup({ requestId: 'prep-1', scope: request().scope })).binding.source.revision).toBe('src-rev-1');
  });

  it('records an interrupted counter as observable and never repeats it automatically', async () => {
    const counter = fixtureCounter(async () => {
      throw new Error('socket hang up');
    });
    const service = await makeService({ counter });

    expect(await codeOf(service.prepare(request()))).toBe('counter_interrupted');
    expect(counter.calls).toHaveLength(1);

    const receipt = await service.lookup({ requestId: 'prep-1', scope: request().scope });
    expect(receipt.state).toBe('counter_interrupted');
    expect(receipt.detail).toBe('counter_outcome_unknown');
    expect(receipt.ready).toBe(false);

    // The same request again returns the same durable fact — no second call.
    const again = await service.prepare(request());
    expect(again.state).toBe('counter_interrupted');
    expect(counter.calls).toHaveLength(1);
  });

  it('charges an interrupted call against the scope allowance', async () => {
    const counter = fixtureCounter(async () => {
      throw new Error('socket hang up');
    });
    const service = await makeService({ counter });
    await codeOf(service.prepare(request()));
    expect(service.store.scopeUsage('scope:device-1').counterCalls).toBe(1);
  });
});

describe('B-P2 service: cancellation and deadlines', () => {
  it('cancels a preparation mid-counter as an interrupted outcome, not a clean cancellation', async () => {
    let seen: InputPreparationCounterRequestV1 | undefined;
    const counter = fixtureCounter(
      (counterRequest) =>
        new Promise<InputPreparationCounterResultV1>((_resolve, reject) => {
          seen = counterRequest;
          counterRequest.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const service = await makeService({ counter });

    const pending = service.prepare(request());
    // Wait until the counter has actually been entered.
    while (seen === undefined) await new Promise((resolve) => setImmediate(resolve));

    const cancelled = await service.cancel({ requestId: 'prep-1', scope: request().scope });
    expect(cancelled.state).toBe('counter_interrupted');
    expect(cancelled.detail).toBe('cancelled_during_counter');
    expect(await codeOf(pending)).toBe('counter_interrupted');
    expect(counter.calls).toHaveLength(1);

    // Cancelling again is a no-op and does not rewrite the unknown outcome.
    const again = await service.cancel({ requestId: 'prep-1', scope: request().scope });
    expect(again.state).toBe('counter_interrupted');
  });

  it('bounds one counter call by the explicit per-call timeout, whose clock starts at the call', async () => {
    // The whole-preparation deadline is left generous on purpose: only the
    // per-call bound may fire here, and its clock must start when the call
    // starts — not when `prepare` did, or the compile and the durable writes
    // would eat the budget this policy field is about.
    const limits = validateInputPreparationLimits({
      ...LIMITS,
      revision: 'limits-rev-fast',
      counterTimeoutMs: 20,
      preparationDeadlineMs: 9_000,
    });
    const counter = fixtureCounter(
      (counterRequest) =>
        new Promise<InputPreparationCounterResultV1>((_resolve, reject) => {
          counterRequest.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const service = await makeService({ limits, counter });
    expect(await codeOf(service.prepare(request({ policyRevision: 'limits-rev-fast' })))).toBe('counter_interrupted');
    const receipt = await service.lookup({ requestId: 'prep-1', scope: request().scope });
    expect(receipt.state).toBe('counter_interrupted');
    expect(receipt.detail).toBe('counter_deadline_elapsed');
    expect(counter.calls).toHaveLength(1);
  });

  it('cancels cleanly, without spending the record on an unknown outcome, when the abort lands before the call', async () => {
    const counter = fixtureCounter();
    const service = await makeService({
      counter,
      // A compiler that yields long enough for the cancel below to land while
      // the pure stage is still running.
      compiler: {
        ...stubCompiler(),
        async compile(compileRequest) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return stubCompiler().compile(compileRequest);
        },
      },
    });

    const pending = service.prepare(request());
    // Wait for the durable reservation, so the cancel lands inside the pure
    // stage rather than before the record exists at all.
    while (service.store.list().length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const cancelled = await service.cancel({ requestId: 'prep-1', scope: request().scope });
    const code = await codeOf(pending);

    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.detail).toBe('cancelled_before_counter');
    expect(code).toBe('cancelled');
    // The call was never placed, so it is not charged as an unknown outcome.
    expect(counter.calls).toEqual([]);
    expect(service.store.list()[0]?.counterCalls).toBe(0);
  });
});

describe('B-P2 service: compile refusal', () => {
  it('maps a compiler refusal to unsupported_input, records it, and never calls the counter', async () => {
    const counter = fixtureCounter();
    const service = await makeService({ compiler: stubCompiler({ fail: true }), counter });
    expect(await codeOf(service.prepare(request()))).toBe('unsupported_input');
    expect(counter.calls).toEqual([]);
    const receipt = await service.lookup({ requestId: 'prep-1', scope: request().scope });
    expect(receipt.state).toBe('failed');
    expect(receipt.detail).toBe('compile_rejected');
    expect(receipt.artifact).toBeUndefined();
  });

  it('pairs the wire code and the recorded detail on a tampered projection digest', async () => {
    // The pairing, end to end, rather than the two halves separately: the REAL
    // envelope verifier refuses a projection digest that does not describe the
    // bytes it travels with, the caller is told `unsupported_input`, and the
    // durable record keeps the specific `projection_digest_mismatch` a later
    // `lookup` can answer with. A generic `compile_rejected` here would lose
    // exactly which contract broke.
    const counter = fixtureCounter();
    const service = await makeService({ compiler: tamperedProjectionDigestCompiler(), counter });

    expect(await codeOf(service.prepare(request()))).toBe('unsupported_input');

    const receipt = await service.lookup({ requestId: 'prep-1', scope: request().scope });
    expect(receipt.state).toBe('failed');
    expect(receipt.detail).toBe('projection_digest_mismatch');
    expect(receipt.artifact).toBeUndefined();
    expect(counter.calls).toEqual([]);
  });
});

describe('B-P2 service: byte, call and in-flight policy', () => {
  it('refuses a request over the configured request byte policy before touching authority', async () => {
    const limits = validateInputPreparationLimits({ ...LIMITS, revision: 'limits-rev-tiny', maxRequestBytes: 64 });
    const compiler = stubCompiler();
    const service = await makeService({ limits, compiler });
    expect(await codeOf(service.prepare(request({ policyRevision: 'limits-rev-tiny' })))).toBe('limit_exceeded');
    expect(compiler.calls).toEqual([]);
  });

  it('refuses an artifact over the per-artifact byte policy after compiling, without counting it', async () => {
    const limits = validateInputPreparationLimits({ ...LIMITS, revision: 'limits-rev-small', maxArtifactBytes: 200, maxScopeAggregateBytes: 200 });
    const counter = fixtureCounter();
    const service = await makeService({
      limits,
      counter,
      compiler: stubCompiler({ body: () => 'x'.repeat(5_000) }),
    });
    expect(await codeOf(service.prepare(request({ policyRevision: 'limits-rev-small' })))).toBe('limit_exceeded');
    expect(counter.calls).toEqual([]);
    expect((await service.lookup({ requestId: 'prep-1', scope: request().scope })).detail).toBe('artifact_bytes_exceeded');
  });

  it('enforces the per-scope counter-call allowance, and the consumed calls survive restart', async () => {
    const storeDir = await tmpStoreDir();
    const limits = validateInputPreparationLimits({ ...LIMITS, revision: 'limits-rev-one-call', maxCounterCallsPerScope: 1 });
    const counter = fixtureCounter();
    const first = await makeService({ storeDir, limits, counter });
    await first.prepare(request({ policyRevision: 'limits-rev-one-call' }));
    expect(counter.calls).toHaveLength(1);

    // A brand-new service over the SAME store: the allowance is a durable fact,
    // not an in-memory counter a restart resets.
    const restarted = await makeService({ storeDir, limits, counter });
    expect(await codeOf(restarted.prepare(request({ requestId: 'prep-2', policyRevision: 'limits-rev-one-call' })))).toBe(
      'limit_exceeded',
    );
    expect(counter.calls).toHaveLength(1);
  });

  it('enforces the per-scope aggregate byte allowance across requests', async () => {
    const limits = validateInputPreparationLimits({ ...LIMITS, revision: 'limits-rev-agg', maxArtifactBytes: 3_000, maxScopeAggregateBytes: 3_000 });
    const counter = fixtureCounter();
    const service = await makeService({ limits, counter, compiler: stubCompiler({ body: () => 'x'.repeat(1_500) }) });
    await service.prepare(request({ policyRevision: 'limits-rev-agg' }));
    expect(await codeOf(service.prepare(request({ requestId: 'prep-2', policyRevision: 'limits-rev-agg' })))).toBe('limit_exceeded');
    expect((await service.lookup({ requestId: 'prep-2', scope: request().scope })).detail).toBe('scope_aggregate_bytes_exceeded');
    expect(counter.calls).toHaveLength(1);
  });

  it('refuses to start a preparation beyond the in-flight allowance', async () => {
    const limits = validateInputPreparationLimits({ ...LIMITS, revision: 'limits-rev-single', maxInFlight: 1 });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const counter = fixtureCounter(async (counterRequest) => {
      await gate;
      return {
        method: 'fixture.tokenizer',
        methodVersion: '0',
        authority: 'test_fixture',
        value: 1,
        coverage: { covered: true },
        providerEvidence: fixtureEvidence(counterRequest),
      };
    });
    const service = await makeService({ limits, counter });

    const held = service.prepare(request({ policyRevision: 'limits-rev-single' }));
    while (counter.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    expect(await codeOf(service.prepare(request({ requestId: 'prep-2', policyRevision: 'limits-rev-single' })))).toBe(
      'limit_exceeded',
    );
    release?.();
    await held;
  });
});

/**
 * A compiler whose envelope is padded until the `prompt_prepared` frame the
 * launcher would write measures EXACTLY `targetFrameBytes`.
 *
 * The padding is derived through the product builder itself, never from a
 * hardcoded overhead: the frame under test is the frame the service builds,
 * and `RPC_MAX_FRAME_BYTES` is read off the runtime rather than restated here,
 * so a fork that moves the cap moves this test with it.
 */
function frameSizedCompiler(targetFrameBytes: number): InputPreparationCompiler {
  const base = stubCompiler();
  return {
    runtime: base.runtime,
    async compile(compileRequest: CompilePreparedInputRequest): Promise<CompiledPreparedInput> {
      const compiled = await base.compile(compileRequest);
      const expected = {
        envelopeDigest: compiled.envelopeDigest,
        toolManifestDigest: compiled.toolManifestDigest,
        model: compileRequest.model,
        binding: compileRequest.binding,
      };
      const skeleton = { format: 'pi.session.prepared-input', version: 3, pad: '' };
      const overhead = rpcFrameByteLength(
        buildPreparedPromptCommand(skeleton, expected, PREPARED_PROMPT_COMMAND_ID),
      );
      const envelope = { ...skeleton, pad: 'x'.repeat(targetFrameBytes - overhead) };
      return { ...compiled, envelope: envelope as never };
    },
  };
}

describe('B-P2 service: the runtime frame bound is decided before the operator byte policy', () => {
  it('admits an envelope whose prepared frame measures exactly the runtime cap', async () => {
    // Everything the OPERATOR bounds is opened wide on purpose: what is under
    // test is the RUNTIME's bound, and a retention refusal here would answer a
    // different question.
    const limits = validateInputPreparationLimits({
      ...LIMITS,
      revision: 'limits-rev-roomy',
      maxArtifactBytes: 32 * 1024 * 1024,
      maxScopeAggregateBytes: 32 * 1024 * 1024,
    });
    const counter = fixtureCounter();
    const service = await makeService({
      limits,
      counter,
      compiler: frameSizedCompiler(RPC_MAX_FRAME_BYTES),
    });

    const receipt = await service.prepare(request({ policyRevision: 'limits-rev-roomy' }));
    expect(receipt.state).toBe('prepared');
    expect(counter.calls).toHaveLength(1);
  });

  it('refuses one byte over the cap as rpc_frame_too_large, naming the measured length', async () => {
    const limits = validateInputPreparationLimits({
      ...LIMITS,
      revision: 'limits-rev-roomy',
      maxArtifactBytes: 32 * 1024 * 1024,
      maxScopeAggregateBytes: 32 * 1024 * 1024,
    });
    const counter = fixtureCounter();
    const service = await makeService({
      limits,
      counter,
      compiler: frameSizedCompiler(RPC_MAX_FRAME_BYTES + 1),
    });

    let error: InputPreparationRequestError | undefined;
    try {
      await service.prepare(request({ policyRevision: 'limits-rev-roomy' }));
    } catch (thrown) {
      if (!(thrown instanceof InputPreparationRequestError)) throw thrown;
      error = thrown;
    }
    expect(error?.code).toBe('rpc_frame_too_large');
    expect(error?.message).toContain(String(RPC_MAX_FRAME_BYTES + 1));
    expect(error?.message).toContain(String(RPC_MAX_FRAME_BYTES));

    // Nothing was counted, and the refusal is the durable fact a later lookup
    // answers with rather than a generic failure.
    expect(counter.calls).toEqual([]);
    expect((await service.lookup({ requestId: 'prep-1', scope: request().scope })).detail).toBe(
      'rpc_frame_too_large',
    );
  });

  it('decides the runtime bound BEFORE the per-artifact retention bound', async () => {
    // Both bounds are violated by this preparation. The runtime's is the one
    // that must answer: an artifact that can never be delivered is not an
    // artifact the operator's retention policy has an opinion about yet.
    const limits = validateInputPreparationLimits({
      ...LIMITS,
      revision: 'limits-rev-small',
      maxArtifactBytes: 200,
      maxScopeAggregateBytes: 200,
    });
    const counter = fixtureCounter();
    const service = await makeService({
      limits,
      counter,
      compiler: frameSizedCompiler(RPC_MAX_FRAME_BYTES + 1),
    });

    expect(await codeOf(service.prepare(request({ policyRevision: 'limits-rev-small' })))).toBe(
      'rpc_frame_too_large',
    );
    expect((await service.lookup({ requestId: 'prep-1', scope: request().scope })).detail).not.toBe(
      'artifact_bytes_exceeded',
    );
    expect(counter.calls).toEqual([]);
  });
});

describe('B-P2 service: bounds hold under concurrent distinct requests', () => {
  /**
   * Two different requestIds are two different records, two different keys and
   * two different caller-side locks: nothing in this service serializes them.
   * A bound that is read and then acted on is therefore a bound both of them
   * pass, which is why each of these three is decided inside the store's
   * serialized tail, in the same closure as its write.
   */
  async function raced(
    service: InputPreparationService,
    policyRevision: string,
  ): Promise<{ counted: number; refusals: InputPreparationRequestError[] }> {
    const outcomes = await Promise.allSettled([
      service.prepare(request({ requestId: 'prep-a', policyRevision })),
      service.prepare(request({ requestId: 'prep-b', policyRevision })),
    ]);
    const counted = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled' && outcome.value.state === 'prepared',
    ).length;
    const refusals = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      .map((outcome) => outcome.reason as InputPreparationRequestError);
    for (const refusal of refusals) expect(refusal).toBeInstanceOf(InputPreparationRequestError);
    return { counted, refusals };
  }

  it('admits exactly one concurrent request under an in-flight bound of one', async () => {
    const limits = validateInputPreparationLimits({ ...LIMITS, revision: 'limits-rev-race-inflight', maxInFlight: 1 });
    const counter = fixtureCounter();
    const service = await makeService({ limits, counter });

    const { counted, refusals } = await raced(service, limits.revision);
    expect(counted).toBe(1);
    expect(refusals.map((refusal) => refusal.code)).toEqual(['limit_exceeded']);
    expect(counter.calls).toHaveLength(1);
  });

  it('places exactly one counter call under a per-scope allowance of one', async () => {
    const limits = validateInputPreparationLimits({
      ...LIMITS,
      revision: 'limits-rev-race-calls',
      maxCounterCallsPerScope: 1,
    });
    const counter = fixtureCounter();
    const service = await makeService({ limits, counter });

    const { counted, refusals } = await raced(service, limits.revision);
    expect(counted).toBe(1);
    expect(refusals.map((refusal) => refusal.code)).toEqual(['limit_exceeded']);
    expect(counter.calls).toHaveLength(1);
    expect(service.store.scopeUsage('scope:device-1').counterCalls).toBe(1);
    expect(service.store.list().filter((record) => record.state === 'failed').map((record) => record.detail)).toEqual([
      'counter_call_limit_exceeded',
    ]);
  });

  it('retains exactly one artifact when the second concurrent request would exceed the scope aggregate', async () => {
    const limits = validateInputPreparationLimits({
      ...LIMITS,
      revision: 'limits-rev-race-bytes',
      maxArtifactBytes: 3_000,
      maxScopeAggregateBytes: 3_000,
    });
    const counter = fixtureCounter();
    const service = await makeService({ limits, counter, compiler: stubCompiler({ body: () => 'x'.repeat(1_500) }) });

    const { counted, refusals } = await raced(service, limits.revision);
    expect(counted).toBe(1);
    expect(refusals.map((refusal) => refusal.code)).toEqual(['limit_exceeded']);
    expect(counter.calls).toHaveLength(1);
    expect(service.store.scopeUsage('scope:device-1').artifactBytes).toBeLessThanOrEqual(3_000);
    expect(service.store.list().filter((record) => record.state === 'failed').map((record) => record.detail)).toEqual([
      'scope_aggregate_bytes_exceeded',
    ]);
  });
});

describe('B-P2 service: durable-write ambiguity is never masked', () => {
  it('answers durable_write_failed when the failure marking cannot be written, and stays latched', async () => {
    const storeDir = await tmpStoreDir();
    const logPath = path.join(storeDir, 'input-preparation', 'records.jsonl');
    const counter = fixtureCounter();
    const service = await makeService({
      storeDir,
      counter,
      compiler: {
        ...stubCompiler(),
        async compile(): Promise<CompiledPreparedInput> {
          // A real I/O fault, landing between the reservation and the refusal:
          // the compile refusal below has to be RECORDED, and the log cannot
          // take the write.
          await fs.chmod(logPath, 0o400);
          throw new InputPreparationCompileError('stub refuses this input');
        },
      },
    });

    // The refusal the caller is told about is the DANGEROUS one: the record log
    // is quarantined, which governs what may be retried — not `unsupported_input`.
    expect(await codeOf(service.prepare(request()))).toBe('durable_write_failed');

    await fs.chmod(logPath, 0o600);
    // The latch outlives the fault, exactly as it does for any other durable write.
    expect(await codeOf(service.prepare(request({ requestId: 'prep-2' })))).toBe('durable_write_failed');
    expect(counter.calls).toEqual([]);
  });
});

describe('B-P2 service: restart reconciliation', () => {
  it('turns a crashed counting record into an observable interruption, never a resumed call', async () => {
    const storeDir = await tmpStoreDir();
    let stall: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      stall = resolve;
    });
    const counter = fixtureCounter(async (counterRequest) => {
      await gate;
      return {
        method: 'fixture.tokenizer',
        methodVersion: '0',
        authority: 'test_fixture',
        value: 1,
        coverage: { covered: true },
        providerEvidence: fixtureEvidence(counterRequest),
      };
    });
    const first = await makeService({ storeDir, counter });
    const held = first.prepare(request());
    while (counter.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));

    // A "crash": a second service opens the same store while the first record
    // is still `counting` on disk.
    const restartCounter = fixtureCounter();
    const restarted = await makeService({ storeDir, counter: restartCounter });
    const receipt = await restarted.lookup({ requestId: 'prep-1', scope: request().scope });
    expect(receipt.state).toBe('counter_interrupted');
    expect(receipt.detail).toBe('counter_outcome_unknown_after_restart');
    expect(receipt.counter).toBeUndefined();

    // Re-presenting the same request after restart returns the persisted fact.
    const again = await restarted.prepare(request());
    expect(again.state).toBe('counter_interrupted');
    expect(restartCounter.calls).toEqual([]);

    stall?.();
    await held.catch(() => undefined);
    await first.stop();
  });
});


describe('PR187 review regressions', () => {
  it.each(['pair', 'snapshot', 'malformed', 'throw'])('validates independent source authority: %s', async (mode) => {
    const compiler = stubCompiler();
    const counter = fixtureCounter();
    const service = await makeService({ compiler, counter, authorityResolver: {
      ...ALWAYS_AUTHORIZED,
      async resolveSource({ grant, source, snapshot }) {
        expect(grant.scopeId).toBe('scope:device-1');
        expect(snapshot).toEqual(request().snapshot);
        if (mode === 'throw') throw new Error('Host offline');
        if (mode === 'malformed') return { authorized: 'yes' } as never;
        if (mode === 'snapshot') return { authorized: false, reason: 'disclosure_denied' };
        return { authorized: true, source: { ...source, digest: 'other' } };
      },
    } });
    expect(await codeOf(service.prepare(request()))).toBe(['throw', 'malformed'].includes(mode) ? 'authority_unavailable' : 'scope_denied');
    expect(compiler.calls).toEqual([]);
    expect(counter.calls).toEqual([]);
    expect(service.store.list()).toEqual([]);
  });

  it('isolates the request and verified grant from resolver mutation', async () => {
    const compiler = stubCompiler();
    let sourceCalls = 0;
    const service = await makeService({ compiler, authorityResolver: {
      ...ALWAYS_AUTHORIZED,
      async resolveSource(input) {
        sourceCalls += 1;
        const original = structuredClone(input.source);
        const mutable = input as unknown as { grant: { scopeId: string }; source: { digest: string }; snapshot: { messages: { content: string }[] } };
        mutable.grant.scopeId = 'evil';
        mutable.source.digest = 'evil';
        mutable.snapshot.messages[0]!.content = 'evil';
        await Promise.resolve();
        return { authorized: true, source: original };
      },
    } });
    const receipt = await service.prepare(request());
    expect(sourceCalls).toBe(1);
    expect(receipt.binding.source).toEqual(request().source);
    expect(receipt.binding.scopeId).toBe('scope:device-1');
    // The compile input is the daemon-derived projection: `selectedTools` and
    // the tool list are this device's observation, not the caller's. Isolation
    // is about what the CALLER stated — every caller-stated field reaches the
    // compiler verbatim, and the resolver's mutations reach nothing at all.
    expect(compiler.calls[0]?.snapshot.prompt).toMatchObject(request().snapshot.prompt);
    expect(compiler.calls[0]?.snapshot.messages).toEqual(request().snapshot.messages);
    expect(JSON.stringify(compiler.calls[0])).not.toContain('evil');
  });

  it.each(['timeout', 'cancel', 'stop'])('settles %s even when counter ignores abort, ignores late resolution/rejection', async (mode) => {
    for (const late of ['resolve', 'reject']) {
      let resolve!: (value: InputPreparationCounterResultV1) => void;
      let reject!: (error: Error) => void;
      let lateRequest!: InputPreparationCounterRequestV1;
      const counter = fixtureCounter((counterRequest) => {
        lateRequest = counterRequest;
        return new Promise((yes, no) => { resolve = yes; reject = no; });
      });
      const limits = { ...LIMITS, counterTimeoutMs: mode === 'timeout' ? 20 : 5_000 };
      const service = await makeService({ counter, limits });
      const pending = codeOf(service.prepare(request()));
      while (counter.calls.length === 0) await new Promise((done) => setImmediate(done));
      const removeListener = vi.spyOn(counter.calls[0]!.signal, 'removeEventListener');
      const action = mode === 'cancel' ? service.cancel({ requestId: 'prep-1', scope: request().scope }) : mode === 'stop' ? service.stop() : Promise.resolve();
      try {
        expect(await Promise.race([Promise.all([pending, action]).then(([code]) => code), new Promise((done) => setTimeout(() => done('hung'), 500))])).toBe('counter_interrupted');
      } finally {
        if (late === 'reject') reject(new Error('late counter rejection'));
        else resolve({ method: 'fixture', methodVersion: '0', authority: 'test_fixture', value: 2, coverage: { covered: true }, providerEvidence: fixtureEvidence(lateRequest) });
        await pending;
        await action;
      }
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(service.store.list()[0]?.state).toBe('counter_interrupted');
      expect(service.store.list()[0]?.counterCalls).toBe(1);
      if (mode !== 'stop') expect((await service.prepare(request())).state).toBe('counter_interrupted');
      expect(counter.calls).toHaveLength(1);
    }
  });

  it('maps typed runtime failure and keeps the reserved request spent', async () => {
    const counter = fixtureCounter();
    let calls = 0;
    const service = await makeService({ counter, compiler: { ...stubCompiler(), async compile() {
      calls += 1;
      throw new InputPreparationRuntimeIdentityError('installed closure changed');
    } } });
    expect(await codeOf(service.prepare(request()))).toBe('runtime_identity_unavailable');
    const receipt = await service.prepare(request());
    expect(receipt.state).toBe('failed');
    expect(receipt.detail).toBe('runtime_identity_unavailable');
    expect(calls).toBe(1);
    expect(counter.calls).toEqual([]);
  });

  it('collects idle artifacts, then tombstones without another prepare', async () => {
    let clock = 1_000_000;
    const limits = { ...LIMITS, counterTimeoutMs: 100, preparationDeadlineMs: 200, retentionMs: 400, retryHorizonMs: 100 };
    const storeDir = await tmpStoreDir();
    const service = await makeService({ storeDir, limits, now: () => clock });
    await service.prepare(request());
    clock += 401;
    // The GC timer is a real timer whose delay comes from the fake clock, so a
    // fixed wall-clock sleep races CI load; poll for the drained state.
    await vi.waitFor(async () => {
      expect(await fs.readdir(path.join(storeDir, 'input-preparation', 'artifacts'))).toEqual([]);
    }, { timeout: 5_000 });
    expect(service.store.list()).toHaveLength(1);
    clock += 100;
    await vi.waitFor(() => {
      expect(service.store.list()).toEqual([]);
    }, { timeout: 5_000 });
  });

  it('collects artifacts on restart after both horizons without another prepare', async () => {
    let clock = 1_000_000;
    const storeDir = await tmpStoreDir();
    const first = await makeService({ storeDir, now: () => clock });
    await first.prepare(request());
    await first.stop();
    clock += LIMITS.retentionMs + LIMITS.retryHorizonMs + 1;
    const restarted = await makeService({ storeDir, now: () => clock });
    expect(restarted.store.list()).toEqual([]);
    expect(await fs.readdir(path.join(storeDir, 'input-preparation', 'artifacts'))).toEqual([]);
  });

  it('latches background GC faults for subsequent access and stop', async () => {
    const limits = { ...LIMITS, counterTimeoutMs: 100, preparationDeadlineMs: 200, retentionMs: 400, retryHorizonMs: 100 };
    const service = await makeService({ limits });
    await service.prepare(request());
    const fault = new Error('GC filesystem offline');
    const gc = vi.spyOn(service.store, 'gc').mockRejectedValue(fault);
    await vi.waitFor(() => {
      expect(gc).toHaveBeenCalled();
    }, { timeout: 5_000 });
    await expect(service.lookup({ requestId: 'prep-1', scope: request().scope })).rejects.toBe(fault);
    await expect(service.stop()).rejects.toBe(fault);
    gc.mockRestore();
  });
});


describe('PR187 retention lifecycle races', () => {
  it('protects an active compile from GC after both horizons', async () => {
    let clock = 1_000_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const compiler = stubCompiler();
    const limits = { ...LIMITS, retryHorizonMs: 20 };
    const service = await makeService({ limits, now: () => clock, compiler: {
      ...compiler, async compile(input) { await gate; return compiler.compile(input); },
    } });
    const pending = service.prepare(request());
    while (service.store.list().length === 0) await new Promise((done) => setImmediate(done));
    clock += limits.retentionMs + limits.retryHorizonMs + 1;
    try {
      await new Promise((done) => setTimeout(done, 60));
      expect(service.store.list()[0]?.state).toBe('reserved');
    } finally { release(); }
    expect((await pending).state).toBe('prepared');
  });

  it('waits for in-flight GC on stop and leaves no timer running', async () => {
    const service = await makeService({ limits: { ...LIMITS, counterTimeoutMs: 100, preparationDeadlineMs: 200, retentionMs: 400, retryHorizonMs: 100 } });
    await service.prepare(request());
    let release!: () => void;
    const gate = new Promise<{ artifactsRemoved: number; recordsRemoved: number }>((resolve) => {
      release = () => resolve({ artifactsRemoved: 0, recordsRemoved: 0 });
    });
    const gc = vi.spyOn(service.store, 'gc').mockReturnValue(gate);
    while (gc.mock.calls.length === 0) await new Promise((done) => setTimeout(done, 5));
    let stopped = false;
    const stop = service.stop().then(() => { stopped = true; });
    await new Promise((done) => setImmediate(done));
    expect(stopped).toBe(false);
    release();
    await stop;
    await new Promise((done) => setTimeout(done, 50));
    expect(gc).toHaveBeenCalledTimes(1);
    gc.mockRestore();
  });
});


describe('PR187 shutdown admission race', () => {
  it('does not place a counter call when stop races a pending durable reservation', async () => {
    const counter = fixtureCounter();
    const service = await makeService({ counter });
    const originalReserve = service.store.reserve.bind(service.store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reserve = vi.spyOn(service.store, 'reserve').mockImplementation(async (input) => {
      await gate;
      return originalReserve(input);
    });
    const pending = codeOf(service.prepare(request()));
    while (reserve.mock.calls.length === 0) await new Promise((done) => setImmediate(done));
    const stopped = service.stop();
    await new Promise((done) => setImmediate(done));
    release();
    await stopped;
    expect(await pending).toBe('cancelled');
    expect(service.store.list()[0]?.state).toBe('cancelled');
    expect(counter.calls).toEqual([]);
  });
});
