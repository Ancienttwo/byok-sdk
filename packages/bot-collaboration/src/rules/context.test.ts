import { expect, it } from 'vitest';
import type { HandoffPack } from '@byok-sdk/protocol';
import { hash, canonical } from '@byok-sdk/server/execution-core/canonical';
import { contextPack, contextTurns, historyRowFromTurn, turnInstruction, type ContextHistory } from './context';
import type { ContextState } from './schema';
import type { Turn } from './turn';

const STORED_HISTORY = ['turns', 'cards', 'questions', 'rejected', 'schemas', 'inputs', 'inputBatches'];
/** Team rows from an external authority, with no Turn rows. A read of a stored history row throws. */
function authority(): ContextState {
  const state: ContextState = {
    team: { bots: { main: { id: 'main', name: 'Main', role: 'Team owner', mainBot: true, archived: false, readyRevision: '1' } },
      rooms: {}, rounds: {}, seats: {}, notes: [{ id: 'n1', text: 'Note' }], homeOperations: [] },
    delegations: {}, replies: {},
  };
  return new Proxy(state, { get(target, key, receiver) {
    if (STORED_HISTORY.includes(String(key))) throw new Error(`Read stored ${String(key)}`);
    return Reflect.get(target, key, receiver);
  } });
}
function turn(id: string, request: string, status: Turn['status'] = 'succeeded'): Turn {
  return { id, root: id, botId: 'main', source: 'user', request, hop: 0, status, authority: 'owner', ...(status === 'succeeded' ? { conclusion: 'succeeded' } : {}) };
}
const limits = { turnLimit: 100, contextMaxBytes: 32_768, instructionMaxBytes: 65_536 };

it('#606 acceptance 4: freezes the ContextPack from injected history, and reads no stored history', () => {
  const current = turn('t3', 'And now?', 'queued');
  const history: ContextHistory = {
    turns: [turn('t1', 'First'), turn('t2', 'Second'), current],
    cards: [{ id: 'c1', turnId: 't1', action: { action: 'send_message', summary: 'Send', draft: { text: 'hi' } }, state: 'pending', expiresAt: 10 }],
    questions: [{ id: 'q1', turnId: 't2', value: { question: 'Which?', answerKind: 'text' }, answer: 'This' }],
    rejected: [{ botId: 'main', taskId: 'task', action: 'delegate', reason: 'hop_limit' }],
  };
  const injected = structuredClone(history);
  const { context, instruction } = turnInstruction(authority(), history, current, limits);
  if (!('history' in context)) throw new Error('Expected a Bot Turn context');
  expect(context.history.recent).toEqual(injected.turns.slice(0, 2).map(row => ({ lines: [{ speaker: row.source, text: row.request }],
    meta: { id: row.id, root: row.root, hop: row.hop, status: row.status, conclusion: row.conclusion, outcomeSummary: [] } })));
  expect(context.cards).toEqual(injected.cards);
  expect(context.questions).toEqual(injected.questions);
  expect(context.rejectedActions).toEqual(injected.rejected);
  expect(context.teamNotes).toEqual([{ id: 'n1', text: 'Note' }]);
  expect(instruction.endsWith(`\n\nRequest:\nAnd now?\n\nContextPack:\n${JSON.stringify(context)}`)).toBe(true);
  expect(history).toEqual(injected);
});

it('selects the current Turn by id and keeps it out of the history rows', () => {
  const rows = [turn('t1', 'First'), turn('t2', 'Now', 'queued'), turn('t3', 'Later', 'queued')];
  const history: ContextHistory = { turns: rows, cards: [], questions: [], rejected: [] };
  const { context } = turnInstruction(authority(), history, rows[1]!, limits);
  if (!('history' in context)) throw new Error('Expected a Bot Turn context');
  const ids = (pack: HandoffPack) => pack.recent.map(row => (row.meta as { id: string }).id);
  expect(ids(context.history)).toEqual(['t1', 't3']);
  // The turn limit selects no history, and the candidate of a snapshot view is the newest turn of `recent`.
  expect(ids(contextPack(history, 2).history)).toEqual(['t1', 't2', 't3']);
  expect(ids(contextPack(history, 2, 't2').history)).toEqual(['t1', 't3', 't2']);
  // A candidate that does not fit leaves `recent` empty: it never reads as the last turn of `earlier`.
  const budgets = { recentBytes: 10, earlyBytes: 4096, totalBytes: 8192 };
  expect(contextPack(history, 2, undefined, undefined, undefined, undefined, undefined, undefined, budgets).history).toMatchObject({ recent: [], omittedTurns: 1 });
  expect(() => contextPack(history, 2, 'missing')).toThrow('Missing ContextPack candidate');
});

it('takes injected rows in the ContextPack row shape, and refuses any other shape', () => {
  const injected = contextTurns([{ id: 'c1', root: 'c1', source: 'user', request: 'Cloud', hop: 0, status: 'succeeded', outcomeSummary: ['ask_user'], reply: 'Seen' }]);
  const current = turn('t1', 'Now', 'queued');
  const history: ContextHistory = { turns: [...injected, current], cards: [], questions: [], rejected: [] };
  const { context } = turnInstruction(authority(), history, current, limits);
  if (!('history' in context)) throw new Error('Expected a Bot Turn context');
  expect(context.history.recent).toEqual([{ lines: [{ speaker: 'user', text: 'Cloud' }, { speaker: 'bot', text: 'Seen' }],
    meta: { id: 'c1', root: 'c1', hop: 0, status: 'succeeded', outcomeSummary: ['ask_user'] } }]);
  for (const bad of [null, {}, [null], [{ ...injected[0], source: 'other' }], [{ ...injected[0], hop: -1 }], [{ ...injected[0], outcomeSummary: [1] }],
    [{ ...injected[0], conclusion: 3 }], [{ ...injected[0], reply: 3 }]]) expect(() => contextTurns(bad)).toThrow('Invalid injected history');
});

it('#1318: builds a history row from a bot-turn projection and its reply, which contextTurns takes as it is', () => {
  const projection = JSON.parse(JSON.stringify({ owner: 'main', ...turn('t1', 'Compare A and B'), outcome: { ask_user: {} }, reported: true, reply: 'A wins' }));
  const row = historyRowFromTurn(projection);
  expect(row).toEqual({ id: 't1', root: 't1', source: 'user', request: 'Compare A and B', hop: 0, status: 'succeeded', conclusion: 'succeeded',
    outcomeSummary: ['ask_user'], reply: 'A wins' });
  expect(hash(canonical(contextTurns([row])))).toBe(hash(canonical([row])));
  const { reply: _reply, ...plain } = projection;
  expect(historyRowFromTurn(plain)).not.toHaveProperty('reply');
});
