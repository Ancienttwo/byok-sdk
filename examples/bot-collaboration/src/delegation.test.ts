import { expect, it } from 'vitest';
import { hash, type Json } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { addTurn, stateOf } from './model';
import { applyDelegate, claimUnit, releaseUnit, REPLY_UNCERTAIN_AFTER_MS, resolveDelegation, retryReply, ROOT_BOT_BUDGET } from './delegation';

function setup() {
  const state = stateOf({});
  for (const id of ['a', 'b']) state.team.bots[id] = { id, name: id, role: 'Member', persona: '', model: 'default',
    mainBot: false, archived: false, revision: '1', readyRevision: '1', execution: template('device', id) };
  const turn = addTurn(state, { id: 'root', root: 'root', source: 'user', request: 'Ask b', botId: 'a', hop: 0, authority: 'owner' });
  const events: string[] = [];
  const emit = (id: string, _value: Json) => { events.push(id); };
  const apply = () => applyDelegate(state, turn, 'task', { delegate: [{ to: 'b', request: 'Check' }, { to: 'a', request: 'Continue' }] },
    false, 0, emit, (_kind, work) => work());
  return { state, events, emit, apply };
}

it('changes no unit twice on a replayed apply, claim, release or verdict, and keeps spent + reserved <= 12', () => {
  const { state, events, emit, apply } = setup();
  expect(apply()).toEqual({ successor: true });
  const saved = structuredClone(state);
  const published = [...events];
  expect(apply()).toEqual({ successor: true });
  expect(state).toEqual(saved);
  expect(events).toEqual(published);
  const id = hash(['task', 'delegate', 0]), bUnit = hash([id, 'B']), slot = hash(['task', 'A', 0]);
  expect(state.budgets.root).toEqual({ continuation: 1, delegation: 0, reserved: 2 });
  expect(Object.values(state.units).map(unit => [unit.id, unit.state, unit.turnId])).toEqual([[slot, 'reserved', undefined], [bUnit, 'reserved', id]]);

  claimUnit(state, bUnit); claimUnit(state, bUnit);
  releaseUnit(state, bUnit);
  expect(state.units[bUnit]!.state).toBe('spent');
  expect(state.budgets.root).toMatchObject({ delegation: 1, reserved: 1 });
  const d = state.delegations[id]!;
  expect(resolveDelegation(state, d, 'answered', 1, emit, undefined, 'b-task')).toBe(true);
  const resolved = structuredClone(state);
  expect(resolveDelegation(state, d, 'failed', 2, emit, 'no_reply')).toBe(false);
  expect(state).toEqual(resolved);
  expect(state.units[slot]).toMatchObject({ state: 'reserved', turnId: hash(['bot_reply', id]) });
  claimUnit(state, slot); claimUnit(state, slot);
  expect(state.budgets.root).toMatchObject({ delegation: 2, reserved: 0 });
  expect(state.budgets.root!.delegation + state.budgets.root!.reserved!).toBeLessThanOrEqual(ROOT_BOT_BUDGET);
});

it('releases the B unit when the delegation resolves before its Turn starts', () => {
  const { state, emit, apply } = setup();
  apply();
  const id = hash(['task', 'delegate', 0]);
  resolveDelegation(state, state.delegations[id]!, 'expired', 1, emit);
  expect(state.units[hash([id, 'B'])]!.state).toBe('released');
  expect(state.budgets.root).toMatchObject({ delegation: 0, reserved: 1 });
});

it('backs off reply checks from 1 s to 60 s and shows uncertain after 30 minutes without a verdict', () => {
  const { state, emit, apply, events } = setup();
  apply();
  const d = state.delegations[hash(['task', 'delegate', 0])]!;
  Object.assign(d, { status: 'reply_pending', pendingSince: 0, nextCheckAt: 0, checks: 0 });
  const delays = Array.from({ length: 8 }, () => { const at = REPLY_UNCERTAIN_AFTER_MS - 1; retryReply(d, at, emit); return d.nextCheckAt! - at; });
  expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
  expect(d.status).toBe('reply_pending');
  retryReply(d, REPLY_UNCERTAIN_AFTER_MS, emit);
  expect(d).toMatchObject({ status: 'uncertain', uncertainSince: REPLY_UNCERTAIN_AFTER_MS });
  expect(d.verdict).toBeUndefined();
  expect(events.at(-1)).toBe(`delegation:${d.id}:${d.revision}`);
});
