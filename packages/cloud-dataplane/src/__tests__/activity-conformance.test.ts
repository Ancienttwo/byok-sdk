import { fileURLToPath } from 'node:url';
import { createMutableClock } from '@byok-sdk/core';
import { runActivityConformance, type ActivityCompositionFactory } from '@byok-sdk/conformance';
import { tenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresActivityStore } from '../stores/activity';
import {
  createDataplaneScope,
  SKIP_DATAPLANE,
  SKIP_REASON,
} from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));

const factory: ActivityCompositionFactory = {
  async create() {
    const scope = await createDataplaneScope();
    await migrate(scope.pool, DEPLOY_SQL);
    const clock = createMutableClock();
    return {
      store: new PostgresActivityStore(scope.pool, clock),
      advanceTime: (ms) => clock.advance(ms),
      dispose: () => scope.dispose(),
    };
  },
};

if (SKIP_DATAPLANE) {
  describe.skip(`activity store conformance [postgres] — ${SKIP_REASON}`, () => {
    it('needs a dataplane substrate', () => undefined);
  });
} else {
  runActivityConformance('postgres', factory);
}

describe.skipIf(SKIP_DATAPLANE)('typed activity JSONB authority', () => {
  it('fails closed when a pre-cutover detail row survives past the required TTL drain', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const tenant = tenantId('tenant-legacy-activity');
      await scope.pool.query(
        `INSERT INTO activity_tail (tenant_id, task_id, entries, dropped, capacity, expires_at)
         VALUES ($1, $2, $3::jsonb, 0, 50, $4)`,
        [
          tenant,
          'task-legacy',
          JSON.stringify([{ at: clock.now().toISOString(), detail: '{"type":"turn_end"}' }]),
          new Date(clock.now().getTime() + 60_000).toISOString(),
        ],
      );
      const store = new PostgresActivityStore(scope.pool, clock);
      await expect(store.read(tenant, 'task-legacy')).rejects.toThrow();
      await expect(
        store.append(tenant, {
          taskId: 'task-legacy',
          sourceEnvelopeId: 'typed-envelope',
          batchSeq: 1,
          events: [{ type: 'turn_end' }],
          dropped: 0,
          ttlMs: 300_000,
        }),
      ).rejects.toThrow();
      const unchanged = await scope.pool.query<{ entries: unknown; expires_at: string }>(
        `SELECT entries, expires_at FROM activity_tail WHERE tenant_id = $1 AND task_id = $2`,
        [tenant, 'task-legacy'],
      );
      expect(unchanged.rows[0]).toEqual({
        entries: [{ at: clock.now().toISOString(), detail: '{"type":"turn_end"}' }],
        expires_at: new Date(clock.now().getTime() + 60_000).toISOString(),
      });
    } finally {
      await scope.dispose();
    }
  });
});
