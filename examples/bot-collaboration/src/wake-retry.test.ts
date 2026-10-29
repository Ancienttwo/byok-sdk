import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createByokServer } from '@byok-sdk/server';
import type { ExecutionServer } from '@byok-sdk/server/execution-core';
import { hash, HostLedger } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import type { ChannelPort } from './channel';
import { BotCollaboration, type BotOptions } from './host';
import { stateOf } from './model';
import { routineOf, seedRoutine } from './routines.test-support';
import { botCompactVeto } from './compaction';

let root: string;
let ledger: HostLedger;
let server: ReturnType<typeof createByokServer>;
let bot: BotCollaboration;
afterEach(async () => {
  await bot?.close(); await server?.close(); ledger?.close();
  if (root) await rm(root, { recursive: true, force: true });
  vi.useRealTimers(); vi.restoreAllMocks();
});
async function setup(wrap: (server: ExecutionServer) => ExecutionServer, options: Partial<BotOptions> = {}) {
  vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 19, 8));
  root = await mkdtemp(path.join(tmpdir(), 'bot-retry-'));
  ledger = new HostLedger(path.join(root, 'host.sqlite'), 'wake-retry', { compactVeto: botCompactVeto });
  server = createByokServer({ productId: 'wake-retry', storage: { kind: 'sqlite', path: path.join(root, 'server.sqlite') },
    wake: { consume: async () => {} } });
  bot = new BotCollaboration(wrap(server), ledger, { botId: 'main', execution: template('device'), connector: async () => null, ...options });
}
const pending = async () => (await server.wakes.pending()).map(wake => wake.dedupKey).filter(key => !key.startsWith('host-scan:'));
/** An SDK schedule that fails for the routine that `taskId` creates, and counts its calls. */
function failingSchedule(taskId: string) {
  const prefix = `${hash([taskId, 'create_routine', 0])}:`;
  const probe = { fail: true, attempts: 0, wrap: (server: ExecutionServer): ExecutionServer => ({ ...server, wakes: { ...server.wakes, schedule: async input => {
    if (input.dedupKey.startsWith(prefix)) { probe.attempts++; if (probe.fail) throw new Error('schedule unavailable'); }
    return server.wakes.schedule(input);
  } } }) };
  return probe;
}
const outbox = () => Object.values(ledger.snapshot().outbox).filter(row => row.kind === 'schedule' || row.kind === 'cancel-wake');

// K4 owns the routine wake outbox. A failed SDK call rejects the drain and keeps the row for a later drain.
it('keeps a failed routine wake schedule in the K4 outbox, schedules another routine, and sends it on a later drain', async () => {
  const failingId = hash(['failing', 'create_routine', 0]);
  let fail = true;
  await setup(server => ({ ...server, wakes: { ...server.wakes, schedule: async input => {
    if (fail && input.dedupKey.startsWith(`${failingId}:`)) throw new Error('schedule unavailable');
    return server.wakes.schedule(input);
  } } }));
  await expect(seedRoutine(bot, 'failing', 'failing')).rejects.toThrow('Wake dispatch failed');
  await expect(seedRoutine(bot, 'other', 'other')).rejects.toThrow('Wake dispatch failed');
  const otherId = hash(['other', 'create_routine', 0]);
  expect((await server.wakes.pending()).map(wake => wake.dedupKey)).toEqual([routineOf(bot, otherId).next!.dedupKey]);
  expect(outbox()).toEqual([{ kind: 'schedule', input: routineOf(bot, failingId).next, lastError: 'schedule unavailable' }]);
  fail = false;
  await bot.drain();
  expect(outbox()).toEqual([]);
  expect((await server.wakes.pending()).map(wake => wake.dedupKey).sort())
    .toEqual([routineOf(bot, failingId).next!.dedupKey, routineOf(bot, otherId).next!.dedupKey].sort());
});

it('completes a routine whose wake cancel fails, and sends the cancel on a later drain', async () => {
  let fail = false;
  await setup(server => ({ ...server, wakes: { ...server.wakes, cancel: async key => {
    if (fail) throw new Error('cancel unavailable');
    return server.wakes.cancel(key);
  } } }));
  const id = await seedRoutine(bot, 'cancel-recovery', 'report');
  const armed = routineOf(bot, id).next!;
  fail = true;
  await expect(bot.setRoutineLifecycle(id, 'completed')).rejects.toThrow('Wake dispatch failed');
  expect(routineOf(bot, id)).toMatchObject({ lifecycle: 'completed', status: 'ok', next: null });
  expect(outbox()).toEqual([{ kind: 'cancel-wake', key: armed.dedupKey, lastError: 'cancel unavailable' }]);
  fail = false;
  await bot.drain();
  expect(outbox()).toEqual([]);
  expect(await server.wakes.pending()).toEqual([]);
});

it('retries a failed routine wake call from the K4 timer with backoff', async () => {
  const probe = failingSchedule('failing');
  await setup(probe.wrap);
  // One call in the K4 command, one in the K8 pass. The failed K4 command arms the K4 retry timer.
  await expect(seedRoutine(bot, 'failing', 'failing')).rejects.toThrow('Wake dispatch failed');
  await expect(bot.drain()).rejects.toThrow('Wake dispatch failed');
  expect(probe.attempts).toBe(2);
  await vi.advanceTimersByTimeAsync(999);
  expect(probe.attempts).toBe(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(probe.attempts).toBe(3);
  probe.fail = false;
  await vi.advanceTimersByTimeAsync(1999);
  expect(probe.attempts).toBe(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(probe.attempts).toBe(4);
  expect(outbox()).toEqual([]);
  expect(await pending()).toEqual([routineOf(bot, hash(['failing', 'create_routine', 0])).next!.dedupKey]);
});

it('keeps other timer work on time while a routine wake call keeps failing', async () => {
  const probe = failingSchedule('failing');
  await setup(probe.wrap, { coalesce: {} });
  await expect(seedRoutine(bot, 'failing', 'failing')).rejects.toThrow('Wake dispatch failed');
  // The first input makes the Bot busy, so the second one opens a batch that seals at its window end.
  await expect(bot.input('first', 'Long task')).rejects.toThrow('Wake dispatch failed');
  await expect(bot.input('second', 'One more thing')).rejects.toThrow('Wake dispatch failed');
  const batch = hash(['user', 'main', 'second']);
  expect(bot.snapshot().inputBatches![batch]).toMatchObject({ state: 'open' });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(bot.snapshot().inputBatches![batch]).toMatchObject({ state: 'sealed', sealReason: 'window' });
  expect(outbox()).toEqual([expect.objectContaining({ kind: 'schedule', lastError: 'schedule unavailable' })]);
});

it('keeps one SDK wake when a resume of the same key follows a failed cancel', async () => {
  let fail = false;
  await setup(server => ({ ...server, wakes: { ...server.wakes, cancel: async key => {
    if (fail) throw new Error('cancel unavailable');
    return server.wakes.cancel(key);
  } } }));
  const id = await seedRoutine(bot, 'resume', 'report');
  const armed = routineOf(bot, id).next!;
  fail = true;
  await expect(bot.setRoutineLifecycle(id, 'paused')).rejects.toThrow('Wake dispatch failed');
  await bot.setRoutineLifecycle(id, 'active');
  fail = false;
  await bot.drain();
  expect(routineOf(bot, id).next).toEqual(armed);
  expect(outbox()).toEqual([]);
  expect(await pending()).toEqual([armed.dedupKey]);
});

it('sends a due delivery and keeps the timer at 60 seconds while a routine wake call keeps failing', async () => {
  const probe = failingSchedule('failing');
  const send = vi.fn<ChannelPort['send']>(async () => ({ result: 'accepted', platformMessageId: 'sent' }));
  await setup(probe.wrap, { channel: { port: { send } } });
  await expect(seedRoutine(bot, 'failing', 'failing')).rejects.toThrow('Wake dispatch failed');
  const conversation = { kind: 'direct', id: 'main' } as const, now = Date.now();
  ledger.transaction(s => {
    const channel = stateOf(s.application).channel ??= { inbounds: {}, pushRoutes: {}, deliveries: {} };
    channel.pushRoutes.push = { kind: 'push', id: 'push', conversation, channel: 'fake', target: 'chat', optedInBy: 'owner', optedInAt: now };
    channel.deliveries.due = { id: 'due', taskId: 'task', turnId: 'turn', messageId: 'message', body: 'Report', conversation, channel: 'fake',
      route: { kind: 'push', pushRouteId: 'push' }, state: 'pending', attempts: 0, nextAttemptAt: now };
  });
  const before = probe.attempts;
  await expect(bot.drain()).rejects.toThrow('Wake dispatch failed');
  expect(send).toHaveBeenCalledTimes(1);
  expect(bot.snapshot().channel!.deliveries.due).toMatchObject({ state: 'accepted', platformMessageId: 'sent' });
  // A due time in the past would arm a 1 ms timer and call the SDK in a loop.
  await vi.advanceTimersByTimeAsync(1000);
  expect(probe.attempts - before).toBeLessThanOrEqual(2);
});
