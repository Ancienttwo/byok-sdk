import type { TenantId } from '@byok-sdk/core';
import { createEnvelope, decodeEnvelope, type EventsPollResponse } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { handleInboundEnvelope } from '../inbound';
import { tenantStoresFor } from '../tenant-stores';
import {
  TENANT_A,
  TENANT_B,
  createHarness,
  offerPayload,
  type CloudHarness,
  type PairedDevice,
} from './support/harness';

function devicePrincipal(tenant: TenantId, deviceId: string) {
  return { kind: 'device', tenantId: tenant, productId: 'test-product', deviceId } as const;
}

async function poll(
  harness: CloudHarness,
  device: PairedDevice,
  cursor = 0,
): Promise<EventsPollResponse> {
  const response = await harness.request(`/byok/events?cursor=${cursor}`, {
    headers: device.authorization,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as EventsPollResponse;
}

describe('host task cancellation', () => {
  it('cancels before lease and never redelivers the original offer to an offline device', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload('must never start'),
    });

    const cancelled = await harness.cloud.cancelTask(TENANT_A, offer.taskId, 'operator stopped it');

    expect(cancelled).toMatchObject({
      taskId: offer.taskId,
      status: 'cancelled',
      cancellation: { reason: 'operator stopped it' },
    });
    expect(cancelled.cancellation?.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const page = await poll(harness, device);
    expect(page.events.map((event) => event.type)).toEqual(['task.cancel']);
    expect(page.events[0]).toMatchObject({
      task_id: offer.taskId,
      payload: { reason: 'operator stopped it' },
    });
  });

  it('marks leased work cancel_requested and durably delivers the existing task.cancel command', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload('already running'),
    });
    const delivered = await poll(harness, device);
    expect(delivered.cursor).toBe(offer.seq);
    const stores = tenantStoresFor(devicePrincipal(TENANT_A, device.deviceId), {
      core: harness.core,
      cloud: harness.stores,
    });
    await handleInboundEnvelope(
      stores,
      device.deviceId,
      createEnvelope('task.claim', { deviceId: device.deviceId }, { taskId: offer.taskId }),
    );
    await handleInboundEnvelope(
      stores,
      device.deviceId,
      createEnvelope('task.started', {}, { taskId: offer.taskId }),
    );

    const cancellation = await harness.cloud.cancelTask(TENANT_A, offer.taskId, 'stop runtime');
    expect(cancellation.status).toBe('cancel_requested');

    const page = await poll(harness, device, offer.seq);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.type).toBe('task.cancel');
    expect(page.events[0]?.seq).toBeGreaterThan(offer.seq);

    await handleInboundEnvelope(
      stores,
      device.deviceId,
      createEnvelope('task.cancelled', { reason: 'stop runtime' }, { taskId: offer.taskId }),
    );
    await expect(harness.cloud.readTaskAttempt(TENANT_A, offer.taskId)).resolves.toMatchObject({
      status: 'cancelled',
      cancellation: { reason: 'stop runtime' },
    });
    await expect(harness.cloud.readTaskResult(TENANT_A, offer.taskId)).resolves.toMatchObject({
      state: 'cancelled',
      reason: 'stop runtime',
    });
  });

  it('keeps a success accepted before a late host cancellation as the terminal outcome', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload('already succeeded'),
    });
    const stores = tenantStoresFor(devicePrincipal(TENANT_A, device.deviceId), {
      core: harness.core,
      cloud: harness.stores,
    });
    await harness.cloud.createBoardItem(TENANT_A, {
      itemId: offer.taskId,
      channel: 'support',
      title: 'Already succeeded',
      status: 'in_progress',
    });

    await handleInboundEnvelope(
      stores,
      device.deviceId,
      createEnvelope('task.claim', { deviceId: device.deviceId }, { taskId: offer.taskId }),
    );
    await handleInboundEnvelope(
      stores,
      device.deviceId,
      createEnvelope('task.started', {}, { taskId: offer.taskId }),
    );
    await handleInboundEnvelope(
      stores,
      device.deviceId,
      createEnvelope(
        'task.complete',
        { summary: 'success won', sessionRef: 'successful-session' },
        { taskId: offer.taskId },
      ),
    );

    const lateCancellation = await harness.cloud.cancelTask(TENANT_A, offer.taskId, 'too late');

    expect(lateCancellation).toMatchObject({ taskId: offer.taskId, status: 'complete' });
    expect(lateCancellation.cancellation).toBeUndefined();
    await expect(harness.cloud.readTaskResult(TENANT_A, offer.taskId)).resolves.toMatchObject({
      state: 'complete',
      summary: 'success won',
      sessionRef: 'successful-session',
    });
    await expect(harness.cloud.listBoardItems(TENANT_A, {})).resolves.toMatchObject({
      items: [{ itemId: offer.taskId, status: 'in_review' }],
    });

    const mailbox = await harness.core.mailbox.readAfter(TENANT_A, {
      deviceId: device.deviceId,
      afterSeq: 0,
    });
    expect(mailbox.messages.map((row) => decodeEnvelope(row.body).type)).toEqual(['task.offer']);
  });

  it('keeps accepted cancellation ahead of a racing success receipt and creates no review side effect', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload('race success'),
    });
    const stores = tenantStoresFor(devicePrincipal(TENANT_A, device.deviceId), {
      core: harness.core,
      cloud: harness.stores,
    });
    await handleInboundEnvelope(
      stores,
      device.deviceId,
      createEnvelope('task.claim', { deviceId: device.deviceId }, { taskId: offer.taskId }),
    );
    const cancellation = await harness.cloud.cancelTask(TENANT_A, offer.taskId, 'cancel wins');

    await handleInboundEnvelope(
      stores,
      device.deviceId,
      createEnvelope(
        'task.complete',
        { summary: 'late success', sessionRef: 'late-session' },
        { taskId: offer.taskId },
      ),
    );

    const raw = await harness.cloud.readTerminalReceipt(TENANT_A, offer.taskId);
    expect(raw && decodeEnvelope(raw.body).type).toBe('task.complete');
    await expect(harness.cloud.readTaskResult(TENANT_A, offer.taskId)).resolves.toMatchObject({
      state: 'cancelled',
      reason: 'cancel wins',
      recordedAt: cancellation.cancellation?.requestedAt,
    });
    await expect(harness.cloud.listBoardItems(TENANT_A, {})).resolves.toMatchObject({ items: [] });
  });

  it('does not project a racing success when cancellation lands between its read and status CAS', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload('interleaved success'),
    });
    const stores = tenantStoresFor(devicePrincipal(TENANT_A, device.deviceId), {
      core: harness.core,
      cloud: harness.stores,
    });
    await harness.cloud.createBoardItem(TENANT_A, {
      itemId: offer.taskId,
      channel: 'support',
      title: 'Interleaved success',
      status: 'in_progress',
    });
    await handleInboundEnvelope(
      stores,
      device.deviceId,
      createEnvelope('task.claim', { deviceId: device.deviceId }, { taskId: offer.taskId }),
    );

    let releaseStatusMutation!: () => void;
    const statusMutationHeld = new Promise<void>((resolve) => {
      releaseStatusMutation = resolve;
    });
    let statusMutationEntered!: () => void;
    const statusMutationStarted = new Promise<void>((resolve) => {
      statusMutationEntered = resolve;
    });
    const raceStores = {
      ...stores,
      tasks: {
        ...stores.tasks,
        recordStatus: async (input: Parameters<typeof stores.tasks.recordStatus>[0]) => {
          // Pause immediately before the attempt's ordering CAS. All reads and
          // the terminal receipt write have completed; cancellation now lands
          // before the underlying status mutation is allowed to run.
          statusMutationEntered();
          await statusMutationHeld;
          return stores.tasks.recordStatus(input);
        },
      },
    };

    const terminal = handleInboundEnvelope(
      raceStores,
      device.deviceId,
      createEnvelope(
        'task.complete',
        { summary: 'late success', sessionRef: 'late-session' },
        { taskId: offer.taskId },
      ),
    );
    await statusMutationStarted;

    const cancellation = await harness.cloud.cancelTask(TENANT_A, offer.taskId, 'cancel wins the CAS');
    expect(cancellation.status).toBe('cancel_requested');
    releaseStatusMutation();
    await expect(terminal).resolves.toBe('accepted');

    await expect(harness.cloud.readTaskAttempt(TENANT_A, offer.taskId)).resolves.toMatchObject({
      status: 'cancel_requested',
      cancellation: { reason: 'cancel wins the CAS' },
    });
    await expect(harness.cloud.readTaskResult(TENANT_A, offer.taskId)).resolves.toMatchObject({
      state: 'cancelled',
      reason: 'cancel wins the CAS',
    });
    await expect(harness.cloud.listBoardItems(TENANT_A, {})).resolves.toMatchObject({
      items: [{ itemId: offer.taskId, status: 'in_progress' }],
    });
  });

  it('is idempotent and retains the first cancellation reason and one cancel delivery', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload(),
    });

    const first = await harness.cloud.cancelTask(TENANT_A, offer.taskId, 'first reason');
    const second = await harness.cloud.cancelTask(TENANT_A, offer.taskId, 'different retry reason');

    expect(second).toEqual(first);
    const mailbox = await harness.core.mailbox.readAfter(TENANT_A, {
      deviceId: device.deviceId,
      afterSeq: 0,
    });
    expect(mailbox.messages.map((row) => decodeEnvelope(row.body).type)).toEqual([
      'task.offer',
      'task.cancel',
    ]);
  });

  it('coalesces truly concurrent duplicate cancellations into one tombstone and one delivery', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload('cancel concurrently'),
    });
    const reasons = Array.from({ length: 32 }, (_, index) => `concurrent-reason-${index}`);

    // Start every host call before awaiting any result. The in-memory
    // cancellation port must share the in-flight mutation, rather than merely
    // making sequential retries idempotent.
    const cancellations = await Promise.all(
      reasons.map((reason) => harness.cloud.cancelTask(TENANT_A, offer.taskId, reason)),
    );

    expect(new Set(cancellations.map((cancellation) => JSON.stringify(cancellation)))).toHaveLength(1);
    expect(cancellations[0]).toMatchObject({
      taskId: offer.taskId,
      status: 'cancelled',
      cancellation: { reason: expect.stringMatching(/^concurrent-reason-\d+$/) },
    });
    const mailbox = await harness.core.mailbox.readAfter(TENANT_A, {
      deviceId: device.deviceId,
      afterSeq: 0,
    });
    expect(mailbox.messages.map((row) => decodeEnvelope(row.body).type)).toEqual([
      'task.offer',
      'task.cancel',
    ]);
  });

  it('fails closed for unknown and cross-tenant task ids without changing the real task', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload(),
    });

    await expect(harness.cloud.cancelTask(TENANT_B, offer.taskId, 'guess')).rejects.toMatchObject({
      code: 'task_not_found',
    });
    await expect(harness.cloud.cancelTask(TENANT_A, 'missing-task', 'guess')).rejects.toMatchObject({
      code: 'task_not_found',
    });
    await expect(harness.cloud.readTaskAttempt(TENANT_A, offer.taskId)).resolves.toMatchObject({
      status: 'offered',
    });
  });
});
