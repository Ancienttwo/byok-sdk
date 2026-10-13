/**
 * Mailbox admission at the cloud surface (#411).
 *
 * The mailbox limit is enforced by the store that inserts the row, so these
 * cases pin what a Host and a device observe when it refuses: a typed
 * `storage_quota_exceeded`, a retry that converges on the same task, a
 * cancellation that is never blocked, and a 507 on the device message route
 * whose resend executes nothing twice.
 */
import { isCoreError, type TenantId } from '@byok-sdk/core';
import {
  createEnvelope,
  decodeEnvelope,
  type AgentEgressPolicy,
  type EventsPollResponse,
} from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import {
  TENANT_A,
  createHarness,
  offerPayload,
  type CloudHarness,
  type PairedDevice,
} from './support/harness';

const AGENT_REF = { agentId: 'agent-admission', profileRevision: 'profile-admission' } as const;
const POLICY: AgentEgressPolicy = {
  policyRevision: 'policy-r1',
  activity: { delivery: 'latest-value' as const, maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: {
    maxPendingEventsPerAgent: 10,
    maxPendingBytesPerAgent: 4096,
    maxPendingBytesPerTenant: 8192,
  },
  transfers: {
    workspace: { maxBytes: 512, allowedMimeTypes: ['text/plain'] },
    transcript: 'disabled' as const,
    artifact: 'disabled' as const,
  },
};

/** Re-issues the harness entitlement with a new mailbox limit. */
async function limitMailbox(
  harness: CloudHarness,
  tenant: TenantId,
  version: bigint,
  mailboxLimitBytes: bigint,
): Promise<void> {
  await harness.core.quota.writeEntitlement(tenant, {
    version,
    hardLimitBytes: 1_000_000_000n,
    maxObjectBytes: 100_000_000n,
    maxInlineBytes: 1_000_000n,
    mailboxLimitBytes,
    retentionPolicyId: 'test',
  });
}

/** Fills the mailbox exactly: whatever is retained now is the whole limit. */
async function fillMailbox(harness: CloudHarness, tenant: TenantId, version: bigint): Promise<void> {
  const { bytes } = await harness.core.mailbox.readUsage(tenant);
  await limitMailbox(harness, tenant, version, bytes);
}

async function poll(harness: CloudHarness, device: PairedDevice): Promise<EventsPollResponse> {
  const response = await harness.request('/byok/events?cursor=0', { headers: device.authorization });
  expect(response.status).toBe(200);
  return (await response.json()) as EventsPollResponse;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

describe('mailbox admission at the cloud surface', () => {
  it('refuses an offer into a full mailbox and converges when the same taskId is retried', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await limitMailbox(harness, TENANT_A, 2n, 0n);

    const refused = await captureError(
      harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
        taskId: 'admission-retry',
        payload: offerPayload('wait for room'),
      }),
    );
    expect(isCoreError(refused, 'storage_quota_exceeded')).toBe(true);
    expect((await harness.core.mailbox.readUsage(TENANT_A)).bytes).toBe(0n);

    await limitMailbox(harness, TENANT_A, 3n, 100_000_000n);
    const retried = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      taskId: 'admission-retry',
      payload: offerPayload('wait for room'),
    });
    // The refused attempt left no row and consumed no seq.
    expect(retried).toMatchObject({ taskId: 'admission-retry', seq: 1 });

    const page = await poll(harness, device);
    expect(page.events.map((event) => [event.type, event.task_id])).toEqual([
      ['task.offer', 'admission-retry'],
    ]);
  });

  it('cancels a task while the mailbox is full and counts the cancellation', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload('stop me'),
    });
    await fillMailbox(harness, TENANT_A, 2n);
    const before = (await harness.core.mailbox.readUsage(TENANT_A)).bytes;

    const blocked = await captureError(
      harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload('no room') }),
    );
    expect(isCoreError(blocked, 'storage_quota_exceeded')).toBe(true);

    const cancelled = await harness.cloud.cancelTask(TENANT_A, offer.taskId, 'full mailbox');
    expect(cancelled).toMatchObject({ taskId: offer.taskId, status: 'cancelled' });
    expect((await harness.core.mailbox.readUsage(TENANT_A)).bytes).toBeGreaterThan(before);
    const page = await poll(harness, device);
    expect(page.events.map((event) => event.type)).toEqual(['task.cancel']);
  });

  it('answers 507 when a reply cannot be appended and a resent batch executes nothing twice', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: [
        'agent-home-contract',
        'agent-egress-policy',
        'agent-egress-reliable-ack',
        'agent-content-workspace-read',
        'agent-message-egress',
        'terminal-projection-selection',
      ],
    });
    await harness.cloud.enqueueAgentEgressOffer(TENANT_A, device.deviceId, {
      taskId: 'admission-egress',
      payload: {
        instruction: 'emit one reliable event',
        agentRef: AGENT_REF,
        sessionRef: 'session-admission',
        egressPolicy: POLICY,
      },
    });
    await fillMailbox(harness, TENANT_A, 2n);

    const event = createEnvelope('agent.egress.reliable', {
      agentRef: AGENT_REF,
      sessionRef: 'session-admission',
      policyRevision: POLICY.policyRevision,
      eventId: '10000000-0000-4000-8000-000000000411',
      cursor: 1,
      payload: { status: 'ready' },
      contentHash: `sha256:${'a'.repeat(64)}`,
      byteCount: 18,
    });
    const send = () =>
      harness.request('/byok/messages', {
        method: 'POST',
        headers: { ...device.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [event] }),
      });

    const full = await send();
    expect(full.status).toBe(507);
    expect(await full.json()).toEqual({ error: 'storage_quota_exceeded' });
    // The egress fact committed before the ack append was refused.
    const committed = await harness.cloud.readAgentEgress(
      TENANT_A,
      device.deviceId,
      AGENT_REF,
      event.payload.eventId,
    );
    expect(committed?.payload).toEqual(event.payload);

    await limitMailbox(harness, TENANT_A, 3n, 100_000_000n);
    const resent = await send();
    expect(resent.status).toBe(200);
    expect(await resent.json()).toEqual({ accepted: 1 });
    const replayed = await send();
    expect(await replayed.json()).toEqual({ accepted: 1 });

    // Same receipt, one acknowledgement: the resend replayed the committed
    // fact instead of executing the event a second time.
    expect(
      await harness.cloud.readAgentEgress(TENANT_A, device.deviceId, AGENT_REF, event.payload.eventId),
    ).toEqual(committed);
    const page = await harness.core.mailbox.readAfter(TENANT_A, {
      deviceId: device.deviceId,
      afterSeq: 0,
    });
    const acknowledgements = page.messages
      .map((message) => decodeEnvelope(message.body))
      .filter((envelope) => envelope.type === 'agent.egress.ack');
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]).toMatchObject({ payload: { receiptId: committed?.receiptId } });
  });
});
