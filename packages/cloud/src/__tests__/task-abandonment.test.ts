import { describe, expect, it } from 'vitest';
import { ByokCloudError } from '../errors';
import { TENANT_A, TEST_AGENT_REF, createHarness, grantAgentHome, offerPayload } from './support/harness';

async function offered(options?: { readonly machineId: string }) {
  const harness = createHarness();
  const device = await harness.pairDevice(TENANT_A, undefined, options?.machineId);
  await grantAgentHome(harness, TENANT_A, device.deviceId);
  const offer = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: offerPayload('never runs') });
  return { harness, device, offer };
}

async function pendingSeqs(harness: ReturnType<typeof createHarness>, deviceId: string): Promise<number[]> {
  const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId, afterSeq: 0 });
  return page.messages.map((message) => message.seq);
}

describe('host task abandonment', () => {
  it('settles the task, dead-letters its offer and reads back a cloud-settled result', async () => {
    const { harness, device, offer } = await offered();
    expect(await pendingSeqs(harness, device.deviceId)).toEqual([offer.seq]);

    const attempt = await harness.cloud.abandonTask(TENANT_A, offer.taskId, 'operator');

    expect(attempt).toMatchObject({ taskId: offer.taskId, status: 'cancelled', terminalCause: 'operator' });
    expect(await pendingSeqs(harness, device.deviceId)).toEqual([]);
    expect((await harness.core.mailbox.readUsage(TENANT_A)).bytes).toBe(0n);
    await expect(harness.cloud.readTaskResult(TENANT_A, offer.taskId)).resolves.toEqual({
      taskId: offer.taskId,
      state: 'cancelled',
      terminalCause: 'operator',
      agentRef: TEST_AGENT_REF,
      recordedAt: attempt.terminalAt,
    });
    // A second call finds a terminal attempt and leaves it as it is.
    await expect(harness.cloud.abandonTask(TENANT_A, offer.taskId, 'device_revoked')).resolves.toEqual(attempt);
  });

  it('refuses an unknown cause and an unknown task', async () => {
    const { harness, offer } = await offered();
    await expect(harness.cloud.abandonTask(TENANT_A, offer.taskId, 'device_lost' as never)).rejects.toSatisfy(
      (error: unknown) => error instanceof ByokCloudError && error.code === 'coordination_input_invalid',
    );
    await expect(harness.cloud.readTaskAttempt(TENANT_A, offer.taskId)).resolves.toMatchObject({ status: 'offered' });
    await expect(harness.cloud.abandonTask(TENANT_A, 'task_missing', 'operator')).rejects.toSatisfy(
      (error: unknown) => error instanceof ByokCloudError && error.code === 'task_not_found',
    );
  });

  it('keeps the cancellation tombstone as the result of a cancelled task', async () => {
    const { harness, offer } = await offered();
    const cancelled = await harness.cloud.cancelTask(TENANT_A, offer.taskId, 'operator stopped it');

    await harness.cloud.abandonTask(TENANT_A, offer.taskId, 'operator');

    await expect(harness.cloud.readTaskResult(TENANT_A, offer.taskId)).resolves.toMatchObject({
      state: 'cancelled',
      reason: 'operator stopped it',
      terminalCause: 'operator stopped it',
      recordedAt: cancelled.cancellation?.requestedAt,
    });
  });

  it('reports a revoked device task as cancelled under device_revoked', async () => {
    const { harness, device, offer } = await offered();

    await harness.cloud.revokeDevice(TENANT_A, device.deviceId);

    const attempt = await harness.cloud.readTaskAttempt(TENANT_A, offer.taskId);
    expect(attempt).toMatchObject({ status: 'cancelled', terminalCause: 'device_revoked' });
    expect(await pendingSeqs(harness, device.deviceId)).toEqual([]);
    await expect(harness.cloud.readTaskResult(TENANT_A, offer.taskId)).resolves.toMatchObject({
      state: 'cancelled',
      terminalCause: 'device_revoked',
      recordedAt: attempt?.terminalAt,
    });
  });

  it('reports a superseded device task as cancelled under device_superseded', async () => {
    const machineId = 'c'.repeat(64);
    const { harness, offer } = await offered({ machineId });

    await harness.pairDevice(TENANT_A, undefined, machineId);

    await expect(harness.cloud.readTaskResult(TENANT_A, offer.taskId)).resolves.toMatchObject({
      state: 'cancelled',
      terminalCause: 'device_superseded',
    });
  });
});
