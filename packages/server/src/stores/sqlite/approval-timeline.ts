import { assertCollectExpiredInput, type Clock, type CollectExpiredInput, type CollectExpiredResult, type TenantId } from '@byok-sdk/core';
import {
  ApprovalObservationSchema, ByokCloudError, approvalTimelineCursor, parseApprovalObservations,
  pendingApproval, sameApprovalTimelineEvent, validateApprovalTimelineAppend, validateApprovalTimelineResolve,
  type ApprovalTimelineAppendInput, type ApprovalTimelineResolvePendingInput,
  type ApprovalTimelineResolvePendingResult, type ApprovalTimelineStore, type ApprovalTimelineTail,
} from '@byok-sdk/cloud';
import type { DatabaseSync } from 'node:sqlite';

export const APPROVAL_TIMELINE_SCHEMA = `
CREATE TABLE approval_timeline_tail (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  entries_json TEXT NOT NULL,
  next_revision INTEGER NOT NULL CHECK (next_revision > 0),
  dropped INTEGER NOT NULL CHECK (dropped >= 0),
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, task_id)
);
CREATE INDEX approval_timeline_expiry ON approval_timeline_tail (tenant_id, expires_at, task_id);
`;

interface Coordinator {
  run<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T>;
  transaction<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T>;
}

function invalid(): never {
  throw new ByokCloudError('coordination_input_invalid', 'SQLite approval timeline authority is malformed.');
}

function readTail(db: DatabaseSync, tenant: TenantId, taskId: string): ApprovalTimelineTail | undefined {
  const row = db.prepare('SELECT * FROM approval_timeline_tail WHERE tenant_id = ? AND task_id = ?').get(tenant, taskId);
  if (row === undefined) return undefined;
  if (typeof row.entries_json !== 'string' || typeof row.expires_at !== 'string' ||
      !Number.isFinite(Date.parse(row.expires_at)) || new Date(row.expires_at).toISOString() !== row.expires_at ||
      typeof row.next_revision !== 'number' || !Number.isSafeInteger(row.next_revision) || row.next_revision <= 0 ||
      typeof row.capacity !== 'number' || !Number.isSafeInteger(row.capacity) || row.capacity <= 0 ||
      typeof row.dropped !== 'number' || !Number.isSafeInteger(row.dropped) || row.dropped < 0) invalid();
  const entries = parseApprovalObservations(JSON.parse(row.entries_json));
  const cursor = approvalTimelineCursor(entries);
  if (entries.length === 0 || entries.length > row.capacity || cursor !== row.next_revision - 1 ||
      entries.some((entry, index) => entry.taskId !== taskId || !Number.isSafeInteger(entry.revision) ||
        (index > 0 && entry.revision !== entries[index - 1]!.revision + 1))) invalid();
  return { tenantId: tenant, taskId, entries, cursor, dropped: row.dropped, capacity: row.capacity, expiresAt: row.expires_at };
}

function persist(
  db: DatabaseSync, tenant: TenantId, input: ApprovalTimelineAppendInput,
  validated: ReturnType<typeof validateApprovalTimelineAppend>, now: Date, live?: ApprovalTimelineTail,
): ApprovalTimelineTail {
  const revision = (live?.cursor ?? 0) + 1;
  if (!Number.isSafeInteger(revision + 1)) invalid();
  const observation = ApprovalObservationSchema.parse({
    taskId: input.taskId, sourceEnvelopeId: input.sourceEnvelopeId,
    revision, receivedAt: now.toISOString(), event: validated.event,
  });
  const all = [...(live?.entries ?? []), observation];
  const evicted = Math.max(0, all.length - validated.capacity);
  const tail: ApprovalTimelineTail = {
    tenantId: tenant, taskId: input.taskId, entries: all.slice(evicted), cursor: revision,
    dropped: (live?.dropped ?? 0) + evicted, capacity: validated.capacity,
    expiresAt: new Date(now.getTime() + validated.ttlMs).toISOString(),
  };
  db.prepare(`INSERT INTO approval_timeline_tail
    (tenant_id, task_id, entries_json, next_revision, dropped, capacity, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, task_id) DO UPDATE SET
    entries_json = excluded.entries_json, next_revision = excluded.next_revision,
    dropped = excluded.dropped, capacity = excluded.capacity, expires_at = excluded.expires_at`)
    .run(tenant, input.taskId, JSON.stringify(tail.entries), revision + 1, tail.dropped, tail.capacity, tail.expiresAt);
  return tail;
}

export class SqliteApprovalTimelineStore implements ApprovalTimelineStore {
  constructor(private readonly coordinator: Coordinator, private readonly clock: Clock) {}

  async append(tenant: TenantId, input: ApprovalTimelineAppendInput): Promise<ApprovalTimelineTail> {
    const validated = validateApprovalTimelineAppend(input);
    return this.coordinator.transaction(db => {
      const now = this.clock.now();
      const stored = readTail(db, tenant, input.taskId);
      const live = stored !== undefined && now.toISOString() < stored.expiresAt ? stored : undefined;
      const duplicate = live?.entries.find(entry => entry.sourceEnvelopeId === input.sourceEnvelopeId);
      if (duplicate !== undefined) {
        if (!sameApprovalTimelineEvent(duplicate.event, validated.event)) {
          throw new ByokCloudError('coordination_input_invalid', 'Approval source envelope identity already belongs to another lifecycle event.');
        }
        return live!;
      }
      return persist(db, tenant, input, validated, now, live);
    });
  }

  async resolvePending(tenant: TenantId, input: ApprovalTimelineResolvePendingInput): Promise<ApprovalTimelineResolvePendingResult> {
    const validated = validateApprovalTimelineResolve(input);
    return this.coordinator.transaction(db => {
      const now = this.clock.now();
      const live = readTail(db, tenant, input.taskId);
      if (live === undefined || now.toISOString() >= live.expiresAt) return { status: 'absent' };
      const duplicate = live.entries.find(entry => entry.sourceEnvelopeId === input.sourceEnvelopeId);
      if (duplicate !== undefined) {
        return { status: sameApprovalTimelineEvent(duplicate.event, validated.event) ? 'replayed' : 'conflict', tail: live };
      }
      const pending = pendingApproval(live);
      if (pending === undefined) return { status: 'absent', tail: live };
      if (pending.sourceEnvelopeId !== input.expectedSourceEnvelopeId || pending.revision !== input.expectedRevision) {
        return { status: 'superseded', tail: live };
      }
      return { status: 'applied', tail: persist(db, tenant, input, validated, now, live) };
    });
  }

  read(tenant: TenantId, taskId: string): Promise<ApprovalTimelineTail | undefined> {
    return this.coordinator.run(db => {
      const tail = readTail(db, tenant, taskId);
      if (tail === undefined) return undefined;
      if (this.clock.now().toISOString() >= tail.expiresAt) {
        db.prepare('DELETE FROM approval_timeline_tail WHERE tenant_id = ? AND task_id = ?').run(tenant, taskId);
        return undefined;
      }
      return tail;
    });
  }

  async collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    return this.coordinator.transaction(db => {
      const candidates = db.prepare(`SELECT task_id FROM approval_timeline_tail
        WHERE tenant_id = ? AND expires_at <= ? ORDER BY expires_at, task_id LIMIT ?`)
        .all(tenant, input.now, input.limit + 1);
      const remove = db.prepare('DELETE FROM approval_timeline_tail WHERE tenant_id = ? AND task_id = ?');
      for (const row of candidates.slice(0, input.limit)) remove.run(tenant, row.task_id!);
      return { removed: Math.min(candidates.length, input.limit), expired: 0, releasedBytes: 0n, more: candidates.length > input.limit };
    });
  }
}
