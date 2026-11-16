import { fileURLToPath } from 'node:url';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresTaskAttemptStore } from '../stores/task-attempts';
import { createDataplaneScope, SKIP_DATAPLANE, SKIP_REASON } from './support/dataplane';

const AGENT_REF = { agentId: 'agent-1', profileRevision: 'rev-1' } as const;

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));

describe.skipIf(SKIP_DATAPLANE)(`custom harness claim CAS — ${SKIP_REASON}`, () => {
  it('persists the first executor across store reconstruction, and the schema holds exactly one once owned', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const tenant = tenantId('custom-harness');
      const store = new PostgresTaskAttemptStore(scope.pool, createMutableClock());
      await store.reserveAgentOffer(tenant, { taskId: 't', deviceId: 'device-a', agentRef: AGENT_REF });
      const outcomes = await Promise.all(['acme-harness', 'other'].map((harnessId) =>
        store.claim(tenant, { taskId: 't', deviceId: 'device-a', executor: { kind: 'harness', harnessId } })));
      const winner = await new PostgresTaskAttemptStore(scope.pool, createMutableClock()).get(tenant, 't');
      expect(winner?.claimedExecutor?.kind).toBe('harness');
      expect(['acme-harness', 'other']).toContain(winner?.claimedExecutor?.kind === 'harness' ? winner.claimedExecutor.harnessId : undefined);
      // Both CAS callers must observe the same immutable winner, so inbound
      // can reject the losing identity without trusting its earlier read.
      for (const outcome of outcomes) expect(outcome).toEqual(winner);
      expect(winner?.ownerDeviceId).toBe('device-a');
      // An owned attempt names exactly one executor: neither both columns (0021, 0040) nor none (0040).
      await expect(scope.pool.query(`UPDATE task SET claimed_runtime = 'pi' WHERE tenant_id = $1 AND task_id = 't'`, [tenant]))
        .rejects.toThrow(/task_claimed_(identity_exclusive|executor_present)/u);
      await expect(scope.pool.query(`UPDATE task SET claimed_harness_id = NULL WHERE tenant_id = $1 AND task_id = 't'`, [tenant]))
        .rejects.toThrow('task_claimed_executor_present');
    } finally { await scope.dispose(); }
  });
});
