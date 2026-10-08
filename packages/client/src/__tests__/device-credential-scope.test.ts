import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DeviceStore } from '../daemon/store';

describe('device credential identity', () => {
  it('shares product credentials across metadata directories and isolates other products', async () => {
    vi.stubEnv('BYOK_TEST_DEVICE_CREDENTIAL_STORE', '1');
    const productId = randomUUID();
    const first = new DeviceStore('/unused/first', undefined, productId);
    const second = new DeviceStore('/unused/second', undefined, productId);
    const other = new DeviceStore('/unused/first', undefined, randomUUID());
    const record = { deviceId: 'device', tenantId: 'tenant', devicePublicKey: 'public',
      accessToken: 'token', expiresAt: '2030-01-01T00:00:00.000Z', devicePrivateKeyPem: 'private' };
    try {
      await first.credentials.replace(record);
      expect(await second.credentials.read()).toEqual(record);
      expect(await other.credentials.read()).toBeUndefined();
      await second.credentials.clear();
      expect(await first.credentials.read()).toBeUndefined();
    } finally {
      await first.credentials.clear();
      vi.unstubAllEnvs();
    }
  });
});
