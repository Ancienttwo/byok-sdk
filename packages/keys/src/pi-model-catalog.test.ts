import { describe, expect, it } from 'vitest';
import { classifyPiCatalogModel, piModelConfigFromPinnedCatalog } from './pi-model-catalog';
import { assertPiPreparedProviderProfile } from './pi-provider-launcher-core';
import { buildPiProviderProjection } from './pi-provider-projection';
import { parseModelProviderProfile } from './provider-profile';

// pi-ai 1.3.0 `providers/data/zai.json` glm-5.3, as `getBuiltinModels('zai')` returns it.
const GLM_5_3 = {
  id: 'glm-5.3', name: 'GLM-5.3', api: 'openai-completions', provider: 'zai',
  baseUrl: 'https://api.z.ai/api/coding/paas/v4', reasoning: true,
  thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
  input: ['text'], cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  compat: {
    supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: 'max_tokens',
    thinkingFormat: 'zai', supportsStrictMode: true, zaiToolStream: true,
  },
  contextWindow: 1_000_000, maxTokens: 131_072, type: 'chat',
} as const;

const FULL_MAP = { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null } as const;

describe('piModelConfigFromPinnedCatalog', () => {
  it('returns the exact pinned entry, including supportsStrictMode, with the requested thinking level', () => {
    const result = piModelConfigFromPinnedCatalog({ provider: 'zai', api: 'openai-completions', model: 'glm-5.3', thinkingLevel: 'high' });
    const { thinkingLevelMap, compat, contextWindow, maxTokens, reasoning } = GLM_5_3;
    expect(result).toEqual({
      ok: true,
      config: { contextWindow, maxTokens, reasoning, thinkingLevel: 'high', thinkingLevelMap, compat },
      input: ['text'],
    });
  });

  it('builds a profile the projection passes to Pi unchanged', () => {
    const result = piModelConfigFromPinnedCatalog({ provider: 'zai', api: 'openai-completions', model: 'glm-5.3', thinkingLevel: 'low' });
    if (!result.ok) throw new Error(result.reason);
    const profile = parseModelProviderProfile({
      adapter: 'openai_compatible', auth_mode: 'bearer', base_url: GLM_5_3.baseUrl, capabilities: [],
      created_at: '2026-10-21T00:00:00.000Z', updated_at: '2026-10-21T00:00:00.000Z', display_name: 'GLM', enabled: true,
      kind: 'model', model: GLM_5_3.id, profile_ref: 'zai-glm', provider_kind: 'zai', pi_model: result.config,
    });
    const provider = (buildPiProviderProjection(profile, 'pi-rpc') as any).providers['byok-sdk-zai-glm'];
    expect(provider.api).toBe('openai-completions');
    expect(provider.models[0].compat).toEqual(GLM_5_3.compat);
    expect(provider.models[0].thinkingLevelMap).toEqual(GLM_5_3.thinkingLevelMap);
    // The frozen prepared wire does not carry supportsStrictMode, so that entry keeps refusing it.
    expect(() => assertPiPreparedProviderProfile(profile)).toThrow(/declares Pi compat\.supportsStrictMode; the prepared model wire/);
  });

  it('refuses an entry whose catalog thinkingLevelMap is not complete, naming the field', () => {
    expect(piModelConfigFromPinnedCatalog({ provider: 'minimax', api: 'anthropic-messages', model: 'MiniMax-M2.7', thinkingLevel: 'high' }))
      .toEqual({ ok: false, reason: 'unrepresentable', fields: ['thinkingLevelMap'] });
  });

  it('refuses a thinking level the entry does not support and lists the supported ones', () => {
    expect(piModelConfigFromPinnedCatalog({ provider: 'zai', api: 'openai-completions', model: 'glm-5.3', thinkingLevel: 'medium' }))
      .toEqual({ ok: false, reason: 'thinking_level_unsupported', supported: ['low', 'high', 'max'] });
  });

  it.each([
    { provider: 'custom', api: 'openai-completions', model: 'glm-5.3' },
    { provider: 'zai', api: 'openai-responses', model: 'glm-5.3' },
    { provider: 'zai', api: 'openai-completions', model: 'glm-0' },
    { provider: '__proto__', api: 'openai-completions', model: 'glm-5.3' },
    { provider: 'zai', api: 'openai-completions', model: 'constructor' },
    { provider: 'zai', api: 'bedrock-converse-stream', model: 'glm-5.3' },
  ] as const)('reports $provider/$api/$model as not in the catalog', (selection) => {
    expect(piModelConfigFromPinnedCatalog({ ...selection, thinkingLevel: 'high' } as never))
      .toEqual({ ok: false, reason: 'not_in_catalog' });
  });
});

describe('classifyPiCatalogModel', () => {
  const completions = { ...GLM_5_3, thinkingLevelMap: FULL_MAP, compat: {} };

  it('lists every field PiModelConfig cannot carry, so a new pi-ai field never passes silently', () => {
    expect(classifyPiCatalogModel({
      ...completions,
      headers: { 'x-extra': '1' },
      futureField: true,
      compat: { sendSessionAffinityHeaders: true, supportsStrictMode: true },
      thinkingLevelMap: { ...FULL_MAP, minimal: undefined },
    }, 'openai_compatible')).toEqual({
      unrepresentable: ['compat.sendSessionAffinityHeaders', 'futureField', 'headers', 'thinkingLevelMap.minimal'],
    });
  });

  it('refuses an api that is not the vendor adapter', () => {
    expect(classifyPiCatalogModel(completions, 'anthropic')).toEqual({ unrepresentable: ['api'] });
    expect(classifyPiCatalogModel({ ...completions, api: 'anthropic-messages' }, 'openai_compatible'))
      .toEqual({ unrepresentable: ['api'] });
  });

  it('admits each new compat key only under the Pi api whose schema declares it', () => {
    const anthropic = { ...completions, api: 'anthropic-messages', compat: { forceAdaptiveThinking: true } };
    expect(classifyPiCatalogModel(anthropic, 'anthropic')).toMatchObject({ config: { compat: { forceAdaptiveThinking: true } } });
    expect(classifyPiCatalogModel({ ...completions, compat: { forceAdaptiveThinking: true } }, 'openai_compatible'))
      .toEqual({ unrepresentable: ['compat.forceAdaptiveThinking'] });
    expect(classifyPiCatalogModel({ ...completions, compat: { requiresReasoningContentOnAssistantMessages: true } }, 'openai_compatible'))
      .toMatchObject({ config: { compat: { requiresReasoningContentOnAssistantMessages: true } } });
    const responses = { ...completions, api: 'openai-responses' };
    expect(classifyPiCatalogModel({ ...responses, compat: { supportsStrictMode: false } }, 'openai_compatible'))
      .toMatchObject({ config: { api: 'openai-responses', compat: { supportsStrictMode: false } } });
    expect(classifyPiCatalogModel({ ...responses, compat: { requiresReasoningContentOnAssistantMessages: true } }, 'openai_compatible'))
      .toEqual({ unrepresentable: ['compat.requiresReasoningContentOnAssistantMessages'] });
  });

  it('refuses a reasoning entry with no selectable level as its thinkingLevelMap', () => {
    const allNull = Object.fromEntries(Object.keys(FULL_MAP).map((level) => [level, null]));
    expect(classifyPiCatalogModel({ ...completions, thinkingLevelMap: allNull }, 'openai_compatible'))
      .toEqual({ unrepresentable: ['thinkingLevelMap'] });
  });
});
