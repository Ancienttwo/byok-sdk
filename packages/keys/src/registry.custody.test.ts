import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROVIDER_CUSTODY_RECEIPT_LIMIT } from './custody';
import { PI_MODEL_FIXTURE } from './fixtures/pi-model-config';
import {
  assertProviderCustodyIdle,
  readProviderCustodySnapshot,
} from './pi-provider-launcher-core';
import { InMemoryProviderProfileStore } from './profile-store';
import { ProviderRegistry, type ProviderConfiguration } from './registry';
import { InMemorySecretStore, modelProviderSecretName } from './secret-store';
import { SqliteProviderProfileStore, providerConfigurationLockPath } from './sqlite-profile-store';
import { isSqliteAvailable } from './sqlite-support';

const OLD_KEY = 'sk-registry-custody-old-0a1f';
const NEW_KEY = 'sk-registry-custody-new-9b2e';

const OPENAI: ProviderConfiguration = {
  adapter: 'openai_compatible',
  auth_mode: 'bearer',
  base_url: 'https://api.openai.com/v1',
  capabilities: [],
  display_name: 'OpenAI',
  model: 'gpt-5.2',
  pi_model: PI_MODEL_FIXTURE,
  profile_ref: 'openai',
  provider_kind: 'openai',
};

let directory: string;
let dbPath: string;
let profiles: SqliteProviderProfileStore;
let secrets: InMemorySecretStore;
let clock: number;

const registry = () => new ProviderRegistry({ now: () => new Date(clock), profileStore: profiles, secretStore: secrets });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'byok-keys-custody-'));
  dbPath = join(directory, 'provider-profile.sqlite');
  profiles = new SqliteProviderProfileStore({ path: dbPath });
  secrets = new InMemorySecretStore();
  clock = Date.parse('2026-09-28T05:00:00.000Z');
});

afterEach(async () => {
  await profiles.close();
  rmSync(directory, { force: true, recursive: true });
});

describe.skipIf(!isSqliteAvailable())('ProviderRegistry.replaceSecret golden (D4)', () => {
  it('writes only the credential store: profile bytes, revision and hash are unchanged', async () => {
    const configured = await registry().configure(OPENAI, OLD_KEY);
    const profileBefore = await profiles.get('openai');
    clock += 60_000;
    const replaced = await registry().replaceSecret('openai', NEW_KEY);

    expect(replaced.profile_revision).toBe(configured.profile_revision);
    expect(replaced.profile_hash).toBe(configured.profile_hash);
    expect(replaced.updated_at).toBe(configured.updated_at);
    expect(replaced).toEqual({ ...configured, secret_configured: true, configuration_pending: false });
    expect(await profiles.get('openai')).toEqual(profileBefore);
    await expect(secrets.get(modelProviderSecretName('openai'))).resolves.toBe(NEW_KEY);

    const statusText = JSON.stringify({ replaced, list: await registry().list() });
    expect(statusText).not.toContain(OLD_KEY);
    expect(statusText).not.toContain(NEW_KEY);
    await profiles.close();
    for (const suffix of ['', '-wal']) {
      try {
        const bytes = readFileSync(`${dbPath}${suffix}`);
        expect(bytes.includes(Buffer.from(NEW_KEY))).toBe(false);
        expect(bytes.includes(Buffer.from(OLD_KEY))).toBe(false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    profiles = new SqliteProviderProfileStore({ path: dbPath });
  });

  it('requires an existing authenticating profile and a non-empty secret', async () => {
    await expect(registry().replaceSecret('openai', NEW_KEY)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    await registry().configure({ ...OPENAI, profile_ref: 'local', provider_kind: 'custom', auth_mode: 'none', base_url: 'http://127.0.0.1:11434/v1' });
    await expect(registry().replaceSecret('local', NEW_KEY)).rejects.toMatchObject({ code: 'PROVIDER_SECRET_NOT_ALLOWED' });
    await registry().configure(OPENAI, OLD_KEY);
    await expect(registry().replaceSecret('openai', '')).rejects.toMatchObject({ code: 'PROVIDER_SECRET_EMPTY' });
    await expect(secrets.get(modelProviderSecretName('openai'))).resolves.toBe(OLD_KEY);
  });
});

describe.skipIf(!isSqliteAvailable())('registry custody (A4, A8)', () => {
  it('every writer leaves no pending marker behind on success', async () => {
    await registry().configure(OPENAI, OLD_KEY);
    await registry().replaceSecret('openai', NEW_KEY);
    await registry().setDefaultModelProvider('openai');
    await expect(profiles.getPending('openai')).resolves.toBeUndefined();
    await expect(registry().get('openai')).resolves.toMatchObject({ configuration_pending: false });
  });

  it('an interrupted change blocks readers and secret-less writers until a key is supplied', async () => {
    await registry().configure(OPENAI, OLD_KEY);
    await profiles.markPending({ profileRef: 'openai', operation: 'configure', requestId: null, requestDigest: null, operationGeneration: null, since: '2026-09-28T05:00:00.000Z' });

    await expect(registry().get('openai')).resolves.toMatchObject({ configuration_pending: true });
    await expect(registry().resolveDefaultModelProvider()).rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION_PENDING' });
    await expect(registry().configure({ ...OPENAI, model: 'gpt-5.2-mini' })).rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION_PENDING' });

    await registry().configure(OPENAI, NEW_KEY);
    await expect(profiles.getPending('openai')).resolves.toBeUndefined();
    await expect(registry().resolveDefaultModelProvider()).resolves.toBeDefined();
  });

  it('remove goes through the same pending path and keeps the watermark tombstone', async () => {
    await registry().configure(OPENAI, OLD_KEY);
    await profiles.commitCustody({
      profileRef: 'openai',
      mutation: { kind: 'none' },
      clearPending: false,
      receipt: {
        requestId: 'req-7', profileRef: 'openai', operationGeneration: 7, requestDigest: `sha256:${'1'.repeat(64)}`,
        result: {
          requestId: 'req-7', requestDigest: `sha256:${'1'.repeat(64)}`, operation: 'replace_secret', operationGeneration: 7, outcome: 'applied', code: null,
          profileRef: 'openai', binding: null, secretConfigured: true, keyCheck: 'not_run',
        },
      },
    });
    const markSpy = vi.spyOn(profiles, 'markPending');
    await expect(registry().delete('openai')).resolves.toBe(true);
    expect(markSpy).toHaveBeenCalledWith(expect.objectContaining({ operation: 'delete' }));
    await expect(profiles.get('openai')).resolves.toBeUndefined();
    await expect(profiles.getPending('openai')).resolves.toBeUndefined();
    await expect(secrets.has(modelProviderSecretName('openai'))).resolves.toBe(false);
    await expect(profiles.getOperationWatermark('openai')).resolves.toBe(7);
  });

  it('retains at most the receipt limit, evicting oldest first, while the watermark only rises', async () => {
    for (let generation = 1; generation <= PROVIDER_CUSTODY_RECEIPT_LIMIT + 3; generation += 1) {
      await profiles.commitCustody({
        profileRef: 'openai',
        mutation: { kind: 'none' },
        clearPending: false,
        receipt: {
          requestId: `req-${generation}`, profileRef: 'openai', operationGeneration: generation, requestDigest: `sha256:${'2'.repeat(64)}`,
          result: {
            requestId: `req-${generation}`, requestDigest: `sha256:${'2'.repeat(64)}`, operation: 'delete', operationGeneration: generation, outcome: 'applied', code: null,
            profileRef: 'openai', binding: null, secretConfigured: false, keyCheck: 'not_run',
          },
        },
      });
    }
    await expect(profiles.getReceipt('req-3')).resolves.toBeUndefined();
    await expect(profiles.getReceipt('req-4')).resolves.toBeDefined();
    await expect(profiles.getOperationWatermark('openai')).resolves.toBe(PROVIDER_CUSTODY_RECEIPT_LIMIT + 3);
  });

  it('creates an owner-only lock file and a read-only store refuses a database without custody tables', async () => {
    expect(statSync(providerConfigurationLockPath(dbPath)).mode & 0o777).toBe(0o600);
    const { DatabaseSync } = await import('node:sqlite');
    const legacyPath = join(directory, 'legacy.sqlite');
    new DatabaseSync(legacyPath).close();
    expect(() => new SqliteProviderProfileStore({ path: legacyPath, readOnly: true }))
      .toThrow(expect.objectContaining({ code: 'PROVIDER_STORE_SCHEMA_STALE' }));
  });
});

describe('launcher custody snapshot (A4)', () => {
  async function setup() {
    const store = new InMemoryProviderProfileStore();
    const keys = new InMemorySecretStore();
    const subject = new ProviderRegistry({ profileStore: store, secretStore: keys, now: () => new Date('2026-09-28T05:00:00.000Z') });
    await subject.configure(OPENAI, OLD_KEY);
    return { store, keys, subject, profile: (await store.get('openai'))! };
  }

  it('reads the key only for the exact profile it projected, with no pending marker', async () => {
    const { store, keys, profile } = await setup();
    await expect(readProviderCustodySnapshot({ profiles: store, profile, createSecretStore: () => keys })).resolves.toBe(OLD_KEY);
    await expect(assertProviderCustodyIdle({ profiles: store, profile })).resolves.toBeUndefined();
  });

  it('refuses while pending, after the profile changed, and after it was removed', async () => {
    const { store, keys, subject, profile } = await setup();
    await store.markPending({ profileRef: 'openai', operation: 'configure', requestId: 'r', requestDigest: `sha256:${'3'.repeat(64)}`, operationGeneration: 2, since: '2026-09-28T05:00:00.000Z' });
    await expect(readProviderCustodySnapshot({ profiles: store, profile, createSecretStore: () => keys })).rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION_PENDING' });
    await expect(assertProviderCustodyIdle({ profiles: store, profile })).rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION_PENDING' });

    await subject.configure({ ...OPENAI, model: 'gpt-5.2-mini' }, NEW_KEY);
    await expect(readProviderCustodySnapshot({ profiles: store, profile, createSecretStore: () => keys })).rejects.toMatchObject({ code: 'PROVIDER_PROFILE_CONFLICT' });
    await subject.delete('openai');
    await expect(readProviderCustodySnapshot({ profiles: store, profile, createSecretStore: () => keys })).rejects.toMatchObject({ code: 'PROVIDER_PROFILE_CONFLICT' });
  });

  it('a concurrent credential change waits for the reader, so the pair stays consistent', async () => {
    const { store, keys, subject, profile } = await setup();
    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const slowKeys = Object.assign(Object.create(keys) as InMemorySecretStore, {
      get: async (name: Parameters<InMemorySecretStore['get']>[0]) => { await gate; return keys.get(name); },
      available: () => keys.available(),
    });
    const read = readProviderCustodySnapshot({ profiles: store, profile, createSecretStore: () => slowKeys });
    const write = subject.configure({ ...OPENAI, provider_kind: 'openrouter', base_url: 'https://openrouter.ai/api/v1' }, NEW_KEY);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(keys.get(modelProviderSecretName('openai'))).resolves.toBe(OLD_KEY);
    releaseRead();
    await expect(read).resolves.toBe(OLD_KEY);
    await write;
    await expect(keys.get(modelProviderSecretName('openai'))).resolves.toBe(NEW_KEY);
  });
});
