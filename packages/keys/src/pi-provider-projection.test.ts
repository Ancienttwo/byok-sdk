import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { PI_MODEL_FIXTURE } from './fixtures/pi-model-config';
const { thinkingLevel, ...modelSettings } = PI_MODEL_FIXTURE;

import { modelApiUrl } from './http';
import { MODEL_PROVIDER_VENDORS } from './provider-catalog';
import {
  PI_AUTH_NONE_API_KEY,
  PI_LAUNCHER_RUNTIME_ENTRIES,
  PI_PROJECTED_KEY_ENV,
  buildPiPreparedArgs,
  buildPiProviderArgs,
  buildPiProviderProjection,
} from './pi-provider-projection';
import { parseModelProviderProfile } from './provider-profile';

const timestamps = {
  created_at: '2026-08-12T00:00:00.000Z',
  updated_at: '2026-08-12T00:00:00.000Z',
};

describe('buildPiProviderProjection', () => {
  const argvProfile = () => parseModelProviderProfile({
    ...timestamps, pi_model: PI_MODEL_FIXTURE, adapter: 'openai_compatible', auth_mode: 'none',
    base_url: 'http://127.0.0.1:9191/v1', capabilities: [], display_name: 'Synthetic', enabled: true,
    kind: 'model', model: 'explicit-model', profile_ref: 'synthetic', provider_kind: 'custom',
  });

  it.each([
    ['--config-digest=' + 'a'.repeat(64)], ['--config-digest', 'a'.repeat(64)], ['--config', './relative.json'], ['--config', '/bad\nconfig.json'],
    ['__byok_sdk_helper', 'pi-rpc'], ['--pi-fixed-args', '[\"spoof\"]'], ['--no-skills', '--no-skills'],
    ['--extension', './relative.js'], ['--extension', 'https://example.com/extension.js'],
    ['--extension', path.resolve('bad\npath.js')], ['--extension'],
    ['--model', 'override'], ['--thinking', 'max'], ['--settings', '/untrusted'],
    ['--mode', 'rpc'], ['--no-tools', '--tools', 'bash'], ['--session', 'bad\nvalue'],
  ])('rejects unsafe or conflicting delegated argv %j', (...tail) => {
    expect(() => buildPiProviderArgs(argvProfile(), ['--mode', 'rpc', ...tail])).toThrow();
  });

  it('preserves absolute extensions and allow/deny tools under the exact model', () => {
    const extension = path.resolve('owned-extension.js');
    const args = ['--mode', 'rpc', '--extension', extension, '--tools', 'read', '--exclude-tools', 'bash'];
    expect(buildPiProviderArgs(argvProfile(), args).slice(0, args.length)).toEqual(args);
  });

  it('preserves explicit SDK entry config and disabled discovery flags', () => {
    const args = ['--config', path.resolve('task config.json'), '--mode', 'rpc', '--no-skills', '--no-extensions'];
    expect(buildPiProviderArgs(argvProfile(), args)).toEqual([
      ...args, '--provider', 'byok-sdk-synthetic', '--model', 'explicit-model', '--thinking', thinkingLevel,
    ]);
  });

  it('projects an OpenAI-compatible profile without embedding its secret', () => {
    const profile = parseModelProviderProfile({
      ...timestamps,
      pi_model: PI_MODEL_FIXTURE,
      adapter: 'openai_compatible',
      auth_mode: 'bearer',
      base_url: 'https://api.openai.com/v1',
      capabilities: [],
      display_name: 'GPT',
      enabled: true,
      kind: 'model',
      model: 'gpt-5.2',
      profile_ref: 'openai',
      provider_kind: 'openai',
    });
    const projection = buildPiProviderProjection(profile);
    expect(projection).toEqual({
      providers: {
        'byok-sdk-openai': {
          baseUrl: 'https://api.openai.com/v1',
          api: 'openai-completions',
          apiKey: `$${PI_PROJECTED_KEY_ENV}`,
          authHeader: true,
          models: [{ ...modelSettings, id: 'gpt-5.2', name: 'GPT', input: ['text'] }],
        },
      },
    });
    expect(JSON.stringify(projection)).not.toContain('sk-');
  });

  it('uses Anthropic Messages/x-api-key semantics without a bearer authHeader', () => {
    const profile = parseModelProviderProfile({
      ...timestamps,
      pi_model: PI_MODEL_FIXTURE,
      adapter: 'anthropic',
      auth_mode: 'x_api_key',
      base_url: 'https://api.anthropic.com/v1',
      capabilities: [],
      display_name: 'Claude',
      enabled: true,
      kind: 'model',
      model: 'claude-sonnet-5',
      profile_ref: 'anthropic',
      provider_kind: 'anthropic',
    });
    expect(buildPiProviderProjection(profile)).toEqual({
      providers: {
        'byok-sdk-anthropic': {
          baseUrl: 'https://api.anthropic.com',
          api: 'anthropic-messages',
          apiKey: `$${PI_PROJECTED_KEY_ENV}`,
          models: [{ ...modelSettings, id: 'claude-sonnet-5', name: 'Claude', input: ['text'] }],
        },
      },
    });
  });

  /** Pi's Anthropic SDK requests `${baseUrl}/v1/messages`; the keys client requests `modelApiUrl(base_url, 'messages')`. */
  const piAnthropicEndpoint = (profile: ReturnType<typeof parseModelProviderProfile>) => {
    const projection = buildPiProviderProjection(profile) as { providers: Record<string, { baseUrl: string }> };
    return `${projection.providers[`byok-sdk-${profile.profile_ref}`]!.baseUrl}/v1/messages`;
  };
  const anthropicProfile = (provider_kind: string, base_url: string) => parseModelProviderProfile({
    ...timestamps, pi_model: PI_MODEL_FIXTURE, adapter: 'anthropic', auth_mode: 'x_api_key', base_url,
    capabilities: [], display_name: 'Messages', enabled: true, kind: 'model', model: 'messages-model',
    profile_ref: 'messages', provider_kind,
  });

  it.each(Object.entries(MODEL_PROVIDER_VENDORS).filter(([, vendor]) => vendor.adapter === 'anthropic'))(
    'sends Pi to the keys client endpoint for catalog entry %s',
    (kind, vendor) => {
      const profile = anthropicProfile(kind, vendor.base_url);
      expect(piAnthropicEndpoint(profile)).toBe(modelApiUrl(vendor.base_url, 'messages'));
      expect(piAnthropicEndpoint(profile)).not.toContain('/v1/v1/');
    },
  );

  it.each([
    ['https://gateway.example/anthropic/v1', 'https://gateway.example/anthropic/v1/messages'],
    ['https://gateway.example/anthropic/v1/', 'https://gateway.example/anthropic/v1/messages'],
    ['https://gateway.example/anthropic/v1/messages', 'https://gateway.example/anthropic/v1/messages'],
    ['http://127.0.0.1:8080/v1', 'http://127.0.0.1:8080/v1/messages'],
  ])('sends Pi to the keys client endpoint for custom base_url %s', (baseUrl, endpoint) => {
    expect(modelApiUrl(baseUrl, 'messages')).toBe(endpoint);
    expect(piAnthropicEndpoint(anthropicProfile('custom', baseUrl))).toBe(endpoint);
  });

  it.each(['https://gateway.example/anthropic', 'https://api.anthropic.com', 'https://gateway.example/v2'])(
    'refuses a custom Anthropic base_url %s that Pi cannot reach exactly',
    (baseUrl) => {
      expect(() => buildPiProviderProjection(anthropicProfile('custom', baseUrl)))
        .toThrow(expect.objectContaining({ code: 'PROVIDER_URL_INVALID' }));
    },
  );

  it('projects the fixed placeholder key, and no bearer flag, for a keyless rpc profile', () => {
    expect(PI_AUTH_NONE_API_KEY).toBe('byok-sdk-auth-none');
    expect(buildPiProviderProjection(argvProfile(), 'pi-rpc')).toStrictEqual({
      providers: {
        'byok-sdk-synthetic': {
          baseUrl: 'http://127.0.0.1:9191/v1',
          api: 'openai-completions',
          apiKey: PI_AUTH_NONE_API_KEY,
          models: [{ ...modelSettings, id: 'explicit-model', name: 'Synthetic', input: ['text'] }],
        },
      },
    });
  });

  it.each(['pi-prepared', 'pi-durable'] as const)('refuses a keyless profile for the %s entry, which requires a credential', (entry) => {
    expect(() => buildPiProviderProjection(argvProfile(), entry))
      .toThrow(expect.objectContaining({ code: 'PROVIDER_PROFILE_INVALID' }));
  });

  it('namespaces two custom profiles of one kind as distinct Pi providers', () => {
    const build = (profile_ref: string, capabilities: string[]) =>
      buildPiProviderProjection(
        parseModelProviderProfile({
          ...timestamps,
      pi_model: PI_MODEL_FIXTURE,
          adapter: 'openai_compatible',
          auth_mode: 'bearer',
          base_url: 'https://openrouter.ai/api/v1',
          capabilities,
          display_name: 'OpenRouter',
          enabled: true,
          kind: 'model',
          model: 'anthropic/claude-sonnet-4',
          profile_ref,
          provider_kind: 'custom',
        }),
      ) as { providers: Record<string, { models: Array<{ input: string[] }> }> };

    const primary = build('openrouter-primary', ['image-input']);
    const backup = build('openrouter-backup', []);
    expect(Object.keys(primary.providers)).toEqual(['byok-sdk-openrouter-primary']);
    expect(Object.keys(backup.providers)).toEqual(['byok-sdk-openrouter-backup']);
    expect(primary.providers['byok-sdk-openrouter-primary']?.models[0]?.input).toEqual([
      'text',
      'image',
    ]);
    expect(backup.providers['byok-sdk-openrouter-backup']?.models[0]?.input).toEqual([
      'text',
    ]);
  });

  it('binds Pi to the namespaced projection and exact model', () => {
    const profile = parseModelProviderProfile({
      ...timestamps,
      pi_model: PI_MODEL_FIXTURE,
      adapter: 'openai_compatible',
      auth_mode: 'bearer',
      base_url: 'https://api.openai.com/v1',
      capabilities: [],
      display_name: 'GPT',
      enabled: true,
      kind: 'model',
      model: 'gpt-5.2',
      profile_ref: 'openai',
      provider_kind: 'openai',
    });
    expect(buildPiProviderArgs(profile, ['--mode', 'rpc', '--no-tools'])).toEqual([
      '--mode',
      'rpc',
      '--no-tools',
      '--provider',
      'byok-sdk-openai',
      '--model',
      'gpt-5.2', '--thinking', thinkingLevel,
    ]);
  });

  it('rejects delegated provider/model overrides and non-RPC modes', () => {
    const profile = parseModelProviderProfile({
      ...timestamps,
      pi_model: PI_MODEL_FIXTURE,
      adapter: 'openai_compatible',
      auth_mode: 'bearer',
      base_url: 'https://api.openai.com/v1',
      capabilities: [],
      display_name: 'GPT',
      enabled: true,
      kind: 'model',
      model: 'gpt-5.2',
      profile_ref: 'openai',
      provider_kind: 'openai',
    });
    expect(() => buildPiProviderArgs(profile, ['--mode', 'json'])).toThrow(/--mode rpc/);
    expect(() =>
      buildPiProviderArgs(profile, ['--mode', 'rpc', '--provider', 'openai']),
    ).toThrow(/does not allow delegated argument --provider/);
  });
});

describe('the pi-prepared and pi-durable delegated argv grammar', () => {
  const config = path.resolve('prepared-launch.json');

  it('declares exactly the three runtime entries this launcher may parent', () => {
    expect([...PI_LAUNCHER_RUNTIME_ENTRIES]).toEqual(['pi-rpc', 'pi-prepared', 'pi-durable']);
  });

  it('accepts exactly --config <absolute path> and appends nothing', () => {
    expect(buildPiPreparedArgs(['--config', config])).toEqual(['--config', config]);
  });

  it.each([
    [[]],
    [['--config']],
    [['--config', config, '--no-skills']],
    [['--no-skills', '--config', config]],
    [['--config', 'prepared-launch.json']],
    [['--config', '/tmp/bad\nlaunch.json']],
    [['--config', '/tmp/bad\u0000launch.json']],
    [['--provider', 'byok-sdk-synthetic']],
    [['--model', 'explicit-model']],
    [['--thinking', 'low']],
    [['--mode', 'rpc']],
    [['--config', config, '--config', config]],
  ])('refuses delegated argv the prepared host would not accept %j', (delegated) => {
    expect(() => buildPiPreparedArgs(delegated)).toThrow();
  });

  it('leaves the pi-rpc grammar byte-identical to the pre-runtime-entry output', () => {
    const profile = parseModelProviderProfile({
      ...timestamps, pi_model: PI_MODEL_FIXTURE, adapter: 'openai_compatible', auth_mode: 'bearer',
      base_url: 'https://api.z.ai/api/coding/paas/v4', capabilities: [], display_name: 'GLM',
      enabled: true, kind: 'model', model: 'glm-4.6', profile_ref: 'zai-coding', provider_kind: 'custom',
    });
    const delegated = ['--config', config, '--mode', 'rpc', '--no-skills'];
    // Frozen literal, captured from the grammar as it stood at ea5719b4, so a
    // future edit to the shared launcher cannot move the rpc child's argv
    // while only the prepared entry was meant to change.
    expect(JSON.stringify(buildPiProviderArgs(profile, delegated))).toBe(JSON.stringify([
      '--config', config, '--mode', 'rpc', '--no-skills',
      '--provider', 'byok-sdk-zai-coding', '--model', 'glm-4.6', '--thinking', 'low',
    ]));
  });
});
