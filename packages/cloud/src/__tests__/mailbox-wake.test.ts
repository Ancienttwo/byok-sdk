import { createMutableClock, tenantId } from '@byok-sdk/core';
import type { EventsPollResponse } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailboxWake } from '../mailbox-wake';
import { createInProcessMailboxWake } from '../stores/in-memory/mailbox-wake';
import { TENANT_A, TENANT_B, createHarness, grantAgentHome, offerPayload, type CloudHarness } from './support/harness';

function observeReads(harness: CloudHarness) {
  let reads = 0;
  let observed!: () => void;
  const first = new Promise<void>((resolve) => { observed = resolve; });
  const read = harness.core.mailbox.readAfter.bind(harness.core.mailbox);
  vi.spyOn(harness.core.mailbox, 'readAfter').mockImplementation(async (...args) => {
    const page = await read(...args);
    reads += 1;
    observed();
    return page;
  });
  return { first, count: () => reads };
}

function trackedWake(inner: MailboxWake, beforeNext?: () => Promise<void>) {
  let closed = 0;
  const wake: MailboxWake = {
    appended: (tenant, deviceId) => inner.appended(tenant, deviceId),
    subscribe(tenant, deviceId, signal) {
      const sub = inner.subscribe(tenant, deviceId, signal);
      return {
        async next(ms) { await beforeNext?.(); await sub.next(ms); },
        close() { closed += 1; sub.close(); },
      };
    },
  };
  return { wake, closed: () => closed };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('wake-driven events hold', () => {
  it('bounds idle reads by ceil(hold / fallback) + 1, including the final read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const harness = createHarness({ longPollHoldMs: 100, mailboxWake: createInProcessMailboxWake({ fallbackMs: 30 }) });
    const device = await harness.pairDevice(TENANT_A);
    const observed = observeReads(harness);
    const held = harness.request('/byok/events', { headers: device.authorization });
    await observed.first;
    await vi.advanceTimersByTimeAsync(100);
    const response = await held;
    expect(await response.json()).toMatchObject({ events: [], cursor: 0 });
    expect(observed.count()).toBeLessThanOrEqual(Math.ceil(100 / 30) + 1);
    expect(observed.count()).toBeGreaterThan(1);
  });

  it('releases a five-second hold within 100 ms after facade append', async () => {
    const tracked = trackedWake(createInProcessMailboxWake());
    const harness = createHarness({ longPollHoldMs: 5_000, mailboxWake: tracked.wake });
    const device = await harness.pairDevice(TENANT_A);
    await grantAgentHome(harness, TENANT_A, device.deviceId);
    const observed = observeReads(harness);
    const held = harness.request('/byok/events', { headers: device.authorization });
    await observed.first;
    const started = performance.now();
    const offer = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    const response = await held;
    expect(performance.now() - started).toBeLessThan(100);
    expect(await response.json()).toMatchObject({ events: [{ task_id: offer.taskId }] });
    expect(tracked.closed()).toBe(1);
    expect((await harness.core.mailbox.readCursor(TENANT_A, device.deviceId)).ackedSeq).toBe(0);
  });

  it('wakes for a host cancellation committed through the cancellation store', async () => {
    const harness = createHarness({ longPollHoldMs: 5_000, mailboxWake: createInProcessMailboxWake() });
    const device = await harness.pairDevice(TENANT_A);
    await grantAgentHome(harness, TENANT_A, device.deviceId);
    const offer = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    await harness.request('/byok/events', { headers: device.authorization });
    const observed = observeReads(harness);
    const held = harness.request(`/byok/events?cursor=${offer.seq}`, { headers: device.authorization });
    await observed.first;
    await harness.cloud.cancelTask(TENANT_A, offer.taskId, 'stop');
    expect(await (await held).json()).toMatchObject({ events: [{ type: 'task.cancel', task_id: offer.taskId }] });
  });

  it('delivers on fallback when every hint is dropped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const inner = createInProcessMailboxWake({ fallbackMs: 40 });
    const harness = createHarness({ longPollHoldMs: 5_000, mailboxWake: { ...inner, appended() {} } });
    const device = await harness.pairDevice(TENANT_A);
    await grantAgentHome(harness, TENANT_A, device.deviceId);
    const observed = observeReads(harness);
    const held = harness.request('/byok/events', { headers: device.authorization });
    await observed.first;
    const offer = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    await vi.advanceTimersByTimeAsync(40);
    expect(await (await held).json()).toMatchObject({ events: [{ task_id: offer.taskId }] });
    expect(observed.count()).toBe(2);
  });

  it('retains a hint between an empty read and the first wait', async () => {
    let append!: () => Promise<void>;
    let appended = false;
    const tracked = trackedWake(createInProcessMailboxWake(), async () => {
      if (!appended) { appended = true; await append(); }
    });
    const harness = createHarness({ longPollHoldMs: 5_000, mailboxWake: tracked.wake });
    const device = await harness.pairDevice(TENANT_A);
    await grantAgentHome(harness, TENANT_A, device.deviceId);
    append = async () => { await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: offerPayload() }); };
    const observed = observeReads(harness);
    const response = await harness.request('/byok/events', { headers: device.authorization });
    expect(((await response.json()) as EventsPollResponse).events).toHaveLength(1);
    expect(observed.count()).toBe(2);
  });

  it('coalesces repeated hints and never returns an early empty page', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const wake = createInProcessMailboxWake({ fallbackMs: 5_000 });
    const harness = createHarness({ longPollHoldMs: 100, mailboxWake: wake });
    const device = await harness.pairDevice(TENANT_A);
    const observed = observeReads(harness);
    let returned = false;
    const held = harness.request('/byok/events', { headers: device.authorization }).then((r) => { returned = true; return r; });
    await observed.first;
    for (let i = 0; i < 100; i += 1) wake.appended(TENANT_A, device.deviceId);
    await vi.advanceTimersByTimeAsync(99);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await held).json()).toMatchObject({ events: [] });
    expect(observed.count()).toBeLessThanOrEqual(4);
  });

  it('stops reads and closes its subscription on request abort', async () => {
    const tracked = trackedWake(createInProcessMailboxWake());
    const harness = createHarness({ longPollHoldMs: 5_000, mailboxWake: tracked.wake });
    const device = await harness.pairDevice(TENANT_A);
    const observed = observeReads(harness);
    const controller = new AbortController();
    const held = harness.request('/byok/events', { headers: device.authorization, signal: controller.signal });
    await observed.first;
    controller.abort();
    await held;
    expect(observed.count()).toBe(1);
    expect(tracked.closed()).toBe(1);
    tracked.wake.appended(TENANT_A, device.deviceId);
    expect(observed.count()).toBe(1);
  });

  it('returns 409 for a sweep during a hold, before an empty 200', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const clock = createMutableClock();
    const harness = createHarness({ clock, longPollHoldMs: 100, mailboxWake: createInProcessMailboxWake({ fallbackMs: 40 }) });
    const device = await harness.pairDevice(TENANT_A);
    await grantAgentHome(harness, TENANT_A, device.deviceId);
    const offer = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    await harness.cloud.cancelTask(TENANT_A, offer.taskId, 'cancelled offer');
    // A read-ahead caller scans beyond the delivered cancellation without
    // acknowledging either row. Expiry must invalidate its original cursor.
    await harness.request('/byok/events', { headers: device.authorization });
    const observed = observeReads(harness);
    const held = harness.request('/byok/events?cursor=0&afterSeq=2', { headers: device.authorization });
    await observed.first;
    clock.advance(1_000);
    const cutoff = clock.now().toISOString();
    await harness.core.mailbox.collectExpired(TENANT_A, { now: cutoff, limit: 500, ackedBefore: cutoff, expireUnackedBefore: cutoff, reapDeadLettersBefore: '1970-01-01T00:00:00.000Z' });
    await vi.advanceTimersByTimeAsync(40);
    const response = await held;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'cursor_too_old', recoverableFrom: 3 });
  });
});

describe('in-process subscription contract', () => {
  it('routes by the exact tenant/device pair, including embedded separators', async () => {
    vi.useFakeTimers();
    const wake = createInProcessMailboxWake();
    const a = wake.subscribe(TENANT_A, 'device', new AbortController().signal);
    const b = wake.subscribe(TENANT_B, 'device', new AbortController().signal);
    let returned = false;
    const held = b.next(5_000).then(() => { returned = true; });
    wake.appended(TENANT_A, 'device');
    await a.next(5_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(returned).toBe(false);
    b.close(); await held; a.close();
    const separated = wake.subscribe(tenantId('a\nb'), 'c', new AbortController().signal);
    const other = wake.subscribe(tenantId('a'), 'b\nc', new AbortController().signal);
    let otherReturned = false;
    const otherHeld = other.next(5_000).then(() => { otherReturned = true; });
    wake.appended(tenantId('a\nb'), 'c');
    await separated.next(5_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(otherReturned).toBe(false);
    separated.close(); other.close(); await otherHeld;
  });

  it('closes idempotently, clears pending timers, and accepts a pre-aborted signal', async () => {
    vi.useFakeTimers();
    const wake = createInProcessMailboxWake();
    const sub = wake.subscribe(TENANT_A, 'device', new AbortController().signal);
    const held = sub.next(5_000);
    expect(vi.getTimerCount()).toBe(1);
    sub.close(); sub.close(); await held;
    expect(vi.getTimerCount()).toBe(0);
    await wake.subscribe(TENANT_A, 'device', AbortSignal.abort()).next(5_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, NaN, Infinity, 0.5, 2_147_483_648])('rejects invalid fallbackMs %s', (fallbackMs) => {
    expect(() => createInProcessMailboxWake({ fallbackMs })).toThrow(RangeError);
  });
});
