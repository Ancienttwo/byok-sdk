import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createByokServer } from '@byok-sdk/server';
import type { ExecutionServer } from '../../host-execution-core/src/core';
import { HostLedger } from '../../host-execution-core/src/ledger';
import { template } from '../../host-execution-core/src/test-support';
import { BotCollaboration } from './host';
import { stateOf } from './model';
import { createRoutine } from './routines';

let root: string;
let ledger: HostLedger;
let server: ReturnType<typeof createByokServer>;
let bot: BotCollaboration;
afterEach(async () => {
  await bot?.close(); await server?.close(); ledger?.close();
  if (root) await rm(root, { recursive: true, force: true });
  vi.useRealTimers(); vi.restoreAllMocks();
});
async function setup(wrap: (server: ExecutionServer) => ExecutionServer) {
  vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 19, 8));
  root = await mkdtemp(path.join(tmpdir(), 'bot-retry-'));
  ledger = new HostLedger(path.join(root, 'host.sqlite'), 'wake-retry');
  server = createByokServer({ productId: 'wake-retry', storage: { kind: 'sqlite', path: path.join(root, 'server.sqlite') },
    wake: { consume: async () => {} } });
  bot = new BotCollaboration(wrap(server), ledger, { botId: 'main', execution: template('device'), connector: async () => null });
}
function addRoutine(key: string) {
  return ledger.transaction(s => createRoutine(stateOf(s.application), 'main', key, 0,
    { localId: 'new_routine_1', schedule: { hour: 9, minute: 0, tz: 'UTC' }, prompt: key }, Date.now()).id);
}

it('backs off schedule_retrying without writes between retries and lets another routine proceed', async () => {
  let failingId: string;
  let attempts = 0;
  await setup(server => ({ ...server, wakes: { ...server.wakes, schedule: async input => {
    if (input.dedupKey.startsWith(`${failingId}:`)) { attempts++; throw new Error('schedule unavailable'); }
    return server.wakes.schedule(input);
  } } }));
  failingId = addRoutine('failing');
  const otherId = addRoutine('other');
  const transactions = vi.spyOn(ledger, 'transaction');
  const startedAt = Date.now();
  await bot.drain();
  expect(bot.snapshot().routines[failingId]!.status).toBe('schedule_retrying');
  expect(bot.snapshot().operations.find(o => o.routineId === failingId)).toMatchObject({ state: 'pending', retryAt: startedAt + 60_000 });
  const initialWrites = transactions.mock.calls.length;
  // Fail fast on the old 1 ms loop before advancing the full retry window.
  await vi.advanceTimersByTimeAsync(100);
  expect(transactions.mock.calls.length - initialWrites).toBe(0);
  expect((await server.wakes.pending()).map(w => w.dedupKey)).toContain(bot.snapshot().routines[otherId]!.armed!.key);
  await vi.advanceTimersByTimeAsync(59_900);
  expect(attempts).toBe(2);
  expect(transactions.mock.calls.length - initialWrites).toBeLessThanOrEqual(10);
  expect(bot.snapshot().operations.find(o => o.routineId === failingId)).toMatchObject({ state: 'pending', retryAt: startedAt + 120_000 });
});

it('keeps a failed cancel ahead of its schedule without letting that blocked schedule drive the timer', async () => {
  let fail = true;
  const calls: string[] = [];
  let armedKey: string;
  await setup(server => ({ ...server, wakes: { ...server.wakes,
    cancel: async key => {
      calls.push('cancel');
      if (fail) throw new Error('cancel unavailable');
      return server.wakes.cancel(key);
    },
    schedule: async input => {
      if (input.dedupKey === armedKey) calls.push('schedule');
      return server.wakes.schedule(input);
    },
  } }));
  const id = addRoutine('ordered');
  await bot.drain();
  armedKey = bot.snapshot().routines[id]!.armed!.key;
  await bot.setRoutineLifecycle(id, 'paused');
  expect(bot.snapshot().routines[id]!.status).toBe('schedule_retrying');
  await bot.setRoutineLifecycle(id, 'active');
  expect(bot.snapshot().operations.filter(o => o.state === 'pending').map(o => o.kind)).toEqual(['cancel', 'schedule']);
  const transactions = vi.spyOn(ledger, 'transaction');
  await vi.advanceTimersByTimeAsync(100);
  expect(transactions).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(59_899);
  expect(transactions).not.toHaveBeenCalled();
  expect(calls).toEqual(['cancel']);
  fail = false;
  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toEqual(['cancel', 'cancel', 'schedule']);
  expect(transactions.mock.calls.length).toBeLessThanOrEqual(10);
  expect(bot.snapshot().operations.every(o => o.state !== 'pending')).toBe(true);
  expect((await server.wakes.pending()).map(w => w.dedupKey)).toEqual([armedKey]);
});
