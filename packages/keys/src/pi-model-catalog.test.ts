import { describe, expect, it } from 'vitest';
import { classifyPiCatalogModel, piModelConfigFromPinnedCatalog } from './pi-model-catalog';
import { assertPiPreparedProviderProfile } from './pi-provider-launcher-core';
import { buildPiProviderProjection } from './pi-provider-projection';
import { MODEL_PROVIDER_VENDORS } from './provider-catalog';
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

  it('refuses an entry whose catalog thinkingLevelMap is partial, naming each missing level', () => {
    // pi-ai 1.3.0 deepseek-flash maps five levels and leaves off and xhigh out.
    expect(piModelConfigFromPinnedCatalog({ provider: 'deepseek', api: 'openai-completions', model: 'deepseek-flash', thinkingLevel: 'high' }))
      .toEqual({ ok: false, reason: 'unrepresentable', fields: ['thinkingLevelMap.off', 'thinkingLevelMap.xhigh'] });
  });

  it('returns an entry that has no thinkingLevelMap without one', () => {
    const result = piModelConfigFromPinnedCatalog({ provider: 'minimax', api: 'anthropic-messages', model: 'MiniMax-M2.7', thinkingLevel: 'medium' });
    expect(result).toEqual({
      ok: true,
      config: { contextWindow: 204_800, maxTokens: 131_072, reasoning: true, thinkingLevel: 'medium', compat: {} },
      input: ['text'],
    });
    expect(result.ok && Object.hasOwn(result.config, 'thinkingLevelMap')).toBe(false);
  });

  it.each([
    ['cerebras', 'openai-completions', 'gpt-oss-120b'],
    ['minimax', 'anthropic-messages', 'MiniMax-M2.7'],
    ['minimax', 'anthropic-messages', 'MiniMax-M3'],
    ['minimax-cn', 'anthropic-messages', 'MiniMax-M2.7'],
    ['zai', 'openai-completions', 'glm-4.7'],
    ['zai', 'openai-completions', 'glm-5-turbo'],
    ['zai', 'openai-completions', 'glm-5.3'],
    ['zai-coding-cn', 'openai-completions', 'glm-4.6v'],
  ] as const)('derives the Cerebras, MiniMax and GLM entry %s/%s/%s', (provider, api, model) => {
    expect(piModelConfigFromPinnedCatalog({ provider, api, model, thinkingLevel: 'high' })).toMatchObject({ ok: true });
  });

  it.each(['xhigh', 'max'] as const)('refuses %s for an entry without a map, as Pi does', (thinkingLevel) => {
    expect(piModelConfigFromPinnedCatalog({ provider: 'minimax-cn', api: 'anthropic-messages', model: 'MiniMax-M2.7', thinkingLevel }))
      .toEqual({ ok: false, reason: 'thinking_level_unsupported', supported: ['off', 'minimal', 'low', 'medium', 'high'] });
  });

  it('builds an anthropic profile from an entry without a map, and the projection declares no map', () => {
    const result = piModelConfigFromPinnedCatalog({ provider: 'minimax', api: 'anthropic-messages', model: 'MiniMax-M2.7', thinkingLevel: 'high' });
    if (!result.ok) throw new Error(result.reason);
    const profile = parseModelProviderProfile({
      adapter: 'anthropic', auth_mode: 'x_api_key', base_url: 'https://api.minimax.io/anthropic/v1', capabilities: [],
      created_at: '2026-10-21T00:00:00.000Z', updated_at: '2026-10-21T00:00:00.000Z', display_name: 'MiniMax', enabled: true,
      kind: 'model', model: 'MiniMax-M2.7', profile_ref: 'minimax-m27', provider_kind: 'minimax', pi_model: result.config,
    });
    const provider = (buildPiProviderProjection(profile, 'pi-rpc') as any).providers['byok-sdk-minimax-m27'];
    expect([provider.api, provider.baseUrl]).toEqual(['anthropic-messages', 'https://api.minimax.io/anthropic']);
    expect(provider.models[0]).toEqual({
      id: 'MiniMax-M2.7', name: 'MiniMax', input: ['text'], contextWindow: 204_800, maxTokens: 131_072, reasoning: true, compat: {},
    });
    expect(Object.hasOwn(provider.models[0], 'thinkingLevelMap')).toBe(false);
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

describe('pinned entries that declare sendSessionAffinityHeaders or allowEmptySignature', () => {
  const timestamps = { created_at: '2026-10-26T00:00:00.000Z', updated_at: '2026-10-26T00:00:00.000Z' };

  it('returns an OpenRouter completions entry with sendSessionAffinityHeaders and projects it to Pi', () => {
    // pi-ai 1.4.0 `providers/data/openrouter.json` deepseek/deepseek-chat.
    const result = piModelConfigFromPinnedCatalog({ provider: 'openrouter', api: 'openai-completions', model: 'deepseek/deepseek-chat', thinkingLevel: 'off' });
    const compat = { supportsDeveloperRole: false, thinkingFormat: 'openrouter', supportsStrictMode: true, sendSessionAffinityHeaders: true };
    expect(result).toEqual({
      ok: true, config: { contextWindow: 128_000, maxTokens: 16_000, reasoning: false, thinkingLevel: 'off', compat }, input: ['text'],
    });
    if (!result.ok) throw new Error(result.reason);
    const vendor = MODEL_PROVIDER_VENDORS.openrouter;
    const profile = parseModelProviderProfile({
      ...timestamps, adapter: vendor.adapter, auth_mode: vendor.auth_mode, base_url: vendor.base_url, capabilities: [],
      display_name: 'DeepSeek', enabled: true, kind: 'model', model: 'deepseek/deepseek-chat', profile_ref: 'or-deepseek',
      provider_kind: 'openrouter', pi_model: result.config,
    });
    const provider = (buildPiProviderProjection(profile, 'pi-rpc') as any).providers['byok-sdk-or-deepseek'];
    expect(provider.api).toBe('openai-completions');
    expect(provider.models[0].compat).toEqual(compat);
    expect(() => assertPiPreparedProviderProfile(profile)).toThrow(/compat\.sendSessionAffinityHeaders; the prepared model wire/);
  });

  it('returns a Vercel AI Gateway anthropic-messages entry with allowEmptySignature and projects it to Pi', () => {
    // pi-ai 1.4.0 `providers/data/vercel-ai-gateway.json` alibaba/qwen-3-235b.
    const result = piModelConfigFromPinnedCatalog({ provider: 'vercel-ai-gateway', api: 'anthropic-messages', model: 'alibaba/qwen-3-235b', thinkingLevel: 'off' });
    expect(result).toEqual({
      ok: true,
      config: { contextWindow: 262_144, maxTokens: 16_384, reasoning: false, thinkingLevel: 'off', compat: { allowEmptySignature: true } },
      input: ['text'],
    });
    if (!result.ok) throw new Error(result.reason);
    const vendor = MODEL_PROVIDER_VENDORS['vercel-ai-gateway'];
    const profile = parseModelProviderProfile({
      ...timestamps, adapter: vendor.adapter, auth_mode: vendor.auth_mode, base_url: vendor.base_url, capabilities: [],
      display_name: 'Qwen 3 235B', enabled: true, kind: 'model', model: 'alibaba/qwen-3-235b', profile_ref: 'vercel-qwen',
      provider_kind: 'vercel-ai-gateway', pi_model: result.config,
    });
    const provider = (buildPiProviderProjection(profile, 'pi-rpc') as any).providers['byok-sdk-vercel-qwen'];
    expect(provider.api).toBe('anthropic-messages');
    expect(provider.models[0].compat).toEqual({ allowEmptySignature: true });
    expect(() => assertPiPreparedProviderProfile(profile)).toThrow(/anthropic adapter/);
  });
});

describe('classifyPiCatalogModel', () => {
  const completions = { ...GLM_5_3, thinkingLevelMap: FULL_MAP, compat: {} };

  it('lists every field PiModelConfig cannot carry, so a new pi-ai field never passes silently', () => {
    expect(classifyPiCatalogModel({
      ...completions,
      headers: { 'x-extra': '1' },
      futureField: true,
      compat: { sessionAffinityFormat: 'openrouter', supportsStrictMode: true },
      thinkingLevelMap: { ...FULL_MAP, minimal: undefined },
    }, 'openai_compatible')).toEqual({
      unrepresentable: ['compat.sessionAffinityFormat', 'futureField', 'headers', 'thinkingLevelMap.minimal'],
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

  it('admits sendSessionAffinityHeaders under completions and anthropic-messages, and allowEmptySignature under anthropic-messages only', () => {
    const both = { sendSessionAffinityHeaders: true, allowEmptySignature: true };
    expect(classifyPiCatalogModel({ ...completions, api: 'anthropic-messages', compat: both }, 'anthropic'))
      .toMatchObject({ config: { compat: both } });
    expect(classifyPiCatalogModel({ ...completions, compat: { sendSessionAffinityHeaders: false } }, 'openai_compatible'))
      .toMatchObject({ config: { compat: { sendSessionAffinityHeaders: false } } });
    expect(classifyPiCatalogModel({ ...completions, compat: both }, 'openai_compatible'))
      .toEqual({ unrepresentable: ['compat.allowEmptySignature'] });
    expect(classifyPiCatalogModel({ ...completions, api: 'openai-responses', compat: both }, 'openai_compatible'))
      .toEqual({ unrepresentable: ['compat.allowEmptySignature', 'compat.sendSessionAffinityHeaders'] });
  });

  it.each(['sendSessionAffinityHeaders', 'allowEmptySignature'] as const)('refuses a non-boolean compat.%s', (key) => {
    const anthropic = { ...completions, api: 'anthropic-messages' };
    for (const value of ['true', 1, null]) {
      expect(classifyPiCatalogModel({ ...anthropic, compat: { [key]: value } }, 'anthropic'))
        .toEqual({ unrepresentable: [`compat.${key}`] });
    }
  });

  it('keeps an absent thinkingLevelMap absent', () => {
    const { thinkingLevelMap: _, ...withoutMap } = completions;
    const entry = classifyPiCatalogModel(withoutMap, 'openai_compatible');
    expect(entry).toMatchObject({ config: { reasoning: true, compat: {} } });
    expect('config' in entry && Object.hasOwn(entry.config, 'thinkingLevelMap')).toBe(false);
  });

  it('refuses a reasoning entry with no selectable level as its thinkingLevelMap', () => {
    const allNull = Object.fromEntries(Object.keys(FULL_MAP).map((level) => [level, null]));
    expect(classifyPiCatalogModel({ ...completions, thinkingLevelMap: allNull }, 'openai_compatible'))
      .toEqual({ unrepresentable: ['thinkingLevelMap'] });
  });
});
