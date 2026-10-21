import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { MODEL_THINKING_LEVELS } from '@earendil-works/pi-ai/providers/model-schema';
import clientManifest from '../../package.json' with { type: 'json' };
// Relative and test-only: the release graph keeps `@byok-sdk/keys` and the
// dispatch packages disjoint, and keys has no pi-ai dependency. This is the
// one place both the pinned pi-ai and the keys table are importable.
import { PI_MODEL_CATALOG_FILE, renderPiModelCatalog } from '../../../../scripts/keys/generate-pi-model-catalog';
import { PI_MODEL_CATALOG, PI_MODEL_CATALOG_PI_AI_VERSION } from '../../../keys/src/pi-model-catalog.generated';
import { piModelConfigFromPinnedCatalog } from '../../../keys/src/pi-model-catalog';
import { PI_MODEL_APIS, PI_THINKING_LEVELS, type PiModelApi } from '../../../keys/src/pi-model-config';
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
    expect(readFileSync(PI_MODEL_CATALOG_FILE, 'utf8')).toBe(await renderPiModelCatalog());
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
        // Each refused path starts at the vendor api, the required map, or a field the pinned model declares.
        for (const field of refusal.fields) {
          const head = field.split('.')[0]!;
          const named = head === 'api' || head === 'thinkingLevelMap' || Object.hasOwn(model, head);
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
      expect({ provider, ...pick(entry) }).toEqual({ provider, ...pick({ compat: {}, ...model }) });
    }
    // Cerebras, Z.AI GLM-5.x and the other full-map entries; a pi-ai upgrade that empties this set is a regression.
    expect(representable).toBeGreaterThan(0);
  });
});
