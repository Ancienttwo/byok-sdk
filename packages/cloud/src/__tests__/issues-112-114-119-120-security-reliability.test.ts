import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createEnvelope, decodeEnvelope, type AgentRef } from '@byok-sdk/protocol';
import { describe, expect, it, vi } from 'vitest';
import { handleAgentMessagePublish } from '../inbound';
import { tenantStoresFor } from '../tenant-stores';
import { CLOUD_ORIGIN, TENANT_A, createDeviceKeys, createHarness, type CloudHarness } from './support/harness';

const AGENT_REF = { agentId: 'issue-agent', profileRevision: 'issue-profile' } as const;
const OTHER_AGENT_REF = { agentId: 'issue-agent-other', profileRevision: 'issue-profile' } as const;
const CONTENT_HASH = 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

function message(taskId: string, envelopeId?: string, agentRef: AgentRef = AGENT_REF) {
  return createEnvelope('agent.message.publish', {
    agentRef,
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

async function admitMessageEgress(harness: CloudHarness, deviceId: string, agentRef: AgentRef = AGENT_REF): Promise<string> {
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
      agentRef,
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
    const dedup = vi.spyOn(harness.stores.dedup, 'checkAndRecordAgent');

    const response = await postMessage(harness, device.authorization, message(taskId));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1 });
    expect(rate).toHaveBeenCalledTimes(1);
    expect(dedup).toHaveBeenCalledTimes(1);
    expect(consumed).toHaveLength(1);
  });

  it('isolates the same message id across two exact Agent task attempts on one device', async () => {
    const consumed: unknown[] = [];
    const harness = createHarness({ agentMessage: { consume: async (input) => { consumed.push(input); return { outcome: 'accepted' }; } } });
    const device = await harness.pairDevice(TENANT_A);
    const firstTaskId = await admitMessageEgress(harness, device.deviceId, AGENT_REF);
    const secondTaskId = await admitMessageEgress(harness, device.deviceId, OTHER_AGENT_REF);
    const first = message(firstTaskId, '10000000-0000-4000-8000-000000001130', AGENT_REF);
    const second = message(secondTaskId, '10000000-0000-4000-8000-000000001131', OTHER_AGENT_REF);

    expect(first.payload.messageId).toBe(second.payload.messageId);
    expect(await (await postMessage(harness, device.authorization, first)).json()).toEqual({ accepted: 1 });
    expect(await (await postMessage(harness, device.authorization, second)).json()).toEqual({ accepted: 1 });
    expect(await (await postMessage(
      harness,
      device.authorization,
      message(firstTaskId, '10000000-0000-4000-8000-000000001132', AGENT_REF),
    )).json()).toEqual({ accepted: 1 });
    expect(consumed).toHaveLength(2);
    expect(consumed).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: firstTaskId, payload: expect.objectContaining({ agentRef: AGENT_REF }) }),
      expect.objectContaining({ taskId: secondTaskId, payload: expect.objectContaining({ agentRef: OTHER_AGENT_REF }) }),
    ]));
    const dispositions = (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 })).messages
      .map((row) => decodeEnvelope(row.body))
      .filter((envelope) => envelope.type === 'agent.message.disposition');
    expect(dispositions).toHaveLength(2);
    expect(dispositions.map((envelope) => envelope.payload.messageId)).toEqual([first.payload.messageId, second.payload.messageId]);
  });

  it('replays an existing receipt before terminal state, but never calls the consumer for a new terminal message', async () => {
    const consumed: unknown[] = [];
    const harness = createHarness({ agentMessage: { consume: async (input) => { consumed.push(input); return { outcome: 'accepted' }; } } });
    const device = await harness.pairDevice(TENANT_A);
    const taskId = await admitMessageEgress(harness, device.deviceId);
    const first = message(taskId);
    expect((await postMessage(harness, device.authorization, first)).status).toBe(200);
    await harness.stores.tasks.recordStatus(TENANT_A, { taskId, status: 'complete', agentRef: AGENT_REF });

    const replay = await postMessage(harness, device.authorization, message(taskId, '10000000-0000-4000-8000-000000001121'));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ accepted: 1 });

    const terminalBody = 'new terminal side effect';
    const newMessage = createEnvelope('agent.message.publish', {
      ...first.payload,
      messageId: '10000000-0000-4000-8000-000000001122',
      body: terminalBody,
      byteCount: new TextEncoder().encode(terminalBody).length,
      contentHash: `sha256:${createHash('sha256').update(terminalBody).digest('hex')}`,
    }, { taskId });
    const terminal = await postMessage(harness, device.authorization, newMessage);
    expect(await terminal.json()).toEqual({ accepted: 0, rejected: 1 });
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

    const cancelled = await postMessage(harness, device.authorization, message(taskId));
    expect(await cancelled.json()).toEqual({ accepted: 0, rejected: 1 });
    expect(consumed).toBe(0);
  });

  it('keeps one logical product effect when exact live publishes consume concurrently', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const outcomes = new Map<string, { outcome: 'accepted' }>();
    let invocations = 0;
    let effects = 0;
    const harness = createHarness({
      agentMessage: {
        consume: async (input) => {
          invocations += 1;
          const key = JSON.stringify([input.tenant, input.deviceId, input.taskId, input.payload.agentRef, input.payload.messageId]);
          const existing = outcomes.get(key);
          if (existing !== undefined) return existing;
          const outcome = { outcome: 'accepted' as const };
          outcomes.set(key, outcome);
          effects += 1;
          await gate;
          return outcome;
        },
      },
    });
    const device = await harness.pairDevice(TENANT_A);
    const taskId = await admitMessageEgress(harness, device.deviceId);
    const first = postMessage(harness, device.authorization, message(taskId, '10000000-0000-4000-8000-000000001123'));
    await vi.waitFor(() => expect(invocations).toBe(1));
    const second = postMessage(harness, device.authorization, message(taskId, '10000000-0000-4000-8000-000000001124'));
    expect(await (await second).json()).toEqual({ accepted: 1 });
    expect(invocations).toBe(2);
    expect(effects).toBe(1);
    release!();
    expect((await first).status).toBe(200);
    expect(effects).toBe(1);
    const replay = await postMessage(harness, device.authorization, message(taskId, '10000000-0000-4000-8000-000000001126'));
    expect(await replay.json()).toEqual({ accepted: 1 });
    expect(invocations).toBe(2);
    expect(effects).toBe(1);
  });

  it('recovers an exact message after consumer success and pre-write finalization failure', async () => {
    // This map models the product's durable, immutable outcome authority.
    const outcomes = new Map<string, { outcome: 'accepted' }>();
    let invocations = 0;
    let effects = 0;
    const createConsumer = () => async (
      input: Parameters<NonNullable<NonNullable<Parameters<typeof createHarness>[0]>['agentMessage']>['consume']>[0],
    ) => {
      invocations += 1;
      const key = JSON.stringify([input.tenant, input.deviceId, input.taskId, input.payload.agentRef, input.payload.messageId]);
      if (!outcomes.has(key)) { outcomes.set(key, { outcome: 'accepted' }); effects += 1; }
      return outcomes.get(key)!;
    };
    let activeConsumer = createConsumer();
    const harness = createHarness({
      agentMessage: {
        consume: (input) => activeConsumer(input),
      },
    });
    const device = await harness.pairDevice(TENANT_A);
    const taskId = await admitMessageEgress(harness, device.deviceId);
    const envelope = message(taskId);
    const finalize = harness.stores.tasks.finalizeAgentMessage.bind(harness.stores.tasks);
    let fail = true;
    harness.stores.tasks.finalizeAgentMessage = async (...args) => {
      if (fail) { fail = false; throw new Error('injected pre-write finalization failure'); }
      return finalize(...args);
    };
    const first = await postMessage(harness, device.authorization, envelope);
    expect(first.status).toBe(500);
    expect(effects).toBe(1);
    const recomposedStores = tenantStoresFor(
      { kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId: device.deviceId },
      { core: harness.core, cloud: harness.stores },
    );
    await expect(handleAgentMessagePublish(
      recomposedStores,
      device.deviceId,
      taskId,
      envelope.payload,
      undefined,
      false,
    )).rejects.toThrow('consumer is unavailable');
    const pending = await recomposedStores.tasks.readAgentMessage({
      taskId,
      deviceId: device.deviceId,
      messageId: envelope.payload.messageId,
      payloadBody: JSON.stringify(envelope.payload),
    });
    expect(pending).toBeDefined();
    expect(pending?.terminalBody).toBeUndefined();
    activeConsumer = createConsumer();
    const retry = await postMessage(harness, device.authorization, envelope);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ accepted: 1 });
    expect(invocations).toBe(2);
    expect(effects).toBe(1);
    const replay = await postMessage(harness, device.authorization, envelope);
    expect(await replay.json()).toEqual({ accepted: 1 });
    expect(effects).toBe(1);
    const rows = (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 })).messages;
    const dispositions = rows.map((row) => decodeEnvelope(row.body)).filter((row) => row.type === 'agent.message.disposition');
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]!.payload.outcome).toBe('accepted');
  });

  it.each(['complete', 'cancel_requested'] as const)(
    'recovers an existing exact pending message after %s while rejecting new and conflicting payloads',
    async (terminalState) => {
      const outcomes = new Map<string, { outcome: 'accepted' }>();
      let effects = 0;
      const harness = createHarness({
        agentMessage: {
          consume: async (input) => {
            const key = JSON.stringify([input.tenant, input.deviceId, input.taskId, input.payload.agentRef, input.payload.messageId]);
            if (!outcomes.has(key)) { outcomes.set(key, { outcome: 'accepted' }); effects += 1; }
            return outcomes.get(key)!;
          },
        },
      });
      const device = await harness.pairDevice(TENANT_A);
      const taskId = await admitMessageEgress(harness, device.deviceId);
      const original = message(taskId);
      const finalize = harness.stores.tasks.finalizeAgentMessage.bind(harness.stores.tasks);
      let fail = true;
      harness.stores.tasks.finalizeAgentMessage = async (...args) => {
        if (fail) { fail = false; throw new Error('injected pending reservation'); }
        return finalize(...args);
      };

      expect((await postMessage(harness, device.authorization, original)).status).toBe(500);
      if (terminalState === 'complete') {
        await harness.stores.tasks.recordStatus(TENANT_A, { taskId, status: 'complete', agentRef: AGENT_REF });
      } else {
        await harness.stores.tasks.claim(TENANT_A, { taskId, deviceId: device.deviceId });
        await harness.cloud.cancelTask(TENANT_A, taskId, 'cancel after consume');
      }

      expect(await (await postMessage(harness, device.authorization, original)).json()).toEqual({ accepted: 1 });
      expect(effects).toBe(1);

      const newMessage = createEnvelope('agent.message.publish', {
        ...original.payload,
        messageId: '10000000-0000-4000-8000-000000001127',
      }, { taskId });
      expect(await (await postMessage(harness, device.authorization, newMessage)).json()).toEqual({ accepted: 0, rejected: 1 });

      const conflictingBody = 'changed after reservation';
      const conflicting = createEnvelope('agent.message.publish', {
        ...original.payload,
        body: conflictingBody,
        byteCount: new TextEncoder().encode(conflictingBody).length,
        contentHash: `sha256:${createHash('sha256').update(conflictingBody).digest('hex')}`,
      }, { taskId });
      expect(await (await postMessage(harness, device.authorization, conflicting)).json()).toEqual({ accepted: 0, rejected: 1 });
      expect(effects).toBe(1);
    },
  );

  it('retries an exact pending message when the consumer commits and then throws', async () => {
    const outcomes = new Map<string, { outcome: 'accepted' }>();
    let invocations = 0;
    let effects = 0;
    const harness = createHarness({
      agentMessage: {
        consume: async (input) => {
          invocations += 1;
          const key = JSON.stringify([input.tenant, input.deviceId, input.taskId, input.payload.agentRef, input.payload.messageId]);
          const existing = outcomes.get(key);
          if (existing !== undefined) return existing;
          outcomes.set(key, { outcome: 'accepted' });
          effects += 1;
          throw new Error('consumer transport lost after commit');
        },
      },
    });
    const device = await harness.pairDevice(TENANT_A);
    const taskId = await admitMessageEgress(harness, device.deviceId);
    const first = message(taskId);

    expect((await postMessage(harness, device.authorization, first)).status).toBe(500);
    expect(invocations).toBe(1);
    expect(effects).toBe(1);
    const consumerReplay = await postMessage(harness, device.authorization, message(taskId, '10000000-0000-4000-8000-000000001125'));
    expect(await consumerReplay.json()).toEqual({ accepted: 1 });
    expect(invocations).toBe(2);
    expect(effects).toBe(1);
    expect(await (await postMessage(harness, device.authorization, first)).json()).toEqual({ accepted: 1 });
    expect(invocations).toBe(2);
    const mailbox = await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 });
    const dispositions = mailbox.messages
      .map((row) => decodeEnvelope(row.body))
      .filter((row) => row.type === 'agent.message.disposition');
    expect(dispositions.map((row) => row.payload.outcome)).toEqual(['accepted']);
  });
});
