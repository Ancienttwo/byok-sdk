import { describe, expect, it } from 'vitest';

import * as keys from './index';

describe('Agent-scoped provider profile binding', () => {
  it('exposes an opaque multi-instance profile identity instead of one fixed custom slot', async () => {
    const api = keys as typeof keys & {
      ProviderProfileRefSchema?: { parse(value: unknown): string };
      MODEL_PROVIDER_KINDS?: readonly string[];
    };

    expect(api.ProviderProfileRefSchema).toBeDefined();
    expect(api.ProviderProfileRefSchema?.parse('openrouter-primary')).toBe('openrouter-primary');
    expect(api.ProviderProfileRefSchema?.parse('openrouter-backup')).toBe('openrouter-backup');
    expect(api.MODEL_PROVIDER_KINDS).toEqual([...keys.MODEL_PROVIDER_VENDOR_IDS, 'custom']);
    expect(api.MODEL_PROVIDER_KINDS).toEqual(
      expect.arrayContaining(['openai', 'deepseek', 'anthropic', 'custom']),
    );
  });

  it('projects explicit image-input capability without exposing a credential', () => {
    const profile = keys.parseModelProviderProfile({
      adapter: 'openai_compatible',
      auth_mode: 'bearer',
      base_url: 'https://openrouter.ai/api/v1',
      capabilities: ['image-input'],
      created_at: '2026-08-26T00:00:00.000Z',
      display_name: 'OpenRouter primary',
      enabled: true,
      kind: 'model',
      model: 'anthropic/claude-sonnet-4',
      profile_ref: 'openrouter-primary',
      provider_kind: 'custom',
      updated_at: '2026-08-26T00:00:00.000Z',
    });
    const projection = keys.buildPiProviderProjection(profile) as {
      providers: Record<string, { models: Array<{ input?: string[] }> }>;
    };

    expect(projection.providers['byok-sdk-openrouter-primary']?.models[0]?.input).toEqual(['text', 'image']);
    expect(JSON.stringify(projection)).not.toMatch(/sk-|credential|secret/iu);
  });

  it('derives and verifies one exact credential-free local binding', () => {
    const profile = keys.parseModelProviderProfile({
      adapter: 'openai_compatible',
      auth_mode: 'bearer',
      base_url: 'https://openrouter.ai/api/v1',
      capabilities: ['image-input'],
      created_at: '2026-08-26T00:00:00.000Z',
      display_name: 'OpenRouter primary',
      enabled: true,
      kind: 'model',
      model: 'anthropic/claude-sonnet-4',
      profile_ref: 'openrouter-primary',
      provider_kind: 'custom',
      updated_at: '2026-08-26T00:00:00.000Z',
    });
    const binding = keys.exactProviderProfileBinding(profile, ['image-input']);

    expect(binding).toMatchObject({
      profileRef: 'openrouter-primary',
      profileRevision: String(Date.parse('2026-08-26T00:00:00.000Z')),
      modelId: 'anthropic/claude-sonnet-4',
      requiredCapabilities: ['image-input'],
    });
    expect(binding.profileHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(binding)).not.toContain(profile.base_url);
    expect(() => keys.assertExactProviderProfileBinding(profile, binding)).not.toThrow();
    expect(() => keys.assertExactProviderProfileBinding(profile, {
      ...binding,
      profileRevision: String(Number(binding.profileRevision) + 1),
    })).toThrow(/revision mismatch/);
    expect(() => keys.assertExactProviderProfileBinding(profile, {
      ...binding,
      requiredCapabilities: ['image-input', 'image-input'],
    })).toThrow(/unsupported|repeat|unique/);
  });
});
