import { assertCollectExpiredInput, type Clock, type CollectExpiredInput, type CollectExpiredResult, type TenantId } from '@byok-sdk/core';
import {
  ByokCloudError, activityEntryBytes, activitySourceHash, createActivityEntry, validateActivityAppend,
  ACTIVITY_TERMINAL_TTL_MS, DEFAULT_ACTIVITY_CAPACITY, MAX_ACTIVITY_BYTES,
  type ActivityAppendInput, type ActivityReadOptions, type ActivityStore, type ActivityTail, type ActivityTailEntry,
} from '@byok-sdk/cloud';
import type { DatabaseSync } from 'node:sqlite';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Mirrors deploy/sql/0034_activity_log.sql. The generation is minted in code when the head is inserted. */
export const ACTIVITY_LOG_SCHEMA = `
CREATE TABLE activity_log_head (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  generation TEXT NOT NULL CHECK (length(generation) > 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND ${MAX_SAFE}),
  floor INTEGER NOT NULL DEFAULT 0 CHECK (floor >= 0 AND floor <= revision),
  dropped INTEGER NOT NULL DEFAULT 0 CHECK (dropped BETWEEN 0 AND ${MAX_SAFE}),
  source_dropped INTEGER NOT NULL DEFAULT 0 CHECK (source_dropped BETWEEN 0 AND ${MAX_SAFE}),
  capacity INTEGER NOT NULL DEFAULT ${DEFAULT_ACTIVITY_CAPACITY} CHECK (capacity BETWEEN 1 AND ${DEFAULT_ACTIVITY_CAPACITY}),
  byte_capacity INTEGER NOT NULL DEFAULT ${MAX_ACTIVITY_BYTES} CHECK (byte_capacity BETWEEN 1 AND ${MAX_ACTIVITY_BYTES}),
  retained_bytes INTEGER NOT NULL DEFAULT 0 CHECK (retained_bytes BETWEEN 0 AND byte_capacity),
  ttl_ms INTEGER NOT NULL DEFAULT ${ACTIVITY_TERMINAL_TTL_MS} CHECK (ttl_ms BETWEEN 1 AND ${ACTIVITY_TERMINAL_TTL_MS}),
  terminal_at TEXT,
  expires_at TEXT,
  removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1)),
  PRIMARY KEY (tenant_id, task_id),
  CHECK ((terminal_at IS NULL) = (expires_at IS NULL))
);
CREATE INDEX activity_log_expiry ON activity_log_head (tenant_id, expires_at, task_id)
  WHERE retained_bytes > 0 AND expires_at IS NOT NULL;
-- A null body is the immutable source identity fence after eviction/expiry.
CREATE TABLE activity_log_entry (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND ${MAX_SAFE}),
  source_envelope_id TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
  body TEXT CHECK (body IS NULL OR json_valid(body)),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 0 AND ${MAX_ACTIVITY_BYTES}),
  PRIMARY KEY (tenant_id, task_id, revision),
  UNIQUE (tenant_id, task_id, source_envelope_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES activity_log_head (tenant_id, task_id) ON DELETE CASCADE,
  CHECK ((body IS NULL AND byte_size = 0) OR (body IS NOT NULL AND byte_size > 0))
);
CREATE INDEX activity_log_retained ON activity_log_entry (tenant_id, task_id, revision) WHERE body IS NOT NULL;
`;

/** The columns an existing file must hold; a missing table is refused, never recreated. */
export const ACTIVITY_LOG_PROJECTIONS = [
  'tenant_id, task_id, generation, revision, floor, dropped, source_dropped, capacity, byte_capacity, retained_bytes, ttl_ms, terminal_at, expires_at, removed FROM activity_log_head',
  'tenant_id, task_id, revision, source_envelope_id, source_hash, body, byte_size FROM activity_log_entry',
] as const;

interface Coordinator {
  run<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T>;
  transaction<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T>;
}

interface Head {
  readonly tenantId: TenantId;
  readonly taskId: string;
  readonly generation: string;
  readonly revision: number;
  floor: number;
  readonly dropped: number;
  readonly sourceDropped: number;
  readonly capacity: number;
  readonly byteCapacity: number;
  retainedBytes: number;
  readonly ttlMs: number;
  readonly terminalAt: string | null;
  readonly expiresAt: string | null;
  readonly removed: boolean;
}

function malformed(): never {
  throw new ByokCloudError('coordination_input_invalid', 'SQLite activity log authority is malformed.');
}

function integer(value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) malformed();
  return value;
}

function instant(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) malformed();
  return value;
}

function parseHead(row: Record<string, unknown> | undefined, tenant: TenantId, taskId: string): Head | undefined {
  if (row === undefined) return undefined;
  if (row.tenant_id !== tenant || row.task_id !== taskId || typeof row.generation !== 'string' || row.generation.length === 0
    || (row.removed !== 0 && row.removed !== 1)) malformed();
  const head: Head = {
    tenantId: tenant, taskId, generation: row.generation,
    revision: integer(row.revision, 0), floor: integer(row.floor, 0),
    dropped: integer(row.dropped, 0), sourceDropped: integer(row.source_dropped, 0),
    capacity: integer(row.capacity, 1), byteCapacity: integer(row.byte_capacity, 1),
    retainedBytes: integer(row.retained_bytes, 0), ttlMs: integer(row.ttl_ms, 1),
    terminalAt: instant(row.terminal_at), expiresAt: instant(row.expires_at), removed: row.removed === 1,
  };
  if (head.floor > head.revision || (head.terminalAt === null) !== (head.expiresAt === null)) malformed();
  return head;
}

function readHead(db: DatabaseSync, tenant: TenantId, taskId: string): Head | undefined {
  return parseHead(db.prepare('SELECT * FROM activity_log_head WHERE tenant_id = ? AND task_id = ?').get(tenant, taskId), tenant, taskId);
}

function insertHead(db: DatabaseSync, tenant: TenantId, taskId: string): boolean {
  return Number(db.prepare('INSERT INTO activity_log_head (tenant_id, task_id, generation) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
    .run(tenant, taskId, globalThis.crypto.randomUUID()).changes) > 0;
}

function clearExpired(db: DatabaseSync, head: Head, now: string): void {
  if (head.expiresAt === null || head.expiresAt > now || head.retainedBytes === 0) return;
  db.prepare('UPDATE activity_log_entry SET body = NULL, byte_size = 0 WHERE tenant_id = ? AND task_id = ? AND body IS NOT NULL')
    .run(head.tenantId, head.taskId);
  db.prepare('UPDATE activity_log_head SET floor = revision, retained_bytes = 0 WHERE tenant_id = ? AND task_id = ?')
    .run(head.tenantId, head.taskId);
  head.floor = head.revision;
  head.retainedBytes = 0;
}

function parseEntry(row: Record<string, unknown>, head: Head): ActivityTailEntry {
  if (typeof row.body !== 'string') malformed();
  let entry: unknown;
  try { entry = JSON.parse(row.body); } catch { malformed(); }
  if (entry === null || typeof entry !== 'object' || !('kind' in entry)
    || !['progress', 'sealed-progress', 'artifact'].includes(entry.kind as string)
    || !('revision' in entry) || entry.revision !== integer(row.revision, 1)
    || !('taskId' in entry) || entry.taskId !== head.taskId
    || !('sourceEnvelopeId' in entry) || entry.sourceEnvelopeId !== row.source_envelope_id) malformed();
  return entry as ActivityTailEntry;
}

function tail(db: DatabaseSync, head: Head, after = 0): ActivityTail {
  const rows = db.prepare(
    `SELECT revision, source_envelope_id, body FROM activity_log_entry
      WHERE tenant_id = ? AND task_id = ? AND revision > ? AND body IS NOT NULL ORDER BY revision`,
  ).all(head.tenantId, head.taskId, after);
  return {
    tenantId: head.tenantId, taskId: head.taskId, entries: rows.map(row => parseEntry(row, head)),
    cursor: { version: 1, tenantId: head.tenantId, taskId: head.taskId, generation: head.generation, revision: head.revision },
    floor: head.floor, after, dropped: head.dropped, sourceDropped: head.sourceDropped,
    capacity: head.capacity, byteCapacity: head.byteCapacity, retainedBytes: head.retainedBytes,
    ...(head.terminalAt === null ? {} : { terminalAt: head.terminalAt }),
    ...(head.expiresAt === null ? {} : { expiresAt: head.expiresAt }),
  };
}

/**
 * Removes a task's activity content inside the caller's transaction, keeping a
 * removed head so a later append cannot recreate history. Returns 1 when live
 * (not already removed) history existed.
 */
export function removeActivityContent(db: DatabaseSync, tenant: TenantId, taskId: string): number {
  const created = insertHead(db, tenant, taskId);
  const head = readHead(db, tenant, taskId)!;
  db.prepare('UPDATE activity_log_entry SET body = NULL, byte_size = 0 WHERE tenant_id = ? AND task_id = ? AND body IS NOT NULL')
    .run(tenant, taskId);
  db.prepare('UPDATE activity_log_head SET removed = 1, floor = revision, retained_bytes = 0 WHERE tenant_id = ? AND task_id = ?')
    .run(tenant, taskId);
  return !created && !head.removed ? 1 : 0;
}

/** Every operation is one coordinator transaction on the task head; no process-local replay state. */
export class SqliteActivityStore implements ActivityStore {
  constructor(private readonly coordinator: Coordinator, private readonly clock: Clock) {}

  async append(tenant: TenantId, input: ActivityAppendInput): Promise<ActivityTail> {
    const capacity = validateActivityAppend(input);
    const snapshot = structuredClone(input);
    const hash = await activitySourceHash(snapshot);
    const byteCapacity = snapshot.byteCapacity ?? MAX_ACTIVITY_BYTES;
    return this.coordinator.transaction(db => {
      const created = Number(db.prepare(
        `INSERT INTO activity_log_head (tenant_id, task_id, generation, capacity, byte_capacity, ttl_ms)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).run(tenant, snapshot.taskId, globalThis.crypto.randomUUID(), capacity, byteCapacity, snapshot.ttlMs).changes) > 0;
      const head = readHead(db, tenant, snapshot.taskId)!;
      if (head.removed) throw new ByokCloudError('activity_history_gap', 'Activity content was removed.');
      const previous = db.prepare(
        'SELECT source_hash FROM activity_log_entry WHERE tenant_id = ? AND task_id = ? AND source_envelope_id = ?',
      ).get(tenant, snapshot.taskId, snapshot.sourceEnvelopeId);
      if (previous !== undefined) {
        if (previous.source_hash !== hash) throw new ByokCloudError('coordination_input_invalid', 'Activity source identity conflicts with a previous submission.');
        clearExpired(db, head, this.clock.now().toISOString());
        return tail(db, head);
      }
      if (head.terminalAt !== null) throw new ByokCloudError('activity_task_settled', 'Task activity admission is closed.');
      if (!created && (head.capacity !== capacity || head.byteCapacity !== byteCapacity || head.ttlMs !== snapshot.ttlMs)) {
        throw new ByokCloudError('coordination_input_invalid', 'Activity retention bounds are fixed by the first append.');
      }
      const revision = head.revision + 1;
      if (!Number.isSafeInteger(revision)) throw new ByokCloudError('coordination_input_invalid', 'Activity revision exhausted.');
      const entry = createActivityEntry(snapshot, revision, this.clock.now().toISOString());
      const bytes = activityEntryBytes(entry);
      if (bytes > byteCapacity) throw new ByokCloudError('activity_batch_too_large', 'Activity entry exceeds its serialized byte cap.');
      db.prepare(
        `INSERT INTO activity_log_entry (tenant_id, task_id, revision, source_envelope_id, source_hash, body, byte_size)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(tenant, snapshot.taskId, revision, snapshot.sourceEnvelopeId, hash, JSON.stringify(entry), bytes);
      const retained = db.prepare(
        'SELECT revision, byte_size FROM activity_log_entry WHERE tenant_id = ? AND task_id = ? AND body IS NOT NULL ORDER BY revision',
      ).all(tenant, snapshot.taskId).map(row => ({ revision: integer(row.revision, 1), byteSize: integer(row.byte_size, 1) }));
      let retainedBytes = head.retainedBytes + bytes, evicted = 0, floor = head.floor;
      while (retained.length - evicted > capacity || retainedBytes > byteCapacity) {
        const oldest = retained[evicted++]!;
        retainedBytes -= oldest.byteSize;
        floor = oldest.revision;
      }
      if (evicted > 0) db.prepare(
        'UPDATE activity_log_entry SET body = NULL, byte_size = 0 WHERE tenant_id = ? AND task_id = ? AND revision <= ? AND body IS NOT NULL',
      ).run(tenant, snapshot.taskId, floor);
      const updated = db.prepare(
        `UPDATE activity_log_head SET revision = ?, floor = ?, retained_bytes = ?, dropped = dropped + ?, source_dropped = source_dropped + ?
          WHERE tenant_id = ? AND task_id = ? RETURNING *`,
      ).get(revision, floor, retainedBytes, evicted, 'dropped' in snapshot ? snapshot.dropped : 0, tenant, snapshot.taskId);
      return tail(db, parseHead(updated, tenant, snapshot.taskId)!);
    });
  }

  async settle(tenant: TenantId, taskId: string, terminalAt: string): Promise<ActivityTail> {
    const terminalMs = Date.parse(terminalAt);
    if (!Number.isFinite(terminalMs) || new Date(terminalMs).toISOString() !== terminalAt) {
      throw new ByokCloudError('coordination_input_invalid', 'Activity terminal time must be canonical ISO.');
    }
    return this.coordinator.transaction(db => {
      insertHead(db, tenant, taskId);
      let head = readHead(db, tenant, taskId)!;
      if (head.removed) throw new ByokCloudError('activity_history_gap', 'Activity content was removed.');
      if (head.terminalAt === null) head = parseHead(db.prepare(
        'UPDATE activity_log_head SET terminal_at = ?, expires_at = ? WHERE tenant_id = ? AND task_id = ? RETURNING *',
      ).get(terminalAt, new Date(terminalMs + head.ttlMs).toISOString(), tenant, taskId), tenant, taskId)!;
      clearExpired(db, head, this.clock.now().toISOString());
      return tail(db, head);
    });
  }

  async read(tenant: TenantId, taskId: string, options: ActivityReadOptions = {}): Promise<ActivityTail | undefined> {
    const after = options.after;
    if (after !== undefined) {
      const cursor = after as unknown;
      if (cursor !== null && typeof cursor === 'object' && !('version' in cursor)
        && 'batchSeq' in cursor && Number.isSafeInteger(cursor.batchSeq) && Number(cursor.batchSeq) >= 0
        && 'eventIndex' in cursor && Number.isSafeInteger(cursor.eventIndex) && Number(cursor.eventIndex) >= 0) {
        throw new ByokCloudError('activity_history_gap', 'Activity cursor predates this log generation.');
      }
      if (cursor === null || typeof cursor !== 'object' || after.version !== 1
        || after.tenantId !== tenant || after.taskId !== taskId || !Number.isSafeInteger(after.revision)
        || after.revision < 0 || typeof after.generation !== 'string' || after.generation.length === 0) {
        throw new ByokCloudError('activity_cursor_invalid', 'Invalid activity cursor.');
      }
    }
    return this.coordinator.transaction(db => {
      const head = readHead(db, tenant, taskId);
      if (head === undefined || head.removed) {
        if (after !== undefined) throw new ByokCloudError('activity_history_gap', 'Activity history is unavailable.');
        return undefined;
      }
      const now = this.clock.now().toISOString();
      clearExpired(db, head, now);
      if (after !== undefined && (after.generation !== head.generation || after.revision < head.floor)) {
        throw new ByokCloudError('activity_history_gap', 'Activity cursor is below the retained floor or from another generation.');
      }
      if (after !== undefined && after.revision > head.revision) throw new ByokCloudError('activity_cursor_invalid', 'Activity cursor is ahead of the log.');
      if (head.expiresAt !== null && head.expiresAt <= now) {
        if (after !== undefined) throw new ByokCloudError('activity_history_gap', 'Activity history expired.');
        return undefined;
      }
      return tail(db, head, after?.revision);
    });
  }

  async collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    return this.coordinator.transaction(db => {
      const rows = db.prepare(
        `SELECT * FROM activity_log_head WHERE tenant_id = ? AND expires_at <= ? AND retained_bytes > 0
          ORDER BY expires_at, task_id LIMIT ?`,
      ).all(tenant, input.now, input.limit + 1);
      for (const row of rows.slice(0, input.limit)) {
        if (typeof row.task_id !== 'string') malformed();
        clearExpired(db, parseHead(row, tenant, row.task_id)!, input.now);
      }
      return { removed: Math.min(rows.length, input.limit), expired: 0, releasedBytes: 0n, more: rows.length > input.limit };
    });
  }
}
