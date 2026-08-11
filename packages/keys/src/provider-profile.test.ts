import { describe, expect, it } from 'vitest';

import { ByokKeysError } from './errors';
import {
  ModelProviderProfileSchema,
  parseModelProviderProfile,
  type ModelProviderProfileInput,
} from './provider-profile';

const openAiProfile = (
  overrides: Partial<ModelProviderProfileInput> = {},
): ModelProviderProfileInput => ({
  adapter: 'openai_compatible',
  auth_mode: 'bearer',
  base_url: 'https://api.openai.com/v1',
  created_at: '2026-08-05T00:00:00.000Z',
  display_name: 'OpenAI',
  enabled: true,
  kind: 'model',
  model: 'gpt-4o-mini',
  provider_id: 'openai',
  updated_at: '2026-08-05T00:00:00.000Z',
  ...overrides,
});

const anthropicProfile = (
  overrides: Partial<ModelProviderProfileInput> = {},
): ModelProviderProfileInput =>
  openAiProfile({
    adapter: 'anthropic',
    auth_mode: 'x_api_key',
    base_url: 'https://api.anthropic.com/v1',
    display_name: 'Anthropic',
    model: 'claude-sonnet-4-5',
    provider_id: 'anthropic',
    ...overrides,
  });

const expectRejected = (
  value: unknown,
  code = 'PROVIDER_PROFILE_INVALID',
): ByokKeysError => {
  let thrown: unknown;
  try {
    parseModelProviderProfile(value);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ByokKeysError);
  expect((thrown as ByokKeysError).code).toBe(code);
  return thrown as ByokKeysError;
};

describe('ModelProviderProfileSchema', () => {
  it('accepts a bearer OpenAI-compatible profile', () => {
    expect(parseModelProviderProfile(openAiProfile())).toEqual({
      adapter: 'openai_compatible',
      auth_mode: 'bearer',
      base_url: 'https://api.openai.com/v1',
      created_at: '2026-08-05T00:00:00.000Z',
      display_name: 'OpenAI',
      enabled: true,
      kind: 'model',
      model: 'gpt-4o-mini',
      provider_id: 'openai',
      updated_at: '2026-08-05T00:00:00.000Z',
    });
  });

  it('accepts an x_api_key Anthropic profile', () => {
    expect(parseModelProviderProfile(anthropicProfile()).adapter).toBe(
      'anthropic',
    );
  });

  it('accepts auth_mode none on an OpenAI-compatible loopback provider', () => {
    const parsed = parseModelProviderProfile(
      openAiProfile({
        auth_mode: 'none',
        base_url: 'http://localhost:11434/v1',
        provider_id: 'custom',
      }),
    );
    expect(parsed.auth_mode).toBe('none');
  });

  it('normalizes the base URL and trims surrounding whitespace on strings', () => {
    const parsed = parseModelProviderProfile(
      openAiProfile({
        base_url: 'https://api.openai.com/v1/',
        display_name: '  OpenAI  ',
      }),
    );
    expect(parsed.base_url).toBe('https://api.openai.com/v1');
    expect(parsed.display_name).toBe('OpenAI');
  });

  it('rejects an anthropic adapter that is not x_api_key', () => {
    const error = expectRejected(anthropicProfile({ auth_mode: 'bearer' }));
    expect(error.message).toBe('Anthropic requires x_api_key authentication');
  });

  it('rejects an openai_compatible adapter using x_api_key', () => {
    const error = expectRejected(openAiProfile({ auth_mode: 'x_api_key' }));
    expect(error.message).toBe(
      'OpenAI-compatible providers support bearer or no authentication',
    );
  });

  it('rejects an unknown provider id', () => {
    expectRejected(openAiProfile({ provider_id: 'mistral' as never }));
  });

  it('rejects an unknown auth mode', () => {
    expectRejected(openAiProfile({ auth_mode: 'oauth' as never }));
  });

  it('rejects the market_data kind that stayed in the source repo', () => {
    expectRejected({ ...openAiProfile(), kind: 'market_data' });
  });

  it('reports a bad base URL with the URL error code, not the profile code', () => {
    expectRejected(
      openAiProfile({ base_url: 'http://api.openai.com/v1' }),
      'PROVIDER_URL_INVALID',
    );
  });

  it('rejects updated_at preceding created_at', () => {
    const error = expectRejected(
      openAiProfile({ updated_at: '2026-08-04T00:00:00.000Z' }),
    );
    expect(error.message).toBe('Provider updated_at cannot precede created_at');
  });

  it('rejects a non-ISO timestamp', () => {
    expectRejected(openAiProfile({ created_at: 'yesterday' }));
  });

  it('rejects an empty display name', () => {
    expectRejected(openAiProfile({ display_name: '   ' }));
  });

  it('rejects a display name over 100 characters', () => {
    expectRejected(openAiProfile({ display_name: 'a'.repeat(101) }));
  });

  it('rejects a model name over 160 characters', () => {
    expectRejected(openAiProfile({ model: 'm'.repeat(161) }));
  });

  it('rejects header-injection characters in the model name', () => {
    expectRejected(openAiProfile({ model: 'gpt-4o\r\nx-injected: 1' }));
  });

  it('rejects a non-boolean enabled flag', () => {
    expectRejected(openAiProfile({ enabled: 'true' as never }));
  });

  it('carries no secret field on the schema', () => {
    const parsed = ModelProviderProfileSchema.parse(openAiProfile());
    expect(Object.keys(parsed).sort()).toEqual([
      'adapter',
      'auth_mode',
      'base_url',
      'created_at',
      'display_name',
      'enabled',
      'kind',
      'model',
      'provider_id',
      'updated_at',
    ]);
  });

  it('strips unknown fields rather than carrying them through', () => {
    const parsed = ModelProviderProfileSchema.parse({
      ...openAiProfile(),
      api_key: 'sk-should-not-survive',
    });
    expect(JSON.stringify(parsed)).not.toContain('sk-should-not-survive');
  });
});
