import { createHash } from 'node:crypto';

import {
  InMemoryTruthStore,
  contentHash,
  tenantId,
  type TruthRecord,
  type TruthStore,
} from '@byok-sdk/core';
import { describe, expect, it, vi } from 'vitest';

import type { ModelProviderId, ModelProviderProfile } from './provider-profile';
import { ProviderRegistry } from './registry';
import { InMemorySecretStore } from './secret-store';
import {
  PROVIDER_PROFILE_TRUTH_RECORD_KEY,
  TruthStoreProviderProfileStore,
} from './truth-profile-store';

const TENANT = tenantId('keys-truth-test');
const OTHER_TENANT = tenantId('keys-truth-other');
const CLOCK = { now: () => new Date('2026-08-17T00:00:00.000Z') };
const CANARY = 'sk-never-enters-truth';

const BASE = {
  adapter: 'openai_compatible',
  auth_mode: 'bearer',
  base_url: 'https://api.openai.com/v1',
  created_at: '2026-08-17T00:00:00.000Z',
  display_name: 'OpenAI',
  enabled: true,
  kind: 'model',
  model: 'gpt-5.2',
  updated_at: '2026-08-17T00:00:00.000Z',
} as const;

function profile(
  provider_id: ModelProviderId,
  overrides: Partial<ModelProviderProfile> = {},
): ModelProviderProfile {
  return { ...BASE, provider_id, ...overrides } as ModelProviderProfile;
}

function store(truthStore: TruthStore, tenant = TENANT) {
  return new TruthStoreProviderProfileStore({ tenant, truthStore });
}

function hash(body: string) {
  return contentHash(
    `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`,
  );
}

function withBody(record: TruthRecord, body: string): TruthRecord {
  return {
    ...record,
    body: { kind: 'inline', body },
    byteSize: BigInt(new TextEncoder().encode(body).byteLength),
    contentHash: hash(body),
  };
}

function staticTruth(record: TruthRecord): TruthStore {
  return {
    getRecord: vi.fn(async () => record),
    listManifest: vi.fn(async () => []),
    writeSnapshot: vi.fn(async () => {
      throw new Error('unexpected write');
    }),
    writeTerminal: vi.fn(async () => {
      throw new Error('unexpected terminal write');
    }),
  };
}

async function validRecord(): Promise<TruthRecord> {
  const truth = new InMemoryTruthStore(CLOCK);
  await store(truth).save(profile('openai'));
  return (await truth.getRecord(TENANT, {
    kind: 'profile',
    recordKey: PROVIDER_PROFILE_TRUTH_RECORD_KEY,
  }))!;
}

describe('TruthStoreProviderProfileStore authority', () => {
  it('writes one deterministic bounded aggregate with correct hash and size', async () => {
    const truth = new InMemoryTruthStore(CLOCK);
    const subject = store(truth);
    await subject.save(profile('openai'));
    await subject.save(
      profile('anthropic', {
        adapter: 'anthropic',
        auth_mode: 'x_api_key',
        base_url: 'https://api.anthropic.com',
        enabled: false,
      }),
    );

    const record = (await truth.getRecord(TENANT, {
      kind: 'profile',
      recordKey: PROVIDER_PROFILE_TRUTH_RECORD_KEY,
    }))!;
    expect(record.rev).toBe(2);
    expect(record.body.kind).toBe('inline');
    const body = record.body.kind === 'inline' ? record.body.body : '';
    expect(JSON.parse(body).profiles.map((entry: { provider_id: string }) => entry.provider_id)).toEqual([
      'anthropic',
      'openai',
    ]);
    expect(record.contentHash).toBe(hash(body));
    expect(record.byteSize).toBe(BigInt(new TextEncoder().encode(body).byteLength));
  });

  it('keeps tenant registries isolated in one shared TruthStore', async () => {
    const truth = new InMemoryTruthStore(CLOCK);
    await store(truth).save(profile('openai'));
    await store(truth, OTHER_TENANT).save(
      profile('deepseek', { base_url: 'https://api.deepseek.com' }),
    );

    expect((await store(truth).list()).map((entry) => entry.provider_id)).toEqual(['openai']);
    expect((await store(truth, OTHER_TENANT).list()).map((entry) => entry.provider_id)).toEqual([
      'deepseek',
    ]);
  });

  it('fails one of two concurrent writers from the same revision without merging', async () => {
    const truth = new InMemoryTruthStore(CLOCK);
    const first = store(truth);
    const second = store(truth);

    const results = await Promise.allSettled([
      first.save(profile('openai')),
      second.save(profile('deepseek', { base_url: 'https://api.deepseek.com' })),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({ code: 'PROVIDER_PROFILE_CONFLICT' }),
    });
    expect(await first.list()).toHaveLength(1);
  });

  it('never writes a configured provider secret into truth', async () => {
    const truth = new InMemoryTruthStore(CLOCK);
    const registry = new ProviderRegistry({
      profileStore: store(truth),
      secretStore: new InMemorySecretStore(),
    });
    await registry.configure(
      {
        adapter: 'openai_compatible',
        auth_mode: 'bearer',
        base_url: 'https://api.openai.com/v1',
        display_name: 'OpenAI',
        model: 'gpt-5.2',
        provider_id: 'openai',
      },
      CANARY,
    );

    const record = (await truth.getRecord(TENANT, {
      kind: 'profile',
      recordKey: PROVIDER_PROFILE_TRUTH_RECORD_KEY,
    }))!;
    expect(record.body.kind).toBe('inline');
    expect(record.body.kind === 'inline' ? record.body.body : '').not.toContain(CANARY);
  });

  it('rejects object bodies, mismatched size, and mismatched hash', async () => {
    const record = await validRecord();
    const cases: TruthRecord[] = [
      { ...record, body: { kind: 'object', hash: record.contentHash } },
      { ...record, byteSize: record.byteSize + 1n },
      { ...record, contentHash: contentHash(`sha256:${'0'.repeat(64)}`) },
    ];
    for (const candidate of cases) {
      await expect(store(staticTruth(candidate)).list()).rejects.toMatchObject({
        code: 'PROVIDER_TRUTH_INVALID',
      });
    }
  });

  it('rejects duplicate providers and secret-shaped fields even with matching hash and size', async () => {
    const record = await validRecord();
    const parsed = JSON.parse(record.body.kind === 'inline' ? record.body.body : '');
    const duplicate = JSON.stringify({
      ...parsed,
      profiles: [parsed.profiles[0], parsed.profiles[0]],
    });
    const secretShaped = JSON.stringify({
      ...parsed,
      profiles: [{ ...parsed.profiles[0], api_key: CANARY }],
    });

    for (const body of [duplicate, secretShaped]) {
      await expect(store(staticTruth(withBody(record, body))).list()).rejects.toMatchObject({
        code: 'PROVIDER_TRUTH_INVALID',
      });
    }
  });

  it('rejects non-canonical JSON and authority returned for another tenant', async () => {
    const record = await validRecord();
    const pretty = JSON.stringify(
      JSON.parse(record.body.kind === 'inline' ? record.body.body : ''),
      null,
      2,
    );
    await expect(store(staticTruth(withBody(record, pretty))).list()).rejects.toMatchObject({
      code: 'PROVIDER_TRUTH_INVALID',
    });
    await expect(
      store(staticTruth({ ...record, tenantId: OTHER_TENANT })).list(),
    ).rejects.toMatchObject({ code: 'PROVIDER_TRUTH_INVALID' });
  });
});
