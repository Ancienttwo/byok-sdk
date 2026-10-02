import { SQLITE_MIGRATIONS, SqliteStorage, type SqliteDatabase, type SqliteExecutor, type SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';
import type { DurableStorageFactory } from '../../client/src/adapters/pi-durable/storage';

// pi owns schema/migrations. Discover its identifiers rather than maintaining a second schema.
const names = new Set(['durable_schema']);
for (const migration of SQLITE_MIGRATIONS) for (const sql of migration.statements) {
  for (const match of sql.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi)) names.add(match[1]!);
}
const identifiers = new RegExp(`\\b(${[...names].join('|')})\\b`, 'g');
function prefixed(sql: string): string {
  return sql.split(/('(?:[^']|'')*')/).map((part, i) => i % 2 ? part : part.replace(identifiers, name => `pi_${name}`)).join('');
}
function binding(value: SqliteValue): SqlStorageValue {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError('SQLite integer outside safe range');
    return Number(value);
  }
  if (value instanceof Uint8Array) return new Uint8Array(value).buffer;
  return value;
}
function row<T extends object>(raw: Record<string, SqlStorageValue>): T {
  const result: Record<string, unknown> = { ...raw };
  for (const [key, value] of Object.entries(result)) if (value instanceof ArrayBuffer) result[key] = new Uint8Array(value);
  return result as T;
}

/** One adapter per DO database: unrelated reads, writes, transactions and close share this queue. */
export class DurableObjectSqliteDatabase implements SqliteDatabase {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly storage: DurableObjectStorage) {}

  private queued<T>(operation: () => T | Promise<T>, allowClosed = false): Promise<T> {
    const result = this.tail.then(() => {
      if (this.closed && !allowClosed) throw new Error('SQLite database is closed');
      return operation();
    });
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  private executor(active: () => boolean): SqliteExecutor {
    const query = (sql: string, params: SqliteValue[]) => {
      if (!active()) throw new Error('SQLite transaction handle is no longer active');
      return this.storage.sql.exec(prefixed(sql), ...params.map(binding));
    };
    return {
      exec: async sql => { query(sql, []).toArray(); },
      run: async (sql, ...params) => { query(sql, params).toArray(); },
      get: async <T extends object>(sql: string, ...params: SqliteValue[]) => {
        const rows = query(sql, params).toArray();
        return rows[0] === undefined ? undefined : row<T>(rows[0]);
      },
      all: async <T extends object>(sql: string, ...params: SqliteValue[]) => query(sql, params).toArray().map(raw => row<T>(raw)),
    };
  }

  exec(sql: string): Promise<void> { return this.queued(() => this.executor(() => true).exec(sql)); }
  run(sql: string, ...params: SqliteValue[]): Promise<void> { return this.queued(() => this.executor(() => true).run(sql, ...params)); }
  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> { return this.queued(() => this.executor(() => true).get<T>(sql, ...params)); }
  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> { return this.queued(() => this.executor(() => true).all<T>(sql, ...params)); }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.queued(() => this.storage.transaction(async () => {
      let active = true;
      try { return await callback(this.executor(() => active)); }
      finally { active = false; }
    }));
  }

  close(): Promise<void> {
    // The DO owns the physical connection; closing only invalidates this adapter.
    return this.queued(() => {
      if (this.closed) return;
      this.closed = true;
    }, true); // Only idempotent close may pass the closed-operation gate.
  }
}

export const openDurableObjectStorage: DurableStorageFactory<DurableObjectStorage> = storage =>
  SqliteStorage.open(new DurableObjectSqliteDatabase(storage));
