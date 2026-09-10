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
    const projection = buildPiProviderProjection(profile) as any;
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
    expect(() => buildPiProviderProjection(profile)).toThrow(/requires explicit pi_model/);
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

  it.each(['contextWindow', 'maxTokens', 'thinkingLevel', 'compat'] as const)('fences changed %s before launch', (field) => {
    const original = parseModelProviderProfile(profileInput);
    const changedValues = { contextWindow: 900_000, maxTokens: 16_384, thinkingLevel: 'high',
      compat: { ...PI_MODEL_FIXTURE.compat, zaiToolStream: false } };
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
