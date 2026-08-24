import { DeviceStore, type DeviceRecord } from '../../daemon/store';

/**
 * Test-only enrollment setup. It mirrors production authority deliberately:
 * the in-memory credential double receives the complete enrollment record and
 * `device.json` receives only its deterministic metadata projection.
 */
export async function seedDeviceEnrollment(store: DeviceStore, record: DeviceRecord): Promise<void> {
  await store.credentials.replace(record);
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
