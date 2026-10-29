import type { RetentionPolicy } from '@byok-sdk/cloud';
import { tenantId, type Clock, type TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
import type { ByokPool } from '../pool';
import { CloudCleanupError } from '../maintenance-errors';

export interface TenantRetentionPolicyInput extends RetentionPolicy {
  readonly policyId: string;
}

export interface TenantRetentionPolicy extends TenantRetentionPolicyInput {
  readonly tenantId: TenantId;
  readonly updatedAt: string;
}

interface RetentionPolicyRow {
  readonly tenant_id: string;
  readonly policy_id: string;
  readonly mailbox_acked_retention_ms: bigint;
  readonly mailbox_unacked_retention_ms: bigint;
  readonly mailbox_dead_letter_retention_ms: bigint;
  readonly request_receipt_retention_ms: bigint;
  readonly object_orphan_grace_ms: bigint;
  readonly updated_at: string;
}

/** Tenant-owned policy on the Worker-loadable maintenance surface; no defaults. */
export class PostgresRetentionPolicyStore {
  readonly #pool: Pool;
  constructor(pool: ByokPool, private readonly clock: Clock) { this.#pool = pool; }

  async writeRetentionPolicy(
    tenant: TenantId,
    input: TenantRetentionPolicyInput,
  ): Promise<TenantRetentionPolicy> {
    assertPolicy(input);
    const written = await this.#pool.query<RetentionPolicyRow>(
       `INSERT INTO tenant_retention_policy (
         tenant_id, policy_id, mailbox_acked_retention_ms,
         mailbox_unacked_retention_ms, mailbox_dead_letter_retention_ms,
         request_receipt_retention_ms, object_orphan_grace_ms, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, policy_id) DO UPDATE
          SET mailbox_acked_retention_ms = EXCLUDED.mailbox_acked_retention_ms,
              mailbox_unacked_retention_ms = EXCLUDED.mailbox_unacked_retention_ms,
              mailbox_dead_letter_retention_ms = EXCLUDED.mailbox_dead_letter_retention_ms,
              request_receipt_retention_ms = EXCLUDED.request_receipt_retention_ms,
              object_orphan_grace_ms = EXCLUDED.object_orphan_grace_ms,
              updated_at = EXCLUDED.updated_at
       RETURNING tenant_id, policy_id, mailbox_acked_retention_ms,
                 mailbox_unacked_retention_ms, mailbox_dead_letter_retention_ms,
                 request_receipt_retention_ms, object_orphan_grace_ms, updated_at`,
      [
        tenant,
        input.policyId,
        input.mailboxAckedRetentionMs,
        input.mailboxUnackedRetentionMs,
        input.mailboxDeadLetterRetentionMs,
        input.requestReceiptRetentionMs,
        input.objectOrphanGraceMs,
        this.clock.now().toISOString(),
      ],
    );
    return toPolicy(written.rows[0]!);
  }

  async readRetentionPolicy(tenant: TenantId): Promise<TenantRetentionPolicy> {
    const result = await this.#pool.query<RetentionPolicyRow>(
      `SELECT p.tenant_id, p.policy_id, p.mailbox_acked_retention_ms,
              p.mailbox_unacked_retention_ms, p.mailbox_dead_letter_retention_ms,
              p.request_receipt_retention_ms, p.object_orphan_grace_ms, p.updated_at
         FROM storage_entitlement e
         JOIN tenant_retention_policy p
           ON p.tenant_id = e.tenant_id AND p.policy_id = e.retention_policy_id
        WHERE e.tenant_id = $1`,
      [tenant],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new CloudCleanupError(
        'cleanup_policy_missing',
        `Tenant ${tenant} has no retention policy matching its entitlement.`,
      );
    }
    const policy = toPolicy(row);
    assertPolicy(policy);
    return policy;
  }

}

function toPolicy(row: RetentionPolicyRow): TenantRetentionPolicy {
  return {
    tenantId: tenantId(row.tenant_id),
    policyId: row.policy_id,
    mailboxAckedRetentionMs: row.mailbox_acked_retention_ms,
    mailboxUnackedRetentionMs: row.mailbox_unacked_retention_ms,
    mailboxDeadLetterRetentionMs: row.mailbox_dead_letter_retention_ms,
    requestReceiptRetentionMs: row.request_receipt_retention_ms,
    objectOrphanGraceMs: row.object_orphan_grace_ms,
    updatedAt: row.updated_at,
  };
}

function assertPolicy(input: TenantRetentionPolicyInput): void {
  if (typeof input.policyId !== 'string' || input.policyId.length === 0 || input.policyId.length > 256 || input.policyId.trim() !== input.policyId) {
    throw new CloudCleanupError('cleanup_invalid_input', 'policyId must be a non-empty, unpadded string no longer than 256 characters.');
  }
  for (const [field, value] of [
    ['mailboxAckedRetentionMs', input.mailboxAckedRetentionMs],
    ['mailboxUnackedRetentionMs', input.mailboxUnackedRetentionMs],
    ['mailboxDeadLetterRetentionMs', input.mailboxDeadLetterRetentionMs],
    ['requestReceiptRetentionMs', input.requestReceiptRetentionMs],
    ['objectOrphanGraceMs', input.objectOrphanGraceMs],
  ] as const) {
    if (typeof value !== 'bigint' || value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CloudCleanupError(
        'cleanup_invalid_input',
        `${field} must be a positive bigint duration no larger than Number.MAX_SAFE_INTEGER milliseconds.`,
      );
    }
  }
}

