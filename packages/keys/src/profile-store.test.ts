import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTruthStore, tenantId } from '@byok-sdk/core';

import { InMemoryProviderProfileStore } from './profile-store';
import type { ProviderProfileStore } from './profile-store';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { isSqliteAvailable } from './sqlite-support';
import { TruthStoreProviderProfileStore } from './truth-profile-store';
import type { ModelProviderId, ModelProviderProfile } from './provider-profile';

// node:sqlite requires Node 22.5+, and shipped behind --experimental-sqlite
// until later in the 22.x line — so "Node >= 22.5" alone doesn't mean the
// module actually loads. Gate on ACTUAL availability (attempts the real
// require — see sqlite-support.ts's isSqliteAvailable), not a version-number
// heuristic, so this correctly skips on any runtime where node:sqlite isn't
// really usable (the CI Node 20 leg, or an intermediate flagged 22.x) and
// still runs on one where it is. Only the Sqlite pass is gated — the InMemory
// pass of this shared contract suite must run on every supported runtime.
const sqliteReady = isSqliteAvailable();

const BASE = {
  adapter: 'openai_compatible',
  auth_mode: 'bearer',
  base_url: 'https://api.openai.com/v1',
  created_at: '2026-08-05T00:00:00.000Z',
  display_name: 'OpenAI',
  enabled: true,
  kind: 'model',
  model: 'gpt-5.2',
  updated_at: '2026-08-05T00:00:00.000Z',
} as const;

const profile = (
  provider_id: ModelProviderId,
  overrides: Partial<ModelProviderProfile> = {},
): ModelProviderProfile =>
  ({ ...BASE, provider_id, ...overrides }) as ModelProviderProfile;

/**
 * Both implementations answer to one contract, so the suite runs twice — the
 * same shape `@byok-sdk/server` uses to keep `InMemoryTaskStore` and
 * `SqliteTaskStore` honest against each other. SQLite runs `:memory:` here;
 * on-disk behaviour (file mode, no plaintext key in the file) is
 * `sqlite-profile-store.test.ts`.
 */
const implementations: ReadonlyArray<{
  factory: () => ProviderProfileStore;
  label: string;
  ready: boolean;
}> = [
  {
    factory: () => new InMemoryProviderProfileStore(),
    label: 'InMemory',
    ready: true,
  },
  {
    factory: () => new SqliteProviderProfileStore({ path: ':memory:' }),
    label: 'Sqlite',
    ready: sqliteReady,
  },
  {
    factory: () =>
      new TruthStoreProviderProfileStore({
        tenant: tenantId('profile-contract-tenant'),
        truthStore: new InMemoryTruthStore({
          now: () => new Date('2026-08-05T00:00:00.000Z'),
        }),
      }),
    label: 'TruthStore',
    ready: true,
  },
];

for (const { factory, label, ready } of implementations) {
  describe.skipIf(!ready)(`${label}ProviderProfileStore`, () => {
    let store: ProviderProfileStore;

    const open = () => {
      store = factory();
      return store;
    };

    afterEach(async () => {
      await store?.close();
    });

    it('returns undefined for an unknown provider', async () => {
      await expect(open().get('openai')).resolves.toBeUndefined();
    });

    it('saves and reads a profile back', async () => {
      const saved = await open().save(profile('openai'));
      expect(saved).toMatchObject({ provider_id: 'openai', model: 'gpt-5.2' });
      await expect(store.get('openai')).resolves.toMatchObject({ provider_id: 'openai' });
    });

    it('lists profiles in a stable provider-id order', async () => {
      open();
      await store.save(profile('openai'));
      await store.save(profile('anthropic', {
        adapter: 'anthropic',
        auth_mode: 'x_api_key',
        base_url: 'https://api.anthropic.com',
        enabled: false,
      }));
      expect((await store.list()).map((entry) => entry.provider_id)).toEqual([
        'anthropic',
        'openai',
      ]);
    });

    it('updates an existing profile rather than duplicating it', async () => {
      open();
      await store.save(profile('openai'));
      await store.save(
        profile('openai', {
          model: 'gpt-5.3',
          updated_at: '2026-08-05T01:00:00.000Z',
        }),
      );
      expect(await store.list()).toHaveLength(1);
      expect((await store.get('openai'))?.model).toBe('gpt-5.3');
    });

    it('validates on save, failing closed on a bad profile', async () => {
      await expect(
        open().save(profile('openai', { base_url: 'http://evil.example.com' })),
      ).rejects.toThrowError(expect.objectContaining({ code: 'PROVIDER_URL_INVALID' }));
    });

    it('keeps at most one enabled model profile', async () => {
      open();
      await store.save(profile('openai'));
      await store.save(profile('deepseek', { base_url: 'https://api.deepseek.com' }));
      expect((await store.get('openai'))?.enabled).toBe(false);
      expect((await store.get('deepseek'))?.enabled).toBe(true);
      expect((await store.list()).filter((entry) => entry.enabled)).toHaveLength(1);
    });

    it('exposes the single enabled profile through getEnabled', async () => {
      open();
      await store.save(profile('openai', { enabled: false }));
      await expect(store.getEnabled()).resolves.toBeUndefined();
      await store.save(profile('deepseek', { base_url: 'https://api.deepseek.com' }));
      expect((await store.getEnabled())?.provider_id).toBe('deepseek');
    });

    it('switches the enabled profile through setEnabled', async () => {
      open();
      await store.save(profile('openai'));
      await store.save(profile('deepseek', { base_url: 'https://api.deepseek.com' }));
      const switched = await store.setEnabled('openai');
      expect(switched.enabled).toBe(true);
      expect((await store.getEnabled())?.provider_id).toBe('openai');
      expect((await store.get('deepseek'))?.enabled).toBe(false);
    });

    it('fails closed when enabling a provider that was never configured', async () => {
      await expect(open().setEnabled('custom')).rejects.toThrowError(
        expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED' }),
      );
    });

    it('deletes a profile and reports whether anything was removed', async () => {
      open();
      await expect(store.delete('openai')).resolves.toBe(false);
      await store.save(profile('openai'));
      await expect(store.delete('openai')).resolves.toBe(true);
      await expect(store.get('openai')).resolves.toBeUndefined();
    });

    it('preserves created_at across an update while updated_at moves', async () => {
      open();
      await store.save(profile('openai'));
      await store.save(
        profile('openai', { updated_at: '2026-08-06T00:00:00.000Z' }),
      );
      await expect(store.get('openai')).resolves.toMatchObject({
        created_at: '2026-08-05T00:00:00.000Z',
        updated_at: '2026-08-06T00:00:00.000Z',
      });
    });

    it('round-trips an anthropic profile with its own adapter and auth mode', async () => {
      const saved = await open().save(
        profile('anthropic', {
          adapter: 'anthropic',
          auth_mode: 'x_api_key',
          base_url: 'https://api.anthropic.com',
        }),
      );
      expect(saved).toMatchObject({
        adapter: 'anthropic',
        auth_mode: 'x_api_key',
      });
    });

    it('never persists a secret-shaped field', async () => {
      open();
      await store.save(profile('openai'));
      const stored = (await store.get('openai')) as Record<string, unknown>;
      expect(Object.keys(stored)).not.toContain('api_key');
      expect(Object.keys(stored)).not.toContain('secret');
    });
  });
}
