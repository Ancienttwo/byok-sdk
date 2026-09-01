import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresPairingCodeStore } from '../stores/pairing-codes';
import { PostgresTaskAttemptStore } from '../stores/task-attempts';
import { createDataplaneScope, SKIP_DATAPLANE, SKIP_REASON } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('tenant-issues-112-120');

function enrollment(code: string, deviceId: string) {
  return {
    pairingCode: code,
    deviceId,
    deviceName: 'durable-dataplane-device',
    devicePublicKey: 'durable-public-key',
    proofKeyId: 'identity',
    proofKeyEpoch: 0,
  };
}

describe.skipIf(SKIP_DATAPLANE)(`Issues #112/#120 Postgres regressions — ${SKIP_REASON}`, () => {
  it('keeps one immutable pairing completion and replays only the exact enrollment binding', async () => {
    const scope = await createDataplaneScope(8);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const pairing = new PostgresPairingCodeStore(scope.pool, clock);
      await pairing.issue(TENANT, {
        code: 'ISSUE112',
        productId: 'issue-product',
        expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
      });

      const attempts = await Promise.all([
        pairing.redeemAndRegister(enrollment('ISSUE112', 'device-a')),
        pairing.redeemAndRegister(enrollment('ISSUE112', 'device-b')),
      ]);
      expect(attempts).toEqual([
        expect.objectContaining({ deviceId: 'device-a' }),
        expect.objectContaining({ deviceId: 'device-a' }),
      ]);
      await expect(pairing.redeemAndRegister({ ...enrollment('ISSUE112', 'device-c'), deviceName: 'conflict' })).resolves.toBeUndefined();
      await expect(scope.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM device WHERE tenant_id = $1', [TENANT]))
        .resolves.toMatchObject({ rows: [{ count: '1' }] });
    } finally {
      await scope.dispose();
    }
  });

  it('uses one durable live-task reservation for concurrent agent-message admission and lets cancellation win before a reservation', async () => {
    const scope = await createDataplaneScope(8);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const tasks = new PostgresTaskAttemptStore(scope.pool, clock);
      await tasks.open(TENANT, { taskId: 'issue-message-live', deviceId: 'device-issue' });

      const reservations = await Promise.all(Array.from({ length: 16 }, () =>
        tasks.reserveAgentMessage(TENANT, {
          taskId: 'issue-message-live',
          deviceId: 'device-issue',
          messageId: '10000000-0000-4000-8000-000000001120',
          payloadBody: '{"message":"exact"}',
        }),
      ));
      expect(reservations.filter((result) => result === 'reserved')).toHaveLength(1);
      expect(reservations.filter((result) => result === 'pending')).toHaveLength(15);

      await tasks.open(TENANT, { taskId: 'issue-message-cancelled', deviceId: 'device-issue' });
      await scope.pool.query(
        `UPDATE task SET status = 'cancel_requested', cancel_requested_at = $3 WHERE tenant_id = $1 AND task_id = $2`,
        [TENANT, 'issue-message-cancelled', clock.now().toISOString()],
      );
      await expect(tasks.reserveAgentMessage(TENANT, {
        taskId: 'issue-message-cancelled',
        deviceId: 'device-issue',
        messageId: randomUUID(),
        payloadBody: '{"message":"must-not-run"}',
      })).resolves.toBe('rejected');
    } finally {
      await scope.dispose();
    }
  });

  it('keeps an exact pending admission fail-closed until its owner writes one terminal body', async () => {
    const scope = await createDataplaneScope(8);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const tasks = new PostgresTaskAttemptStore(scope.pool, clock);
      const taskId = 'issue-message-recovery';
      const input = {
        taskId,
        deviceId: 'device-issue',
        messageId: '10000000-0000-4000-8000-000000001121',
        payloadBody: '{"message":"exact"}',
      };
      await tasks.open(TENANT, { taskId, deviceId: input.deviceId });
      expect(await tasks.reserveAgentMessage(TENANT, input)).toBe('reserved');
      clock.advance(60_000);
      expect(await tasks.reserveAgentMessage(TENANT, input)).toBe('pending');
      expect((await tasks.readAgentMessage(TENANT, input))?.terminalBody).toBeUndefined();

      const finalized = await tasks.finalizeAgentMessage(TENANT, {
        ...input,
        terminalBody: '{"outcome":"held"}',
      });
      expect(finalized).toMatchObject({
        messageId: input.messageId,
        payloadBody: input.payloadBody,
        terminalBody: '{"outcome":"held"}',
      });
      await expect(tasks.finalizeAgentMessage(TENANT, {
        ...input,
        terminalBody: '{"outcome":"different"}',
      })).resolves.toMatchObject({ terminalBody: '{"outcome":"held"}' });
    } finally {
      await scope.dispose();
    }
  });
});
