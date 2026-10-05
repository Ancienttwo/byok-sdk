import { createHash } from 'node:crypto';
import { InMemoryTruthStore, contentHash, tenantId } from '@byok-sdk/core';
import { describe, expect, it, vi } from 'vitest';
import { parseModelProviderProfile } from './provider-profile';
import { ProviderRegistry } from './registry';
import { InMemorySecretStore, modelProviderSecretName } from './secret-store';
import { MAX_PROVIDER_PROFILES, PROVIDER_PROFILE_TRUTH_RECORD_KEY, TruthStoreProviderProfileStore } from './truth-profile-store';

const tenant = tenantId('profile-bound-fixture');
const now = () => new Date('2026-10-05T00:00:00.000Z');
const profile = (index: number, enabled = false) => parseModelProviderProfile({
  adapter: 'openai_compatible', auth_mode: 'bearer', base_url: 'https://provider.example/v1',
  capabilities: [], created_at: now().toISOString(), updated_at: now().toISOString(),
  display_name: `Fixture ${index}`, enabled, kind: 'model', model: 'fixture',
  profile_ref: `fixture-${String(index).padStart(2, '0')}`, provider_kind: 'custom',
});
const key = { kind: 'profile' as const, recordKey: PROVIDER_PROFILE_TRUTH_RECORD_KEY };
async function seeded() {
  const truth = new InMemoryTruthStore({ now });
  const store = new TruthStoreProviderProfileStore({ tenant, truthStore: truth });
  for (let i = 0; i < MAX_PROVIDER_PROFILES; i++) await store.save(profile(i, i === 0));
  return { truth, store, write: vi.spyOn(truth, 'writeSnapshot') };
}

describe('TruthStore profile registry count admission', () => {
  it.each([false, true])('rejects a 33rd profile before any write (enabled=%s) and stays usable', async enabled => {
    const { truth, store, write } = await seeded();
    const before = await truth.getRecord(tenant, key);
    await expect(store.save(profile(MAX_PROVIDER_PROFILES, enabled))).rejects.toMatchObject({ code: 'PROVIDER_TRUTH_INVALID' });
    expect(write).not.toHaveBeenCalled();
    expect(await truth.getRecord(tenant, key)).toEqual(before);
    const reopened = new TruthStoreProviderProfileStore({ tenant, truthStore: truth });
    expect(await reopened.list()).toHaveLength(MAX_PROVIDER_PROFILES);
    expect(await reopened.getEnabled()).toEqual(profile(0, true));
    expect(await reopened.get(profile(MAX_PROVIDER_PROFILES).profile_ref)).toBeUndefined();
    for (let i = 0; i < MAX_PROVIDER_PROFILES; i++) expect(await reopened.get(profile(i).profile_ref)).toEqual(profile(i, i === 0));
    const updated = { ...profile(1, true), display_name: 'Updated at capacity' };
    await expect(reopened.save(updated)).resolves.toEqual(updated);
    expect(await reopened.getEnabled()).toEqual(updated);
    expect(await reopened.list()).toHaveLength(MAX_PROVIDER_PROFILES);
    await expect(reopened.delete(profile(2).profile_ref)).resolves.toBe(true);
    await expect(reopened.save(profile(MAX_PROVIDER_PROFILES))).resolves.toEqual(profile(MAX_PROVIDER_PROFILES));
    expect(await reopened.list()).toHaveLength(MAX_PROVIDER_PROFILES);
  });

  it.each([undefined, 'inert-existing-secret'])('registry configure rolls back secret to %s without corrupting profiles', async previousSecret => {
    const { truth, store, write } = await seeded();
    const secrets = new InMemorySecretStore();
    const rejected = profile(MAX_PROVIDER_PROFILES, true);
    const secretName = modelProviderSecretName(rejected.profile_ref);
    if (previousSecret !== undefined) await secrets.set(secretName, previousSecret);
    const existingName = modelProviderSecretName(profile(0).profile_ref);
    await secrets.set(existingName, 'inert-original-secret');
    const registry = new ProviderRegistry({ profileStore: store, secretStore: secrets, now });
    const before = await truth.getRecord(tenant, key);
    await expect(registry.configure(rejected, 'inert-new-secret')).rejects.toMatchObject({ code: 'PROVIDER_TRUTH_INVALID' });
    expect(write).not.toHaveBeenCalled();
    expect(await truth.getRecord(tenant, key)).toEqual(before);
    expect(await secrets.get(secretName)).toBe(previousSecret);
    expect(await secrets.get(existingName)).toBe('inert-original-secret');
    expect(await store.getPending(rejected.profile_ref)).toBeUndefined();
    expect(await registry.list()).toHaveLength(MAX_PROVIDER_PROFILES);
    expect(await store.getEnabled()).toEqual(profile(0, true));
    await registry.configure({ ...profile(0, true), display_name: 'Still usable' }, 'inert-replacement-secret');
    expect(await secrets.get(existingName)).toBe('inert-replacement-secret');
    expect(await store.getPending(profile(0).profile_ref)).toBeUndefined();
    expect(await store.list()).toHaveLength(MAX_PROVIDER_PROFILES);
  });

  it('continues rejecting externally supplied 33-profile snapshots with valid hash and size', async () => {
    const { truth, store, write } = await seeded();
    const before = (await truth.getRecord(tenant, key))!;
    const body = JSON.stringify({ schema_version: 1, profiles: Array.from({ length: MAX_PROVIDER_PROFILES + 1 }, (_, i) => profile(i)) });
    await truth.writeSnapshot(tenant, {
      ...key, expectedRev: before.rev, contentHash: contentHash(`sha256:${createHash('sha256').update(body).digest('hex')}`),
      byteSize: BigInt(new TextEncoder().encode(body).byteLength), body: { kind: 'inline', body }, label: 'Corrupted fixture',
    });
    write.mockClear();
    await expect(store.list()).rejects.toMatchObject({ code: 'PROVIDER_TRUTH_INVALID' });
    await expect(store.delete(profile(0).profile_ref)).rejects.toMatchObject({ code: 'PROVIDER_TRUTH_INVALID' });
    expect(write).not.toHaveBeenCalled();
  });
});
