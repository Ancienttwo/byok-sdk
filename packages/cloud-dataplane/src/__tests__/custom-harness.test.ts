import { fileURLToPath } from 'node:url';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresTaskAttemptStore } from '../stores/task-attempts';
import { createDataplaneScope, SKIP_DATAPLANE, SKIP_REASON } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));

describe.skipIf(SKIP_DATAPLANE)(`custom harness claim CAS — ${SKIP_REASON}`, () => {
  it('persists the first identity across store reconstruction and rejects dual identity', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const tenant = tenantId('custom-harness');
      const store = new PostgresTaskAttemptStore(scope.pool, createMutableClock());
      await store.open(tenant, { taskId: 't', deviceId: 'device-a' });
      const outcomes = await Promise.all(['acme-harness', 'other'].map((harnessId) =>
        store.claim(tenant, { taskId: 't', deviceId: 'device-a', harnessId })));
      const winner = await new PostgresTaskAttemptStore(scope.pool, createMutableClock()).get(tenant, 't');
      expect(['acme-harness', 'other']).toContain(winner?.claimedHarnessId);
      // Both CAS callers must observe the same immutable winner, so inbound
      // can reject the losing identity without trusting its earlier read.
      for (const outcome of outcomes) expect(outcome).toEqual(winner);
      expect(winner?.ownerDeviceId).toBe('device-a');
      await store.open(tenant, { taskId: 'invalid', deviceId: 'device-a' });
      await expect(store.claim(tenant, { taskId: 'invalid', deviceId: 'device-a', harnessId: 'acme-harness', runtime: 'pi' })).rejects.toThrow('task_claimed_identity_exclusive');
    } finally { await scope.dispose(); }
  });
});
