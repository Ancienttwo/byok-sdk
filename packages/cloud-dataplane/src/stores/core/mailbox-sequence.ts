/**
 * The one Postgres mailbox sequence allocator.
 *
 * The caller must already be in a transaction and must keep that transaction
 * open until its outbox row is inserted. The returned row lock is what makes a
 * lower sequence commit before any higher sequence for the same device.
 */
import type { TenantId } from '@byok-sdk/core';
import type { PoolClient } from 'pg';

export async function allocateMailboxSequence(
  client: PoolClient,
  tenant: TenantId,
  deviceId: string,
  now: string,
): Promise<number> {
  const allocation = await client.query<{ readonly seq: bigint }>(
    `INSERT INTO device_stream (tenant_id, device_id, next_seq, acked_seq, acked_at)
     VALUES ($1, $2, 2, 0, $3)
     ON CONFLICT (tenant_id, device_id) DO UPDATE
        SET next_seq = device_stream.next_seq + 1
     RETURNING next_seq - 1 AS seq`,
    [tenant, deviceId, now],
  );
  return Number(allocation.rows[0]!.seq);
}
