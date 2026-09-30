// Copy-and-own Host reference. This is not an SDK storage adapter or public API.
// Select a separate Host database explicitly; never point it at an Agent home
// or the daemon's SDK store. Acceptance uses SQLite and stub runtimes only.
import { DatabaseSync } from 'node:sqlite';

export interface HostSnapshot<T> { readonly revision: number; readonly value: T; }

export class HostRevisionConflict extends Error {
  readonly code = 'host_revision_conflict';
  constructor() { super('Host state changed; reread before making another decision'); }
}

export class SqliteGoalBtwStore {
  private readonly db: DatabaseSync;
  constructor(filename: string, private readonly hostId: string) {
    if (!filename || !hostId) throw new Error('Select an explicit Host database and namespace');
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS bot_state (
        host_id TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(host_id, key));
      CREATE TABLE IF NOT EXISTS bot_execution_ids (
        host_id TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY(host_id, task_id));`);
  }
  close(): void { this.db.close(); }
  read<T>(key: string): HostSnapshot<T> | undefined {
    const row = this.db.prepare('SELECT revision, body FROM bot_state WHERE host_id=? AND key=?').get(this.hostId, key);
    if (!row) return undefined;
    if (typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 0 || typeof row.body !== 'string') {
      throw new Error('Invalid persisted Host state');
    }
    // This example's own JSON is decoded at the SQLite boundary. The composition
    // validates its discriminator, binding and budget before acting on a row.
    return { revision: row.revision, value: JSON.parse(row.body) as T };
  }
  write<T>(key: string, expectedRevision: number | null, value: T, newTaskId?: string): HostSnapshot<T> {
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER)) {
      throw new Error('Invalid Host revision');
    }
    const body = JSON.stringify(value);
    if (body === undefined) throw new Error('Host state must be JSON');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const revision = expectedRevision === null ? 0 : expectedRevision + 1;
      if (expectedRevision === null) {
        const result = this.db.prepare('INSERT OR IGNORE INTO bot_state VALUES (?, ?, ?, ?)').run(this.hostId, key, revision, body);
        if (Number(result.changes) !== 1) throw new HostRevisionConflict();
      } else {
        const result = this.db.prepare('UPDATE bot_state SET revision=?, body=? WHERE host_id=? AND key=? AND revision=?')
          .run(revision, body, this.hostId, key, expectedRevision);
        if (Number(result.changes) !== 1) throw new HostRevisionConflict();
      }
      if (newTaskId !== undefined) {
        // Retain the ID after settlement: restarting a goal never reuses an old
        // execution or promotes a previous terminal into a new step.
        const inserted = this.db.prepare('INSERT OR IGNORE INTO bot_execution_ids VALUES (?, ?)').run(this.hostId, newTaskId);
        if (Number(inserted.changes) !== 1) throw new Error('Host taskId has already been reserved');
      }
      this.db.exec('COMMIT');
      return { revision, value: JSON.parse(body) as T };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
