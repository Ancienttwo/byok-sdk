import { DatabaseSync } from 'node:sqlite';
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
export interface CompactionOptions {
  /** Explicit acknowledgement that these results may be removed under the Host's retention policy. */
  acknowledgedIntentKeys: readonly string[];
  /** Settled Host-only occurrences; promoted occurrences are selected through their intent. */
  acknowledgedOccurrenceKeys?: readonly string[];
  now: number;
  tombstoneRetentionMs: number;
}
export interface CompactionResult {
  compactedIntents: number;
  alreadyCompactedIntents: number;
  executions: number;
  occurrences: number;
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
      CREATE INDEX IF NOT EXISTS host_retired_expiry ON host_retired_identity (tenant, expires_at);`);
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
    try {
      const state = this.snapshot();
      const existing = new Set(Object.keys(state.intents));
      const before = this.projectionLimits && projectionUsage(state);
      const result = apply(state);
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Host transactions must be synchronous');
      // Also covers callers of the exported pure enqueue/recordOccurrence transitions.
      const retired = this.db.prepare("SELECT 1 FROM host_retired_identity WHERE tenant=? AND kind='intent' AND identity=?");
      for (const id of Object.keys(state.intents)) {
        if (!existing.has(id) && retired.get(this.tenant, id)) throw new Error('Retired intent identity cannot be reused');
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
      this.db.exec('COMMIT');
      return structuredClone(result);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Replay evidence is time-bounded; retired intent identities are permanent. */
  hasTombstone(kind: TombstoneKind, identity: string, now: number): boolean {
    time(now);
    return !!this.db.prepare(`SELECT 1 FROM host_retired_identity
      WHERE tenant=? AND kind=? AND identity=? AND (expires_at IS NULL OR expires_at>?)`)
      .get(this.tenant, kind, hash(identity), now);
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
    return this.transaction(state => {
      const result: CompactionResult = { compactedIntents: 0, alreadyCompactedIntents: 0, executions: 0,
        occurrences: 0, expiredTombstones: 0, beforeBytes: Buffer.byteLength(JSON.stringify(state)), afterBytes: 0 };
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
        if (!occurrence || occurrence.key !== key || !occurrence.job || occurrence.intentId || !occurrence.conclusion
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
        retire.run(this.tenant, 'intent', id, null);
        delete state.intents[id]; result.compactedIntents++;
      }
      result.expiredTombstones = Number(this.db.prepare('DELETE FROM host_retired_identity WHERE tenant=? AND expires_at<=?')
        .run(this.tenant, now).changes);
      result.afterBytes = Buffer.byteLength(JSON.stringify(state));
      return result;
    });
  }
  close(): void { this.db.close(); }
}
