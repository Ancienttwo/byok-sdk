import { fileURLToPath } from 'node:url';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe.skipIf(SKIP_DATAPLANE)('one-shot activity log migration', () => {
  it('drops pre-cutover history without conversion, rejects its cursor, and reopens idempotently', async () => {
    const scope = await createDataplaneScope();
    const previous = await mkdtemp(join(tmpdir(), 'byok-activity-migration-'));
    try {
      for (const file of await readdir(DEPLOY_SQL)) {
        if (file.endsWith('.sql') && file < '0034') await copyFile(join(DEPLOY_SQL, file), join(previous, file));
      }
      await migrate(scope.pool, previous);
      const clock = createMutableClock();
      const tenant = tenantId('tenant-legacy-activity');
      await scope.pool.query(
        `INSERT INTO activity_tail (tenant_id, task_id, entries, dropped, capacity, expires_at)
         VALUES ($1, 'task', $2::jsonb, 0, 50, $3)`,
        [tenant, JSON.stringify([{ detail: 'pre-cutover-canary' }]), new Date(clock.now().getTime() + 60_000).toISOString()],
      );
      await migrate(scope.pool, DEPLOY_SQL);
      expect((await scope.pool.query("SELECT to_regclass('activity_tail') AS old")).rows[0].old).toBeNull();
      expect((await scope.pool.query('SELECT count(*) FROM activity_log_head')).rows[0].count).toBe(0n);
      const store = new PostgresActivityStore(scope.pool, clock);
      await expect(store.read(tenant, 'task', { after: { batchSeq: 1, eventIndex: 0 } as never })).rejects.toMatchObject({ code: 'activity_history_gap' });
      expect(await store.read(tenant, 'task')).toBeUndefined();
      const tail = await store.append(tenant, { taskId: 'task', sourceEnvelopeId: 'new', batchSeq: 1, events: [{ type: 'turn_end' }], dropped: 0, ttlMs: 600_000 });
      expect(tail.entries).toHaveLength(1);
      expect(JSON.stringify(tail)).not.toContain('pre-cutover-canary');
      await migrate(scope.pool, DEPLOY_SQL);
      expect(await store.read(tenant, 'task')).toEqual(tail);
    } finally {
      await scope.dispose();
      await rm(previous, { recursive: true, force: true });
    }
  });
});
