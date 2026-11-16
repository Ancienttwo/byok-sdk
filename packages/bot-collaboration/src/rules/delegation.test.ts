import { expect, it } from 'vitest';
import { hash } from '@byok-sdk/server/execution-core/canonical';
import { addTurn } from './turn';
import { applyDelegate, arbitrateCancel, checkReply, delegationDue, replyCheckDue, resolveDelegation, settleDelegations, type DelegationState, type IntentFact, type IntentFacts } from './delegation';
import type { AutonomyGate } from './autonomy';
/** These cases apply every autonomous action, as a Bot in `auto` does. */
const auto: AutonomyGate = { autonomy: 'auto', record: () => { throw new Error('auto records nothing'); } };

/** A plain collaboration slice and K4 facts by Turn id. The rules need no ledger and no Host. */
function setup(targets = ['b']) {
  const bot = (id: string) => ({ id, name: id, archived: false, execution: { deviceId: `${id}-device`, payload: { agentRef: { agentId: id, profileRevision: '1' } } } });
  const state: DelegationState = { team: { bots: { a: bot('a'), b: bot('b'), c: bot('c') } }, turns: {}, budgets: {}, delegations: {}, batches: {}, units: {},
    replies: {}, rejected: [], audit: [] };
  const root = addTurn(state, { id: 'root', root: 'root', source: 'user', request: 'Ask b', botId: 'a', hop: 0, authority: 'owner' });
  const events: string[] = [], emit = (id: string) => { events.push(id); };
  applyDelegate(state, root, 'task', { delegate: targets.map(to => ({ to, request: 'Check' })) }, false, 0, emit, (_kind, work) => work(), auto);
  const d = state.delegations[hash(['task', 'delegate', 0])]!;
  const intents: Record<string, IntentFact & { started?: boolean; declineCode?: string }> = {};
  const facts: IntentFacts = {
    intent: key => intents[key] && { taskId: intents[key].taskId, ...(intents[key].conclusion ? { conclusion: intents[key].conclusion } : {}) },
    started: key => !!intents[key]?.started, declineCode: key => intents[key]?.declineCode, offeredTo: () => undefined,
  };
  return { state, d, intents, facts, events, emit };
}

it('admits a delegation as a B request Turn with reserved units, from rows and facts only', () => {
  const { state, d, events } = setup();
  expect(state.turns[d.id]).toMatchObject({ source: 'bot_request', botId: 'b', hop: 1, authority: 'bot', delegationId: d.id, unit: hash([d.id, 'B']) });
  expect(d).toMatchObject({ status: 'queued', toAgentRef: { agentId: 'b', profileRevision: '1' }, toDeviceId: 'b-device', revision: 1 });
  expect(state.budgets.root).toEqual({ continuation: 0, delegation: 0, reserved: 2 });
  expect(events).toEqual([`delegation:${d.id}:1`]);
});

it('spends the B unit at the first observed start, and maps a decline to a verdict with the busy rule', () => {
  for (const [code, reason] of [['agent_home_writer_busy', 'busy'], [undefined, 'busy'], ['model_unavailable', 'model_unavailable']] as const) {
    const { state, d, intents, facts, emit } = setup();
    intents[d.id] = { taskId: 'b-task', started: true };
    settleDelegations(state, facts, 1, emit);
    expect(state.units[hash([d.id, 'B'])]!.state).toBe('spent');
    expect(d.status).toBe('running');
    intents[d.id] = { taskId: 'b-task', conclusion: 'declined', ...(code ? { declineCode: code } : {}) };
    settleDelegations(state, facts, 2, emit);
    expect(d).toMatchObject({ verdict: 'failed', reason, status: 'resolved', replyTurnId: hash(['bot_reply', d.id]) });
    expect(state.turns[d.replyTurnId!]).toMatchObject({ source: 'bot_reply', botId: 'a', replies: [expect.objectContaining({ verdict: 'failed', reason })] });
  }
});

it('arbitrates a cancel from intent facts: no intent closes now, an open intent waits for its terminal', () => {
  const now = setup();
  expect(arbitrateCancel(now.state, now.facts, now.d, 5, now.emit)).toBe(false);
  expect(now.d).toMatchObject({ verdict: 'cancelled', reason: 'user_cancelled', cancel: { targetTurnId: now.d.id, delivered: true } });
  expect(now.state.turns[now.d.id]).toMatchObject({ status: 'failed', conclusion: 'cancelled' });

  const open = setup();
  open.intents[open.d.id] = { taskId: 'b-task' };
  expect(arbitrateCancel(open.state, open.facts, open.d, 5, open.emit)).toBe(true);
  expect(open.d.verdict).toBeUndefined();
  open.intents[open.d.id] = { taskId: 'b-task', conclusion: 'cancelled' };
  settleDelegations(open.state, open.facts, 6, open.emit);
  expect(open.d).toMatchObject({ verdict: 'cancelled', reason: 'user_cancelled' });
});

it('ignores a failed reply check after its delegation resolves and excludes resolved timer rows', () => {
  const { state, d, emit, events } = setup();
  Object.assign(d, { status: 'reply_pending', pendingSince: 0, nextCheckAt: 1 });
  expect(replyCheckDue(d, 1)).toBe(true);
  resolveDelegation(state, d, 'answered', 2, emit);
  const resolved = structuredClone(d), published = events.length;
  checkReply(state, d, { failed: true }, 100_000, emit, 10);
  expect(d).toEqual(resolved);
  expect(events).toHaveLength(published);
  expect(replyCheckDue(d, 100_001)).toBe(false);
  expect(delegationDue(state)).toEqual([]);
  d.nextCheckAt = 1;
  expect(delegationDue(state)).toEqual([]);
});

it('keeps an uncertain sibling reply slot when a report arrives during initiator suspension', () => {
  const { state, d, intents, facts, emit } = setup(['b', 'c']);
  const sibling = state.delegations[hash(['task', 'delegate', 1])]!;
  intents[sibling.id] = { taskId: 'c-task', started: true };
  settleDelegations(state, facts, 1, emit);
  settleDelegations(state, facts, 12, emit, { cancelGraceMs: 10, uncertainAfterMs: 10 });
  expect(sibling.status).toBe('uncertain');
  const initiator = state.team.bots.a!;
  state.team.bots = { ...state.team.bots, a: { ...initiator, participation: 'suspended' } };
  resolveDelegation(state, d, 'answered', 13, emit);
  expect(d).toMatchObject({ verdict: 'answered', undelivered: 'initiator_suspended' });
  expect(d.replyTurnId).toBeUndefined();
  const slots = state.batches.task!.slots;
  expect(slots.map(id => state.units[id]!.state)).toEqual(['reserved', 'released']);
  state.team.bots = { ...state.team.bots, a: initiator };
  resolveDelegation(state, sibling, 'answered', 14, emit);
  expect(state.turns[sibling.replyTurnId!]).toMatchObject({ source: 'bot_reply', botId: 'a', status: 'queued', unit: slots[0] });
  expect(state.units[slots[0]!]).toMatchObject({ state: 'reserved', turnId: sibling.replyTurnId });
});
