/**
 * The Postgres runner of the one-shot wire v3 -> v4 receipt migration (#925).
 * An operator runs it once, after draining v3 work and before starting a v4
 * cloud. It ships in 0.31.x only; the next minor removes it.
 */
import {
  WireV4ReceiptMigrationError,
  migrateWireV3Receipt,
  wireV4ReceiptKind,
  type WireV4ReceiptRefusal,
} from '@byok-sdk/cloud';
import type { Pool } from 'pg';

const PAGE_SIZE = 500;

export interface WireV4ReceiptMigrationResult {
  /** Receipts rewritten to v4 bytes. */
  readonly migrated: number;
  /** Offer and terminal receipts already readable under v4. */
  readonly unchanged: number;
}

interface ReceiptRow {
  readonly tenant_id: string;
  readonly key: string;
  readonly body: string;
}

/**
 * Migrates every offer and terminal receipt in `device_request_receipts` in
 * one transaction. When any receipt is refused it rolls back, so no receipt
 * changes, and throws {@link WireV4ReceiptMigrationError} listing each refused
 * receipt. Writers must be stopped while it runs.
 */
export async function migratePostgresReceiptsToWireV4(pool: Pool): Promise<WireV4ReceiptMigrationResult> {
  const client = await pool.connect();
  let migrated = 0;
  let unchanged = 0;
  const refused: WireV4ReceiptRefusal[] = [];
  try {
    await client.query('BEGIN');
    let after: { readonly tenantId: string; readonly key: string } | undefined;
    for (;;) {
      // Keyset pages bound memory; the receipt families never expire, so the table can be large.
      const page = await client.query<ReceiptRow>(
        `SELECT tenant_id, key, body FROM device_request_receipts
         WHERE (key LIKE 'task-offer:%' OR key LIKE 'task:%')
           AND ($1::text IS NULL OR (tenant_id, key) > ($1::text, $2::text))
         ORDER BY tenant_id, key LIMIT $3`,
        [after?.tenantId ?? null, after?.key ?? null, PAGE_SIZE],
      );
      for (const row of page.rows) {
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
          await client.query('UPDATE device_request_receipts SET body = $3 WHERE tenant_id = $1 AND key = $2', [
            row.tenant_id,
            row.key,
            result.body,
          ]);
          migrated += 1;
        }
      }
      const last = page.rows.at(-1);
      if (page.rows.length < PAGE_SIZE || last === undefined) break;
      after = { tenantId: last.tenant_id, key: last.key };
    }
    if (refused.length > 0) throw new WireV4ReceiptMigrationError(refused);
    await client.query('COMMIT');
    return { migrated, unchanged };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
