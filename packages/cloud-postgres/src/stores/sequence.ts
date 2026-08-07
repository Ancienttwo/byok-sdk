/**
 * Postgres {@link DeviceSequenceStore}: a monotonic per-(tenant, device)
 * delivery counter starting at 1, matching what a mailbox numbers its first
 * row.
 *
 * One statement allocates. The upsert either creates the row already advanced
 * past its first number or bumps the existing one under the row lock the
 * conflict takes, and `RETURNING next_seq - 1` reads the same for both paths:
 * a fresh row stores 2 and hands back 1; an existing row stores n+1 and hands
 * back n. Concurrent allocations therefore cannot hand out the same number
 * twice — which matters because the daemon's redelivery cursor IS this number,
 * and a repeat makes the cursor ambiguous and one envelope unacknowledgeable.
 */
import type { DeviceSequenceStore } from '@byok/cloud';
import type { TenantId } from '@byok/core';
import type { Pool } from 'pg';

export class PostgresDeviceSequenceStore implements DeviceSequenceStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async next(tenant: TenantId, deviceId: string): Promise<number> {
    const result = await this.#pool.query<{ allocated: bigint }>(
      `INSERT INTO device_stream (tenant_id, device_id, next_seq, acked_seq)
       VALUES ($1, $2, 2, 0)
       ON CONFLICT (tenant_id, device_id) DO UPDATE
         SET next_seq = device_stream.next_seq + 1
       RETURNING next_seq - 1 AS allocated`,
      [tenant, deviceId],
    );
    // int8 decodes to bigint (see `pool.ts`); the port speaks `number` because
    // that is the envelope `seq` on the wire.
    return Number(result.rows[0]!.allocated);
  }
}
