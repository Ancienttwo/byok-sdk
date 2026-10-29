import { afterEach, expect, it, vi } from 'vitest';
import { hash, taskId, nextIntervalOccurrence, parseRoutineWakeKey } from '@byok-sdk/server/execution-core';
import { openHost, template, type TestHost } from './test-support';

let host: TestHost;
afterEach(async () => { vi.useRealTimers(); await host?.close(); vi.restoreAllMocks(); });
const occurrences = () => Object.values(host.ledger.snapshot().occurrences);
const intents = () => Object.values(host.ledger.snapshot().intents);

it('skips three days of missed slots and runs exactly one catch_up with an injected clock', async () => {
  host = await openHost(); await host.offline();
  const now = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  await host.core.addRoutine(host.routine('sleep', { rule: { anchorMs: now + 50, everyMs: 86_400_000 } }));
  vi.setSystemTime(now + 3 * 86_400_000);
  await vi.waitFor(() => expect(occurrences()).toHaveLength(1));
  expect(occurrences()[0]).toMatchObject({ trigger: { kind: 'catch_up', plannedAt: now + 50 } });
  expect(occurrences()[0]!.nextAt).toBeGreaterThan(occurrences()[0]!.recordedAt);
  expect(occurrences()[0]!.nextAt! - occurrences()[0]!.recordedAt).toBeLessThanOrEqual(86_400_000);
  expect((occurrences()[0]!.nextAt! - occurrences()[0]!.trigger.plannedAt) % 86_400_000).toBe(0);
  // An exact duplicate delivery uses the committed trigger and next time.
  const row = occurrences()[0]!;
  const oldWake = { wakeId: 'duplicate', dedupKey: row.wakeKey, availableAt: row.trigger.plannedAt,
    deliveredAt: Date.now(), delivery: 2 };
  await host.core.consume(oldWake, new AbortController().signal);
  expect(occurrences()).toHaveLength(1);
  await host.online();
  const intent = intents()[0]!;
  await vi.waitFor(() => expect(host.adapter.sessions.has(intent.taskId)).toBe(true), { timeout: 5000 });
  host.adapter.sessions.get(intent.taskId)!.finish({ text: 'one catch-up' });
  await vi.waitFor(async () => { await host.core.drain(); expect(host.core.intent(intent.key)?.conclusion).toBe('succeeded'); }, { timeout: 5000 });
  expect(host.adapter.starts).toHaveLength(1);
  expect(occurrences()).toHaveLength(1);
});

it('keeps one running occurrence and only the latest queued slot, then pause stops new slots', async () => {
  host = await openHost();
  const now = Date.now();
  // Mock only the wall clock. Fake timers would let vi.waitFor advance it.
  vi.setSystemTime(now);
  await host.core.addRoutine(host.routine('coalesce', { rule: { anchorMs: now, everyMs: 100 } }));
  await vi.waitFor(() => expect(host.adapter.starts).toHaveLength(1));
  for (const slot of [1, 2]) {
    vi.setSystemTime(now + slot * 100);
    await host.server.wakes.schedule({ dedupKey: `coalesce-clock:${slot}`, availableAt: Date.now() });
    await vi.waitFor(() => expect(occurrences()).toHaveLength(slot + 1));
  }
  await vi.waitFor(() => expect(occurrences().length).toBeGreaterThanOrEqual(3));
  expect(intents().filter(row => row.phase === 'inflight')).toHaveLength(1);
  expect(intents().filter(row => row.phase === 'queued')).toHaveLength(1);
  expect(occurrences().some(row => row.conclusion === 'superseded')).toBe(true);
  const latest = occurrences().find(row => row.trigger.plannedAt === now + 200)!;
  expect(host.ledger.snapshot().intents[latest.intentId!]?.phase).toBe('queued');
  await host.core.lifecycle('coalesce', 'paused');
  const count = occurrences().length;
  // Cross later slots and observe a real SDK completion while the routine is paused.
  vi.setSystemTime(now + 1000);
  await host.server.wakes.schedule({ dedupKey: 'coalesce-clock:paused', availableAt: Date.now() });
  await vi.waitFor(async () => {
    expect((await host.server.wakes.pending()).some(wake => wake.dedupKey === 'coalesce-clock:paused')).toBe(false);
  });
  // The SDK invalidates delivery before its complete write commits.
  // Wait for that write before checking that the paused routine has no wakes.
  await vi.waitFor(async () => {
    expect((await host.server.wakes.pending()).filter(wake => wake.dedupKey.startsWith('coalesce:'))).toEqual([]);
  }, { timeout: 5000 });
  const running = intents().find(row => row.phase === 'inflight')!;
  host.adapter.sessions.get(running.taskId)!.finish({ text: 'current completes' });
  await vi.waitFor(async () => { await host.core.drain(); expect(host.core.intent(running.key)?.conclusion).toBe('succeeded'); });
  expect(occurrences()).toHaveLength(count);
  expect(host.ledger.snapshot().routines[hash('coalesce')]?.lifecycle).toBe('paused');
  await host.core.lifecycle('coalesce', 'completed');
  await expect(host.core.lifecycle('coalesce', 'active')).rejects.toThrow('cannot resume');
});

it('defers a quiet-hour slot and uses the same pure calendar on both sides', () => {
  const definition = { id: 'quiet', version: 1, timeZone: 'UTC', rule: {
    anchorMs: Date.UTC(2026, 9, 18, 23), everyMs: 86_400_000, quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 },
  }, execution: template('calendar-only'), waitMs: 60000, lateAfterMs: 1000 };
  expect(nextIntervalOccurrence(definition, Date.UTC(2026, 9, 18, 22))).toBe(Date.UTC(2026, 9, 19, 7));
  expect(nextIntervalOccurrence(definition, Date.UTC(2026, 9, 18, 23, 30))).toBe(Date.UTC(2026, 9, 19, 7));
  expect(nextIntervalOccurrence(definition, Date.UTC(2026, 9, 19, 3))).toBe(Date.UTC(2026, 9, 19, 7));
  expect(nextIntervalOccurrence(definition, Date.UTC(2026, 9, 19, 7))).toBe(Date.UTC(2026, 9, 20, 7));
  const sameDay = { ...definition, rule: { anchorMs: Date.UTC(2026, 9, 18, 10), everyMs: 86_400_000,
    quietHours: { startMinute: 9 * 60, endMinute: 11 * 60 } } };
  expect(nextIntervalOccurrence(sameDay, Date.UTC(2026, 9, 18, 10, 30))).toBe(Date.UTC(2026, 9, 18, 11));
  expect(nextIntervalOccurrence({ ...sameDay, rule: { ...sameDay.rule, everyMs: 1 } }, Date.UTC(2026, 9, 18, 10, 30))).toBe(Date.UTC(2026, 9, 18, 11));
});

it('does not retry an old occurrence beyond the next routine slot', async () => {
  host = await openHost({ reconcileMs: 20 });
  // External writer makes each real routine offer decline with a typed busy code.
  const definition = host.routine('retry', { waitMs: 600_000,
    retry: { maxAttempts: 3, delaysMs: [20, 120_000], retryFailures: false } });
  await host.server.executions.submit({ ...definition.execution, taskId: 'other-writer' });
  await vi.waitFor(() => expect(host.adapter.sessions.has('other-writer')).toBe(true));
  definition.rule = { anchorMs: Date.now() + 30, everyMs: 60_000 };
  await host.core.addRoutine(definition);
  await vi.waitFor(() => expect(occurrences()).toHaveLength(1));
  const first = occurrences()[0]!;
  await vi.waitFor(async () => {
    await host.core.drain();
    expect(host.ledger.snapshot().intents[first.intentId!]).toMatchObject({ attempts: 2, conclusion: 'declined' });
  }, { timeout: 5000 });
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(first.nextAt! + 1);
  await host.server.wakes.schedule({ dedupKey: 'retry-slot-clock-check', availableAt: Date.now() });
  await vi.waitFor(() => expect(occurrences().length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
  await host.core.drain();
  const old = host.ledger.snapshot().intents[first.intentId!]!;
  expect(old.attempts).toBe(2);
  expect(old.conclusion).toBe('declined');
  expect(old.generation).toBe(1);
  expect(await host.server.tasks.offer(taskId(old.key, 2))).toBeUndefined();
});

it('lets an admitted queued occurrence finish after pause cancels its successor cutoff', async () => {
  host = await openHost();
  const bot = await host.core.enqueue(host.intent('blocking-bot'));
  await vi.waitFor(() => expect(host.adapter.sessions.has(bot.taskId)).toBe(true));
  await host.core.addRoutine(host.routine('paused-queue', { rule: { anchorMs: Date.now() + 30, everyMs: 1000 }, waitMs: 60_000 }));
  await vi.waitFor(() => expect(occurrences()).toHaveLength(1));
  const occurrence = occurrences()[0]!;
  const before = host.ledger.snapshot().intents[occurrence.intentId!]!;
  expect(before).toMatchObject({ phase: 'queued', retryUntil: occurrence.nextAt });
  await host.core.lifecycle('paused-queue', 'paused');
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(occurrence.nextAt! + 1);
  await host.core.drain();
  const queued = host.ledger.snapshot().intents[occurrence.intentId!]!;
  expect(queued.phase).toBe('queued');
  expect(queued.conclusion).toBeUndefined();
  expect(queued.retryUntil).toBeUndefined();
  expect(queued.waitUntil).toBe(before.waitUntil);
  host.adapter.sessions.get(bot.taskId)!.finish({ text: 'release the FIFO' });
  await vi.waitFor(async () => { await host.core.drain(); expect(host.adapter.sessions.has(queued.taskId)).toBe(true); });
  host.adapter.sessions.get(queued.taskId)!.finish({ text: 'admitted before pause' });
  await vi.waitFor(async () => { await host.core.drain(); expect(host.core.intent(queued.key)?.conclusion).toBe('succeeded'); });
  expect(occurrences()).toHaveLength(1);
  expect(host.ledger.snapshot().routines[hash('paused-queue')]?.lifecycle).toBe('paused');
});

it('redelivers a rejected wake after 60 seconds without another occurrence or execution', async () => {
  let rejected = false;
  host = await openHost({ consume: async (wake, _signal, next) => {
    await next();
    if (wake.dedupKey.startsWith('retry-wake:') && !rejected) { rejected = true; throw new Error('response lost after commit'); }
  } });
  const now = Date.now(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  await host.core.addRoutine(host.routine('retry-wake'));
  await vi.waitFor(async () => expect((await host.server.wakes.pending()).some(wake => wake.lastError === 'response lost after commit')).toBe(true));
  const task = intents()[0]!;
  await vi.waitFor(() => expect(host.adapter.starts).toHaveLength(1));
  await host.core.drain(); // Persist the observed claim before advancing past the waiting deadline.
  vi.setSystemTime(now + 60_100);
  // Public schedule causes the scheduler to compare the injected wall clock.
  await host.server.wakes.schedule({ dedupKey: 'clock-check', availableAt: Date.now() });
  await vi.waitFor(async () => expect((await host.server.wakes.pending()).some(wake => wake.lastError)).toBe(false));
  expect(occurrences()).toHaveLength(1);
  expect(host.core.intent(task.key)?.generation).toBe(0);
  expect(host.adapter.starts).toHaveLength(1);
});

it('a timed-out hook cannot create a late occurrence and does not block another routine', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  host = await openHost({ consume: async (_wake, signal, next) => {
    if (first) { first = false; await held; signal.throwIfAborted(); }
    await next();
  } });
  await host.offline();
  vi.useFakeTimers();
  await host.core.addRoutine(host.routine('held', { rule: { anchorMs: Date.now() + 1, everyMs: 86_400_000 } }));
  await host.core.addRoutine(host.routine('other', { rule: { anchorMs: Date.now() + 2, everyMs: 86_400_000 } }));
  await vi.advanceTimersByTimeAsync(60_001);
  await host.server.wakes.pending(); await vi.advanceTimersByTimeAsync(0);
  expect(occurrences().map(row => row.routineId)).toEqual(['other']);
  const retryAt = (await host.server.wakes.pending()).find(wake => wake.lastError === 'wake_delivery_deadline_exceeded')!.retryAt!;
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(occurrences().map(row => row.routineId)).toEqual(['other']);
  await vi.advanceTimersByTimeAsync(Math.max(0, retryAt - Date.now()));
  await vi.waitFor(() => expect(occurrences().map(row => row.routineId).sort()).toEqual(['held', 'other']));
});

it('reports an initial schedule failure and recovers its durable outbox on startup', async () => {
  let fail = true;
  host = await openHost({ wrapServer: server => ({ ...server, wakes: { ...server.wakes, schedule: async input => {
    if (fail) { fail = false; throw new Error('temporary schedule failure'); }
    return server.wakes.schedule(input);
  } } }) });
  await expect(host.core.addRoutine(host.routine('initial-failure'))).rejects.toThrow('Wake dispatch failed');
  expect(await host.server.wakes.pending()).toEqual([]);
  expect(Object.values(host.ledger.snapshot().outbox)).toContainEqual(expect.objectContaining({ kind: 'schedule', lastError: 'temporary schedule failure' }));
  await host.restartCore();
  await vi.waitFor(() => expect(occurrences()).toHaveLength(1));
  await vi.waitFor(() => expect(host.adapter.starts).toHaveLength(1));
});

// While a task is live, event mode deliberately arms no host-scan: wake (#630).
// The host-scan: case therefore runs without server.events, in durable-scan mode.
it.each([
  { prefix: 'successor-failure:', mode: 'event' },
  { prefix: 'host-scan:', mode: 'durable scan' },
])('rejects the current hook if successor $prefix scheduling fails, then SDK retry recovers ($mode)', async ({ prefix }) => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  let armed = false;
  let failed = false;
  const deliveries: number[] = [];
  host = await openHost({
    consume: async (wake, _signal, next) => {
      if (wake.dedupKey.startsWith('successor-failure:')) {
        deliveries.push(wake.delivery);
        // Initial scheduling may deliver the wake before addRoutine's drain returns.
        await ready;
      }
      await next();
    },
    wrapServer: server => ({
      ...server,
      ...(prefix === 'host-scan:' ? { events: undefined } : {}),
      wakes: { ...server.wakes, schedule: async input => {
        if (armed && !failed && input.dedupKey.startsWith(prefix)) { failed = true; throw new Error('successor schedule unavailable'); }
        return server.wakes.schedule(input);
      } },
    }),
  });
  try {
    await host.core.addRoutine(host.routine('successor-failure', { waitMs: 300_000 }));
    armed = true;
  } finally {
    release();
  }
  await vi.waitFor(async () => expect((await host.server.wakes.pending()).some(wake => wake.lastError?.includes('Wake dispatch failed'))).toBe(true), { timeout: 5000 });
  expect(failed).toBe(true);
  const retry = (await host.server.wakes.pending()).find(wake => wake.lastError?.includes('Wake dispatch failed'))!;
  expect(occurrences()).toHaveLength(1);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(retry.retryAt! + 1);
  await host.server.wakes.schedule({ dedupKey: 'retry-clock-check', availableAt: Date.now() });
  await vi.waitFor(() => expect(deliveries).toEqual([1, 2]));
  await vi.waitFor(() => expect(host.adapter.starts).toHaveLength(1));
  expect(occurrences()).toHaveLength(1);
  expect(Object.keys(host.ledger.snapshot().executions)).toHaveLength(1);
});

it('uses the PRD routine key without payload and parses colon-containing ids from the right', async () => {
  host = await openHost();
  const at = Date.now() + 60_000;
  await host.core.addRoutine(host.routine('team:bot:routine', { version: 12, rule: { anchorMs: at, everyMs: 86_400_000 } }));
  const [wake] = await host.server.wakes.pending();
  expect(wake?.dedupKey).toBe(`team:bot:routine:12:${at}`);
  expect(wake?.payload).toBeUndefined();
  expect(parseRoutineWakeKey(wake!.dedupKey)).toEqual({ id: 'team:bot:routine', version: 12, at });
  for (const key of ['r:01:5', 'r:1:-5', 'r:1:1e3', 'r:0:5', 'r:1:9007199254740993', ':1:5', 'r:1', 'r:1:5 ']) {
    expect(parseRoutineWakeKey(key)).toBeUndefined();
  }
  await host.core.consume({ wakeId: 'unarmed', dedupKey: `team:bot:routine:13:${at}`, availableAt: at, deliveredAt: at, delivery: 1 }, new AbortController().signal);
  expect(occurrences()).toEqual([]);
});
