import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WireV4ReceiptMigrationError } from '@byok-sdk/cloud';
import { decodeEnvelope } from '@byok-sdk/protocol';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { migratePostgresReceiptsToWireV4 } from '../wire-v4-receipt-migration';
import { createDataplaneScope, SKIP_DATAPLANE } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const v3Terminal = readFileSync(new URL('../../../protocol/src/__tests__/golden/v3.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd().split('\n')
  .find((line) => (JSON.parse(line) as { type: string }).type === 'task.complete')!;
const AGENT = { agentId: 'agent-1', profileRevision: 'rev-1' };
const agentOffer = JSON.stringify({ deviceId: 'device-1', type: 'task.offer_for_agent', payload: { instruction: 'x', agentRef: AGENT } });
const legacyOffer = JSON.stringify({ deviceId: 'device-1', type: 'task.offer', payload: { instruction: 'x' } });
const unrelated = '{"anything":"kept"}';

async function seed(pool: Pool, rows: ReadonlyArray<readonly [tenant: string, key: string, body: string]>): Promise<void> {
  for (const [tenant, key, body] of rows) {
    await pool.query(
      'INSERT INTO device_request_receipts (tenant_id, key, body, recorded_at) VALUES ($1, $2, $3, $4)',
      [tenant, key, body, '2026-10-01T00:00:00.000Z'],
    );
  }
}

async function snapshot(pool: Pool): Promise<ReadonlyArray<{ tenant_id: string; key: string; body: string; recorded_at: Date }>> {
  return (await pool.query('SELECT tenant_id, key, body, recorded_at FROM device_request_receipts ORDER BY tenant_id, key')).rows;
}

describe.skipIf(SKIP_DATAPLANE)('Postgres wire v3 -> v4 receipt migration (#925)', () => {
  it('re-encodes v3 terminal receipts and keeps v4-readable and unrelated receipts', async () => {
    const scope = await createDataplaneScope(2);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      await seed(scope.pool, [
        ['tenant-a', 'task:t1:terminal', v3Terminal],
        ['tenant-b', 'task:t1:terminal', v3Terminal],
        ['tenant-a', 'task-offer:m1', agentOffer],
        ['tenant-a', 'task-redaction:t1', unrelated],
      ]);

      expect(await migratePostgresReceiptsToWireV4(scope.pool)).toEqual({ migrated: 2, unchanged: 1 });

      const rows = await snapshot(scope.pool);
      for (const row of rows.filter((r) => r.key === 'task:t1:terminal')) {
        expect(decodeEnvelope(row.body)).toMatchObject({ v: 4, type: 'task.complete' });
        expect(row.recorded_at.toISOString()).toBe('2026-10-01T00:00:00.000Z');
      }
      expect(rows.find((r) => r.key === 'task-offer:m1')!.body).toBe(agentOffer);
      expect(rows.find((r) => r.key === 'task-redaction:t1')!.body).toBe(unrelated);
      expect(await migratePostgresReceiptsToWireV4(scope.pool)).toEqual({ migrated: 0, unchanged: 3 });
    } finally {
      await scope.dispose();
    }
  });

  it('changes no receipt and lists the refused ones when any receipt cannot be migrated', async () => {
    const scope = await createDataplaneScope(2);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      await seed(scope.pool, [
        ['tenant-a', 'task:t1:terminal', v3Terminal],
        ['tenant-a', 'task-offer:legacy', legacyOffer],
      ]);
      const before = await snapshot(scope.pool);

      const failure = await migratePostgresReceiptsToWireV4(scope.pool).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(WireV4ReceiptMigrationError);
      expect((failure as WireV4ReceiptMigrationError).refused).toEqual([
        { tenantId: 'tenant-a', key: 'task-offer:legacy', kind: 'offer', refusal: 'type_without_v4_form', type: 'task.offer' },
      ]);
      expect(await snapshot(scope.pool)).toEqual(before);
    } finally {
      await scope.dispose();
    }
  });
});
