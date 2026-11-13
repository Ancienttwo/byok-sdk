import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildHandoffPack, type HandoffPackBudgets, type HandoffTurn } from '@byok-sdk/protocol';
import { stateOf } from './model';
import * as rules from './rules/context';
import { botTurnInstruction } from './host-kit';
import { seedCollaboration, SYNC_OPTIONS } from './commit-vectors.test-support';
import { syncTurn } from './rules/sync';
import { outcomeSchema, promptActions } from './rules/schema';

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

it('host-kit computes the instruction frozen by sync', () => {
  const state = stateOf({}); seedCollaboration(state);
  const turn = state.turns.t = { id: 't', root: 't', botId: 'main', source: 'user', request: 'Hello', hop: 0, status: 'queued', authority: 'owner' };
  const actions = promptActions(outcomeSchema(turn.botId, state, turn, SYNC_OPTIONS.models, SYNC_OPTIONS.routines, SYNC_OPTIONS.offer), SYNC_OPTIONS.offer);
  const expected = botTurnInstruction({ state, turn, limits: SYNC_OPTIONS.limits, routines: SYNC_OPTIONS.routines, actions }).instruction;
  const step = syncTurn(state, turn, { intent: () => undefined, executionStarted: () => false, retired: () => undefined }, SYNC_OPTIONS, () => {});
  expect(step?.kind).toBe('freeze');
  if (step?.kind !== 'freeze') throw new Error('Expected frozen intent');
  expect(step.input.execution.payload.instruction).toBe(expected);
});

it('#1446: the history of a frozen Turn is byte for byte the handoff pack of its rows', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../../packages/protocol/src/__tests__/golden/handoff-pack.vectors.json', import.meta.url), 'utf8')) as
    Array<{ turns: HandoffTurn[]; budgets: HandoffPackBudgets }>;
  for (const { turns, budgets } of vectors) {
    const rows = turns.map((row, n): rules.ContextTurn => ({ id: `t${n}`, root: `t${n}`, source: 'user', request: row.lines[0]!.text, hop: 0, status: 'succeeded',
      outcomeSummary: [], ...(row.lines[1] ? { reply: row.lines[1].text } : {}) }));
    const packed = rows.map(({ id, root, request, reply }) => ({ lines: [{ speaker: 'user', text: request }, ...(reply === undefined ? [] : [{ speaker: 'bot', text: reply }])],
      meta: { id, root, hop: 0, status: 'succeeded', outcomeSummary: [] } }));
    const now: rules.ContextTurn = { id: 'now', root: 'now', source: 'user', request: 'Now', hop: 0, status: 'queued', outcomeSummary: [] };
    const { history } = rules.contextPack({ turns: [...rows, now], cards: [], questions: [], rejected: [] }, 12, 'now', undefined, true, {}, {}, [], budgets);
    expect(JSON.stringify(history)).toBe(JSON.stringify(buildHandoffPack(packed, budgets)));
  }
});
