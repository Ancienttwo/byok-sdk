import { createEnvelope, decodeEnvelope, type AgentEgressPolicy, type EventsPollResponse } from '@byok-sdk/protocol';
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

function freshEgressOfferPayload() {
  return {
    instruction: 'start a fresh runtime with egress policy',
    policy: { mode: 'auto' as const },
    agentRef: AGENT_REF,
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
      'agent-message-egress',
      'terminal-projection-selection',
    ],
  });
}

describe('hosted Agent egress contract', () => {
  it('binds an Agent message to the exact task/device/AgentRef and returns a durable exact disposition', async () => {
    const consumed: unknown[] = [];
    const harness = createHarness({ agentMessage: { consume: async (input) => { consumed.push(input); return { outcome: 'accepted' }; } } });
    const device = await harness.pairDevice(TENANT_A);
    await admitFullEgress(harness, device.deviceId);
    await expect(harness.cloud.enqueueAgentEgressOffer(TENANT_A, device.deviceId, {
      taskId: 'agent-message-missing-context',
      payload: {
        ...egressOfferPayload(),
        messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100_000 },
        terminalProjection: { mode: 'none' },
      },
    })).rejects.toBeDefined();
    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'agent-message-missing-context')).toBeUndefined();
    const offered = await harness.cloud.enqueueAgentEgressOffer(TENANT_A, device.deviceId, {
      taskId: 'agent-message-task',
      payload: {
        ...egressOfferPayload(),
        messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100_000 },
        terminalProjection: { mode: 'none' },
      },
      agentMessageContext: { destinationBinding: 'conversation/42/turn/7', freshnessCursor: 'turn-seq:7' },
    });
    const message = createEnvelope('agent.message.publish', {
      agentRef: AGENT_REF, sessionRef: 'session-egress', contract: 'example.chat.v1',
      messageId: '10000000-0000-4000-8000-000000000099', cursor: 1,
      contentType: 'text/markdown', body: 'hello',
      contentHash: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', byteCount: 5,
    }, { taskId: offered.taskId });
    const first = await harness.request('/byok/messages', {
      method: 'POST', headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [message] }),
    });
    expect(await first.json()).toEqual({ accepted: 1 });
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ context: { destinationBinding: 'conversation/42/turn/7', freshnessCursor: 'turn-seq:7' } });
    expect(offered.envelope.payload).not.toHaveProperty('agentMessageContext');
    const replay = await harness.request('/byok/messages', {
      method: 'POST', headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [message] }),
    });
    expect(await replay.json()).toEqual({ accepted: 1 });
    expect(consumed).toHaveLength(1);
    const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 });
    const dispositions = page.messages.map((row) => decodeEnvelope(row.body)).filter((item) => item.type === 'agent.message.disposition');
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]).toMatchObject({ task_id: offered.taskId, payload: { outcome: 'accepted', messageId: message.payload.messageId } });
    const second = createEnvelope('agent.message.publish', {
      ...message.payload,
      messageId: '10000000-0000-4000-8000-000000000098',
      body: 'second',
      byteCount: 6,
      contentHash: 'sha256:16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4',
    }, { taskId: offered.taskId });
    const refusedSecond = await harness.request('/byok/messages', {
      method: 'POST', headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [second] }),
    });
    expect(await refusedSecond.json()).toEqual({ accepted: 0, rejected: 1 });
    expect(consumed).toHaveLength(1);
  });

  it.each(['held', 'refused'] as const)('does not re-invoke the product consumer for an exact %s transport replay', async (outcome) => {
    const consumed: unknown[] = [];
    const harness = createHarness({ agentMessage: { consume: async (input) => { consumed.push(input); return { outcome }; } } });
    const device = await harness.pairDevice(TENANT_A);
    await admitFullEgress(harness, device.deviceId);
    const offered = await harness.cloud.enqueueAgentEgressOffer(TENANT_A, device.deviceId, {
      taskId: `agent-message-${outcome}`,
      payload: {
        ...egressOfferPayload(),
        messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100_000 },
        terminalProjection: { mode: 'none' },
      },
      agentMessageContext: { destinationBinding: 'conversation/42/turn/7' },
    });
    const message = createEnvelope('agent.message.publish', {
      agentRef: AGENT_REF, sessionRef: 'session-egress', contract: 'example.chat.v1',
      messageId: '10000000-0000-4000-8000-000000000097', cursor: 1,
      contentType: 'text/markdown', body: 'hello',
      contentHash: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', byteCount: 5,
    }, { taskId: offered.taskId });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await harness.request('/byok/messages', {
        method: 'POST', headers: { ...device.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [message] }),
      });
      expect(await response.json()).toEqual({ accepted: 1 });
    }
    expect(consumed).toHaveLength(1);
    const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 });
    const dispositions = page.messages.map((row) => decodeEnvelope(row.body)).filter((item) => item.type === 'agent.message.disposition');
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]).toMatchObject({ payload: { outcome } });
  });

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

  it('admits the distinct fresh offer only with all four durable capabilities and leaves no task or mailbox row otherwise', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admitFullEgress(harness, device.deviceId);

    await expect(
      harness.cloud.enqueueFreshAgentEgressOffer(TENANT_A, device.deviceId, {
        taskId: 'fresh-missing-capability',
        payload: freshEgressOfferPayload(),
      }),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });
    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'fresh-missing-capability')).toBeUndefined();
    expect(
      (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 })).messages,
    ).toHaveLength(0);

    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: [
        'agent-home-contract',
        'agent-egress-policy',
        'agent-egress-reliable-ack',
        'agent-egress-fresh-session',
      ],
    });
    const offered = await harness.cloud.enqueueFreshAgentEgressOffer(TENANT_A, device.deviceId, {
      taskId: 'fresh-agent-egress-task',
      payload: freshEgressOfferPayload(),
    });
    expect(offered.envelope).toMatchObject({
      type: 'task.offer_for_agent_with_egress_fresh',
      payload: { agentRef: AGENT_REF, egressPolicy: POLICY },
    });
    expect(offered.envelope.payload).not.toHaveProperty('sessionRef');
  });

  it('keeps the resume enqueue on its exact-session message without a fresh fallback', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admitFullEgress(harness, device.deviceId);

    const offered = await harness.cloud.enqueueAgentEgressOffer(TENANT_A, device.deviceId, {
      payload: egressOfferPayload(),
    });

    expect(offered.envelope).toMatchObject({
      type: 'task.offer_for_agent_with_egress',
      payload: { sessionRef: 'session-egress' },
    });
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

  it('filters a pre-lease cancelled egress Agent offer and delivers only task.cancel', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admitFullEgress(harness, device.deviceId);

    const offered = await harness.cloud.enqueueAgentEgressOffer(TENANT_A, device.deviceId, {
      taskId: 'cancelled-agent-egress-task',
      payload: egressOfferPayload(),
    });
    await harness.cloud.cancelTask(TENANT_A, offered.taskId, 'stop before lease');

    const polled = await harness.request('/byok/events?cursor=0', { headers: device.authorization });
    const pollBody = (await polled.json()) as EventsPollResponse;
    expect(pollBody.events.map((event) => event.type)).toEqual(['task.cancel']);
    expect(pollBody.events[0]).toMatchObject({ task_id: offered.taskId });
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
