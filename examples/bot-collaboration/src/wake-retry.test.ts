import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createByokServer } from '@byok-sdk/server';
import type { ExecutionServer } from '@byok-sdk/example-host-execution-core';
import { hash, HostLedger } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration } from './host';
import { routineOf, seedRoutine } from './routines.test-support';

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
