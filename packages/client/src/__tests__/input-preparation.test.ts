import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  verifyCompiledPreparedInput,
  type CompilePreparedInputRequest,
  type CompiledPreparedInput,
  type InputPreparationCompiler,
} from '../adapters/pi/input-preparation';

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
        promptGuidelines: [],
        contextFiles: [],
        formattedSkills: '',
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
      compilerVersion: 2,
    },
    async compile(compileRequest: CompilePreparedInputRequest): Promise<CompiledPreparedInput> {
      // Deep-copy at capture time so a later mutation of the service's own
      // object cannot rewrite what this test observed.
      calls.push(structuredClone(compileRequest) as CompilePreparedInputRequest);
      if (options.fail === true) throw new InputPreparationCompileError('stub refuses this input');
      const body = options.body?.() ?? JSON.stringify({ model: compileRequest.model.id, snapshot: compileRequest.snapshot });
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
          version: 2,
          kind: options.projectionKind ?? 'content_complete',
          digest: sha256Hex(counterProjection),
        },
        residual: options.residual ?? [{ key: 'max_tokens', valueClass: 'bounded_integer' }],
        envelope: { format: 'pi.session.prepared-input', version: 2 } as never,
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
          version: 2,
          snapshot: {},
          context: {},
          providerRequest: {
            format: runtime.requestFormat,
            compilerVersion: runtime.compilerVersion,
            body: '{"model":"glm-4.6","messages":[],"max_tokens":4096}',
            counterProjection,
            // The digest of DIFFERENT bytes than the ones it travels with.
            projection: { version: 2, kind: 'content_complete', digest: sha256Hex(`${counterProjection} `) },
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
    kind: 'count',
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
  async resolveScope(claim) {
    return { authorized: true, grant: { scopeId: `scope:${claim.deviceId}`, ...claim } };
  },
};

async function makeService(overrides: {
  storeDir?: string;
  limits?: InputPreparationLimitsPolicyV1;
  authorityResolver?: InputPreparationAuthorityResolver;
  counter?: InputPreparationCounterAdapter;
  compiler?: InputPreparationCompiler;
  toolSurface?: RecordingToolSurface;
  now?: () => number;
} = {}): Promise<InputPreparationService> {
  const service = createInputPreparationService({
    storeDir: overrides.storeDir ?? (await tmpStoreDir()),
    limits: overrides.limits ?? LIMITS,
    authorityResolver: overrides.authorityResolver ?? ALWAYS_AUTHORIZED,
    counter: overrides.counter ?? fixtureCounter(),
    compiler: overrides.compiler ?? stubCompiler(),
    toolSurface: overrides.toolSurface ?? recordingToolSurface(),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
  await service.open();
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
      authorityResolver: { async resolveScope() { return { authorized: false, reason: 'unknown_device' }; } },
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
      authorityResolver: { async resolveScope() { throw new Error('authority store offline'); } },
    });
    expect(await codeOf(service.prepare(request()))).toBe('authority_unavailable');
    expect(compiler.calls).toEqual([]);
  });

  it('refuses a grant that answers about a different subject than the claim', async () => {
    const compiler = stubCompiler();
    const service = await makeService({
      compiler,
      authorityResolver: {
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
    expect((await service.lookup({ requestId: 'prep-1', scope: request().scope })).state).toBe('counted');
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

    expect(receipt.state).toBe('counted');
    expect(receipt.ready).toBe(false);
    // The projection IS content-complete — the stub compiles what a real one
    // compiles — so what keeps this receipt unready is the missing Host
    // accounting ruling and the fixture counter authority, not a blanket
    // coverage label that could never be cleared.
    expect(receipt.readinessReasons).not.toContain('projection_unknown');
    expect(receipt.readinessReasons).toContain('accounting_policy_missing');
    expect(receipt.readinessReasons).toContain('counter_authority_not_production');
    expect(receipt.counter).toMatchObject({ authority: 'test_fixture', kind: 'count', value: 123 });
    expect(receipt.artifact?.projection).toEqual({
      version: 2,
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
    expect(receipt.readinessReasons).not.toContain('counter_missing');
    // The fixture counter authority is what is left, which is the honest state
    // of an offline suite and is exactly what must never be clearable here.
    expect(receipt.readinessReasons).toContain('counter_authority_not_production');
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
        kind: 'count',
        value: 11,
        coverage: { covered: true },
        providerEvidence: { ...fixtureEvidence(counterRequest), projectionDigest: 'f'.repeat(64) },
      })),
    });

    expect(await codeOf(service.prepare(request()))).toBe('counter_unavailable');
    const receipt = await service.lookup({ requestId: 'prep-1', scope: request().scope });
    expect(receipt.counter).toBeUndefined();
    expect(receipt.readinessReasons).toContain('counter_missing');
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
        kind: 'count',
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
        kind: 'count',
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
        kind: 'count',
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
      (outcome) => outcome.status === 'fulfilled' && outcome.value.state === 'counted',
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
        kind: 'count',
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
