import { assertCollectExpiredInput, type CollectExpiredInput, type CollectExpiredResult, type Clock, type TenantId } from '@byok-sdk/core';
import { ByokCloudError } from '../../errors';
import {
  activityEntryBytes, activitySourceHash, activityTailKey, createActivityEntry, validateActivityAppend,
  ACTIVITY_TERMINAL_TTL_MS, DEFAULT_ACTIVITY_CAPACITY, MAX_ACTIVITY_BYTES,
  type ActivityAppendInput, type ActivityReadOptions, type ActivityStore, type ActivityTail,
} from '../../activity';

interface TaskLog { tail: ActivityTail; ttlMs: number; fences: Map<string, string>; removed: boolean }
const LOGS = new WeakMap<InMemoryActivityStore, Map<string, TaskLog>>();

/** Remove content, retaining a fence against resurrection and a cursor gap. */
export function deleteActivityTail(store: InMemoryActivityStore, tenant: TenantId, taskId: string): number {
  const logs = LOGS.get(store)!;
  const key = activityTailKey(tenant, taskId);
  const log = logs.get(key) ?? newLog(tenant, taskId);
  const existed = logs.has(key) && !log.removed;
  log.tail = { ...log.tail, entries: [], retainedBytes: 0, floor: log.tail.cursor.revision };
  log.removed = true;
  logs.set(key, log);
  return existed ? 1 : 0;
}
function newLog(tenant: TenantId, taskId: string): TaskLog {
  return {
    tail: {
      tenantId: tenant, taskId, entries: [],
      cursor: { version: 1, tenantId: tenant, taskId, generation: crypto.randomUUID(), revision: 0 },
      floor: 0, dropped: 0, sourceDropped: 0, capacity: DEFAULT_ACTIVITY_CAPACITY,
      byteCapacity: MAX_ACTIVITY_BYTES, retainedBytes: 0,
    },
    ttlMs: ACTIVITY_TERMINAL_TTL_MS, fences: new Map(), removed: false,
  };
}

export class InMemoryActivityStore implements ActivityStore {
  readonly #logs = new Map<string, TaskLog>();
  constructor(private readonly clock: Clock) { LOGS.set(this, this.#logs); }

  async append(tenant: TenantId, input: ActivityAppendInput): Promise<ActivityTail> {
    const capacity = validateActivityAppend(input);
    // Snapshot caller-owned data before hashing. No await occurs after reading task state:
    // append, settle and redaction therefore share one synchronous commit boundary.
    const snapshot = structuredClone(input);
    const hash = await activitySourceHash(snapshot);
    const key = activityTailKey(tenant, snapshot.taskId);
    const existing = this.#logs.get(key);
    const log = existing ?? newLog(tenant, snapshot.taskId);
    if (log.removed) throw new ByokCloudError('activity_history_gap', 'Activity content was removed.');
    const fence = log.fences.get(snapshot.sourceEnvelopeId);
    if (fence !== undefined) {
      if (fence !== hash) throw new ByokCloudError('coordination_input_invalid', 'Activity source identity conflicts with a previous submission.');
      return structuredClone(this.#expire(log));
    }
    if (log.tail.terminalAt !== undefined) throw new ByokCloudError('activity_task_settled', 'Task activity admission is closed.');
    if (existing !== undefined && (capacity !== log.tail.capacity || (snapshot.byteCapacity ?? MAX_ACTIVITY_BYTES) !== log.tail.byteCapacity || snapshot.ttlMs !== log.ttlMs)) {
      throw new ByokCloudError('coordination_input_invalid', 'Activity retention bounds are fixed by the first append.');
    }
    const revision = log.tail.cursor.revision + 1;
    if (!Number.isSafeInteger(revision)) throw new ByokCloudError('coordination_input_invalid', 'Activity revision exhausted.');
    const entry = createActivityEntry(snapshot, revision, this.clock.now().toISOString());
    const byteCapacity = snapshot.byteCapacity ?? MAX_ACTIVITY_BYTES;
    const bytes = activityEntryBytes(entry);
    if (bytes > byteCapacity) throw new ByokCloudError('activity_batch_too_large', 'Activity entry exceeds its serialized byte cap.');
    const entries = [...log.tail.entries, entry];
    let retainedBytes = log.tail.retainedBytes + bytes;
    let floor = log.tail.floor, evicted = 0;
    while (entries.length > capacity || retainedBytes > byteCapacity) {
      const removed = entries.shift()!;
      retainedBytes -= activityEntryBytes(removed);
      floor = removed.revision;
      evicted++;
    }
    const tail: ActivityTail = {
      ...log.tail, entries, cursor: { ...log.tail.cursor, revision }, floor,
      dropped: log.tail.dropped + evicted,
      sourceDropped: log.tail.sourceDropped + ('dropped' in snapshot ? snapshot.dropped : 0),
      capacity, byteCapacity, retainedBytes,
    };
    log.tail = tail;
    log.ttlMs = snapshot.ttlMs;
    log.fences.set(snapshot.sourceEnvelopeId, hash);
    this.#logs.set(key, log);
    return structuredClone(tail);
  }

  async settle(tenant: TenantId, taskId: string, terminalAt: string): Promise<ActivityTail> {
    const terminalMs = Date.parse(terminalAt);
    if (!Number.isFinite(terminalMs) || new Date(terminalMs).toISOString() !== terminalAt) {
      throw new ByokCloudError('coordination_input_invalid', 'Activity terminal time must be canonical ISO.');
    }
    const key = activityTailKey(tenant, taskId);
    const log = this.#logs.get(key) ?? newLog(tenant, taskId);
    if (log.removed) throw new ByokCloudError('activity_history_gap', 'Activity content was removed.');
    if (log.tail.terminalAt === undefined) {
      log.tail = { ...log.tail, terminalAt, expiresAt: new Date(terminalMs + log.ttlMs).toISOString() };
      this.#logs.set(key, log);
    }
    return structuredClone(this.#expire(log));
  }

  #expire(log: TaskLog): ActivityTail {
    if (log.tail.expiresAt !== undefined && log.tail.expiresAt <= this.clock.now().toISOString()) {
      log.tail = { ...log.tail, entries: [], floor: log.tail.cursor.revision, retainedBytes: 0 };
    }
    return log.tail;
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
    const log = this.#logs.get(activityTailKey(tenant, taskId));
    if (log === undefined || log.removed) {
      if (after !== undefined) throw new ByokCloudError('activity_history_gap', 'Activity history is unavailable.');
      return undefined;
    }
    const tail = this.#expire(log);
    if (after !== undefined && (after.generation !== tail.cursor.generation || after.revision < tail.floor)) {
      throw new ByokCloudError('activity_history_gap', 'Activity cursor is below the retained floor or from another generation.');
    }
    if (after !== undefined && after.revision > tail.cursor.revision) throw new ByokCloudError('activity_cursor_invalid', 'Activity cursor is ahead of the log.');
    if (tail.expiresAt !== undefined && tail.expiresAt <= this.clock.now().toISOString()) {
      if (after !== undefined) throw new ByokCloudError('activity_history_gap', 'Activity history expired.');
      return undefined;
    }
    return structuredClone({ ...tail, entries: tail.entries.filter(entry => entry.revision > (after?.revision ?? 0)) });
  }

  async collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    let removed = 0, more = false;
    for (const log of this.#logs.values()) {
      if (log.tail.tenantId !== tenant || log.tail.expiresAt === undefined || log.tail.expiresAt > input.now || log.tail.entries.length === 0) continue;
      if (removed === input.limit) { more = true; break; }
      log.tail = { ...log.tail, entries: [], floor: log.tail.cursor.revision, retainedBytes: 0 };
      removed++;
    }
    return { removed, expired: 0, releasedBytes: 0n, more };
  }
}
