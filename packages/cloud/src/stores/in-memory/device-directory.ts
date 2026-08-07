/**
 * In-memory {@link DeviceDirectory}.
 *
 * Rows live under a `(tenant, deviceId)` composite key, so a cross-tenant read
 * is not "denied" — it addresses a different key space and finds nothing
 * (§12.6.2 layer 3). The pre-tenant index below holds the SAME record objects,
 * so a revocation applied through the composite key is immediately visible to
 * `/byok/challenge` and `/byok/token` with no second copy to keep in sync.
 */
import { tenantKey, type TenantId } from '@byok/core';
import type { DeviceDirectory, DeviceRecord, DeviceRegistration } from '../ports';

export class InMemoryDeviceDirectory implements DeviceDirectory {
  readonly #byTenant = new Map<string, DeviceRecord>();
  readonly #byDeviceId = new Map<string, string>();

  async register(tenant: TenantId, input: DeviceRegistration): Promise<DeviceRecord> {
    const record: DeviceRecord = {
      tenantId: tenant,
      productId: input.productId,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      devicePublicKey: input.devicePublicKey,
      revoked: false,
    };
    const key = tenantKey(tenant, record.deviceId);
    this.#byTenant.set(key, record);
    this.#byDeviceId.set(record.deviceId, key);
    return record;
  }

  async get(tenant: TenantId, deviceId: string): Promise<DeviceRecord | undefined> {
    return this.#byTenant.get(tenantKey(tenant, deviceId));
  }

  async revoke(tenant: TenantId, deviceId: string): Promise<void> {
    const key = tenantKey(tenant, deviceId);
    const record = this.#byTenant.get(key);
    if (record === undefined) return;
    this.#byTenant.set(key, { ...record, revoked: true });
  }

  async list(tenant: TenantId): Promise<readonly DeviceRecord[]> {
    const prefix = tenantKey(tenant, '');
    return [...this.#byTenant.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record);
  }

  async resolveByDeviceId(deviceId: string): Promise<DeviceRecord | undefined> {
    const key = this.#byDeviceId.get(deviceId);
    return key === undefined ? undefined : this.#byTenant.get(key);
  }
}
