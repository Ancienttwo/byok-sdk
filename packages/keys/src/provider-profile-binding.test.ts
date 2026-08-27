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
    expect(api.MODEL_PROVIDER_KINDS).toEqual(['openai', 'deepseek', 'anthropic', 'custom']);
  });

  it('projects explicit image-input capability without exposing a credential', () => {
    const projection = keys.buildPiProviderProjection({
      adapter: 'openai_compatible',
      auth_mode: 'bearer',
      base_url: 'https://openrouter.ai/api/v1',
      capabilities: ['image-input'],
      created_at: '2026-08-26T00:00:00.000Z',
      display_name: 'OpenRouter primary',
      enabled: true,
      kind: 'model',
      model: 'anthropic/claude-sonnet-4',
      profile_hash: `sha256:${'a'.repeat(64)}`,
      profile_ref: 'openrouter-primary',
      profile_revision: '1',
      provider_kind: 'custom',
      updated_at: '2026-08-26T00:00:00.000Z',
    } as never) as {
      providers: Record<string, { models: Array<{ input?: string[] }> }>;
    };

    expect(projection.providers['byok-sdk-openrouter-primary']?.models[0]?.input).toEqual(['text', 'image']);
    expect(JSON.stringify(projection)).not.toMatch(/sk-|credential|secret/iu);
  });
});
