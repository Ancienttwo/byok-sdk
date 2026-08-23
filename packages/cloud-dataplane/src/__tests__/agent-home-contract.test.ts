import { fileURLToPath } from 'node:url';
import { AGENT_HOME_CONTRACT_CAPABILITY } from '@byok-sdk/cloud';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresDeviceDirectory } from '../stores/devices';
import { PostgresTaskAttemptStore } from '../stores/task-attempts';
import {
  createDataplaneScope,
  POSTGRES_URL,
  SKIP_REASON,
} from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('tenant-agent-home-readback');
const OTHER_TENANT = tenantId('tenant-agent-home-readback-other');
const AGENT_REF = { agentId: 'durable-agent-1', profileRevision: 'profile-r7' } as const;

if (POSTGRES_URL === undefined) {
  describe.skip(`Postgres Agent-home durable readback — ${SKIP_REASON}`, () => {
    it('needs a real Postgres substrate', () => undefined);
  });
} else {
  describe('Postgres Agent-home durable readback', () => {
    it('reads exact capability, AgentRef, owner, and terminal cause through a fresh pool/store composition', async () => {
      const scope = await createDataplaneScope(2);
      let restartedPool: ReturnType<typeof scope.openRestartPool> | undefined;
      try {
        await migrate(scope.pool, DEPLOY_SQL);
        const clock = createMutableClock();
        const devices = new PostgresDeviceDirectory(scope.pool, clock);
        const tasks = new PostgresTaskAttemptStore(scope.pool, clock);

        await devices.register(TENANT, {
          productId: 'agent-home-product',
          deviceId: 'agent-home-device',
          deviceName: 'Agent home host',
          devicePublicKey: 'agent-home-public-key',
          proofKeyId: 'agent-home-proof-key',
          proofKeyEpoch: 0,
        });
        await devices.recordCapabilities(TENANT, {
          deviceId: 'agent-home-device',
          capabilities: [AGENT_HOME_CONTRACT_CAPABILITY, 'result-document'],
        });
        await expect(tasks.open(TENANT, {
          taskId: 'agent-home-invalid-backslash',
          deviceId: 'agent-home-device',
          agentRef: { agentId: 'invalid\\agent', profileRevision: 'profile-r7' },
        })).rejects.toThrow(/task_agent_ref_bounded/);
        await expect(tasks.get(TENANT, 'agent-home-invalid-backslash')).resolves.toBeUndefined();
        await expect(tasks.open(TENANT, {
          taskId: 'agent-home-invalid-windows-name',
          deviceId: 'agent-home-device',
          agentRef: { agentId: 'CON', profileRevision: 'profile-r7' },
        })).rejects.toThrow(/task_agent_ref_bounded/);
        await expect(tasks.get(TENANT, 'agent-home-invalid-windows-name')).resolves.toBeUndefined();
        const reservations = await Promise.all([
          tasks.reserveAgentOffer(TENANT, {
            taskId: 'agent-home-concurrent-reservation',
            deviceId: 'agent-home-device',
            agentRef: AGENT_REF,
          }),
          tasks.reserveAgentOffer(TENANT, {
            taskId: 'agent-home-concurrent-reservation',
            deviceId: 'agent-home-device',
            agentRef: AGENT_REF,
          }),
        ]);
        expect(reservations.filter((reservation) => reservation.created)).toHaveLength(1);
        expect(reservations.filter((reservation) => !reservation.created)).toHaveLength(1);
        await tasks.recordStatus(TENANT, {
          taskId: 'agent-home-concurrent-reservation',
          status: 'failed',
          agentRef: { agentId: 'other-agent', profileRevision: 'profile-r7' },
          terminalCause: 'must not overwrite identity',
        });
        await expect(tasks.get(TENANT, 'agent-home-concurrent-reservation')).resolves.toMatchObject({
          status: 'offered',
          agentRef: AGENT_REF,
        });
        await tasks.open(TENANT, {
          taskId: 'agent-home-task',
          deviceId: 'agent-home-device',
          agentRef: AGENT_REF,
        });
        await tasks.claim(TENANT, {
          taskId: 'agent-home-task',
          deviceId: 'agent-home-device',
        });
        await tasks.recordStatus(TENANT, {
          taskId: 'agent-home-task',
          status: 'failed',
          agentRef: AGENT_REF,
          terminalCause: 'runtime stopped',
        });

        // A new pool plus new store objects model a cloud process restart. No
        // object above is reused; the migrated Postgres rows are the authority.
        restartedPool = scope.openRestartPool(2);
        const restartedDevices = new PostgresDeviceDirectory(restartedPool, clock);
        const restartedTasks = new PostgresTaskAttemptStore(restartedPool, clock);

        await expect(restartedDevices.get(TENANT, 'agent-home-device')).resolves.toMatchObject({
          capabilities: [AGENT_HOME_CONTRACT_CAPABILITY, 'result-document'],
        });
        await expect(restartedTasks.get(TENANT, 'agent-home-task')).resolves.toMatchObject({
          agentRef: AGENT_REF,
          ownerDeviceId: 'agent-home-device',
          status: 'failed',
          terminalCause: 'runtime stopped',
        });
        await expect(restartedDevices.get(OTHER_TENANT, 'agent-home-device')).resolves.toBeUndefined();
        await expect(restartedTasks.get(OTHER_TENANT, 'agent-home-task')).resolves.toBeUndefined();
      } finally {
        await restartedPool?.end();
        await scope.dispose();
      }
    });
  });
}
