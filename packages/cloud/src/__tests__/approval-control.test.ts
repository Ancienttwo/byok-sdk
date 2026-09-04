/**
 * GAP-1: `approveTask`/`rejectTask` on the hosted kernel.
 *
 * The reference server resolves an approval off a mutable slot on its own task
 * record (`TaskSnapshot.pendingApprovalId`, `packages/server/src/hub.ts`).
 * Cloud has no such record and deliberately adds none: the two observations
 * that move that slot — `task.await_approval` and `task.approval_resolved` —
 * are already durable in the approval timeline, so the pending approval is
 * DERIVED from the tail on every call (`approval-control.ts`). These tests are
 * about that derivation and the gate order built on it, not about the mailbox
 * plumbing underneath.
 *
 * Every refusal here must also be a NON-EVENT: a rejected call allocates no
 * mailbox row, so an operator's mistargeted click cannot leave a `task.approve`
 * behind for the runtime to act on later.
 */
import type { TenantId } from '@byok-sdk/core';
import { createEnvelope, type EventsPollResponse } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { StaleApprovalError } from '../approval-control';
import { isCloudError } from '../errors';
import { handleInboundEnvelope } from '../inbound';
import { tenantStoresFor } from '../tenant-stores';
import {
  PRODUCT_ID,
  TENANT_A,
  TENANT_B,
  createHarness,
  offerPayload,
  type CloudHarness,
  type PairedDevice,
} from './support/harness';

function devicePrincipal(tenant: TenantId, deviceId: string) {
  return { kind: 'device', tenantId: tenant, productId: PRODUCT_ID, deviceId } as const;
}

function deviceStores(harness: CloudHarness, device: PairedDevice) {
  return tenantStoresFor(devicePrincipal(TENANT_A, device.deviceId), {
    core: harness.core,
    cloud: harness.stores,
  });
}

async function poll(harness: CloudHarness, device: PairedDevice, cursor: number): Promise<EventsPollResponse> {
  const response = await harness.request(`/byok/events?cursor=${cursor}`, {
    headers: device.authorization,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as EventsPollResponse;
}

interface PausedTask {
  readonly taskId: string;
  /** The delivery seq of the offer — the cursor everything after it is polled from. */
  readonly seq: number;
}

/** Offer -> claim -> started: the state a runtime is in when it asks for an approval. */
async function claimedTask(harness: CloudHarness, device: PairedDevice): Promise<PausedTask> {
  const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
    payload: offerPayload('needs a human'),
  });
  // Deliver the offer before anything polls past it: the mailbox refuses a
  // cursor beyond its own delivery watermark, so `offer.seq` is only a usable
  // cursor once the device has actually been handed that row.
  expect((await poll(harness, device, 0)).events.map((event) => event.type)).toEqual(['task.offer']);
  const stores = deviceStores(harness, device);
  expect(
    await handleInboundEnvelope(
      stores,
      device.deviceId,
      createEnvelope('task.claim', { deviceId: device.deviceId }, { taskId: offer.taskId }),
    ),
  ).toBe('accepted');
  expect(
    await handleInboundEnvelope(
      stores,
      device.deviceId,
      createEnvelope('task.started', {}, { taskId: offer.taskId }),
    ),
  ).toBe('accepted');
  return { taskId: offer.taskId, seq: offer.seq };
}

/** The daemon reporting that it is blocked, exactly as `task-runner.ts` does. */
async function awaitApproval(
  harness: CloudHarness,
  device: PairedDevice,
  taskId: string,
  approvalId: string | undefined,
  summary = 'delete production',
): Promise<void> {
  expect(
    await handleInboundEnvelope(
      deviceStores(harness, device),
      device.deviceId,
      createEnvelope(
        'task.await_approval',
        { summary, ...(approvalId === undefined ? {} : { approvalId }) },
        { taskId },
      ),
    ),
  ).toBe('accepted');
}

/** The daemon reporting that it resolved the approval locally, without a wire decision. */
async function approvalResolved(
  harness: CloudHarness,
  device: PairedDevice,
  taskId: string,
  approvalId: string,
): Promise<void> {
  expect(
    await handleInboundEnvelope(
      deviceStores(harness, device),
      device.deviceId,
      createEnvelope(
        'task.approval_resolved',
        { approvalId, decision: 'approve', resolvedBy: 'local', at: new Date().toISOString() },
        { taskId },
      ),
    ),
  ).toBe('accepted');
}

async function paused(harness: CloudHarness, device: PairedDevice, approvalId: string | undefined) {
  const task = await claimedTask(harness, device);
  await awaitApproval(harness, device, task.taskId, approvalId);
  return task;
}

describe('approveTask (GAP-1)', () => {
  it('enqueues exactly one task.approve to the claiming device, targeting the pending approval', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await paused(harness, device, 'approval-a');

    const enqueued = await harness.cloud.approveTask(TENANT_A, task.taskId);

    expect(enqueued.envelope.type).toBe('task.approve');
    expect(enqueued.seq).toBeGreaterThan(task.seq);
    const page = await poll(harness, device, task.seq);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      type: 'task.approve',
      task_id: task.taskId,
      // No caller-supplied id: the pending one is what the daemon gets, so its
      // own exact-match check (`TaskRunner.handleApprove`) can still run.
      payload: { approvalId: 'approval-a' },
    });
  });

  it('carries a caller-supplied approvalId when it matches the pending one', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await paused(harness, device, 'approval-a');

    await harness.cloud.approveTask(TENANT_A, task.taskId, { approvalId: 'approval-a' });

    const page = await poll(harness, device, task.seq);
    expect(page.events.map((event) => event.type)).toEqual(['task.approve']);
    expect(page.events[0]?.payload).toMatchObject({ approvalId: 'approval-a' });
  });

  it('refuses a superseded approvalId with both ids on the error and enqueues nothing', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await paused(harness, device, 'approval-a');
    // The daemon moved on to a fresh approval without this cloud ever seeing
    // the first one resolved — the newest request is the one that is pending.
    await awaitApproval(harness, device, task.taskId, 'approval-b', 'delete staging');

    const caught = await harness.cloud
      .approveTask(TENANT_A, task.taskId, { approvalId: 'approval-a' })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(StaleApprovalError);
    const stale = caught as StaleApprovalError;
    expect(stale.taskId).toBe(task.taskId);
    expect(stale.requestedApprovalId).toBe('approval-a');
    expect(stale.currentApprovalId).toBe('approval-b');
    expect((await poll(harness, device, task.seq)).events).toHaveLength(0);
  });

  it('does not manufacture an approvalId when the daemon never reported one', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    // A pre-M5 daemon: pending, resolvable, but not targetable. There is no id
    // to disagree with, so the caller's own id is not stale, but it is not a
    // protocol identity and must not enter the durable event or wire payload.
    const task = await paused(harness, device, undefined);

    await harness.cloud.approveTask(TENANT_A, task.taskId, { approvalId: 'approval-a' });

    const page = await poll(harness, device, task.seq);
    expect(page.events.map((event) => event.type)).toEqual(['task.approve']);
    expect(page.events[0]?.payload).toEqual({});
    const tail = await harness.stores.approvals.read(TENANT_A, task.taskId);
    expect(tail?.entries.at(-1)).not.toHaveProperty('event.approvalId');
  });

  it('omits approvalId entirely when neither side has one', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await paused(harness, device, undefined);

    await harness.cloud.approveTask(TENANT_A, task.taskId);

    const page = await poll(harness, device, task.seq);
    expect(page.events[0]?.payload).toEqual({});
  });
});

describe('the gates that refuse before any mailbox row exists', () => {
  it('refuses a task with no pending approval', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await claimedTask(harness, device);

    const caught = await harness.cloud
      .approveTask(TENANT_A, task.taskId)
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(isCloudError(caught, 'task_not_awaiting_approval')).toBe(true);
    expect((await poll(harness, device, task.seq)).events).toHaveLength(0);
  });

  it('refuses a task this tenant never offered', async () => {
    const harness = createHarness();
    await harness.pairDevice(TENANT_A);

    const caught = await harness.cloud
      .approveTask(TENANT_A, 'task_does-not-exist')
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(isCloudError(caught, 'task_not_found')).toBe(true);
  });

  it('refuses an unclaimed task even when a timeline entry exists', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload('never claimed'),
    });
    // Reported without a claim: nothing owns this attempt, so no runtime is
    // paused on it and there is no device an approval could belong to.
    await awaitApproval(harness, device, offer.taskId, 'approval-a');

    const caught = await harness.cloud
      .approveTask(TENANT_A, offer.taskId)
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(isCloudError(caught, 'task_not_awaiting_approval')).toBe(true);
  });

  it('refuses a task that already reached a terminal, even with an unresolved request on the tail', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await paused(harness, device, 'approval-a');
    // The runtime resolved locally and ran to completion without ever sending
    // `task.approval_resolved` — the implicit path the server infers from the
    // next message. The tail still shows a request; the attempt says otherwise.
    expect(
      await handleInboundEnvelope(
        deviceStores(harness, device),
        device.deviceId,
        createEnvelope(
          'task.complete',
          { summary: 'did it anyway', sessionRef: 'resolved-locally' },
          { taskId: task.taskId },
        ),
      ),
    ).toBe('accepted');

    const caught = await harness.cloud
      .approveTask(TENANT_A, task.taskId)
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(isCloudError(caught, 'task_not_awaiting_approval')).toBe(true);
    expect((await poll(harness, device, task.seq)).events).toHaveLength(0);
  });
});

describe('a reported local resolution clears the pending approval', () => {
  it('leaves nothing pending, and a later request makes the old id stale again', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await paused(harness, device, 'approval-a');

    await harness.cloud.approveTask(TENANT_A, task.taskId, { approvalId: 'approval-a' });
    await approvalResolved(harness, device, task.taskId, 'approval-a');

    // Resolved: there is no pending approval at all now, so the same call is
    // refused by the pending gate rather than by targeting.
    const afterResolution = await harness.cloud
      .approveTask(TENANT_A, task.taskId, { approvalId: 'approval-a' })
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(isCloudError(afterResolution, 'task_not_awaiting_approval')).toBe(true);

    // A fresh request re-opens the slot with a NEW id, which is what makes the
    // old one stale rather than merely gone.
    await awaitApproval(harness, device, task.taskId, 'approval-b', 'and now this');
    const afterNewRequest = await harness.cloud
      .approveTask(TENANT_A, task.taskId, { approvalId: 'approval-a' })
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(afterNewRequest).toBeInstanceOf(StaleApprovalError);
    expect((afterNewRequest as StaleApprovalError).currentApprovalId).toBe('approval-b');

    // Exactly one enqueue across all of it: the first approve.
    const page = await poll(harness, device, task.seq);
    expect(page.events.map((event) => event.type)).toEqual(['task.approve']);
  });

  it('ignores a resolution naming an already-superseded approval', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await paused(harness, device, 'approval-a');
    await awaitApproval(harness, device, task.taskId, 'approval-b', 'delete staging');
    // A late report about the approval the daemon already moved past. Applying
    // it would clear a slot that belongs to a different, still-pending request.
    await approvalResolved(harness, device, task.taskId, 'approval-a');

    await harness.cloud.approveTask(TENANT_A, task.taskId);

    const page = await poll(harness, device, task.seq);
    expect(page.events[0]?.payload).toMatchObject({ approvalId: 'approval-b' });
  });
});

describe('rejectTask (GAP-1)', () => {
  it('mirrors approveTask with task.reject and carries the reason verbatim', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await paused(harness, device, 'approval-a');

    const enqueued = await harness.cloud.rejectTask(TENANT_A, task.taskId, {
      approvalId: 'approval-a',
      reason: 'not on a Friday',
    });

    expect(enqueued.envelope.type).toBe('task.reject');
    const page = await poll(harness, device, task.seq);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      type: 'task.reject',
      task_id: task.taskId,
      payload: { approvalId: 'approval-a', reason: 'not on a Friday' },
    });
  });

  it('leaves the reason absent on the wire when the caller supplies none', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await paused(harness, device, 'approval-a');

    await harness.cloud.rejectTask(TENANT_A, task.taskId);

    const page = await poll(harness, device, task.seq);
    expect(page.events[0]?.payload).toEqual({ approvalId: 'approval-a' });
  });

  it('refuses a superseded approvalId on the same gate order as approveTask', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await paused(harness, device, 'approval-a');
    await awaitApproval(harness, device, task.taskId, 'approval-b', 'delete staging');

    const caught = await harness.cloud
      .rejectTask(TENANT_A, task.taskId, { approvalId: 'approval-a', reason: 'no' })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(StaleApprovalError);
    expect((caught as StaleApprovalError).requestedApprovalId).toBe('approval-a');
    expect((caught as StaleApprovalError).currentApprovalId).toBe('approval-b');
    expect((await poll(harness, device, task.seq)).events).toHaveLength(0);
  });

  it('refuses a task with no pending approval', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await claimedTask(harness, device);

    const caught = await harness.cloud
      .rejectTask(TENANT_A, task.taskId, { reason: 'nope' })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(isCloudError(caught, 'task_not_awaiting_approval')).toBe(true);
    expect((await poll(harness, device, task.seq)).events).toHaveLength(0);
  });
});

describe('tenant closure', () => {
  it('does not resolve another tenant approval by task id', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await paused(harness, device, 'approval-a');

    const caught = await harness.cloud
      .approveTask(TENANT_B, task.taskId)
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(isCloudError(caught, 'task_not_found')).toBe(true);
    expect((await poll(harness, device, task.seq)).events).toHaveLength(0);
  });
});
