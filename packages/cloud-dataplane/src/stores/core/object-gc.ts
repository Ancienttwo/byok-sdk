import { ByokCoreError, type ContentHash, type TenantId } from '@byok-sdk/core';
import type { PoolClient } from 'pg';

export async function settleDeletedObject(
    client: PoolClient,
    tenant: TenantId,
    hash: ContentHash,
    now: string,
  ): Promise<bigint | undefined> {
    const settled = await client.query<{
      readonly gc_accounted_bytes: bigint;
    }>(
      `WITH locked_manifest AS MATERIALIZED (
         SELECT m.tenant_id, m.gc_accounted_bytes, m.gc_accounted_object
           FROM object_manifest m
          WHERE m.tenant_id = $1 AND m.hash = $2
            AND m.state = 'delete_pending'
            AND m.ref_count = 0
            AND m.gc_accounted_bytes IS NOT NULL
            AND m.gc_accounted_object IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM object_reference r
               WHERE r.tenant_id = m.tenant_id AND r.hash = m.hash
            )
          FOR UPDATE OF m
       ), candidate AS MATERIALIZED (
         SELECT m.gc_accounted_bytes, m.gc_accounted_object
           FROM locked_manifest m JOIN storage_usage u ON u.tenant_id = m.tenant_id
          WHERE u.committed_object_bytes >= m.gc_accounted_bytes
            AND u.object_count >= CASE WHEN m.gc_accounted_object THEN 1 ELSE 0 END
          FOR UPDATE OF u
       ), moved AS (
         UPDATE object_manifest m
            SET state = 'deleted', updated_at = $3
           FROM candidate c
          WHERE m.tenant_id = $1 AND m.hash = $2 AND m.state = 'delete_pending'
         RETURNING c.gc_accounted_bytes, c.gc_accounted_object
       ), accounted AS (
         UPDATE storage_usage u
            SET committed_object_bytes = u.committed_object_bytes - moved.gc_accounted_bytes,
                object_count = u.object_count - CASE WHEN moved.gc_accounted_object THEN 1 ELSE 0 END,
                updated_at = $3
           FROM moved
          WHERE u.tenant_id = $1
         RETURNING moved.gc_accounted_bytes
       )
       SELECT gc_accounted_bytes FROM accounted`,
      [tenant, hash, now],
    );
    const row = settled.rows[0];
    if (row !== undefined) return row.gc_accounted_bytes;
    const current = await client.query<{ readonly state: string }>(
      'SELECT state FROM object_manifest WHERE tenant_id = $1 AND hash = $2',
      [tenant, hash],
    );
    if (current.rows[0]?.state === 'deleted') return undefined;
    throw new ByokCoreError(
      'storage_integrity_mismatch',
      `Object ${hash} could not settle its delete tombstone against storage usage.`,
    );
  }

