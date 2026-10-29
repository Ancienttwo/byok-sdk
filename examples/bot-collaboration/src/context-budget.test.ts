import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as protocol from '@byok-sdk/protocol';
import { createByokServer } from '@byok-sdk/server';
import { hash, HostLedger } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration, type BotOptions } from './host';
import { stateOf } from './model';
import { contextPack } from './schema';
import { roomFields } from './team';
import { botRoutines, createDefinition, updateDefinition } from './routines';
import { deliverRoutine, routineOf, routineRow, seedRoutine } from './routines.test-support';
import { botCompactVeto } from './compaction';

let root: string | undefined;
let ledger: HostLedger | undefined;
let server: ReturnType<typeof createByokServer> | undefined;
let bot: BotCollaboration | undefined;
afterEach(async () => {
  await bot?.close(); await server?.close(); ledger?.close();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined; ledger = undefined; server = undefined; bot = undefined;
  vi.useRealTimers(); vi.restoreAllMocks();
});
async function setup(options: Partial<BotOptions> = {}) {
  root = await mkdtemp(path.join(tmpdir(), 'bot-context-'));
  ledger = new HostLedger(path.join(root, 'host.sqlite'), 'context-test', { compactVeto: botCompactVeto });
  server = createByokServer({ productId: 'context-test', storage: { kind: 'sqlite', path: path.join(root, 'server.sqlite') }, wake: { consume: async () => {} } });
  bot = new BotCollaboration(server, ledger, { botId: 'main', execution: template('device'), connector: async () => null, ...options });
}

it('selects a declared recent window, summarizes outcomes and includes only current routine definitions', () => {
  const state = stateOf({});
  for (let n = 0; n < 20; n++) state.turns[`turn-${n}`] = { id: `turn-${n}`, root: 'root', botId: 'main', source: 'user', request: `request-${n}`,
    hop: 0, status: 'succeeded', outcome: { delegate: [{ to: 'main', request: 'full-document-must-stay-out' }] } };
  state.rejected.push({ botId: 'main', taskId: 'old', action: 'delegate', reason: 'seen', consumedBy: 'old-turn' }, { botId: 'main', taskId: 'new', action: 'delegate', reason: 'unseen' });
  // An idle routine switches to its update at once, so the K4 row holds only the current definition.
  const routine = routineRow(createDefinition([], 'main', 'seed', 0, { localId: 'new_routine_1', schedule: { minute: 0, hour: 9, tz: 'UTC' }, prompt: 'old-definition' }, 'bot'));
  routine.definition = updateDefinition([routine], 'main', { routineId: routine.definition.id, prompt: 'current-definition' });
  const context = contextPack(state, 3, undefined, undefined, undefined, undefined, undefined, botRoutines([routine]));
  expect(context.historyWindow).toEqual({ turnLimit: 3, omittedTurns: 17,
    omittedCards: 0, omittedQuestions: 0, omittedPendingCards: 0, omittedPendingQuestions: 0,
    maxBytes: 32768, omittedMessages: 0, omittedRejections: 0, currentRequestBytes: 0, metadataOverBudget: false, notice: 'Earlier history was omitted.' });
  expect(context.turns.map(t => t.id)).toEqual(['turn-17', 'turn-18', 'turn-19']);
  expect(context.turns.every(t => t.outcomeSummary.includes('delegate'))).toBe(true);
  expect(JSON.stringify(context)).not.toContain('full-document-must-stay-out');
  expect(context.rejectedActions.map(r => r.reason)).toEqual(['unseen']);
  expect(context.routines[0]!.definition!.prompt).toBe('current-definition');
  expect(JSON.stringify(context)).not.toContain('old-definition');
  expect(context.routines[0]).not.toHaveProperty('versions');
});

it('blocks an oversized UTF-8 ContextPack with a readable reason and no retry spin or execution', async () => {
  vi.useFakeTimers();
  await setup({ contextMaxBytes: 1024 });
  const submit = vi.spyOn(server!.executions, 'submit');
  const id = await bot!.input('too-large', '😀'.repeat(1024));
  expect(bot!.snapshot().turns[id]).toMatchObject({ status: 'blocked', blockedReason: expect.stringContaining('budget is 1024 bytes') });
  expect(bot!.core.intent(id)).toBeUndefined();
  expect(submit).not.toHaveBeenCalled();
  expect(Object.values(ledger!.snapshot().outbox)).toContainEqual(expect.objectContaining({ kind: 'projection', value: expect.objectContaining({ turnId: id, reason: expect.stringContaining('Current Request') }) }));
  const transactions = vi.spyOn(ledger!, 'transaction');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(transactions).not.toHaveBeenCalled();
});

it('blocks a schema still above its cap after flat fallback without dropping authorized ids', async () => {
  await setup();
  const compose = vi.spyOn(protocol, 'composeBotTurnOutcomeSchema').mockImplementation(() => {
    throw new protocol.BotTurnOutcomeSchemaError('schema-over-budget', 'still too large');
  });
  const id = await bot!.input('schema-cap', 'request');
  expect(compose).toHaveBeenCalled();
  for (const [fragments] of compose.mock.calls) {
    expect(fragments.create_routine!.items!.properties!.localId!.enum).toEqual(['new_routine_1']);
  }
  expect(compose.mock.calls.some(([fragments]) => fragments.create_routine!.items!.properties!.schedule!.oneOf === undefined)).toBe(true);
  expect(bot!.snapshot().turns[id]).toMatchObject({ status: 'blocked', blockedReason: expect.stringContaining('after flat fallback') });
  expect(bot!.core.intent(id)).toBeUndefined();
});

it('reserves rejected feedback in frozen input and releases it when the execution never starts', async () => {
  await setup();
  ledger!.transaction(s => { stateOf(s.application).rejected.push({ botId: 'main', taskId: 'prior', action: 'delegate', reason: 'not-yet-seen' }); });
  const first = await bot!.input('first-reader', 'read feedback');
  const task = bot!.core.intent(first)!.taskId;
  const frozen = structuredClone(ledger!.snapshot().executions[task]!.input);
  expect(String(frozen.payload.instruction)).toContain('not-yet-seen');
  expect(bot!.snapshot().rejected[0]!.consumedBy).toBe(first);
  await bot!.drain();
  expect(ledger!.snapshot().executions[task]!.input).toEqual(frozen);
  await bot!.cancelTurn(first);
  expect(bot!.core.intent(first)!.conclusion).toBe('cancelled');
  expect(bot!.snapshot().rejected[0]!.consumedBy).toBeUndefined();
  const next = await bot!.input('next-reader', 'read feedback');
  expect(bot!.snapshot().rejected[0]!.consumedBy).toBe(next);
});

it('reduces older history with an explicit notice when the current request fits', () => {
  const state = stateOf({});
  for (let n = 0; n < 2; n++) state.turns[`large-${n}`] = { id: `large-${n}`, root: 'root', botId: 'main', source: 'user',
    request: 'x'.repeat(18_000), hop: 0, status: 'succeeded' };
  const context = contextPack(state, 12);
  expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(32 * 1024);
  expect(context.historyWindow.omittedTurns).toBe(1);
  expect(context.turns.map(turn => turn.id)).toEqual(['large-1']);
});

it('admits a new turn after large settled cards and questions fill the history', async () => {
  await setup();
  ledger!.transaction(s => {
    const state = stateOf(s.application);
    state.cards.pending = { id: 'pending', turnId: 'old-0', state: 'pending', expiresAt: Date.now() + 86_400_000,
      action: { action: 'send_message', summary: 'Send', draft: { text: 'approve this' } } };
    state.questions.pending = { id: 'pending', turnId: 'old-0', value: { question: 'answer this', answerKind: 'text' } };
    for (let n = 0; n < 40; n++) {
      const id = `old-${n}`;
      state.turns[id] = { id, root: id, botId: 'main', source: 'user', request: 'old request', hop: 0, status: 'succeeded', conclusion: 'succeeded' };
      const reply = hash(['action_result', id]);
      state.turns[reply] = { id: reply, root: id, botId: 'main', source: 'action_result', request: 'old result', hop: 0, status: 'succeeded', conclusion: 'succeeded' };
      state.cards[id] = { id, turnId: id, state: 'confirmed', expiresAt: Date.now() + 86_400_000,
        action: { action: 'send_message', summary: 'Send', draft: { text: '😀'.repeat(1000) } }, result: { sent: true }, decisionReported: true };
      state.questions[id] = { id, turnId: id, value: { question: 'x'.repeat(1000), answerKind: 'text' }, answer: 'x'.repeat(1000) };
    }
  });
  const id = await bot!.input('after-card-history', 'new request');
  expect(bot!.snapshot().turns[id]!.status).toBe('processing');
  const task = bot!.core.intent(id)!.taskId;
  const instruction = String(ledger!.snapshot().executions[task]!.input.payload.instruction);
  const context = JSON.parse(instruction.split('\n\nContextPack:\n')[1]!);
  expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(32 * 1024);
  expect(context.cards.length).toBeLessThanOrEqual(12);
  expect(context.questions.length).toBeLessThanOrEqual(12);
  expect(context.cards).toContainEqual(expect.objectContaining({ id: 'pending' }));
  expect(context.questions).toContainEqual(expect.objectContaining({ id: 'pending' }));
  expect(context.questions).toContainEqual(expect.objectContaining({ id: 'old-39' }));
  expect(context.questions).not.toContainEqual(expect.objectContaining({ id: 'old-0' }));
  expect(context.cards).not.toContainEqual(expect.objectContaining({ id: 'old-0' }));
  expect(context.historyWindow.omittedCards).toBe(41 - context.cards.length);
  expect(context.historyWindow.omittedQuestions).toBe(41 - context.questions.length);
  expect(instruction.split('\n\nContextPack:\n')[0]).toContain('Request:\nnew request');
  expect(context.turns.some((turn: { id: string }) => turn.id === id)).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(context)) + context.historyWindow.currentRequestBytes).toBeLessThanOrEqual(32 * 1024);
  expect(Object.keys(bot!.snapshot().cards)).toHaveLength(41);
  expect(Object.keys(bot!.snapshot().questions)).toHaveLength(41);
});

it('bounds pending context too and counts pending omissions without hiding the current request', () => {
  const state = stateOf({});
  state.turns.current = { id: 'current', root: 'root', botId: 'main', source: 'user', request: 'small request', hop: 0, status: 'queued' };
  for (let n = 0; n < 20; n++) {
    const id = `pending-${n}`;
    state.cards[id] = { id, turnId: 'old', state: 'pending', expiresAt: Date.now() + 86_400_000,
      action: { action: 'send_message', summary: 'Send', draft: { text: 'x'.repeat(1000) } } };
    state.questions[id] = { id, turnId: 'old', value: { question: 'x'.repeat(1000), answerKind: 'text' } };
  }
  const context = contextPack(state, 12, 'current', 4096);
  expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(4096);
  expect(context.turns[0]!.request).toBe('small request');
  expect(context.historyWindow).toMatchObject({ omittedCards: 20 - context.cards.length,
    omittedQuestions: 20 - context.questions.length, omittedPendingCards: 20 - context.cards.length,
    omittedPendingQuestions: 20 - context.questions.length });
});

it('cannot admit an unchanged oversized request by aging it out of the history window', async () => {
  await setup();
  const oversized = await bot!.input('oversized-current', 'x'.repeat(40_000));
  expect(bot!.snapshot().turns[oversized]!.status).toBe('blocked');
  for (let n = 0; n < 13; n++) await bot!.input(`short-${n}`, 'short');
  expect(bot!.snapshot().turns[oversized]!.status).toBe('blocked');
  expect(bot!.core.intent(oversized)).toBeUndefined();
});

it('cancels a blocked turn before admission without an intent or repeat publication', async () => {
  vi.useFakeTimers();
  await setup({ contextMaxBytes: 1 });
  const id = await bot!.input('cancel-before-admission', 'request');
  await bot!.cancelTurn(id);
  expect(bot!.snapshot().turns[id]).toMatchObject({ status: 'failed', conclusion: 'cancelled', reported: true });
  expect(bot!.core.intent(id)).toBeUndefined();
  await bot!.core.flushProjections(async () => {});
  await bot!.cancelTurn(id);
  expect(Object.values(ledger!.snapshot().outbox).filter(row => row.kind === 'projection')).toEqual([]);
  const transactions = vi.spyOn(ledger!, 'transaction');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(transactions).not.toHaveBeenCalled();
});

it('settles a blocked routine occurrence on cancellation so a pending version can activate', async () => {
  vi.useFakeTimers();
  await setup({ contextMaxBytes: 512 });
  const id = await seedRoutine(bot!, 'blocked-routine', '😀'.repeat(500));
  await bot!.drain();
  vi.setSystemTime(routineOf(bot!, id).next!.availableAt);
  await deliverRoutine(bot!, id);
  const turn = Object.values(bot!.snapshot().turns)[0]!;
  expect(turn.status).toBe('blocked');
  await bot!.updateRoutine({ routineId: id, prompt: 'short' });
  expect(routineOf(bot!, id).pending!.version).toBe(2);
  await bot!.cancelTurn(turn.id);
  expect(Object.values(ledger!.snapshot().occurrences)[0]!.conclusion).toBe('cancelled');
  expect(botRoutines([routineOf(bot!, id)])[0]).toMatchObject({ current: 2, pending: null });
  expect(bot!.core.intent(turn.id)).toBeUndefined();
});


async function reopen(options: Partial<BotOptions>) {
  await bot!.close();
  bot = new BotCollaboration(server!, ledger!, { botId: 'main', execution: template('device'), connector: async () => null, ...options });
  await bot.recover();
}

it('reserves only refusal feedback that is present in the frozen ContextPack', async () => {
  await setup({ contextMaxBytes: 2048 });
  ledger!.transaction(s => stateOf(s.application).rejected.push({ botId: 'main', taskId: 'unseen',
    action: 'delegate', reason: 'Unseen feedback '.repeat(200) }));
  const first = await bot!.input('trimmed-refusal', 'Small request');
  const frozen = ledger!.snapshot().executions[bot!.core.intent(first)!.taskId]!.input;
  const context = JSON.parse(String(frozen.payload.instruction).split('ContextPack:\n')[1]!);
  expect(context.rejectedActions).toEqual([]);
  expect(context.historyWindow.omittedRejections).toBe(1);
  expect(bot!.snapshot().rejected[0]!.consumedBy).toBeUndefined();
  await bot!.cancelTurn(first);
  await reopen({ contextMaxBytes: 8192 });
  const next = await bot!.input('visible-refusal', 'Read the feedback');
  const input = ledger!.snapshot().executions[bot!.core.intent(next)!.taskId]!.input;
  const delivered = JSON.parse(String(input.payload.instruction).split('ContextPack:\n')[1]!);
  expect(delivered.rejectedActions).toHaveLength(1);
  expect(delivered.rejectedActions[0].reason).toBe('Unseen feedback '.repeat(200));
  expect(bot!.snapshot().rejected[0]!.consumedBy).toBe(next);
  expect(ledger!.snapshot().executions[bot!.core.intent(first)!.taskId]!.input).toEqual(frozen);
});

it('keeps a released blocked room seat unadmitted after a restart with a larger budget', async () => {
  await setup({ contextMaxBytes: 512 });
  ledger!.transaction(s => {
    const state = stateOf(s.application);
    state.team.rooms.room = { id: 'room', ...roomFields(state.team, { name: 'Room', members: ['main'] }), messages: [] };
  });
  const round = await bot!.roomInput('blocked-seat', 'room', 'x'.repeat(1024), ['main']);
  const seat = bot!.snapshot().team.rounds[round]!.seats[0]!;
  const saved = structuredClone(bot!.snapshot().team.seats[seat]);
  expect(saved).toMatchObject({ status: 'blocked', released: true });
  expect(bot!.core.intent(seat)).toBeUndefined();
  await reopen({ contextMaxBytes: 8192 });
  await bot!.drain();
  expect(bot!.snapshot().team.seats[seat]).toEqual(saved);
  expect(bot!.core.intent(seat)).toBeUndefined();
  expect(bot!.snapshot().turns[seat]).toMatchObject({ status: 'blocked', blockedReason: saved!.reason });
});

it('leaves a turn with a missing Bot unadmitted without a fixed-point spin', async () => {
  await setup();
  ledger!.transaction(s => {
    stateOf(s.application).turns.orphan = { id: 'orphan', root: 'orphan', botId: 'missing', source: 'user',
      request: 'Unadmitted', hop: 0, status: 'queued' };
  });
  await bot!.drain();
  expect(bot!.core.intent('orphan')).toBeUndefined();
  expect(bot!.snapshot().turns.orphan).toMatchObject({ status: 'queued', botId: 'missing' });
});
