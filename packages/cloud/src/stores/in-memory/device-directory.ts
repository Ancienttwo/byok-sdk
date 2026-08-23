/**
 * In-memory {@link DeviceDirectory}.
 *
 * Rows live under a `(tenant, deviceId)` composite key, so a cross-tenant read
 * is not "denied" — it addresses a different key space and finds nothing
 * (§12.6.2 layer 3). The pre-tenant index below holds the SAME record objects,
 * so a revocation applied through the composite key is immediately visible to
 * `/byok/challenge` and `/byok/token` with no second copy to keep in sync.
 */
import {
  PRESENCE_LEVELS,
  tenantKey,
  type PresenceStore,
  type TenantId,
  type TenantReadinessDevice,
  type TenantReadiness,
} from '@byok-sdk/core';
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
      proofKeyId: input.proofKeyId,
      proofKeyEpoch: input.proofKeyEpoch,
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

  async recordCapabilities(
    tenant: TenantId,
    input: { readonly deviceId: string; readonly capabilities: readonly string[] },
  ): Promise<DeviceRecord | undefined> {
    const key = tenantKey(tenant, input.deviceId);
    const record = this.#byTenant.get(key);
    if (record === undefined || record.revoked) return undefined;
    const updated: DeviceRecord = {
      ...record,
      capabilities: Object.freeze([...input.capabilities]),
    };
    this.#byTenant.set(key, updated);
    return updated;
  }

  async list(tenant: TenantId): Promise<readonly DeviceRecord[]> {
    const prefix = tenantKey(tenant, '');
    return [...this.#byTenant.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record);
  }

  async readiness(tenant: TenantId, presence: PresenceStore): Promise<TenantReadiness> {
    const devices = await this.list(tenant);
    const livePresence = await presence.list(tenant);
    const presenceByDevice = new Map(livePresence.map((hint) => [hint.deviceId, hint]));
    const activeDeviceIds = new Set(
      devices.filter((device) => !device.revoked).map((device) => device.deviceId),
    );
    const observedPresenceByLevel = Object.fromEntries(
      PRESENCE_LEVELS.map((level) => [level, 0]),
    ) as Record<(typeof PRESENCE_LEVELS)[number], number>;
    for (const hint of livePresence) {
      if (!activeDeviceIds.has(hint.deviceId)) continue;
      observedPresenceByLevel[hint.level] += 1;
    }
    return {
      tenantId: tenant,
      activePairedDeviceCount: devices.filter((device) => !device.revoked).length,
      revokedDeviceCount: devices.filter((device) => device.revoked).length,
      observedPresenceCount: Object.values(observedPresenceByLevel).reduce(
        (total, count) => total + count,
        0,
      ),
      observedPresenceByLevel,
      devices: [...devices]
        .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
        .map((device): TenantReadinessDevice => {
          const hint = device.revoked ? undefined : presenceByDevice.get(device.deviceId);
          return {
            deviceId: device.deviceId,
            productId: device.productId,
            deviceName: device.deviceName,
            revoked: device.revoked,
            ...(hint === undefined
              ? {}
              : {
                  presence: {
                    level: hint.level,
                    ...(hint.detail === undefined ? {} : { detail: hint.detail }),
                    ...(hint.configuredToolsets === undefined
                      ? {}
                      : { configuredToolsets: hint.configuredToolsets }),
                    ...(hint.clientVersion === undefined ? {} : { clientVersion: hint.clientVersion }),
                    ...(hint.protocolVersions === undefined
                      ? {}
                      : { protocolVersions: hint.protocolVersions }),
                    ...(hint.runtimes === undefined ? {} : { runtimes: hint.runtimes }),
                    observedAt: hint.observedAt,
                    expiresAt: hint.expiresAt,
                  },
                }),
          };
        }),
    };
  }

  async resolveByDeviceId(deviceId: string): Promise<DeviceRecord | undefined> {
    const key = this.#byDeviceId.get(deviceId);
    return key === undefined ? undefined : this.#byTenant.get(key);
  }
}
