import { DatabaseSync } from 'node:sqlite';
import type { MemoryIntentRow } from './memory';
import { hash, taskId, time, type LedgerState, type Occurrence } from './model';

export interface ProjectionOutboxLimits { maxCount?: number; maxBytes?: number }
export interface HostLedgerOptions { projectionOutboxLimits?: ProjectionOutboxLimits }
export interface ProjectionOutboxUsage { count: number; bytes: number }
/** Capacity refusal contains no projection identity or payload. */
export class OutboxFullError extends Error {
  readonly code = 'outbox_full' as const;
  constructor() { super('Projection outbox capacity exceeded'); this.name = 'OutboxFullError'; }
}
function projectionUsage(state: LedgerState): ProjectionOutboxUsage {
  let count = 0, bytes = 0;
  for (const [key, row] of Object.entries(state.outbox)) {
    if (row.kind !== 'projection') continue;
    count++;
    // Stable persisted payload only: retry diagnostics must not block delivery recovery.
    bytes += Buffer.byteLength(JSON.stringify([key, { kind: row.kind, id: row.id, value: row.value }]), 'utf8');
  }
  return { count, bytes };
}

export const MIN_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export type TombstoneKind = 'intent' | 'application' | 'slot';
/** The core derives each routine occurrence intent key from its occurrence key (a SHA-256 hex digest). */
const OCCURRENCE_INTENT_KEY = /^occurrence:[0-9a-f]{64}$/;
/** A retired intent key, or a routine occurrence key outside its occurrence, cannot admit new work. */
export class RetiredIntentIdentityError extends Error {
  readonly code = 'retired_intent_identity' as const;
  constructor() {
    super('Retired intent identity cannot be reused');
    this.name = 'RetiredIntentIdentityError';
  }
}
export interface CompactionOptions {
  /** Explicit acknowledgement that these results may be removed under the Host's retention policy. */
  acknowledgedIntentKeys: readonly string[];
  /** Settled Host job or Host occurrence rows without an intent; promoted occurrences are selected through their intent. */
  acknowledgedOccurrenceKeys?: readonly string[];
  /** Terminal memory intents whose readback the Host has acknowledged. */
  acknowledgedMemoryIntentIds?: readonly string[];
  now: number;
  tombstoneRetentionMs: number;
}
export interface CompactionResult {
  compactedIntents: number;
  alreadyCompactedIntents: number;
  executions: number;
  occurrences: number;
  memoryIntents: number;
  alreadyCompactedMemoryIntents: number;
  expiredTombstones: number;
  beforeBytes: number;
  afterBytes: number;
}

function empty(): LedgerState {
  return { version: 1, sequence: 0, scanSequence: 0, intents: {}, executions: {}, routines: {},
    occurrences: {}, slots: {}, outbox: {}, applied: {}, application: {}, scanWake: null };
}

/** Small single-owner reference. Keep this database separate from the SDK and Agent home. */
export class HostLedger {
  private readonly db: DatabaseSync;
  private readonly outboxListeners = new Set<() => void>();
  /** Post-commit hints for newly inserted projections. The durable outbox is the authority. */
  onOutbox(listener: () => void): () => void {
    this.outboxListeners.add(listener);
    return () => { this.outboxListeners.delete(listener); };
  }
  private readonly projectionLimits?: Readonly<ProjectionOutboxLimits>;
  constructor(filename: string, readonly tenant: string, options: HostLedgerOptions = {}) {
    if (options.projectionOutboxLimits !== undefined) {
      const { maxCount, maxBytes } = options.projectionOutboxLimits;
      if (maxCount === undefined && maxBytes === undefined) throw new Error('Supply a projection outbox limit');
      for (const value of [maxCount, maxBytes]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Projection outbox limits must be nonnegative safe integers');
      }
      this.projectionLimits = Object.freeze({ maxCount, maxBytes });
    }
    if (!filename || !tenant.trim()) throw new Error('Select a Host database and tenant');
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS host_ledger (tenant TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_retired_identity (
        tenant TEXT NOT NULL, kind TEXT NOT NULL, identity TEXT NOT NULL, expires_at INTEGER,
        PRIMARY KEY (tenant, kind, identity));
      CREATE INDEX IF NOT EXISTS host_retired_expiry ON host_retired_identity (tenant, expires_at);
      CREATE TABLE IF NOT EXISTS host_retired_memory_intent (
        tenant TEXT NOT NULL, intent_id TEXT NOT NULL, approval TEXT NOT NULL, body TEXT NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY (tenant, intent_id));
      CREATE INDEX IF NOT EXISTS host_retired_memory_approval ON host_retired_memory_intent (tenant, approval);
      CREATE INDEX IF NOT EXISTS host_retired_memory_expiry ON host_retired_memory_intent (tenant, expires_at);`);
    this.db.prepare('INSERT OR IGNORE INTO host_ledger VALUES (?, ?)').run(tenant, JSON.stringify(empty()));
  }
  snapshot(): LedgerState {
    const row = this.db.prepare('SELECT body FROM host_ledger WHERE tenant=?').get(this.tenant);
    if (typeof row?.body !== 'string') throw new Error('Missing Host ledger');
    const state = JSON.parse(row.body) as LedgerState;
    if (state.version !== 1) throw new Error('Unsupported Host ledger version');
    return state;
  }
  projectionOutboxUsage(): ProjectionOutboxUsage { return projectionUsage(this.snapshot()); }
  transaction<T>(apply: (state: LedgerState) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    let result: T;
    let added = false;
    try {
      const state = this.snapshot();
      const existing = new Set(Object.keys(state.intents));
      const prior = new Set(Object.keys(state.outbox));
      const before = this.projectionLimits && projectionUsage(state);
      result = apply(state);
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Host transactions must be synchronous');
      // Also covers callers of the exported pure enqueue/recordOccurrence transitions.
      const retired = this.db.prepare("SELECT 1 FROM host_retired_identity WHERE tenant=? AND kind='intent' AND identity=?");
      for (const [id, intent] of Object.entries(state.intents)) {
        if (existing.has(id)) continue;
        // A derived routine key enters only with its own occurrence, so an expired routine row cannot reopen work.
        if (retired.get(this.tenant, id) || OCCURRENCE_INTENT_KEY.test(intent.key) && (intent.key !== `occurrence:${intent.occurrence}`
          || state.occurrences[intent.occurrence!]?.intentId !== id)) throw new RetiredIntentIdentityError();
      }
      if (this.projectionLimits && before) {
        const after = projectionUsage(state);
        const countLimit = this.projectionLimits.maxCount ?? Infinity;
        const byteLimit = this.projectionLimits.maxBytes ?? Infinity;
        const recovering = before.count > countLimit || before.bytes > byteLimit;
        if (recovering ? after.count > before.count || after.bytes > before.bytes
          : after.count > countLimit || after.bytes > byteLimit) throw new OutboxFullError();
      }
      this.db.prepare('UPDATE host_ledger SET body=? WHERE tenant=?').run(JSON.stringify(state), this.tenant);
      added = Object.entries(state.outbox).some(([key, row]) => row.kind === 'projection' && !prior.has(key));
      result = structuredClone(result);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (added) for (const listener of [...this.outboxListeners]) { try { listener(); } catch { /* Hints cannot roll back committed state. */ } }
    return result;
  }
  /** Replay evidence is time-bounded. Caller intent identities are permanent; routine occurrence identities expire with their slot. */
  hasTombstone(kind: TombstoneKind, identity: string, now: number): boolean {
    time(now);
    return !!this.db.prepare(`SELECT 1 FROM host_retired_identity
      WHERE tenant=? AND kind=? AND identity=? AND (expires_at IS NULL OR expires_at>?)`)
      .get(this.tenant, kind, hash(identity), now);
  }
  /** A compacted terminal memory row answers replays until it expires. `approval` is the key used in `memory.approvals`. */
  retiredMemoryIntent(by: 'intent' | 'approval', identity: string, now: number): MemoryIntentRow | undefined {
    time(now);
    const row = this.db.prepare(`SELECT body FROM host_retired_memory_intent WHERE tenant=? AND ${by === 'intent' ? 'intent_id' : 'approval'}=?
      AND expires_at>? ORDER BY expires_at DESC LIMIT 1`).get(this.tenant, identity, now);
    return typeof row?.body === 'string' ? JSON.parse(row.body) as MemoryIntentRow : undefined;
  }
  /** Explicit, transactional removal of acknowledged settled core history. Never runs automatically. */
  compact(options: CompactionOptions): CompactionResult {
    const now = time(options.now), retention = time(options.tombstoneRetentionMs);
    if (retention < MIN_TOMBSTONE_RETENTION_MS) throw new Error('Tombstone retention must be at least seven days');
    const expiresAt = time(now + retention);
    if (!Array.isArray(options.acknowledgedIntentKeys)) throw new Error('Acknowledged intent keys must be an array');
    const keys = [...new Set(options.acknowledgedIntentKeys)];
    if (keys.some(key => typeof key !== 'string' || !key.trim())) throw new Error('Invalid acknowledged intent key');
    if (options.acknowledgedOccurrenceKeys !== undefined && !Array.isArray(options.acknowledgedOccurrenceKeys)) throw new Error('Acknowledged occurrence keys must be an array');
    const occurrenceKeys = [...new Set(options.acknowledgedOccurrenceKeys ?? [])];
    if (occurrenceKeys.some(key => typeof key !== 'string' || !key.trim())) throw new Error('Invalid acknowledged occurrence key');
    if (options.acknowledgedMemoryIntentIds !== undefined && !Array.isArray(options.acknowledgedMemoryIntentIds)) throw new Error('Acknowledged memory intent IDs must be an array');
    const memoryIds = [...new Set(options.acknowledgedMemoryIntentIds ?? [])];
    if (memoryIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Invalid acknowledged memory intent ID');
    return this.transaction(state => {
      const result: CompactionResult = { compactedIntents: 0, alreadyCompactedIntents: 0, executions: 0, occurrences: 0,
        memoryIntents: 0, alreadyCompactedMemoryIntents: 0, expiredTombstones: 0, beforeBytes: Buffer.byteLength(JSON.stringify(state)), afterBytes: 0 };
      const retire = this.db.prepare(`INSERT INTO host_retired_identity (tenant,kind,identity,expires_at)
        VALUES (?,?,?,?) ON CONFLICT (tenant,kind,identity) DO UPDATE SET
        expires_at=CASE WHEN expires_at IS NULL THEN NULL ELSE max(expires_at,excluded.expires_at) END`);
      const pendingIntents = new Set<string>(), pendingResults = new Set<string>();
      for (const row of Object.values(state.outbox)) {
        if (row.kind === 'intent') pendingIntents.add(row.intentId);
        if (row.kind === 'projection') pendingResults.add(row.id);
      }
      const byIntent = new Map<string, Occurrence[]>(), byOccurrence = new Map<string, string[]>();
      const occurrenceOwners = new Map<string, string[]>();
      for (const intent of Object.values(state.intents)) {
        if (!intent.occurrence) continue;
        const owners = occurrenceOwners.get(intent.occurrence) ?? [];
        owners.push(intent.id); occurrenceOwners.set(intent.occurrence, owners);
      }
      for (const occurrence of Object.values(state.occurrences)) {
        if (!occurrence.intentId) continue;
        const rows = byIntent.get(occurrence.intentId) ?? [];
        rows.push(occurrence); byIntent.set(occurrence.intentId, rows);
      }
      for (const [slot, occurrence] of Object.entries(state.slots)) {
        const slots = byOccurrence.get(occurrence) ?? [];
        slots.push(slot); byOccurrence.set(occurrence, slots);
      }
      for (const key of occurrenceKeys) {
        const occurrence = state.occurrences[key];
        if (!occurrence || occurrence.key !== key || !(occurrence.job || occurrence.hook) || occurrence.intentId || !occurrence.conclusion
          || Object.values(state.outbox).some(row => row.kind === 'host-job' && row.occurrenceKey === key)
          || occurrenceOwners.has(key)) throw new Error('Only settled Host-only occurrences can be compacted');
        const slot = hash(occurrence.wakeKey);
        if (state.slots[slot] !== key || byOccurrence.get(key)?.length !== 1) throw new Error('Invalid occurrence slot association');
        retire.run(this.tenant, 'slot', slot, expiresAt);
        delete state.slots[slot]; delete state.occurrences[key]; result.occurrences++;
      }
      for (const key of keys) {
        const id = hash(key), intent = state.intents[id];
        if (!intent) {
          if (!this.hasTombstone('intent', key, now)) throw new Error('Acknowledged intent not found');
          result.alreadyCompactedIntents++; continue;
        }
        if (intent.id !== id || intent.key !== key || intent.phase !== 'settled' || !intent.conclusion) {
          throw new Error('Only settled intents can be compacted');
        }
        if (pendingIntents.has(id) || pendingResults.has(`intent:${key}`)) throw new Error('Intent has an unacknowledged outbox record');
        if (!Number.isSafeInteger(intent.generation) || intent.generation < 0 || intent.generation >= intent.retry.maxAttempts
          || intent.taskId !== taskId(key, intent.generation)) throw new Error('Invalid execution generation');
        const occurrences = byIntent.get(id) ?? [];
        if (occurrences.length !== (intent.occurrence ? 1 : 0)
          || occurrences.some(row => row.key !== intent.occurrence || !row.conclusion
            || occurrenceOwners.get(row.key)?.length !== 1)) throw new Error('Invalid settled occurrence association');
        for (let generation = 0; generation <= intent.generation; generation++) {
          const executionId = taskId(key, generation), execution = state.executions[executionId];
          if (!execution || execution.input.taskId !== executionId) throw new Error('Missing execution evidence');
          if (state.applied[executionId]) retire.run(this.tenant, 'application', hash(executionId), expiresAt);
          delete state.executions[executionId]; delete state.applied[executionId]; result.executions++;
        }
        for (const occurrence of occurrences) {
          const slot = hash(occurrence.wakeKey);
          if (state.slots[slot] !== occurrence.key) throw new Error('Missing occurrence slot');
          if (byOccurrence.get(occurrence.key)?.length !== 1) {
            throw new Error('Invalid occurrence slot association');
          }
          retire.run(this.tenant, 'slot', slot, expiresAt);
          delete state.slots[slot]; delete state.occurrences[occurrence.key]; result.occurrences++;
        }
        // Caller keys retire permanently. A derived routine key expires with its slot: the routine
        // reservation refuses the old slot, and the transaction guard refuses direct reuse.
        retire.run(this.tenant, 'intent', id, OCCURRENCE_INTENT_KEY.test(key) && key === `occurrence:${intent.occurrence}` ? expiresAt : null);
        delete state.intents[id]; result.compactedIntents++;
      }
      const retireMemory = this.db.prepare('INSERT INTO host_retired_memory_intent (tenant,intent_id,approval,body,expires_at) VALUES (?,?,?,?,?)');
      for (const id of memoryIds) {
        const store = state.memory, row = store?.intents[id];
        if (!store || !row) {
          if (!this.retiredMemoryIntent('intent', id, now)) throw new Error('Acknowledged memory intent not found');
          result.alreadyCompactedMemoryIntents++; continue;
        }
        if (row.intent.intentId !== id || !row.readback) throw new Error('Only terminal memory intents can be compacted');
        if (Object.values(store.restores ?? {}).some(restore => (restore.status === 'preparing' || restore.status === 'applying')
          && restore.files.some(file => file.intentId === id))) throw new Error('Memory intent belongs to an active restore');
        const approval = hash([row.deviceId, row.intent.approvalRef]);
        if (store.approvals[approval] !== id) throw new Error('Invalid memory approval association');
        // approve() rejects an expired input before its replay lookup, so the copy also outlives the approval.
        retireMemory.run(this.tenant, id, approval, JSON.stringify(row), time(Math.max(expiresAt, row.expiresAt)));
        delete store.intents[id]; delete store.approvals[approval]; result.memoryIntents++;
      }
      result.expiredTombstones = Number(this.db.prepare('DELETE FROM host_retired_identity WHERE tenant=? AND expires_at<=?')
        .run(this.tenant, now).changes) + Number(this.db.prepare('DELETE FROM host_retired_memory_intent WHERE tenant=? AND expires_at<=?')
        .run(this.tenant, now).changes);
      result.afterBytes = Buffer.byteLength(JSON.stringify(state));
      return result;
    });
  }
  close(): void { this.db.close(); }
}
