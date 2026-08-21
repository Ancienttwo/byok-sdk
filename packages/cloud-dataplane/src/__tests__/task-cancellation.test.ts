import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentHash, createMutableClock, tenantId } from '@byok-sdk/core';
import { createWebCrypto, type TaskCancellationRequest } from '@byok-sdk/cloud';
import { createEnvelope, encodeEnvelope } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresTaskCancellationStore } from '../stores/task-cancellations';
import { PostgresTaskAttemptStore } from '../stores/task-attempts';
import {
  createDataplaneScope,
  SKIP_DATAPLANE,
  SKIP_REASON,
} from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const INVARIANTS_SQL = readFileSync(
  new URL('../../../../tests/sql/control_plane_invariants.sql', import.meta.url),
  'utf8',
);
const TENANT = tenantId('tenant-cancellation-atomicity');
const OTHER_TENANT = tenantId('tenant-cancellation-other');

function materializeCancellation(
  taskId: string,
  reason: string,
  onMaterialize?: () => void,
): TaskCancellationRequest['materialize'] {
  return async (seq, messageId) => {
    onMaterialize?.();
    const body = encodeEnvelope(
      createEnvelope('task.cancel', { reason }, {
        id: messageId,
        taskId,
        seq,
      }),
    );
    const bytes = new TextEncoder().encode(body);
    return {
      body,
      bodyHash: contentHash(await createWebCrypto().sha256(bytes)),
      byteSize: BigInt(bytes.length),
    };
  };
}

describe.skipIf(SKIP_DATAPLANE)(`Postgres task cancellation — ${SKIP_REASON}`, () => {
  it('rolls back both tombstone and mailbox delivery when materialization fails', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const tasks = new PostgresTaskAttemptStore(scope.pool, clock);
      const cancellations = new PostgresTaskCancellationStore(scope.pool, clock);
      await tasks.open(TENANT, { taskId: 'task-atomic', deviceId: 'device-atomic' });

      await expect(
        cancellations.request(TENANT, {
          taskId: 'task-atomic',
          proposedMessageId: 'cancel-atomic',
          reason: 'stop',
          materialize: async () => {
            throw new Error('injected materialization failure');
          },
        }),
      ).rejects.toThrow('injected materialization failure');

      const unchanged = await tasks.get(TENANT, 'task-atomic');
      expect(unchanged).toMatchObject({ status: 'offered' });
      expect(unchanged?.cancellation).toBeUndefined();
      const rows = await scope.pool.query<{ readonly count: string }>(
        'SELECT count(*)::text AS count FROM outbox WHERE tenant_id = $1 AND device_id = $2',
        [TENANT, 'device-atomic'],
      );
      expect(rows.rows[0]?.count).toBe('0');
      const sequences = await scope.pool.query<{ readonly count: string }>(
        'SELECT count(*)::text AS count FROM device_stream WHERE tenant_id = $1 AND device_id = $2',
        [TENANT, 'device-atomic'],
      );
      expect(sequences.rows[0]?.count).toBe('0');
    } finally {
      await scope.dispose();
    }
  });

  it('rolls back an already-inserted outbox row and sequence when the task update fails', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const tasks = new PostgresTaskAttemptStore(scope.pool, clock);
      const cancellations = new PostgresTaskCancellationStore(scope.pool, clock);
      await tasks.open(TENANT, { taskId: 'task-update-fails', deviceId: 'device-update-fails' });
      await scope.pool.query(`
        CREATE FUNCTION reject_cancellation_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.cancel_requested_at IS NOT NULL THEN
            RAISE EXCEPTION 'injected task update failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER reject_cancellation_update
          BEFORE UPDATE ON task
          FOR EACH ROW EXECUTE FUNCTION reject_cancellation_update();
      `);

      await expect(cancellations.request(TENANT, {
        taskId: 'task-update-fails',
        proposedMessageId: randomUUID(),
        reason: 'must roll back',
        materialize: materializeCancellation('task-update-fails', 'must roll back'),
      })).rejects.toThrow('injected task update failure');

      const unchanged = await tasks.get(TENANT, 'task-update-fails');
      expect(unchanged).toMatchObject({ status: 'offered' });
      expect(unchanged?.cancellation).toBeUndefined();
      const outbox = await scope.pool.query<{ readonly count: string }>(
        'SELECT count(*)::text AS count FROM outbox WHERE tenant_id = $1 AND device_id = $2',
        [TENANT, 'device-update-fails'],
      );
      expect(outbox.rows[0]?.count).toBe('0');
      const streams = await scope.pool.query<{ readonly count: string }>(
        'SELECT count(*)::text AS count FROM device_stream WHERE tenant_id = $1 AND device_id = $2',
        [TENANT, 'device-update-fails'],
      );
      expect(streams.rows[0]?.count).toBe('0');
    } finally {
      await scope.dispose();
    }
  });

  it('commits one cancellation tombstone and one idempotent mailbox row', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const tasks = new PostgresTaskAttemptStore(scope.pool, clock);
      const cancellations = new PostgresTaskCancellationStore(scope.pool, clock);
      await tasks.open(TENANT, { taskId: 'task-once', deviceId: 'device-once' });
      const request = {
        taskId: 'task-once',
        proposedMessageId: randomUUID(),
        reason: 'first reason',
        materialize: materializeCancellation('task-once', 'first reason'),
      } as const;

      const first = await cancellations.request(TENANT, request);
      const second = await cancellations.request(TENANT, {
        ...request,
        proposedMessageId: randomUUID(),
        reason: 'ignored retry reason',
      });

      expect(first).toBeDefined();
      if (first === undefined) throw new Error('task vanished during cancellation');
      expect(second).toEqual(first);
      expect(first.attempt).toMatchObject({
        status: 'cancelled',
        cancellation: { reason: 'first reason' },
      });
      const rows = await scope.pool.query<{ readonly count: string }>(
        'SELECT count(*)::text AS count FROM outbox WHERE tenant_id = $1 AND device_id = $2',
        [TENANT, 'device-once'],
      );
      expect(rows.rows[0]?.count).toBe('1');
    } finally {
      await scope.dispose();
    }
  });

  it('keeps the cancellation tombstone idempotent after acknowledged delivery retention', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const tasks = new PostgresTaskAttemptStore(scope.pool, clock);
      const cancellations = new PostgresTaskCancellationStore(scope.pool, clock);
      await tasks.open(TENANT, { taskId: 'task-retained', deviceId: 'device-retained' });
      const first = await cancellations.request(TENANT, {
        taskId: 'task-retained',
        proposedMessageId: randomUUID(),
        reason: 'retain tombstone',
        materialize: materializeCancellation('task-retained', 'retain tombstone'),
      });
      expect(first?.attempt.status).toBe('cancelled');
      await scope.pool.query(
        "UPDATE outbox SET state = 'acked' WHERE tenant_id = $1 AND device_id = $2",
        [TENANT, 'device-retained'],
      );
      await scope.pool.query(
        "DELETE FROM outbox WHERE tenant_id = $1 AND device_id = $2 AND state = 'acked'",
        [TENANT, 'device-retained'],
      );

      const replay = await cancellations.request(TENANT, {
        taskId: 'task-retained',
        proposedMessageId: randomUUID(),
        reason: 'ignored retry',
        materialize: materializeCancellation('task-retained', 'ignored retry'),
      });

      expect(replay?.attempt).toEqual(first?.attempt);
      expect(replay?.message).toBeUndefined();
    } finally {
      await scope.dispose();
    }
  });

  it('keeps a success accepted before cancellation terminal and does not enqueue a cancel delivery', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const tasks = new PostgresTaskAttemptStore(scope.pool, clock);
      const cancellations = new PostgresTaskCancellationStore(scope.pool, clock);
      await tasks.open(TENANT, { taskId: 'task-succeeded', deviceId: 'device-succeeded' });
      await tasks.claim(TENANT, { taskId: 'task-succeeded', deviceId: 'device-succeeded' });
      await tasks.recordStatus(TENANT, { taskId: 'task-succeeded', status: 'running' });
      await tasks.recordStatus(TENANT, { taskId: 'task-succeeded', status: 'complete' });

      let materializations = 0;
      const mutation = await cancellations.request(TENANT, {
        taskId: 'task-succeeded',
        proposedMessageId: randomUUID(),
        reason: 'too late',
        materialize: materializeCancellation('task-succeeded', 'too late', () => {
          materializations += 1;
        }),
      });

      expect(mutation).toMatchObject({ attempt: { taskId: 'task-succeeded', status: 'complete' } });
      expect(mutation?.attempt.cancellation).toBeUndefined();
      expect(mutation?.message).toBeUndefined();
      expect(materializations).toBe(0);
      const rows = await scope.pool.query<{ readonly count: string }>(
        'SELECT count(*)::text AS count FROM outbox WHERE tenant_id = $1 AND device_id = $2',
        [TENANT, 'device-succeeded'],
      );
      expect(rows.rows[0]?.count).toBe('0');
    } finally {
      await scope.dispose();
    }
  });

  it('coalesces concurrent duplicate cancellations into one tombstone and one delivery', async () => {
    const scope = await createDataplaneScope(16);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const tasks = new PostgresTaskAttemptStore(scope.pool, clock);
      const cancellations = new PostgresTaskCancellationStore(scope.pool, clock);
      await tasks.open(TENANT, { taskId: 'task-concurrent', deviceId: 'device-concurrent' });

      let materializations = 0;
      const mutations = await Promise.all(
        Array.from({ length: 32 }, () => cancellations.request(TENANT, {
          taskId: 'task-concurrent',
          proposedMessageId: randomUUID(),
          reason: 'concurrent stop',
          materialize: materializeCancellation('task-concurrent', 'concurrent stop', () => {
            materializations += 1;
          }),
        })),
      );

      const first = mutations[0];
      expect(first).toBeDefined();
      for (const mutation of mutations) expect(mutation).toEqual(first);
      expect(first).toMatchObject({
        attempt: {
          taskId: 'task-concurrent',
          status: 'cancelled',
          cancellation: { reason: 'concurrent stop' },
        },
      });
      expect(materializations).toBe(1);
      const rows = await scope.pool.query<{ readonly count: string }>(
        'SELECT count(*)::text AS count FROM outbox WHERE tenant_id = $1 AND device_id = $2',
        [TENANT, 'device-concurrent'],
      );
      expect(rows.rows[0]?.count).toBe('1');
    } finally {
      await scope.dispose();
    }
  });

  it('keeps direct dataplane cancellation tenant-closed', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const tasks = new PostgresTaskAttemptStore(scope.pool, clock);
      const cancellations = new PostgresTaskCancellationStore(scope.pool, clock);
      await tasks.open(TENANT, { taskId: 'task-tenant-closed', deviceId: 'device-tenant-closed' });

      await expect(cancellations.request(OTHER_TENANT, {
        taskId: 'task-tenant-closed',
        proposedMessageId: randomUUID(),
        reason: 'wrong tenant',
        materialize: materializeCancellation('task-tenant-closed', 'wrong tenant'),
      })).resolves.toBeUndefined();

      await expect(tasks.get(TENANT, 'task-tenant-closed')).resolves.toMatchObject({ status: 'offered' });
      const rows = await scope.pool.query<{ readonly count: string }>(
        'SELECT count(*)::text AS count FROM outbox WHERE tenant_id = $1 OR tenant_id = $2',
        [TENANT, OTHER_TENANT],
      );
      expect(rows.rows[0]?.count).toBe('0');
    } finally {
      await scope.dispose();
    }
  });

  it('makes the SQL invariant reject a migrated schema missing a 0009 cancellation column', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      await scope.pool.query('ALTER TABLE task DROP COLUMN cancel_message_id');
      await expect(scope.pool.query(INVARIANTS_SQL)).rejects.toThrow(/0009_task_cancellation/);
    } finally {
      await scope.dispose();
    }
  });
});
