import {
  deriveSealingKeyId,
  openProviderProvisioningSecret,
  sealProviderProvisioningRequest,
} from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';

import { DEVICE_SEALING_SECRET_NAME, DeviceSealingKeyStore } from './device-sealing-key';
import { InMemorySecretStore } from './secret-store';
import { assertSecretName } from './secret-name';

const ENROLLMENT = { tenantId: 'tenant-1', deviceId: 'device-1' };

describe('DeviceSealingKeyStore', () => {
  it('uses a secret name the shared rule accepts', () => {
    expect(DEVICE_SEALING_SECRET_NAME).toBe('device-sealing-p256-v1');
    expect(assertSecretName(DEVICE_SEALING_SECRET_NAME)).toBe(DEVICE_SEALING_SECRET_NAME);
  });

  it('creates once, persists in the credential store, and loads the same key afterwards', async () => {
    const secrets = new InMemorySecretStore();
    const store = new DeviceSealingKeyStore({ secretStore: secrets });
    const created = await store.loadOrCreate(ENROLLMENT);
    expect(created.epoch).toBe(1);
    expect(created.keyId).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(created.keyId).toBe(await deriveSealingKeyId(created.publicJwk));
    expect(Object.keys(created.publicJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(created.privateKey.extractable).toBe(false);
    const stored = await secrets.get(DEVICE_SEALING_SECRET_NAME);
    expect(stored).toBeDefined();
    expect(stored).not.toMatch(/[\r\n]/u);

    const loaded = await new DeviceSealingKeyStore({ secretStore: secrets }).loadOrCreate(ENROLLMENT);
    expect(loaded.keyId).toBe(created.keyId);
    expect(loaded.epoch).toBe(1);
    await expect(secrets.get(DEVICE_SEALING_SECRET_NAME)).resolves.toBe(stored);
  });

  it('opens what a browser seals to its public key', async () => {
    const key = await new DeviceSealingKeyStore({ secretStore: new InMemorySecretStore() }).loadOrCreate(ENROLLMENT);
    const request = await sealProviderProvisioningRequest({
      header: {
        tenantId: 'tenant-1', deviceId: 'device-1', agentId: 'agent-1', requestId: 'r1', operation: 'replace_secret',
        operationGeneration: 1, expectedProfile: null, expectedEnrollmentRevision: 'e1', expectedPlacementRevision: 'p1', issuedAt: '2026-09-28T00:00:00.000Z', expiresAt: '2026-09-28T00:10:00.000Z',
      },
      config: { operation: 'replace_secret', agentId: 'agent-1', providerKind: 'zai' },
      recipient: { keyId: key.keyId, publicJwk: key.publicJwk },
      secret: 'sk-sealed-to-device',
    });
    await expect(openProviderProvisioningSecret({ request, recipient: key })).resolves.toBe('sk-sealed-to-device');
  });

  it('never reuses a key across enrollments (A1): a new enrollment gets a new key at the next epoch', async () => {
    const secrets = new InMemorySecretStore();
    const store = new DeviceSealingKeyStore({ secretStore: secrets });
    const first = await store.loadOrCreate(ENROLLMENT);
    const repaired = await store.loadOrCreate({ tenantId: 'tenant-1', deviceId: 'device-2' });
    expect(repaired.keyId).not.toBe(first.keyId);
    expect(repaired.epoch).toBe(2);
    expect(repaired.enrollment).toEqual({ tenantId: 'tenant-1', deviceId: 'device-2' });
  });

  it('rotate replaces the private key and advances the epoch', async () => {
    const secrets = new InMemorySecretStore();
    const store = new DeviceSealingKeyStore({ secretStore: secrets });
    const first = await store.loadOrCreate(ENROLLMENT);
    const before = await secrets.get(DEVICE_SEALING_SECRET_NAME);
    const rotated = await store.rotate(ENROLLMENT);
    expect(rotated.keyId).not.toBe(first.keyId);
    expect(rotated.epoch).toBe(2);
    const after = await secrets.get(DEVICE_SEALING_SECRET_NAME);
    expect(after).not.toBe(before);
    expect(after).not.toContain(JSON.parse(before!).jwk.d);
  });

  it('fails closed on a malformed or inconsistent stored key and never regenerates it', async () => {
    for (const bad of [
      'not json',
      JSON.stringify({ v: 1 }),
      JSON.stringify({ v: 2, tenantId: 't', deviceId: 'd', epoch: 1, jwk: {} }),
    ]) {
      const secrets = new InMemorySecretStore();
      await secrets.set(DEVICE_SEALING_SECRET_NAME, bad);
      await expect(new DeviceSealingKeyStore({ secretStore: secrets }).loadOrCreate(ENROLLMENT))
        .rejects.toMatchObject({ code: 'DEVICE_SEALING_KEY_INVALID' });
      await expect(secrets.get(DEVICE_SEALING_SECRET_NAME)).resolves.toBe(bad);
    }

    // A private scalar that does not belong to the stored public point.
    const secrets = new InMemorySecretStore();
    const store = new DeviceSealingKeyStore({ secretStore: secrets });
    await store.loadOrCreate(ENROLLMENT);
    const record = JSON.parse((await secrets.get(DEVICE_SEALING_SECRET_NAME))!);
    const other = new InMemorySecretStore();
    await new DeviceSealingKeyStore({ secretStore: other }).loadOrCreate(ENROLLMENT);
    const otherRecord = JSON.parse((await other.get(DEVICE_SEALING_SECRET_NAME))!);
    const mixed = JSON.stringify({ ...record, jwk: { ...record.jwk, d: otherRecord.jwk.d } });
    await secrets.set(DEVICE_SEALING_SECRET_NAME, mixed);
    await expect(store.loadOrCreate(ENROLLMENT)).rejects.toMatchObject({ code: 'DEVICE_SEALING_KEY_INVALID' });
    await expect(secrets.get(DEVICE_SEALING_SECRET_NAME)).resolves.toBe(mixed);
  });
});
