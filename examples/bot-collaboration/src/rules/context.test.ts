import { expect, it } from 'vitest';
import { contextPack, turnInstruction, type ContextHistory } from './context';
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
  if (!('turns' in context)) throw new Error('Expected a Bot Turn context');
  expect(context.turns).toEqual(injected.turns.slice(0, 2).map(row => ({ id: row.id, root: row.root, source: row.source, request: row.request,
    hop: row.hop, status: row.status, conclusion: row.conclusion, outcomeSummary: [] })));
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
  if (!('turns' in context)) throw new Error('Expected a Bot Turn context');
  expect(context.turns.map(row => row.id)).toEqual(['t1', 't3']);
  expect(contextPack(history, 2).turns.map(row => row.id)).toEqual(['t2', 't3']);
  expect(() => contextPack(history, 2, 'missing')).toThrow('Missing ContextPack candidate');
});
