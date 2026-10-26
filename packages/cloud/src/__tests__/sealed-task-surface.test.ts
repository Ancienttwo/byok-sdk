/**
 * #654 E4a: what a sealed task shows outside the device.
 *
 * - A draft is plaintext, so the Host refuses `agent.message.draft` for a task
 *   whose offer has any `sealing` (§6.1, §10.4).
 * - Each Host read of a sealed task returns only the stored sealed member, or
 *   the closed plaintext projection (12e).
 */
import { readFileSync } from 'node:fs';

import type { TenantId } from '@byok-sdk/core';
import {
  createEnvelope,
  requiredReceiverCapabilities,
  type Envelope,
  type MessageType,
} from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { handleInboundEnvelope } from '../inbound';
import { tenantStoresFor } from '../tenant-stores';
import { PRODUCT_ID, TENANT_A, createHarness, type CloudHarness } from './support/harness';
import { SEALING, inlineMember, sealInput } from './support/sealed';

type CorpusLine = { type: MessageType; payload: Record<string, unknown> };
const corpus = readFileSync(new URL('../../../protocol/src/__tests__/golden/v3.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as CorpusLine);
const lines = corpus.map((line, index) => ({ ...line, index }));
const egressLine = (type: MessageType, categories: readonly string[]) => lines.find((line) => line.type === type
  && line.payload.messageEgress !== undefined
  && JSON.stringify((line.payload.sealing as { categories?: unknown } | undefined)?.categories) === JSON.stringify(categories))!;

const OUTPUT_MEMBER = corpus.find((line) => line.type === 'task.complete_sealed')!.payload.sealed!;
const CONTEXT = { destinationBinding: 'conversation/654/turn/1' };

let taskCount = 0;

function deviceStores(harness: CloudHarness, deviceId: string) {
  return tenantStoresFor(
    { kind: 'device', tenantId: TENANT_A as TenantId, productId: PRODUCT_ID, deviceId },
    { core: harness.core, cloud: harness.stores, mailboxWake: harness.mailboxWake },
  );
}

function deviceSender(harness: CloudHarness, deviceId: string, taskId: string) {
  const stores = deviceStores(harness, deviceId);
  return (type: MessageType, payload: object) =>
    handleInboundEnvelope(stores, deviceId, createEnvelope(type as Envelope['type'], payload as never, { taskId }) as Envelope);
}

/** An egress Agent task with a message requirement, offered through `lane`. */
async function egressTask(lane: 'plain' | 'sealed' | 'fresh', payload: Record<string, unknown>, type: MessageType) {
  const harness = createHarness({ agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
  const device = await harness.pairDevice(TENANT_A);
  await harness.stores.devices.recordCapabilities(TENANT_A, {
    deviceId: device.deviceId, capabilities: requiredReceiverCapabilities(type, payload as never),
  });
  taskCount += 1;
  const taskId = `sealed-surface-${taskCount}`;
  if (lane === 'plain') await harness.cloud.enqueueAgentEgressOffer(TENANT_A, device.deviceId, { taskId, payload: payload as never, agentMessageContext: CONTEXT });
  if (lane === 'sealed') await harness.cloud.enqueueSealedAgentEgressOffer(TENANT_A, device.deviceId, { taskId, payload: payload as never, agentMessageContext: CONTEXT });
  if (lane === 'fresh') await harness.cloud.submitSealedAgentExecution(TENANT_A, { taskId, deviceId: device.deviceId, payload: payload as never, agentMessageContext: CONTEXT });
  const agentRef = payload.agentRef as { agentId: string; profileRevision: string };
  const stores = deviceStores(harness, device.deviceId);
  return {
    harness, taskId, agentRef,
    send: deviceSender(harness, device.deviceId, taskId),
    deliver: (envelope: Envelope) => handleInboundEnvelope(stores, device.deviceId, envelope),
  };
}

describe('a sealed task streams no draft (#654 E4a)', () => {
  const refused = { outcome: 'rejected', reason: 'agent_message_draft_invalid' };

  it('accepts a draft for a plaintext egress task', async () => {
    const line = lines.find((entry) => entry.type === 'task.offer_for_agent_with_egress' && entry.payload.messageEgress !== undefined)!;
    const task = await egressTask('plain', line.payload, line.type);
    expect(await task.send('agent.message.draft', { agentRef: task.agentRef, revision: 1, offset: 0, text: 'hello' }))
      .toEqual({ outcome: 'accepted' });
    expect(await task.harness.stores.agentMessageDraft.read(TENANT_A, task.taskId)).toBeDefined();
  });

  it.each([
    ['task.offer_for_agent_with_egress_sealed', 'sealed'],
    ['task.offer_for_agent_with_egress_fresh_sealed', 'fresh'],
  ] as const)('%s with output sealing refuses a draft before the envelope identity is reserved', async (type, lane) => {
    const line = egressLine(type, ['task-output']);
    const task = await egressTask(lane, line.payload, line.type);
    const draft = createEnvelope('agent.message.draft', { agentRef: task.agentRef, revision: 1, offset: 0, text: 'hello' }, { taskId: task.taskId });
    // The same envelope twice: a reserved identity would answer the replay as a duplicate.
    expect(await task.deliver(draft)).toEqual(refused);
    expect(await task.deliver(draft)).toEqual(refused);
    expect(await task.harness.stores.agentMessageDraft.read(TENANT_A, task.taskId)).toBeUndefined();
  });

  it('a task with input sealing only also refuses a draft', async () => {
    const line = egressLine('task.offer_for_agent_with_egress_sealed', ['task-output']);
    taskCount += 1;
    const { instruction: _instruction, ...payload } = line.payload;
    const content = await sealInput({
      tenant: TENANT_A, deviceId: 'unused', type: 'task.offer_for_agent_with_egress_sealed',
      identity: { taskId: `input-only-${taskCount}` }, plaintext: { instruction: 'sealed' },
    });
    const sealedPayload = { ...payload, sealing: { ...SEALING, categories: ['task-input'] }, sealed: inlineMember(content) };
    const task = await egressTask('sealed', sealedPayload, line.type);
    expect(await task.send('agent.message.draft', { agentRef: task.agentRef, revision: 1, offset: 0, text: 'hello' })).toEqual(refused);
    expect(await task.harness.stores.agentMessageDraft.read(TENANT_A, task.taskId)).toBeUndefined();
  });
});

describe('the Host read surface of a sealed task (#654 E4a)', () => {
  it('returns only sealed members and closed plaintext fields', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId, capabilities: requiredReceiverCapabilities('task.offer_sealed', { sealing: SEALING, sealed: {} } as never),
    });
    const taskId = 'sealed-read-surface';
    const instruction = inlineMember(await sealInput({
      tenant: TENANT_A, deviceId: device.deviceId, type: 'task.offer_sealed', identity: { taskId }, plaintext: { instruction: 'secret plan' },
    }));
    await harness.cloud.enqueueSealedOffer(TENANT_A, device.deviceId, { taskId, payload: { runtime: 'pi', sealing: SEALING, sealed: instruction } as never });
    const send = deviceSender(harness, device.deviceId, taskId);
    for (const [type, payload] of [
      ['task.claim', { deviceId: device.deviceId, runtime: 'pi' }],
      ['task.started', {}],
      ['task.progress_sealed', { seq: 1, sealed: OUTPUT_MEMBER }],
      ['task.await_approval_sealed', { approvalId: 'approval-1', sealed: OUTPUT_MEMBER }],
      ['task.approval_resolved', { approvalId: 'approval-1', decision: 'approve', resolvedBy: 'local', at: '2026-10-24T00:00:00.000Z' }],
      ['task.complete_sealed', { sessionRef: 'session-sealed', sealed: OUTPUT_MEMBER }],
    ] as const) {
      expect(await send(type, payload), type).toEqual({ outcome: 'accepted' });
    }

    const offer = await harness.cloud.readTaskOffer(TENANT_A, taskId);
    expect(offer?.type).toBe('task.offer_sealed');
    expect(offer?.payload).toEqual({ runtime: 'pi', sealing: SEALING, sealed: instruction });

    expect(await harness.cloud.readTaskAttempt(TENANT_A, taskId)).toEqual({
      tenantId: TENANT_A, taskId, deviceId: device.deviceId, ownerDeviceId: device.deviceId, claimedRuntime: 'pi',
      status: 'complete', offeredAt: expect.any(String), claimedAt: expect.any(String), terminalAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    expect((await harness.cloud.readDeviceTerminal(TENANT_A, taskId))?.envelope.payload)
      .toEqual({ sessionRef: 'session-sealed', sealed: OUTPUT_MEMBER });
    expect(await harness.cloud.readTaskResult(TENANT_A, taskId))
      .toEqual({ taskId, state: 'complete', sessionRef: 'session-sealed', recordedAt: expect.any(String) });

    expect((await harness.cloud.readActivity(TENANT_A, taskId))?.entries).toEqual([{
      taskId, sourceEnvelopeId: expect.any(String), batchSeq: 1, eventIndex: 0, sourceDropped: 0,
      receivedAt: expect.any(String), sealed: OUTPUT_MEMBER,
    }]);

    const approvals = await harness.cloud.readApprovalTimeline(TENANT_A, taskId);
    expect(approvals?.entries.map(({ event }) => event)).toEqual([
      { type: 'approval_requested', approvalId: 'approval-1', sealed: OUTPUT_MEMBER },
      { type: 'approval_resolved', approvalId: 'approval-1', decision: 'approve', resolvedBy: 'local', at: '2026-10-24T00:00:00.000Z' },
    ]);
  });

  it('a plaintext terminal of a sealed task keeps only its closed code', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId, capabilities: requiredReceiverCapabilities('task.offer_sealed', { sealing: SEALING, sealed: {} } as never),
    });
    const taskId = 'sealed-read-surface-fail';
    const instruction = inlineMember(await sealInput({
      tenant: TENANT_A, deviceId: device.deviceId, type: 'task.offer_sealed', identity: { taskId }, plaintext: { instruction: 'secret plan' },
    }));
    await harness.cloud.enqueueSealedOffer(TENANT_A, device.deviceId, { taskId, payload: { runtime: 'pi', sealing: SEALING, sealed: instruction } as never });
    const send = deviceSender(harness, device.deviceId, taskId);
    expect(await send('task.claim', { deviceId: device.deviceId, runtime: 'pi' })).toEqual({ outcome: 'accepted' });
    expect(await send('task.fail', { reason: 'sealed_key_unavailable', retryable: false })).toEqual({ outcome: 'accepted' });
    expect(await harness.cloud.readTaskAttempt(TENANT_A, taskId)).toMatchObject({ status: 'failed', terminalCause: 'sealed_key_unavailable' });
    expect(await harness.cloud.readTaskResult(TENANT_A, taskId)).toEqual({
      taskId, state: 'failed', reason: 'sealed_key_unavailable', terminalCause: 'sealed_key_unavailable', retryable: false,
      recordedAt: expect.any(String),
    });
  });
});
