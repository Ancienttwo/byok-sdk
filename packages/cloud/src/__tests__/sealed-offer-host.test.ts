/**
 * #654 E3b: the Host side of a sealed offer.
 *
 * - A retry that seals the same content again is a duplicate by its
 *   comparison projection (§9.2). The first ciphertext stays the offer.
 * - The object with the declared hash of a `ciphertextRef` must be
 *   committed in this tenant, with the declared size and content type. The
 *   task then holds an object reference to it, so orphan GC keeps it while
 *   the task lives.
 *
 * Every blob here goes through the device blob routes. No store is mocked.
 */
import type { ContentHash } from '@byok-sdk/core';
import { sealContent } from '@byok-sdk/core/sealed-payload';
import { decodeEnvelope, requiredReceiverCapabilities } from '@byok-sdk/protocol';
import { describe, expect, it, vi } from 'vitest';
import { TENANT_A, TENANT_B, TEST_AGENT_REF, createHarness, offerPayload, type CloudHarness, type PairedDevice } from './support/harness';
import {
  BY_REFERENCE_TEXT_LENGTH,
  CIPHERTEXT_CONTENT_TYPE,
  SEALING,
  inlineMember,
  referenceMember,
  sha256Hash,
  uploadCiphertext,
  type CiphertextRef,
} from './support/sealed';

const TASK_ID = 'sealed-host-task';
const TYPE = 'task.offer_for_agent_sealed';
/** The plaintext fields of the sealed Agent resume offer. */
const RESUME = { runtime: 'pi', agentRef: TEST_AGENT_REF, sessionRef: offerPayload().sessionRef } as const;
const SCOPE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

async function sealedDevice(): Promise<{ harness: CloudHarness; device: PairedDevice }> {
  const harness = createHarness();
  const device = await harness.pairDevice(TENANT_A);
  const capabilities = requiredReceiverCapabilities(TYPE, { ...RESUME, sealing: SEALING, sealed: {} });
  await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities });
  return { harness, device };
}

/** The sealed instruction. `sealInput` binds no Agent; an Agent offer's instruction binds the offer's Agent. */
function seal(device: PairedDevice, instruction: string) {
  return sealContent({
    scopeKey: SCOPE_KEY,
    scope: { id: SEALING.scopeId, epoch: SEALING.epoch },
    chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` },
    sender: 'A'.repeat(43),
    category: 'task-input',
    binding: {
      tenantId: TENANT_A,
      family: 'task.offer_for_agent',
      direction: 'server-to-daemon',
      identity: { taskId: TASK_ID },
      deviceId: device.deviceId,
      agentRef: { ...TEST_AGENT_REF },
      categories: [...SEALING.categories],
      notAfter: null,
    },
    plaintext: { instruction },
    maxContentLength: 2 * 1024 * 1024,
  });
}

/** `plain` holds more plaintext fields of the offer. */
function offer(harness: CloudHarness, device: PairedDevice, sealed: object, plain: object = {}) {
  return harness.cloud.enqueueSealedAgentOffer(TENANT_A, device.deviceId, {
    taskId: TASK_ID,
    payload: { ...RESUME, ...plain, sealing: SEALING, sealed } as never,
  });
}

/** The first offer fails at its mailbox append, after its receipt. Only then may the same task id be offered again. */
async function failedFirstOffer(harness: CloudHarness, device: PairedDevice, sealed: object, plain: object = {}): Promise<void> {
  vi.spyOn(harness.core.mailbox, 'append').mockRejectedValueOnce(new Error('mailbox unavailable'));
  await expect(offer(harness, device, sealed, plain)).rejects.toThrow('mailbox unavailable');
  expect(await mailbox(harness, device)).toEqual([]);
}

async function mailbox(harness: CloudHarness, device: PairedDevice) {
  const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 });
  return page.messages.map((message) => decodeEnvelope(message.body));
}

async function refCount(harness: CloudHarness, ref: CiphertextRef): Promise<number | undefined> {
  return (await harness.core.objects.get(TENANT_A, ref.contentHash as ContentHash))?.refCount;
}

describe('a sealed offer retry keeps the first ciphertext (#654 §9.2)', () => {
  it('returns the first envelope when the retry seals the same content again, and appends one mailbox row', async () => {
    const { harness, device } = await sealedDevice();
    const first = await seal(device, 'review the patch');
    const again = await seal(device, 'review the patch');
    expect(again.header.salt).not.toBe(first.header.salt);
    expect(again.header.contentMac).toBe(first.header.contentMac);

    await failedFirstOffer(harness, device, inlineMember(first));
    const retried = await offer(harness, device, inlineMember(again));

    expect(retried.envelope.payload).toMatchObject({ sealed: inlineMember(first) });
    expect(await mailbox(harness, device)).toEqual([retried.envelope]);
    await expect(offer(harness, device, inlineMember(again)), 'a delivered offer is not offered again').rejects.toMatchObject({
      code: 'agent_task_already_exists',
    });
  });

  it('refuses other content under the same task id, and keeps the first offer', async () => {
    const { harness, device } = await sealedDevice();
    const first = inlineMember(await seal(device, 'review the patch'));
    await failedFirstOffer(harness, device, first);

    await expect(offer(harness, device, inlineMember(await seal(device, 'delete the branch')))).rejects.toMatchObject({
      code: 'coordination_input_invalid',
    });
    expect(await mailbox(harness, device)).toEqual([]);
    const retried = await offer(harness, device, first);
    expect(await mailbox(harness, device)).toEqual([retried.envelope]);
  });

  it('refuses a plaintext field change under the same task id and the same sealed member, and keeps the first offer', async () => {
    const { harness, device } = await sealedDevice();
    const sealed = inlineMember(await seal(device, 'review the patch'));
    await failedFirstOffer(harness, device, sealed, { sessionRef: 'session-a' });

    await expect(offer(harness, device, sealed, { sessionRef: 'session-b' })).rejects.toMatchObject({ code: 'coordination_input_invalid' });
    expect(await mailbox(harness, device)).toEqual([]);
    const retried = await offer(harness, device, sealed, { sessionRef: 'session-a' });
    expect(retried.envelope.payload).toMatchObject({ sessionRef: 'session-a', sealed });
    expect(await mailbox(harness, device)).toEqual([retried.envelope]);
  });
});

describe('a sealed offer by ciphertextRef (#654 E3b)', () => {
  it('accepts a committed object with the declared hash, size and content type, and holds one reference to it', async () => {
    const { harness, device } = await sealedDevice();
    const content = await seal(device, 'x'.repeat(BY_REFERENCE_TEXT_LENGTH));
    const ref = await uploadCiphertext(harness, device, content.ciphertext);
    expect(await refCount(harness, ref)).toBe(0);

    const enqueued = await offer(harness, device, referenceMember(content, ref));

    expect(enqueued.envelope.payload).toMatchObject({ sealed: { ciphertextRef: ref } });
    expect(await mailbox(harness, device)).toEqual([enqueued.envelope]);
    expect(await refCount(harness, ref)).toBe(1);
  });

  it('keeps the first blob on a retry that sealed again into a new blob, and holds no reference to the new blob', async () => {
    const { harness, device } = await sealedDevice();
    const text = 'x'.repeat(BY_REFERENCE_TEXT_LENGTH);
    const first = await seal(device, text);
    const again = await seal(device, text);
    const firstRef = await uploadCiphertext(harness, device, first.ciphertext);
    const againRef = await uploadCiphertext(harness, device, again.ciphertext);

    await failedFirstOffer(harness, device, referenceMember(first, firstRef));
    expect(await refCount(harness, firstRef)).toBe(1);
    const retried = await offer(harness, device, referenceMember(again, againRef));

    expect(retried.envelope.payload).toMatchObject({ sealed: referenceMember(first, firstRef) });
    expect(await mailbox(harness, device)).toEqual([retried.envelope]);
    expect(await refCount(harness, firstRef)).toBe(1);
    expect(await refCount(harness, againRef)).toBe(0);
  });

  type Refusal = (harness: CloudHarness, device: PairedDevice, ciphertext: Uint8Array) => Promise<{ ref: CiphertextRef; uploaded?: CiphertextRef }>;
  const refusals: readonly (readonly [string, Refusal])[] = [
    ['a blob that is not finalized', async (harness, device, ciphertext) => ({ ref: await uploadCiphertext(harness, device, ciphertext, { finalize: false }) })],
    ['a blob of another tenant', async (harness, _device, ciphertext) => ({
      ref: await uploadCiphertext(harness, await harness.pairDevice(TENANT_B), ciphertext),
    })],
    ['a declared hash that names no object of this tenant', async (harness, device, ciphertext) => {
      const uploaded = await uploadCiphertext(harness, device, ciphertext);
      return { ref: { ...uploaded, contentHash: await sha256Hash(ciphertext.subarray(1)) }, uploaded };
    }],
    ['a declared size that is not the size of the blob', async (harness, device, ciphertext) => {
      const uploaded = await uploadCiphertext(harness, device, ciphertext.subarray(1));
      return { ref: { ...uploaded, size: ciphertext.byteLength }, uploaded };
    }],
    ['a declared content type that is not the type of the blob', async (harness, device, ciphertext) => {
      const uploaded = await uploadCiphertext(harness, device, ciphertext, { contentType: 'text/plain' });
      return { ref: { ...uploaded, contentType: CIPHERTEXT_CONTENT_TYPE }, uploaded };
    }],
  ];

  it.each(refusals)('refuses %s before any task, mailbox or reference state', async (_name, prepare) => {
    const { harness, device } = await sealedDevice();
    const content = await seal(device, 'x'.repeat(BY_REFERENCE_TEXT_LENGTH));
    const { ref, uploaded } = await prepare(harness, device, content.ciphertext);

    await expect(offer(harness, device, referenceMember(content, ref))).rejects.toMatchObject({ code: 'coordination_input_invalid' });
    expect(await harness.cloud.readTaskAttempt(TENANT_A, TASK_ID)).toBeUndefined();
    expect(await mailbox(harness, device)).toEqual([]);
    if (uploaded !== undefined) expect(await refCount(harness, uploaded)).toBe(0);
  });
});
