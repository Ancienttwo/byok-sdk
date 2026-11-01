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
import { createEnvelope } from '@byok-sdk/protocol';
import { describe, expect, it, vi } from 'vitest';
import { StaleApprovalError } from '../approval-control';
import {
  MAX_APPROVAL_EVENT_BYTES,
  MAX_APPROVAL_TIMELINE_BYTES,
  retainApprovalObservations,
  validateApprovalTimelineAppend,
  type ApprovalObservation,
} from '../approval-timeline';
import { isCloudError } from '../errors';
import { handleInboundEnvelope } from '../inbound';
import { tenantStoresFor } from '../tenant-stores';
import {
  PRODUCT_ID,
  TENANT_A,
  TENANT_B,
  TEST_AGENT_REF,
  createHarness,
  decodeEventsPage,
  grantAgentHome,
  offerPayload,
  type CloudHarness,
  type DecodedEventsPage,
  type PairedDevice,
} from './support/harness';

function devicePrincipal(tenant: TenantId, deviceId: string) {
  return { kind: 'device', tenantId: tenant, productId: PRODUCT_ID, deviceId } as const;
}

function deviceStores(harness: CloudHarness, device: PairedDevice) {
  return tenantStoresFor(devicePrincipal(TENANT_A, device.deviceId), {
    core: harness.core,
    cloud: harness.stores,
    mailboxWake: harness.mailboxWake,
  });
}

async function poll(harness: CloudHarness, device: PairedDevice, cursor: number): Promise<DecodedEventsPage> {
  const response = await harness.request(`/byok/events?cursor=${cursor}`, {
    headers: device.authorization,
  });
  expect(response.status).toBe(200);
  return decodeEventsPage(await response.json());
}

interface PausedTask {
  readonly taskId: string;
  /** The delivery seq of the offer — the cursor everything after it is polled from. */
  readonly seq: number;
}

/** Offer -> claim -> started: the state a runtime is in when it asks for an approval. */
async function claimedTask(harness: CloudHarness, device: PairedDevice): Promise<PausedTask> {
  await grantAgentHome(harness, TENANT_A, device.deviceId);
  const offer = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
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
      createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: TEST_AGENT_REF }, { taskId: offer.taskId }),
    ).then((result) => result.outcome),
  ).toBe('accepted');
  expect(
    await handleInboundEnvelope(
      stores,
      device.deviceId,
      createEnvelope('task.started', {}, { taskId: offer.taskId }),
    ).then((result) => result.outcome),
  ).toBe('accepted');
  return { taskId: offer.taskId, seq: offer.seq };
}

/** The daemon reporting that it is blocked, exactly as `task-runner.ts` does. */
async function awaitApproval(
  harness: CloudHarness,
  device: PairedDevice,
  taskId: string,
  approvalId: string,
  summary = 'delete production',
): Promise<void> {
  expect(
    await handleInboundEnvelope(
      deviceStores(harness, device),
      device.deviceId,
      createEnvelope(
        'task.await_approval',
        { summary, approvalId },
        { taskId },
      ),
    ).then((result) => result.outcome),
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
    ).then((result) => result.outcome),
  ).toBe('accepted');
}

async function paused(harness: CloudHarness, device: PairedDevice, approvalId: string) {
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

  it('refuses a pending request recorded before wire v4 without an approvalId, with no write', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await claimedTask(harness, device);
    // The v4 wire refuses an id-less task.await_approval, so only a row
    // recorded before v4 can hold one. A v4 decision must name its approval.
    await harness.stores.approvals.append(TENANT_A, {
      taskId: task.taskId,
      sourceEnvelopeId: 'pre-v4-request',
      event: { type: 'approval_requested', summary: 'delete production' },
    });
    const before = await harness.stores.approvals.read(TENANT_A, task.taskId);
    expect(before?.entries.map(({ event }) => event)).toEqual([{ type: 'approval_requested', summary: 'delete production' }]);

    for (const decide of [
      () => harness.cloud.approveTask(TENANT_A, task.taskId),
      () => harness.cloud.rejectTask(TENANT_A, task.taskId, { reason: 'no' }),
    ]) {
      const caught = await decide()
        .then(() => undefined)
        .catch((error: unknown) => error);
      expect(isCloudError(caught, 'task_not_awaiting_approval')).toBe(true);
    }

    expect(await harness.stores.approvals.read(TENANT_A, task.taskId)).toEqual(before);
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
    await grantAgentHome(harness, TENANT_A, device.deviceId);
    const offer = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
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
    // The runtime ran to completion without ever sending
    // `task.approval_resolved`. The tail still shows a request; the attempt
    // says otherwise.
    expect(
      await handleInboundEnvelope(
        deviceStores(harness, device),
        device.deviceId,
        createEnvelope(
          'task.complete',
          { summary: 'did it anyway', sessionRef: 'resolved-locally', agentRef: TEST_AGENT_REF },
          { taskId: task.taskId },
        ),
      ).then((result) => result.outcome),
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

  it('persists the first host rejection payload before a failed mailbox append, then replays only that payload', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await paused(harness, device, 'approval-reason');
    const append = vi
      .spyOn(harness.core.mailbox, 'append')
      .mockRejectedValueOnce(new Error('injected mailbox append failure'));

    await expect(
      harness.cloud.rejectTask(TENANT_A, task.taskId, {
        approvalId: 'approval-reason',
        reason: 'first reason',
      }),
    ).rejects.toThrow('injected mailbox append failure');

    await expect(
      harness.cloud.rejectTask(TENANT_A, task.taskId, {
        approvalId: 'approval-reason',
        reason: 'second reason',
      }),
    ).rejects.toMatchObject({ code: 'coordination_input_invalid' });
    expect((await poll(harness, device, task.seq)).events).toHaveLength(0);

    await expect(
      harness.cloud.rejectTask(TENANT_A, task.taskId, {
        approvalId: 'approval-reason',
        reason: 'first reason',
      }),
    ).resolves.toMatchObject({ envelope: { type: 'task.reject' } });

    const page = await poll(harness, device, task.seq);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      type: 'task.reject',
      task_id: task.taskId,
      payload: { approvalId: 'approval-reason', reason: 'first reason' },
    });
    expect(append).toHaveBeenCalledTimes(2);
    append.mockRestore();
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

describe.each(['approve', 'reject'] as const)('committed %s replay targeting (#1085)', (decision) => {
  const reason = decision === 'reject' ? 'not on a Friday' : undefined;
  const decide = (harness: CloudHarness, taskId: string, approvalId?: string) =>
    decision === 'approve'
      ? harness.cloud.approveTask(TENANT_A, taskId, { approvalId })
      : harness.cloud.rejectTask(TENANT_A, taskId, { approvalId, reason });

  it('refuses a stale target before recovering a committed decision or redelivering it', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await paused(harness, device, 'approval-a');
    await approvalResolved(harness, device, task.taskId, 'approval-a');
    await awaitApproval(harness, device, task.taskId, 'approval-b');
    const append = vi.spyOn(harness.core.mailbox, 'append')
      .mockRejectedValueOnce(new Error('injected mailbox append failure'));
    try {
      await expect(decide(harness, task.taskId, 'approval-b')).rejects.toThrow('injected mailbox append failure');
      const committed = await harness.stores.approvals.read(TENANT_A, task.taskId);
      expect(committed?.entries.at(-1)?.event).toMatchObject({
        type: 'approval_resolved', approvalId: 'approval-b', decision, resolvedBy: 'host',
      });
      expect(append).toHaveBeenCalledTimes(1);
      expect((await poll(harness, device, task.seq)).events).toHaveLength(0);

      await expect(decide(harness, task.taskId, 'approval-a'))
        .rejects.toMatchObject({ code: 'coordination_input_invalid' });
      expect(append).toHaveBeenCalledTimes(1);
      expect(await harness.stores.approvals.read(TENANT_A, task.taskId)).toEqual(committed);
      expect((await poll(harness, device, task.seq)).events).toHaveLength(0);

      const recovered = await decide(harness, task.taskId, 'approval-b');
      const replayed = await decide(harness, task.taskId);
      expect(replayed.envelope.id).toBe(recovered.envelope.id);
      expect(replayed.seq).toBe(recovered.seq);
      const callsBeforeStale = append.mock.calls.length;
      await expect(decide(harness, task.taskId, 'approval-a'))
        .rejects.toMatchObject({ code: 'coordination_input_invalid' });
      expect(append).toHaveBeenCalledTimes(callsBeforeStale);
      expect(await harness.stores.approvals.read(TENANT_A, task.taskId)).toEqual(committed);
      const page = await poll(harness, device, task.seq);
      expect(page.events).toHaveLength(1);
      expect(page.events[0]).toMatchObject({
        id: recovered.envelope.id, type: `task.${decision}`, task_id: task.taskId,
        payload: { approvalId: 'approval-b', ...(reason === undefined ? {} : { reason }) },
      });
    } finally {
      append.mockRestore();
    }
  });

  it.each(['approval-b', undefined])('recovers one immutable message when retry approvalId is %s', async (retryId) => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const task = await paused(harness, device, 'approval-b');
    const append = vi.spyOn(harness.core.mailbox, 'append')
      .mockRejectedValueOnce(new Error('injected mailbox append failure'));
    try {
      await expect(decide(harness, task.taskId, 'approval-b')).rejects.toThrow('injected mailbox append failure');
      const opposite = decision === 'approve'
        ? harness.cloud.rejectTask(TENANT_A, task.taskId, { approvalId: 'approval-b' })
        : harness.cloud.approveTask(TENANT_A, task.taskId, { approvalId: 'approval-b' });
      await expect(opposite).rejects.toMatchObject({ code: 'coordination_input_invalid' });
      expect(append).toHaveBeenCalledTimes(1);
      expect((await poll(harness, device, task.seq)).events).toHaveLength(0);
      const first = await decide(harness, task.taskId, retryId);
      const second = await decide(harness, task.taskId, retryId);
      expect(second.envelope.id).toBe(first.envelope.id);
      expect(second.seq).toBe(first.seq);
      const page = await poll(harness, device, task.seq);
      expect(page.events).toHaveLength(1);
      expect(page.events[0]).toMatchObject({
        id: first.envelope.id, type: `task.${decision}`,
        payload: { approvalId: 'approval-b', ...(reason === undefined ? {} : { reason }) },
      });
    } finally {
      append.mockRestore();
    }
  });
});

function observation(revision: number, event: ApprovalObservation['event']): ApprovalObservation {
  return { taskId: 'task', sourceEnvelopeId: `envelope-${revision}`, revision, receivedAt: '2026-11-01T00:00:00.000Z', event };
}

/** A host reject's reason is the one unbounded field an event can carry. */
function hostReject(approvalId: string, reasonBytes: number) {
  return { type: 'approval_resolved' as const, approvalId, decision: 'reject' as const, resolvedBy: 'host' as const, reason: 'x'.repeat(reasonBytes), at: '2026-11-01T00:00:00.000Z' };
}

const bytes = (entries: readonly ApprovalObservation[]) => new TextEncoder().encode(JSON.stringify(entries)).byteLength;

// Every adapter retains through retainApprovalObservations, so its byte bound
// is proved once here; count and pending protection run in conformance (#1113 A3).
describe('approval timeline retention', () => {
  it('evicts the oldest observations past the byte bound and keeps the pending request', () => {
    const filler = (revision: number) => observation(revision, hostReject(`other-${revision}`, 400 * 1024));
    let entries: readonly ApprovalObservation[] = [observation(1, { type: 'approval_requested', summary: 'Allow', approvalId: 'pending' })];
    let evicted = 0;
    for (let revision = 2; revision <= 5; revision += 1) {
      const retained = retainApprovalObservations(entries, filler(revision), 50);
      entries = retained.entries;
      evicted += retained.evicted;
    }
    expect(entries.map((entry) => entry.revision)).toEqual([1, 4, 5]);
    expect(evicted).toBe(2);
    expect(bytes(entries)).toBeLessThanOrEqual(MAX_APPROVAL_TIMELINE_BYTES);
  });

  it('refuses one event past its serialized bound', () => {
    const fits = hostReject('a', 1024);
    const overhead = new TextEncoder().encode(JSON.stringify(fits)).byteLength - 1024;
    const append = (reasonBytes: number) => validateApprovalTimelineAppend({ taskId: 'task', sourceEnvelopeId: 'envelope', event: hostReject('a', reasonBytes) });
    expect(append(MAX_APPROVAL_EVENT_BYTES - overhead).event).toBeDefined();
    expect(() => append(MAX_APPROVAL_EVENT_BYTES - overhead + 1)).toThrow(expect.objectContaining({ code: 'coordination_input_invalid' }));
  });
});
