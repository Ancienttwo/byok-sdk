import { fileURLToPath } from 'node:url';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresTaskAttemptStore } from '../stores/task-attempts';
import {
  createDataplaneScope,
  SKIP_DATAPLANE,
  SKIP_REASON,
} from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('tenant-agent-message-admission');
const DEVICE = 'agent-message-admission-device';
const MESSAGE_ID = '10000000-0000-4000-8000-000000000220';
const AGENT_A = { agentId: 'agent-message-admission-a', profileRevision: '7' } as const;
const AGENT_B = { agentId: 'agent-message-admission-b', profileRevision: '7' } as const;

function admission(taskId: string, agentRef: typeof AGENT_A | typeof AGENT_B) {
  return {
    taskId,
    deviceId: DEVICE,
    messageId: MESSAGE_ID,
    payloadBody: JSON.stringify({ agentRef, messageId: MESSAGE_ID }),
  };
}

describe.skipIf(SKIP_DATAPLANE)(`Postgres Agent-message admission — ${SKIP_REASON}`, () => {
  it('isolates one same-device message id per exact Agent task attempt while retaining retry idempotency', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const tasks = new PostgresTaskAttemptStore(scope.pool, createMutableClock());
      const firstTaskId = 'agent-message-admission-task-a';
      const secondTaskId = 'agent-message-admission-task-b';
      const first = admission(firstTaskId, AGENT_A);
      const second = admission(secondTaskId, AGENT_B);

      await tasks.reserveAgentOffer(TENANT, { taskId: firstTaskId, deviceId: DEVICE, agentRef: AGENT_A });
      await tasks.reserveAgentOffer(TENANT, { taskId: secondTaskId, deviceId: DEVICE, agentRef: AGENT_B });
      await expect(tasks.reserveAgentMessage(TENANT, first)).resolves.toBe('reserved');
      await expect(tasks.reserveAgentMessage(TENANT, first)).resolves.toBe('pending');
      await expect(tasks.reserveAgentMessage(TENANT, second)).resolves.toBe('reserved');
      await expect(tasks.reserveAgentMessage(TENANT, second)).resolves.toBe('pending');

      const rows = await scope.pool.query<{ task_id: string; message_id: string }>(
        `SELECT task_id, message_id
           FROM agent_message_admission
          WHERE tenant_id = $1 AND device_id = $2 AND message_id = $3
          ORDER BY task_id`,
        [TENANT, DEVICE, MESSAGE_ID],
      );
      expect(rows.rows).toEqual([
        { task_id: firstTaskId, message_id: MESSAGE_ID },
        { task_id: secondTaskId, message_id: MESSAGE_ID },
      ]);

      await expect(tasks.finalizeAgentMessage(TENANT, {
        ...first,
        terminalBody: JSON.stringify({ outcome: 'accepted', taskId: firstTaskId }),
      })).resolves.toMatchObject({ messageId: MESSAGE_ID });
      await expect(tasks.readAgentMessage(TENANT, first)).resolves.toMatchObject({
        messageId: MESSAGE_ID,
        terminalBody: JSON.stringify({ outcome: 'accepted', taskId: firstTaskId }),
      });
      await expect(tasks.readAgentMessage(TENANT, second)).resolves.toMatchObject({
        messageId: MESSAGE_ID,
        payloadBody: second.payloadBody,
      });
    } finally {
      await scope.dispose();
    }
  });
});
