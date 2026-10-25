import { afterEach, expect, it, vi } from 'vitest';
import { canonical, hash } from '@byok-sdk/example-host-execution-core';
import { openHost, template, type TestHost } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration } from './host';
import type { ContextTurn } from './schema';
import { botCompactVeto } from './compaction';

let fixture: TestHost | undefined, bot: BotCollaboration | undefined;
afterEach(async () => { await bot?.close(); await fixture?.close(); bot = fixture = undefined; });

const INJECTED: ContextTurn[] = [
  { id: 'cloud-1', root: 'cloud-1', source: 'user', request: 'Injected earlier request', hop: 0, status: 'succeeded', conclusion: 'succeeded', outcomeSummary: [] },
  { id: 'cloud-2', root: 'cloud-2', source: 'user', request: 'Injected later request', hop: 0, status: 'succeeded', outcomeSummary: ['ask_user'] },
];
/** Real SQLite HostLedger, embedded server, HTTP and daemon. The history authority is a scripted function. */
async function open(history: (input: { botId: string; turnId: string }) => Promise<readonly ContextTurn[]>, historyTimeoutMs?: number) {
  fixture = await openHost({ externalCore: true, ledgerOptions: { compactVeto: botCompactVeto }, consume: (wake, signal) => bot!.consume(wake, signal) });
  bot = new BotCollaboration(fixture.server, fixture.ledger, { botId: 'main', connector: async () => null, execution: template(fixture.deviceId), history, historyTimeoutMs });
  return { fixture, bot };
}
function contextOf(host: BotCollaboration, turnId: string): { turns: unknown[] } {
  const instruction = host.core.intent(turnId)!.execution.payload.instruction;
  if (typeof instruction !== 'string') throw new Error('Expected an inline instruction');
  return JSON.parse(instruction.slice(instruction.indexOf('\nContextPack:\n') + '\nContextPack:\n'.length)) as { turns: unknown[] };
}

it('#606 acceptance 4: the ContextPack has the injected history, and the collaboration state stores none of it', async () => {
  const reads: Array<{ botId: string; turnId: string }> = [];
  const { fixture, bot } = await open(async input => { reads.push(input); return INJECTED; });
  const first = await bot.input('k1', 'First');
  expect(reads).toEqual([{ botId: 'main', turnId: first }]);
  expect(contextOf(bot, first).turns).toEqual(INJECTED);
  expect(bot.snapshot().turns[first]!.historyDigest).toBe(hash(canonical(INJECTED)));
  const stored = JSON.stringify(bot.snapshot());
  for (const row of INJECTED) {
    expect(stored).not.toContain(row.request);
    expect(stored).not.toContain(row.id);
  }
  // The device's own earlier Turn is not history in this mode: only the authority's rows are.
  await vi.waitFor(async () => { await bot.drain(); expect(fixture.adapter.sessions.has(bot.core.intent(first)!.taskId)).toBe(true); });
  fixture.adapter.sessions.get(bot.core.intent(first)!.taskId)!.finish({});
  await vi.waitFor(async () => { await bot.drain(); expect(bot.snapshot().turns[first]!.status).toBe('succeeded'); });
  const second = await bot.input('k2', 'Second');
  expect(contextOf(bot, second).turns.map(row => (row as ContextTurn).id)).toEqual(['cloud-1', 'cloud-2']);
});

it('leaves a Turn queued while its history read fails or returns another shape, and freezes it after a good read', async () => {
  // The timer can read again at any time, so each answer holds until the test changes it.
  let mode: 'offline' | 'bad' | 'good' = 'offline';
  const { bot } = await open(async () => {
    if (mode === 'offline') throw new Error('authority offline');
    return (mode === 'bad' ? [{ id: 'bad' }] : INJECTED) as readonly ContextTurn[];
  });
  const turnId = await bot.input('k1', 'First');
  expect(bot.core.intent(turnId)).toBeUndefined();
  expect(bot.snapshot().turns[turnId]).toMatchObject({ status: 'queued' });
  mode = 'bad';
  await bot.drain();
  expect(bot.core.intent(turnId)).toBeUndefined();
  mode = 'good';
  await bot.drain();
  expect(contextOf(bot, turnId).turns).toEqual(INJECTED);
});

it('counts a history read still open after historyTimeoutMs as failed, so the Turn stays queued and the Host keeps working', async () => {
  let stall = true;
  const { bot } = await open(async () => stall ? new Promise<never>(() => {}) : INJECTED, 50);
  const turnId = await bot.input('k1', 'First');
  expect(bot.core.intent(turnId)).toBeUndefined();
  expect(bot.snapshot().turns[turnId]).toMatchObject({ status: 'queued' });
  // The exclusive queue is free: another input still commits while the authority stalls.
  const other = await bot.input('k2', 'Second');
  expect(bot.core.intent(other)).toBeUndefined();
  stall = false;
  await bot.drain();
  expect(contextOf(bot, turnId).turns).toEqual(INJECTED);
});

it('refuses a history timeout outside 1 ms to 2^31 - 1 ms', async () => {
  fixture = await openHost({ externalCore: true, ledgerOptions: { compactVeto: botCompactVeto }, consume: (wake, signal) => bot!.consume(wake, signal) });
  for (const historyTimeoutMs of [0, 2_147_483_648, 1.5]) {
    expect(() => new BotCollaboration(fixture!.server, fixture!.ledger, { botId: 'main', connector: async () => null, execution: template(fixture!.deviceId),
      historyTimeoutMs })).toThrow(/Invalid history timeout|nonnegative safe integer/);
  }
});
