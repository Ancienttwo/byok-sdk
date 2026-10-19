import { DatabaseSync } from 'node:sqlite';
import type { LedgerState } from './model';

function empty(): LedgerState {
  return { version: 1, sequence: 0, scanSequence: 0, intents: {}, executions: {}, routines: {},
    occurrences: {}, slots: {}, outbox: {}, applied: {}, application: {}, scanWake: null };
}

/** Small single-owner reference. Keep this database separate from the SDK and Agent home. */
export class HostLedger {
  private readonly db: DatabaseSync;
  constructor(filename: string, readonly tenant: string) {
    if (!filename || !tenant.trim()) throw new Error('Select a Host database and tenant');
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS host_ledger (tenant TEXT PRIMARY KEY, body TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO host_ledger VALUES (?, ?)').run(tenant, JSON.stringify(empty()));
  }
  snapshot(): LedgerState {
    const row = this.db.prepare('SELECT body FROM host_ledger WHERE tenant=?').get(this.tenant);
    if (typeof row?.body !== 'string') throw new Error('Missing Host ledger');
    const state = JSON.parse(row.body) as LedgerState;
    if (state.version !== 1) throw new Error('Unsupported Host ledger version');
    return state;
  }
  transaction<T>(apply: (state: LedgerState) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.snapshot();
      const result = apply(state);
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Host transactions must be synchronous');
      this.db.prepare('UPDATE host_ledger SET body=? WHERE tenant=?').run(JSON.stringify(state), this.tenant);
      this.db.exec('COMMIT');
      return structuredClone(result);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}
