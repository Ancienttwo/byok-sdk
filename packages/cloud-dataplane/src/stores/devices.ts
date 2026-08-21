/**
 * Postgres {@link DeviceDirectory}.
 *
 * Rows live under the composite key `(tenant_id, device_id)`, so a cross-tenant
 * read is not "denied" — it addresses a different key space and finds nothing
 * (§12.6.2 layer 3). `resolveByDeviceId` is the documented pre-tenant entry
 * point, and it is safe for exactly one reason: the row it returns CARRIES its
 * tenant, so the caller never compares a tenant it was handed against one it
 * guessed. One row, two access paths, never two copies to keep in sync — a
 * stale pre-tenant index would be a revoked device that can still get a token.
 */
import {
  type Clock,
  type PresenceStore,
  type PresenceLevel,
  type TenantId,
  type TenantReadinessDevice,
  type TenantReadiness,
} from '@byok-sdk/core';
import type { DeviceDirectory, DeviceRecord, DeviceRegistration } from '@byok-sdk/cloud';
import type { Pool } from 'pg';

interface DeviceRow {
  readonly tenant_id: string;
  readonly device_id: string;
  readonly product_id: string;
  readonly device_name: string;
  readonly device_public_key: string;
  readonly proof_key_id: string;
  readonly proof_key_epoch: number;
  readonly revoked: boolean;
}

/**
 * `tenant_id` is read back from the row rather than re-branded from the
 * argument, so `resolveByDeviceId` and `get` produce records the same way.
 * The cast is confined here: this module is the boundary where a database
 * string becomes the branded identity core mints elsewhere.
 */
function toRecord(row: DeviceRow): DeviceRecord {
  return {
    tenantId: row.tenant_id as TenantId,
    productId: row.product_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    devicePublicKey: row.device_public_key,
    proofKeyId: row.proof_key_id,
    proofKeyEpoch: row.proof_key_epoch,
    revoked: row.revoked,
  };
}

const SELECT_COLUMNS =
  'tenant_id, device_id, product_id, device_name, device_public_key, proof_key_id, proof_key_epoch, revoked';

export class PostgresDeviceDirectory implements DeviceDirectory {
  readonly #pool: Pool;
  readonly #clock: Clock | undefined;

  constructor(pool: Pool, clock?: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async register(tenant: TenantId, input: DeviceRegistration): Promise<DeviceRecord> {
    // Re-pairing an existing device replaces its registration in place rather
    // than creating a second row, matching the in-memory reference. `revoked`
    // resets because a fresh pairing IS a new grant.
    const result = await this.#pool.query<DeviceRow>(
      `INSERT INTO device (
         tenant_id, device_id, product_id, device_name, device_public_key,
         proof_key_id, proof_key_epoch, revoked
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, false)
       ON CONFLICT (tenant_id, device_id) DO UPDATE
         SET product_id = EXCLUDED.product_id,
             device_name = EXCLUDED.device_name,
             device_public_key = EXCLUDED.device_public_key,
             proof_key_id = EXCLUDED.proof_key_id,
             proof_key_epoch = EXCLUDED.proof_key_epoch,
             revoked = false
       RETURNING ${SELECT_COLUMNS}`,
      [
        tenant,
        input.deviceId,
        input.productId,
        input.deviceName,
        input.devicePublicKey,
        input.proofKeyId,
        input.proofKeyEpoch,
      ],
    );
    return toRecord(result.rows[0]!);
  }

  async get(tenant: TenantId, deviceId: string): Promise<DeviceRecord | undefined> {
    const result = await this.#pool.query<DeviceRow>(
      `SELECT ${SELECT_COLUMNS} FROM device WHERE tenant_id = $1 AND device_id = $2`,
      [tenant, deviceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  async revoke(tenant: TenantId, deviceId: string): Promise<void> {
    // A no-op for a device this tenant does not own: revoking what you cannot
    // address changes nothing and reports nothing back.
    await this.#pool.query('UPDATE device SET revoked = true WHERE tenant_id = $1 AND device_id = $2', [
      tenant,
      deviceId,
    ]);
  }

  async list(tenant: TenantId): Promise<readonly DeviceRecord[]> {
    const result = await this.#pool.query<DeviceRow>(
      `SELECT ${SELECT_COLUMNS} FROM device WHERE tenant_id = $1 ORDER BY device_id`,
      [tenant],
    );
    return result.rows.map(toRecord);
  }

  async readiness(tenant: TenantId, _presence: PresenceStore): Promise<TenantReadiness> {
    // One tenant-scoped aggregate over durable devices and the latest live
    // presence row. The presence parameter keeps the port shape identical to
    // the reference implementation; SQL is the set-wise authority here.
    const result = await this.#pool.query<{
      device_id: string;
      product_id: string;
      device_name: string;
      revoked: boolean;
      presence_level: string | null;
      presence_detail: string | null;
      presence_configured_toolsets: readonly string[] | null;
      presence_client_version: string | null;
      presence_protocol_versions: readonly number[] | null;
      presence_runtimes: ReadonlyArray<{ id: string; version?: string; authPresent?: boolean }> | null;
      presence_observed_at: string | null;
      presence_expires_at: string | null;
      active_paired_device_count: number | string;
      revoked_device_count: number | string;
      observed_presence_count: number | string;
      observed_online_count: number | string;
      observed_thinking_count: number | string;
      observed_working_count: number | string;
      observed_error_count: number | string;
      observed_offline_count: number | string;
    }>(
      `SELECT
         d.device_id,
         d.product_id,
         d.device_name,
         d.revoked,
         CASE WHEN NOT d.revoked THEN p.level END AS presence_level,
         CASE WHEN NOT d.revoked THEN p.detail END AS presence_detail,
         CASE WHEN NOT d.revoked THEN p.configured_toolsets END AS presence_configured_toolsets,
         CASE WHEN NOT d.revoked THEN p.client_version END AS presence_client_version,
         CASE WHEN NOT d.revoked THEN p.protocol_versions END AS presence_protocol_versions,
         CASE WHEN NOT d.revoked THEN p.runtimes END AS presence_runtimes,
         CASE WHEN NOT d.revoked THEN p.observed_at END AS presence_observed_at,
         CASE WHEN NOT d.revoked THEN p.expires_at END AS presence_expires_at,
         (COUNT(*) FILTER (WHERE NOT d.revoked) OVER ())::int AS active_paired_device_count,
         (COUNT(*) FILTER (WHERE d.revoked) OVER ())::int AS revoked_device_count,
         (COUNT(*) FILTER (WHERE NOT d.revoked AND p.device_id IS NOT NULL) OVER ())::int AS observed_presence_count,
         (COUNT(*) FILTER (WHERE NOT d.revoked AND p.level = 'online') OVER ())::int AS observed_online_count,
         (COUNT(*) FILTER (WHERE NOT d.revoked AND p.level = 'thinking') OVER ())::int AS observed_thinking_count,
         (COUNT(*) FILTER (WHERE NOT d.revoked AND p.level = 'working') OVER ())::int AS observed_working_count,
         (COUNT(*) FILTER (WHERE NOT d.revoked AND p.level = 'error') OVER ())::int AS observed_error_count,
         (COUNT(*) FILTER (WHERE NOT d.revoked AND p.level = 'offline') OVER ())::int AS observed_offline_count
       FROM device d
       LEFT JOIN device_presence p
         ON p.tenant_id = d.tenant_id
        AND p.device_id = d.device_id
        AND p.expires_at > $2
       WHERE d.tenant_id = $1
       ORDER BY d.device_id`,
      [tenant, this.#clock?.now().toISOString() ?? new Date().toISOString()],
    );
    const row = result.rows[0];
    const count = (value: number | string): number => Number(value);
    const devices: TenantReadinessDevice[] = result.rows.map((device) => ({
      deviceId: device.device_id,
      productId: device.product_id,
      deviceName: device.device_name,
      revoked: device.revoked,
      ...(device.presence_level === null
        ? {}
        : {
            presence: {
              level: device.presence_level as PresenceLevel,
              ...(device.presence_detail === null ? {} : { detail: device.presence_detail }),
              ...(device.presence_configured_toolsets === null
                ? {}
                : { configuredToolsets: Object.freeze([...device.presence_configured_toolsets]) }),
              ...(device.presence_client_version === null
                ? {}
                : { clientVersion: device.presence_client_version }),
              ...(device.presence_protocol_versions === null
                ? {}
                : { protocolVersions: Object.freeze([...device.presence_protocol_versions]) }),
              ...(device.presence_runtimes === null
                ? {}
                : { runtimes: Object.freeze(device.presence_runtimes.map((runtime) => Object.freeze({ ...runtime }))) }),
              observedAt: device.presence_observed_at!,
              expiresAt: device.presence_expires_at!,
            },
          }),
    }));
    return {
      tenantId: tenant,
      activePairedDeviceCount: count(row?.active_paired_device_count ?? 0),
      revokedDeviceCount: count(row?.revoked_device_count ?? 0),
      observedPresenceCount: count(row?.observed_presence_count ?? 0),
      observedPresenceByLevel: {
        online: count(row?.observed_online_count ?? 0),
        thinking: count(row?.observed_thinking_count ?? 0),
        working: count(row?.observed_working_count ?? 0),
        error: count(row?.observed_error_count ?? 0),
        offline: count(row?.observed_offline_count ?? 0),
      },
      devices,
    };
  }

  async resolveByDeviceId(deviceId: string): Promise<DeviceRecord | undefined> {
    const result = await this.#pool.query<DeviceRow>(
      `SELECT ${SELECT_COLUMNS} FROM device WHERE device_id = $1`,
      [deviceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toRecord(row);
  }
}
