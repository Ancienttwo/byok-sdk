/**
 * `GET /byok/events` when the caller's cursor has fallen out of the retained
 * window (design packet GAP-3).
 *
 * Before this, the cloud long-poll had no such answer: a device that had lost
 * rows got a 200 whose page simply started later than it expected, which is
 * indistinguishable from "nothing new" until work quietly goes missing. The
 * reference server has always failed closed here
 * (`packages/server/src/hub.ts:2519` -> `packages/server/src/http.ts:386`), and
 * the daemon's transport already knows how to read that answer
 * (`packages/client/src/daemon/long-poll-transport.ts:567-578`) — so the body
 * asserted here is that exact one, field for field, not merely "a 409".
 *
 * The floor rule under test is the server's own: a caller at
 * `recoverableFrom - 1` can still be handed the first retained row; anything
 * lower cannot.
 */
import { createMutableClock } from '@byok-sdk/core';
import type { EventsPollResponse } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { TENANT_A, createHarness, offerPayload } from './support/harness';

describe('GET /byok/events cursor_too_old', () => {
  it('refuses a cursor below rows lost to expiry, and serves the one at the floor', async () => {
    const clock = createMutableClock();
    const harness = createHarness({ clock });
    const device = await harness.pairDevice(TENANT_A);

    const one = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload('one'),
    });
    await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload('two') });
    clock.advance(1_000);
    const cutoff = clock.now().toISOString();
    const three = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload('three'),
    });
    const four = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload('four'),
    });

    // One delivery, no ack: the device is handed everything and then loses the
    // first two rows to the retention sweep before it can report a cursor.
    const delivered = await harness.request('/byok/events', { headers: device.authorization });
    expect(delivered.status).toBe(200);
    const swept = await harness.core.mailbox.collectRetired(TENANT_A, {
      deviceId: device.deviceId,
      ackedBefore: cutoff,
      expireUnackedBefore: cutoff,
    });
    expect(swept.expiredCount).toBe(2);

    const lost = await harness.json('/byok/events?cursor=0', { headers: device.authorization });
    expect(lost.status).toBe(409);
    expect(lost.body).toEqual({ error: 'cursor_too_old', recoverableFrom: three.seq });
    // A refusal is not an ack: the device's durable position is where it was.
    expect((await harness.core.mailbox.readCursor(TENANT_A, device.deviceId)).ackedSeq).toBe(0);

    const atFloor = await harness.json(`/byok/events?cursor=${three.seq - 1}`, {
      headers: device.authorization,
    });
    expect(atFloor.status).toBe(200);
    expect((atFloor.body as EventsPollResponse).events.map((event) => event.seq)).toEqual([
      three.seq,
      four.seq,
    ]);
    // The floor moved past rows 1 and 2 specifically, not past everything.
    expect(one.seq).toBe(1);
  });

  it('never refuses a cursor merely because the rows past it were acked and retired', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const one = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload('one'),
    });
    const two = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload('two'),
    });

    await harness.request('/byok/events', { headers: device.authorization });
    const acked = await harness.json(`/byok/events?cursor=${two.seq}`, {
      headers: device.authorization,
    });
    expect(acked.status).toBe(200);
    expect((acked.body as EventsPollResponse).events).toEqual([]);
    const swept = await harness.core.mailbox.collectRetired(TENANT_A, {
      deviceId: device.deviceId,
      ackedBefore: '2999-01-01T00:00:00.000Z',
      expireUnackedBefore: '2999-01-01T00:00:00.000Z',
    });
    expect(swept).toMatchObject({ deletedCount: 2, expiredCount: 0 });

    // Consumed is not lost. A daemon that re-polls from an old cursor is doing
    // what at-least-once permits, and answering it 409 would turn the frozen
    // §8.3 stall-recovery path into a forced resync.
    const replay = await harness.json(`/byok/events?cursor=${one.seq - 1}`, {
      headers: device.authorization,
    });
    expect(replay.status).toBe(200);
    expect((replay.body as EventsPollResponse).events).toEqual([]);
    expect((await harness.core.mailbox.readCursor(TENANT_A, device.deviceId)).ackedSeq).toBe(two.seq);
  });

  it('keeps a fresh device at cursor 0 on the 200 empty-page path', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);

    const fresh = await harness.json('/byok/events?cursor=0', { headers: device.authorization });

    // An empty mailbox has retired nothing, so its floor is 1 and cursor 0 is
    // inside the window. Nothing about this path changed.
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({ events: [], cursor: 0 });
  });

  it('leaves a poll inside the window untouched', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload(),
    });

    const page = await harness.json('/byok/events?cursor=0', { headers: device.authorization });

    expect(page.status).toBe(200);
    expect((page.body as EventsPollResponse).events.map((event) => event.seq)).toEqual([offer.seq]);
  });
});
