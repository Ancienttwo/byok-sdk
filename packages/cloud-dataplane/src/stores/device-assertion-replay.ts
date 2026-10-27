import { assertCollectExpiredInput, type CollectExpiredInput, type CollectExpiredResult, type TenantId } from '@byok-sdk/core';
import type {
  DeviceAssertionReplayAuthority,
  DeviceAssertionReplayConsumeInput,
} from '@byok-sdk/core';
import type { Pool } from 'pg';
import type { ByokPool } from '../pool';

/** Durable atomic replay authority for hosted device-assertion exchange. */
export class PostgresDeviceAssertionReplayAuthority implements DeviceAssertionReplayAuthority {
  readonly #pool: Pool;

  constructor(pool: ByokPool) {
    this.#pool = pool;
  }

  async consume(input: DeviceAssertionReplayConsumeInput): Promise<boolean> {
    if (!Number.isFinite(Date.parse(input.expiresAt))) {
      throw new Error('device assertion replay expiry is invalid');
    }
    // The conflict target is the full primary key, `schema` segment included
    // (contract §8.2(2), `deploy/sql/0022_task_assertion_replay_schema.sql`).
    // Both lanes share this ledger; the discriminator is what keeps one lane's
    // `jti` from burning the other's key and keeps the two consumption
    // ledgers distinguishable for audit.
    const result = await this.#pool.query(
      `INSERT INTO device_assertion_replay (
         tenant_id, issuer, product_id, device_id, audience, schema, jti, expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, issuer, product_id, device_id, audience, schema, jti) DO NOTHING
       RETURNING jti`,
      [
        input.tenantId,
        input.issuer,
        input.productId,
        input.deviceId,
        input.audience,
        input.schema,
        input.jti,
        input.expiresAt,
      ],
    );
    return result.rowCount === 1;
  }

  async collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    const result = await this.#pool.query<{removed: string; more: boolean}>(
      `WITH candidates AS MATERIALIZED (
         SELECT ctid FROM device_assertion_replay WHERE tenant_id = $1 AND (expires_at <= $2)
         ORDER BY expires_at LIMIT $3 + 1 FOR UPDATE SKIP LOCKED
       ), deleted AS (
         DELETE FROM device_assertion_replay WHERE ctid IN (SELECT ctid FROM candidates LIMIT $3) RETURNING 1
       ) SELECT (SELECT count(*) FROM deleted)::text AS removed,
                EXISTS(SELECT 1 FROM candidates OFFSET $3) AS more`,
      [tenant, input.now, input.limit],
    );
    return { removed: Number(result.rows[0]!.removed), expired: 0, releasedBytes: 0n, more: result.rows[0]!.more };
  }

}
