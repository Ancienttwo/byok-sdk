import { REQUEST_RECEIPT_PREFIXES, type ReceiptCollectExpiredInput } from '@byok-sdk/cloud';
import { assertCollectExpiredInput, type CollectExpiredResult } from '@byok-sdk/core';
import { assertCanonicalTimestamp } from '@byok-sdk/core';
/**
 * Postgres {@link RequestReceiptStore}: the first write is the fact.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` and nothing else. The terminal a device
 * reports is a fact, and the retry the at-least-once wire guarantees must not
 * overwrite it (§12.6.4: 不覆写第一份事实). `created: false` is how the caller
 * learns it was a replay, which is why an upsert that UPDATED would be wrong in
 * a way no naive "record it twice" test would catch — it would pass, while
 * silently rewriting history and restamping `recorded_at`.
 */
import type { RequestReceipt, RequestReceiptStore } from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
import type { ByokPool } from '../pool';

interface ReceiptRow {
  readonly tenant_id: string;
  readonly key: string;
  readonly body: string;
  readonly recorded_at: Date;
}

const SELECT_COLUMNS = 'tenant_id, key, body, recorded_at';

function toReceipt(row: ReceiptRow): RequestReceipt {
  return {
    tenantId: row.tenant_id as TenantId,
    key: row.key,
    body: row.body,
    recordedAt: row.recorded_at.toISOString(),
  };
}

export class PostgresRequestReceiptStore implements RequestReceiptStore {
  readonly #pool: Pool;
  readonly #clock: Clock;

  constructor(pool: ByokPool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async collectExpired(tenant: TenantId, input: ReceiptCollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    assertCanonicalTimestamp(input.requestBefore, 'requestBefore');
    if (REQUEST_RECEIPT_PREFIXES.length === 0) return { removed: 0, expired: 0, releasedBytes: 0n, more: false };
    const predicates = REQUEST_RECEIPT_PREFIXES.map((_, i) => `left(key, length($${i + 4}::text)) = $${i + 4}`).join(' OR ');
    const result = await this.#pool.query<{removed: string; more: boolean}>(
      `WITH candidates AS MATERIALIZED (
         SELECT ctid FROM device_request_receipts WHERE tenant_id = $1 AND recorded_at < $2 AND (${predicates})
         ORDER BY recorded_at, key LIMIT $3 + 1 FOR UPDATE SKIP LOCKED
       ), deleted AS (
         DELETE FROM device_request_receipts WHERE ctid IN (SELECT ctid FROM candidates LIMIT $3) RETURNING 1
       ) SELECT (SELECT count(*) FROM deleted)::text AS removed,
                EXISTS(SELECT 1 FROM candidates OFFSET $3) AS more`,
      [tenant, input.requestBefore, input.limit, ...REQUEST_RECEIPT_PREFIXES],
    );
    return { removed: Number(result.rows[0]!.removed), expired: 0, releasedBytes: 0n, more: result.rows[0]!.more };
  }

  async record(
    tenant: TenantId,
    input: { readonly key: string; readonly body: string },
  ): Promise<{ readonly receipt: RequestReceipt; readonly created: boolean }> {
    const inserted = await this.#pool.query<ReceiptRow>(
      `INSERT INTO device_request_receipts (tenant_id, key, body, recorded_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, key) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [tenant, input.key, input.body, this.#clock.now().toISOString()],
    );
    const created = inserted.rows[0];
    if (created !== undefined) return { receipt: toReceipt(created), created: true };

    const existing = await this.get(tenant, input.key);
    // Unreachable in practice: the insert only declines when the row exists.
    if (existing === undefined) throw new Error(`receipt ${input.key} vanished during record`);
    return { receipt: existing, created: false };
  }

  async get(tenant: TenantId, key: string): Promise<RequestReceipt | undefined> {
    const result = await this.#pool.query<ReceiptRow>(
      `SELECT ${SELECT_COLUMNS} FROM device_request_receipts WHERE tenant_id = $1 AND key = $2`,
      [tenant, key],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toReceipt(row);
  }
}
