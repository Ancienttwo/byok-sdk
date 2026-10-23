import { expect, it } from 'vitest';
import { stateOf } from './model';
import * as rules from './rules/context';

const limits = { turnLimit: 100, contextMaxBytes: 32_768, instructionMaxBytes: 65_536 };

it('freezes the same instruction from the device ledger as from the same Bot history given by another authority', () => {
  const state = stateOf({});
  for (const id of ['main', 'other']) state.team.bots[id] = { id, name: id, role: 'Member', persona: '', model: 'default', mainBot: id === 'main',
    archived: false, revision: '1', readyRevision: '1', execution: { deviceId: 'device', payload: { agentRef: { agentId: id, profileRevision: '1' } } } as never };
  const add = (id: string, botId: string, request: string) => { state.turns[id] = { id, root: id, botId, source: 'user', request, hop: 0, status: 'succeeded', authority: 'owner', conclusion: 'succeeded' }; };
  add('m1', 'main', 'Mine'); add('o1', 'other', 'Not mine'); add('m2', 'main', 'Mine too');
  state.turns.m3 = { id: 'm3', root: 'm3', botId: 'main', source: 'user', request: 'Now', hop: 0, status: 'queued', authority: 'owner' };
  state.cards.c1 = { id: 'c1', turnId: 'o1', action: { action: 'send_message', summary: 'Other', draft: { text: 'x' } }, state: 'pending', expiresAt: 1 };
  state.rejected.push({ botId: 'main', taskId: 'a', action: 'delegate', reason: 'hop_limit' },
    { botId: 'other', taskId: 'b', action: 'delegate', reason: 'hop_limit' }, { botId: 'main', taskId: 'c', action: 'delegate', reason: 'x', consumedBy: 'm2' });
  const { turns: _turns, cards: _cards, questions: _questions, rejected: _rejected, ...authority } = state;
  const injected: rules.ContextHistory = { turns: [state.turns.m1!, state.turns.m2!, state.turns.m3!], cards: [], questions: [], rejected: [state.rejected[0]!] };
  expect(rules.botTurnInstruction(state, state.turns.m3!, limits)).toEqual(rules.turnInstruction(authority, injected, state.turns.m3!, limits));
});
