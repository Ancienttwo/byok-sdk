import { createEnvelope, decodeEnvelope, type AgentEgressPolicy } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { tenantStoresFor } from '../tenant-stores';
import { TENANT_A, createHarness, type CloudHarness } from './support/harness';

const AGENT_REF = { agentId: 'agent-egress', profileRevision: 'profile-egress' } as const;
const POLICY: AgentEgressPolicy = {
  policyRevision: 'policy-r1',
  activity: { mode: 'metadata-status' as const, delivery: 'latest-value' as const },
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
const CONTENT_HASH = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function egressOfferPayload() {
  return {
    instruction: 'run with egress policy',
    policy: { mode: 'auto' as const },
    agentRef: AGENT_REF,
    sessionRef: 'session-egress',
    egressPolicy: POLICY,
  };
}

function reliableEnvelope() {
  return createEnvelope('agent.egress.reliable', {
    agentRef: AGENT_REF,
    sessionRef: 'session-egress',
    policyRevision: POLICY.policyRevision,
    eventId: '10000000-0000-4000-8000-000000000010',
    cursor: 7,
    payload: { status: 'ready' },
    contentHash: CONTENT_HASH,
    byteCount: 18,
  });
}

function deviceStores(harness: CloudHarness, deviceId: string) {
  return tenantStoresFor(
    { kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId },
    { core: harness.core, cloud: harness.stores },
  );
}

async function admitFullEgress(harness: CloudHarness, deviceId: string): Promise<void> {
  await harness.stores.devices.recordCapabilities(TENANT_A, {
    deviceId,
    capabilities: [
      'agent-home-contract',
      'agent-egress-policy',
      'agent-egress-reliable-ack',
      'agent-content-workspace-read',
    ],
  });
}

describe('hosted Agent egress contract', () => {
  it('fails closed before allocation when the durable egress capabilities are absent', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: ['agent-home-contract'],
    });

    await expect(
      harness.cloud.enqueueAgentEgressOffer(TENANT_A, device.deviceId, { payload: egressOfferPayload() }),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });
    expect(
      (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 })).messages,
    ).toHaveLength(0);
  });

  it('persists exact AgentRef/session/cursor and replays one immutable acknowledgement receipt', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admitFullEgress(harness, device.deviceId);

    const offered = await harness.cloud.enqueueAgentEgressOffer(TENANT_A, device.deviceId, {
      taskId: 'agent-egress-task',
      payload: egressOfferPayload(),
    });
    expect(offered.envelope.type).toBe('task.offer_for_agent_with_egress');
    expect(offered.attempt.agentRef).toEqual(AGENT_REF);

    const event = reliableEnvelope();
    const first = await harness.request('/byok/messages', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [event] }),
    });
    expect(await first.json()).toEqual({ accepted: 1 });
    const stored = await harness.cloud.readAgentEgress(TENANT_A, device.deviceId, event.payload.eventId);
    expect(stored?.payload).toEqual(event.payload);
    expect(stored?.receiptId).toMatch(/^[0-9a-f-]{36}$/u);

    const replay = await harness.request('/byok/messages', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [event] }),
    });
    expect(await replay.json()).toEqual({ accepted: 1 });

    const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 });
    const acknowledgements = page.messages
      .map((message) => decodeEnvelope(message.body))
      .filter((envelope) => envelope.type === 'agent.egress.ack');
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]).toMatchObject({
      payload: {
        agentRef: AGENT_REF,
        sessionRef: 'session-egress',
        policyRevision: POLICY.policyRevision,
        eventId: event.payload.eventId,
        cursor: 7,
        receiptId: stored?.receiptId,
      },
    });

    const polled = await harness.request('/byok/events?cursor=0', { headers: device.authorization });
    const pollBody = (await polled.json()) as { capabilities: readonly string[]; events: unknown[] };
    expect(pollBody.capabilities).toEqual(
      expect.arrayContaining([
        'agent-egress-policy',
        'agent-egress-reliable-ack',
        'agent-content-workspace-read',
      ]),
    );
    expect(pollBody.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'agent.egress.ack' })]));
  });

  it('admits content reads per surface and persists the content-free receipt fact', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admitFullEgress(harness, device.deviceId);

    await expect(
      harness.cloud.enqueueAgentContentRead(TENANT_A, device.deviceId, {
        payload: {
          requestId: '10000000-0000-4000-8000-000000000020',
          surface: 'transcript',
          actor: { kind: 'user', id: 'actor-cloud-1' },
          agentRef: AGENT_REF,
          sessionRef: 'session-egress',
          runtime: 'codex',
          cwd: '/workspace',
          policyRevision: POLICY.policyRevision,
          target: 'trace.jsonl',
          mimeType: 'application/json',
          decodeAs: 'utf8',
          policy: { maxBytes: 512, allowedMimeTypes: ['application/json'] },
        },
      }),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });

    const request = await harness.cloud.enqueueAgentContentRead(TENANT_A, device.deviceId, {
      payload: {
        requestId: '10000000-0000-4000-8000-000000000021',
        surface: 'workspace',
        actor: { kind: 'user', id: 'actor-cloud-1' },
        agentRef: AGENT_REF,
        sessionRef: 'session-egress',
        runtime: 'codex',
        cwd: '/workspace',
        policyRevision: POLICY.policyRevision,
        target: 'README.md',
        mimeType: 'text/plain',
        decodeAs: 'utf8',
        policy: { maxBytes: 512, allowedMimeTypes: ['text/plain'] },
      },
    });
    expect(request.envelope.type).toBe('agent.content.read');
    const receipt = createEnvelope('agent.content.receipt', {
      requestId: '10000000-0000-4000-8000-000000000021',
      eventId: '10000000-0000-4000-8000-000000000021',
      cursor: 8,
      surface: 'workspace',
      actor: { kind: 'user', id: 'actor-cloud-1' },
      agentRef: AGENT_REF,
      sessionRef: 'session-egress',
      runtime: 'codex',
      cwd: '/workspace',
      policyRevision: POLICY.policyRevision,
      target: 'README.md',
      mimeType: 'text/plain',
      decodeAs: 'utf8',
      decision: 'allowed',
      byteCount: 12,
      contentHash: CONTENT_HASH,
      blobRef: {
        blobId: 'blob-content-1',
        contentHash: CONTENT_HASH,
        size: 12,
        contentType: 'text/plain',
      },
    });
    const response = await harness.request('/byok/messages', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [receipt] }),
    });
    expect(await response.json()).toEqual({ accepted: 1 });
    const durableReceipt = await deviceStores(harness, device.deviceId).receipts.get(
      `agent-content:${device.deviceId}:${receipt.payload.requestId}`,
    );
    expect(durableReceipt === undefined ? undefined : JSON.parse(durableReceipt.body)).toEqual(receipt.payload);
    const acknowledgements = (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 })).messages
      .map((message) => decodeEnvelope(message.body))
      .filter((envelope) => envelope.type === 'agent.egress.ack');
    expect(acknowledgements).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          eventId: receipt.payload.requestId,
          cursor: receipt.payload.cursor,
          receiptId: receipt.payload.requestId,
        }),
      }),
    ]);

    const duplicate = await harness.request('/byok/messages', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [createEnvelope('agent.content.receipt', receipt.payload)] }),
    });
    expect(await duplicate.json()).toEqual({ accepted: 1 });
    expect(
      (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 })).messages
        .map((message) => decodeEnvelope(message.body))
        .filter((envelope) => envelope.type === 'agent.egress.ack'),
    ).toHaveLength(1);

    const mismatch = createEnvelope('agent.content.receipt', {
      ...receipt.payload,
      cursor: receipt.payload.cursor + 1,
    });
    const rejected = await harness.request('/byok/messages', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [mismatch] }),
    });
    expect(await rejected.json()).toEqual({ accepted: 0, rejected: 1 });
  });
});
