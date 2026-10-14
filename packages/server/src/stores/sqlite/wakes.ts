import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { TenantId } from '@byok-sdk/core';
import { WAKE_RETENTION_MS, type WakeScheduleInput, type WakeScheduleResult } from '../../wakes/types';
import { assertCollectLimit, assertWakeContent, type StoredWake, type WakeStore } from '../../wakes/store';

export const WAKE_SCHEMA = `
CREATE TABLE wake (
  tenant_id TEXT NOT NULL,
  wake_id TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  available_at INTEGER NOT NULL,
  payload TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'done')),
  due_at INTEGER NOT NULL,
  retry_at INTEGER,
  deliveries INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  done_at INTEGER,
  PRIMARY KEY (tenant_id, wake_id),
  UNIQUE (tenant_id, dedup_key)
);
CREATE INDEX wake_due ON wake (tenant_id, state, due_at, wake_id);
CREATE INDEX wake_done ON wake (tenant_id, state, done_at);
`;
interface Coordinator {
  run<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T>;
  transaction<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T>;
}
interface Row extends Record<string, unknown> {
  wake_id: string; dedup_key: string; available_at: number; payload: string | null;
  state: 'queued' | 'done'; due_at: number; retry_at: number | null;
  deliveries: number; last_error: string | null; done_at: number | null;
}
function fromRow(row: Row): StoredWake {
  return { wakeId: row.wake_id, dedupKey: row.dedup_key, availableAt: row.available_at, state: row.state,
    dueAt: row.due_at, deliveries: row.deliveries,
    ...(row.payload === null ? {} : { payload: row.payload }),
    ...(row.retry_at === null ? {} : { retryAt: row.retry_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    ...(row.done_at === null ? {} : { doneAt: row.done_at }) };
}
export class SqliteWakeStore implements WakeStore {
  constructor(readonly coordinator: Coordinator, readonly tenant: TenantId) {}
  schedule(input: WakeScheduleInput, _now: number): Promise<WakeScheduleResult> {
    return this.coordinator.transaction(db => {
      const row = db.prepare('SELECT * FROM wake WHERE tenant_id = ? AND dedup_key = ?').get(this.tenant, input.dedupKey) as Row | undefined;
      if (row) { assertWakeContent(fromRow(row), input); return { wakeId: row.wake_id, accepted: false }; }
      const id = randomUUID();
      db.prepare("INSERT INTO wake (tenant_id, wake_id, dedup_key, available_at, payload, state, due_at, deliveries) VALUES (?, ?, ?, ?, ?, 'queued', ?, 0)")
        .run(this.tenant, id, input.dedupKey, input.availableAt, input.payload ?? null, input.availableAt);
      return { wakeId: id, accepted: true };
    });
  }
  cancel(key: string): Promise<boolean> {
    return this.coordinator.transaction(db => db.prepare("DELETE FROM wake WHERE tenant_id = ? AND dedup_key = ? AND state = 'queued'").run(this.tenant, key).changes > 0);
  }
  pending(): Promise<readonly StoredWake[]> {
    return this.coordinator.run(db => (db.prepare("SELECT * FROM wake WHERE tenant_id = ? AND state = 'queued' ORDER BY due_at, wake_id").all(this.tenant) as Row[]).map(fromRow));
  }
  nextDueAt(): Promise<number | undefined> {
    return this.coordinator.run(db => (db.prepare("SELECT due_at FROM wake WHERE tenant_id = ? AND state = 'queued' ORDER BY due_at, wake_id LIMIT 1").get(this.tenant) as { due_at: number } | undefined)?.due_at);
  }
  beginDelivery(now: number): Promise<StoredWake | undefined> {
    return this.coordinator.transaction(db => {
      const row = db.prepare("SELECT * FROM wake WHERE tenant_id = ? AND state = 'queued' AND due_at <= ? ORDER BY due_at, wake_id LIMIT 1").get(this.tenant, now) as Row | undefined;
      if (!row) return undefined;
      db.prepare('UPDATE wake SET deliveries = deliveries + 1 WHERE tenant_id = ? AND wake_id = ?').run(this.tenant, row.wake_id);
      return fromRow({ ...row, deliveries: row.deliveries + 1 });
    });
  }
  complete(id: string, now: number): Promise<void> {
    return this.coordinator.transaction(db => { db.prepare("UPDATE wake SET state = 'done', done_at = ? WHERE tenant_id = ? AND wake_id = ? AND state = 'queued'").run(now, this.tenant, id); });
  }
  reject(id: string, retryAt: number, lastError: string): Promise<void> {
    return this.coordinator.transaction(db => { db.prepare("UPDATE wake SET due_at = ?, retry_at = ?, last_error = ? WHERE tenant_id = ? AND wake_id = ? AND state = 'queued'").run(retryAt, retryAt, lastError, this.tenant, id); });
  }
  async collectExpired(now: number, limit: number): Promise<number> {
    assertCollectLimit(now, limit);
    return this.coordinator.transaction(db => Number(db.prepare("DELETE FROM wake WHERE tenant_id = ? AND wake_id IN (SELECT wake_id FROM wake WHERE tenant_id = ? AND state = 'done' AND done_at < ? ORDER BY done_at, wake_id LIMIT ?)")
      .run(this.tenant, this.tenant, now - WAKE_RETENTION_MS, limit).changes));
  }
}
