import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { loadSqliteModule } from '../sqlite-support';
import type { MemoryIntentRow } from './memory';
import { hash, isOccurrenceIntentKey, occurrenceIntentKey, taskId, time, type Json, type LedgerState, type Occurrence } from './model';
import { agentKey } from './transitions';

export interface ProjectionOutboxLimits { maxCount?: number; maxBytes?: number }
/**
 * Refuses the compaction of one intent identity with a reason, or allows it with `undefined`.
 * `compact` calls it in its own transaction, before it removes anything, with the state before the compaction.
 * It must not change the state. An application registers it once, so a plain `compact` call cannot skip it.
 */
export type CompactVeto = (state: Readonly<LedgerState>, intentKey: string) => string | undefined;
export interface HostLedgerOptions { projectionOutboxLimits?: ProjectionOutboxLimits; compactVeto?: CompactVeto }
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

/** The registered veto refused one identity. The whole compaction rolls back. */
export class CompactVetoError extends Error {
  readonly code = 'compact_vetoed' as const;
  constructor(readonly intentKey: string, reason: string) { super(`Compaction refused: ${reason}`); this.name = 'CompactVetoError'; }
}

/**
 * Application rows by stable identity, in the same transaction as the ledger body (#798).
 * The port is open only while `apply` runs. It reads and writes only this tenant's rows.
 * A retired identity stays retired: the port has no way to clear it.
 */
export interface ApplicationRows {
  get(namespace: string, id: string): Json | undefined;
  /** `expiresAt`: `expire` may remove the row from that time on. Absent: the row never expires. */
  put(namespace: string, id: string, value: Json, expiresAt?: number): void;
  /** Returns whether a row existed. */
  delete(namespace: string, id: string): boolean;
  /** Removes the rows of a namespace whose `expiresAt` is `now` or earlier. Returns their count. */
  expire(namespace: string, now: number): number;
  retire(namespace: string, id: string): void;
  isRetired(namespace: string, id: string): boolean;
}
const ROW_NAMESPACE_MAX = 128, ROW_ID_MAX = 1024;
function rowNamespace(namespace: unknown): void {
  if (typeof namespace !== 'string' || !namespace || namespace.length > ROW_NAMESPACE_MAX) throw new Error('Invalid application row namespace');
}
function rowId(id: unknown): void {
  if (typeof id !== 'string' || !id || id.length > ROW_ID_MAX) throw new Error('Invalid application row id');
}

export const MIN_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export type TombstoneKind = 'intent' | 'application' | 'slot';
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

/** A tombstone of `host_retired_identity`. `row` is an application row tombstone (`ApplicationRows.retire`). */
export interface LedgerDumpTombstone { kind: TombstoneKind | 'row'; identity: string; expiresAt: number | null }
export interface LedgerDumpRow { namespace: string; id: string; value: Json; expiresAt: number | null }
export interface LedgerDumpMemoryTombstone { intentId: string; approval: string; row: MemoryIntentRow; expiresAt: number }
/**
 * Every stored row of one tenant, for a topology switch (#975). Each list is ordered by its key, and each expiry is as stored.
 * It carries no tenant id: `loadForSwitch` writes it into another, empty tenant.
 */
export interface LedgerDump {
  version: 1;
  body: LedgerState;
  tombstones: LedgerDumpTombstone[];
  rows: LedgerDumpRow[];
  memoryTombstones: LedgerDumpMemoryTombstone[];
}
const TOMBSTONE_KINDS: ReadonlySet<string> = new Set(['intent', 'application', 'slot', 'row']);
const TENANT_TABLES = ['host_ledger', 'host_retired_identity', 'host_retired_memory_intent', 'host_application_row'] as const;
const expiry = (value: unknown): number | null => value === null ? null : time(value as number);
const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid switch dump ${what}`);
  return value;
};
const record = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid switch dump ${what}`);
  return value as Record<string, unknown>;
};
const serialized = (value: unknown, what: string): string => {
  const body = JSON.stringify(value);
  if (typeof body !== 'string') throw new Error(`Invalid switch dump ${what}`);
  return body;
};

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
  /** An application checks this identity to prove that its veto guards every compaction. */
  readonly compactVeto?: CompactVeto;
  constructor(filename: string, readonly tenant: string, options: HostLedgerOptions = {}) {
    if (options.compactVeto !== undefined) {
      if (typeof options.compactVeto !== 'function') throw new Error('The compact veto must be a function');
      this.compactVeto = options.compactVeto;
    }
    if (options.projectionOutboxLimits !== undefined) {
      const { maxCount, maxBytes } = options.projectionOutboxLimits;
      if (maxCount === undefined && maxBytes === undefined) throw new Error('Supply a projection outbox limit');
      for (const value of [maxCount, maxBytes]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Projection outbox limits must be nonnegative safe integers');
      }
      this.projectionLimits = Object.freeze({ maxCount, maxBytes });
    }
    if (!filename || !tenant.trim()) throw new Error('Select a Host database and tenant');
    // The bundler drops the `node:` prefix from static imports, and `sqlite` has no unprefixed builtin.
    const { DatabaseSync: Database } = loadSqliteModule();
    this.db = new Database(filename);
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
      CREATE INDEX IF NOT EXISTS host_retired_memory_expiry ON host_retired_memory_intent (tenant, expires_at);
      CREATE TABLE IF NOT EXISTS host_application_row (
        tenant TEXT NOT NULL, namespace TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, expires_at INTEGER,
        PRIMARY KEY (tenant, namespace, id));
      CREATE INDEX IF NOT EXISTS host_application_row_expiry ON host_application_row (tenant, namespace, expires_at);`);
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
  transaction<T>(apply: (state: LedgerState, rows: ApplicationRows) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    let result: T;
    let added = false;
    try {
      const state = this.snapshot();
      const existing = new Set(Object.keys(state.intents));
      const prior = new Set(Object.keys(state.outbox));
      const before = this.projectionLimits && projectionUsage(state);
      const port = this.rows();
      try { result = apply(state, port.rows); } finally { port.close(); }
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Host transactions must be synchronous');
      // Also covers callers of the exported pure enqueue/recordOccurrence transitions.
      const retired = this.db.prepare("SELECT 1 FROM host_retired_identity WHERE tenant=? AND kind='intent' AND identity=?");
      for (const [id, intent] of Object.entries(state.intents)) {
        if (existing.has(id)) continue;
        // A derived routine key enters only with its own occurrence, so an expired routine row cannot reopen work.
        if (retired.get(this.tenant, id) || isOccurrenceIntentKey(intent.key) && (intent.key !== occurrenceIntentKey(intent.occurrence!)
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
  private rowStatements?: Record<'get' | 'put' | 'delete' | 'expire' | 'retire' | 'retired', StatementSync>;
  /** A port for one transaction. All SQL stays here; the caller gets no database handle. */
  private rows(): { rows: ApplicationRows; close(): void } {
    let open = true;
    const tenant = this.tenant;
    // Prepared once per ledger: one retention call can write thousands of rows in one transaction.
    const sql = this.rowStatements ??= {
      get: this.db.prepare('SELECT body FROM host_application_row WHERE tenant=? AND namespace=? AND id=?'),
      put: this.db.prepare(`INSERT INTO host_application_row (tenant,namespace,id,body,expires_at) VALUES (?,?,?,?,?)
        ON CONFLICT (tenant,namespace,id) DO UPDATE SET body=excluded.body, expires_at=excluded.expires_at`),
      delete: this.db.prepare('DELETE FROM host_application_row WHERE tenant=? AND namespace=? AND id=?'),
      expire: this.db.prepare('DELETE FROM host_application_row WHERE tenant=? AND namespace=? AND expires_at<=?'),
      retire: this.db.prepare(`INSERT INTO host_retired_identity (tenant,kind,identity,expires_at) VALUES (?,'row',?,NULL)
        ON CONFLICT (tenant,kind,identity) DO UPDATE SET expires_at=NULL`),
      retired: this.db.prepare("SELECT 1 FROM host_retired_identity WHERE tenant=? AND kind='row' AND identity=?"),
    };
    const check = (namespace: string, ...id: [string] | []) => {
      if (!open) throw new Error('The application row port is closed');
      rowNamespace(namespace);
      if (id.length) rowId(id[0]);
    };
    const rows: ApplicationRows = Object.freeze({
      get(namespace: string, id: string) {
        check(namespace, id);
        const row = sql.get.get(tenant, namespace, id);
        return typeof row?.body === 'string' ? JSON.parse(row.body) as Json : undefined;
      },
      put(namespace: string, id: string, value: Json, expiresAt?: number) {
        check(namespace, id);
        if (expiresAt !== undefined) time(expiresAt);
        const body = JSON.stringify(value);
        if (typeof body !== 'string') throw new Error('An application row must be JSON');
        sql.put.run(tenant, namespace, id, body, expiresAt ?? null);
      },
      delete(namespace: string, id: string) {
        check(namespace, id);
        return Number(sql.delete.run(tenant, namespace, id).changes) > 0;
      },
      expire(namespace: string, now: number) {
        check(namespace);
        return Number(sql.expire.run(tenant, namespace, time(now)).changes);
      },
      retire(namespace: string, id: string) {
        check(namespace, id);
        sql.retire.run(tenant, hash([namespace, id]));
      },
      isRetired(namespace: string, id: string) {
        check(namespace, id);
        return !!sql.retired.get(tenant, hash([namespace, id]));
      },
    });
    return { rows, close: () => { open = false; } };
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
      const body = JSON.stringify(state);
      const result: CompactionResult = { compactedIntents: 0, alreadyCompactedIntents: 0, executions: 0, occurrences: 0,
        memoryIntents: 0, alreadyCompactedMemoryIntents: 0, expiredTombstones: 0, beforeBytes: Buffer.byteLength(body), afterBytes: 0 };
      if (this.compactVeto) {
        // An acknowledged occurrence retires the derived intent identity of its occurrence too.
        for (const key of [...keys.filter(key => state.intents[hash(key)]), ...occurrenceKeys.map(occurrenceIntentKey)]) {
          const reason: unknown = this.compactVeto(state, key);
          if (reason === undefined) continue;
          if (typeof reason !== 'string' || !reason) throw new Error('A compact veto returns a reason or undefined');
          throw new CompactVetoError(key, reason);
        }
        if (JSON.stringify(state) !== body) throw new Error('A compact veto must not change the ledger');
      }
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
        retire.run(this.tenant, 'intent', id, isOccurrenceIntentKey(key) && key === occurrenceIntentKey(intent.occurrence!) ? expiresAt : null);
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
  /**
   * Reads every stored row of this tenant in one read transaction (#975): the ledger body, the tombstones and application rows
   * with their expiry as stored, and the retired memory intents. It checks nothing else; the switch preconditions are the
   * caller's. Call it outside `transaction()`.
   */
  dumpForSwitch(): LedgerDump {
    this.db.exec('BEGIN');
    try {
      const dump = this.readDump();
      this.db.exec('COMMIT');
      return dump;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** The rows of this tenant, inside the caller's transaction: the dump, and the load's read-back. */
  private readDump(): LedgerDump {
    return {
      version: 1,
      body: this.snapshot(),
      tombstones: this.db.prepare('SELECT kind, identity, expires_at FROM host_retired_identity WHERE tenant=? ORDER BY kind, identity')
        .all(this.tenant).map(row => ({ kind: row.kind as LedgerDumpTombstone['kind'], identity: String(row.identity),
          expiresAt: row.expires_at === null ? null : Number(row.expires_at) })),
      rows: this.db.prepare('SELECT namespace, id, body, expires_at FROM host_application_row WHERE tenant=? ORDER BY namespace, id')
        .all(this.tenant).map(row => ({ namespace: String(row.namespace), id: String(row.id), value: JSON.parse(String(row.body)) as Json,
          expiresAt: row.expires_at === null ? null : Number(row.expires_at) })),
      memoryTombstones: this.db.prepare('SELECT intent_id, approval, body, expires_at FROM host_retired_memory_intent WHERE tenant=? ORDER BY intent_id')
        .all(this.tenant).map(row => ({ intentId: String(row.intent_id), approval: String(row.approval),
          row: JSON.parse(String(row.body)) as MemoryIntentRow, expiresAt: Number(row.expires_at) })),
    };
  }
  /**
   * Writes a `dumpForSwitch` result into this tenant in one transaction (#975). The tenant must be empty: the body of a new
   * ledger and no other row. Expiry is kept, never reset. The loaded body passes the intent identity checks of `transaction()`
   * against the dump's own tombstones. The dump must be bound to this tenant: each intent's `agent` is `agentKey(tenant, …)`,
   * a scan wake key names this tenant, and it holds no memory state or retired memory intent. After the writes, in the same
   * transaction, `verify` gets this tenant's rows read back as `dumpForSwitch` reads them; when it throws, nothing is
   * written. Any refusal or write failure rolls the whole load back. It runs before any core is bound to this ledger, so
   * loaded work stays inert until the caller starts one; it sends no outbox hint.
   */
  loadForSwitch(dump: LedgerDump, verify: (readBack: LedgerDump) => void): void {
    if (typeof verify !== 'function') throw new Error('A switch load needs a read-back check');
    if (this.outboxListeners.size) throw new Error('Load a switch dump before any core is bound to this ledger');
    const input = record(dump, 'document');
    if (input.version !== 1) throw new Error('Unsupported switch dump version');
    const body = record(input.body, 'body') as unknown as LedgerState;
    if (body.version !== 1) throw new Error('Unsupported Host ledger version');
    for (const name of ['tombstones', 'rows', 'memoryTombstones'] as const) if (!Array.isArray(input[name])) throw new Error(`Invalid switch dump ${name}`);
    const tombstones = (input.tombstones as unknown[]).map(value => {
      const row = record(value, 'tombstone');
      if (!TOMBSTONE_KINDS.has(row.kind as string)) throw new Error('Invalid switch dump tombstone kind');
      return [text(row.kind, 'tombstone kind'), text(row.identity, 'tombstone identity'), expiry(row.expiresAt)] as const;
    });
    const rows = (input.rows as unknown[]).map(value => {
      const row = record(value, 'row');
      rowNamespace(row.namespace); rowId(row.id);
      return [row.namespace as string, row.id as string, serialized(row.value, 'row value'), expiry(row.expiresAt)] as const;
    });
    const retired = new Set(tombstones.filter(([kind]) => kind === 'intent').map(([, identity]) => identity));
    for (const [id, intent] of Object.entries(record(body.intents, 'intents') as LedgerState['intents'])) {
      if (retired.has(id) || isOccurrenceIntentKey(intent.key) && (intent.key !== occurrenceIntentKey(intent.occurrence!)
        || body.occurrences?.[intent.occurrence!]?.intentId !== id)) throw new RetiredIntentIdentityError();
      // The FIFO key includes the tenant, so an intent of another tenant would queue apart from new work here.
      if (intent.agent !== agentKey(this.tenant, intent.execution)) throw new Error('A switch dump intent must queue under this tenant');
    }
    // The scan wake key names the tenant too. Memory binds the tenant inside its digests, so it does not move (D4).
    const scan = `host-scan:${hash(this.tenant)}:`;
    const scanKeys = [body.scanWake?.dedupKey, ...Object.values(record(body.outbox, 'outbox') as LedgerState['outbox'])
      .map(row => row.kind === 'schedule' ? row.input.dedupKey : row.kind === 'cancel-wake' ? row.key : undefined)];
    if (scanKeys.some(key => key?.startsWith('host-scan:') && !key.startsWith(scan))) throw new Error('A switch dump scan wake must name this tenant');
    if ((input.memoryTombstones as unknown[]).length || body.memory && Object.values(body.memory).some(value => !value || typeof value !== 'object' || Object.keys(value).length)) {
      throw new Error('A switch dump carries no memory state');
    }
    const state = serialized(body, 'body');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (hash(this.snapshot()) !== hash(empty()) || TENANT_TABLES.slice(1).some(table =>
        this.db.prepare(`SELECT 1 FROM ${table} WHERE tenant=? LIMIT 1`).get(this.tenant))) throw new Error('A switch dump loads only into an empty tenant');
      this.db.prepare('UPDATE host_ledger SET body=? WHERE tenant=?').run(state, this.tenant);
      const tombstone = this.db.prepare('INSERT INTO host_retired_identity (tenant,kind,identity,expires_at) VALUES (?,?,?,?)');
      for (const row of tombstones) tombstone.run(this.tenant, ...row);
      const put = this.db.prepare('INSERT INTO host_application_row (tenant,namespace,id,body,expires_at) VALUES (?,?,?,?,?)');
      for (const row of rows) put.run(this.tenant, ...row);
      verify(this.readDump());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /**
   * Deletes every row of this tenant, tombstones included, in one transaction, then closes this ledger (#975). Irreversible.
   * For a tenant that never ran work, such as an aborted switch import; the caller gates it. Refused while a core is bound.
   * Other `HostLedger` instances on the same file stay open, and reopening the tenant id creates an empty tenant.
   */
  discard(): void {
    if (this.outboxListeners.size) throw new Error('Close the core bound to this ledger before discarding it');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of TENANT_TABLES) this.db.prepare(`DELETE FROM ${table} WHERE tenant=?`).run(this.tenant);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.db.close();
  }
  close(): void { this.db.close(); }
}
