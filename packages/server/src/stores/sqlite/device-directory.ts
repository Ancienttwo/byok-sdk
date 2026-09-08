import {
  PRESENCE_LEVELS,
  type PresenceStore,
  type TenantId,
  type TenantReadiness,
  type TenantReadinessDevice,
} from '@byok-sdk/core';
import type { DeviceDirectory, DeviceRecord, DeviceRegistration } from '@byok-sdk/cloud';
import { HarnessInventorySchema, type HarnessInfo } from '@byok-sdk/protocol';
import type { DatabaseSync } from 'node:sqlite';

export const DEVICE_SCHEMA = `
CREATE TABLE device_directory (
  tenant_id TEXT NOT NULL,
  device_id TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL,
  machine_id TEXT,
  device_name TEXT NOT NULL,
  device_public_key TEXT NOT NULL,
  proof_key_id TEXT NOT NULL,
  proof_key_epoch INTEGER NOT NULL CHECK (proof_key_epoch >= 0),
  capabilities_json TEXT,
  harnesses_json TEXT,
  PRIMARY KEY (tenant_id, device_id)
);
CREATE UNIQUE INDEX device_directory_machine
  ON device_directory (tenant_id, product_id, machine_id) WHERE machine_id IS NOT NULL;
`;

interface Coordinator {
  run<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T>;
  transaction<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T>;
}

type Row = Record<string, unknown>;
function requiredString(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid SQLite device ${field}`);
  return value;
}
function capabilities(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error('Invalid SQLite device capabilities');
  }
  return Object.freeze([...value]);
}
function fromRow(row: Row): DeviceRecord {
  const epoch = row.proof_key_epoch;
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error('Invalid SQLite device proof_key_epoch');
  }
  return {
    tenantId: requiredString(row, 'tenant_id') as TenantId,
    deviceId: requiredString(row, 'device_id'),
    productId: requiredString(row, 'product_id'),
    deviceName: requiredString(row, 'device_name'),
    devicePublicKey: requiredString(row, 'device_public_key'),
    proofKeyId: requiredString(row, 'proof_key_id'),
    proofKeyEpoch: epoch,
    revoked: false,
    ...(row.machine_id === null ? {} : { machineId: requiredString(row, 'machine_id') }),
    ...(row.capabilities_json === null ? {} : {
      capabilities: capabilities(JSON.parse(requiredString(row, 'capabilities_json'))),
    }),
    ...(row.harnesses_json === null ? {} : {
      harnesses: HarnessInventorySchema.parse(JSON.parse(requiredString(row, 'harnesses_json'))),
    }),
  };
}

/** Enrollment, capability admission and pre-tenant auth read the same durable row. */
export class SqliteDeviceDirectory implements DeviceDirectory {
  constructor(private readonly coordinator: Coordinator) {}

  register(tenant: TenantId, input: DeviceRegistration): Promise<DeviceRecord> {
    return this.coordinator.transaction(db => {
      // Global device IDs resolve a tenant before authentication. A collision must
      // fail rather than replacing another tenant's authentication authority.
      const owner = db.prepare('SELECT tenant_id FROM device_directory WHERE device_id = ?').get(input.deviceId);
      if (owner !== undefined && owner.tenant_id !== tenant) throw new Error('Device ID already belongs to another tenant');
      if (input.machineId !== undefined) {
        db.prepare('DELETE FROM device_directory WHERE tenant_id = ? AND product_id = ? AND machine_id = ? AND device_id <> ?')
          .run(tenant, input.productId, input.machineId, input.deviceId);
      }
      db.prepare(`INSERT INTO device_directory
        (tenant_id, device_id, product_id, machine_id, device_name, device_public_key, proof_key_id, proof_key_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, device_id) DO UPDATE SET
          product_id = excluded.product_id, machine_id = excluded.machine_id,
          device_name = excluded.device_name, device_public_key = excluded.device_public_key,
          proof_key_id = excluded.proof_key_id, proof_key_epoch = excluded.proof_key_epoch,
          capabilities_json = NULL, harnesses_json = NULL`)
        .run(tenant, input.deviceId, input.productId, input.machineId ?? null,
          input.deviceName, input.devicePublicKey, input.proofKeyId, input.proofKeyEpoch);
      return fromRow(db.prepare('SELECT * FROM device_directory WHERE tenant_id = ? AND device_id = ?').get(tenant, input.deviceId)!);
    });
  }

  get(tenant: TenantId, deviceId: string): Promise<DeviceRecord | undefined> {
    return this.coordinator.run(db => {
      const row = db.prepare('SELECT * FROM device_directory WHERE tenant_id = ? AND device_id = ?').get(tenant, deviceId);
      return row === undefined ? undefined : fromRow(row);
    });
  }

  revoke(tenant: TenantId, deviceId: string): Promise<void> {
    return this.coordinator.run(db => {
      db.prepare('DELETE FROM device_directory WHERE tenant_id = ? AND device_id = ?').run(tenant, deviceId);
    });
  }

  list(tenant: TenantId): Promise<readonly DeviceRecord[]> {
    return this.coordinator.run(db => db.prepare('SELECT * FROM device_directory WHERE tenant_id = ? ORDER BY device_id')
      .all(tenant).map(fromRow));
  }

  resolveByDeviceId(deviceId: string): Promise<DeviceRecord | undefined> {
    return this.coordinator.run(db => {
      const row = db.prepare('SELECT * FROM device_directory WHERE device_id = ?').get(deviceId);
      return row === undefined ? undefined : fromRow(row);
    });
  }

  recordCapabilities(tenant: TenantId, input: {
    readonly deviceId: string; readonly capabilities: readonly string[]; readonly harnesses?: readonly HarnessInfo[];
  }): Promise<DeviceRecord | undefined> {
    return this.coordinator.transaction(db => {
      const row = db.prepare('SELECT * FROM device_directory WHERE tenant_id = ? AND device_id = ?').get(tenant, input.deviceId);
      if (row === undefined) return undefined;
      fromRow(row);
      const declaredCapabilities = capabilities(input.capabilities);
      const harnesses = HarnessInventorySchema.parse(input.harnesses ?? []);
      db.prepare('UPDATE device_directory SET capabilities_json = ?, harnesses_json = ? WHERE tenant_id = ? AND device_id = ?')
        .run(JSON.stringify(declaredCapabilities), JSON.stringify(harnesses), tenant, input.deviceId);
      return fromRow(db.prepare('SELECT * FROM device_directory WHERE tenant_id = ? AND device_id = ?').get(tenant, input.deviceId)!);
    });
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

}
