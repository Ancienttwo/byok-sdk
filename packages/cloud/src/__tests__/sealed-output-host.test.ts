/**
 * #654 E3b-2: the Host side of sealed task output.
 *
 * - A task whose offer sealed `task-output` reports output sealed, or in
 *   plaintext with only the closed codes of `SEALED_TASK_PLAIN_CODES` (12d).
 * - A task that did not seal its output reports no sealed output.
 * - A sealed terminal takes every gate of its plaintext type. It records the
 *   status, keeps only a closed code as the terminal cause, reads back as a
 *   `DeviceTerminal` with its sealed member, and projects only its plaintext
 *   fields onto `TerminalResult` (12e).
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
import { PRODUCT_ID, TENANT_A, createHarness, type CloudHarness, type PairedDevice } from './support/harness';
import { SEALING, inlineMember, sealInput } from './support/sealed';

const corpus = readFileSync(new URL('../../../protocol/src/__tests__/golden/v3.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: MessageType; payload: { sealed?: object } });

/** A schema-valid `task-output` sealed member from the corpus. The Host reads only its outer fields. */
const OUTPUT_MEMBER = corpus.find((line) => line.type === 'task.complete_sealed')!.payload.sealed!;
/** A `task-output` member above the inline limit, which names its ciphertext blob. */
const BY_REFERENCE_MEMBER = corpus.find((line) => line.type === 'task.complete_sealed'
  && (line.payload.sealed as { ciphertextRef?: unknown }).ciphertextRef !== undefined)!.payload.sealed!;

/** The plaintext fields of each sealed output type, with no Agent, harness or recovery binding. */
const SEALED_OUTPUTS = {
  'task.complete_sealed': { sessionRef: 'session-sealed', sealed: OUTPUT_MEMBER },
  'task.fail_sealed': { retryable: false, sealed: OUTPUT_MEMBER },
  'task.decline_sealed': { retryable: false, sealed: OUTPUT_MEMBER },
  'task.cancelled_sealed': { sealed: OUTPUT_MEMBER },
  'task.artifact_sealed': {
    artifactId: '00000000-0000-4000-8000-000000000600', name: 'patch.diff', contentType: 'text/x-diff', sealed: OUTPUT_MEMBER,
  },
  'task.progress_sealed': { seq: 1, sealed: OUTPUT_MEMBER },
  'task.await_approval_sealed': { approvalId: 'approval-1', sealed: OUTPUT_MEMBER },
} as const;
type SealedOutputType = keyof typeof SEALED_OUTPUTS;

const OUTPUT_SEALING = SEALING;
const INPUT_SEALING = { ...SEALING, categories: ['task-input'] } as const;

interface Task {
  readonly harness: CloudHarness;
  readonly device: PairedDevice;
  readonly taskId: string;
  send(type: MessageType, payload: object): ReturnType<typeof handleInboundEnvelope>;
}

let taskCount = 0;

/** A task offered to a sealed-capable device, with `sealing` (or none), claimed unless told not to. */
async function offeredTask(sealing: typeof OUTPUT_SEALING | typeof INPUT_SEALING | undefined, claim = true): Promise<Task> {
  const harness = createHarness();
  const device = await harness.pairDevice(TENANT_A);
  const capabilities = requiredReceiverCapabilities('task.offer_sealed', { sealing: OUTPUT_SEALING, sealed: {} });
  await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities });
  taskCount += 1;
  const taskId = `sealed-output-${taskCount}`;
  if (sealing === undefined) {
    await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { taskId, payload: { instruction: 'plain', runtime: 'pi' } });
  } else {
    const content = await sealInput({
      tenant: TENANT_A, deviceId: device.deviceId, type: 'task.offer_sealed', identity: { taskId }, plaintext: { instruction: 'sealed' },
    });
    await harness.cloud.enqueueSealedOffer(TENANT_A, device.deviceId, {
      taskId,
      payload: { runtime: 'pi', sealing, sealed: inlineMember(content) } as never,
    });
  }
  const stores = tenantStoresFor(
    { kind: 'device', tenantId: TENANT_A as TenantId, productId: PRODUCT_ID, deviceId: device.deviceId },
    { core: harness.core, cloud: harness.stores, mailboxWake: harness.mailboxWake },
  );
  const send = (type: MessageType, payload: object) =>
    handleInboundEnvelope(stores, device.deviceId, createEnvelope(type as Envelope['type'], payload as never, { taskId }) as Envelope);
  if (claim) {
    expect(await send('task.claim', { deviceId: device.deviceId, runtime: 'pi' })).toEqual({ outcome: 'accepted' });
    expect(await send('task.started', {})).toEqual({ outcome: 'accepted' });
  }
  return { harness, device, taskId, send };
}

/** An output-only sealed Agent offer from the corpus. */
const AGENT_OFFER = corpus.find((line) => line.type === 'task.offer_for_agent_sealed' && line.payload.sealed === undefined)!
  .payload as unknown as { agentRef: { agentId: string; profileRevision: string }; runtime: string; sealing: { categories: string[] } };

/** An Agent task whose offer seals its output, claimed unless told not to. */
async function agentTask(claim: boolean): Promise<Task> {
  const harness = createHarness();
  const device = await harness.pairDevice(TENANT_A);
  const capabilities = requiredReceiverCapabilities('task.offer_for_agent_sealed', AGENT_OFFER);
  await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities });
  taskCount += 1;
  const taskId = `sealed-agent-output-${taskCount}`;
  expect(AGENT_OFFER.sealing.categories).toContain('task-output');
  await harness.cloud.enqueueSealedAgentOffer(TENANT_A, device.deviceId, { taskId, payload: AGENT_OFFER as never });
  const stores = tenantStoresFor(
    { kind: 'device', tenantId: TENANT_A as TenantId, productId: PRODUCT_ID, deviceId: device.deviceId },
    { core: harness.core, cloud: harness.stores, mailboxWake: harness.mailboxWake },
  );
  const send = (type: MessageType, payload: object) =>
    handleInboundEnvelope(stores, device.deviceId, createEnvelope(type as Envelope['type'], payload as never, { taskId }) as Envelope);
  if (claim) {
    expect(await send('task.claim', { deviceId: device.deviceId, runtime: AGENT_OFFER.runtime, agentRef: AGENT_OFFER.agentRef }))
      .toEqual({ outcome: 'accepted' });
    expect(await send('task.started', {})).toEqual({ outcome: 'accepted' });
  }
  return { harness, device, taskId, send };
}

const refused = (reason: string) => ({ outcome: 'rejected', reason });

describe('a sealed terminal of an output-sealed task (#654 E3b-2)', () => {
  const terminals = [
    ['task.complete_sealed', 'complete', undefined, { state: 'complete', sessionRef: 'session-sealed' }],
    ['task.fail_sealed', 'failed', undefined, { state: 'failed', retryable: false }],
    ['task.cancelled_sealed', 'cancelled', undefined, { state: 'cancelled' }],
  ] as const;

  it.each(terminals)('%s records the status, no terminal cause, and reads back with its sealed member', async (type, status, _cause, result) => {
    const task = await offeredTask(OUTPUT_SEALING);
    expect(await task.send(type, SEALED_OUTPUTS[type])).toEqual({ outcome: 'accepted' });

    const attempt = await task.harness.cloud.readTaskAttempt(TENANT_A, task.taskId);
    expect(attempt).toMatchObject({ status });
    expect(attempt?.terminalCause).toBeUndefined();
    expect((await task.harness.cloud.readDeviceTerminal(TENANT_A, task.taskId))?.envelope).toMatchObject({
      type, task_id: task.taskId, payload: SEALED_OUTPUTS[type],
    });
    expect(await task.harness.cloud.readTaskResult(TENANT_A, task.taskId)).toEqual({
      taskId: task.taskId, ...result, recordedAt: expect.any(String),
    });
  });

  it('task.decline_sealed keeps only its closed home code as the terminal cause', async () => {
    const task = await offeredTask(OUTPUT_SEALING, false);
    const payload = { ...SEALED_OUTPUTS['task.decline_sealed'], code: 'agent_home_writer_busy' };
    expect(await task.send('task.decline_sealed', payload)).toEqual({ outcome: 'accepted' });

    expect(await task.harness.cloud.readTaskAttempt(TENANT_A, task.taskId)).toMatchObject({
      status: 'failed', terminalCause: 'agent_home_writer_busy',
    });
    expect(await task.harness.cloud.readTaskResult(TENANT_A, task.taskId)).toEqual({
      taskId: task.taskId, state: 'failed', code: 'agent_home_writer_busy', terminalCause: 'agent_home_writer_busy', retryable: false,
      recordedAt: expect.any(String),
    });
  });

  it('a later terminal does not replace the first one', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    expect(await task.send('task.complete_sealed', SEALED_OUTPUTS['task.complete_sealed'])).toEqual({ outcome: 'accepted' });
    expect(await task.send('task.fail_sealed', SEALED_OUTPUTS['task.fail_sealed'])).toEqual({ outcome: 'accepted' });
    expect((await task.harness.cloud.readDeviceTerminal(TENANT_A, task.taskId))?.envelope.type).toBe('task.complete_sealed');
  });

  it('accepts a sealed artifact and stores nothing for it', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    expect(await task.send('task.artifact_sealed', SEALED_OUTPUTS['task.artifact_sealed'])).toEqual({ outcome: 'accepted' });
    expect(await task.harness.cloud.readTaskAttempt(TENANT_A, task.taskId)).toMatchObject({ status: 'running' });
  });

  it.each(Object.keys(SEALED_OUTPUTS) as SealedOutputType[])(
    'refuses %s by ciphertextRef, because this Host does not retain the blob, before the envelope identity is reserved',
    async (type) => {
      const task = await offeredTask(OUTPUT_SEALING, type !== 'task.decline_sealed');
      const payload = { ...SEALED_OUTPUTS[type], sealed: BY_REFERENCE_MEMBER };
      expect(await task.send(type, payload)).toEqual(refused('sealed_payload_unsupported'));
      expect(await task.send(type, payload)).toEqual(refused('sealed_payload_unsupported'));
      expect(await task.harness.cloud.readDeviceTerminal(TENANT_A, task.taskId)).toBeUndefined();
    },
  );

  it('stores each sealed progress batch as one activity entry (12e)', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    expect(await task.send('task.progress_sealed', SEALED_OUTPUTS['task.progress_sealed'])).toEqual({ outcome: 'accepted' });
    expect(await task.send('task.progress_sealed', { ...SEALED_OUTPUTS['task.progress_sealed'], seq: 2 })).toEqual({ outcome: 'accepted' });
    const tail = await task.harness.cloud.readActivity(TENANT_A, task.taskId);
    expect(tail?.entries).toEqual([1, 2].map((batchSeq) => ({
      taskId: task.taskId,
      sourceEnvelopeId: expect.any(String),
      batchSeq,
      eventIndex: 0,
      sourceDropped: 0,
      receivedAt: expect.any(String),
      sealed: OUTPUT_MEMBER,
    })));
    expect(tail?.cursor).toEqual({ batchSeq: 2, eventIndex: 0 });
  });

  it('stores a sealed approval request, which the Host approves while it is pending (12e)', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    expect(await task.send('task.await_approval_sealed', SEALED_OUTPUTS['task.await_approval_sealed'])).toEqual({ outcome: 'accepted' });
    expect((await task.harness.cloud.readApprovalTimeline(TENANT_A, task.taskId))?.entries.map(({ event }) => event)).toEqual([
      { type: 'approval_requested', approvalId: 'approval-1', sealed: OUTPUT_MEMBER },
    ]);
    await expect(task.harness.cloud.approveTask(TENANT_A, task.taskId, { approvalId: 'approval-1' })).resolves.toBeDefined();
    expect((await task.harness.cloud.readApprovalTimeline(TENANT_A, task.taskId))?.entries.map(({ event }) => event.type)).toEqual([
      'approval_requested', 'approval_resolved',
    ]);
  });
});

describe('every sealed offer lane freezes the output sealing that the gate reads (#654 E3b-2)', () => {
  const CONTEXT = { destinationBinding: 'conversation/654/turn/1' };
  const withContext = (payload: { messageEgress?: unknown }) => (payload.messageEgress === undefined ? {} : { agentMessageContext: CONTEXT });
  type Lane = (harness: CloudHarness, deviceId: string, taskId: string, payload: never) => Promise<unknown>;
  const lanes: Record<string, Lane> = {
    'task.offer_sealed': (h, d, taskId, payload) => h.cloud.enqueueSealedOffer(TENANT_A, d, { taskId, payload }),
    'task.offer_with_toolsets_sealed': (h, d, taskId, payload) => h.cloud.enqueueSealedToolsetOffer(TENANT_A, d, { taskId, payload }),
    'task.offer_for_agent_sealed': (h, d, taskId, payload) => h.cloud.enqueueSealedAgentOffer(TENANT_A, d, { taskId, payload }),
    'task.offer_for_agent_with_egress_sealed': (h, d, taskId, payload) =>
      h.cloud.enqueueSealedAgentEgressOffer(TENANT_A, d, { taskId, payload, ...withContext(payload) }),
    'task.offer_for_agent_with_egress_fresh_sealed': (h, d, taskId, payload) =>
      h.cloud.submitSealedAgentExecution(TENANT_A, { taskId, deviceId: d, payload, ...withContext(payload) }),
  };
  const outputOnly = Object.keys(lanes).map((type) => corpus.find((line) => line.type === type && line.payload.sealed === undefined
    && (type !== 'task.offer_for_agent_with_egress_fresh_sealed' || (line.payload as { terminalProjection?: unknown }).terminalProjection !== undefined))!);

  it.each(outputOnly.map((line) => [line.type, line] as const))('%s: a claimed task accepts a sealed completion', async (type, line) => {
    const payload = line.payload as { agentRef?: unknown; runtime?: string; harnessId?: string; sealing: { categories: string[] } };
    expect(payload.sealing.categories).toContain('task-output');
    const harness = createHarness({ agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: requiredReceiverCapabilities(type, payload) });
    const taskId = `sealed-lane-${type}`;
    await lanes[type]!(harness, device.deviceId, taskId, payload as never);
    const stores = tenantStoresFor(
      { kind: 'device', tenantId: TENANT_A as TenantId, productId: PRODUCT_ID, deviceId: device.deviceId },
      { core: harness.core, cloud: harness.stores, mailboxWake: harness.mailboxWake },
    );
    const send = (envelopeType: MessageType, body: object) =>
      handleInboundEnvelope(stores, device.deviceId, createEnvelope(envelopeType as Envelope['type'], body as never, { taskId }) as Envelope);
    const echo = {
      ...(payload.agentRef === undefined ? {} : { agentRef: payload.agentRef }),
      ...(payload.harnessId === undefined ? {} : { harnessId: payload.harnessId }),
    };
    expect(await send('task.claim', {
      deviceId: device.deviceId, ...(payload.runtime === undefined ? {} : { runtime: payload.runtime }), ...echo,
    })).toEqual({ outcome: 'accepted' });

    expect(await send('task.complete', { summary: 'plain', sessionRef: 'session-plain', ...echo })).toEqual(refused('sealed_output_required'));
    expect(await send('task.complete_sealed', { ...SEALED_OUTPUTS['task.complete_sealed'], ...echo })).toEqual({ outcome: 'accepted' });
    expect(await harness.cloud.readTaskAttempt(TENANT_A, taskId)).toMatchObject({ status: 'complete' });
  });
});

describe('a sealed terminal takes the gates of its plaintext type (#654 §8.5)', () => {
  it.each(['task.complete_sealed', 'task.fail_sealed', 'task.cancelled_sealed'] as const)(
    '%s with a harness the claim did not name is refused',
    async (type) => {
      const task = await offeredTask(OUTPUT_SEALING);
      expect(await task.send(type, { ...SEALED_OUTPUTS[type], harnessId: 'other-harness' })).toEqual(refused('terminal_harness_mismatch'));
      expect(await task.harness.cloud.readTaskAttempt(TENANT_A, task.taskId)).toMatchObject({ status: 'running' });
    },
  );

  it.each(['task.complete_sealed', 'task.fail_sealed', 'task.decline_sealed', 'task.cancelled_sealed'] as const)(
    '%s of an Agent task must echo the Agent identity',
    async (type) => {
      const task = await agentTask(type !== 'task.decline_sealed');
      expect(await task.send(type, SEALED_OUTPUTS[type])).toEqual(refused('agent_identity_mismatch'));
      expect(await task.send(type, { ...SEALED_OUTPUTS[type], agentRef: { ...AGENT_OFFER.agentRef, profileRevision: 'profile-other' } }))
        .toEqual(refused('agent_identity_mismatch'));
      expect(await task.send(type, { ...SEALED_OUTPUTS[type], agentRef: AGENT_OFFER.agentRef })).toEqual({ outcome: 'accepted' });
    },
  );

  it('task.fail_sealed with recovery is refused: an interruption is reported in plaintext (12d)', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    const recovery = { kind: 'daemon_interrupted', offerId: '00000000-0000-4000-8000-0000000000c1' };
    expect(await task.send('task.fail_sealed', { ...SEALED_OUTPUTS['task.fail_sealed'], recovery })).toEqual(refused('recovery_report_invalid'));
  });
});

describe('the output rule of the frozen sealing (#654 12d)', () => {
  const refusedPlain: readonly (readonly [string, MessageType, object])[] = [
    ['a completion', 'task.complete', { summary: 'done', sessionRef: 'session-plain' }],
    ['a failure with free text', 'task.fail', { reason: 'tool crashed', retryable: false }],
    ['a failure whose code has a suffix', 'task.fail', { reason: 'sealed_key_unavailable: no key', retryable: false }],
    ['a failure with a decline code', 'task.fail', { reason: 'sealed_open_failed', retryable: false }],
    ['a cancellation with a reason', 'task.cancelled', { reason: 'operator stopped it' }],
    ['a cancellation with the interruption code', 'task.cancelled', { reason: 'daemon_interrupted' }],
    ['progress', 'task.progress', { seq: 1, events: [{ type: 'text', text: 'working' }] }],
    ['an inline artifact', 'task.artifact', {
      artifactId: '00000000-0000-4000-8000-000000000601', name: 'a.txt', contentType: 'text/plain', inline: 'aGk',
    }],
    ['an approval request', 'task.await_approval', { approvalId: 'approval-2', summary: 'run rm?' }],
  ];

  it.each(refusedPlain)('refuses %s in plaintext, before the envelope identity is reserved', async (_name, type, payload) => {
    const task = await offeredTask(OUTPUT_SEALING);
    expect(await task.send(type, payload)).toEqual(refused('sealed_output_required'));
    expect(await task.send(type, payload)).toEqual(refused('sealed_output_required'));
    expect(await task.harness.cloud.readTaskAttempt(TENANT_A, task.taskId)).toMatchObject({ status: 'running' });
  });

  it('refuses a plaintext decline with free text', async () => {
    const task = await offeredTask(OUTPUT_SEALING, false);
    expect(await task.send('task.decline', { reason: 'busy', retryable: true })).toEqual(refused('sealed_output_required'));
  });

  it.each([
    ['task.fail', { reason: 'sealed_key_unavailable', retryable: false }, 'failed', 'sealed_key_unavailable'],
    ['task.cancelled', {}, 'cancelled', undefined],
  ] as const)('accepts %s with only a closed code, and keeps that code as the terminal cause', async (type, payload, status, cause) => {
    const task = await offeredTask(OUTPUT_SEALING);
    expect(await task.send(type, payload)).toEqual({ outcome: 'accepted' });
    const attempt = await task.harness.cloud.readTaskAttempt(TENANT_A, task.taskId);
    expect(attempt).toMatchObject({ status });
    expect(attempt?.terminalCause).toBe(cause);
  });

  it('accepts a plaintext decline with a sealed decline code', async () => {
    const task = await offeredTask(OUTPUT_SEALING, false);
    const payload = { code: 'sealed_open_failed', reason: 'sealed_open_failed', retryable: false };
    expect(await task.send('task.decline', payload)).toEqual({ outcome: 'accepted' });
    expect(await task.harness.cloud.readTaskAttempt(TENANT_A, task.taskId)).toMatchObject({
      status: 'failed', terminalCause: 'sealed_open_failed',
    });
  });

  it.each([['input sealing only', INPUT_SEALING], ['no sealing', undefined]] as const)(
    'a task with %s refuses every sealed output, and accepts plaintext output',
    async (_name, sealing) => {
      for (const type of Object.keys(SEALED_OUTPUTS) as SealedOutputType[]) {
        const task = await offeredTask(sealing, type !== 'task.decline_sealed');
        expect(await task.send(type, SEALED_OUTPUTS[type]), type).toEqual(refused('sealed_payload_unsupported'));
      }
      const task = await offeredTask(sealing);
      expect(await task.send('task.complete', { summary: 'done', sessionRef: 'session-plain' })).toEqual({ outcome: 'accepted' });
      expect(await task.harness.cloud.readTaskResult(TENANT_A, task.taskId)).toMatchObject({ state: 'complete', summary: 'done' });
    },
  );
});
