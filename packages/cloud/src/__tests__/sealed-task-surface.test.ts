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
import { sealContent } from '@byok-sdk/core/sealed-payload';
import {
  createEnvelope,
  requiredReceiverCapabilities,
  type Envelope,
  type MessageType,
} from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { handleInboundEnvelope } from '../inbound';
import { tenantStoresFor } from '../tenant-stores';
import { PRODUCT_ID, TENANT_A, TEST_AGENT_REF, createHarness, type CloudHarness } from './support/harness';
import { SEALING, inlineMember } from './support/sealed';

type CorpusLine = { type: MessageType; payload: Record<string, unknown> };
const corpus = readFileSync(new URL('../../../protocol/src/__tests__/golden/v4.envelopes.ndjson', import.meta.url), 'utf8')
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

const SCOPE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

type AgentRef = { readonly agentId: string; readonly profileRevision: string };

/**
 * The sealed instruction of an Agent offer of plaintext type `family` to
 * `deviceId`. `sealInput` binds no Agent; an Agent offer's instruction binds
 * the offer's Agent.
 */
async function sealAgentInstruction(
  deviceId: string,
  taskId: string,
  instruction: string,
  agentRef: AgentRef = TEST_AGENT_REF,
  family = 'task.offer_for_agent',
) {
  const content = await sealContent({
    scopeKey: SCOPE_KEY,
    scope: { id: SEALING.scopeId, epoch: SEALING.epoch },
    chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` },
    sender: 'A'.repeat(43),
    category: 'task-input',
    binding: {
      tenantId: TENANT_A,
      family,
      direction: 'server-to-daemon',
      identity: { taskId },
      deviceId,
      agentRef: { agentId: agentRef.agentId, profileRevision: agentRef.profileRevision },
      categories: [...SEALING.categories],
      notAfter: null,
    },
    plaintext: { instruction },
    maxContentLength: 2 * 1024 * 1024,
  });
  return inlineMember(content);
}

/** A sealed Agent resume offer payload with both categories sealed. */
function sealedAgentOffer(sealed: Awaited<ReturnType<typeof sealAgentInstruction>>) {
  return { runtime: 'pi' as const, agentRef: TEST_AGENT_REF, sessionRef: 'test-session', sealing: SEALING, sealed };
}

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

type EgressPayload = Record<string, unknown>;

/**
 * An egress Agent task with a message requirement, offered through `lane`.
 * A payload that seals its instruction is built for the device and task id.
 */
async function egressTask(
  lane: 'plain' | 'sealed' | 'fresh',
  build: EgressPayload | ((deviceId: string, taskId: string) => Promise<EgressPayload>),
  type: MessageType,
) {
  const harness = createHarness({ agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
  const device = await harness.pairDevice(TENANT_A);
  taskCount += 1;
  const taskId = `sealed-surface-${taskCount}`;
  const payload = typeof build === 'function' ? await build(device.deviceId, taskId) : build;
  await harness.stores.devices.recordCapabilities(TENANT_A, {
    deviceId: device.deviceId, capabilities: requiredReceiverCapabilities(type, payload as never),
  });
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
    const { instruction: _instruction, ...payload } = line.payload;
    const task = await egressTask('sealed', async (deviceId, taskId) => ({
      ...payload,
      sealing: { ...SEALING, categories: ['task-input'] },
      sealed: await sealAgentInstruction(deviceId, taskId, 'sealed', payload.agentRef as AgentRef, 'task.offer_for_agent_with_egress'),
    }), line.type);
    expect(await task.send('agent.message.draft', { agentRef: task.agentRef, revision: 1, offset: 0, text: 'hello' })).toEqual(refused);
    expect(await task.harness.stores.agentMessageDraft.read(TENANT_A, task.taskId)).toBeUndefined();
  });
});

describe('the Host read surface of a sealed task (#654 E4a)', () => {
  it('returns only sealed members and closed plaintext fields', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const taskId = 'sealed-read-surface';
    const instruction = await sealAgentInstruction(device.deviceId, taskId, 'secret plan');
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId, capabilities: requiredReceiverCapabilities('task.offer_for_agent_sealed', sealedAgentOffer(instruction) as never),
    });
    await harness.cloud.enqueueSealedAgentOffer(TENANT_A, device.deviceId, { taskId, payload: sealedAgentOffer(instruction) as never });
    const send = deviceSender(harness, device.deviceId, taskId);
    for (const [type, payload] of [
      ['task.claim', { deviceId: device.deviceId, runtime: 'pi', agentRef: TEST_AGENT_REF }],
      ['task.started', {}],
      ['task.progress_sealed', { seq: 1, sealed: OUTPUT_MEMBER }],
      ['task.await_approval_sealed', { approvalId: 'approval-1', sealed: OUTPUT_MEMBER }],
      ['task.approval_resolved', { approvalId: 'approval-1', decision: 'approve', resolvedBy: 'local', at: '2026-10-24T00:00:00.000Z' }],
      ['task.complete_sealed', { sessionRef: 'session-sealed', agentRef: TEST_AGENT_REF, sealed: OUTPUT_MEMBER }],
    ] as const) {
      expect(await send(type, payload), type).toEqual({ outcome: 'accepted' });
    }

    const offer = await harness.cloud.readTaskOffer(TENANT_A, taskId);
    expect(offer?.type).toBe('task.offer_for_agent_sealed');
    expect(offer?.payload).toEqual(sealedAgentOffer(instruction));

    expect(await harness.cloud.readTaskAttempt(TENANT_A, taskId)).toEqual({
      tenantId: TENANT_A, taskId, deviceId: device.deviceId, agentRef: TEST_AGENT_REF, ownerDeviceId: device.deviceId, claimedRuntime: 'pi',
      status: 'complete', offeredAt: expect.any(String), claimedAt: expect.any(String), terminalAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    expect((await harness.cloud.readDeviceTerminal(TENANT_A, taskId))?.envelope.payload)
      .toEqual({ sessionRef: 'session-sealed', agentRef: TEST_AGENT_REF, sealed: OUTPUT_MEMBER });
    expect(await harness.cloud.readTaskResult(TENANT_A, taskId))
      .toEqual({ taskId, state: 'complete', sessionRef: 'session-sealed', agentRef: TEST_AGENT_REF, recordedAt: expect.any(String) });

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
    const taskId = 'sealed-read-surface-fail';
    const instruction = await sealAgentInstruction(device.deviceId, taskId, 'secret plan');
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId, capabilities: requiredReceiverCapabilities('task.offer_for_agent_sealed', sealedAgentOffer(instruction) as never),
    });
    await harness.cloud.enqueueSealedAgentOffer(TENANT_A, device.deviceId, { taskId, payload: sealedAgentOffer(instruction) as never });
    const send = deviceSender(harness, device.deviceId, taskId);
    expect(await send('task.claim', { deviceId: device.deviceId, runtime: 'pi', agentRef: TEST_AGENT_REF })).toEqual({ outcome: 'accepted' });
    expect(await send('task.fail', { reason: 'sealed_key_unavailable', retryable: false, agentRef: TEST_AGENT_REF })).toEqual({ outcome: 'accepted' });
    expect(await harness.cloud.readTaskAttempt(TENANT_A, taskId)).toMatchObject({ status: 'failed', terminalCause: 'sealed_key_unavailable' });
    expect(await harness.cloud.readTaskResult(TENANT_A, taskId)).toEqual({
      taskId, state: 'failed', reason: 'sealed_key_unavailable', terminalCause: 'sealed_key_unavailable', retryable: false,
      agentRef: TEST_AGENT_REF, recordedAt: expect.any(String),
    });
  });
});
