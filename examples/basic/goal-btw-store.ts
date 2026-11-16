// Copy-and-own Host reference. This is not an SDK storage adapter or public API.
// Select a separate Host database explicitly; never point it at an Agent home
// or the daemon's SDK store. Acceptance uses SQLite and stub runtimes only.
import { DatabaseSync } from 'node:sqlite';
import { readSqliteFileUnchanged, SQLITE_USER_OBJECT, sqliteOpenPath } from '@byok-sdk/core/sqlite-node';

export interface HostSnapshot<T> { readonly revision: number; readonly value: T; }

export class HostRevisionConflict extends Error {
  readonly code = 'host_revision_conflict';
  constructor() { super('Host state changed; reread before making another decision'); }
}

/** A Host database in another format than this store's. It is refused before any write and left as it is. */
export class HostFormatError extends Error {
  readonly code = 'host_format';
  constructor(message: string) { super(message); this.name = 'HostFormatError'; }
}

/**
 * Format authority of a Host database: one row per store, so the Clarification
 * and goal/btw stores can share a file. A file with tables but no `host_format`
 * predates it and is refused.
 */
export interface HostStoreFormat {
  readonly owner: string;
  readonly version: number;
  readonly tables: readonly string[];
  /** This version's tables and indexes, created once in a new file. */
  readonly ddl: string;
}

function hostFormat(db: DatabaseSync, format: HostStoreFormat): 'new' | 'current' {
  const names = new Set(db.prepare(`SELECT name FROM sqlite_schema WHERE type='table' AND ${SQLITE_USER_OBJECT}`).all().map(row => String(row.name)));
  if (names.size === 0) return 'new';
  if (!names.has('host_format')) throw new HostFormatError('Host database has tables but no host_format; it predates this store format');
  const row = db.prepare('SELECT version FROM host_format WHERE owner=?').get(format.owner);
  if (row === undefined) {
    if (format.tables.some(table => names.has(table))) throw new HostFormatError(`Host database has ${format.owner} tables without a format version`);
    return 'new';
  }
  if (row.version !== format.version || format.tables.some(table => !names.has(table))) {
    throw new HostFormatError(`Host database has ${format.owner} format ${String(row.version)}; this Host reads ${format.version}`);
  }
  return 'current';
}

/**
 * Open a Host database for one store. The format is decided on the unchanged
 * main file before the writable open, and again inside the creating
 * transaction, where a not-yet-checkpointed WAL is visible. A new store
 * checkpoints at once so its format reaches the main file.
 */
export function openHostDatabase(filename: string, format: HostStoreFormat, pragmas: string): DatabaseSync {
  readSqliteFileUnchanged(filename, db => hostFormat(db, format));
  const db = new DatabaseSync(sqliteOpenPath(filename));
  try {
    if (hostFormat(db, format) === 'current') {
      db.exec(pragmas);
      return db;
    }
    db.exec(`${pragmas} BEGIN IMMEDIATE;`);
    try {
      if (hostFormat(db, format) === 'new') {
        db.exec(`CREATE TABLE IF NOT EXISTS host_format (owner TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT; ${format.ddl}`);
        db.prepare('INSERT INTO host_format (owner, version) VALUES (?, ?)').run(format.owner, format.version);
      }
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const GOAL_BTW_FORMAT: HostStoreFormat = {
  owner: 'goal-btw',
  version: 1,
  tables: ['bot_state', 'bot_execution_ids'],
  ddl: `CREATE TABLE bot_state (
        host_id TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(host_id, key));
      CREATE TABLE bot_execution_ids (
        host_id TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY(host_id, task_id));`,
};

export class SqliteGoalBtwStore {
  private readonly db: DatabaseSync;
  constructor(filename: string, private readonly hostId: string) {
    if (!filename || !hostId) throw new Error('Select an explicit Host database and namespace');
    this.db = openHostDatabase(filename, GOAL_BTW_FORMAT, 'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
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
