/**
 * The mailbox limit check holds when the session default isolation is raised.
 *
 * `insertOutboxRow` serializes limited admission with a tenant advisory lock
 * and then runs a guarded `INSERT ... WHERE SUM(...) + n <= limit`. That is only
 * a serialized decision when the statement's snapshot starts after the lock is
 * granted (READ COMMITTED). Under REPEATABLE READ the first statement of the
 * transaction fixes the snapshot, so racers that waited on the lock still sum
 * a pre-race world and all pass (verified with
 * `default_transaction_isolation=repeatable read`: 14 admitted against a limit
 * for 10). The writers therefore open with an explicit isolation level, and the
 * writer refuses to run in any other.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contentHash, createMutableClock, isCoreError, tenantId } from '@byok-sdk/core';
import { migrate } from '../migrate';
import { PostgresMailboxStore } from '../stores/core/mailbox';
import { insertOutboxRow } from '../stores/core/outbox-writer';
import { PostgresQuotaStore } from '../stores/core/quota';
import { createDataplaneScope, SKIP_DATAPLANE, SKIP_REASON } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('tenant-isolation');
const HASH = contentHash(`sha256:${'b'.repeat(64)}`);

function body(deviceId: string, messageId: string, bytes: number) {
  return {
    deviceId,
    messageId,
    admission: 'limited' as const,
    materialize: () => ({ body: 'x'.repeat(bytes), bodyHash: HASH, byteSize: BigInt(bytes) }),
  };
}

describe.skipIf(SKIP_DATAPLANE)(`mailbox admission isolation — ${SKIP_REASON}`, () => {
  it('does not oversell when the session default is REPEATABLE READ', async () => {
    const scope = await createDataplaneScope(16);
    // Every connection the pool opens defaults to REPEATABLE READ, the way a
    // host-configured `default_transaction_isolation` would.
    scope.pool.on('connect', (client) => {
      void client.query("SET default_transaction_isolation = 'repeatable read'");
    });
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const quota = new PostgresQuotaStore(scope.pool, clock);
      const mailbox = new PostgresMailboxStore(scope.pool, clock);
      await quota.writeEntitlement(TENANT, {
        version: 1n,
        hardLimitBytes: 1_000_000n,
        maxObjectBytes: 400n,
        maxInlineBytes: 100n,
        mailboxLimitBytes: 100n,
        retentionPolicyId: 'default',
      });

      const defaultLevel = await scope.pool.query<{ transaction_isolation: string }>(
        'SHOW transaction_isolation',
      );
      expect(defaultLevel.rows[0]?.transaction_isolation).toBe('repeatable read');

      const outcomes = await Promise.allSettled(
        Array.from({ length: 40 }, (_unused, index) =>
          mailbox.append(TENANT, body(`device-${index % 8}`, `race-${index}`, 10)),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(10);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect(isCoreError(outcome.reason, 'storage_quota_exceeded')).toBe(true);
        }
      }
      expect((await mailbox.readUsage(TENANT)).bytes).toBe(100n);
    } finally {
      await scope.dispose();
    }
  });

  it('refuses to write an outbox row outside a READ COMMITTED transaction', async () => {
    const scope = await createDataplaneScope(4);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const quota = new PostgresQuotaStore(scope.pool, createMutableClock());
      await quota.writeEntitlement(TENANT, {
        version: 1n,
        hardLimitBytes: 1_000_000n,
        maxObjectBytes: 400n,
        maxInlineBytes: 100n,
        mailboxLimitBytes: 100n,
        retentionPolicyId: 'default',
      });

      const client = await scope.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const input = {
          deviceId: 'device-rr',
          messageId: 'rr-1',
          admission: 'limited' as const,
          now: '2026-01-01T00:00:00.000Z',
          materialize: () => ({ body: 'x', bodyHash: HASH, byteSize: 1n }),
        };
        await expect(insertOutboxRow(client, TENANT, input)).rejects.toThrow(/READ COMMITTED/);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      const rows = await scope.pool.query('SELECT 1 FROM outbox WHERE tenant_id = $1', [TENANT]);
      expect(rows.rowCount).toBe(0);
    } finally {
      await scope.dispose();
    }
  });
});
