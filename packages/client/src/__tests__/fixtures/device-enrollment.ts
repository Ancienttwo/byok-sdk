import { DeviceStore, type DeviceRecord } from '../../daemon/store';

/**
 * Test-only enrollment setup. It mirrors the production split deliberately:
 * `device.json` receives metadata only, while the in-memory credential double
 * receives the bearer and private key. No test writes an OS credential.
 */
export async function seedDeviceEnrollment(store: DeviceStore, record: DeviceRecord): Promise<void> {
  await store.credentials.replace({
    accessToken: record.accessToken,
    expiresAt: record.expiresAt,
    devicePrivateKeyPem: record.devicePrivateKeyPem,
  });
  await store.save({
    deviceId: record.deviceId,
    tenantId: record.tenantId,
    devicePublicKey: record.devicePublicKey,
  });
}

export async function clearDeviceEnrollment(store: DeviceStore): Promise<void> {
  await store.credentials.clear();
  await store.remove();
}
