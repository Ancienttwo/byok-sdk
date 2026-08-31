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
 *
 * Revocation DELETES. The `revoked` column and {@link DeviceRecord.revoked}
 * survive because every auth path reads them, but nothing in this module ever
 * writes `true` any more: `revoke` and machine supersession remove the row and
 * its device-scoped state, so a revoked device is byte-for-byte a device that
 * was never registered. `device_active_machine_key` (0015) is still the
 * invariant — its `NOT revoked` predicate simply never has a false row left to
 * exclude.
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
import type { Pool, PoolClient } from 'pg';

interface DeviceRow {
  readonly tenant_id: string;
  readonly device_id: string;
  readonly product_id: string;
  readonly device_name: string;
  readonly device_public_key: string;
  readonly proof_key_id: string;
  readonly proof_key_epoch: number;
  readonly revoked: boolean;
  readonly machine_id: string | null;
  readonly capabilities: readonly string[] | null;
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
    ...(row.machine_id == null ? {} : { machineId: row.machine_id }),
    ...(row.capabilities == null ? {} : { capabilities: Object.freeze([...row.capabilities]) }),
  };
}

const SELECT_COLUMNS =
  'tenant_id, device_id, product_id, device_name, device_public_key, proof_key_id, proof_key_epoch, revoked, machine_id, capabilities';

/**
 * The device-scoped state a device row is the only reason to keep, deleted
 * alongside it. Every entry is keyed by `(tenant_id, device_id, …)`, so the
 * delete addresses the same key space the row itself lived in.
 *
 * Deliberately NOT here:
 *
 * - `task`, `agent_egress_event`, `proof_request_receipt` — history keyed by a
 *   device_id STRING, with no foreign key. What a device did stays true after
 *   the grant that let it is gone.
 * - `outbox` and `device_stream` — core's mailbox, whose rows carry message
 *   bodies and are retired through `collectRetired`/tenant erasure. A device
 *   directory that deleted them would be a second authority over core state,
 *   and an unbounded body delete on the pairing path is an availability risk.
 * - `agent_memory_projection_head` / `…_metering_receipt` — keyed by
 *   `(tenant_id, agent_id)`; `device_id` is provenance, not identity. Erasing
 *   a head has its OWN protocol (0014's epoch fence), and bypassing it would
 *   let a stale writer re-enter under a lower epoch.
 *
 * Every statement below is index-covered by its table's primary key, except
 * `device_assertion_replay`, whose PK leads with `tenant_id` and is swept by
 * expiry — a tenant-prefixed scan over live assertions, so no new index.
 */
const DEVICE_STATE_DELETES = [
  'DELETE FROM device_presence WHERE tenant_id = $1 AND device_id = ANY($2::text[])',
  'DELETE FROM auth_nonce WHERE tenant_id = $1 AND device_id = ANY($2::text[])',
  'DELETE FROM inbound_dedup WHERE tenant_id = $1 AND device_id = ANY($2::text[])',
  'DELETE FROM device_assertion_replay WHERE tenant_id = $1 AND device_id = ANY($2::text[])',
] as const;

/**
 * Removes the device-scoped state for ids whose rows have already been deleted
 * in this transaction. Callers pass the ids `DELETE … RETURNING device_id`
 * actually removed, so a no-op revoke deletes nothing at all.
 */
async function deleteDeviceState(
  client: PoolClient,
  tenant: TenantId,
  deviceIds: readonly string[],
): Promise<void> {
  if (deviceIds.length === 0) return;
  for (const statement of DEVICE_STATE_DELETES) {
    await client.query(statement, [tenant, [...deviceIds]]);
  }
}

/** Best-effort unwind — the original failure is what the caller must see, not a rollback that also failed. */
async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {}
}

/**
 * The client-scoped registration mutation shared by standalone device
 * registration and pairing enrollment. Its caller owns the transaction so the
 * guarded pairing-code update, machine supersession cleanup, and insert can
 * commit or roll back together.
 */
export async function registerDeviceOnClient(
  client: PoolClient,
  tenant: TenantId,
  input: DeviceRegistration,
): Promise<DeviceRecord> {
  // Re-pairing an existing device replaces its registration in place rather
  // than creating a second row, matching the in-memory reference. `revoked`
  // resets because a fresh pairing IS a new grant.
  //
  // With a machine identity present this is SEVERAL statements — delete this
  // tenant/product's prior rows for the same machine, delete the state those
  // rows were the only reason to keep, then insert — and they must commit or
  // fail together: a partial apply is either a machine holding two rows or a
  // machine holding none. The supersession runs FIRST because
  // `device_active_machine_key` (0015) is a partial unique index, so
  // inserting before deleting would collide with the row this call replaces.
  //
  // The predecessor row is REMOVED rather than flagged: a superseded grant
  // that lingers is a credential every read path has to remember to exclude,
  // and the history of what that device did lives in the audit tables keyed
  // by its device_id string, which this deliberately does not touch.
  //
  // `device_id <> $4` skips the device being registered: re-pairing the SAME
  // id is the ON CONFLICT replacement below, not a supersession of itself.
  //
  // Deliberately not one multi-CTE statement: a data-modifying CTE sees the
  // snapshot from the start of the statement, so the INSERT could not observe
  // the DELETE's effect and the unique index would reject exactly the
  // supersession this exists to perform.
  if (input.machineId !== undefined) {
    const superseded = await client.query<{ device_id: string }>(
      `DELETE FROM device
        WHERE tenant_id = $1 AND product_id = $2 AND machine_id = $3 AND device_id <> $4
      RETURNING device_id`,
      [tenant, input.productId, input.machineId, input.deviceId],
    );
    await deleteDeviceState(
      client,
      tenant,
      superseded.rows.map((row) => row.device_id),
    );
  }
  const result = await client.query<DeviceRow>(
    `INSERT INTO device (
       tenant_id, device_id, product_id, device_name, device_public_key,
       proof_key_id, proof_key_epoch, revoked, machine_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)
     ON CONFLICT (tenant_id, device_id) DO UPDATE
       SET product_id = EXCLUDED.product_id,
           device_name = EXCLUDED.device_name,
           device_public_key = EXCLUDED.device_public_key,
           proof_key_id = EXCLUDED.proof_key_id,
           proof_key_epoch = EXCLUDED.proof_key_epoch,
           revoked = false,
           machine_id = EXCLUDED.machine_id,
           capabilities = NULL
     RETURNING ${SELECT_COLUMNS}`,
    [
      tenant,
      input.deviceId,
      input.productId,
      input.deviceName,
      input.devicePublicKey,
      input.proofKeyId,
      input.proofKeyEpoch,
      input.machineId ?? null,
    ],
  );
  return toRecord(result.rows[0]!);
}

export class PostgresDeviceDirectory implements DeviceDirectory {
  readonly #pool: Pool;
  readonly #clock: Clock | undefined;

  constructor(pool: Pool, clock?: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async register(tenant: TenantId, input: DeviceRegistration): Promise<DeviceRecord> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const record = await registerDeviceOnClient(client, tenant, input);
      await client.query('COMMIT');
      return record;
    } catch (cause) {
      await rollback(client);
      throw cause;
    } finally {
      client.release();
    }
  }

  async get(tenant: TenantId, deviceId: string): Promise<DeviceRecord | undefined> {
    const result = await this.#pool.query<DeviceRow>(
      `SELECT ${SELECT_COLUMNS} FROM device WHERE tenant_id = $1 AND device_id = $2`,
      [tenant, deviceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Revocation removes the registration and the device-scoped state that only
   * existed to serve it, in one transaction: a half-applied revoke that left
   * live presence or an unspent challenge nonce behind would be state for a
   * device the directory can no longer name.
   *
   * A no-op for a device this tenant does not own: revoking what you cannot
   * address deletes nothing and reports nothing back.
   */
  async revoke(tenant: TenantId, deviceId: string): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const removed = await client.query<{ device_id: string }>(
        'DELETE FROM device WHERE tenant_id = $1 AND device_id = $2 RETURNING device_id',
        [tenant, deviceId],
      );
      await deleteDeviceState(
        client,
        tenant,
        removed.rows.map((row) => row.device_id),
      );
      await client.query('COMMIT');
    } catch (cause) {
      await rollback(client);
      throw cause;
    } finally {
      client.release();
    }
  }

  async recordCapabilities(
    tenant: TenantId,
    input: { readonly deviceId: string; readonly capabilities: readonly string[] },
  ): Promise<DeviceRecord | undefined> {
    const result = await this.#pool.query<DeviceRow>(
      `UPDATE device
          SET capabilities = $3::jsonb
        WHERE tenant_id = $1 AND device_id = $2 AND revoked = false
      RETURNING ${SELECT_COLUMNS}`,
      [tenant, input.deviceId, JSON.stringify([...input.capabilities])],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toRecord(row);
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
