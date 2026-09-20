import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputPreparationModelSchema } from '@byok-sdk/protocol';
import { parseInputPreparationRequestParams } from '../daemon/control-protocol';
import { parsePreparedExpectedModel } from '../bin/pi-prepared-host';
import { InputPreparationStore, type ReserveInput } from '../daemon/input-preparation-store';
import {
  INPUT_PREPARATION_REQUEST_FORMAT,
  INPUT_PREPARATION_VERSION,
  type InputPreparationBindingV1,
  type InputPreparationModelV1,
} from '../input-preparation';
// Relative, and test-only: the release graph
// (`scripts/release/check-package-graph.mjs`) keeps `@byok-sdk/keys` and the
// dispatch packages disjoint as SHIPPED dependencies, which is exactly why the
// wire restates the two model declarations instead of importing them. A test is
// the one place both authorities can be looked at together, and it is the only
// thing that stops the restatement from drifting.
import { buildPiProviderProjection, piProjectionProviderId } from '../../../keys/src/pi-provider-projection';
import { ModelProviderProfileSchema } from '../../../keys/src/provider-profile';
import { PiModelConfigSchema } from '../../../keys/src/pi-model-config';

/**
 * The model that travels the prepared lane is read by FOUR independent
 * carriers, and no one of them is the authority over the others:
 *
 *   1. `@byok-sdk/protocol`'s `InputPreparationModelSchema` — the wire.
 *   2. `daemon/control-protocol.ts`'s hand parse — what the daemon admits.
 *   3. `bin/pi-prepared-host.ts`'s hand parse — what the prepared launch
 *      re-presents to the native verifier as an INDEPENDENT expectation.
 *   4. `daemon/input-preparation-store.ts` — what survives a process boundary.
 *
 * They are deliberately separate readers (a value read through a shared helper
 * would be one reader agreeing with itself), so the property that matters is
 * that they never DISAGREE: a declaration one admits and another silently drops
 * is a prepared model that no longer equals the session model, which the native
 * session reports as `prepared_model_drift` at consume — after the count was
 * already taken.
 *
 * So one fixture table runs through all four, and a fifth test proves the
 * admitted shape is exactly the shape `@byok-sdk/keys` actually projects into
 * the `models.json` the runtime is launched with.
 */

const THINKING_LEVEL_MAP = {
  off: null,
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
} as const;

const COMPAT = {
  supportsDeveloperRole: false,
  maxTokensField: 'max_tokens',
  thinkingFormat: 'zai',
  zaiToolStream: true,
} as const;

const BASE_MODEL = {
  id: 'glm-4.6',
  name: 'GLM 4.6',
  api: 'openai-completions',
  provider: 'zai',
  baseUrl: 'https://api.z.ai/api/coding/paas/v4',
  reasoning: true,
  input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
} as const;

function model(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...BASE_MODEL, ...overrides };
}

const { max: _droppedMax, ...MISSING_MAX_LEVEL } = THINKING_LEVEL_MAP;

/** Every fixture, with the verdict all four carriers must reach for it. */
const FIXTURES: readonly (readonly [string, Record<string, unknown>, 'accept' | 'refuse'])[] = [
  ['both declarations present', model({ thinkingLevelMap: THINKING_LEVEL_MAP, compat: COMPAT }), 'accept'],
  ['neither declaration present', model(), 'accept'],
  ['only the thinking level map', model({ thinkingLevelMap: THINKING_LEVEL_MAP }), 'accept'],
  ['only compat', model({ compat: COMPAT }), 'accept'],
  ['an empty compat declaration', model({ compat: {} }), 'accept'],
  ['a level mapped to null', model({ thinkingLevelMap: { ...THINKING_LEVEL_MAP, high: null } }), 'accept'],
  ['an unknown compat key', model({ compat: { ...COMPAT, supportsStrictMode: true } }), 'refuse'],
  ['a compat flag that is not a boolean', model({ compat: { ...COMPAT, zaiToolStream: 'yes' } }), 'refuse'],
  ['an unsupported maxTokensField', model({ compat: { ...COMPAT, maxTokensField: 'max_output_tokens' } }), 'refuse'],
  ['an unsupported thinkingFormat', model({ compat: { ...COMPAT, thinkingFormat: 'anthropic' } }), 'refuse'],
  ['a compat that is not an object', model({ compat: [] }), 'refuse'],
  ['a thinking level outside the seven', model({ thinkingLevelMap: { ...THINKING_LEVEL_MAP, ultra: 'high' } }), 'refuse'],
  ['a thinking level map missing one of the seven', model({ thinkingLevelMap: MISSING_MAX_LEVEL }), 'refuse'],
  ['a level value that is neither string nor null', model({ thinkingLevelMap: { ...THINKING_LEVEL_MAP, high: 3 } }), 'refuse'],
  ['an empty effort string', model({ thinkingLevelMap: { ...THINKING_LEVEL_MAP, high: '' } }), 'refuse'],
  ['an over-long effort string', model({ thinkingLevelMap: { ...THINKING_LEVEL_MAP, high: 'a'.repeat(65) } }), 'refuse'],
  ['an effort string outside the portable character set', model({ thinkingLevelMap: { ...THINKING_LEVEL_MAP, high: 'very high' } }), 'refuse'],
  ['a thinking level map that is not an object', model({ thinkingLevelMap: 'high' }), 'refuse'],
];

// ---------------------------------------------------------------------------
// One carrier per reader. Each answers the model it admitted, or undefined.
// ---------------------------------------------------------------------------

function throughWireSchema(candidate: unknown): unknown {
  const parsed = InputPreparationModelSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function requestParams(candidate: unknown): unknown {
  return {
    format: INPUT_PREPARATION_REQUEST_FORMAT,
    version: INPUT_PREPARATION_VERSION,
    requestId: 'prep-1',
    policyRevision: 'limits-rev-1',
    scope: { deviceId: 'device-1', agentRef: 'agent-1', profileId: 'profile-1', profileRevision: 'profile-rev-1' },
    source: { revision: 'src-rev-1', digest: 'src-digest-1' },
    selection: { model: candidate, options: { cacheRetention: 'none', maxTokens: 4_096 } },
    snapshot: {
      prompt: {
        cwd: '/workspace/project',
        toolSnippets: {},
        promptGuidelines: [],
        contextFiles: [],
        formattedSkills: '',
        docsPaths: { readmePath: 'README.md', docsPath: 'docs', examplesPath: 'examples' },
      },
      messages: [{ role: 'user', content: 'summarise the repository', timestamp: 1_700_000_000_000 }],
    },
    permissionMode: 'auto',
    requiredToolsets: ['team'],
  };
}

function throughControlProtocol(candidate: unknown): unknown {
  const parsed = parseInputPreparationRequestParams(requestParams(candidate));
  return parsed.ok ? parsed.request.selection.model : undefined;
}

/**
 * The prepared host reports a bad configuration by writing one line and
 * exiting, which is the right behaviour for a launch process and the wrong one
 * inside a test runner. Both are intercepted so the refusal is observable as a
 * value rather than as a dead worker.
 */
function throughPreparedHost(candidate: unknown): unknown {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`prepared host refused with exit ${String(code)}`);
  }) as never);
  try {
    return parsePreparedExpectedModel(candidate);
  } catch {
    return undefined;
  } finally {
    exit.mockRestore();
    stderr.mockRestore();
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const BINDING: InputPreparationBindingV1 = {
  scopeId: 'scope-a',
  deviceId: 'device-1',
  agentRef: 'agent-1',
  profileId: 'profile-1',
  profileRevision: 'profile-rev-1',
  source: { revision: 'src-rev-1', digest: 'src-digest-1' },
  target: { endpoint: 'https://api.z.ai/api/coding/paas/v4', modelId: 'glm-4.6' },
  policyRevision: 'policy-1',
  permissionMode: 'auto',
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
  requestDigest: 'digest-1',
};

/**
 * A real durable write and a real replay from a second store instance — the
 * property under test is what survives a process boundary, so nothing here is
 * held in memory across the boundary.
 */
async function throughStore(admitted: InputPreparationModelV1): Promise<InputPreparationModelV1 | undefined> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-prep-model-parity-'));
  cleanups.push(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const options = { storeDir: dir, retentionMs: 3_600_000, retryHorizonMs: 3_600_000 };
  const writer = new InputPreparationStore(options);
  await writer.open();
  const input: ReserveInput = {
    key: { scopeId: 'scope-a', agentRef: 'agent-1', requestId: 'req-1' },
    requestDigest: 'digest-1',
    binding: BINDING,
    model: admitted,
    maxInFlight: 8,
  };
  const outcome = await writer.reserve(input);
  const reader = new InputPreparationStore(options);
  await reader.open();
  return reader.get(outcome.record.recordId)?.model;
}

describe('input preparation model: every carrier admits the same closed shape', () => {
  it.each(FIXTURES.map(([label, candidate, verdict]) => [label, candidate, verdict] as const))(
    '%s: the wire schema and both hand parsers agree (%#)',
    (_label, candidate, verdict) => {
      const wire = throughWireSchema(candidate);
      const control = throughControlProtocol(candidate);
      const host = throughPreparedHost(candidate);

      if (verdict === 'refuse') {
        expect({ wire, control, host }).toEqual({ wire: undefined, control: undefined, host: undefined });
        return;
      }

      // Admitted by all three, and admitted VERBATIM: a carrier that accepted
      // the model but dropped a declaration on the way out is the failure this
      // whole file exists to catch.
      expect(wire).toEqual(candidate);
      expect(control).toEqual(candidate);
      expect(host).toEqual(candidate);
      // Absent stays absent — not defaulted, and not materialised as an
      // explicit `undefined` key either.
      for (const key of ['thinkingLevelMap', 'compat'] as const) {
        const declared = Object.hasOwn(candidate, key);
        expect(Object.hasOwn(wire as object, key)).toBe(declared);
        expect(Object.hasOwn(control as object, key)).toBe(declared);
        expect(Object.hasOwn(host as object, key)).toBe(declared);
      }
    },
  );

  it.each(FIXTURES.filter(([, , verdict]) => verdict === 'accept').map(([label, candidate]) => [label, candidate] as const))(
    '%s: survives a durable write and a replay from a second store, byte-stably',
    async (_label, candidate) => {
      const admitted = throughControlProtocol(candidate) as InputPreparationModelV1;
      const replayed = await throughStore(admitted);
      expect(replayed).toEqual(candidate);
      // Byte-stable, not merely deep-equal: the record log is append-only JSON,
      // and a re-serialisation that moved or re-typed a key would change every
      // later digest taken over it.
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(admitted));
    },
  );
});

describe('input preparation model: the wire carries what the launcher projects', () => {
  /** A real BYOK profile: a z.ai coding endpoint launched as its own namespaced provider. */
  const PROFILE = ModelProviderProfileSchema.parse({
    adapter: 'openai_compatible',
    auth_mode: 'bearer',
    base_url: 'https://api.z.ai/api/coding/paas/v4',
    capabilities: [],
    created_at: '2026-09-21T00:00:00.000Z',
    display_name: 'GLM 4.6 (coding)',
    enabled: true,
    kind: 'model',
    model: 'glm-4.6',
    pi_model: {
      contextWindow: 200_000,
      maxTokens: 98_304,
      reasoning: true,
      thinkingLevel: 'high',
      thinkingLevelMap: THINKING_LEVEL_MAP,
      compat: COMPAT,
    },
    profile_ref: 'zai-coding',
    provider_kind: 'zai',
    updated_at: '2026-09-21T00:00:00.000Z',
  });

  interface ProjectedProvider {
    readonly baseUrl: string;
    readonly api: string;
    readonly models: readonly Record<string, unknown>[];
  }

  function projected(): { providerId: string; provider: ProjectedProvider; entry: Record<string, unknown> } {
    const projection = buildPiProviderProjection(PROFILE) as { providers: Record<string, ProjectedProvider> };
    const providerId = piProjectionProviderId(PROFILE.profile_ref);
    const provider = projection.providers[providerId]!;
    return { providerId, provider, entry: provider.models[0]! };
  }

  it('maps the projected models.json entry onto the wire model field for field', () => {
    const { providerId, provider, entry } = projected();
    expect(providerId).toBe('byok-sdk-zai-coding');

    const wireModel = {
      id: entry['id'],
      name: entry['name'],
      // Provider block, not model entry: the launched runtime reads `api` and
      // `baseUrl` off the provider when the entry states neither.
      api: provider.api,
      provider: providerId,
      baseUrl: provider.baseUrl,
      reasoning: entry['reasoning'],
      input: entry['input'],
      // `cost` is NOT in the projection. The fork's composer defaults an entry
      // without one to all zeroes — see
      // `node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js:71`
      // (`cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`),
      // reached from `packages/client/node_modules/`. Stated here rather than
      // defaulted by this SDK: the composer owns the value, and a second
      // default would be this package quietly deciding a price.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: entry['contextWindow'],
      maxTokens: entry['maxTokens'],
      thinkingLevelMap: entry['thinkingLevelMap'],
      compat: entry['compat'],
    };

    const parsed = InputPreparationModelSchema.safeParse(wireModel);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(wireModel);

    // Field for field against the projection, not just "it parsed".
    expect(wireModel.id).toBe('glm-4.6');
    expect(wireModel.name).toBe('GLM 4.6 (coding)');
    expect(wireModel.api).toBe('openai-completions');
    expect(wireModel.provider).toBe('byok-sdk-zai-coding');
    expect(wireModel.baseUrl).toBe('https://api.z.ai/api/coding/paas/v4');
    expect(wireModel.reasoning).toBe(true);
    expect(wireModel.input).toEqual(['text']);
    expect(wireModel.contextWindow).toBe(200_000);
    expect(wireModel.maxTokens).toBe(98_304);
    expect(wireModel.thinkingLevelMap).toEqual(THINKING_LEVEL_MAP);
    expect(wireModel.compat).toEqual(COMPAT);

    // And both hand parsers admit exactly the same object, unchanged.
    expect(throughControlProtocol(wireModel)).toEqual(wireModel);
    expect(throughPreparedHost(wireModel)).toEqual(wireModel);
  });

  it('carries every model-entry key the projection emits that is not the launch thinking level', () => {
    const { entry } = projected();
    // `thinkingLevel` is stripped by the projection itself (it travels as the
    // launcher's `--thinking` argument, not as a model field), so the entry's
    // own keys are exactly what the wire has to be able to express.
    const wireCarries = new Set([
      'id', 'name', 'api', 'provider', 'baseUrl', 'reasoning', 'input',
      'cost', 'contextWindow', 'maxTokens', 'thinkingLevelMap', 'compat',
    ]);
    expect(Object.keys(entry).filter((key) => !wireCarries.has(key))).toEqual([]);
  });

  it('admits exactly the key set and value sets the device-local Pi model authority declares', () => {
    // The wire RESTATES these shapes because the release graph forbids the
    // dependency. This is the check that keeps the restatement honest: the two
    // definitions are compared directly, in the one place both are importable.
    const local = PiModelConfigSchema.shape;
    const localLevelMap = local.thinkingLevelMap;
    const localCompat = local.compat;
    const wireLevelMap = InputPreparationModelSchema.shape.thinkingLevelMap.unwrap();
    const wireCompat = InputPreparationModelSchema.shape.compat.unwrap();

    expect(Object.keys(wireLevelMap.shape)).toEqual(Object.keys(localLevelMap.shape));
    expect(Object.keys(wireCompat.shape)).toEqual(Object.keys(localCompat.shape));

    // The two closed value sets, compared rather than restated a third time.
    expect(wireCompat.shape.maxTokensField.unwrap().options)
      .toEqual(localCompat.shape.maxTokensField.unwrap().options);
    expect(wireCompat.shape.thinkingFormat.unwrap().options)
      .toEqual(localCompat.shape.thinkingFormat.unwrap().options);

    // Key sets alone would not catch a looser effort BOUND, so the same values
    // go through both definitions and the verdicts are compared.
    const efforts: readonly unknown[] = [
      null, 'high', 'a'.repeat(64), 'a'.repeat(65), '', 'very high', 'ünicode', 3, undefined, {},
    ];
    for (const effort of efforts) {
      const candidate = { ...THINKING_LEVEL_MAP, high: effort };
      expect(
        [effort, wireLevelMap.safeParse(candidate).success],
      ).toEqual([effort, localLevelMap.safeParse(candidate).success]);
    }
  });
});
