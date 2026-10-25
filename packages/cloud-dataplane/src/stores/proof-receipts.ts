import type {
  ProofReceiptCollectExpiredInput,
  ProofReceiptRetentionAuthority,
  ProofRequestReceipt,
  ProofRequestReceiptInput,
  ProofRequestReceiptStore,
} from '@byok-sdk/cloud';
import { assertCanonicalTimestamp, assertCollectExpiredInput, type Clock, type CollectExpiredResult, type TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';

interface ProofReceiptRow {
  readonly tenant_id: string;
  readonly device_id: string;
  readonly request_id: string;
  readonly operation: string;
  readonly resource: string;
  readonly body_sha256: string;
  readonly body_size: string;
  readonly response_status: number;
  readonly response_body: string;
  readonly recorded_at: Date;
}

const SELECT_COLUMNS = `tenant_id, device_id, request_id, operation, resource,
  body_sha256, body_size, response_status, response_body, recorded_at`;

function toReceipt(row: ProofReceiptRow): ProofRequestReceipt {
  return {
    tenantId: row.tenant_id as TenantId,
    deviceId: row.device_id,
    requestId: row.request_id,
    operation: row.operation,
    resource: row.resource,
    bodySha256: row.body_sha256,
    bodySize: BigInt(row.body_size),
    responseStatus: row.response_status,
    responseBody: row.response_body,
    recordedAt: row.recorded_at.toISOString(),
  };
}

export class PostgresProofRequestReceiptStore implements ProofRequestReceiptStore {
  readonly #pool: Pool;
  readonly #clock: Clock;

  constructor(pool: Pool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async record(
    tenant: TenantId,
    input: ProofRequestReceiptInput,
  ): Promise<{ readonly receipt: ProofRequestReceipt; readonly created: boolean }> {
    const result = await this.#pool.query<ProofReceiptRow>(
      `INSERT INTO proof_request_receipt (
         tenant_id, device_id, request_id, operation, resource, body_sha256,
         body_size, response_status, response_body, recorded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, device_id, request_id) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [
        tenant,
        input.deviceId,
        input.requestId,
        input.operation,
        input.resource,
        input.bodySha256,
        input.bodySize.toString(),
        input.responseStatus,
        input.responseBody,
        this.#clock.now().toISOString(),
      ],
    );
    const inserted = result.rows[0];
    if (inserted !== undefined) return { receipt: toReceipt(inserted), created: true };
    const existing = await this.get(tenant, input.deviceId, input.requestId);
    if (existing === undefined) throw new Error(`proof receipt ${input.requestId} vanished during record`);
    return { receipt: existing, created: false };
  }

  async get(
    tenant: TenantId,
    deviceId: string,
    requestId: string,
  ): Promise<ProofRequestReceipt | undefined> {
    const result = await this.#pool.query<ProofReceiptRow>(
      `SELECT ${SELECT_COLUMNS}
       FROM proof_request_receipt
       WHERE tenant_id = $1 AND device_id = $2 AND request_id = $3`,
      [tenant, deviceId, requestId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toReceipt(row);
  }
}

/**
 * Prunes `proof_request_receipt`, which the truth put and the three E2EE member
 * writes share. A Postgres host passes it as the cloud's
 * `proofReceiptRetention.authority`. It is separate from the `proofReceipts`
 * port, which keeps exactly the methods the cloud contract declares.
 */
export class PostgresProofReceiptRetentionAuthority implements ProofReceiptRetentionAuthority {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async collectExpired(tenant: TenantId, input: ProofReceiptCollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    assertCanonicalTimestamp(input.recordedBefore, 'recordedBefore');
    const result = await this.#pool.query<{ removed: string; more: boolean }>(
      `WITH candidates AS MATERIALIZED (
         SELECT ctid FROM proof_request_receipt
         WHERE tenant_id = $1 AND recorded_at < $2
         ORDER BY recorded_at
         LIMIT $3 + 1
         FOR UPDATE SKIP LOCKED
       ), deleted AS (
         DELETE FROM proof_request_receipt
         WHERE ctid IN (SELECT ctid FROM candidates LIMIT $3)
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM deleted)::text AS removed,
              EXISTS (SELECT 1 FROM candidates OFFSET $3) AS more`,
      [tenant, input.recordedBefore, input.limit],
    );
    return { removed: Number(result.rows[0]!.removed), expired: 0, releasedBytes: 0n, more: result.rows[0]!.more };
  }
}
