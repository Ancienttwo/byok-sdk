import { statSync } from 'node:fs';
import { readSqliteSnapshot, SqliteReadOnlyOpenError, SqliteSnapshotError } from '@byok-sdk/core/sqlite-node';
import { HostStoreFormatError, K4_FORMAT, storedFormats } from './ledger.js';
import type { LedgerState } from './model.js';

/** The K4 body fields `readHostLedger` decodes and checks for one tenant. */
export type HostLedgerReadState = Pick<LedgerState, 'application' | 'intents' | 'executions'>;
/** One `host_ledger` row. A malformed row is reported here and does not hide the other rows. */
export type HostLedgerTenantRead =
  | { tenant: string; ok: true; state: HostLedgerReadState }
  /** `tenant` is `null` when the stored tenant is not a string. */
  | { tenant: string | null; ok: false; code: 'corrupt_row'; message: string };
/**
 * The result of {@link readHostLedger}.
 * - `ok`: every tenant row of one committed state, ordered by tenant; empty when the table has no rows.
 * - `absent`: nothing to read: no file or an empty one (`no_file`), or a database without the `host_ledger` table (`no_table`).
 * - `retryable`: no consistent state could be taken this time. `snapshot_changed`: a writer changed the database, its WAL or its
 *   rollback journal while it was copied. `hot_journal`: a rollback journal may need recovery; it stays until a writer opens the ledger.
 * - `unreadable`: the ledger itself cannot be read: the path is not a regular file, the file is not SQLite or is damaged, its
 *   format is not K4 format 1 (`format_unsupported`), or it could not be read (`open_failed`).
 */
export type HostLedgerRead =
  | { kind: 'ok'; tenants: HostLedgerTenantRead[] }
  | { kind: 'absent'; reason: 'no_file' | 'no_table' }
  | { kind: 'retryable'; code: 'snapshot_changed' | 'hot_journal'; message: string }
  | { kind: 'unreadable'; code: 'not_a_file' | 'not_sqlite' | 'corrupt' | 'format_unsupported' | 'open_failed'; message: string };

type Unreadable = Extract<HostLedgerRead, { kind: 'unreadable' }>;
const unreadable = (code: Unreadable['code'], error: unknown): Unreadable =>
  ({ kind: 'unreadable', code, message: error instanceof Error ? error.message : String(error) });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Read every tenant of a K4 Host ledger without opening it for writing (#2474). The ledger is read from a private copy of
 * its database, WAL and rollback journal (`readSqliteSnapshot`): SQLite never opens the original, so the database, WAL and
 * SHM files are not written, and none is created. Committed WAL frames are seen; a copy taken while a writer changed the
 * files is discarded as `retryable`. Other layers' `host_store_format` rows, such as K8's, are not checked: only the K4 body
 * is decoded. It never throws for the file's content or state.
 */
export function readHostLedger(path: string): HostLedgerRead {
  try {
    let stat;
    try { stat = statSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent', reason: 'no_file' };
      return unreadable('open_failed', error);
    }
    if (!stat.isFile()) return unreadable('not_a_file', new Error('The Host ledger path is not a regular file'));
    return readSqliteSnapshot(path, (db): HostLedgerRead => {
      const formats = storedFormats(db);
      if (!formats) return { kind: 'absent', reason: 'no_table' };
      if (formats.get('k4') !== K4_FORMAT) {
        return unreadable('format_unsupported', new Error(`This Host ledger holds K4 format ${formats.get('k4') ?? 'none'}; this build reads ${K4_FORMAT}`));
      }
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='host_ledger'").get()) return { kind: 'absent', reason: 'no_table' };
      return { kind: 'ok', tenants: db.prepare('SELECT tenant, body FROM host_ledger ORDER BY tenant').all().map(tenantRow) };
    }) ?? { kind: 'absent', reason: 'no_file' };
  } catch (error) {
    if (error instanceof SqliteSnapshotError) {
      return { kind: 'retryable', code: error.reason === 'changed' ? 'snapshot_changed' : 'hot_journal', message: error.message };
    }
    if (error instanceof HostStoreFormatError) return unreadable('format_unsupported', error);
    if (error instanceof SqliteReadOnlyOpenError) return unreadable('open_failed', error);
    const { code, errcode } = (error ?? {}) as { code?: unknown; errcode?: unknown };
    if (code === 'ERR_SQLITE_ERROR' && typeof errcode === 'number') {
      // Primary result code: 26 SQLITE_NOTADB, 11 SQLITE_CORRUPT, 1 SQLITE_ERROR (a table without the K4 columns).
      const primary = errcode & 0xff;
      if (primary === 26) return unreadable('not_sqlite', error);
      if (primary === 11) return unreadable('corrupt', error);
      if (primary === 1) return unreadable('format_unsupported', error);
    }
    return unreadable('open_failed', error);
  }
}

function tenantRow(row: Record<string, unknown>): HostLedgerTenantRead {
  const corrupt = (message: string): HostLedgerTenantRead =>
    ({ tenant: typeof row.tenant === 'string' ? row.tenant : null, ok: false, code: 'corrupt_row', message });
  if (typeof row.tenant !== 'string') return corrupt('The tenant is not a string');
  if (typeof row.body !== 'string') return corrupt('The ledger body is not text');
  let body: unknown;
  try { body = JSON.parse(row.body); } catch { return corrupt('The ledger body is not JSON'); }
  if (!isRecord(body)) return corrupt('The ledger body is not an object');
  const { application, intents, executions } = body;
  if (!isRecord(application) || !isRecord(intents) || !isRecord(executions)) {
    return corrupt('The ledger body has no application, intents and executions objects');
  }
  return { tenant: row.tenant, ok: true, state: { application, intents, executions } as HostLedgerReadState };
}
