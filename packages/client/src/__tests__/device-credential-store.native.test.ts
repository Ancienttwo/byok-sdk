import { describe, expect, it } from 'vitest';
import { DeviceCredentialStore } from '../daemon/device-credential-store';

const nativeWindowsSmoke =
  process.platform === 'win32' && process.env.BYOK_NATIVE_WINDOWS_CREDENTIAL_SMOKE === '1';

const record = {
  deviceId: 'device-native-windows-ci',
  tenantId: 'tenant-native-windows-ci',
  devicePublicKey: 'fixture-public-key',
  accessToken: 'fixture-access-token',
  expiresAt: '2030-01-01T00:00:00.000Z',
  devicePrivateKeyPem: 'fixture-private-key',
} as const;

describe.skipIf(!nativeWindowsSmoke)('Windows Credential Manager native smoke', () => {
  it('round-trips a unique enrollment through fresh provider processes', async () => {
    const productId = `windows-credential-native-ci-${process.pid}-${Date.now()}`;
    const writer = new DeviceCredentialStore({ productId });
    let replaced = false;

    try {
      await expect(writer.read()).resolves.toBeUndefined();
      await writer.replace(record);
      replaced = true;

      const reader = new DeviceCredentialStore({ productId });
      await expect(reader.read()).resolves.toEqual(record);
      await expect(reader.clear()).resolves.toBe(true);
      replaced = false;

      const verifier = new DeviceCredentialStore({ productId });
      await expect(verifier.read()).resolves.toBeUndefined();
    } finally {
      if (replaced) await writer.clear().catch(() => {});
    }
  });
});
