import type {
  DeviceAssertionReplayAuthority,
  DeviceAssertionReplayConsumeInput,
} from '@byok-sdk/core';
import type { Pool } from 'pg';

/** Durable atomic replay authority for hosted device-assertion exchange. */
export class PostgresDeviceAssertionReplayAuthority implements DeviceAssertionReplayAuthority {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async consume(input: DeviceAssertionReplayConsumeInput): Promise<boolean> {
    if (!Number.isFinite(Date.parse(input.expiresAt))) {
      throw new Error('device assertion replay expiry is invalid');
    }
    const result = await this.#pool.query(
      `INSERT INTO device_assertion_replay (
         tenant_id, issuer, product_id, device_id, audience, jti, expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, issuer, product_id, device_id, audience, jti) DO NOTHING
       RETURNING jti`,
      [
        input.tenantId,
        input.issuer,
        input.productId,
        input.deviceId,
        input.audience,
        input.jti,
        input.expiresAt,
      ],
    );
    return result.rowCount === 1;
  }

  /** Bounded retention cleanup; callers choose cadence and batch size. */
  async deleteExpired(before: Date, limit: number): Promise<number> {
    if (!Number.isFinite(before.getTime()) || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error('device assertion replay cleanup bounds are invalid');
    }
    const result = await this.#pool.query(
      `DELETE FROM device_assertion_replay
       WHERE ctid IN (
         SELECT ctid
         FROM device_assertion_replay
         WHERE expires_at <= $1
         ORDER BY expires_at
         LIMIT $2
       )`,
      [before.toISOString(), limit],
    );
    return result.rowCount ?? 0;
  }
}
