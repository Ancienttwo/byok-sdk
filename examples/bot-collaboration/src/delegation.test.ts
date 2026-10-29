import { expect, it } from 'vitest';
import { enqueue, hash, type Intent, type Json, type LedgerState } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { addTurn, stateOf } from './model';
import { abandonDelegation, applyDelegate, arbitrateCancel, claimUnit, delegationDue, releaseUnit, REPLY_UNCERTAIN_AFTER_MS, resolveDelegation, retryReply, ROOT_BOT_BUDGET,
  settleDelegations, DEFAULT_CANCEL_GRACE_MS } from './delegation';

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
  const delays = Array.from({ length: 8 }, () => { const at = REPLY_UNCERTAIN_AFTER_MS - 1; retryReply(state, d, at, emit); return d.nextCheckAt! - at; });
  expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
  expect(d.status).toBe('reply_pending');
  retryReply(state, d, REPLY_UNCERTAIN_AFTER_MS, emit);
  expect(d).toMatchObject({ status: 'uncertain', uncertainSince: REPLY_UNCERTAIN_AFTER_MS });
  expect(d.verdict).toBeUndefined();
  expect(events.at(-1)).toBe(`delegation:${d.id}:${d.revision}`);
});

function ledger(): LedgerState {
  return { version: 1, sequence: 0, scanSequence: 0, intents: {}, executions: {}, routines: {}, occurrences: {}, slots: {}, outbox: {},
    applied: {}, application: {}, scanWake: null };
}
const decline = (code: string) => ({ envelope: { type: 'task.decline', payload: { code } } }) as never;

it.each<[string, (intent: Intent, s: LedgerState) => void, { verdict: string; reason?: string }]>([
  ['cancelled with Host cancel reason expired', intent => { intent.cancelReason = 'expired'; intent.conclusion = 'cancelled'; },
    { verdict: 'expired', reason: 'claim_raced_deadline' }],
  ['cancelled after a user cancel', intent => { intent.cancelReason = 'cancelled'; intent.conclusion = 'cancelled'; },
    { verdict: 'cancelled', reason: 'user_cancelled' }],
  ['expired', intent => { intent.conclusion = 'expired'; }, { verdict: 'expired' }],
  ['declined busy', (intent, s) => { s.executions[intent.taskId]!.terminal = decline('agent_home_writer_busy'); intent.conclusion = 'declined'; },
    { verdict: 'failed', reason: 'busy' }],
  ['declined with another code', (intent, s) => { s.executions[intent.taskId]!.terminal = decline('runtime_unavailable'); intent.conclusion = 'declined'; },
    { verdict: 'failed', reason: 'runtime_unavailable' }],
  ['failed', intent => { intent.conclusion = 'failed'; }, { verdict: 'failed' }],
])('maps the K4 conclusion %s to its verdict (§8.1)', (_name, conclude, expected) => {
  const { state, emit, apply } = setup();
  apply();
  const s = ledger(), d = state.delegations[hash(['task', 'delegate', 0])]!;
  conclude(enqueue(s, 'tenant', { key: d.id, source: 'bot', waitUntil: 1, execution: template('device', 'b') }), s);
  settleDelegations(s, state, 1, emit);
  expect({ verdict: d.verdict, reason: d.reason }).toEqual(expected);
});

it('freezes a cancel without a K4 intent, closes the Turn, and sets the verdict once', () => {
  const { state, emit, apply } = setup();
  apply();
  const s = ledger(), d = state.delegations[hash(['task', 'delegate', 0])]!;
  expect(arbitrateCancel(s, state, d, 5, emit)).toBe(false);
  expect(d).toMatchObject({ verdict: 'cancelled', reason: 'user_cancelled', cancel: { requestedAt: 5, targetTurnId: d.id, delivered: true } });
  expect(state.turns[d.id]).toMatchObject({ status: 'failed', conclusion: 'cancelled' });
  expect(() => arbitrateCancel(s, state, d, 6, emit)).toThrow('already resolved');
});

it('keeps one undelivered cancel on an open intent until delivery, and replays it unchanged', () => {
  const { state, emit, apply } = setup();
  apply();
  const s = ledger(), d = state.delegations[hash(['task', 'delegate', 0])]!;
  enqueue(s, 'tenant', { key: d.id, source: 'bot', waitUntil: 1, execution: template('device', 'b') });
  expect(arbitrateCancel(s, state, d, 5, emit)).toBe(true);
  const saved = structuredClone(d);
  expect(arbitrateCancel(s, state, d, 9, emit)).toBe(true);
  expect(d).toEqual(saved);
  expect(d.verdict).toBeUndefined();
  expect(d.cancel).toEqual({ requestedAt: 5, targetTurnId: d.id, delivered: false });
});

it('End on a claimed uncertain chain writes one K4 cancel, and its later terminal is audited once', () => {
  const { state, emit, apply } = setup();
  apply();
  const s = ledger(), d = state.delegations[hash(['task', 'delegate', 0])]!;
  const intent = enqueue(s, 'tenant', { key: d.id, source: 'bot', waitUntil: 1, execution: template('device', 'b') });
  s.executions[intent.taskId]!.started = true;
  settleDelegations(s, state, 0, emit);
  expect(d).toMatchObject({ status: 'running', claimed: { turnId: d.id, at: 0 } });
  settleDelegations(s, state, REPLY_UNCERTAIN_AFTER_MS, emit);
  expect(d.status).toBe('uncertain');
  expect(abandonDelegation(s, state, d, REPLY_UNCERTAIN_AFTER_MS + 1, emit)).toBe(true);
  expect(d).toMatchObject({ verdict: 'abandoned', lateTurnId: d.id,
    cancel: { requestedAt: REPLY_UNCERTAIN_AFTER_MS + 1, targetTurnId: d.id, delivered: false } });
  intent.conclusion = 'succeeded';
  settleDelegations(s, state, REPLY_UNCERTAIN_AFTER_MS + 2, emit);
  settleDelegations(s, state, REPLY_UNCERTAIN_AFTER_MS + 3, emit);
  expect(state.audit.filter(line => line.startsWith('Delegation terminal after verdict'))).toEqual([`Delegation terminal after verdict: ${d.id} ${intent.taskId}`]);
  expect(d).toMatchObject({ verdict: 'abandoned' });
  expect(d.lateTurnId).toBeUndefined();
});

it('arms the claim timer only for the current chain Turn, so a queued successor cannot spin the timer', () => {
  const { state, emit, apply } = setup();
  apply();
  const s = ledger(), d = state.delegations[hash(['task', 'delegate', 0])]!;
  const timers = { cancelGraceMs: DEFAULT_CANCEL_GRACE_MS, uncertainAfterMs: REPLY_UNCERTAIN_AFTER_MS };
  const intent = enqueue(s, 'tenant', { key: d.id, source: 'bot', waitUntil: 1, execution: template('device', 'b') });
  s.executions[intent.taskId]!.started = true;
  settleDelegations(s, state, 0, emit);
  expect(delegationDue(state, timers)).toEqual([REPLY_UNCERTAIN_AFTER_MS]);
  // T1 succeeded with a self continuation T2 that has no intent yet.
  intent.conclusion = 'succeeded';
  addTurn(state, { id: 'successor', root: 'root', source: 'bot_request', request: 'Continue', botId: 'b', hop: 1, authority: 'bot', delegationId: d.id });
  d.chainTurnIds.push('successor');
  settleDelegations(s, state, REPLY_UNCERTAIN_AFTER_MS * 2, emit);
  expect(d.status).toBe('running');
  expect(delegationDue(state, timers)).toEqual([]);
});
