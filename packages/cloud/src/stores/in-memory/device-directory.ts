/**
 * In-memory {@link DeviceDirectory}.
 *
 * Rows live under a `(tenant, deviceId)` composite key, so a cross-tenant read
 * is not "denied" — it addresses a different key space and finds nothing
 * (§12.6.2 layer 3). The pre-tenant index below maps a deviceId to that same
 * composite key, so a revocation applied through the composite key is
 * immediately visible to `/byok/challenge` and `/byok/token` with no second
 * copy to keep in sync — and a deleted row is removed from BOTH in one step.
 *
 * Revocation DELETES. `DeviceRecord.revoked` survives as the field every auth
 * path already reads, but no record this store writes ever carries `true`:
 * revocation and machine supersession remove the record outright, so "revoked"
 * and "never registered" are one indistinguishable answer rather than two.
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
      // Always false, and there is no writer that sets it true — see the file
      // header. The field stays because every auth path reads it.
      revoked: false,
      ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
    };
    // One physical machine, one device row per product. The scan is
    // deliberately narrowed by tenant AND product AND a present machineId:
    // an absent machineId matches nothing, so devices that could not identify
    // their machine never supersede each other. Prior rows are DELETED, not
    // flagged: a superseded grant that lingers as a row is a credential the
    // directory still has to remember to exclude on every read path, and the
    // history of which machine held which grant belongs to the audit surfaces
    // keyed by device id (tasks, egress, proof receipts), not to the directory.
    //
    // The device being registered is skipped: re-pairing the SAME deviceId is
    // an in-place replacement below, not a supersession of itself.
    if (input.machineId !== undefined) {
      for (const [key, existing] of [...this.#byTenant]) {
        if (existing.deviceId === record.deviceId) continue;
        if (existing.tenantId !== tenant) continue;
        if (existing.productId !== input.productId) continue;
        if (existing.machineId !== input.machineId) continue;
        this.#forget(key, existing.deviceId);
      }
    }
    const key = tenantKey(tenant, record.deviceId);
    this.#byTenant.set(key, record);
    this.#byDeviceId.set(record.deviceId, key);
    return record;
  }

  async get(tenant: TenantId, deviceId: string): Promise<DeviceRecord | undefined> {
    return this.#byTenant.get(tenantKey(tenant, deviceId));
  }

  /**
   * Revocation removes the registration. A no-op for a device this tenant does
   * not own: revoking what you cannot address changes nothing.
   */
  async revoke(tenant: TenantId, deviceId: string): Promise<void> {
    const key = tenantKey(tenant, deviceId);
    if (!this.#byTenant.has(key)) return;
    this.#forget(key, deviceId);
  }

  /**
   * Drops a record from the composite map and, only when it still points here,
   * from the pre-tenant index. A re-registration under the same deviceId has
   * already re-pointed that index, and a stale delete would blind
   * `/byok/challenge` to a device that is currently paired.
   */
  #forget(key: string, deviceId: string): void {
    this.#byTenant.delete(key);
    if (this.#byDeviceId.get(deviceId) === key) this.#byDeviceId.delete(deviceId);
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
