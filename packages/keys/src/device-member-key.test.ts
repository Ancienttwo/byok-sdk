import {
  deriveMemberId,
  generateScopeKey,
  openScopeKeyPackage,
  sealScopeKeyPackage,
  signMemberChainEntry,
  verifyMemberChainEntry,
} from '@byok-sdk/core/sealed-payload';
import { describe, expect, it } from 'vitest';

import {
  DEVICE_MEMBER_KEM_SECRET_NAME,
  DEVICE_MEMBER_SIGNING_SECRET_NAME,
  DeviceMemberKeyStore,
} from './device-member-key';
import { DEVICE_SEALING_SECRET_NAME, DeviceSealingKeyStore } from './device-sealing-key';
import { InMemorySecretStore } from './secret-store';
import { assertSecretName } from './secret-name';

const ENROLLMENT = { tenantId: 'tenant-1', deviceId: 'device-1' };

async function storedJson(secrets: InMemorySecretStore, name: string): Promise<{ jwk: { d: string }; epoch?: number }> {
  return JSON.parse((await secrets.get(name))!);
}

describe('DeviceMemberKeyStore', () => {
  it('uses two secret names the shared rule accepts, apart from the provider sealing key (D12)', () => {
    expect(DEVICE_MEMBER_SIGNING_SECRET_NAME).toBe('device-member-signing-p256-v1');
    expect(DEVICE_MEMBER_KEM_SECRET_NAME).toBe('device-member-kem-p256-v1');
    for (const name of [DEVICE_MEMBER_SIGNING_SECRET_NAME, DEVICE_MEMBER_KEM_SECRET_NAME]) {
      expect(assertSecretName(name)).toBe(name);
      expect(name).not.toBe(DEVICE_SEALING_SECRET_NAME);
    }
  });

  it('creates once, persists in the credential store, and loads the same keys afterwards', async () => {
    const secrets = new InMemorySecretStore();
    const created = await new DeviceMemberKeyStore({ secretStore: secrets }).loadOrCreate(ENROLLMENT);
    expect(created.memberId).toBe(await deriveMemberId(created.signing.publicJwk));
    expect(created.enrollment).toEqual(ENROLLMENT);
    expect(created.kem.epoch).toBe(1);
    expect(created.signing.privateKey.extractable).toBe(false);
    expect(created.kem.privateKey.extractable).toBe(false);
    expect(Object.keys(created.signing.publicJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(created.kem.publicJwk).not.toEqual(created.signing.publicJwk);
    const signing = await secrets.get(DEVICE_MEMBER_SIGNING_SECRET_NAME);
    const kem = await secrets.get(DEVICE_MEMBER_KEM_SECRET_NAME);
    for (const stored of [signing, kem]) {
      expect(stored).toBeDefined();
      expect(stored).not.toMatch(/[\r\n]/u);
    }

    const loaded = await new DeviceMemberKeyStore({ secretStore: secrets }).loadOrCreate(ENROLLMENT);
    expect(loaded.memberId).toBe(created.memberId);
    expect(loaded.kem.publicJwk).toEqual(created.kem.publicJwk);
    expect(loaded.kem.epoch).toBe(1);
    await expect(secrets.get(DEVICE_MEMBER_SIGNING_SECRET_NAME)).resolves.toBe(signing);
    await expect(secrets.get(DEVICE_MEMBER_KEM_SECRET_NAME)).resolves.toBe(kem);
  });

  it('does not touch the provider sealing key entry', async () => {
    const secrets = new InMemorySecretStore();
    const sealing = await new DeviceSealingKeyStore({ secretStore: secrets }).loadOrCreate(ENROLLMENT);
    const before = await secrets.get(DEVICE_SEALING_SECRET_NAME);
    const member = await new DeviceMemberKeyStore({ secretStore: secrets }).loadOrCreate(ENROLLMENT);
    await new DeviceMemberKeyStore({ secretStore: secrets }).rotateKem(ENROLLMENT);
    await expect(secrets.get(DEVICE_SEALING_SECRET_NAME)).resolves.toBe(before);
    expect(member.kem.publicJwk).not.toEqual(sealing.publicJwk);
  });

  it('signs member chain entries and opens scope key packages sealed to it', async () => {
    const device = await new DeviceMemberKeyStore({ secretStore: new InMemorySecretStore() }).loadOrCreate(ENROLLMENT);
    const entry = await signMemberChainEntry(
      { v: 1, tenantId: 'tenant-1', seq: 1, prev: null, op: 'add', subject: { member: device.memberId }, signer: device.memberId },
      device.signing,
    );
    await expect(verifyMemberChainEntry(entry, device.signing.publicJwk)).resolves.toMatchObject({ ok: true });

    const sender = await new DeviceMemberKeyStore({ secretStore: new InMemorySecretStore() }).loadOrCreate({
      tenantId: 'tenant-1',
      deviceId: 'device-2',
    });
    const scopeKey = generateScopeKey();
    const pkg = await sealScopeKeyPackage({
      scopeKey,
      tenantId: 'tenant-1',
      scopeId: 'scope-1',
      epoch: 1,
      recipient: { memberId: device.memberId, kemPublicJwk: device.kem.publicJwk },
      sender: { signingPublicJwk: sender.signing.publicJwk, signingPrivateKey: sender.signing.privateKey },
    });
    const opened = await openScopeKeyPackage({
      package: pkg,
      expected: { tenantId: 'tenant-1', scopeId: 'scope-1', epoch: 1 },
      recipient: { memberId: device.memberId, kemPublicJwk: device.kem.publicJwk, kemPrivateKey: device.kem.privateKey },
      senderSigningPublicJwk: sender.signing.publicJwk,
    });
    expect(opened).toMatchObject({ ok: true });
    expect(opened.ok && Array.from(opened.scopeKey)).toEqual(Array.from(scopeKey));
  });

  it('rotateKem replaces only the KEM key, advances its epoch, and keeps the member id (§7.5)', async () => {
    const secrets = new InMemorySecretStore();
    const store = new DeviceMemberKeyStore({ secretStore: secrets });
    const first = await store.loadOrCreate(ENROLLMENT);
    const signingBefore = await secrets.get(DEVICE_MEMBER_SIGNING_SECRET_NAME);
    const kemBefore = await storedJson(secrets, DEVICE_MEMBER_KEM_SECRET_NAME);

    const rotated = await store.rotateKem(ENROLLMENT);
    expect(rotated.memberId).toBe(first.memberId);
    expect(rotated.kem.epoch).toBe(2);
    expect(rotated.kem.publicJwk).not.toEqual(first.kem.publicJwk);
    await expect(secrets.get(DEVICE_MEMBER_SIGNING_SECRET_NAME)).resolves.toBe(signingBefore);
    expect(await secrets.get(DEVICE_MEMBER_KEM_SECRET_NAME)).not.toContain(kemBefore.jwk.d);

    const reloaded = await new DeviceMemberKeyStore({ secretStore: secrets }).loadOrCreate(ENROLLMENT);
    expect(reloaded.kem.epoch).toBe(2);
    expect(reloaded.kem.publicJwk).toEqual(rotated.kem.publicJwk);
  });

  it('makes a new member for a new enrollment: new signing key, new KEM key at epoch 1', async () => {
    const secrets = new InMemorySecretStore();
    const store = new DeviceMemberKeyStore({ secretStore: secrets });
    const first = await store.loadOrCreate(ENROLLMENT);
    await store.rotateKem(ENROLLMENT);

    const repaired = await store.loadOrCreate({ tenantId: 'tenant-1', deviceId: 'device-2' });
    expect(repaired.memberId).not.toBe(first.memberId);
    expect(repaired.enrollment).toEqual({ tenantId: 'tenant-1', deviceId: 'device-2' });
    expect(repaired.kem.epoch).toBe(1);
    expect(repaired.kem.publicJwk).not.toEqual(first.kem.publicJwk);

    const rotatedForNew = await new DeviceMemberKeyStore({ secretStore: secrets }).rotateKem({ tenantId: 'tenant-2', deviceId: 'device-3' });
    expect(rotatedForNew.kem.epoch).toBe(1);
    expect(rotatedForNew.memberId).not.toBe(repaired.memberId);
  });

  it('never gives a new signing key an existing KEM key', async () => {
    const secrets = new InMemorySecretStore();
    const store = new DeviceMemberKeyStore({ secretStore: secrets });
    const first = await store.loadOrCreate(ENROLLMENT);
    await secrets.delete(DEVICE_MEMBER_SIGNING_SECRET_NAME);
    const next = await store.loadOrCreate(ENROLLMENT);
    expect(next.memberId).not.toBe(first.memberId);
    expect(next.kem.publicJwk).not.toEqual(first.kem.publicJwk);
    expect(next.kem.epoch).toBe(1);
  });

  it('creates a missing KEM key for an existing member at epoch 1', async () => {
    const secrets = new InMemorySecretStore();
    const store = new DeviceMemberKeyStore({ secretStore: secrets });
    const first = await store.loadOrCreate(ENROLLMENT);
    await secrets.delete(DEVICE_MEMBER_KEM_SECRET_NAME);
    const next = await store.loadOrCreate(ENROLLMENT);
    expect(next.memberId).toBe(first.memberId);
    expect(next.kem.epoch).toBe(1);
    expect(next.kem.publicJwk).not.toEqual(first.kem.publicJwk);
  });

  it('fails closed on a malformed stored record and never regenerates it', async () => {
    const malformed = [
      'not json',
      JSON.stringify({ v: 1 }),
      JSON.stringify({ v: 2, tenantId: 'tenant-1', deviceId: 'device-1', epoch: 1, jwk: {} }),
    ];
    for (const name of [DEVICE_MEMBER_SIGNING_SECRET_NAME, DEVICE_MEMBER_KEM_SECRET_NAME]) {
      for (const bad of malformed) {
        const secrets = new InMemorySecretStore();
        const store = new DeviceMemberKeyStore({ secretStore: secrets });
        await store.loadOrCreate(ENROLLMENT);
        await secrets.set(name, bad);
        await expect(store.loadOrCreate(ENROLLMENT)).rejects.toMatchObject({ code: 'DEVICE_MEMBER_KEY_INVALID' });
        await expect(store.rotateKem(ENROLLMENT)).rejects.toMatchObject({ code: 'DEVICE_MEMBER_KEY_INVALID' });
        await expect(secrets.get(name)).resolves.toBe(bad);
      }
    }
  });

  it('fails closed when a private scalar does not belong to the stored public point', async () => {
    for (const name of [DEVICE_MEMBER_SIGNING_SECRET_NAME, DEVICE_MEMBER_KEM_SECRET_NAME]) {
      const secrets = new InMemorySecretStore();
      const store = new DeviceMemberKeyStore({ secretStore: secrets });
      await store.loadOrCreate(ENROLLMENT);
      const other = new InMemorySecretStore();
      await new DeviceMemberKeyStore({ secretStore: other }).loadOrCreate(ENROLLMENT);
      const record = await storedJson(secrets, name);
      const otherRecord = await storedJson(other, name);
      const mixed = JSON.stringify({ ...record, jwk: { ...record.jwk, d: otherRecord.jwk.d } });
      await secrets.set(name, mixed);
      await expect(store.loadOrCreate(ENROLLMENT)).rejects.toMatchObject({ code: 'DEVICE_MEMBER_KEY_INVALID' });
      await expect(secrets.get(name)).resolves.toBe(mixed);
    }
  });
});
