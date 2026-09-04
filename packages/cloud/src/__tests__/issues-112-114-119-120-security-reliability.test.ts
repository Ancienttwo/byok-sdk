import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMutableClock } from '@byok-sdk/core';
import { createEnvelope, decodeEnvelope } from '@byok-sdk/protocol';
import { describe, expect, it, vi } from 'vitest';
import { CLOUD_ORIGIN, TENANT_A, createDeviceKeys, createHarness, type CloudHarness } from './support/harness';

const AGENT_REF = { agentId: 'issue-agent', profileRevision: 'issue-profile' } as const;
const CONTENT_HASH = 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

function message(taskId: string, envelopeId?: string) {
  return createEnvelope('agent.message.publish', {
    agentRef: AGENT_REF,
    sessionRef: 'issue-session',
    contract: 'example.chat.v1',
    messageId: '10000000-0000-4000-8000-000000001120',
    cursor: 1,
    contentType: 'text/markdown',
    body: 'hello',
    contentHash: CONTENT_HASH,
    byteCount: 5,
  }, { taskId, ...(envelopeId === undefined ? {} : { id: envelopeId }) });
}

async function admitMessageEgress(harness: CloudHarness, deviceId: string): Promise<string> {
  await harness.stores.devices.recordCapabilities(TENANT_A, {
    deviceId,
    capabilities: [
      'agent-home-contract',
      'agent-egress-policy',
      'agent-egress-reliable-ack',
      'agent-message-egress',
      'terminal-projection-selection',
    ],
  });
  const offered = await harness.cloud.enqueueAgentEgressOffer(TENANT_A, deviceId, {
    taskId: `issue-task-${crypto.randomUUID()}`,
    payload: {
      instruction: 'send one message',
      policy: { mode: 'auto' },
      agentRef: AGENT_REF,
      sessionRef: 'issue-session',
      egressPolicy: {
        policyRevision: 'issue-policy',
        activity: { mode: 'metadata-status', delivery: 'latest-value' },
        reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
        transfers: {
          workspace: { maxBytes: 512, allowedMimeTypes: ['text/plain'] },
          transcript: 'disabled',
          artifact: 'disabled',
        },
      },
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 100 },
      terminalProjection: { mode: 'none' },
    },
    agentMessageContext: { destinationBinding: 'issue/conversation/1' },
  });
  return offered.taskId;
}

function postMessage(
  harness: CloudHarness,
  authorization: { readonly authorization: string },
  envelope: ReturnType<typeof message>,
) {
  return harness.request('/byok/messages', {
    method: 'POST',
    headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [envelope] }),
  });
}

describe('Issues #112/#114/#119/#120 hosted cloud regressions', () => {
  it('replays only an exact completed pairing binding and keeps concurrent exact retries to one device', async () => {
    const harness = createHarness();
    const pairing = await harness.cloud.createPairingCode(TENANT_A, { productId: 'test-product' });
    const keys = createDeviceKeys();
    const headers = { 'content-type': 'application/json' };
    const binding = {
      pairingCode: pairing.code,
      deviceName: 'durable-pairing',
      devicePublicKey: keys.publicKeyBase64Url,
    };
    const pair = (body: unknown) => harness.request('/byok/pair', { method: 'POST', headers, body: JSON.stringify(body) });

    const [first, retry] = await Promise.all([pair(binding), pair(binding)]);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    const firstBody = await first.json() as { deviceId: string };
    expect(await retry.json()).toMatchObject({ deviceId: firstBody.deviceId });
    expect(await harness.cloud.listDevices(TENANT_A)).toHaveLength(1);

    const conflict = await pair({ ...binding, deviceName: 'different-device-binding' });
    expect(conflict.status).toBe(401);
    expect(await harness.cloud.listDevices(TENANT_A)).toHaveLength(1);
  });

  it('bounds a presigned PUT by its authoritative reservation size even when Content-Length lies', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const reservation = await harness.request('/byok/blobs', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json', 'idempotency-key': 'issue-114' },
      body: JSON.stringify({ size: 1, contentType: 'text/plain', contentHash: `sha256:${'a'.repeat(64)}` }),
    });
    expect(reservation.status).toBe(200);
    const { uploadUrl } = await reservation.json() as { uploadUrl: string };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0]));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const response = await harness.cloud.fetch(new Request(`${CLOUD_ORIGIN}${uploadUrl}`, {
      method: 'PUT',
      headers: { 'content-length': '1' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }));
    expect(response.status).toBe(413);
  });

  it('uses one preallocated upload buffer rather than retaining chunks and joining a second full copy', () => {
    const source = readFileSync(new URL('../handlers/blobs.ts', import.meta.url), 'utf8');
    expect(source).toContain('const data = new Uint8Array(ceiling);');
    expect(source).not.toContain('const chunks: Uint8Array[] = [];');
    expect(source).not.toContain('for (const chunk of chunks)');
  });

  it('routes every valid agent.message.publish through exactly one common rate and dedup admission', async () => {
    const consumed: unknown[] = [];
    const harness = createHarness({ agentMessage: { consume: async (input) => { consumed.push(input); return { outcome: 'accepted' }; } } });
    const device = await harness.pairDevice(TENANT_A);
    const taskId = await admitMessageEgress(harness, device.deviceId);
    const rate = vi.spyOn(harness.stores.rateLimiter, 'consume');
    const dedup = vi.spyOn(harness.stores.dedup, 'checkAndRecord');

    const first = message(taskId);
    const response = await postMessage(harness, device.authorization, first);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcomes: [{ id: first.id, outcome: 'accepted' }] });
    expect(rate).toHaveBeenCalledTimes(1);
    expect(dedup).toHaveBeenCalledTimes(1);
    expect(consumed).toHaveLength(1);
  });

  it('replays an existing receipt before terminal state, but never calls the consumer for a new terminal message', async () => {
    const consumed: unknown[] = [];
    const harness = createHarness({ agentMessage: { consume: async (input) => { consumed.push(input); return { outcome: 'accepted' }; } } });
    const device = await harness.pairDevice(TENANT_A);
    const taskId = await admitMessageEgress(harness, device.deviceId);
    const first = message(taskId);
    expect((await postMessage(harness, device.authorization, first)).status).toBe(200);
    await harness.stores.tasks.recordStatus(TENANT_A, { taskId, status: 'complete', agentRef: AGENT_REF });

    const replayMessage = message(taskId, '10000000-0000-4000-8000-000000001121');
    const replay = await postMessage(harness, device.authorization, replayMessage);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ outcomes: [{ id: replayMessage.id, outcome: 'accepted' }] });

    const terminalBody = 'new terminal side effect';
    const newMessage = createEnvelope('agent.message.publish', {
      ...first.payload,
      messageId: '10000000-0000-4000-8000-000000001122',
      body: terminalBody,
      byteCount: new TextEncoder().encode(terminalBody).length,
      contentHash: `sha256:${createHash('sha256').update(terminalBody).digest('hex')}`,
    }, { taskId });
    const terminal = await postMessage(harness, device.authorization, newMessage);
    expect(await terminal.json()).toEqual({
      outcomes: [{ id: newMessage.id, outcome: 'rejected', reason: 'inbound_rejected' }],
    });
    expect(consumed).toHaveLength(1);

    const receipts = await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 });
    expect(receipts.messages.map((row) => decodeEnvelope(row.body)).filter((row) => row.type === 'agent.message.disposition')).toHaveLength(1);
  });

  it('lets cancellation win the shared task authority before a new publish can invoke the consumer', async () => {
    let consumed = 0;
    const harness = createHarness({ agentMessage: { consume: async () => { consumed += 1; return { outcome: 'accepted' }; } } });
    const device = await harness.pairDevice(TENANT_A);
    const taskId = await admitMessageEgress(harness, device.deviceId);
    await harness.stores.tasks.claim(TENANT_A, { taskId, deviceId: device.deviceId });
    await expect(harness.cloud.cancelTask(TENANT_A, taskId, 'operator cancelled')).resolves.toMatchObject({
      status: 'cancel_requested',
      cancellation: { reason: 'operator cancelled' },
    });

    const cancelledMessage = message(taskId);
    const cancelled = await postMessage(harness, device.authorization, cancelledMessage);
    expect(await cancelled.json()).toEqual({
      outcomes: [{ id: cancelledMessage.id, outcome: 'rejected', reason: 'inbound_rejected' }],
    });
    expect(consumed).toBe(0);
  });

  it('atomically reserves a live message before the consumer so concurrent same-message publishes have one winner', async () => {
    const clock = createMutableClock();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let consumed = 0;
    const harness = createHarness({ clock, agentMessage: { consume: async () => { consumed += 1; await gate; return { outcome: 'accepted' }; } } });
    const device = await harness.pairDevice(TENANT_A);
    const taskId = await admitMessageEgress(harness, device.deviceId);
    const firstMessage = message(taskId, '10000000-0000-4000-8000-000000001123');
    const first = postMessage(harness, device.authorization, firstMessage);
    await vi.waitFor(() => expect(consumed).toBe(1));
    clock.advance(60_000);
    const secondMessage = message(taskId, '10000000-0000-4000-8000-000000001124');
    const second = postMessage(harness, device.authorization, secondMessage);
    // Give the competing request a chance to pass the first await in the
    // handler while the first consumer is still held. The unfixed route invokes
    // it a second time here; a durable reservation returns pending instead.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(consumed).toBe(1);
    const pending = await second;
    expect(await pending.json()).toEqual({
      outcomes: [{ id: secondMessage.id, outcome: 'rejected', reason: 'inbound_rejected' }],
    });
    release!();
    expect((await first).status).toBe(200);
    expect(consumed).toBe(1);
    const replayMessage = message(taskId, '10000000-0000-4000-8000-000000001126');
    const replay = await postMessage(harness, device.authorization, replayMessage);
    expect(await replay.json()).toEqual({ outcomes: [{ id: replayMessage.id, outcome: 'accepted' }] });
    expect(consumed).toBe(1);
  });

  it('terminalizes consumer failures without replaying the consumer', async () => {
    let consumed = 0;
    const harness = createHarness({
      agentMessage: {
        consume: async () => {
          consumed += 1;
          throw new Error('consumer transport lost');
        },
      },
    });
    const device = await harness.pairDevice(TENANT_A);
    const taskId = await admitMessageEgress(harness, device.deviceId);
    const first = message(taskId);

    expect(await (await postMessage(harness, device.authorization, first)).json()).toEqual({
      outcomes: [{ id: first.id, outcome: 'accepted' }],
    });
    expect(consumed).toBe(1);
    const consumerReplayMessage = message(taskId, '10000000-0000-4000-8000-000000001125');
    const consumerReplay = await postMessage(harness, device.authorization, consumerReplayMessage);
    expect(await consumerReplay.json()).toEqual({ outcomes: [{ id: consumerReplayMessage.id, outcome: 'accepted' }] });
    expect(consumed).toBe(1);
    const mailbox = await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 });
    const dispositions = mailbox.messages
      .map((row) => decodeEnvelope(row.body))
      .filter((row) => row.type === 'agent.message.disposition');
    expect(dispositions.map((row) => row.payload.outcome)).toEqual(['held']);
    expect(dispositions.map((row) => row.payload.reasonCode)).toEqual(['consumer_failed']);
  });
});
