import { afterEach, expect, it, vi } from 'vitest';
import { hash } from '@byok-sdk/server/execution-core';
import { openHost, template, type TestHost } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration, type BotOptions } from './host';
import { deliverRoutine, seedRoutine } from './routines.test-support';
import { botCompactVeto } from './compaction';

let fixture: TestHost;
let bot: BotCollaboration;
afterEach(async () => { await bot?.close(); await fixture?.close(); });
/** Real embedded server, HTTP, daemon and submit_result helper, with input coalescing on by default. */
async function setup(rest: Partial<BotOptions> = {}) {
  const host = fixture = await openHost({ externalCore: true, ledgerOptions: { compactVeto: botCompactVeto }, consume: (wake, signal) => bot.consume(wake, signal), agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
  const base = template(host.deviceId);
  bot = new BotCollaboration(host.server, host.ledger, { botId: 'main', execution: { ...base,
    agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'coalesce' }, payload: { ...base.payload,
      messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65536 } } },
    connector: async id => ({ ok: true, externalId: id }), coalesce: {}, ...rest });
  return host;
}
const idOf = (key: string) => hash(['user', 'main', key]);
const sequence = (id: string) => bot.core.intent(id)!.sequence;
async function running(id: string) {
  await vi.waitFor(async () => { await bot.drain(); expect(fixture.adapter.sessions.has(bot.core.intent(id)?.taskId ?? '')).toBe(true); }, { timeout: 5000 });
  return fixture.adapter.sessions.get(bot.core.intent(id)!.taskId)!;
}
async function finish(id: string, document: unknown = {}) {
  await (await running(id)).finish(document);
  await vi.waitFor(async () => { await bot.drain(); expect(bot.snapshot().turns[id]?.status).toBe('succeeded'); }, { timeout: 5000 });
}
function projection(id: string) {
  return Object.values(fixture.ledger.snapshot().outbox).find(row => row.kind === 'projection' && row.id === id) as { value: Record<string, unknown> } | undefined;
}

it('without coalesce keeps one Turn, intent and execution per input (S1)', async () => {
  const host = await setup({ coalesce: undefined });
  const first = await bot.input('busy', 'Long task');
  await running(first);
  const ids = [await bot.input('o1', 'one'), await bot.input('o2', 'two')];
  expect(ids).toEqual([idOf('o1'), idOf('o2')]);
  expect(ids.map(id => bot.core.intent(id)?.source)).toEqual(['user', 'user']);
  for (const id of [first, ...ids]) await finish(id);
  expect(host.adapter.starts).toHaveLength(3);
  expect(bot.snapshot()).not.toHaveProperty('inputs');
  expect(bot.snapshot()).not.toHaveProperty('inputBatches');
  expect(Object.values(bot.snapshot().turns).some(turn => 'inputIds' in turn)).toBe(false);
});

it('runs three inputs sent while the Bot is busy as one more execution whose instruction has three frames (S3)', async () => {
  const host = await setup();
  const first = await bot.input('busy', 'Long task');
  await running(first);
  const [a, b, c] = ['m1', 'm2', 'm3'].map(key => idOf(key)) as [string, string, string];
  expect([await bot.input('m1', 'one'), await bot.input('m2', 'two'), await bot.input('m3', 'three')]).toEqual([a, a, a]);
  expect(bot.snapshot().turns[a]).toBeUndefined();
  expect(bot.core.intent(a)).toBeUndefined();
  await finish(first);
  await finish(a);
  expect(host.adapter.starts).toHaveLength(2);
  const start = host.adapter.starts[1]!;
  if (start.kind !== 'instruction') throw new Error('Expected an instruction start');
  expect(start.instruction).toContain('Request:\nThe owner sent 3 messages while you were busy. Read them in order and answer them together.\n');
  expect(start.instruction.match(/^--- message \d\/3 \(\d+ bytes\) ---$/gm)).toEqual(['--- message 1/3 (3 bytes) ---', '--- message 2/3 (3 bytes) ---', '--- message 3/3 (5 bytes) ---']);
  expect(Object.values(host.ledger.snapshot().intents).map(intent => intent.key)).toEqual([first, a]);
  expect(bot.snapshot().inputBatches![a]).toMatchObject({ state: 'sealed', sealReason: 'idle', inputIds: [a, b, c] });
  // One reply for the batch. Its owner projection names every input it answers (§4.4).
  expect(projection(`bot-turn:${a}`)?.value).toMatchObject({ status: 'succeeded', source: 'user', inputIds: [a, b, c] });
});

it('counts the window from the first input, puts later inputs in a new batch, and seals early when the Bot is idle (S4)', async () => {
  let now = Date.now();
  const host = await setup({ now: () => now });
  const first = await bot.input('busy', 'Long task');
  await running(first);
  const [a, b, c] = ['w1', 'w2', 'w3'].map(key => idOf(key)) as [string, string, string];
  await bot.input('w1', 'one');
  now += 9_999;
  expect(await bot.input('w2', 'two')).toBe(a);
  now += 1;
  await bot.drain();
  expect(bot.snapshot().inputBatches![a]).toMatchObject({ state: 'sealed', sealReason: 'window', inputIds: [a, b], sealAt: now });
  expect(bot.core.intent(a)?.phase).toBe('queued');
  // The batch is in K4 already, so a later input starts another batch.
  expect(await bot.input('w3', 'three')).toBe(c);
  expect(bot.snapshot().inputBatches![c]).toMatchObject({ state: 'open', inputIds: [c], sealAt: now + 10_000 });
  await finish(first);
  expect(bot.snapshot().inputBatches![c]!.state).toBe('open');
  await finish(a);
  expect(bot.snapshot().inputBatches![c]).toMatchObject({ state: 'sealed', sealReason: 'idle' });
  expect(now).toBeLessThan(bot.snapshot().inputBatches![c]!.sealAt);
  await finish(c);
  expect([first, a, c].map(sequence)).toEqual([...[first, a, c].map(sequence)].sort((x, y) => x - y));
  expect(host.adapter.starts).toHaveLength(3);
});

it('seals the open batch before answer, action_result, routine and continuation Turns, in arrival order (S5)', async () => {
  await setup();
  const setupTurn = await bot.input('setup', 'Ask me and draft a message');
  await finish(setupTurn, { ask_user: { question: 'Continue?', answerKind: 'text' },
    confirmable_action: [{ action: 'send_message', summary: 'Send', draft: { text: 'hello' } }] });
  const question = Object.values(bot.snapshot().questions)[0]!, card = Object.values(bot.snapshot().cards)[0]!;
  const routineId = await seedRoutine(bot, 'seed', 'Daily report');
  await bot.drain();
  const first = await bot.input('busy', 'Long task');
  await running(first);
  const [u1, u2, u3, u4] = ['u1', 'u2', 'u3', 'u4'].map(key => idOf(key)) as [string, string, string, string];
  await bot.input('u1', 'before the answer');
  await bot.answer(question.id, 'Yes');
  await bot.input('u2', 'before the decision');
  await bot.decide(card.id, 'rejected');
  await bot.input('u3', 'before the routine');
  await deliverRoutine(bot, routineId, Date.now());
  await bot.input('u4', 'before the continuation');
  await finish(first, { delegate: [{ to: 'main', request: 'Continue the long task' }] });
  const turns = Object.values(bot.snapshot().turns);
  const of = (source: string) => turns.find(turn => turn.source === source)!.id;
  // The boundary seal keeps every non-autonomous Turn in arrival order. #1229 item 1 then puts the user input u4,
  // frozen after the queued, never-submitted routine Turn, ahead of it. The continuation arrives later, so it stays
  // after both. The routine Turn's own arrival order is unchanged; only a user intent moves ahead of it.
  const order = [first, u1, of('answer'), u2, of('action_result'), u3, u4, of('routine'), of('continuation')];
  expect(order.map(sequence)).toEqual([...order.map(sequence)].sort((x, y) => x - y));
  expect(sequence(u4)).toBeLessThan(sequence(of('routine')));
  for (const id of [u1, u2, u3, u4]) expect(bot.snapshot().inputBatches![id]).toMatchObject({ state: 'sealed', sealReason: 'boundary', inputIds: [id] });
});

it('cancels a whole batch through a member id, before and after the batch reaches K4', async () => {
  let now = Date.now();
  const host = await setup({ now: () => now });
  const first = await bot.input('busy', 'Long task');
  await running(first);
  const [a, b, c, d] = ['c1', 'c2', 'c3', 'c4'].map(key => idOf(key)) as [string, string, string, string];
  await bot.input('c1', 'one');
  await bot.input('c2', 'two');
  await bot.cancelTurn(b);
  expect(bot.snapshot().inputBatches![a]).toMatchObject({ state: 'sealed', sealReason: 'cancel', inputIds: [a, b] });
  expect(bot.snapshot().turns[a]).toMatchObject({ status: 'failed', conclusion: 'cancelled', inputIds: [a, b] });
  expect(bot.core.intent(a)).toBeUndefined();
  expect(projection(`bot-turn:${a}`)?.value).toMatchObject({ conclusion: 'cancelled', inputIds: [a, b] });
  expect(await bot.input('c2', 'two')).toBe(a);
  await bot.input('c3', 'three');
  await bot.input('c4', 'four');
  now += 10_000;
  await bot.drain();
  expect(bot.core.intent(c)?.phase).toBe('queued');
  await bot.cancelTurn(d);
  await vi.waitFor(async () => { await bot.drain(); expect(bot.snapshot().turns[c]).toMatchObject({ status: 'failed', conclusion: 'cancelled', inputIds: [c, d] }); }, { timeout: 5000 });
  expect(bot.core.intent(c)?.conclusion).toBe('cancelled');
  await finish(first);
  expect(host.adapter.starts).toHaveLength(1);
});
