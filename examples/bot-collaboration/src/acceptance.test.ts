import { afterEach, expect, it, vi } from 'vitest';
import { openHost, template, type TestHost } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration, type BotOptions } from './host';
import { stateOf } from './model';
import { hash, type Json } from '@byok-sdk/server/execution-core';
import { botCompactVeto } from './compaction';

let fixture: TestHost | undefined;
let bot: BotCollaboration | undefined;
afterEach(async () => { await bot?.close(); await fixture?.close(); vi.restoreAllMocks(); });
async function setup(rest: Partial<BotOptions> = {}) {
  fixture = await openHost({ externalCore: true, ledgerOptions: { compactVeto: botCompactVeto }, consume: (wake, signal) => bot!.consume(wake, signal),
    agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
  const base = template(fixture.deviceId);
  const options: BotOptions = { botId: 'main', execution: { ...base,
    agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'acceptance' }, payload: { ...base.payload,
      messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65536 },
    } }, connector: async id => ({ externalId: id }), ...rest };
  bot = new BotCollaboration(fixture.server, fixture.ledger, options);
  // Test fixture: these cases exercise the actions the Main Bot applies. The product default is observe (#1229);
  // autonomy.test.ts owns that default.
  fixture.ledger.transaction(s => { stateOf(s.application).team.bots.main!.autonomy = 'auto'; });
  return options;
}
async function finish(id: string, outcome: unknown = {}) {
  await vi.waitFor(() => expect(fixture!.adapter.sessions.has(bot!.core.intent(id)!.taskId)).toBe(true), { timeout: 5000 });
  fixture!.adapter.sessions.get(bot!.core.intent(id)!.taskId)!.finish(outcome);
  await vi.waitFor(async () => { await bot!.drain(); expect(bot!.snapshot().turns[id]?.status).toBe('succeeded'); }, { timeout: 5000 });
}
const action = { action: 'send_message', summary: 'Send', draft: { text: 'hello' } };

it('keeps an expired card in the next ContextPack without creating a model turn', async () => {
  let now = Date.now();
  const connector = vi.fn(async () => ({ ok: true }));
  await setup({ now: () => now, connector });
  const root = await bot!.input('ignored-card', 'Prepare a draft');
  await finish(root, { confirmable_action: [action] });
  const card = Object.values(bot!.snapshot().cards)[0]!;
  const starts = fixture!.adapter.starts.length;
  now += 86_400_001;
  await bot!.drain();
  expect(bot!.snapshot().cards[card.id]!.state).toBe('expired');
  expect(Object.values(bot!.snapshot().turns)).toHaveLength(1);
  expect(fixture!.adapter.starts).toHaveLength(starts);
  await expect(bot!.decide(card.id, 'confirmed')).rejects.toThrow('Card expired');
  expect(connector).not.toHaveBeenCalled();
  const next = await bot!.input('after-expiry', 'What changed?');
  const offer = await fixture!.server.tasks.offer(bot!.core.intent(next)!.taskId);
  if (!offer || !('instruction' in offer.payload)) throw new Error('Expected an instruction offer');
  const context = JSON.parse(String(offer.payload.instruction).split('\n\nContextPack:\n')[1]!);
  expect(context.cards).toContainEqual(expect.objectContaining({ id: card.id, state: 'expired' }));
  await finish(next);
});

it('bounds an uncooperative connector and releases queued input, answer, decision and wake calls', async () => {
  let signal: AbortSignal | undefined;
  let complete!: (value: Json) => void;
  await setup({ connectorTimeoutMs: 50, connector: async (_id, _action, _draft, inputSignal) => {
    signal = inputSignal;
    return new Promise<Json>(resolve => { complete = resolve; });
  } });
  const root = await bot!.input('hung-connector', 'Send');
  await finish(root, { confirmable_action: [action], ask_user: { question: 'Continue?', answerKind: 'text' } });
  const card = Object.values(bot!.snapshot().cards)[0]!;
  const question = Object.values(bot!.snapshot().questions)[0]!;
  const decision = bot!.decide(card.id, 'confirmed');
  const input = bot!.input('during-connector', 'New input');
  const answer = bot!.answer(question.id, 'Yes');
  const conflict = expect(bot!.decide(card.id, 'rejected')).rejects.toThrow('Card already confirmed');
  const wake = bot!.consume({ wakeId: 'malformed', dedupKey: 'malformed', availableAt: Date.now(), deliveredAt: Date.now(), delivery: 1 }, new AbortController().signal);
  const [, inputId] = await Promise.all([decision, input, answer, conflict, wake]);
  expect(signal?.aborted).toBe(true);
  expect(bot!.snapshot().turns[inputId!]).toBeDefined();
  expect(Object.values(bot!.snapshot().questions)[0]!.answer).toBe('Yes');
  expect(fixture!.ledger.snapshot().ignoredWakes).toContainEqual(expect.objectContaining({ reason: 'unknown_key', wakeKeyHash: hash('malformed') }));
  expect(bot!.snapshot().cards[card.id]!.error).toContain('Connector timed out');
  expect(bot!.snapshot().cards[card.id]!.conclusion).toBe('failed');
  complete({ externalId: 'late-result' });
  await bot!.drain();
  expect(bot!.snapshot().cards[card.id]!.result).toBeUndefined();
  expect(Object.values(bot!.snapshot().turns).find(t => t.source === 'action_result')!.request).toContain('Connector timed out');
});

it('does not restore an uploaded decision projection after sync or restart', async () => {
  const options = await setup();
  const root = await bot!.input('projection', 'Prepare a draft');
  await finish(root, { confirmable_action: [action] });
  const card = Object.values(bot!.snapshot().cards)[0]!;
  await bot!.decide(card.id, 'rejected');
  const result = Object.values(bot!.snapshot().turns).find(t => t.source === 'action_result')!;
  await finish(result.id);
  const ids: string[] = [];
  const upload = async (id: string) => { ids.push(id); };
  await bot!.core.flushProjections(upload);
  await bot!.drain();
  await bot!.core.flushProjections(upload);
  await bot!.close();
  bot = new BotCollaboration(fixture!.server, fixture!.ledger, options);
  await bot.recover();
  await bot.core.flushProjections(upload);
  expect(ids.filter(id => id === `card:${card.id}:rejected`)).toHaveLength(1);
  expect(bot.snapshot().cards[card.id]!.decisionReported).toBe(true);
});

it('rejects conflicting decisions and preserves same-decision replay', async () => {
  await setup();
  const root = await bot!.input('decisions', 'Prepare a draft');
  await finish(root, { confirmable_action: [action] });
  const card = Object.values(bot!.snapshot().cards)[0]!;
  await bot!.decide(card.id, 'rejected');
  await expect(bot!.decide(card.id, 'confirmed')).rejects.toThrow('Card already rejected');
  await bot!.decide(card.id, 'rejected');
  expect(Object.values(bot!.snapshot().turns).filter(t => t.source === 'action_result')).toHaveLength(1);
});

it('applies routine policy before questions and delegation, and publishes cards before questions', async () => {
  await setup();
  const root = await bot!.input('ordered-actions', 'Prepare actions');
  fixture!.ledger.transaction(s => { stateOf(s.application).budgets[root]!.continuation = 4; });
  await finish(root, { create_routine: [{ localId: 'new_routine_1', schedule: { minute: 0, hour: 9, dayOfMonth: 31, month: 4, tz: 'UTC' }, prompt: 'invalid' }],
    confirmable_action: [action], ask_user: { question: 'Choose', answerKind: 'single_choice', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] },
    delegate: [{ to: 'main', request: 'continue' }] });
  expect(bot!.snapshot().rejected.map(r => r.action)).toEqual(['create_routine', 'ask_user', 'delegate']);
  const next = await bot!.input('ordered-projections', 'Prepare cards');
  const prior = new Set(Object.keys(fixture!.ledger.snapshot().outbox));
  await finish(next, { confirmable_action: [action], ask_user: { question: 'Choose', answerKind: 'text' } });
  const projections = Object.entries(fixture!.ledger.snapshot().outbox).filter(([key, row]) => !prior.has(key) && row.kind === 'projection')
    .map(([, row]) => row.kind === 'projection' ? row.id.split(':')[0] : '');
  expect(projections.slice(0, 2)).toEqual(['card', 'question']);
});

it('uses state version 3 and rejects version 1, version 2, unsupported or unversioned saved state without resetting it', () => {
  expect(stateOf({}).version).toBe(3);
  const savedStates: Array<[Json, string]> = [
    [{ version: 1, sequence: 7 }, 'Bot collaboration state version 1 is not supported. Bot routines moved to K4 routines.'],
    [{ version: 2, sequence: 7 }, 'Bot collaboration state version 2 is not supported. Retention moved settled rows out of the state.'],
    [{ version: 4, sequence: 7 }, 'Unsupported Bot collaboration state version'], [{ sequence: 7 }, 'Unsupported Bot collaboration state version']];
  for (const [saved, message] of savedStates) {
    const application: Record<string, Json> = { collaboration: saved };
    expect(() => stateOf(application)).toThrow(message);
    expect(application.collaboration).toBe(saved);
  }
});

it('refreshes expiry before freezing the next input without an intervening drain', async () => {
  let now = Date.now();
  await setup({ now: () => now });
  const root = await bot!.input('expiry-race', 'Prepare a draft');
  await finish(root, { confirmable_action: [action] });
  const card = Object.values(bot!.snapshot().cards)[0]!;
  now += 86_400_001;
  const next = await bot!.input('expiry-direct-input', 'What changed?');
  const offer = await fixture!.server.tasks.offer(bot!.core.intent(next)!.taskId);
  if (!offer || !('instruction' in offer.payload)) throw new Error('Expected an instruction offer');
  const context = JSON.parse(String(offer.payload.instruction).split('\n\nContextPack:\n')[1]!);
  expect(context.cards).toContainEqual(expect.objectContaining({ id: card.id, state: 'expired' }));
  expect(Object.values(bot!.snapshot().turns)).toHaveLength(2);
  await finish(next);
});
