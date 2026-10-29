/**
 * The Postgres transitions device retirement and task abandonment share.
 *
 * Each runs inside the caller's transaction, which must be opened with
 * `BEGIN_OUTBOX_WRITE`: under READ COMMITTED a guarded `UPDATE` re-checks a row
 * that a concurrent writer committed while it waited, so an attempt or a row
 * that became terminal or acked meanwhile is skipped instead of overwritten.
 *
 * Lock order, the same as cancellation's: task rows (in `task_id` order), then
 * each device's `device_stream` row (in `device_id` order), then the outbox
 * rows. The stream row is the lock every mailbox writer and the ack take before
 * an outbox row, so taking it first means a row appended before this
 * transaction is either expired here or already acked, and an ack never waits
 * on an outbox row this transaction holds while this one waits on its stream.
 * No tenant mailbox lock is taken: expiring only lowers the `pending` sum a
 * limited append is checked against.
 */
import {
  TASK_ATTEMPT_UNFINISHED_STATUSES,
  type TaskAbandonCause,
} from '@byok-sdk/cloud';
import type { TenantId } from '@byok-sdk/core';
import type { PoolClient } from 'pg';
import { readOutbox } from './task-redaction';

type Querier = Pick<PoolClient, 'query'>;

const UNFINISHED = [...TASK_ATTEMPT_UNFINISHED_STATUSES];

async function lockStreams(client: Querier, tenant: TenantId, deviceIds: readonly string[]): Promise<void> {
  await client.query(
    `SELECT 1 FROM device_stream WHERE tenant_id = $1 AND device_id = ANY($2::text[])
      ORDER BY device_id FOR UPDATE`,
    [tenant, [...deviceIds]],
  );
}

/** Dead-letters a device's `pending` rows: every one, or exactly the listed seqs. Nothing else moves. */
export async function expirePendingOutbox(
  client: Querier,
  tenant: TenantId,
  deviceId: string,
  seqs: 'all' | readonly (number | string)[],
): Promise<number> {
  if (seqs !== 'all' && seqs.length === 0) return 0;
  await lockStreams(client, tenant, [deviceId]);
  return expireLocked(client, tenant, deviceId, seqs);
}

async function expireLocked(
  client: Querier,
  tenant: TenantId,
  deviceId: string,
  seqs: 'all' | readonly (number | string)[],
): Promise<number> {
  if (seqs !== 'all' && seqs.length === 0) return 0;
  const expired = await client.query(
    `UPDATE outbox SET state = 'expired'
      WHERE tenant_id = $1 AND device_id = $2 AND state = 'pending'
        AND ($3::bigint[] IS NULL OR seq = ANY($3::bigint[]))`,
    [tenant, deviceId, seqs === 'all' ? null : seqs.map(String)],
  );
  return expired.rowCount ?? 0;
}

/**
 * Device retirement: every unfinished attempt the devices were offered or own,
 * then every pending row addressed to them. Callers pass only ids whose row
 * they deleted in this transaction.
 */
export async function retireDevices(
  client: Querier,
  tenant: TenantId,
  deviceIds: readonly string[],
  cause: Extract<TaskAbandonCause, 'device_revoked' | 'device_superseded'>,
  now: string,
): Promise<void> {
  if (deviceIds.length === 0) return;
  const ids = [...deviceIds].sort();
  await client.query(
    `WITH locked AS (
       SELECT task_id FROM task
        WHERE tenant_id = $1 AND status = ANY($2::text[])
          AND (device_id = ANY($3::text[]) OR owner_device_id = ANY($3::text[]))
        ORDER BY task_id FOR UPDATE
     )
     UPDATE task t
        SET status = 'cancelled', terminal_cause = $4, terminal_at = COALESCE(t.terminal_at, $5), updated_at = $5
       FROM locked
      WHERE t.tenant_id = $1 AND t.task_id = locked.task_id AND t.status = ANY($2::text[])`,
    [tenant, UNFINISHED, ids, cause, now],
  );
  await lockStreams(client, tenant, ids);
  for (const deviceId of ids) await expireLocked(client, tenant, deviceId, 'all');
}

/**
 * Task abandonment for an attempt the caller holds under `FOR UPDATE` and has
 * found unfinished: the attempt, then its pending rows on its target and owner
 * devices, identified exactly as redaction identifies them.
 */
export async function abandonTask(
  client: Querier,
  tenant: TenantId,
  task: { readonly task_id: string; readonly device_id: string; readonly owner_device_id: string | null; readonly status: string },
  cause: TaskAbandonCause,
  now: string,
): Promise<void> {
  await client.query(
    `UPDATE task
        SET status = 'cancelled', terminal_cause = $3, terminal_at = COALESCE(terminal_at, $4), updated_at = $4
      WHERE tenant_id = $1 AND task_id = $2 AND status = ANY($5::text[])`,
    [tenant, task.task_id, cause, now, UNFINISHED],
  );
  const devices = task.owner_device_id === null || task.owner_device_id === task.device_id
    ? [task.device_id]
    : [task.device_id, task.owner_device_id];
  await lockStreams(client, tenant, devices);
  const rows = await readOutbox(client, tenant, task.task_id, task, false, true);
  for (const deviceId of [...devices].sort()) {
    await expireLocked(client, tenant, deviceId, rows.filter((row) => row.device_id === deviceId).map((row) => row.seq));
  }
}
