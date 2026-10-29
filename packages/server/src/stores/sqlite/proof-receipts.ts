import { assertCanonicalTimestamp, assertCollectExpiredInput, type Clock, type CollectExpiredResult, type TenantId } from '@byok-sdk/core';
import type {
  ProofReceiptCollectExpiredInput,
  ProofReceiptRetentionAuthority,
  ProofRequestReceipt,
  ProofRequestReceiptInput,
  ProofRequestReceiptStore,
} from '@byok-sdk/cloud';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Used device-proof request ids, in the same table shape as the Postgres
 * `proof_request_receipt`. Added to every database on open with
 * `IF NOT EXISTS`, after the schema version gate, and then checked by
 * projection, so a same-named table of another shape fails closed.
 */
export const PROOF_REQUEST_RECEIPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS proof_request_receipt (
  tenant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  resource TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  body_size INTEGER NOT NULL CHECK (body_size >= 0),
  response_status INTEGER NOT NULL CHECK (response_status >= 100 AND response_status <= 599),
  response_body TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, device_id, request_id)
);
CREATE INDEX IF NOT EXISTS proof_request_receipt_recorded_idx
  ON proof_request_receipt (tenant_id, recorded_at);
`;

export const PROOF_REQUEST_RECEIPT_PROJECTION =
  'tenant_id, device_id, request_id, operation, resource, body_sha256, body_size, response_status, response_body, recorded_at FROM proof_request_receipt';

interface Coordinator {
  run<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T>;
  transaction<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T>;
}

interface ProofReceiptRow {
  readonly tenant_id: string;
  readonly device_id: string;
  readonly request_id: string;
  readonly operation: string;
  readonly resource: string;
  readonly body_sha256: string;
  readonly body_size: number;
  readonly response_status: number;
  readonly response_body: string;
  readonly recorded_at: string;
}

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
    recordedAt: row.recorded_at,
  };
}

function read(db: DatabaseSync, tenant: TenantId, deviceId: string, requestId: string): ProofRequestReceipt | undefined {
  const row = db.prepare(`SELECT ${PROOF_REQUEST_RECEIPT_PROJECTION} WHERE tenant_id = ? AND device_id = ? AND request_id = ?`)
    .get(tenant, deviceId, requestId) as ProofReceiptRow | undefined;
  return row === undefined ? undefined : toReceipt(row);
}

/** First-result-wins proof receipts; the cloud's `proofReceipts` port. */
export class SqliteProofRequestReceiptStore implements ProofRequestReceiptStore {
  constructor(private readonly coordinator: Coordinator, private readonly clock: Clock) {}

  record(tenant: TenantId, input: ProofRequestReceiptInput): Promise<{ readonly receipt: ProofRequestReceipt; readonly created: boolean }> {
    return this.coordinator.run((db) => {
      const result = db.prepare(`INSERT INTO proof_request_receipt (tenant_id, device_id, request_id, operation, resource, body_sha256, body_size, response_status, response_body, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, device_id, request_id) DO NOTHING`)
        .run(tenant, input.deviceId, input.requestId, input.operation, input.resource, input.bodySha256, input.bodySize,
          input.responseStatus, input.responseBody, this.clock.now().toISOString());
      return { receipt: read(db, tenant, input.deviceId, input.requestId)!, created: Number(result.changes) === 1 };
    });
  }

  get(tenant: TenantId, deviceId: string, requestId: string): Promise<ProofRequestReceipt | undefined> {
    return this.coordinator.run(db => read(db, tenant, deviceId, requestId));
  }
}

/**
 * Prunes `proof_request_receipt`; the server passes it as the cloud's
 * `proofReceiptRetention.authority`. It is separate from the `proofReceipts`
 * port, which keeps exactly the methods the cloud contract declares.
 */
export class SqliteProofReceiptRetentionAuthority implements ProofReceiptRetentionAuthority {
  constructor(private readonly coordinator: Coordinator) {}

  async collectExpired(tenant: TenantId, input: ProofReceiptCollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    assertCanonicalTimestamp(input.recordedBefore, 'recordedBefore');
    return this.coordinator.transaction((db): CollectExpiredResult => {
      const removed = Number(db.prepare(`DELETE FROM proof_request_receipt WHERE rowid IN (
        SELECT rowid FROM proof_request_receipt
        WHERE tenant_id = ? AND recorded_at < ?
        ORDER BY recorded_at, device_id, request_id
        LIMIT ?
      )`).run(tenant, input.recordedBefore, input.limit).changes);
      const more = db.prepare('SELECT 1 FROM proof_request_receipt WHERE tenant_id = ? AND recorded_at < ? LIMIT 1')
        .get(tenant, input.recordedBefore) !== undefined;
      return { removed, expired: 0, releasedBytes: 0n, more };
    });
  }
}
