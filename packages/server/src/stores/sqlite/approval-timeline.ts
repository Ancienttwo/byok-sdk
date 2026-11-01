import { assertCollectExpiredInput, type Clock, type CollectExpiredInput, type CollectExpiredResult, type TenantId } from '@byok-sdk/core';
import {
  ApprovalObservationSchema, ByokCloudError, approvalTimelineCursor, parseApprovalObservations,
  pendingApproval, retainApprovalObservations, sameApprovalTimelineEvent, validateApprovalTimelineAppend, validateApprovalTimelineResolve,
  type ApprovalTimelineAppendInput, type ApprovalTimelineResolvePendingInput,
  type ApprovalTimelineResolvePendingResult, type ApprovalTimelineStore, type ApprovalTimelineTail,
} from '@byok-sdk/cloud';
import type { DatabaseSync } from 'node:sqlite';

/**
 * `terminal_at`/`expires_at` are set by the output closure trigger when the
 * task's output closes; an open timeline never expires (#1113 A3). A closed
 * row stays as a fence after its observations are cleared.
 */
export const APPROVAL_TIMELINE_SCHEMA = `
CREATE TABLE approval_timeline_tail (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  entries_json TEXT NOT NULL,
  next_revision INTEGER NOT NULL CHECK (next_revision > 0),
  dropped INTEGER NOT NULL CHECK (dropped >= 0),
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  terminal_at TEXT,
  expires_at TEXT,
  PRIMARY KEY (tenant_id, task_id),
  CHECK ((terminal_at IS NULL) = (expires_at IS NULL))
);
CREATE INDEX approval_timeline_expiry ON approval_timeline_tail (tenant_id, expires_at, task_id) WHERE expires_at IS NOT NULL;
`;

/** The 7->8 step: the idle expiry column goes, every retained observation stays. */
export const APPROVAL_TIMELINE_V7_REBUILD = `
ALTER TABLE approval_timeline_tail RENAME TO approval_timeline_tail_v7;
DROP INDEX approval_timeline_expiry;
${APPROVAL_TIMELINE_SCHEMA}
INSERT INTO approval_timeline_tail (tenant_id, task_id, entries_json, next_revision, dropped, capacity)
SELECT tenant_id, task_id, entries_json, next_revision, dropped, capacity FROM approval_timeline_tail_v7;
DROP TABLE approval_timeline_tail_v7;
`;

interface Coordinator {
  run<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T>;
  transaction<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T>;
}

function invalid(): never {
  throw new ByokCloudError('coordination_input_invalid', 'SQLite approval timeline authority is malformed.');
}

function canonicalInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function readTail(db: DatabaseSync, tenant: TenantId, taskId: string): ApprovalTimelineTail | undefined {
  const row = db.prepare('SELECT * FROM approval_timeline_tail WHERE tenant_id = ? AND task_id = ?').get(tenant, taskId);
  if (row === undefined) return undefined;
  const closed = row.terminal_at !== null;
  if (typeof row.entries_json !== 'string' ||
      (closed ? !canonicalInstant(row.terminal_at) || !canonicalInstant(row.expires_at) : row.expires_at !== null) ||
      typeof row.next_revision !== 'number' || !Number.isSafeInteger(row.next_revision) || row.next_revision <= 0 ||
      typeof row.capacity !== 'number' || !Number.isSafeInteger(row.capacity) || row.capacity <= 0 ||
      typeof row.dropped !== 'number' || !Number.isSafeInteger(row.dropped) || row.dropped < 0) invalid();
  const entries = parseApprovalObservations(JSON.parse(row.entries_json));
  const cursor = approvalTimelineCursor(entries);
  // Only a closed timeline is empty: closing creates it, and clearing keeps it as a fence.
  if ((entries.length === 0 && !closed) || entries.length > row.capacity ||
      (cursor !== undefined && cursor !== row.next_revision - 1) ||
      entries.some((entry, index) => entry.taskId !== taskId || !Number.isSafeInteger(entry.revision) ||
        (index > 0 && entry.revision <= entries[index - 1]!.revision))) invalid();
  return {
    tenantId: tenant, taskId, entries, ...(cursor === undefined ? {} : { cursor }), dropped: row.dropped, capacity: row.capacity,
    ...(closed ? { terminalAt: row.terminal_at as string, expiresAt: row.expires_at as string } : {}),
  };
}

function expired(tail: ApprovalTimelineTail, now: string): boolean {
  return tail.expiresAt !== undefined && tail.expiresAt <= now;
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
  const retained = retainApprovalObservations(live?.entries ?? [], observation, validated.capacity);
  const tail: ApprovalTimelineTail = {
    tenantId: tenant, taskId: input.taskId, entries: retained.entries, cursor: revision,
    dropped: (live?.dropped ?? 0) + retained.evicted, capacity: validated.capacity,
  };
  db.prepare(`INSERT INTO approval_timeline_tail
    (tenant_id, task_id, entries_json, next_revision, dropped, capacity)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, task_id) DO UPDATE SET
    entries_json = excluded.entries_json, next_revision = excluded.next_revision,
    dropped = excluded.dropped, capacity = excluded.capacity`)
    .run(tenant, input.taskId, JSON.stringify(tail.entries), revision + 1, tail.dropped, tail.capacity);
  return tail;
}

export class SqliteApprovalTimelineStore implements ApprovalTimelineStore {
  constructor(private readonly coordinator: Coordinator, private readonly clock: Clock) {}

  async append(tenant: TenantId, input: ApprovalTimelineAppendInput): Promise<ApprovalTimelineTail> {
    const validated = validateApprovalTimelineAppend(input);
    return this.coordinator.transaction(db => {
      const now = this.clock.now();
      const stored = readTail(db, tenant, input.taskId);
      const duplicate = stored === undefined || expired(stored, now.toISOString())
        ? undefined : stored.entries.find(entry => entry.sourceEnvelopeId === input.sourceEnvelopeId);
      if (duplicate !== undefined) {
        if (!sameApprovalTimelineEvent(duplicate.event, validated.event)) {
          throw new ByokCloudError('coordination_input_invalid', 'Approval source envelope identity already belongs to another lifecycle event.');
        }
        return stored!;
      }
      if (stored?.terminalAt !== undefined) {
        throw new ByokCloudError('approval_timeline_settled', 'The task output closed; its approval timeline admits no observation.');
      }
      return persist(db, tenant, input, validated, now, stored);
    });
  }

  async resolvePending(tenant: TenantId, input: ApprovalTimelineResolvePendingInput): Promise<ApprovalTimelineResolvePendingResult> {
    const validated = validateApprovalTimelineResolve(input);
    return this.coordinator.transaction(db => {
      const now = this.clock.now();
      const live = readTail(db, tenant, input.taskId);
      if (live === undefined || expired(live, now.toISOString())) return { status: 'absent' };
      const duplicate = live.entries.find(entry => entry.sourceEnvelopeId === input.sourceEnvelopeId);
      if (duplicate !== undefined) {
        return { status: sameApprovalTimelineEvent(duplicate.event, validated.event) ? 'replayed' : 'conflict', tail: live };
      }
      // A closed timeline has no request left to decide.
      const pending = live.terminalAt === undefined ? pendingApproval(live) : undefined;
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
      return tail === undefined || expired(tail, this.clock.now().toISOString()) ? undefined : tail;
    });
  }

  /** Clears expired observations and keeps each closed row as its fence. */
  async collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    return this.coordinator.transaction(db => {
      const candidates = db.prepare(`SELECT task_id FROM approval_timeline_tail
        WHERE tenant_id = ? AND expires_at <= ? AND entries_json <> '[]' ORDER BY expires_at, task_id LIMIT ?`)
        .all(tenant, input.now, input.limit + 1);
      const clear = db.prepare("UPDATE approval_timeline_tail SET entries_json = '[]' WHERE tenant_id = ? AND task_id = ?");
      for (const row of candidates.slice(0, input.limit)) clear.run(tenant, row.task_id!);
      return { removed: Math.min(candidates.length, input.limit), expired: 0, releasedBytes: 0n, more: candidates.length > input.limit };
    });
  }
}
