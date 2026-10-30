import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresTaskAttemptStore } from '../stores/task-attempts';
import { createDataplaneScope, SKIP_DATAPLANE, SKIP_REASON } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('phase-times');

describe.skipIf(SKIP_DATAPLANE)(`Postgres 0030 and the attempts stored before it — ${SKIP_REASON}`, () => {
  it('reads an attempt from before 0030 with no phase instants and stamps only later transitions', async () => {
    const scope = await createDataplaneScope();
    const before = await mkdtemp(join(tmpdir(), 'byok-before-0030-'));
    try {
      for (const name of await readdir(DEPLOY_SQL)) {
        if (name.endsWith('.sql') && name < '0030') await copyFile(join(DEPLOY_SQL, name), join(before, name));
      }
      await migrate(scope.pool, before);
      await scope.pool.query(
        `INSERT INTO task (tenant_id, task_id, device_id, status, updated_at)
         VALUES ($1, 'old', 'device-1', 'offered', '2026-01-01T00:00:00.000Z')`,
        [TENANT],
      );
      // Add only 0030, so later migrations do not change what this run applies.
      await copyFile(join(DEPLOY_SQL, '0030_task_attempt_phase_times.sql'), join(before, '0030_task_attempt_phase_times.sql'));
      await expect(migrate(scope.pool, before)).resolves.toMatchObject({ applied: ['0030_task_attempt_phase_times.sql'] });
      // The store reads today's schema; the later migrations leave a non-terminal row's phase columns alone.
      await migrate(scope.pool, DEPLOY_SQL);

      const clock = createMutableClock(new Date('2026-10-27T00:00:00.000Z'));
      const store = new PostgresTaskAttemptStore(scope.pool, clock);
      const old = await store.get(TENANT, 'old');
      expect(old).toMatchObject({ status: 'offered', updatedAt: '2026-01-01T00:00:00.000Z' });
      for (const field of ['offeredAt', 'claimedAt', 'firstOutputAt', 'terminalAt']) expect(old).not.toHaveProperty(field);

      await store.claim(TENANT, { taskId: 'old', deviceId: 'device-1' });
      const claimed = await store.get(TENANT, 'old');
      expect(claimed).toMatchObject({ claimedAt: clock.now().toISOString() });
      expect(claimed).not.toHaveProperty('offeredAt');
    } finally {
      await rm(before, { recursive: true, force: true });
      await scope.dispose();
    }
  });
});
