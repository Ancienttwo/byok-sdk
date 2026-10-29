import { expect, it } from 'vitest';
import { hash } from '@byok-sdk/server/execution-core/canonical';
import { addTurn, type Turn } from './turn';
import { applyTurnOutcome, type OutcomePorts, type OutcomeState } from './outcome';
import { outcomeSchema, type ContextState } from './schema';

/** A plain slice with one Main Bot Turn and its frozen schema. The ports record what the Host would store. */
function setup(authority: 'owner' | 'bot', channel = true) {
  const bot = { id: 'main', name: 'Main', role: 'Team owner', mainBot: true, archived: false, readyRevision: '1',
    execution: { deviceId: 'device', payload: { agentRef: { agentId: 'main', profileRevision: '1' } } } };
  const state: OutcomeState & ContextState = {
    team: { bots: { main: bot }, rooms: {}, rounds: {}, seats: {}, roots: {}, notes: [], homeOperations: [] },
    turns: {}, budgets: {}, delegations: {}, batches: {}, units: {}, replies: {}, rejected: [], audit: [], schemas: {}, cards: {}, questions: {},
  };
  const turn = addTurn(state, { id: 't1', root: 't1', source: 'user', request: 'Work', botId: 'main', hop: 0, authority });
  // The schema is frozen for an owner Turn, so it offers management even when the stored Turn has another authority.
  state.schemas.t1 = outcomeSchema('main', state, { ...turn, authority: 'owner' });
  const log: string[] = [];
  const ports: OutcomePorts = {
    now: () => 1000, publish: key => { log.push(`publish ${key}`); }, committed: { intent: () => undefined },
    manage: (_turn, outcome, managed) => {
      if (outcome.team_note) managed('team_note', () => { log.push('manage team_note'); });
    },
    createRoutine: () => { throw new Error('No routines'); }, updateRoutine: () => {}, cancelRoutine: () => {},
    ...(channel ? { deliver: (_turn: Turn, key: string) => { log.push(`deliver ${key}`); } } : {}),
  };
  return { state, ports, log };
}
const action = { action: 'send_message', summary: 'Send', draft: { text: 'hello' } };

it('applies the actions in order, through the ports, and keeps a refused action in rejected', () => {
  const { state, ports, log } = setup('owner');
  applyTurnOutcome(state, 't1', 'task', { team_note: { text: 'Note' }, confirmable_action: [action], ask_user: { question: 'Go?', answerKind: 'text' } }, ports);
  const card = hash(['task', 'confirmable_action', 0]), question = hash(['task', 'ask_user']);
  expect(log).toEqual(['manage team_note', `publish card:${card}`, `deliver card:${card}`, `publish question:${question}`, `deliver question:${question}`]);
  expect(state.cards[card]).toMatchObject({ turnId: 't1', state: 'pending', expiresAt: 1000 + 86_400_000, action });
  expect(state.turns.t1!.outcome).toEqual({ team_note: { text: 'Note' }, confirmable_action: [action], ask_user: { question: 'Go?', answerKind: 'text' } });
  expect(state.rejected).toEqual([]);
});

it('refuses management without owner authority, and queues no delivery without a channel', () => {
  const { state, ports, log } = setup('bot', false);
  applyTurnOutcome(state, 't1', 'task', { team_note: { text: 'Note' }, confirmable_action: [action] }, ports);
  expect(log).toEqual([`publish card:${hash(['task', 'confirmable_action', 0])}`]);
  expect(state.rejected).toEqual([{ botId: 'main', taskId: 'task', action: 'team_note', reason: 'Management needs owner authority' }]);
});

it('records an archived Bot outcome as audit only, and refuses a document outside the frozen schema', () => {
  const archived = setup('owner');
  archived.state.team.bots = { main: { ...archived.state.team.bots.main!, archived: true } };
  applyTurnOutcome(archived.state, 't1', 'task', { confirmable_action: [action] }, archived.ports);
  expect(archived.state.audit).toEqual(['Outcome audit only: task']);
  expect(archived.log).toEqual([]);
  const invalid = setup('owner');
  expect(() => applyTurnOutcome(invalid.state, 't1', 'task', { unknown_action: true }, invalid.ports)).toThrow('Outcome differs from the frozen schema');
  expect(() => applyTurnOutcome(invalid.state, 'missing', 'task', {}, invalid.ports)).toThrow('Missing Bot turn');
});
