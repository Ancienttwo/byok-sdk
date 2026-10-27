import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { ByokServer } from '@byok-sdk/server';
import { AgentRefSchema } from '@byok-sdk/protocol';
import { BetaError, WINDOW_MS, agentScope, canonicalJson, freeze, hash, invalid, keySpec, taskArguments, text,
  type Caller, type KeyInfo, type KeySpec, type QuotaSnapshot, type RoutineReservation, type Scope, type TaskArguments,
  type TaskBinding, type TaskReservation } from './model';

type Row = Record<string, unknown>;
export interface LedgerOptions {
  now?: () => number;
  /** The owning Host's public SDK authority. Never supplied by an MCP caller. */
  tasks?: Pick<ByokServer['tasks'], 'offer' | 'deviceTerminal'>;
}

function privateFile(filename: string): string {
  if (!filename || filename === ':memory:') throw new Error('Select a private beta ledger file');
  const path = resolve(filename);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Beta ledger needs a private directory');
  if (process.platform !== 'win32' && ((parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.())) {
    throw new Error('Beta ledger directory must belong to this user and be private');
  }
  try { closeSync(openSync(path, 'wx', 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || process.platform !== 'win32' && ((file.mode & 0o077) !== 0 || file.uid !== process.getuid?.())) {
    throw new Error('Beta ledger must be a private regular file');
  }
  return path;
}
function digest(tenant: string, keyId: string, salt: string, secret: string): Buffer {
  return createHash('sha256').update(canonicalJson(['byok-bot-key-v1', tenant, keyId, salt, secret])).digest();
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Corrupt beta ledger number');
  return value;
}

/** One Host process owns one tenant's file. All commands are in-process. */
export class BetaLedger {
  private readonly db: DatabaseSync;
  private readonly callers = new WeakMap<Caller, string>();
  private readonly revocations = new Set<(keyId: string) => void>();
  private closed = false;
  constructor(filename: string, readonly tenant: string, private readonly options: LedgerOptions = {}) {
    text(tenant);
    this.db = new DatabaseSync(privateFile(filename));
    try {
      this.db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN EXCLUSIVE');
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'").all().map(row => row.name);
      const expected = ['beta_meta', 'beta_keys', 'beta_tasks', 'beta_routines', 'beta_status'];
      if (tables.length && (tables.length !== expected.length || expected.some(name => !tables.includes(name)))) throw new Error('Not a beta ledger');
      if (!tables.length) this.initialize();
      const meta = this.db.prepare('SELECT version, tenant FROM beta_meta WHERE id=1').get();
      if (meta?.version !== 1 || meta.tenant !== tenant) throw new Error('Beta ledger version or tenant mismatch');
      this.db.exec('COMMIT; PRAGMA journal_mode=WAL');
    } catch (error) { this.db.close(); throw error; }
  }
  private initialize(): void {
    this.db.exec(`CREATE TABLE beta_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, tenant TEXT NOT NULL) STRICT;
      CREATE TABLE beta_keys (key_id TEXT PRIMARY KEY, salt TEXT NOT NULL, digest TEXT NOT NULL, spec TEXT NOT NULL,
        created_at INTEGER NOT NULL, revoked_at INTEGER) STRICT;
      CREATE TABLE beta_tasks (task_id TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES beta_keys(key_id),
        identity TEXT NOT NULL, args_hash TEXT NOT NULL, binding TEXT NOT NULL, created_at INTEGER NOT NULL,
        released INTEGER NOT NULL DEFAULT 0 CHECK(released IN (0,1)), UNIQUE(key_id, identity)) STRICT;
      CREATE INDEX beta_task_window ON beta_tasks(key_id, args_hash, created_at);
      CREATE INDEX beta_task_quota ON beta_tasks(key_id, created_at, released);
      CREATE TABLE beta_routines (routine_id TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES beta_keys(key_id),
        local_id TEXT NOT NULL, args_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
        released INTEGER NOT NULL DEFAULT 0 CHECK(released IN (0,1)), UNIQUE(key_id, local_id)) STRICT;
      CREATE TABLE beta_status (key_id TEXT NOT NULL REFERENCES beta_keys(key_id), at INTEGER NOT NULL) STRICT;
      CREATE INDEX beta_status_window ON beta_status(key_id, at);`);
    this.db.prepare('INSERT INTO beta_meta VALUES (1, 1, ?)').run(this.tenant);
  }
  private assertOpen(): void { if (this.closed) throw new Error('Beta ledger is closed'); }
  private now(): number { return number((this.options.now ?? Date.now)()); }
  private transaction<T>(apply: () => T): T {
    this.assertOpen(); this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = apply();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Beta transactions must be synchronous');
      this.db.exec('COMMIT'); return freeze(structuredClone(result));
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private key(keyId: string): { info: KeyInfo; salt: string; digest: Buffer } | undefined {
    this.assertOpen();
    const row = this.db.prepare('SELECT * FROM beta_keys WHERE key_id=?').get(keyId);
    if (!row) return undefined;
    if (typeof row.spec !== 'string' || typeof row.salt !== 'string' || !/^[a-f0-9]{64}$/.test(row.salt)
      || typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest)) throw new Error('Corrupt beta key ledger');
    const spec = keySpec(JSON.parse(row.spec), true);
    return { info: freeze({ ...spec, keyId, tenant: this.tenant, createdAt: number(row.created_at),
      ...(row.revoked_at === null ? {} : { revokedAt: number(row.revoked_at) }) }), salt: row.salt, digest: Buffer.from(row.digest, 'hex') };
  }
  issueKey(value: KeySpec): { token: string; key: KeyInfo } {
    const spec = keySpec(value);
    const keyId = `byok_bot_${randomBytes(16).toString('hex')}`;
    const secret = randomBytes(32).toString('base64url');
    const salt = randomBytes(32).toString('hex');
    return this.transaction(() => {
      this.db.prepare('INSERT INTO beta_keys VALUES (?, ?, ?, ?, ?, NULL)').run(keyId, salt,
        digest(this.tenant, keyId, salt, secret).toString('hex'), canonicalJson(spec), this.now());
      return { token: `${keyId}.${secret}`, key: this.key(keyId)!.info };
    });
  }
  getKey(keyId: string): KeyInfo | undefined { return this.key(keyId)?.info; }
  authenticate(authorization: string | null): Caller {
    this.assertOpen();
    const header = /^(\S+) +(\S+)$/.exec(authorization ?? '');
    const token = header?.[1]?.toLowerCase() === 'bearer' ? /^(byok_bot_[a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/.exec(header[2]!) : null;
    const entry = token ? this.key(token[1]!) : undefined;
    const candidate = digest(this.tenant, token?.[1] ?? '', entry?.salt ?? '0'.repeat(64), token?.[2] ?? '');
    const matched = timingSafeEqual(candidate, entry?.digest ?? Buffer.alloc(32));
    if (!matched || !entry || entry.info.revokedAt !== undefined) throw new BetaError('unauthorized', 'Invalid byok bot key');
    const caller = freeze(structuredClone(entry.info));
    this.callers.set(caller, caller.keyId); return caller;
  }
  authorize(caller: Caller, required?: Scope): KeyInfo {
    const keyId = this.callers.get(caller);
    const info = keyId === undefined ? undefined : this.key(keyId)?.info;
    if (!info || info.revokedAt !== undefined) throw new BetaError('unauthorized', 'Invalid byok bot key');
    if (required && (!info.scopes.includes(required) || agentScope(required) && !info.agentRef)) {
      throw new BetaError('forbidden', 'Scope not granted');
    }
    return info;
  }
  onRevocation(listener: (keyId: string) => void): () => void {
    this.assertOpen(); this.revocations.add(listener); return () => { this.revocations.delete(listener); };
  }
  revokeKey(keyId: string): boolean {
    const changed = this.transaction(() => this.db.prepare('UPDATE beta_keys SET revoked_at=? WHERE key_id=? AND revoked_at IS NULL').run(this.now(), keyId).changes > 0);
    if (changed) for (const listener of this.revocations) {
      try { listener(keyId); } catch { /* Revocation is durable; next-request auth still refuses. */ }
    }
    return changed;
  }
  private task(row: Row, deduplicated: boolean): TaskReservation {
    if (typeof row.task_id !== 'string' || typeof row.key_id !== 'string' || typeof row.binding !== 'string'
      || ![0, 1].includes(number(row.released))) throw new Error('Corrupt beta task reservation');
    const stored = JSON.parse(row.binding) as TaskBinding;
    const args = taskArguments(stored.arguments);
    const { clientRequestId, ...payload } = args;
    const argsHash = hash(payload);
    const expectedIdentity = clientRequestId === undefined ? `auto:${argsHash}:${number(row.created_at)}` : `explicit:${clientRequestId}`;
    const agent = stored.agentRef === undefined ? undefined : AgentRefSchema.parse(stored.agentRef);
    const grant = this.key(row.key_id)?.info;
    if (!grant || !grant.deviceIds.includes(stored.deviceId) || !grant.runtimes.includes(args.runtime)
      || canonicalJson(agent ?? null) !== canonicalJson(grant.agentRef ?? null)
      || row.args_hash !== argsHash || row.identity !== expectedIdentity
      || row.task_id !== hash(['byok-mcp-task-v1', this.tenant, row.key_id, expectedIdentity])) throw new Error('Corrupt beta task binding');
    const binding: TaskBinding = { deviceId: text(stored.deviceId), arguments: args, ...(agent === undefined ? {} : { agentRef: agent }) };
    return freeze({ taskId: row.task_id, keyId: row.key_id, binding, createdAt: number(row.created_at), slotReleased: row.released === 1, deduplicated });
  }
  private identity(caller: KeyInfo, args: TaskArguments, now: number): { argsHash: string; existing?: Row; identity: string } {
    const { clientRequestId, ...payload } = args;
    const argsHash = hash(payload);
    const existing = clientRequestId === undefined
      ? this.db.prepare('SELECT * FROM beta_tasks WHERE key_id=? AND identity LIKE ? AND args_hash=? AND created_at>? AND created_at<=? ORDER BY created_at LIMIT 1')
        .get(caller.keyId, 'auto:%', argsHash, now - WINDOW_MS, now)
      : this.db.prepare('SELECT * FROM beta_tasks WHERE key_id=? AND identity=?').get(caller.keyId, `explicit:${clientRequestId}`);
    if (existing && existing.args_hash !== argsHash) throw new BetaError('idempotency_conflict', 'Request identity has different arguments');
    return { argsHash, ...(existing ? { existing } : {}), identity: clientRequestId === undefined ? `auto:${argsHash}:${now}` : `explicit:${clientRequestId}` };
  }
  lookupTask(caller: Caller, input: TaskArguments): TaskReservation | undefined {
    const args = taskArguments(input);
    const key = this.authorize(caller, 'tasks.dispatch');
    const saved = this.identity(key, args, this.now()).existing;
    return saved ? this.task(saved, true) : undefined;
  }
  reserveTask(caller: Caller, input: TaskArguments, selectedDeviceId: string): TaskReservation {
    const args = taskArguments(input);
    return this.transaction(() => {
      const key = this.authorize(caller, 'tasks.dispatch'); const now = this.now();
      const identity = this.identity(key, args, now);
      if (identity.existing) return this.task(identity.existing, true);
      if (!key.deviceIds.includes(selectedDeviceId) || !key.runtimes.includes(args.runtime)) throw new BetaError('forbidden', 'Device or runtime not granted');
      const counts = this.counts(key.keyId, now);
      if (counts.runningTasks >= key.quota.runningTasks) throw new BetaError('quota_exceeded', 'Task slots are full', 1);
      if (counts.submits >= key.quota.submitsPerHour) throw new BetaError('quota_exceeded', 'Hourly submit quota is full', this.retryAfter('beta_tasks', 'created_at', key.keyId, now, 3_600_000));
      const taskId = hash(['byok-mcp-task-v1', this.tenant, key.keyId, identity.identity]);
      const binding: TaskBinding = { deviceId: selectedDeviceId, arguments: args, ...(key.agentRef ? { agentRef: key.agentRef } : {}) };
      this.db.prepare('INSERT INTO beta_tasks (task_id,key_id,identity,args_hash,binding,created_at) VALUES (?,?,?,?,?,?)')
        .run(taskId, key.keyId, identity.identity, identity.argsHash, canonicalJson(binding), now);
      return this.task(this.db.prepare('SELECT * FROM beta_tasks WHERE task_id=?').get(taskId)!, false);
    });
  }
  requireTask(caller: Caller, taskId: string, required: Scope = 'tasks.read'): TaskReservation {
    const key = this.authorize(caller, required);
    const row = this.db.prepare('SELECT * FROM beta_tasks WHERE task_id=? AND key_id=?').get(taskId, key.keyId);
    if (!row) throw new BetaError('not_found', 'Resource not found');
    return this.task(row, true);
  }
  /** This key's reservations, newest first. The cursor is opaque to callers. */
  listTasks(caller: Caller, query: { cursor?: string; limit: number }): { tasks: TaskReservation[]; nextCursor?: string } {
    const key = this.authorize(caller, 'tasks.read');
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) invalid();
    const after = query.cursor === undefined ? undefined : /^(\d{1,16})\.([a-f0-9]{64})$/.exec(query.cursor);
    if (query.cursor !== undefined && !after) invalid();
    const rows = after
      ? this.db.prepare('SELECT * FROM beta_tasks WHERE key_id=? AND (created_at<? OR (created_at=? AND task_id<?)) ORDER BY created_at DESC, task_id DESC LIMIT ?')
        .all(key.keyId, Number(after[1]), Number(after[1]), after[2]!, query.limit + 1)
      : this.db.prepare('SELECT * FROM beta_tasks WHERE key_id=? ORDER BY created_at DESC, task_id DESC LIMIT ?').all(key.keyId, query.limit + 1);
    const tasks = rows.slice(0, query.limit).map(row => this.task(row, true));
    const last = tasks.at(-1);
    return { tasks, ...(rows.length > query.limit && last ? { nextCursor: `${last.createdAt}.${last.taskId}` } : {}) };
  }
  /** Task IDs that still hold one of this key's slots, for trusted Host reconciliation. */
  openTasks(caller: Caller): string[] {
    const key = this.authorize(caller);
    return this.db.prepare('SELECT task_id FROM beta_tasks WHERE key_id=? AND released=0 ORDER BY created_at').all(key.keyId).map(row => String(row.task_id));
  }
  consumeStatusRead(caller: Caller, taskId: string): void {
    this.transaction(() => {
      const task = this.requireTask(caller, taskId); const key = this.authorize(caller); const now = this.now();
      this.db.prepare('DELETE FROM beta_status WHERE key_id=? AND (at<=? OR at>?)').run(task.keyId, now - 60_000, now);
      if (this.count('SELECT COUNT(*) AS n FROM beta_status WHERE key_id=?', key.keyId) >= key.quota.statusPerMinute) {
        throw new BetaError('rate_limited', 'Status rate limit reached', this.retryAfter('beta_status', 'at', key.keyId, now, 60_000));
      }
      this.db.prepare('INSERT INTO beta_status VALUES (?, ?)').run(key.keyId, now);
    });
  }
  /** Trusted Host reconciliation. A missing SDK row or Host-only cancel cannot free a slot. */
  async reconcileTask(taskId: string): Promise<boolean> {
    this.assertOpen();
    const row = this.db.prepare('SELECT * FROM beta_tasks WHERE task_id=?').get(taskId);
    if (!row) return false;
    const saved = this.task(row, true);
    if (saved.slotReleased) return true;
    if (!this.options.tasks) throw new Error('Configure the owning SDK task authority for reconciliation');
    const offer = await this.options.tasks.offer(taskId);
    const terminal = await this.options.tasks.deviceTerminal(taskId);
    if (!offer || !terminal) return false;
    const instruction = 'instruction' in offer.payload ? offer.payload.instruction : undefined;
    const offeredAgent = 'agentRef' in offer.payload ? offer.payload.agentRef : undefined;
    if (offer.taskId !== taskId || offer.deviceId !== saved.binding.deviceId || instruction !== saved.binding.arguments.instruction
      || offer.payload.runtime !== saved.binding.arguments.runtime
      || offeredAgent === undefined || saved.binding.agentRef === undefined || canonicalJson(offeredAgent) !== canonicalJson(saved.binding.agentRef)
      || terminal.envelope.task_id !== taskId || !['task.complete', 'task.fail', 'task.cancelled', 'task.decline'].includes(terminal.envelope.type)) {
      throw new Error('SDK task binding or terminal mismatch');
    }
    return this.transaction(() => { this.db.prepare('UPDATE beta_tasks SET released=1 WHERE task_id=?').run(taskId); return true; });
  }
  private priorRoutine(keyId: string, localId: string, argsHash: string): Row | undefined {
    const prior = this.db.prepare('SELECT * FROM beta_routines WHERE key_id=? AND local_id=?').get(keyId, localId);
    if (prior && prior.args_hash !== argsHash) throw new BetaError('idempotency_conflict', 'Routine identity has different arguments');
    return prior;
  }
  /** The saved reservation for this key and local ID, without admitting a new one. */
  lookupRoutine(caller: Caller, localId: string, definition: unknown): RoutineReservation | undefined {
    text(localId); const argsHash = hash(definition);
    const key = this.authorize(caller, 'routines.write');
    const prior = this.priorRoutine(key.keyId, localId, argsHash);
    return prior ? this.routine(prior, true) : undefined;
  }
  reserveRoutine(caller: Caller, localId: string, definition: unknown): RoutineReservation {
    text(localId); const argsHash = hash(definition);
    return this.transaction(() => {
      const key = this.authorize(caller, 'routines.write'); const now = this.now();
      const prior = this.priorRoutine(key.keyId, localId, argsHash);
      if (prior) return this.routine(prior, true);
      if (this.count('SELECT COUNT(*) AS n FROM beta_routines WHERE key_id=? AND released=0', key.keyId) >= key.quota.routines) throw new BetaError('quota_exceeded', 'Routine slots are full', 1);
      const routineId = hash(['byok-mcp-routine-v1', this.tenant, key.keyId, localId]);
      this.db.prepare('INSERT INTO beta_routines (routine_id,key_id,local_id,args_hash,created_at) VALUES (?,?,?,?,?)').run(routineId, key.keyId, localId, argsHash, now);
      return this.routine(this.db.prepare('SELECT * FROM beta_routines WHERE routine_id=?').get(routineId)!, false);
    });
  }
  private routine(row: Row, deduplicated: boolean): RoutineReservation {
    if (typeof row.routine_id !== 'string' || typeof row.key_id !== 'string' || typeof row.local_id !== 'string') throw new Error('Corrupt beta routine reservation');
    return freeze({ routineId: row.routine_id, keyId: row.key_id, localId: row.local_id, createdAt: number(row.created_at), slotReleased: row.released === 1, deduplicated });
  }
  requireRoutine(caller: Caller, routineId: string, required: Scope = 'routines.read'): RoutineReservation {
    const key = this.authorize(caller, required);
    const row = this.db.prepare('SELECT * FROM beta_routines WHERE routine_id=? AND key_id=?').get(routineId, key.keyId);
    if (!row) throw new BetaError('not_found', 'Resource not found');
    return this.routine(row, true);
  }
  /** This key's routine reservations, newest first. The cursor is opaque to callers. */
  listRoutines(caller: Caller, query: { cursor?: string; limit: number }): { routines: RoutineReservation[]; nextCursor?: string } {
    const key = this.authorize(caller, 'routines.read');
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) invalid();
    const after = query.cursor === undefined ? undefined : /^(\d{1,16})\.([a-f0-9]{64})$/.exec(query.cursor);
    if (query.cursor !== undefined && !after) invalid();
    const rows = after
      ? this.db.prepare('SELECT * FROM beta_routines WHERE key_id=? AND (created_at<? OR (created_at=? AND routine_id<?)) ORDER BY created_at DESC, routine_id DESC LIMIT ?')
        .all(key.keyId, Number(after[1]), Number(after[1]), after[2]!, query.limit + 1)
      : this.db.prepare('SELECT * FROM beta_routines WHERE key_id=? ORDER BY created_at DESC, routine_id DESC LIMIT ?').all(key.keyId, query.limit + 1);
    const routines = rows.slice(0, query.limit).map(row => this.routine(row, true));
    const last = routines.at(-1);
    return { routines, ...(rows.length > query.limit && last ? { nextCursor: `${last.createdAt}.${last.routineId}` } : {}) };
  }
  /** Routines that still hold a slot although their key is revoked, for trusted Host retirement. */
  revokedRoutines(): string[] {
    this.assertOpen();
    return this.db.prepare('SELECT r.routine_id FROM beta_routines r JOIN beta_keys k ON k.key_id=r.key_id WHERE r.released=0 AND k.revoked_at IS NOT NULL ORDER BY r.created_at')
      .all().map(row => String(row.routine_id));
  }
  /** Call only after the owning K4/Host routine is confirmed completed. Not an MCP command. */
  releaseRoutineSlot(routineId: string): boolean {
    return this.transaction(() => this.db.prepare('UPDATE beta_routines SET released=1 WHERE routine_id=?').run(routineId).changes > 0);
  }
  quota(caller: Caller): QuotaSnapshot {
    const key = this.authorize(caller); const counts = this.counts(key.keyId, this.now());
    return { runningTasks: counts.runningTasks, routines: counts.routines,
      remainingSubmits: Math.max(0, key.quota.submitsPerHour - counts.submits), remainingStatusReads: Math.max(0, key.quota.statusPerMinute - counts.status) };
  }
  private count(sql: string, ...args: SQLInputValue[]): number { return number(this.db.prepare(sql).get(...args)?.n); }
  private counts(keyId: string, now: number) {
    return { runningTasks: this.count('SELECT COUNT(*) AS n FROM beta_tasks WHERE key_id=? AND released=0', keyId),
      submits: this.count('SELECT COUNT(*) AS n FROM beta_tasks WHERE key_id=? AND created_at>? AND created_at<=?', keyId, now - 3_600_000, now),
      routines: this.count('SELECT COUNT(*) AS n FROM beta_routines WHERE key_id=? AND released=0', keyId),
      status: this.count('SELECT COUNT(*) AS n FROM beta_status WHERE key_id=? AND at>? AND at<=?', keyId, now - 60_000, now) };
  }
  private retryAfter(table: 'beta_tasks' | 'beta_status', column: 'created_at' | 'at', keyId: string, now: number, window: number): number {
    const first = this.db.prepare(`SELECT MIN(${column}) AS at FROM ${table} WHERE key_id=? AND ${column}>? AND ${column}<=?`).get(keyId, now - window, now)?.at;
    return Math.max(1, Math.ceil((number(first) + window - now) / 1000));
  }
  close(): void { if (!this.closed) { this.closed = true; this.revocations.clear(); this.db.close(); } }
}
