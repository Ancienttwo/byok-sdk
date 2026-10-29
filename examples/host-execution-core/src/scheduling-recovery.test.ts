import { afterEach, expect, it, vi } from 'vitest';
import { WAKE_MAX_FUTURE_MS } from '@byok-sdk/server';
import { hash, nextIntervalOccurrence } from '@byok-sdk/server/execution-core';
import { openHost, template, type TestHost } from './test-support';

let host: TestHost;
afterEach(async () => { vi.useRealTimers(); await host?.close(); vi.restoreAllMocks(); });
const routine = (id: string) => host.ledger.snapshot().routines[hash(id)]!;

it('keeps an out-of-horizon routine outside the wake outbox while two Agent intents submit', async () => {
  host = await openHost();
  await host.core.addRoutine(host.routine('far', { rule: { anchorMs: Date.now() + 400 * 86_400_000, everyMs: 86_400_000 } }));
  const pending = routine('far');
  expect(pending).toMatchObject({ lifecycle: 'active', status: 'schedule_retrying', scheduleRetryCount: 1 });
  expect(host.ledger.snapshot().outbox[`schedule:${pending.next!.dedupKey}`]).toBeUndefined();
  expect(await host.server.wakes.pending()).toEqual([]);
  const bot = await host.core.enqueue(host.intent('bot-after-far'));
  const other = await host.core.enqueue(host.intent('other-after-far', { execution: template(host.deviceId, 'other-agent') }));
  expect(await host.server.tasks.offer(bot.taskId)).toMatchObject({ delivered: true });
  expect(await host.server.tasks.offer(other.taskId)).toMatchObject({ delivered: true });
  await vi.waitFor(() => expect(host.adapter.starts).toHaveLength(2));
});

it('scans every Agent queue before reporting a permanent wake outbox error', async () => {
  host = await openHost({ wrapServer: server => ({ ...server, wakes: { ...server.wakes, schedule: async input => {
    if (input.dedupKey.startsWith('broken:')) throw new Error('permanent wake row failure');
    return server.wakes.schedule(input);
  } } }) });
  await expect(host.core.addRoutine(host.routine('broken'))).rejects.toThrow('Wake dispatch failed');
  for (const [key, agent] of [['bot-after-error', 'main'], ['other-after-error', 'other-agent']] as const) {
    await expect(host.core.enqueue(host.intent(key, { execution: template(host.deviceId, agent) }))).rejects.toThrow('Wake dispatch failed');
    expect(await host.server.tasks.offer(host.core.intent(key)!.taskId)).toMatchObject({ delivered: true });
  }
  await vi.waitFor(() => expect(host.adapter.starts).toHaveLength(2));
  for (const session of host.adapter.sessions.values()) session.finish({ text: 'progress despite broken wake' });
  await vi.waitFor(async () => {
    await expect(host.core.drain()).rejects.toThrow('Wake dispatch failed');
    expect(host.core.intent('bot-after-error')?.conclusion).toBe('succeeded');
    expect(host.core.intent('other-after-error')?.conclusion).toBe('succeeded');
  }, { timeout: 5000 });
});

it('accepts the exact SDK horizon boundary and retries a later candidate through process backoff', async () => {
  host = await openHost(); await host.offline();
  vi.useFakeTimers();
  const now = Date.now(), at = now + WAKE_MAX_FUTURE_MS;
  await host.core.addRoutine(host.routine('boundary', { rule: { anchorMs: at, everyMs: 86_400_000 } }));
  await host.core.addRoutine(host.routine('beyond', { rule: { anchorMs: at + 1, everyMs: 86_400_000 } }));
  expect((await host.server.wakes.pending()).map(wake => wake.dedupKey)).toEqual([`boundary:1:${at}`]);
  expect(routine('beyond')).toMatchObject({ status: 'schedule_retrying', scheduleRetryAt: now + 60_000 });
  expect(host.ledger.snapshot().outbox[`schedule:beyond:1:${at + 1}`]).toBeUndefined();
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(routine('beyond').status).toBe('ok'));
  expect(routine('beyond').next).toEqual({ dedupKey: `beyond:1:${at + 1}`, availableAt: at + 1 });
  expect((await host.server.wakes.pending()).map(wake => wake.dedupKey)).toEqual([`boundary:1:${at}`, `beyond:1:${at + 1}`]);
  expect(routine('beyond').scheduleRetryAt).toBeUndefined();
});

it('backs off after a wall-clock rollback makes the real SDK reject a previously valid wake', async () => {
  let rollback = false;
  host = await openHost({ wrapServer: server => ({ ...server, wakes: { ...server.wakes, schedule: async input => {
    if (rollback) { rollback = false; vi.setSystemTime(Date.now() - 3_600_000); }
    return server.wakes.schedule(input);
  } } }) });
  await host.offline(); vi.useFakeTimers();
  const now = Date.now(), at = now + WAKE_MAX_FUTURE_MS;
  rollback = true;
  await host.core.addRoutine(host.routine('rollback', { rule: { anchorMs: at, everyMs: 86_400_000 } }));
  expect(routine('rollback')).toMatchObject({ lifecycle: 'active', status: 'schedule_retrying' });
  expect(await host.server.wakes.pending()).toEqual([]);
  expect(host.ledger.snapshot().outbox[`schedule:rollback:1:${at}`]).toBeUndefined();
  await host.restartCore();
  expect(routine('rollback').lastError).toEqual({ code: 'WAKE_AVAILABLE_AT_INVALID', message: 'WAKE_AVAILABLE_AT_INVALID' });
  vi.setSystemTime(now); await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(routine('rollback').status).toBe('ok'));
  expect((await host.server.wakes.pending())[0]).toMatchObject({ dedupKey: `rollback:1:${at}`, availableAt: at });
});

it('keeps a null initial calendar active and recomputes it on startup without changing the definition', async () => {
  let available = false;
  host = await openHost({ nextOccurrence: (_definition, after) => available ? after + 60_000 : null });
  const definition = host.routine('unknown-slot');
  await host.core.addRoutine(definition);
  expect(routine('unknown-slot')).toMatchObject({ lifecycle: 'active', status: 'no_occurrence_within_horizon', next: null });
  expect(await host.server.wakes.pending()).toEqual([]);
  available = true;
  await host.restartCore();
  expect(routine('unknown-slot')).toMatchObject({ lifecycle: 'active', status: 'ok', definition });
  expect((await host.server.wakes.pending())[0]?.dedupKey).toBe(routine('unknown-slot').next?.dedupKey);
  await expect(host.core.addRoutine({ ...definition, version: 2 })).rejects.toThrow('immutable');
});

it('keeps a null successor active and can refresh the same immutable definition', async () => {
  let available = true;
  host = await openHost({ nextOccurrence: (definition, after) => available ? nextIntervalOccurrence(definition, after) : null });
  const definition = host.routine('null-successor');
  await host.core.addRoutine(definition); available = false;
  await vi.waitFor(() => expect(routine('null-successor').status).toBe('no_occurrence_within_horizon'));
  expect(routine('null-successor').lifecycle).toBe('active');
  expect(Object.values(host.ledger.snapshot().occurrences)).toHaveLength(1);
  available = true; await host.core.addRoutine(definition);
  expect(routine('null-successor')).toMatchObject({ lifecycle: 'active', status: 'ok' });
  expect(routine('null-successor').next).not.toBeNull();
});

it('still completes the default interval calendar after its end condition', async () => {
  host = await openHost();
  await host.core.addRoutine(host.routine('ended', { endAt: Date.now() - 1 }));
  expect(routine('ended')).toMatchObject({ lifecycle: 'completed', status: 'ok', next: null });
  expect(await host.server.wakes.pending()).toEqual([]);
});

it('audits a successor calendar exception and resolves the real hook without redelivery', async () => {
  let fail = false;
  const deliveries: number[] = [];
  host = await openHost({
    nextOccurrence: (definition, after) => { if (fail) throw new RangeError('calendar domain exceeded'); return nextIntervalOccurrence(definition, after); },
    consume: async (wake, _signal, next) => { if (wake.dedupKey.startsWith('domain-error:')) deliveries.push(wake.delivery); await next(); },
  });
  await host.core.addRoutine(host.routine('domain-error')); fail = true;
  await vi.waitFor(() => expect(routine('domain-error').status).toBe('calendar_error'));
  const occurrence = Object.values(host.ledger.snapshot().occurrences)[0]!;
  expect(routine('domain-error').calendarErrors).toEqual([{ at: occurrence.recordedAt, wakeKey: occurrence.wakeKey, message: 'calendar domain exceeded' }]);
  expect(routine('domain-error')).toMatchObject({ lifecycle: 'active', next: null });
  await vi.waitFor(async () => expect((await host.server.wakes.pending()).some(wake => wake.dedupKey === occurrence.wakeKey)).toBe(false));
  const intent = host.ledger.snapshot().intents[occurrence.intentId!]!;
  await vi.waitFor(() => expect(host.adapter.sessions.has(intent.taskId)).toBe(true));
  host.adapter.sessions.get(intent.taskId)!.finish({ text: 'current occurrence is independent of the next calendar calculation' });
  await vi.waitFor(async () => { await host.core.drain(); expect(host.core.intent(intent.key)?.conclusion).toBe('succeeded'); });
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 60_001);
  await host.server.wakes.schedule({ dedupKey: 'check-calendar-no-retry', availableAt: Date.now() });
  await vi.waitFor(async () => expect(await host.server.wakes.pending()).toEqual([]));
  expect(deliveries).toEqual([1]);
  expect(routine('domain-error').calendarErrors).toHaveLength(1);
  expect(Object.values(host.ledger.snapshot().occurrences)).toHaveLength(1);
});

it('audits a calendar error during null-state startup recovery without blocking Bot work', async () => {
  let fail = false;
  host = await openHost({ nextOccurrence: () => { if (fail) throw new RangeError('calendar unavailable at startup'); return null; } });
  await host.core.addRoutine(host.routine('restart-error'));
  fail = true; await host.restartCore();
  expect(routine('restart-error')).toMatchObject({ lifecycle: 'active', status: 'calendar_error', next: null });
  expect(routine('restart-error').calendarErrors).toHaveLength(1);
  const bot = await host.core.enqueue(host.intent('bot-after-calendar-error'));
  expect(await host.server.tasks.offer(bot.taskId)).toMatchObject({ delivered: true });
});
