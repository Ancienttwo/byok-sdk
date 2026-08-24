/**
 * Mailbox cursor semantics as the device surface exposes them.
 *
 * The core contract's load-bearing rule is "reading is not acknowledging", and
 * a long-poll route is the easiest place in the system to break it: answering
 * a poll by advancing the cursor to whatever was just handed out would look
 * correct in every happy-path test and would silently drop work the instant a
 * daemon crashed between receiving an envelope and journaling it.
 */
import { createMutableClock, isCoreConflictError, type CoreStores } from '@byok-sdk/core';
import { decodeEnvelope, type EventsPollResponse } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { createHmacTokenSigner } from '../auth/tokens';
import { fullCapabilityDeclaration } from '../capabilities';
import { createByokCloud } from '../cloud';
import { createInMemoryByokCloud } from '../composition/in-memory';
import { isCloudError } from '../errors';
import { TENANT_A, createHarness, offerPayload } from './support/harness';

async function poll(
  harness: ReturnType<typeof createHarness>,
  authorization: { authorization: string },
  cursor?: number,
): Promise<EventsPollResponse> {
  const query = cursor === undefined ? '' : `?cursor=${cursor}`;
  const response = await harness.request(`/byok/events${query}`, { headers: authorization });
  expect(response.status).toBe(200);
  return (await response.json()) as EventsPollResponse;
}

describe('GET /byok/events cursor semantics', () => {
  it('refuses both explicit legacy producer variants before durable mailbox/task side effects for strict devices', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: ['strict-agent-only'],
    });

    await expect(harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload('legacy') }))
      .rejects.toMatchObject({ code: 'agent_capability_missing' });
    await expect(harness.cloud.enqueueToolsetOffer(TENANT_A, device.deviceId, {
      payload: { ...offerPayload('legacy tools'), requiredToolsets: ['salesko'] },
    })).rejects.toMatchObject({ code: 'agent_capability_missing' });
    expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 })).messages).toEqual([]);
    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'task-never-created')).toBeUndefined();
  });

  it('delivers a logical-toolset offer as its distinct fail-closed message type', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const enqueued = await harness.cloud.enqueueToolsetOffer(TENANT_A, device.deviceId, {
      payload: {
        instruction: 'find qualified leads',
        policy: { mode: 'auto' },
        runtime: 'claude',
        requiredToolsets: ['salesko'],
      },
    });

    const page = await poll(harness, device.authorization);
    expect(page.capabilities).toContain('result-document');
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.type).toBe('task.offer_with_toolsets');
    expect(page.events[0]).toEqual(enqueued.envelope);
    expect(JSON.stringify(page.events[0])).not.toMatch(/command|args|secret/i);
  });

  it('replays the same page for as long as the daemon keeps reporting the same cursor', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload('first') });

    const first = await poll(harness, device.authorization);
    const second = await poll(harness, device.authorization, 0);

    expect(first.events).toHaveLength(1);
    expect(second.events).toEqual(first.events);
    // Reading moved nothing: the device's durable ack position is still zero.
    expect((await harness.core.mailbox.readCursor(TENANT_A, device.deviceId)).ackedSeq).toBe(0);
  });

  it('treats the cursor the daemon brings back on its NEXT poll as the only ack', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload() });

    const first = await poll(harness, device.authorization);
    expect(first.cursor).toBe(offer.seq);

    const second = await poll(harness, device.authorization, first.cursor);
    expect(second.events).toEqual([]);
    expect((await harness.core.mailbox.readCursor(TENANT_A, device.deviceId)).ackedSeq).toBe(offer.seq);
  });

  it('hands back events in seq order, and only the ones past the cursor', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const one = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload('one') });
    const two = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload('two') });

    const all = await poll(harness, device.authorization);
    expect(all.events.map((event) => event.seq)).toEqual([one.seq, two.seq]);

    const rest = await poll(harness, device.authorization, one.seq);
    expect(rest.events.map((event) => event.seq)).toEqual([two.seq]);
  });

  it('scans past a filtered cancelled offer so a one-row page still delivers the following cancel', async () => {
    const harness = createHarness({ eventsPageLimit: 1 });
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    await harness.cloud.cancelTask(TENANT_A, offer.taskId, 'stop before lease');

    const page = await poll(harness, device.authorization);

    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ type: 'task.cancel', task_id: offer.taskId, seq: 2 });
    expect(page.cursor).toBe(2);
    expect((await harness.core.mailbox.readCursor(TENANT_A, device.deviceId)).ackedSeq).toBe(0);
  });

  it('does not treat a cursor at or below the ack position as an ack attempt', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    await poll(harness, device.authorization, offer.seq);

    // A daemon that lost its journal and polls from zero must not crash the
    // route with a cursor regression — and must not un-ack what it acked.
    const replay = await poll(harness, device.authorization, 0);
    expect(replay.events).toEqual([]);
    expect((await harness.core.mailbox.readCursor(TENANT_A, device.deviceId)).ackedSeq).toBe(offer.seq);
  });

  it('leaves the store as the authority on an actual cursor regression', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    await harness.core.mailbox.advanceCursor(TENANT_A, { deviceId: device.deviceId, ackedSeq: 1 });

    await expect(
      harness.core.mailbox.advanceCursor(TENANT_A, { deviceId: device.deviceId, ackedSeq: 0 }),
    ).rejects.toSatisfy((error: unknown) => isCoreConflictError(error, 'mailbox_cursor_regression'));
  });

  it('400s a cursor that is not a non-negative integer', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);

    for (const cursor of ['-1', '1.5', 'abc', 'NaN']) {
      const response = await harness.json(`/byok/events?cursor=${cursor}`, { headers: device.authorization });
      expect(response.status, `cursor=${cursor}`).toBe(400);
      expect(response.body).toEqual({ error: 'invalid cursor' });
    }

    // An EMPTY `cursor=` parses as 0 here exactly as it does on the reference
    // server (`Number('') === 0`) — parity includes the edges.
    expect((await harness.json('/byok/events?cursor=', { headers: device.authorization })).status).toBe(200);
  });

  it('holds an empty poll open instead of answering immediately', async () => {
    const harness = createHarness({ longPollHoldMs: 120, longPollIntervalMs: 20 });
    const device = await harness.pairDevice(TENANT_A);

    const startedAt = Date.now();
    const empty = await poll(harness, device.authorization);
    const elapsed = Date.now() - startedAt;

    expect(empty.events).toEqual([]);
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });

  it('returns an envelope that still round-trips through the frozen v1 decoder', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload('frozen bytes'),
    });

    const page = await poll(harness, device.authorization);
    const delivered = page.events[0];
    expect(delivered).toEqual(offer.envelope);

    const stored = await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 });
    expect(decodeEnvelope(stored.messages[0]?.body ?? '')).toEqual(offer.envelope);
  });
});

describe('enqueueOffer', () => {
  it('numbers the envelope with the same seq the mailbox row gets', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);

    const first = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    const second = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    expect([first.seq, second.seq]).toEqual([1, 2]);

    const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 });
    expect(page.messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(page.messages.map((message) => decodeEnvelope(message.body).seq)).toEqual([1, 2]);
  });

  it('fails loudly when the mailbox numbers a row differently from the delivery sequence', async () => {
    const clock = createMutableClock();
    const base = createInMemoryByokCloud({ clock });
    const skewedCore: CoreStores = {
      ...base.core,
      mailbox: {
        ...base.core.mailbox,
        append: async (tenant, input) => ({ ...(await base.core.mailbox.append(tenant, input)), seq: 99 }),
      },
    };
    const skewed = createByokCloud({
      core: skewedCore,
      cloud: base.stores,
      // `fullCapabilityDeclaration()` names `blobs.contentproxy`, and a
      // declaration is not allowed to out-run the parts, so the proxy comes
      // along with it.
      blobContentProxy: base.blobContentProxy,
      crypto: base.crypto,
      tokenSigner: createHmacTokenSigner(new Uint8Array(32).fill(3), clock),
      clock,
      capabilities: fullCapabilityDeclaration(),
    });

    await expect(
      skewed.enqueueOffer(TENANT_A, 'dev_whoever', { payload: offerPayload() }),
    ).rejects.toSatisfy((error: unknown) => isCloudError(error, 'mailbox_seq_mismatch'));
  });

  it('opens the task attempt with no owner until a device claims it', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload() });

    const attempt = await harness.cloud.readTaskAttempt(TENANT_A, taskId);
    expect(attempt?.deviceId).toBe(device.deviceId);
    expect(attempt?.ownerDeviceId).toBeUndefined();
    expect(attempt?.status).toBe('offered');
  });
});
