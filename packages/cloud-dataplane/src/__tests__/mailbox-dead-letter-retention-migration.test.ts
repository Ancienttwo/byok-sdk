import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { createDataplaneScope, SKIP_DATAPLANE, SKIP_REASON } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const MIGRATION = '0031_mailbox_dead_letter_retention.sql';
const TENANT = tenantId('dead-letter-retention');

describe.skipIf(SKIP_DATAPLANE)(`Postgres 0031 and the policies stored before it — ${SKIP_REASON}`, () => {
  it('backfills 30 days of dead-letter retention and indexes only pending mailbox bytes', async () => {
    const scope = await createDataplaneScope();
    const before = await mkdtemp(join(tmpdir(), 'byok-before-0031-'));
    try {
      for (const name of await readdir(DEPLOY_SQL)) {
        if (name.endsWith('.sql') && name < '0031') await copyFile(join(DEPLOY_SQL, name), join(before, name));
      }
      await migrate(scope.pool, before);
      await scope.pool.query(
        `INSERT INTO tenant_retention_policy (
           tenant_id, policy_id, mailbox_acked_retention_ms, mailbox_unacked_retention_ms,
           request_receipt_retention_ms, object_orphan_grace_ms, updated_at
         ) VALUES ($1, 'old', 1, 2, 3, 4, '2026-01-01T00:00:00.000Z')`,
        [TENANT],
      );
      // Add only 0031, so later migrations do not change what this run applies.
      await copyFile(join(DEPLOY_SQL, MIGRATION), join(before, MIGRATION));
      await expect(migrate(scope.pool, before)).resolves.toMatchObject({ applied: [MIGRATION] });

      const backfilled = await scope.pool.query<{ readonly ms: string }>(
        `SELECT mailbox_dead_letter_retention_ms::text AS ms FROM tenant_retention_policy
          WHERE tenant_id = $1 AND policy_id = 'old'`,
        [TENANT],
      );
      expect(backfilled.rows).toEqual([{ ms: String(30 * 86_400_000) }]);
      await expect(scope.pool.query(
        `INSERT INTO tenant_retention_policy (
           tenant_id, policy_id, mailbox_acked_retention_ms, mailbox_unacked_retention_ms,
           mailbox_dead_letter_retention_ms, request_receipt_retention_ms, object_orphan_grace_ms, updated_at
         ) VALUES ($1, 'negative', 1, 2, -1, 3, 4, '2026-01-01T00:00:00.000Z')`,
        [TENANT],
      )).rejects.toMatchObject({ code: '23514', constraint: 'tenant_retention_policy_nonnegative' });

      const indexes = await scope.pool.query<{ readonly indexname: string; readonly indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = current_schema() AND tablename = 'outbox'
            AND indexname IN ('outbox_tenant_bytes_idx', 'outbox_tenant_pending_bytes_idx')`,
      );
      expect(indexes.rows.map(row => row.indexname)).toEqual(['outbox_tenant_pending_bytes_idx']);
      expect(indexes.rows[0]!.indexdef).toContain('(tenant_id) INCLUDE (byte_size)');
      expect(indexes.rows[0]!.indexdef).toContain("WHERE (state = 'pending'::text)");
    } finally {
      await rm(before, { recursive: true, force: true });
      await scope.dispose();
    }
  });
});
