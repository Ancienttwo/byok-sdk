import { describe, expect, it } from 'vitest';
import { InMemoryTruthStore, tenantId } from '@byok-sdk/core';
import { PI_MODEL_FIXTURE } from './fixtures/pi-model-config';
import { parseModelProviderProfile, exactProviderProfileBinding, assertExactProviderProfileBinding } from './provider-profile';
import { buildPiProviderArgs, buildPiProviderProjection } from './pi-provider-projection';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { InMemoryProviderProfileStore } from './profile-store';
import { TruthStoreProviderProfileStore } from './truth-profile-store';
import { ProviderRegistry } from './registry';
import { InMemorySecretStore } from './secret-store';

const profileInput = {
  adapter: 'openai_compatible', auth_mode: 'none', base_url: 'http://127.0.0.1:9191/v1',
  capabilities: [], created_at: '2026-09-10T00:00:00.000Z', updated_at: '2026-09-10T00:00:00.000Z',
  display_name: 'Explicit test model', enabled: true, kind: 'model', model: 'glm-5.3-flash',
  profile_ref: 'test-zai', provider_kind: 'custom', pi_model: PI_MODEL_FIXTURE,
};

describe('explicit Pi model authority', () => {
  it('projects exact settings and chooses the declared thinking level', () => {
    const profile = parseModelProviderProfile(profileInput);
    const projection = buildPiProviderProjection(profile, 'pi-rpc') as any;
    const { thinkingLevel, ...settings } = PI_MODEL_FIXTURE;
    expect(projection.providers['byok-sdk-test-zai'].models).toEqual([
      { id: profile.model, name: profile.display_name, input: ['text'], ...settings },
    ]);
    expect(buildPiProviderArgs(profile, ['--mode', 'rpc'])).toEqual([
      '--mode', 'rpc', '--provider', 'byok-sdk-test-zai', '--model', profile.model, '--thinking', thinkingLevel,
    ]);
  });

  it('rejects Pi admission without explicit settings rather than applying native defaults', () => {
    const { pi_model: _, ...directProfile } = profileInput;
    const profile = parseModelProviderProfile(directProfile);
    expect(() => buildPiProviderProjection(profile, 'pi-rpc')).toThrow(/requires explicit pi_model/);
    expect(() => buildPiProviderArgs(profile, ['--mode', 'rpc'])).toThrow(/requires explicit pi_model/);
  });

  it.each([
    { ...PI_MODEL_FIXTURE, contextWindow: 0 },
    { ...PI_MODEL_FIXTURE, maxTokens: 1_000_001 },
    { ...PI_MODEL_FIXTURE, thinkingLevel: 'off' },
    { ...PI_MODEL_FIXTURE, compat: { ...PI_MODEL_FIXTURE.compat, headers: { Authorization: 'forbidden' } } },
    { ...PI_MODEL_FIXTURE, thinkingLevelMap: { low: 'low' } },
  ])('rejects incomplete or conflicting model settings', (pi_model) => {
    expect(() => parseModelProviderProfile({ ...profileInput, pi_model })).toThrow();
  });

  // pi-ai 1.2.0 `providers/data/xai.json` grok-4.3, minus the catalog-only identity, endpoint and cost fields.
  const XAI_RESPONSES_MODEL = {
    api: 'openai-responses', contextWindow: 1_000_000, maxTokens: 30_000, reasoning: true, thinkingLevel: 'low',
    thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
    compat: { supportsLongCacheRetention: false },
    inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 } } },
  } as const;

  it('projects a declared openai-responses api on the provider and the catalog settings on the model', () => {
    const profile = parseModelProviderProfile({ ...profileInput, auth_mode: 'bearer', pi_model: XAI_RESPONSES_MODEL });
    const provider = (buildPiProviderProjection(profile, 'pi-rpc') as any).providers['byok-sdk-test-zai'];
    const { api, thinkingLevel: _, ...settings } = XAI_RESPONSES_MODEL;
    expect(provider.api).toBe(api);
    expect(provider.models).toEqual([{ id: profile.model, name: profile.display_name, input: ['text'], ...settings }]);
  });

  it('keeps openai-completions when no api is declared', () => {
    const provider = (buildPiProviderProjection(parseModelProviderProfile(profileInput), 'pi-rpc') as any).providers['byok-sdk-test-zai'];
    expect(provider.api).toBe('openai-completions');
    expect(provider.models[0]).not.toHaveProperty('api');
  });

  it('admits supportsLongCacheRetention for openai-completions', () => {
    const pi_model = { ...PI_MODEL_FIXTURE, compat: { ...PI_MODEL_FIXTURE.compat, supportsLongCacheRetention: false } };
    expect(parseModelProviderProfile({ ...profileInput, pi_model }).pi_model).toEqual(pi_model);
  });

  it.each([
    ['a Completions-only compat key under openai-responses', { ...XAI_RESPONSES_MODEL, compat: { thinkingFormat: 'openai' } }, /thinkingFormat does not apply to openai-responses/],
    ['an api Pi does not serve for this adapter', { ...XAI_RESPONSES_MODEL, api: 'anthropic-messages' }, /expected one of "openai-completions"\|"openai-responses"/],
    ['an inputLimits key outside Pi\'s schema', { ...XAI_RESPONSES_MODEL, inputLimits: { images: { maxPixels: 1 } } }, /maxPixels/],
    ['a JPEG quality outside 1..100', { ...XAI_RESPONSES_MODEL, inputLimits: { images: { resize: { jpegQuality: 101 } } } }, /expected number to be <=100/],
  ])('rejects %s', (_, pi_model, message) => {
    expect(() => parseModelProviderProfile({ ...profileInput, pi_model })).toThrow(message);
  });

  it('rejects a Pi api on an anthropic profile, whose adapter decides it', () => {
    expect(() => parseModelProviderProfile({
      ...profileInput, adapter: 'anthropic', auth_mode: 'x_api_key', base_url: 'https://api.anthropic.com/v1',
      pi_model: { ...PI_MODEL_FIXTURE, api: 'openai-completions' },
    })).toThrow(/declare no Pi api/);
  });

  it.each(['api', 'contextWindow', 'maxTokens', 'thinkingLevel', 'compat', 'inputLimits'] as const)('fences changed %s before launch', (field) => {
    const original = parseModelProviderProfile(profileInput);
    const changedValues = { api: 'openai-completions', contextWindow: 900_000, maxTokens: 16_384, thinkingLevel: 'high',
      compat: { ...PI_MODEL_FIXTURE.compat, zaiToolStream: false }, inputLimits: { maxRequestBytes: 1_048_576 } };
    const changed = parseModelProviderProfile({ ...profileInput, pi_model: { ...PI_MODEL_FIXTURE, [field]: changedValues[field] } });
    const binding = exactProviderProfileBinding(original);
    expect(exactProviderProfileBinding(changed).profileHash).not.toBe(binding.profileHash);
    expect(() => assertExactProviderProfileBinding(changed, binding)).toThrow(/hash mismatch/);
  });

  it.each(['memory', 'sqlite', 'truth'] as const)('persists and returns Pi configuration through %s registry', async (kind) => {
    const store = kind === 'memory' ? new InMemoryProviderProfileStore()
      : kind === 'sqlite' ? new SqliteProviderProfileStore({ path: ':memory:' })
      : new TruthStoreProviderProfileStore({ tenant: tenantId('pi-model-test'), truthStore: new InMemoryTruthStore({ now: () => new Date(profileInput.updated_at) }) });
    try {
      const registry = new ProviderRegistry({ profileStore: store, secretStore: new InMemorySecretStore(), now: () => new Date(profileInput.updated_at) });
      const original = parseModelProviderProfile(profileInput);
      const status = await registry.configure(original);
      expect((status as any).pi_model).toEqual(PI_MODEL_FIXTURE);
      expect((await store.get(original.profile_ref) as any).pi_model).toEqual(PI_MODEL_FIXTURE);
      const changed = await registry.configure(parseModelProviderProfile({ ...profileInput, pi_model: { ...PI_MODEL_FIXTURE, maxTokens: 16_384 } }));
      expect(changed.profile_hash).not.toBe(status.profile_hash);
      expect(BigInt(changed.profile_revision)).toBeGreaterThan(BigInt(status.profile_revision));
    } finally { await store.close(); }
  });
});
