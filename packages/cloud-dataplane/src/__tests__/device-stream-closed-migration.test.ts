import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMutableClock, isCoreError, tenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresMailboxStore } from '../stores/core/mailbox';
import { createDataplaneScope, SKIP_DATAPLANE, SKIP_REASON } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const MIGRATION = '0033_device_stream_closed.sql';
const TENANT = tenantId('stream-closed-migration');

describe.skipIf(SKIP_DATAPLANE)(`Postgres 0033 and the streams stored before it — ${SKIP_REASON}`, () => {
  it('closes the stream of a device retired before it, leaves a registered device open and leaves pending rows to retention', async () => {
    const scope = await createDataplaneScope();
    const before = await mkdtemp(join(tmpdir(), 'byok-before-0033-'));
    try {
      for (const name of await readdir(DEPLOY_SQL)) {
        if (name.endsWith('.sql') && name < '0033') await copyFile(join(DEPLOY_SQL, name), join(before, name));
      }
      await migrate(scope.pool, before);
      await scope.pool.query(
        `INSERT INTO device (tenant_id, device_id, product_id, device_name, device_public_key, proof_key_id, proof_key_epoch)
         VALUES ($1, 'kept', 'product', 'kept device', 'public-key', 'proof-key', 0)`,
        [TENANT],
      );
      for (const deviceId of ['kept', 'gone']) {
        await scope.pool.query(
          `INSERT INTO device_stream (tenant_id, device_id, next_seq, acked_seq, acked_at) VALUES ($1, $2, 2, 0, NULL)`,
          [TENANT, deviceId],
        );
        await scope.pool.query(
          `INSERT INTO outbox (tenant_id, device_id, seq, message_id, body, body_hash, byte_size, state, appended_at)
           VALUES ($1, $2, 1, $3, '{}', $4, 2, 'pending', '2026-10-01T00:00:00.000Z')`,
          [TENANT, deviceId, `${deviceId}-offer`, `sha256:${'a'.repeat(64)}`],
        );
      }

      // Add only 0033, so later migrations do not change what this run applies.
      await copyFile(join(DEPLOY_SQL, MIGRATION), join(before, MIGRATION));
      await expect(migrate(scope.pool, before)).resolves.toMatchObject({ applied: [MIGRATION] });

      const streams = await scope.pool.query<{ device_id: string; closed_cause: string | null; closed: boolean }>(
        `SELECT device_id, closed_cause, closed_at IS NOT NULL AS closed FROM device_stream WHERE tenant_id = $1 ORDER BY device_id`,
        [TENANT],
      );
      expect(streams.rows).toEqual([
        { device_id: 'gone', closed_cause: 'device_revoked', closed: true },
        { device_id: 'kept', closed_cause: null, closed: false },
      ]);
      const rows = await scope.pool.query<{ device_id: string; state: string }>(
        'SELECT device_id, state FROM outbox WHERE tenant_id = $1 ORDER BY device_id',
        [TENANT],
      );
      // The migration writes the tombstone and nothing else: the release gate
      // asserts a candidate migration leaves every seeded row byte equal, and
      // the pending rows nobody can ack belong to the dead-letter retention
      // (#1115), not to a one-shot UPDATE.
      expect(rows.rows).toEqual([{ device_id: 'gone', state: 'pending' }, { device_id: 'kept', state: 'pending' }]);

      const mailbox = new PostgresMailboxStore(scope.pool, createMutableClock(new Date('2026-10-30T00:00:00.000Z')));
      const refused = await mailbox.append(TENANT, {
        deviceId: 'gone',
        messageId: 'gone-offer',
        admission: 'cancellation',
        materialize: () => { throw new Error('a closed stream materializes nothing'); },
      }).then(() => undefined, (caught: unknown) => caught);
      expect(isCoreError(refused, 'mailbox_stream_closed')).toBe(true);
      expect(refused).toMatchObject({ deviceId: 'gone', closeCause: 'device_revoked' });
    } finally {
      await rm(before, { recursive: true, force: true });
      await scope.dispose();
    }
  });
});
