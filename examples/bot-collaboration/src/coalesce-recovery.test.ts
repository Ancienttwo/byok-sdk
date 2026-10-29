import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createByokServer } from '@byok-sdk/server';
import { hash, HostLedger } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration, type BotOptions } from './host';
import { botCompactVeto } from './compaction';

const idOf = (key: string) => hash(['user', 'main', key]);
let root: string | undefined;
let close: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of close.reverse()) await step();
  close = [];
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
/**
 * Real SDK server and Host ledger without a device: an offer freezes its input and then waits,
 * so the first Turn keeps the Bot busy. `restart` drops the Host and reopens the same ledger file.
 */
async function open(options: Partial<BotOptions>) {
  root = await mkdtemp(path.join(tmpdir(), 'bot-coalesce-recovery-'));
  const server = createByokServer({ productId: 'coalesce-recovery', storage: { kind: 'sqlite', path: path.join(root, 'server.sqlite') }, wake: { consume: async () => {} } });
  let ledger = new HostLedger(path.join(root, 'host.sqlite'), 'coalesce-recovery', { compactVeto: botCompactVeto });
  const start = () => new BotCollaboration(server, ledger, { botId: 'main', execution: template('device'), connector: async () => null, coalesce: {}, ...options });
  const fixture = {
    bot: start(), get ledger() { return ledger; },
    async restart(next: Partial<BotOptions> = {}) {
      await fixture.bot.close(); ledger.close();
      ledger = new HostLedger(path.join(root!, 'host.sqlite'), 'coalesce-recovery', { compactVeto: botCompactVeto });
      options = { ...options, ...next };
      fixture.bot = start();
      await fixture.bot.recover();
    },
  };
  close.push(() => server.close(), () => ledger.close(), () => fixture.bot.close());
  return fixture;
}
function batchProjections(ledger: HostLedger) {
  return Object.fromEntries(Object.values(ledger.snapshot().outbox)
    .flatMap(row => row.kind === 'projection' && row.id.startsWith('input-batch:') ? [[row.id, row.value]] : []));
}

it('seals an open batch at its window end from the Host timer, with no other Host call', async () => {
  let now = 1_000_000;
  const { bot } = await open({ now: () => now });
  const busy = await bot.input('busy', 'Long task');
  const [a, b] = [idOf('a'), idOf('b')];
  await bot.input('a', 'one'); await bot.input('b', 'two');
  expect(bot.snapshot().inputBatches![a]).toMatchObject({ state: 'open', sealAt: 1_010_000 });
  now = 1_009_999;
  await bot.drain();
  expect(bot.snapshot().inputBatches![a]!.state).toBe('open');
  // The next timer is due in 1 ms. Only that timer can seal the batch now.
  now = 1_010_000;
  await vi.waitFor(() => expect(bot.snapshot().inputBatches![a]).toMatchObject({ state: 'sealed', sealReason: 'window', inputIds: [a, b] }));
  expect(bot.core.intent(a)?.phase).toBe('queued');
  expect(bot.core.intent(busy)!.sequence).toBeLessThan(bot.core.intent(a)!.sequence);
});

it('recovers an open batch after a crash as one Turn and one intent, and replayed inputs never join twice', async () => {
  let now = 1_000_000;
  const fixture = await open({ now: () => now });
  const busy = await fixture.bot.input('busy', 'Long task');
  const [a, b] = [idOf('a'), idOf('b')];
  await fixture.bot.input('a', 'one'); await fixture.bot.input('b', 'two');
  // Crash after both appends committed, before the window end.
  now = 1_005_000;
  await fixture.restart();
  expect(fixture.bot.snapshot().inputBatches![a]).toMatchObject({ state: 'open', inputIds: [a, b], sealAt: 1_010_000 });
  expect([await fixture.bot.input('a', 'one'), await fixture.bot.input('b', 'two')]).toEqual([a, a]);
  await expect(fixture.bot.input('b', 'changed')).rejects.toThrow('Input identity conflict');
  expect(fixture.bot.snapshot().inputBatches![a]!.inputIds).toEqual([a, b]);
  expect(fixture.bot.snapshot().turns[a]).toBeUndefined();
  // Crash again after the window end. recover() seals the batch before any new input.
  now = 1_010_000;
  await fixture.restart();
  await fixture.bot.recover();
  expect(fixture.bot.snapshot().inputBatches![a]).toMatchObject({ state: 'sealed', sealReason: 'window', inputIds: [a, b] });
  expect([await fixture.bot.input('a', 'one'), await fixture.bot.input('b', 'two')]).toEqual([a, a]);
  const users = Object.values(fixture.bot.snapshot().turns).filter(turn => turn.source === 'user');
  expect(users.map(turn => [turn.id, turn.inputIds])).toEqual([[busy, [busy]], [a, [a, b]]]);
  expect(Object.values(fixture.ledger.snapshot().intents).map(intent => intent.key)).toEqual([busy, a]);
  expect(Object.keys(fixture.bot.snapshot().inputs!)).toEqual([busy, a, b]);
});

it('projects revision 1 when a batch opens and revision 2 when it seals; an idle batch projects only revision 2', async () => {
  let now = 1_000_000;
  const fixture = await open({ now: () => now });
  const busy = await fixture.bot.input('busy', 'Long task');
  expect(batchProjections(fixture.ledger)).toEqual({ [`input-batch:${busy}:2`]: { owner: 'main', id: busy, revision: 2, state: 'sealed',
    sealReason: 'idle', inputIds: [busy], openedAt: 1_000_000, sealAt: 1_010_000 } });
  const [a, b] = [idOf('a'), idOf('b')];
  now = 1_001_000; await fixture.bot.input('a', 'one');
  now = 1_002_000; await fixture.bot.input('b', 'two');
  const opened = { owner: 'main', id: a, revision: 1, state: 'open', inputIds: [a], openedAt: 1_001_000, sealAt: 1_011_000 };
  expect(batchProjections(fixture.ledger)[`input-batch:${a}:1`]).toEqual(opened);
  // A restart and replayed inputs publish nothing new and hit no projection identity conflict.
  await fixture.restart();
  expect([await fixture.bot.input('a', 'one'), await fixture.bot.input('b', 'two')]).toEqual([a, a]);
  expect(Object.keys(batchProjections(fixture.ledger))).toEqual([`input-batch:${busy}:2`, `input-batch:${a}:1`]);
  now = 1_011_000;
  await fixture.restart();
  expect(batchProjections(fixture.ledger)).toMatchObject({ [`input-batch:${a}:1`]: opened, [`input-batch:${a}:2`]: { owner: 'main', id: a, revision: 2,
    state: 'sealed', sealReason: 'window', inputIds: [a, b], openedAt: 1_001_000, sealAt: 1_011_000 } });
  await fixture.restart();
  await fixture.bot.input('a', 'one');
  expect(Object.keys(batchProjections(fixture.ledger))).toEqual([`input-batch:${busy}:2`, `input-batch:${a}:1`, `input-batch:${a}:2`]);
});

it('publishes no input-batch projection without coalesce', async () => {
  const { bot, ledger } = await open({ coalesce: undefined });
  await bot.input('busy', 'Long task'); await bot.input('a', 'one');
  expect(batchProjections(ledger)).toEqual({});
});
