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
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { ContentHash, TenantId } from '@byok-sdk/core';
import { sealContent, type SealedContent } from '@byok-sdk/core/sealed-payload';
import {
  createEnvelope,
  requiredReceiverCapabilities,
  type Envelope,
  type MessageType,
  type SealableMessageType,
} from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import type { AgentMessageConsumers } from '../agent-message-disposition';
import { handleInboundEnvelope, terminalReceiptKey } from '../inbound';
import { hashOfferBytes, taskOfferMessageId } from '../offer-identity';
import { taskRedactionReceiptKey } from '../task-redaction';
import { tenantStoresFor } from '../tenant-stores';
import { PRODUCT_ID, TENANT_A, TEST_AGENT_REF, createHarness, offerPayload, type CloudHarness, type PairedDevice } from './support/harness';
import {
  BY_REFERENCE_TEXT_LENGTH,
  SEALING,
  inlineMember,
  referenceMember,
  uploadCiphertext,
  type CiphertextRef,
} from './support/sealed';

const corpus = readFileSync(new URL('../../../protocol/src/__tests__/golden/v4.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as {
    type: MessageType;
    payload: { sealed?: object; sealing?: object; session?: { mode?: string }; egressPolicy?: object };
  });

/** A schema-valid `task-output` sealed member from the corpus. The Host reads only its outer fields. */
const OUTPUT_MEMBER = corpus.find((line) => line.type === 'task.complete' && line.payload.sealed !== undefined)!.payload.sealed!;
/** A `task-output` member above the inline limit, which names its ciphertext blob. */
const BY_REFERENCE_MEMBER = corpus.find((line) => line.type === 'task.complete' && line.payload.sealed !== undefined
  && (line.payload.sealed as { ciphertextRef?: unknown }).ciphertextRef !== undefined)!.payload.sealed!;

/** The sealed branch of each sealable output type, with no Agent, harness or recovery binding. */
const SEALED_OUTPUTS = {
  'task.complete': { sessionRef: 'session-sealed', sealed: OUTPUT_MEMBER },
  'task.fail': { retryable: false, sealed: OUTPUT_MEMBER },
  'task.decline': { retryable: false, sealed: OUTPUT_MEMBER },
  'task.cancelled': { sealed: OUTPUT_MEMBER },
  'task.artifact': {
    artifactId: '00000000-0000-4000-8000-000000000600', name: 'patch.diff', contentType: 'text/x-diff', sealed: OUTPUT_MEMBER,
  },
  'task.progress': { seq: 1, sealed: OUTPUT_MEMBER },
  'task.await_approval': { approvalId: 'approval-1', sealed: OUTPUT_MEMBER },
} as const;
type SealedOutputType = keyof typeof SEALED_OUTPUTS;

const OUTPUT_SEALING = SEALING;
const INPUT_SEALING = { ...SEALING, categories: ['task-input'] } as const;

interface Task {
  readonly harness: CloudHarness;
  readonly device: PairedDevice;
  readonly taskId: string;
  /** The offer's ciphertext blob, when the offer names one. */
  readonly offerRef?: CiphertextRef;
  send(type: MessageType, payload: object): ReturnType<typeof handleInboundEnvelope>;
}

let taskCount = 0;

const SCOPE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

/**
 * One `task-input` member of `type` for a task of {@link TEST_AGENT_REF},
 * sealed now. `sealInput` binds no Agent; a member of an Agent task binds the
 * Agent of the task's offer.
 */
async function sealAgentInput(
  deviceId: string,
  type: SealableMessageType,
  identity: Readonly<Record<string, string>>,
  plaintext: Readonly<Record<string, string>>,
): Promise<SealedContent> {
  return sealContent({
    scopeKey: SCOPE_KEY,
    scope: { id: SEALING.scopeId, epoch: SEALING.epoch },
    chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` },
    sender: 'A'.repeat(43),
    category: 'task-input',
    binding: {
      tenantId: TENANT_A,
      family: type,
      direction: 'server-to-daemon',
      identity,
      deviceId,
      agentRef: { ...TEST_AGENT_REF },
      categories: [...SEALING.categories],
      notAfter: null,
    },
    plaintext,
    maxContentLength: 2 * 1024 * 1024,
  });
}

/** The types whose report echoes the task's Agent, as a v4 daemon's does. */
const ECHOES_AGENT: readonly MessageType[] = [
  'task.claim', 'task.decline', 'task.complete', 'task.fail', 'task.cancelled',
];

/**
 * An Agent task of {@link TEST_AGENT_REF} offered to a sealed-capable device,
 * with `sealing` (or none), claimed unless told not to. A sealed offer names
 * its ciphertext blob when told to. Its `send` echoes the Agent on a claim or
 * terminal that names none.
 */
async function offeredTask(
  sealing: typeof OUTPUT_SEALING | typeof INPUT_SEALING | undefined,
  claim = true,
  offerByReference = false,
): Promise<Task> {
  const harness = createHarness();
  const device = await harness.pairDevice(TENANT_A);
  const resume = { agentRef: TEST_AGENT_REF, session: offerPayload().session, runtime: 'pi' as const };
  const capabilities = requiredReceiverCapabilities('task.offer', { ...resume, sealing: OUTPUT_SEALING, sealed: {} });
  await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities });
  taskCount += 1;
  const taskId = `sealed-output-${taskCount}`;
  let offerRef: CiphertextRef | undefined;
  if (sealing === undefined) {
    await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { taskId, payload: { ...offerPayload('plain'), runtime: 'pi' } });
  } else {
    const content = await sealAgentInput(device.deviceId, 'task.offer', { taskId }, {
      instruction: offerByReference ? 'x'.repeat(BY_REFERENCE_TEXT_LENGTH) : 'sealed',
    });
    if (offerByReference) offerRef = await uploadCiphertext(harness, device, content.ciphertext);
    await harness.cloud.enqueueSealedAgentOffer(TENANT_A, device.deviceId, {
      taskId,
      payload: { ...resume, sealing, sealed: offerRef === undefined ? inlineMember(content) : referenceMember(content, offerRef) } as never,
    });
  }
  const stores = tenantStoresFor(
    { kind: 'device', tenantId: TENANT_A as TenantId, productId: PRODUCT_ID, deviceId: device.deviceId },
    { core: harness.core, cloud: harness.stores, mailboxWake: harness.mailboxWake },
  );
  const send = (type: MessageType, payload: object) => {
    const echoed = ECHOES_AGENT.includes(type) ? { agentRef: TEST_AGENT_REF, ...payload } : payload;
    return handleInboundEnvelope(stores, device.deviceId, createEnvelope(type as Envelope['type'], echoed as never, { taskId }) as Envelope);
  };
  if (claim) {
    expect(await send('task.claim', { deviceId: device.deviceId, runtime: 'pi' })).toEqual({ outcome: 'accepted' });
    expect(await send('task.started', {})).toEqual({ outcome: 'accepted' });
  }
  return { harness, device, taskId, ...(offerRef === undefined ? {} : { offerRef }), send };
}

/** An output-only sealed Agent offer from the corpus. */
const AGENT_OFFER = corpus.find((line) => line.type === 'task.offer' && line.payload.sealing !== undefined && line.payload.sealed === undefined
  && line.payload.session?.mode === 'resume' && line.payload.egressPolicy === undefined)!
  .payload as unknown as { agentRef: { agentId: string; profileRevision: string }; runtime: string; sealing: { categories: string[] } };

/** An Agent task whose offer seals its output, claimed unless told not to. */
async function agentTask(claim: boolean): Promise<Task> {
  const harness = createHarness();
  const device = await harness.pairDevice(TENANT_A);
  const capabilities = requiredReceiverCapabilities('task.offer', AGENT_OFFER);
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
    ['task.complete', 'complete', undefined, { state: 'complete', sessionRef: 'session-sealed' }],
    ['task.fail', 'failed', undefined, { state: 'failed', retryable: false }],
    ['task.cancelled', 'cancelled', undefined, { state: 'cancelled' }],
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
      taskId: task.taskId, ...result, agentRef: TEST_AGENT_REF, recordedAt: expect.any(String),
    });
  });

  it('a sealed task.decline keeps only its closed home code as the terminal cause', async () => {
    const task = await offeredTask(OUTPUT_SEALING, false);
    const payload = { ...SEALED_OUTPUTS['task.decline'], code: 'agent_home_writer_busy' };
    expect(await task.send('task.decline', payload)).toEqual({ outcome: 'accepted' });

    expect(await task.harness.cloud.readTaskAttempt(TENANT_A, task.taskId)).toMatchObject({
      status: 'failed', terminalCause: 'agent_home_writer_busy',
    });
    expect(await task.harness.cloud.readTaskResult(TENANT_A, task.taskId)).toEqual({
      taskId: task.taskId, state: 'failed', code: 'agent_home_writer_busy', terminalCause: 'agent_home_writer_busy', retryable: false,
      agentRef: TEST_AGENT_REF, recordedAt: expect.any(String),
    });
  });

  it('a later terminal does not replace the first one', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    expect(await task.send('task.complete', SEALED_OUTPUTS['task.complete'])).toEqual({ outcome: 'accepted' });
    expect(await task.send('task.fail', SEALED_OUTPUTS['task.fail'])).toEqual({ outcome: 'accepted' });
    expect((await task.harness.cloud.readDeviceTerminal(TENANT_A, task.taskId))?.envelope.type).toBe('task.complete');
  });

  it('accepts a sealed artifact and stores nothing for it', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    expect(await task.send('task.artifact', SEALED_OUTPUTS['task.artifact'])).toEqual({ outcome: 'accepted' });
    expect(await task.harness.cloud.readTaskAttempt(TENANT_A, task.taskId)).toMatchObject({ status: 'running' });
  });

  it('pairs a device approval resolution with a sealed approval request', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    expect(await task.send('task.await_approval', SEALED_OUTPUTS['task.await_approval'])).toEqual({ outcome: 'accepted' });
    expect(await task.send('task.approval_resolved', { approvalId: 'approval-1', decision: 'reject', resolvedBy: 'local', at: '2026-10-24T00:00:00.000Z' }))
      .toEqual({ outcome: 'accepted' });
    expect((await task.harness.cloud.readApprovalTimeline(TENANT_A, task.taskId))?.entries.map(({ event }) => event)).toEqual([
      { type: 'approval_requested', approvalId: 'approval-1', sealed: OUTPUT_MEMBER },
      { type: 'approval_resolved', approvalId: 'approval-1', decision: 'reject', resolvedBy: 'local', at: '2026-10-24T00:00:00.000Z' },
    ]);
  });

  it('stores nothing for a late sealed progress or approval report on a redacted task', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    expect(await task.send('task.complete', SEALED_OUTPUTS['task.complete'])).toEqual({ outcome: 'accepted' });
    await task.harness.stores.receipts.record(TENANT_A, { key: taskRedactionReceiptKey(task.taskId), body: '{}' });
    // The terminal closed the task's output (#1113 A3): late progress and approvals are refused, redacted or not.
    expect(await task.send('task.progress', SEALED_OUTPUTS['task.progress'])).toEqual({ outcome: 'rejected', reason: 'task_settled_by_cloud' });
    expect(await task.send('task.await_approval', SEALED_OUTPUTS['task.await_approval'])).toEqual({ outcome: 'rejected', reason: 'task_settled_by_cloud' });
    expect((await task.harness.cloud.readActivity(TENANT_A, task.taskId))?.entries).toEqual([]);
    expect((await task.harness.cloud.readApprovalTimeline(TENANT_A, task.taskId))?.entries).toEqual([]);
  });

  it.each(['task.progress', 'task.await_approval'] as const)(
    'refuses %s by ciphertextRef, because its tail row expires (12e), before the envelope identity is reserved',
    async (type) => {
      const task = await offeredTask(OUTPUT_SEALING);
      const payload = { ...SEALED_OUTPUTS[type], sealed: BY_REFERENCE_MEMBER };
      expect(await task.send(type, payload)).toEqual(refused('sealed_payload_unsupported'));
      expect(await task.send(type, payload)).toEqual(refused('sealed_payload_unsupported'));
      expect(await task.harness.cloud.readDeviceTerminal(TENANT_A, task.taskId)).toBeUndefined();
    },
  );

  it('keeps sealed artifacts outside the activity log until #1045 item 6', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    expect(await task.send('task.artifact', SEALED_OUTPUTS['task.artifact'])).toEqual({ outcome: 'accepted' });
    expect(await task.harness.cloud.readActivity(TENANT_A, task.taskId)).toBeUndefined();
  });

  it('stores each sealed progress batch as one activity entry (12e)', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    expect(await task.send('task.progress', SEALED_OUTPUTS['task.progress'])).toEqual({ outcome: 'accepted' });
    expect(await task.send('task.progress', { ...SEALED_OUTPUTS['task.progress'], seq: 2 })).toEqual({ outcome: 'accepted' });
    const tail = await task.harness.cloud.readActivity(TENANT_A, task.taskId);
    expect(tail?.entries).toEqual([1, 2].map((batchSeq) => ({
      taskId: task.taskId,
      sourceEnvelopeId: expect.any(String),
      batchSeq,
      kind: 'sealed-progress',
      revision: batchSeq,
      sourceDropped: 0,
      receivedAt: expect.any(String),
      sealed: OUTPUT_MEMBER,
    })));
    expect(tail?.cursor).toMatchObject({ version: 1, revision: 2 });
  });

  it('stores a sealed approval request, which the Host approves while it is pending (12e)', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    expect(await task.send('task.await_approval', SEALED_OUTPUTS['task.await_approval'])).toEqual({ outcome: 'accepted' });
    expect((await task.harness.cloud.readApprovalTimeline(TENANT_A, task.taskId))?.entries.map(({ event }) => event)).toEqual([
      { type: 'approval_requested', approvalId: 'approval-1', sealed: OUTPUT_MEMBER },
    ]);
    await expect(task.harness.cloud.approveTask(TENANT_A, task.taskId, { approvalId: 'approval-1' })).resolves.toBeDefined();
    expect((await task.harness.cloud.readApprovalTimeline(TENANT_A, task.taskId))?.entries.map(({ event }) => event.type)).toEqual([
      'approval_requested', 'approval_resolved',
    ]);
  });
});

describe('a sealed terminal or artifact by ciphertextRef (#654 §58a)', () => {
  const BY_REFERENCE = ['task.complete', 'task.fail', 'task.decline', 'task.cancelled', 'task.artifact'] as const;
  const REFERENCE_SIZE = (BY_REFERENCE_MEMBER as { ciphertextRef: { size: number } }).ciphertextRef.size;

  /** Uploads ciphertext bytes of the corpus member's size. The Host checks the object, not the bytes. */
  async function uploaded(task: Task): Promise<{ member: object; ref: CiphertextRef }> {
    const ref = await uploadCiphertext(task.harness, task.device, randomBytes(REFERENCE_SIZE));
    return { member: { ...BY_REFERENCE_MEMBER, ciphertextRef: ref }, ref };
  }

  async function refCount(task: Task, ref: CiphertextRef): Promise<number | undefined> {
    return (await task.harness.core.objects.get(TENANT_A, ref.contentHash as ContentHash))?.refCount;
  }

  it.each(BY_REFERENCE)('accepts %s naming a committed blob, and the task holds one reference to it', async (type) => {
    const task = await offeredTask(OUTPUT_SEALING, type !== 'task.decline');
    const { member, ref } = await uploaded(task);
    expect(await refCount(task, ref)).toBe(0);

    expect(await task.send(type, { ...SEALED_OUTPUTS[type], sealed: member })).toEqual({ outcome: 'accepted' });
    expect(await refCount(task, ref)).toBe(1);
    if (type !== 'task.artifact') {
      expect((await task.harness.cloud.readDeviceTerminal(TENANT_A, task.taskId))?.envelope.payload).toMatchObject({ sealed: { ciphertextRef: ref } });
    }
    // A resend of the same sealed bytes under a new envelope id holds no second reference.
    expect(await task.send(type, { ...SEALED_OUTPUTS[type], sealed: member })).toEqual({ outcome: 'accepted' });
    expect(await refCount(task, ref)).toBe(1);
  });

  it.each(BY_REFERENCE)('refuses %s naming a blob that does not exist, and records no terminal', async (type) => {
    const task = await offeredTask(OUTPUT_SEALING, type !== 'task.decline');
    const payload = { ...SEALED_OUTPUTS[type], sealed: BY_REFERENCE_MEMBER };
    expect(await task.send(type, payload)).toEqual(refused('sealed_ciphertext_invalid'));
    expect(await task.send(type, payload)).toEqual(refused('sealed_ciphertext_invalid'));
    expect(await task.harness.cloud.readDeviceTerminal(TENANT_A, task.taskId)).toBeUndefined();
  });

  const mismatches: readonly (readonly [string, (task: Task) => Promise<{ uploaded: CiphertextRef; declared: CiphertextRef }>])[] = [
    ['a blob that is not finalized', async (task) => {
      const uploaded = await uploadCiphertext(task.harness, task.device, randomBytes(REFERENCE_SIZE), { finalize: false });
      return { uploaded, declared: uploaded };
    }],
    ['a blob whose size is not the declared size', async (task) => {
      const uploaded = await uploadCiphertext(task.harness, task.device, randomBytes(REFERENCE_SIZE - 1));
      return { uploaded, declared: { ...uploaded, size: REFERENCE_SIZE } };
    }],
    ['a blob whose content type is not the declared type', async (task) => {
      const uploaded = await uploadCiphertext(task.harness, task.device, randomBytes(REFERENCE_SIZE), { contentType: 'text/plain' });
      return { uploaded, declared: { ...uploaded, contentType: 'application/octet-stream' } };
    }],
  ];

  it.each(mismatches)('refuses %s, and holds no reference to it', async (_name, prepare) => {
    const task = await offeredTask(OUTPUT_SEALING);
    const { uploaded, declared } = await prepare(task);
    const member = { ...BY_REFERENCE_MEMBER, ciphertextRef: declared };
    expect(await task.send('task.complete', { ...SEALED_OUTPUTS['task.complete'], sealed: member }))
      .toEqual(refused('sealed_ciphertext_invalid'));
    expect(await refCount(task, uploaded)).toBe(0);
    expect(await task.harness.cloud.readDeviceTerminal(TENANT_A, task.taskId)).toBeUndefined();
  });

  it('a later terminal with another blob does not replace the first, and holds no reference to its blob', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    const first = await uploaded(task);
    const later = await uploaded(task);
    expect(await task.send('task.complete', { ...SEALED_OUTPUTS['task.complete'], sealed: first.member })).toEqual({ outcome: 'accepted' });
    expect(await task.send('task.fail', { ...SEALED_OUTPUTS['task.fail'], sealed: later.member })).toEqual({ outcome: 'accepted' });

    expect((await task.harness.cloud.readDeviceTerminal(TENANT_A, task.taskId))?.envelope.type).toBe('task.complete');
    expect(await refCount(task, first.ref)).toBe(1);
    expect(await refCount(task, later.ref)).toBe(0);
  });

  /** A losing terminal that names `ref`, with the padded length its size fixes. */
  function terminalNaming(ref: CiphertextRef): object {
    return { ...SEALED_OUTPUTS['task.fail'], sealed: { ...BY_REFERENCE_MEMBER, ciphertextRef: ref, paddedLength: ref.size - 16 } };
  }

  it('a losing terminal that names the offer blob leaves the offer reference in place', async () => {
    const task = await offeredTask(OUTPUT_SEALING, true, true);
    const offerRef = task.offerRef!;
    expect(await refCount(task, offerRef)).toBe(1);
    expect(await task.send('task.complete', SEALED_OUTPUTS['task.complete'])).toEqual({ outcome: 'accepted' });

    expect(await task.send('task.fail', terminalNaming(offerRef))).toEqual({ outcome: 'accepted' });
    expect((await task.harness.cloud.readDeviceTerminal(TENANT_A, task.taskId))?.envelope.type).toBe('task.complete');
    expect(await refCount(task, offerRef)).toBe(1);
  });

  it('a losing terminal that names a steer blob leaves the steer reference in place', async () => {
    const task = await offeredTask(OUTPUT_SEALING, false);
    expect(await task.send('task.claim', { deviceId: task.device.deviceId, runtime: 'pi', capabilities: { steer: true } }))
      .toEqual({ outcome: 'accepted' });
    expect(await task.send('task.started', {})).toEqual({ outcome: 'accepted' });
    const steerId = '00000000-0000-4000-8000-000000000601';
    const content = await sealAgentInput(task.device.deviceId, 'task.steer', { taskId: task.taskId, steerId }, {
      text: 'x'.repeat(BY_REFERENCE_TEXT_LENGTH),
    });
    const steerRef = await uploadCiphertext(task.harness, task.device, content.ciphertext);
    await task.harness.cloud.steerSealedTask(TENANT_A, task.taskId, { steerId, sealed: referenceMember(content, steerRef) });
    expect(await refCount(task, steerRef)).toBe(1);
    expect(await task.send('task.complete', SEALED_OUTPUTS['task.complete'])).toEqual({ outcome: 'accepted' });

    expect(await task.send('task.fail', terminalNaming(steerRef))).toEqual({ outcome: 'accepted' });
    expect(await refCount(task, steerRef)).toBe(1);
  });

  it('a terminal after redaction holds no reference to its blob', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    await task.harness.stores.receipts.record(TENANT_A, { key: terminalReceiptKey(task.taskId), body: JSON.stringify({ byokRedacted: 1, absent: true }) });
    const { member, ref } = await uploaded(task);
    expect(await task.send('task.complete', { ...SEALED_OUTPUTS['task.complete'], sealed: member })).toEqual({ outcome: 'accepted' });
    expect(await refCount(task, ref)).toBe(0);
  });

  it('a terminal after redaction releases its reference to a blob that another holder keeps', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    const { member, ref } = await uploaded(task);
    await task.harness.core.objects.addReference(TENANT_A, { hash: ref.contentHash as ContentHash, refKind: 'test', refId: 'other' });
    await task.harness.stores.receipts.record(TENANT_A, { key: terminalReceiptKey(task.taskId), body: JSON.stringify({ byokRedacted: 1, absent: true }) });
    expect(await task.send('task.complete', { ...SEALED_OUTPUTS['task.complete'], sealed: member })).toEqual({ outcome: 'accepted' });
    expect(await refCount(task, ref)).toBe(1);
  });

  it('settles a replayed terminal on a redacted task after redaction deleted its blob', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    const { member, ref } = await uploaded(task);
    const payload = { ...SEALED_OUTPUTS['task.complete'], sealed: member };
    expect(await task.send('task.complete', payload)).toEqual({ outcome: 'accepted' });
    // What redaction leaves: the reference released, the blob deleted, the receipts tombstoned.
    const hash = ref.contentHash as ContentHash;
    await task.harness.core.objects.removeReference(TENANT_A, { hash, refKind: 'sealed-task', refId: task.taskId });
    await task.harness.core.objects.markDeletePending(TENANT_A, hash);
    await task.harness.core.objects.markDeleted(TENANT_A, hash);
    await task.harness.stores.receipts.record(TENANT_A, { key: taskRedactionReceiptKey(task.taskId), body: '{}' });

    expect(await task.send('task.complete', payload)).toEqual({ outcome: 'accepted' });
    expect(await refCount(task, ref)).toBe(0);
  });

  it('an artifact that arrives once its task is terminal holds no reference to its blob', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    expect(await task.send('task.complete', SEALED_OUTPUTS['task.complete'])).toEqual({ outcome: 'accepted' });
    const { member, ref } = await uploaded(task);
    expect(await task.send('task.artifact', { ...SEALED_OUTPUTS['task.artifact'], sealed: member })).toEqual({ outcome: 'accepted' });
    expect(await refCount(task, ref)).toBe(0);
  });

  it('a replay of an artifact once its task is terminal keeps the reference of its earlier delivery', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    const { member, ref } = await uploaded(task);
    const payload = { ...SEALED_OUTPUTS['task.artifact'], sealed: member };
    expect(await task.send('task.artifact', payload)).toEqual({ outcome: 'accepted' });
    expect(await task.send('task.complete', SEALED_OUTPUTS['task.complete'])).toEqual({ outcome: 'accepted' });

    expect(await task.send('task.artifact', payload)).toEqual({ outcome: 'accepted' });
    expect(await refCount(task, ref)).toBe(1);
  });

  it('an artifact whose task is redacted while it retains its blob holds no reference to it', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    const { member, ref } = await uploaded(task);
    // The task completes and is redacted between the artifact's status read and its retain.
    const objects = task.harness.core.objects;
    const addReference = objects.addReference.bind(objects);
    objects.addReference = async (tenant, input) => {
      const added = await addReference(tenant, input);
      expect(await task.send('task.complete', SEALED_OUTPUTS['task.complete'])).toEqual({ outcome: 'accepted' });
      await task.harness.stores.receipts.record(TENANT_A, { key: taskRedactionReceiptKey(task.taskId), body: '{}' });
      return added;
    };
    expect(await task.send('task.artifact', { ...SEALED_OUTPUTS['task.artifact'], sealed: member })).toEqual({ outcome: 'accepted' });
    expect(await refCount(task, ref)).toBe(0);
  });

  it('a late artifact on a redacted task holds no reference to its blob', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    expect(await task.send('task.complete', SEALED_OUTPUTS['task.complete'])).toEqual({ outcome: 'accepted' });
    await task.harness.stores.receipts.record(TENANT_A, { key: taskRedactionReceiptKey(task.taskId), body: '{}' });
    const { member, ref } = await uploaded(task);
    expect(await task.send('task.artifact', { ...SEALED_OUTPUTS['task.artifact'], sealed: member })).toEqual({ outcome: 'accepted' });
    expect(await refCount(task, ref)).toBe(0);
  });
});

describe('every sealed offer lane freezes the output sealing that the gate reads (#654 E3b-2)', () => {
  const CONTEXT = { destinationBinding: 'conversation/654/turn/1' };
  const withContext = (payload: { messageEgress?: unknown }) => (payload.messageEgress === undefined ? {} : { agentMessageContext: CONTEXT });
  type Lane = (harness: CloudHarness, deviceId: string, taskId: string, payload: never) => Promise<unknown>;
  type Variant = 'sealed resume' | 'sealed egress' | 'sealed execution';
  const variantOf = (payload: { session?: { mode?: string }; egressPolicy?: object }): Variant => (
    payload.session?.mode === 'fresh' ? 'sealed execution' : payload.egressPolicy === undefined ? 'sealed resume' : 'sealed egress');
  const lanes: Record<Variant, Lane> = {
    'sealed resume': (h, d, taskId, payload) => h.cloud.enqueueSealedAgentOffer(TENANT_A, d, { taskId, payload }),
    'sealed egress': (h, d, taskId, payload) =>
      h.cloud.enqueueSealedAgentEgressOffer(TENANT_A, d, { taskId, payload, ...withContext(payload) }),
    'sealed execution': (h, d, taskId, payload) =>
      h.cloud.submitSealedAgentExecution(TENANT_A, { taskId, deviceId: d, payload, ...withContext(payload) }),
  };
  const outputOnly = (Object.keys(lanes) as Variant[]).map((variant) => ({
    variant,
    line: corpus.find((line) => line.type === 'task.offer' && line.payload.sealing !== undefined && line.payload.sealed === undefined
      && variantOf(line.payload) === variant
      && (variant !== 'sealed execution' || (line.payload as { terminalProjection?: unknown }).terminalProjection !== undefined))!,
  }));

  it.each(outputOnly.map(({ variant, line }) => [variant, line] as const))('%s: a claimed task accepts a sealed completion', async (variant, line) => {
    const payload = line.payload as { agentRef?: unknown; runtime?: string; harnessId?: string; sealing: { categories: string[] } };
    expect(payload.sealing.categories).toContain('task-output');
    const harness = createHarness({ agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: requiredReceiverCapabilities('task.offer', payload) });
    const taskId = `sealed-lane-${variant.replace(' ', '-')}`;
    await lanes[variant](harness, device.deviceId, taskId, payload as never);
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
    expect(await send('task.complete', { ...SEALED_OUTPUTS['task.complete'], ...echo })).toEqual({ outcome: 'accepted' });
    expect(await harness.cloud.readTaskAttempt(TENANT_A, taskId)).toMatchObject({ status: 'complete' });
  });
});

describe('a sealed terminal takes the gates of its type (#654 §8.5)', () => {
  it.each(['task.complete', 'task.fail', 'task.cancelled'] as const)(
    '%s with a harness the claim did not name is refused',
    async (type) => {
      const task = await offeredTask(OUTPUT_SEALING);
      expect(await task.send(type, { ...SEALED_OUTPUTS[type], harnessId: 'other-harness' })).toEqual(refused('terminal_harness_mismatch'));
      expect(await task.harness.cloud.readTaskAttempt(TENANT_A, task.taskId)).toMatchObject({ status: 'running' });
    },
  );

  it.each(['task.complete', 'task.fail', 'task.decline', 'task.cancelled'] as const)(
    '%s of an Agent task must echo the Agent identity',
    async (type) => {
      const task = await agentTask(type !== 'task.decline');
      expect(await task.send(type, SEALED_OUTPUTS[type])).toEqual(refused('agent_identity_mismatch'));
      expect(await task.send(type, { ...SEALED_OUTPUTS[type], agentRef: { ...AGENT_OFFER.agentRef, profileRevision: 'profile-other' } }))
        .toEqual(refused('agent_identity_mismatch'));
      expect(await task.send(type, { ...SEALED_OUTPUTS[type], agentRef: AGENT_OFFER.agentRef })).toEqual({ outcome: 'accepted' });
    },
  );

  it('a sealed task.fail with recovery is refused: an interruption is reported in plaintext (12d)', async () => {
    const task = await offeredTask(OUTPUT_SEALING);
    const recovery = { kind: 'daemon_interrupted', offerId: '00000000-0000-4000-8000-0000000000c1' };
    expect(await task.send('task.fail', { ...SEALED_OUTPUTS['task.fail'], recovery })).toEqual(refused('recovery_report_invalid'));
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
    ['an artifact with no content', 'task.artifact', {
      artifactId: '00000000-0000-4000-8000-000000000602', name: 'a.txt', contentType: 'text/plain',
    }],
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

  it.each([['claimed', true], ['unclaimed', false]] as const)(
    'accepts a %s interruption in plaintext with recovery, and keeps daemon_interrupted as the terminal cause',
    async (_name, claim) => {
      const task = await offeredTask(OUTPUT_SEALING, claim);
      const offerId = await taskOfferMessageId(TENANT_A, task.taskId, task.device.deviceId, TEST_AGENT_REF, hashOfferBytes);
      const payload = { reason: 'daemon_interrupted', retryable: false, recovery: { kind: 'daemon_interrupted', offerId } };
      expect(await task.send('task.fail', payload)).toEqual({ outcome: 'accepted' });
      expect(await task.harness.cloud.readTaskAttempt(TENANT_A, task.taskId)).toMatchObject({
        status: 'failed', terminalCause: 'daemon_interrupted',
      });
    },
  );

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
        const task = await offeredTask(sealing, type !== 'task.decline');
        expect(await task.send(type, SEALED_OUTPUTS[type]), type).toEqual(refused('sealed_payload_unsupported'));
      }
      const task = await offeredTask(sealing);
      expect(await task.send('task.complete', { summary: 'done', sessionRef: 'session-plain' })).toEqual({ outcome: 'accepted' });
      expect(await task.harness.cloud.readTaskResult(TENANT_A, task.taskId)).toMatchObject({ state: 'complete', summary: 'done' });
    },
  );
});

describe('the sealed Agent message of a task that seals it (#1045 S3)', () => {
  /** The corpus Agent egress offer whose sealing names `agent-message`, with the message limit `maxBytes`. */
  const messageOffer = (maxBytes: number) => {
    const line = corpus.find((entry) => entry.type === 'task.offer'
      && (entry.payload.sealing as { categories?: string[] } | undefined)?.categories?.includes('agent-message'))!;
    const payload = line.payload as { messageEgress: object; agentRef: object; runtime: string };
    return { ...payload, messageEgress: { ...payload.messageEgress, maxBytes } };
  };
  const SEALED_MESSAGE = corpus.find((line) => line.type === 'agent.message.publish' && line.payload.sealed !== undefined)!
    .payload as { agentRef: object; sealed: { contentMac: string } } & Record<string, unknown>;
  const { sealed: _sealed, ...MESSAGE_FIELDS } = SEALED_MESSAGE;
  const PLAIN_MESSAGE = {
    ...MESSAGE_FIELDS, body: 'hello', byteCount: 5,
    contentHash: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  };

  async function messageTask(consumers: AgentMessageConsumers, maxBytes = 262144) {
    const harness = createHarness({ agentMessage: consumers });
    const device = await harness.pairDevice(TENANT_A);
    const payload = messageOffer(maxBytes);
    const capabilities = [...requiredReceiverCapabilities('task.offer', payload), 'agent-message-egress'];
    await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities });
    taskCount += 1;
    const taskId = `sealed-message-${taskCount}`;
    const enqueue = () => harness.cloud.enqueueSealedAgentEgressOffer(TENANT_A, device.deviceId, {
      taskId, payload: payload as never, agentMessageContext: { destinationBinding: 'conversation/1045/turn/1' },
    });
    const stores = tenantStoresFor(
      { kind: 'device', tenantId: TENANT_A as TenantId, productId: PRODUCT_ID, deviceId: device.deviceId },
      { core: harness.core, cloud: harness.stores, mailboxWake: harness.mailboxWake },
    );
    const publish = (message: object) => handleInboundEnvelope(stores, device.deviceId,
      createEnvelope('agent.message.publish', message as never, { taskId }) as Envelope, undefined, consumers);
    const claim = async () => {
      await enqueue();
      expect(await handleInboundEnvelope(stores, device.deviceId, createEnvelope('task.claim', {
        deviceId: device.deviceId, runtime: payload.runtime, agentRef: payload.agentRef,
      } as never, { taskId }) as Envelope)).toEqual({ outcome: 'accepted' });
    };
    return { harness, device, taskId, enqueue, claim, publish };
  }

  it('refuses the submission before any write while the cloud has no consumeSealed', async () => {
    const task = await messageTask({ consume: async () => ({ outcome: 'accepted' }) });
    await expect(task.enqueue()).rejects.toMatchObject({ code: 'agent_message_sealed_consumer_missing' });
    expect(await task.harness.cloud.readTaskAttempt(TENANT_A, task.taskId)).toBeUndefined();
  });

  it('gives the sealed message to consumeSealed alone, refuses its plaintext form, and reads it back by contentMac', async () => {
    const consumed: string[] = [];
    const task = await messageTask({
      consume: async () => { consumed.push('plain'); return { outcome: 'accepted' }; },
      consumeSealed: async ({ payload }) => { consumed.push(payload.sealed.contentMac); return { outcome: 'accepted' }; },
    });
    await task.claim();
    expect(await task.publish(PLAIN_MESSAGE)).toEqual(refused('sealed_output_required'));
    expect(await task.publish(SEALED_MESSAGE)).toEqual({ outcome: 'accepted' });
    // The device retries the same sealed bytes under a new envelope id: no second decision.
    expect(await task.publish(SEALED_MESSAGE)).toEqual({ outcome: 'accepted' });
    expect(consumed).toEqual([SEALED_MESSAGE.sealed.contentMac]);

    const disposition = await task.harness.cloud.readAgentMessageDisposition(TENANT_A, task.device.deviceId, task.taskId, SEALED_MESSAGE as never);
    expect(disposition).toMatchObject({ outcome: 'accepted', contentMac: SEALED_MESSAGE.sealed.contentMac });
    expect(disposition).not.toHaveProperty('contentHash');
    expect(await task.harness.cloud.readTaskAgentMessage(TENANT_A, task.device.deviceId, task.taskId, SEALED_MESSAGE.agentRef as never))
      .toMatchObject({ payload: SEALED_MESSAGE, disposition });
  });

  it('admits a by-reference sealed message only for its committed blob, which the task then holds', async () => {
    const task = await messageTask({ consumeSealed: async () => ({ outcome: 'accepted' }) });
    await task.claim();
    const size = (BY_REFERENCE_MEMBER as { ciphertextRef: { size: number } }).ciphertextRef.size;
    const member = { ...BY_REFERENCE_MEMBER, category: 'agent-message' };
    expect(await task.publish({ ...MESSAGE_FIELDS, sealed: member })).toEqual(refused('sealed_ciphertext_invalid'));

    const ref = await uploadCiphertext(task.harness, task.device, randomBytes(size));
    expect(await task.publish({ ...MESSAGE_FIELDS, sealed: { ...member, ciphertextRef: ref } })).toEqual({ outcome: 'accepted' });
    expect((await task.harness.core.objects.get(TENANT_A, ref.contentHash as ContentHash))?.refCount).toBe(1);
  });

  it('refuses a sealed message above the padded length its frozen byte limit allows', async () => {
    const task = await messageTask({ consumeSealed: async () => ({ outcome: 'accepted' }) }, 1);
    await task.claim();
    const ref = await uploadCiphertext(task.harness, task.device,
      randomBytes((BY_REFERENCE_MEMBER as { ciphertextRef: { size: number } }).ciphertextRef.size));
    expect(await task.publish({ ...MESSAGE_FIELDS, sealed: { ...BY_REFERENCE_MEMBER, category: 'agent-message', ciphertextRef: ref } }))
      .toEqual(refused('agent_message_too_large'));
  });
});
