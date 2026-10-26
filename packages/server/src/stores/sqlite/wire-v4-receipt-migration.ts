/**
 * The embedded SQLite runner of the one-shot wire v3 -> v4 receipt migration
 * (#925). An operator runs it once on a stopped server's database file, after
 * draining v3 work. It ships in 0.31.x only; the next minor removes it.
 */
import { existsSync } from 'node:fs';
import {
  WireV4ReceiptMigrationError,
  migrateWireV3Receipt,
  wireV4ReceiptKind,
  type WireV4ReceiptMigrationResult,
  type WireV4ReceiptRefusal,
} from '@byok-sdk/cloud';
import { openSqliteDatabase, SqliteSchemaError } from '../../sqlite-support';
import { SQLITE_SCHEMA_VERSION } from './index';

const PAGE_SIZE = 500;

interface ReceiptRow {
  readonly tenant_id: string;
  readonly key: string;
  readonly body: string;
}

/**
 * Migrates every offer and terminal receipt in the embedded store at `path`
 * in one transaction. It opens the file with the store's exclusive
 * ownership, so it fails while a server owns the file. When any receipt is
 * refused it rolls back, so no receipt changes, and throws
 * {@link WireV4ReceiptMigrationError} listing each refused receipt.
 */
export function migrateSqliteReceiptsToWireV4(path: string): WireV4ReceiptMigrationResult {
  if (path === ':memory:' || !existsSync(path)) {
    throw new SqliteSchemaError('SQLITE_SCHEMA_INVALID', `No BYOK SQLite database at ${path}`, undefined, SQLITE_SCHEMA_VERSION);
  }
  const db = openSqliteDatabase(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const version = (db.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined)?.value;
      if (version !== SQLITE_SCHEMA_VERSION) {
        throw new SqliteSchemaError(
          'SQLITE_SCHEMA_UNSUPPORTED',
          `The receipt migration needs BYOK SQLite schema version ${SQLITE_SCHEMA_VERSION}, found ${JSON.stringify(version)}`,
          version,
          SQLITE_SCHEMA_VERSION,
        );
      }
      const page = db.prepare(
        `SELECT tenant_id, key, body FROM request_receipt
         WHERE (key LIKE 'task-offer:%' OR key LIKE 'task:%') AND (tenant_id, key) > (?, ?)
         ORDER BY tenant_id, key LIMIT ?`,
      );
      const update = db.prepare('UPDATE request_receipt SET body = ? WHERE tenant_id = ? AND key = ?');
      let migrated = 0;
      let unchanged = 0;
      const refused: WireV4ReceiptRefusal[] = [];
      // Keyset pages bound memory; the receipt families never expire, so the table can be large.
      let after = { tenantId: '', key: '' };
      for (;;) {
        const rows = page.all(after.tenantId, after.key, PAGE_SIZE) as unknown as ReceiptRow[];
        for (const row of rows) {
          const kind = wireV4ReceiptKind(row.key);
          if (kind === undefined) continue;
          const result = migrateWireV3Receipt(kind, row.body);
          if (result.outcome === 'unchanged') {
            unchanged += 1;
          } else if (result.outcome === 'refused') {
            refused.push({
              tenantId: row.tenant_id,
              key: row.key,
              kind,
              refusal: result.refusal,
              ...(result.type === undefined ? {} : { type: result.type }),
            });
          } else {
            update.run(result.body, row.tenant_id, row.key);
            migrated += 1;
          }
        }
        const last = rows.at(-1);
        if (rows.length < PAGE_SIZE || last === undefined) break;
        after = { tenantId: last.tenant_id, key: last.key };
      }
      if (refused.length > 0) throw new WireV4ReceiptMigrationError(refused);
      db.exec('COMMIT');
      return { migrated, unchanged };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}
