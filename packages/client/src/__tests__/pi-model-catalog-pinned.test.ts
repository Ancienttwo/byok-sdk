import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { CompatSchemasByApi } from '@earendil-works/pi-ai/providers/compat-schema';
import { MODEL_THINKING_LEVELS } from '@earendil-works/pi-ai/providers/model-schema';
import clientManifest from '../../package.json' with { type: 'json' };
// Relative and test-only: the release graph keeps `@byok-sdk/keys` and the
// dispatch packages disjoint, and keys has no pi-ai dependency. This is the
// one place both the pinned pi-ai and the keys table are importable.
import { PI_MODEL_CATALOG_FILE, renderPiModelCatalog } from '../../../../scripts/keys/generate-pi-model-catalog';
import { PI_MODEL_CATALOG, PI_MODEL_CATALOG_PI_AI_VERSION } from '../../../keys/src/pi-model-catalog.generated';
import { piModelConfigFromPinnedCatalog } from '../../../keys/src/pi-model-catalog';
import {
  PI_COMPAT_KEYS_BY_API, PI_MODEL_APIS, PI_THINKING_LEVELS, piSupportedThinkingLevels, type PiModelApi,
} from '../../../keys/src/pi-model-config';
import { buildPiProviderProjection } from '../../../keys/src/pi-provider-projection';
import { MODEL_PROVIDER_VENDORS, type ModelProviderVendorId } from '../../../keys/src/provider-catalog';
import { parseModelProviderProfile } from '../../../keys/src/provider-profile';

type PiModel = Record<string, unknown> & { id: string; api: string };

/** Every pinned chat model of a keys vendor, under an api a profile projects. */
function pinnedModels(): { provider: ModelProviderVendorId; model: PiModel }[] {
  return (Object.keys(MODEL_PROVIDER_VENDORS) as ModelProviderVendorId[]).flatMap((provider) =>
    (getBuiltinModels(provider as never) as unknown as PiModel[])
      .filter((model) => (PI_MODEL_APIS as readonly string[]).includes(model.api))
      .map((model) => ({ provider, model })));
}

describe('keys Pi model catalog against the pinned pi-ai', () => {
  it('is generated from the pi-ai the client pins, with no drift', async () => {
    expect(PI_MODEL_CATALOG_PI_AI_VERSION).toBe(clientManifest.byok.piRuntimePin);
    expect(PI_MODEL_CATALOG_PI_AI_VERSION).toBe(clientManifest.dependencies['@earendil-works/pi-ai']);
    // A Windows checkout may convert the file to CRLF; only the content is compared.
    expect(readFileSync(PI_MODEL_CATALOG_FILE, 'utf8').replaceAll('\r\n', '\n')).toBe(await renderPiModelCatalog());
  });

  it("admits each compat key only under a Pi api whose compat schema declares it", () => {
    for (const api of PI_MODEL_APIS) {
      const declared = CompatSchemasByApi[api].properties as Record<string, { type?: string }>;
      expect([api, PI_COMPAT_KEYS_BY_API[api].filter((key) => !Object.hasOwn(declared, key))]).toEqual([api, []]);
    }
    // The two keys added for the OpenRouter, Vercel AI Gateway and Baseten entries.
    for (const api of ['openai-completions', 'anthropic-messages'] as const) {
      expect(CompatSchemasByApi[api].properties.sendSessionAffinityHeaders.type).toBe('boolean');
    }
    expect(CompatSchemasByApi['anthropic-messages'].properties.allowEmptySignature.type).toBe('boolean');
    expect(Object.hasOwn(CompatSchemasByApi['openai-responses'].properties, 'sendSessionAffinityHeaders')).toBe(false);
    expect(Object.hasOwn(CompatSchemasByApi['openai-completions'].properties, 'allowEmptySignature')).toBe(false);
  });

  it("mirrors Pi's thinking levels", () => {
    expect(PI_THINKING_LEVELS).toEqual(MODEL_THINKING_LEVELS);
  });

  it('has exactly one entry per pinned model', () => {
    const pinned = pinnedModels().map(({ provider, model }) => `${provider}/${model.api}/${model.id}`).sort();
    const table = Object.entries(PI_MODEL_CATALOG).flatMap(([provider, byApi]) =>
      Object.entries(byApi).flatMap(([api, models]) => Object.keys(models!).map((id) => `${provider}/${api}/${id}`))).sort();
    expect(table).toEqual(pinned);
  });

  it('projects every representable entry to the pinned Pi model, field by field', () => {
    let representable = 0;
    for (const { provider, model } of pinnedModels()) {
      const vendor = MODEL_PROVIDER_VENDORS[provider];
      const levels = PI_THINKING_LEVELS.map((thinkingLevel) => piModelConfigFromPinnedCatalog({
        provider, api: model.api as PiModelApi, model: model.id, thinkingLevel,
      }));
      const accepted = levels.find((result) => result.ok);
      if (accepted === undefined) {
        const refusal = levels[0]!;
        if (refusal.ok || refusal.reason !== 'unrepresentable') throw new Error(`${provider}/${model.id}: ${JSON.stringify(refusal)}`);
        // Each refused path starts at the vendor api or at a field the pinned model declares.
        for (const field of refusal.fields) {
          const head = field.split('.')[0]!;
          const named = head === 'api' || Object.hasOwn(model, head);
          expect([provider, model.id, field, named]).toEqual([provider, model.id, field, true]);
        }
        continue;
      }
      representable += 1;
      const profile = parseModelProviderProfile({
        adapter: vendor.adapter, auth_mode: vendor.auth_mode, base_url: vendor.base_url,
        capabilities: accepted.input.includes('image') ? ['image-input'] : [],
        created_at: '2026-10-21T00:00:00.000Z', updated_at: '2026-10-21T00:00:00.000Z',
        display_name: String(model.name), enabled: true, kind: 'model', model: model.id,
        profile_ref: 'catalog-parity', provider_kind: provider, pi_model: accepted.config,
      });
      const projected = (buildPiProviderProjection(profile, 'pi-rpc') as any).providers['byok-sdk-catalog-parity'];
      const entry = projected.models[0];
      expect([provider, model.id, projected.api]).toEqual([provider, model.id, model.api]);
      const fields = ['id', 'name', 'input', 'reasoning', 'contextWindow', 'maxTokens', 'thinkingLevelMap', 'compat', 'inputLimits'];
      const pick = (source: Record<string, unknown>) => Object.fromEntries(fields.map((field) => [field, source[field] ?? null]));
      // The projected name is the profile display_name, which the profile schema trims
      // (pi-ai 1.4.0 openrouter google/gemma-4-26b-a4b carries a trailing space).
      expect({ provider, ...pick(entry) }).toEqual({ provider, ...pick({ compat: {}, ...model, name: String(model.name).trim() }) });
    }
    // Cerebras, Z.AI GLM, MiniMax and the other entries; a pi-ai upgrade that empties this set is a regression.
    expect(representable).toBeGreaterThan(0);
  });

  it('accepts exactly the thinking levels Pi offers for each representable entry', () => {
    let compared = 0;
    for (const { provider, model } of pinnedModels()) {
      const accepted = PI_THINKING_LEVELS.filter((thinkingLevel) => piModelConfigFromPinnedCatalog({
        provider, api: model.api as PiModelApi, model: model.id, thinkingLevel,
      }).ok);
      if (accepted.length === 0) continue;
      compared += 1;
      expect([provider, model.id, accepted]).toEqual([provider, model.id, getSupportedThinkingLevels(model as never)]);
    }
    expect(compared).toBeGreaterThan(0);
  });

  it("restates Pi's supported-level rule for every map shape the schema admits", () => {
    const everyLevel = Object.fromEntries(PI_THINKING_LEVELS.map((level) => [level, level]));
    const maps = [
      undefined,
      everyLevel,
      Object.fromEntries(PI_THINKING_LEVELS.map((level) => [level, null])),
      { ...everyLevel, off: null, xhigh: null, max: 'max' },
    ];
    for (const reasoning of [true, false]) {
      for (const thinkingLevelMap of maps) {
        const config = { reasoning, ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }) };
        expect([config, piSupportedThinkingLevels(config as never)])
          .toEqual([config, getSupportedThinkingLevels(config as never)]);
      }
    }
  });
});
