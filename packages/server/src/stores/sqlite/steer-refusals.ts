import type { Clock, TenantId } from '@byok-sdk/core';
import type { SteerRefusalRecord, TaskSteerRefusalStore } from '@byok-sdk/cloud';
import type { DatabaseSync } from 'node:sqlite';

/**
 * One row per refused steer (wire v7, #2009). Like the terminal receipt it
 * sits beside, a row is a lifetime fact: the task archive leaves it as it is,
 * since it holds no task content (ids, a reason token, a device id), and
 * retention never deletes it.
 */
export const STEER_REFUSAL_SCHEMA = `
CREATE TABLE task_steer_refusal (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  steer_message_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  device_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (tenant_id, task_id, steer_message_id),
  UNIQUE (tenant_id, task_id, revision)
);
`;

const STEER_REFUSAL_PROJECTION = 'tenant_id, task_id, steer_message_id, reason, device_id, recorded_at, revision FROM task_steer_refusal';

interface Coordinator {
  run<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T>;
}

interface SteerRefusalRow {
  readonly task_id: string;
  readonly steer_message_id: string;
  readonly reason: string;
  readonly device_id: string;
  readonly recorded_at: string;
  readonly revision: number;
}

function refusalRow(row: SteerRefusalRow): SteerRefusalRecord {
  return {
    taskId: row.task_id,
    steerMessageId: row.steer_message_id,
    reason: row.reason,
    deviceId: row.device_id,
    recordedAt: row.recorded_at,
    revision: row.revision,
  };
}

function readRefusal(db: DatabaseSync, tenant: TenantId, taskId: string, steerMessageId: string): SteerRefusalRecord | undefined {
  const row = db.prepare(`SELECT ${STEER_REFUSAL_PROJECTION} WHERE tenant_id = ? AND task_id = ? AND steer_message_id = ?`)
    .get(tenant, taskId, steerMessageId) as SteerRefusalRow | undefined;
  return row === undefined ? undefined : refusalRow(row);
}

/**
 * SQLite {@link TaskSteerRefusalStore}. The coordinator runs one statement
 * sequence at a time on the handle, so the revision read and the insert below
 * are one serialized step: no second writer can take the same revision.
 */
export class SqliteTaskSteerRefusalStore implements TaskSteerRefusalStore {
  constructor(private readonly coordinator: Coordinator, private readonly clock: Clock) {}

  record(
    tenant: TenantId,
    input: { readonly taskId: string; readonly steerMessageId: string; readonly reason: string; readonly deviceId: string },
  ): Promise<{ readonly refusal: SteerRefusalRecord; readonly created: boolean }> {
    return this.coordinator.run((db) => {
      const existing = readRefusal(db, tenant, input.taskId, input.steerMessageId);
      if (existing !== undefined) return { refusal: existing, created: false };
      const { revision } = db.prepare(
        'SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM task_steer_refusal WHERE tenant_id = ? AND task_id = ?',
      ).get(tenant, input.taskId) as { revision: number };
      db.prepare(
        `INSERT INTO task_steer_refusal (tenant_id, task_id, steer_message_id, reason, device_id, recorded_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(tenant, input.taskId, input.steerMessageId, input.reason, input.deviceId, this.clock.now().toISOString(), revision);
      return { refusal: readRefusal(db, tenant, input.taskId, input.steerMessageId)!, created: true };
    });
  }

  get(tenant: TenantId, taskId: string, steerMessageId: string): Promise<SteerRefusalRecord | undefined> {
    return this.coordinator.run((db) => readRefusal(db, tenant, taskId, steerMessageId));
  }

  list(
    tenant: TenantId,
    query: { readonly taskId: string; readonly afterRevision: number; readonly limit: number },
  ): Promise<readonly SteerRefusalRecord[]> {
    return this.coordinator.run((db) => (db.prepare(
      `SELECT ${STEER_REFUSAL_PROJECTION} WHERE tenant_id = ? AND task_id = ? AND revision > ? ORDER BY revision LIMIT ?`,
    ).all(tenant, query.taskId, query.afterRevision, query.limit) as unknown as SteerRefusalRow[]).map(refusalRow));
  }
}
