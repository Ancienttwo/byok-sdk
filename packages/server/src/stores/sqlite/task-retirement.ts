import { TASK_ATTEMPT_UNFINISHED_STATUSES, type TaskAbandonCause } from '@byok-sdk/cloud';
import type { MailboxStreamCloseCause, TenantId } from '@byok-sdk/core';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The SQLite transitions device retirement and task abandonment share. Both
 * run inside the caller's coordinator transaction, so the task rows and the
 * mailbox rows they settle commit together.
 */

const UNFINISHED = TASK_ATTEMPT_UNFINISHED_STATUSES.map(() => '?').join(', ');

/** Dead-letters a device's `pending` rows: every one, or exactly the listed seqs. Nothing else moves. */
export function expirePendingMailbox(
  db: DatabaseSync,
  tenant: TenantId,
  deviceId: string,
  seqs: 'all' | readonly number[],
): number {
  if (seqs !== 'all' && seqs.length === 0) return 0;
  const listed = seqs === 'all' ? '' : ` AND seq IN (${seqs.map(() => '?').join(', ')})`;
  return Number(db.prepare(
    `UPDATE mailbox_message SET state = 'expired'
     WHERE tenant_id = ? AND device_id = ? AND state = 'pending'${listed}`,
  ).run(tenant, deviceId, ...(seqs === 'all' ? [] : seqs)).changes);
}

/**
 * Closes a retired device's stream, creating it closed if it never had mail,
 * and dead-letters every pending row on it. The first close instant is kept;
 * the cause is the latest. The coordinator transaction orders it with every
 * append, so no append for the device commits a pending row after it.
 */
export function closeMailboxStream(
  db: DatabaseSync,
  tenant: TenantId,
  deviceId: string,
  cause: MailboxStreamCloseCause,
  now: string,
): number {
  db.prepare(
    `INSERT INTO mailbox_cursor (tenant_id, device_id, updated_at, closed_at, closed_cause) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, device_id) DO UPDATE
       SET closed_at = COALESCE(mailbox_cursor.closed_at, excluded.closed_at), closed_cause = excluded.closed_cause`,
  ).run(tenant, deviceId, now, now, cause);
  return expirePendingMailbox(db, tenant, deviceId, 'all');
}

/** Reopens a stream for a new registration of the same id; rows, cursor and seq stay. */
export function reopenMailboxStream(db: DatabaseSync, tenant: TenantId, deviceId: string): void {
  db.prepare(
    `UPDATE mailbox_cursor SET closed_at = NULL, closed_cause = NULL
     WHERE tenant_id = ? AND device_id = ? AND closed_at IS NOT NULL`,
  ).run(tenant, deviceId);
}

/**
 * Settles the unfinished attempts the filter selects; terminal attempts and tombstones are left as they are.
 * `archive_after` takes the terminal instant in the same UPDATE, as every terminal transition sets it.
 */
function abandonAttempts(
  db: DatabaseSync,
  tenant: TenantId,
  cause: TaskAbandonCause,
  now: string,
  filter: string,
  parameters: readonly string[],
): void {
  db.prepare(
    `UPDATE task_attempt SET status = 'cancelled', terminal_cause = ?, terminal_at = COALESCE(terminal_at, ?),
       archive_after = COALESCE(archive_after, terminal_at, ?), updated_at = ?
     WHERE tenant_id = ? AND status IN (${UNFINISHED}) AND (${filter})`,
  ).run(cause, now, now, now, tenant, ...TASK_ATTEMPT_UNFINISHED_STATUSES, ...parameters);
}

/** Device retirement: the device's unfinished attempts, then its stream, closed with every pending row expired. */
export function retireDevice(
  db: DatabaseSync,
  tenant: TenantId,
  deviceId: string,
  cause: Extract<TaskAbandonCause, 'device_revoked' | 'device_superseded'>,
  now: string,
): void {
  abandonAttempts(db, tenant, cause, now, 'device_id = ? OR owner_device_id = ?', [deviceId, deviceId]);
  closeMailboxStream(db, tenant, deviceId, cause, now);
}

/**
 * Task abandonment: the attempt, then its pending rows on its target and
 * owner devices that are no longer registered. A registered device keeps its
 * rows pending, so its `recoverableFrom` never passes rows it has not read;
 * the inbound gate refuses its later report for the settled task. A row belongs to the task when its envelope names it in a
 * top-level `task_id`; the text filter narrows the scan and the parse
 * confirms each match.
 */
export function abandonTask(
  db: DatabaseSync,
  tenant: TenantId,
  task: { readonly taskId: string; readonly deviceId: string; readonly ownerDeviceId?: string },
  cause: TaskAbandonCause,
  now: string,
): void {
  abandonAttempts(db, tenant, cause, now, 'task_id = ?', [task.taskId]);
  const devices = task.ownerDeviceId === undefined || task.ownerDeviceId === task.deviceId
    ? [task.deviceId]
    : [task.deviceId, task.ownerDeviceId];
  for (const deviceId of devices) {
    if (db.prepare('SELECT 1 FROM device_directory WHERE tenant_id = ? AND device_id = ?').get(tenant, deviceId) !== undefined) continue;
    const rows = db.prepare(
      `SELECT seq, body FROM mailbox_message
       WHERE tenant_id = ? AND device_id = ? AND state = 'pending' AND instr(body, ?) > 0 ORDER BY seq`,
    ).all(tenant, deviceId, `"task_id":${JSON.stringify(task.taskId)}`) as unknown as { seq: number; body: string }[];
    expirePendingMailbox(db, tenant, deviceId,
      rows.filter((row) => envelopeTaskId(row.body) === task.taskId).map((row) => Number(row.seq)));
  }
}

function envelopeTaskId(body: string): unknown {
  try {
    const value = JSON.parse(body) as unknown;
    return value !== null && typeof value === 'object' ? (value as { readonly task_id?: unknown }).task_id : undefined;
  } catch {
    return undefined;
  }
}
