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
import type { TenantId } from '@byok/core';
import type { DeviceDirectory, DeviceRecord, DeviceRegistration } from '@byok/cloud';
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

  constructor(pool: Pool) {
    this.#pool = pool;
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

  async resolveByDeviceId(deviceId: string): Promise<DeviceRecord | undefined> {
    const result = await this.#pool.query<DeviceRow>(
      `SELECT ${SELECT_COLUMNS} FROM device WHERE device_id = $1`,
      [deviceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toRecord(row);
  }
}
