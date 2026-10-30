import { createEnvelope } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { handleInboundEnvelope, tenantStoresFor } from '..';
import { ByokCloudError } from '../errors';
import { TENANT_A, TEST_AGENT_REF, createHarness, decodeEventsPage, grantAgentHome, offerPayload, type CloudHarness } from './support/harness';

function deviceStores(harness: CloudHarness, deviceId: string) {
  return tenantStoresFor(
    { kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId },
    { core: harness.core, cloud: harness.stores, mailboxWake: harness.mailboxWake },
  );
}

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
  it('settles the task of a registered device and leaves its offer for that device to read and ack', async () => {
    const { harness, device, offer } = await offered();
    const before = await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 });
    const usage = (await harness.core.mailbox.readUsage(TENANT_A)).bytes;
    expect(usage).toBeGreaterThan(0n);

    const attempt = await harness.cloud.abandonTask(TENANT_A, offer.taskId, 'operator');

    expect(attempt).toMatchObject({ taskId: offer.taskId, status: 'cancelled', terminalCause: 'operator' });
    // Expiring a row a live device has not read would raise its floor past it:
    // its next poll would be a 409 and the daemon would halt for good.
    const after = await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 });
    expect(after.messages.map((message) => message.seq)).toEqual([offer.seq]);
    expect(after.recoverableFrom).toBe(before.recoverableFrom);
    expect((await harness.core.mailbox.readUsage(TENANT_A)).bytes).toBe(usage);
    await expect(harness.cloud.readTaskResult(TENANT_A, offer.taskId)).resolves.toEqual({
      taskId: offer.taskId,
      state: 'cancelled',
      terminalCause: 'operator',
      agentRef: TEST_AGENT_REF,
      recordedAt: attempt.terminalAt,
    });

    // The device polls as usual: the offer is delivered, then acked by the next poll, which frees its quota.
    const polled = await harness.request('/byok/events?cursor=0', { headers: device.authorization });
    expect(polled.status).toBe(200);
    expect(decodeEventsPage(await polled.json()).events.map((event) => event.task_id)).toContain(offer.taskId);
    const acked = await harness.request(`/byok/events?cursor=${offer.seq}`, { headers: device.authorization });
    expect(acked.status).toBe(200);
    expect((await harness.core.mailbox.readUsage(TENANT_A)).bytes).toBe(0n);
    expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 })).recoverableFrom)
      .toBe(before.recoverableFrom);

    // A second call finds a terminal attempt and leaves it as it is.
    await expect(harness.cloud.abandonTask(TENANT_A, offer.taskId, 'device_revoked')).resolves.toEqual(attempt);
  });

  it('refuses every later report from the still-registered device without recording it', async () => {
    const { harness, device, offer } = await offered();
    const attempt = await harness.cloud.abandonTask(TENANT_A, offer.taskId, 'operator');
    const stores = deviceStores(harness, device.deviceId);
    const reports = [
      createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: TEST_AGENT_REF }, { taskId: offer.taskId }),
      createEnvelope('task.started', {}, { taskId: offer.taskId }),
      createEnvelope('task.fail', { reason: 'late', retryable: true, agentRef: TEST_AGENT_REF }, { taskId: offer.taskId }),
    ];

    for (const report of reports) {
      await expect(handleInboundEnvelope(stores, device.deviceId, report), report.type)
        .resolves.toEqual({ outcome: 'rejected', reason: 'task_settled_by_cloud' });
    }
    await expect(harness.cloud.readTaskAttempt(TENANT_A, offer.taskId)).resolves.toEqual(attempt);
    await expect(harness.cloud.readTaskResult(TENANT_A, offer.taskId)).resolves.toMatchObject({ terminalCause: 'operator' });

    // Over HTTP the refusal is a per-envelope state conflict, never a 401/409 that ends the device's run.
    const response = await harness.request('/byok/messages', {
      method: 'POST', headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [createEnvelope('task.fail', { reason: 'later', retryable: true, agentRef: TEST_AGENT_REF }, { taskId: offer.taskId })] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: 0, rejected: 1 });
    expect((await harness.request('/byok/events?cursor=0', { headers: device.authorization })).status).toBe(200);
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
