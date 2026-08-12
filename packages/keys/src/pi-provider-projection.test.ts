import { describe, expect, it } from 'vitest';

import {
  PI_PROJECTED_KEY_ENV,
  buildPiProviderArgs,
  buildPiProviderProjection,
} from './pi-provider-projection';
import { parseModelProviderProfile } from './provider-profile';

const timestamps = {
  created_at: '2026-08-12T00:00:00.000Z',
  updated_at: '2026-08-12T00:00:00.000Z',
};

describe('buildPiProviderProjection', () => {
  it('projects an OpenAI-compatible profile without embedding its secret', () => {
    const profile = parseModelProviderProfile({
      ...timestamps,
      adapter: 'openai_compatible',
      auth_mode: 'bearer',
      base_url: 'https://api.openai.com/v1',
      display_name: 'GPT',
      enabled: true,
      kind: 'model',
      model: 'gpt-5.2',
      provider_id: 'openai',
    });
    const projection = buildPiProviderProjection(profile);
    expect(projection).toEqual({
      providers: {
        'byok-sdk-openai': {
          baseUrl: 'https://api.openai.com/v1',
          api: 'openai-completions',
          apiKey: `$${PI_PROJECTED_KEY_ENV}`,
          authHeader: true,
          models: [{ id: 'gpt-5.2', name: 'GPT' }],
        },
      },
    });
    expect(JSON.stringify(projection)).not.toContain('sk-');
  });

  it('uses Anthropic Messages/x-api-key semantics without a bearer authHeader', () => {
    const profile = parseModelProviderProfile({
      ...timestamps,
      adapter: 'anthropic',
      auth_mode: 'x_api_key',
      base_url: 'https://api.anthropic.com',
      display_name: 'Claude',
      enabled: true,
      kind: 'model',
      model: 'claude-sonnet-5',
      provider_id: 'anthropic',
    });
    expect(buildPiProviderProjection(profile)).toEqual({
      providers: {
        'byok-sdk-anthropic': {
          baseUrl: 'https://api.anthropic.com',
          api: 'anthropic-messages',
          apiKey: `$${PI_PROJECTED_KEY_ENV}`,
          models: [{ id: 'claude-sonnet-5', name: 'Claude' }],
        },
      },
    });
  });

  it('binds Pi to the namespaced projection and exact model', () => {
    const profile = parseModelProviderProfile({
      ...timestamps,
      adapter: 'openai_compatible',
      auth_mode: 'bearer',
      base_url: 'https://api.openai.com/v1',
      display_name: 'GPT',
      enabled: true,
      kind: 'model',
      model: 'gpt-5.2',
      provider_id: 'openai',
    });
    expect(buildPiProviderArgs(profile, ['--mode', 'rpc', '--no-tools'])).toEqual([
      '--mode',
      'rpc',
      '--no-tools',
      '--provider',
      'byok-sdk-openai',
      '--model',
      'gpt-5.2',
    ]);
  });

  it('rejects delegated provider/model overrides and non-RPC modes', () => {
    const profile = parseModelProviderProfile({
      ...timestamps,
      adapter: 'openai_compatible',
      auth_mode: 'bearer',
      base_url: 'https://api.openai.com/v1',
      display_name: 'GPT',
      enabled: true,
      kind: 'model',
      model: 'gpt-5.2',
      provider_id: 'openai',
    });
    expect(() => buildPiProviderArgs(profile, ['--mode', 'json'])).toThrow(/--mode rpc/);
    expect(() =>
      buildPiProviderArgs(profile, ['--mode', 'rpc', '--provider', 'openai']),
    ).toThrow(/does not allow delegated argument --provider/);
  });
});
