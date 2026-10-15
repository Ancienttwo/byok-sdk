/**
 * The wire-major startup fence for the hosted mailbox (PRD §8.3 "升级与排空").
 *
 * Every pending `outbox` row is an envelope the cloud already committed to
 * deliver. Wire v3 has no v2 reader, so a pending row written by an older
 * build can never be delivered correctly: the device would refuse it and stall
 * its cursor, or the cloud would hand it a payload it cannot decode. The only
 * honest outcome is to refuse the composition before it serves a request, the
 * same rule the embedded SQLite store applies
 * (`SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED`, `@byok-sdk/server`).
 *
 * The scan is read-only: SELECTs over pending rows in primary-key order, and
 * nothing else. No row is rewritten, reclassified or deleted; the operator
 * either drains the mailbox with the previous SDK or starts a new database and
 * re-enrolls. Acked and expired rows are history and are not inspected.
 */
import { PROTOCOL_VERSION } from '@byok-sdk/protocol';
import type { Pool } from 'pg';

export const POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED = 'POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED' as const;

/** Pending rows per scan page. Bodies are bounded by the mailbox byte limit, so a page is bounded too. */
const SCAN_PAGE_ROWS = 256;

/**
 * A pending mailbox row is not a wire envelope of this build's
 * `PROTOCOL_VERSION`. Thrown by `createPostgresCloudStores` before any store is
 * returned; the database is left exactly as it was.
 */
export class PostgresMailboxProtocolUnsupportedError extends Error {
  readonly code = POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED;
  /** The wire major every pending row must carry (`PROTOCOL_VERSION`). */
  readonly requiredVersion: number;
  /** The first offending row, in `(tenant_id, device_id, seq)` order. */
  readonly tenantId: string;
  readonly deviceId: string;
  readonly seq: bigint;

  constructor(row: { readonly tenantId: string; readonly deviceId: string; readonly seq: bigint }) {
    super(
      `Pending mailbox rows do not use protocol v${PROTOCOL_VERSION} (first: tenant ${row.tenantId}, device ${row.deviceId}, seq ${row.seq}); ` +
        'preserve the database and drain it with the previous SDK before upgrading, or use a new database and enrollment',
    );
    this.name = 'PostgresMailboxProtocolUnsupportedError';
    this.requiredVersion = PROTOCOL_VERSION;
    this.tenantId = row.tenantId;
    this.deviceId = row.deviceId;
    this.seq = row.seq;
  }
}

interface PendingRow {
  readonly tenant_id: string;
  readonly device_id: string;
  /** Text, so the cursor round-trips without depending on the pool's int8 parser. */
  readonly seq_text: string;
  readonly body: string;
}

/** The same predicate as the SQLite fence: a JSON object whose `v` is exactly `PROTOCOL_VERSION`. */
function isCurrentEnvelope(body: string): boolean {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    return false;
  }
  return typeof envelope === 'object' && envelope !== null && 'v' in envelope && envelope.v === PROTOCOL_VERSION;
}

/**
 * Refuse with {@link PostgresMailboxProtocolUnsupportedError} if any pending
 * `outbox` row is not a current-major envelope. Keyset pagination over the
 * primary key keeps each page bounded; the first offender stops the scan.
 */
export async function assertPendingMailboxProtocol(pool: Pool): Promise<void> {
  let after: PendingRow | undefined;
  for (;;) {
    const page: { rows: PendingRow[] } = after === undefined
      ? await pool.query<PendingRow>(
        `SELECT tenant_id, device_id, seq::text AS seq_text, body FROM outbox
          WHERE state = 'pending'
          ORDER BY tenant_id, device_id, seq
          LIMIT $1`,
        [SCAN_PAGE_ROWS],
      )
      : await pool.query<PendingRow>(
        `SELECT tenant_id, device_id, seq::text AS seq_text, body FROM outbox
          WHERE state = 'pending' AND (tenant_id, device_id, seq) > ($1::text, $2::text, $3::bigint)
          ORDER BY tenant_id, device_id, seq
          LIMIT $4`,
        [after.tenant_id, after.device_id, after.seq_text, SCAN_PAGE_ROWS],
      );
    for (const row of page.rows) {
      if (!isCurrentEnvelope(row.body)) {
        throw new PostgresMailboxProtocolUnsupportedError({ tenantId: row.tenant_id, deviceId: row.device_id, seq: BigInt(row.seq_text) });
      }
    }
    if (page.rows.length < SCAN_PAGE_ROWS) return;
    after = page.rows[page.rows.length - 1];
  }
}
