import { fileURLToPath } from 'node:url';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import {
  runApprovalTimelineConformance,
  type ApprovalTimelineCompositionFactory,
} from '@byok-sdk/conformance';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresApprovalTimelineStore } from '../stores/approval-timeline';
import {
  createDataplaneScope,
  SKIP_DATAPLANE,
  SKIP_REASON,
} from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));

const factory: ApprovalTimelineCompositionFactory = {
  async create() {
    const scope = await createDataplaneScope();
    await migrate(scope.pool, DEPLOY_SQL);
    const clock = createMutableClock();
    return {
      store: new PostgresApprovalTimelineStore(scope.pool, clock),
      advanceTime: (ms) => clock.advance(ms),
      dispose: () => scope.dispose(),
    };
  },
};

if (SKIP_DATAPLANE) {
  describe.skip(`approval timeline store conformance [postgres] — ${SKIP_REASON}`, () => {
    it('needs a dataplane substrate', () => undefined);
  });
} else {
  runApprovalTimelineConformance('postgres', factory);
}

describe.skipIf(SKIP_DATAPLANE)('approval revision authority', () => {
  it('fails closed without mutating a live row whose next revision is inconsistent', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const tenant = tenantId('tenant-malformed-approval-revision');
      const receivedAt = clock.now().toISOString();
      const entries = [
        {
          taskId: 'task-malformed-revision',
          sourceEnvelopeId: 'envelope-existing',
          revision: 3,
          receivedAt,
          event: {
            type: 'approval_requested',
            approvalId: 'approval-existing',
            summary: 'Existing request',
          },
        },
      ];
      await scope.pool.query(
        `INSERT INTO approval_timeline_tail
           (tenant_id, task_id, entries, next_revision, dropped, capacity)
         VALUES ($1, $2, $3::jsonb, 3, 0, 50)`,
        [tenant, 'task-malformed-revision', JSON.stringify(entries)],
      );
      const store = new PostgresApprovalTimelineStore(scope.pool, clock);
      await expect(
        store.append(tenant, {
          taskId: 'task-malformed-revision',
          sourceEnvelopeId: 'envelope-next',
          event: {
            type: 'approval_requested',
            approvalId: 'approval-next',
            summary: 'Next request',
          },
        }),
      ).rejects.toThrow('revision authority is malformed');
      const unchanged = await scope.pool.query<{ entries: unknown; next_revision: bigint }>(
        `SELECT entries, next_revision
           FROM approval_timeline_tail
          WHERE tenant_id = $1 AND task_id = $2`,
        [tenant, 'task-malformed-revision'],
      );
      expect(unchanged.rows[0]).toEqual({ entries, next_revision: 3n });
    } finally {
      await scope.dispose();
    }
  });
});

describe.skipIf(SKIP_DATAPLANE)('approval admission at the task close (#1113 A3)', () => {
  it('refuses a first observation that races the close of a task with no timeline yet', async () => {
    const scope = await createDataplaneScope();
    const closing = await scope.pool.connect();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const tenant = tenantId('tenant-approval-close-race');
      await scope.pool.query(
        `INSERT INTO task (tenant_id, task_id, device_id, status, updated_at) VALUES ($1, 'task', 'device', 'running', $2)`,
        [tenant, clock.now().toISOString()],
      );
      // The close inserts the closed row and holds it until it commits.
      await closing.query('BEGIN');
      await closing.query(`UPDATE task SET status = 'complete', terminal_at = $2 WHERE tenant_id = $1 AND task_id = 'task'`, [tenant, clock.now().toISOString()]);
      const store = new PostgresApprovalTimelineStore(scope.pool, clock);
      const racing = store.append(tenant, {
        taskId: 'task',
        sourceEnvelopeId: 'envelope-racing',
        event: { type: 'approval_requested', approvalId: 'approval-racing', summary: 'Late request' },
      }).then(() => undefined, (caught: unknown) => caught);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await closing.query('COMMIT');
      await expect(racing).resolves.toMatchObject({ code: 'approval_timeline_settled' });
      await expect(store.read(tenant, 'task')).resolves.toMatchObject({ entries: [], terminalAt: clock.now().toISOString() });
    } finally {
      closing.release();
      await scope.dispose();
    }
  });
});
