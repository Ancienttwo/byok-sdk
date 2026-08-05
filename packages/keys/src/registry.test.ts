import { beforeEach, describe, expect, it } from 'vitest';

import { AnthropicMessagesClient } from './anthropic-client';
import { OpenAiCompatibleChatClient } from './openai-client';
import { InMemoryProviderProfileStore } from './profile-store';
import { ProviderRegistry, type ProviderConfiguration } from './registry';
import { InMemorySecretStore } from './secret-store';
import type { ModelProviderSecretName } from './secret-store';

const CANARY = 'sk-canary-registry-0001';

const OPENAI: ProviderConfiguration = {
  adapter: 'openai_compatible',
  auth_mode: 'bearer',
  base_url: 'https://api.openai.com/v1',
  display_name: 'OpenAI',
  model: 'gpt-5.2',
  provider_id: 'openai',
};

const ANTHROPIC: ProviderConfiguration = {
  adapter: 'anthropic',
  auth_mode: 'x_api_key',
  base_url: 'https://api.anthropic.com',
  display_name: 'Anthropic',
  model: 'claude-sonnet-5',
  provider_id: 'anthropic',
};

let secrets: InMemorySecretStore<ModelProviderSecretName>;
let profiles: InMemoryProviderProfileStore;
let clock: number;

const registry = () =>
  new ProviderRegistry({
    now: () => new Date(clock),
    profileStore: profiles,
    secretStore: secrets,
  });

beforeEach(() => {
  secrets = new InMemorySecretStore<ModelProviderSecretName>();
  profiles = new InMemoryProviderProfileStore();
  clock = Date.parse('2026-08-05T00:00:00.000Z');
});

describe('ProviderRegistry.configure', () => {
  it('persists the profile and the secret in their separate stores', async () => {
    const status = await registry().configure(OPENAI, CANARY);
    expect(status).toMatchObject({
      enabled: true,
      model: 'gpt-5.2',
      provider_id: 'openai',
      secret_configured: true,
    });
    expect(profiles.get('openai')?.model).toBe('gpt-5.2');
    await expect(secrets.get('model-openai-api-key')).resolves.toBe(CANARY);
  });

  it('never puts the secret into the profile store', async () => {
    await registry().configure(OPENAI, CANARY);
    expect(JSON.stringify(profiles.list())).not.toContain(CANARY);
  });

  it('never puts the secret into the returned status', async () => {
    const status = await registry().configure(OPENAI, CANARY);
    expect(JSON.stringify(status)).not.toContain(CANARY);
  });

  it('stamps created_at and updated_at from the injected clock', async () => {
    const status = await registry().configure(OPENAI, CANARY);
    expect(status).toMatchObject({
      created_at: '2026-08-05T00:00:00.000Z',
      updated_at: '2026-08-05T00:00:00.000Z',
    });
  });

  it('preserves created_at but advances updated_at on reconfigure', async () => {
    await registry().configure(OPENAI, CANARY);
    clock = Date.parse('2026-08-06T00:00:00.000Z');
    const status = await registry().configure(
      { ...OPENAI, model: 'gpt-5.3' },
      CANARY,
    );
    expect(status).toMatchObject({
      created_at: '2026-08-05T00:00:00.000Z',
      updated_at: '2026-08-06T00:00:00.000Z',
      model: 'gpt-5.3',
    });
  });

  it('reuses an already-stored secret when none is supplied', async () => {
    await registry().configure(OPENAI, CANARY);
    const status = await registry().configure({ ...OPENAI, model: 'gpt-5.3' });
    expect(status.secret_configured).toBe(true);
    await expect(secrets.get('model-openai-api-key')).resolves.toBe(CANARY);
  });

  it('fails closed when an authenticating provider has no secret at all', async () => {
    await expect(registry().configure(OPENAI)).rejects.toThrowError(
      expect.objectContaining({ code: 'PROVIDER_SECRET_MISSING' }),
    );
  });

  it('does not persist a profile it had to reject for a missing secret', async () => {
    await expect(registry().configure(OPENAI)).rejects.toThrow();
    expect(profiles.get('openai')).toBeUndefined();
  });

  it('rejects an empty secret rather than storing it', async () => {
    await expect(registry().configure(OPENAI, '')).rejects.toThrowError(
      expect.objectContaining({ code: 'PROVIDER_SECRET_EMPTY' }),
    );
    await expect(secrets.has('model-openai-api-key')).resolves.toBe(false);
  });

  it('refuses a secret for an unauthenticated provider', async () => {
    await expect(
      registry().configure(
        { ...OPENAI, auth_mode: 'none', base_url: 'http://localhost:11434/v1' },
        CANARY,
      ),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'PROVIDER_SECRET_NOT_ALLOWED' }),
    );
  });

  it('clears any stale secret when a provider becomes unauthenticated', async () => {
    await registry().configure(OPENAI, CANARY);
    const status = await registry().configure({
      ...OPENAI,
      auth_mode: 'none',
      base_url: 'http://localhost:11434/v1',
    });
    expect(status.secret_configured).toBe(false);
    await expect(secrets.has('model-openai-api-key')).resolves.toBe(false);
  });

  it('propagates profile validation failures', async () => {
    await expect(
      registry().configure({ ...OPENAI, base_url: 'http://evil.example.com' }, CANARY),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'PROVIDER_URL_INVALID' }),
    );
  });

  it('keeps only one provider enabled across configures', async () => {
    const subject = registry();
    await subject.configure(OPENAI, CANARY);
    await subject.configure(ANTHROPIC, 'sk-ant-canary');
    const statuses = await subject.list();
    expect(statuses.filter((entry) => entry.enabled)).toHaveLength(1);
    expect(statuses.find((entry) => entry.enabled)?.provider_id).toBe(
      'anthropic',
    );
  });

  it('honours an explicit enabled:false without displacing the default', async () => {
    const subject = registry();
    await subject.configure(OPENAI, CANARY);
    await subject.configure({ ...ANTHROPIC, enabled: false }, 'sk-ant-canary');
    expect((await subject.get('openai'))?.enabled).toBe(true);
    expect((await subject.get('anthropic'))?.enabled).toBe(false);
  });
});

describe('ProviderRegistry.resolveDefaultModelProvider', () => {
  it('returns undefined when nothing is configured', async () => {
    await expect(
      registry().resolveDefaultModelProvider(),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when every profile is disabled', async () => {
    const subject = registry();
    await subject.configure({ ...OPENAI, enabled: false }, CANARY);
    await expect(subject.resolveDefaultModelProvider()).resolves.toBeUndefined();
  });

  it('builds an OpenAI-compatible client for the openai_compatible adapter', async () => {
    const subject = registry();
    await subject.configure(OPENAI, CANARY);
    const client = await subject.resolveDefaultModelProvider();
    expect(client).toBeInstanceOf(OpenAiCompatibleChatClient);
    expect(client?.model).toBe('gpt-5.2');
  });

  it('builds an Anthropic client for the anthropic adapter', async () => {
    const subject = registry();
    await subject.configure(ANTHROPIC, 'sk-ant-canary');
    const client = await subject.resolveDefaultModelProvider();
    expect(client).toBeInstanceOf(AnthropicMessagesClient);
    expect(client?.model).toBe('claude-sonnet-5');
  });

  it('flags remote data transfer for a non-loopback provider', async () => {
    const subject = registry();
    await subject.configure(OPENAI, CANARY);
    expect((await subject.resolveDefaultModelProvider())?.remoteDataTransfer).toBe(
      true,
    );
  });

  it('clears the remote-data-transfer flag for a loopback provider', async () => {
    const subject = registry();
    await subject.configure({
      ...OPENAI,
      auth_mode: 'none',
      base_url: 'http://localhost:11434/v1',
    });
    expect((await subject.resolveDefaultModelProvider())?.remoteDataTransfer).toBe(
      false,
    );
  });

  it('throws rather than returning a degraded client when the secret vanished', async () => {
    const subject = registry();
    await subject.configure(OPENAI, CANARY);
    await secrets.delete('model-openai-api-key');
    await expect(subject.resolveDefaultModelProvider()).rejects.toThrowError(
      expect.objectContaining({ code: 'PROVIDER_SECRET_MISSING' }),
    );
  });
});

describe('ProviderRegistry lifecycle', () => {
  it('switches the default provider', async () => {
    const subject = registry();
    await subject.configure(OPENAI, CANARY);
    await subject.configure(ANTHROPIC, 'sk-ant-canary');
    const status = await subject.setDefaultModelProvider('openai');
    expect(status.provider_id).toBe('openai');
    expect((await subject.resolveDefaultModelProvider())?.model).toBe('gpt-5.2');
  });

  it('fails closed when switching to an unconfigured provider', async () => {
    await expect(
      registry().setDefaultModelProvider('custom'),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED' }),
    );
  });

  it('deletes the profile and its secret together', async () => {
    const subject = registry();
    await subject.configure(OPENAI, CANARY);
    await expect(subject.delete('openai')).resolves.toBe(true);
    expect(profiles.get('openai')).toBeUndefined();
    await expect(secrets.has('model-openai-api-key')).resolves.toBe(false);
  });

  it('reports false when deleting a provider that was never configured', async () => {
    await expect(registry().delete('custom')).resolves.toBe(false);
  });

  it('reports secret_configured per provider', async () => {
    const subject = registry();
    await subject.configure(OPENAI, CANARY);
    await subject.configure({ ...ANTHROPIC, enabled: false }, 'sk-ant-canary');
    await secrets.delete('model-anthropic-api-key');
    const statuses = await subject.list();
    expect(
      statuses.map((entry) => [entry.provider_id, entry.secret_configured]),
    ).toEqual([
      ['anthropic', false],
      ['openai', true],
    ]);
  });

  it('returns undefined for an unconfigured provider', async () => {
    await expect(registry().get('custom')).resolves.toBeUndefined();
  });
});
