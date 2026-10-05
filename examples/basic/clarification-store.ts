// Copy-and-own Host storage, not SDK API. Use a separate Host database, never
// the SDK store/Agent home. SQLite CAS works across connections on one machine;
// this is not a distributed database. Keep cap/config identical across workers.
import { DatabaseSync } from 'node:sqlite';
import { HostRevisionConflict, type HostSnapshot } from './goal-btw-store';

export class SqliteClarificationStore {
  private readonly db: DatabaseSync;
  constructor(filename: string, readonly tenantId: string, readonly maxPending = 100) {
    if (!filename || !tenantId.trim() || !Number.isSafeInteger(maxPending) || maxPending < 1) throw new Error('Invalid Host database, tenant or pending cap');
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS clarification_runs (
        tenant TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        waiting INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(tenant,id));
      CREATE INDEX IF NOT EXISTS clarification_pending ON clarification_runs(tenant,waiting,id);
      CREATE TABLE IF NOT EXISTS clarification_execution_ids (
        tenant TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY(tenant,task_id));`);
  }
  close(): void { this.db.close(); }
  read<T>(id: string): HostSnapshot<T> | undefined {
    const row = this.db.prepare('SELECT revision,body FROM clarification_runs WHERE tenant=? AND id=?').get(this.tenantId, id);
    if (!row) return undefined;
    if (typeof row.revision !== 'number' || typeof row.body !== 'string') throw new Error('Invalid persisted clarification record');
    return { revision: row.revision, value: JSON.parse(row.body) as T };
  }
  pending(afterId = '', limit = 50): string[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid pending page size');
    return this.db.prepare('SELECT id FROM clarification_runs WHERE tenant=? AND waiting=1 AND id>? ORDER BY id LIMIT ?')
      .all(this.tenantId, afterId, limit).map(row => String(row.id));
  }
  write<T>(id: string, expected: number | null, value: T, waiting: boolean, newTaskId?: string): HostSnapshot<T> {
    if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER)) throw new Error('Invalid Host revision');
    const body = JSON.stringify(value);
    if (body === undefined) throw new Error('Host record must be JSON');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (waiting) {
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM clarification_runs WHERE tenant=? AND waiting=1 AND id<>?').get(this.tenantId, id);
        if (Number(count?.n) >= this.maxPending) throw new Error('Host pending question cap reached');
      }
      const revision = expected === null ? 0 : expected + 1;
      const result = expected === null
        ? this.db.prepare('INSERT OR IGNORE INTO clarification_runs VALUES(?,?,?,?,?)').run(this.tenantId,id,revision,Number(waiting),body)
        : this.db.prepare('UPDATE clarification_runs SET revision=?,waiting=?,body=? WHERE tenant=? AND id=? AND revision=?').run(revision,Number(waiting),body,this.tenantId,id,expected);
      if (Number(result.changes) !== 1) throw new HostRevisionConflict();
      if (newTaskId !== undefined) {
        const inserted = this.db.prepare('INSERT OR IGNORE INTO clarification_execution_ids VALUES(?,?)').run(this.tenantId,newTaskId);
        if (Number(inserted.changes) !== 1) throw new Error('Host taskId has already been reserved');
      }
      this.db.exec('COMMIT');
      return { revision, value: JSON.parse(body) as T };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
