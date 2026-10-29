import { expect, it } from 'vitest';
import { hash, type Json } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { addTurn, stateOf, type CollaborationState, type Delegation, type Turn, type Verdict } from './model';
import { applyDelegate, claimUnit, endChain, releaseUnit, REPLY_UNCERTAIN_AFTER_MS, reserveUnits, resolveDelegation, retryReply, ROOT_BOT_BUDGET } from './delegation';

function setup(spent = 0) {
  const state = stateOf({});
  for (const id of ['a', 'b', 'c']) state.team.bots[id] = { id, name: id, role: 'Member', persona: '', model: 'default',
    mainBot: false, archived: false, revision: '1', readyRevision: '1', execution: template('device', id) };
  const root = addTurn(state, { id: 'root', root: 'root', source: 'user', request: 'Ask', botId: 'a', hop: 0, authority: 'owner' });
  state.budgets.root!.delegation = spent;
  const emit = (_id: string, _value: Json) => {};
  const apply = (turn: Turn, task: string, to: string[]) => applyDelegate(state, turn, task,
    { delegate: to.map(target => ({ to: target, request: `Ask ${target}` })) }, false, 0, emit, (_kind, work) => work());
  return { state, root, emit, apply };
}
/** B ran (its unit is spent), reply_pending without a Host record, then no verdict for uncertainAfterMs (§3.3, §8.3). */
function makeUncertain(state: CollaborationState, d: Delegation, now: number) {
  claimUnit(state, state.turns[d.chainTurnIds[0]!]!.unit);
  if (d.status !== 'reply_pending') endChain(state, state.turns[d.chainTurnIds.at(-1)!]!, `${d.id}-task`, false, now, () => {});
  retryReply(state, d, now + REPLY_UNCERTAIN_AFTER_MS, () => {});
}
const replyTurns = (state: CollaborationState) => Object.values(state.turns).filter(turn => turn.source === 'bot_reply');

it('reserve(n) = n + max(n, 1)', () => {
  expect([0, 1, 2].map(reserveUnits)).toEqual([1, 2, 4]);
});

it('every accepted delegation uncertain: no batch Turn; each later verdict reports in its own Turn with its own slot', () => {
  const { state, root, emit, apply } = setup();
  apply(root, 'task', ['b', 'c']);
  const [d0, d1] = [0, 1].map(index => state.delegations[hash(['task', 'delegate', index])]!) as [Delegation, Delegation];
  makeUncertain(state, d0, 0);
  expect(state.batches.task!.released).toBeUndefined();
  makeUncertain(state, d1, 0);
  expect([d0.status, d1.status]).toEqual(['uncertain', 'uncertain']);
  expect(state.batches.task!.released).toBe(true);
  expect(replyTurns(state)).toEqual([]);
  expect(state.turns[hash(['bot_reply', 'task'])]).toBeUndefined();

  resolveDelegation(state, d1, 'answered', 1, emit, undefined, 'b-task');
  const slots = state.batches.task!.slots;
  expect(replyTurns(state)).toEqual([expect.objectContaining({ id: hash(['bot_reply', d1.id]), unit: slots[0],
    replies: [expect.objectContaining({ delegationId: d1.id })] })]);
  // One delegation is still unreported, so its slot stays free.
  expect(state.units[slots[1]!]).toMatchObject({ state: 'reserved' });
  expect(state.units[slots[1]!]!.turnId).toBeUndefined();
  resolveDelegation(state, d0, 'failed', 2, emit, 'no_reply');
  expect(replyTurns(state).map(turn => [turn.id, turn.unit])).toEqual([[hash(['bot_reply', d1.id]), slots[0]], [hash(['bot_reply', d0.id]), slots[1]]]);
  // Both B units are spent; both slots hold a report.
  expect(state.budgets.root).toMatchObject({ delegation: 2, reserved: 2 });
});

it('a batch of one with an uncertain delegation keeps its refusal for the late report under the single key', () => {
  const { state, root, emit, apply } = setup();
  state.team.bots.c!.archived = true;
  apply(root, 'task', ['b', 'c']);
  const d = state.delegations[hash(['task', 'delegate', 0])]!, refused = state.delegations[hash(['task', 'delegate', 1])]!;
  expect(refused).toMatchObject({ verdict: 'refused', reason: 'target_archived' });
  expect(state.budgets.root).toMatchObject({ reserved: 2 });
  makeUncertain(state, d, 0);
  expect(replyTurns(state)).toEqual([]);
  resolveDelegation(state, d, 'answered', 1, emit, undefined, 'b-task');
  expect(replyTurns(state)).toEqual([expect.objectContaining({ id: hash(['bot_reply', d.id]),
    replies: [expect.objectContaining({ delegationId: d.id }), expect.objectContaining({ delegationId: refused.id, verdict: 'refused' })] })]);
  expect(refused.replyTurnId).toBe(hash(['bot_reply', d.id]));
});

/** Deterministic PRNG (mulberry32), so a failing seed reproduces. */
function random(seed: number) {
  let value = seed >>> 0;
  const next = () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let x = Math.imul(value ^ (value >>> 15), 1 | value);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
  return { int: (n: number) => Math.floor(next() * n), pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]! };
}

function check(state: CollaborationState, initial: number, seed: number) {
  const units = Object.values(state.units);
  const budget = state.budgets.root!;
  const where = `seed ${seed}`;
  expect(budget.delegation + (budget.reserved ?? 0), where).toBeLessThanOrEqual(ROOT_BOT_BUDGET);
  expect(budget.reserved ?? 0, where).toBe(units.filter(unit => unit.state === 'reserved').length);
  expect(budget.delegation, where).toBe(initial + units.filter(unit => unit.state === 'spent').length);
  const reported = new Map<string, string>();
  for (const turn of replyTurns(state)) for (const entry of turn.replies!) {
    expect(reported.has(entry.delegationId), where).toBe(false);
    reported.set(entry.delegationId, turn.id);
  }
  for (const d of Object.values(state.delegations)) expect(reported.get(d.id), where).toBe(d.replyTurnId);
  for (const batch of Object.values(state.batches)) {
    const rows = batch.delegationIds.map(id => state.delegations[id]!), n = rows.filter(row => row.requestTurnId).length;
    const turns = new Set(rows.flatMap(row => row.replyTurnId ? [row.replyTurnId] : []));
    expect(turns.size, where).toBeLessThanOrEqual(Math.max(n, 1));
    if (!n) continue;
    // Every report of a batch with an accepted item holds a prepaid slot, so it can start.
    for (const id of turns) expect(state.units[state.turns[id]!.unit!]?.turnId, where).toBe(id);
    const free = batch.slots.filter(slot => state.units[slot]!.state === 'reserved' && !state.units[slot]!.turnId).length;
    expect(free, where).toBeGreaterThanOrEqual(rows.filter(row => row.requestTurnId && !row.replyTurnId).length);
  }
}

it('randomized interleaving of two batches keeps spent + reserved <= 12, and every reserved report can start', () => {
  const verdicts: Verdict[] = ['answered', 'failed', 'expired', 'cancelled', 'abandoned'];
  // Branches that the generator must reach, so the invariants are not checked on easy paths only.
  const reached = new Set<string>();
  const observe = (state: CollaborationState) => {
    const batches = Object.values(state.batches);
    for (const batch of batches) {
      const rows = batch.delegationIds.map(id => state.delegations[id]!), accepted = rows.filter(row => row.requestTurnId);
      if (rows.some(row => row.reason === 'budget_exhausted')) reached.add('budget_exhausted');
      if (accepted.length === 2 && rows.some(row => row.replyTurnId === hash(['bot_reply', batch.id]))) reached.add('batch Turn');
      if (accepted.length === 2 && rows.some(row => row.replyTurnId === hash(['bot_reply', row.id]))) reached.add('late report');
      if (batch.released && accepted.length && accepted.every(row => !row.replyTurnId)) reached.add('released with no Turn');
    }
    if (batches.length === 2 && batches.every(batch => batch.delegationIds.some(id => state.delegations[id]!.requestTurnId && !state.delegations[id]!.replyTurnId))) {
      reached.add('two open batches');
    }
  };
  for (let seed = 1; seed <= 300; seed++) {
    const r = random(seed), initial = r.int(10);
    const { state, root, emit, apply } = setup(initial);
    const origins = [root, addTurn(state, { id: 'second', root: 'root', source: 'continuation', request: 'Again', botId: 'a', hop: 0, authority: 'owner' })];
    const targets = () => r.pick([['b', 'c'], ['c', 'b'], ['b'], ['b', 'b']]);
    const applied: Array<{ turn: Turn; task: string; to: string[] }> = [];
    let now = 0;
    const open = () => Object.values(state.delegations).filter(d => d.requestTurnId && !d.verdict);
    for (let step = 0; step < 40; step++) {
      now += 1000;
      const action = r.int(7);
      if (action === 0 && applied.length < origins.length) {
        const next = { turn: origins[applied.length]!, task: `task-${applied.length}`, to: targets() };
        apply(next.turn, next.task, next.to);
        applied.push(next);
      } else if (action === 1 && applied.length) {
        // A replayed apply of the same terminal changes nothing.
        const saved = structuredClone(state), again = r.pick(applied);
        apply(again.turn, again.task, again.to);
        expect(state, `seed ${seed}`).toEqual(saved);
      } else if (action === 2 && open().length) {
        const d = r.pick(open());
        claimUnit(state, state.turns[d.id]!.unit); claimUnit(state, state.turns[d.id]!.unit);
      } else if (action === 3 && open().length) {
        const d = r.pick(open());
        claimUnit(state, state.turns[d.id]!.unit);
        if (d.status !== 'uncertain') makeUncertain(state, d, now);
      } else if (action === 4 && open().length) {
        const d = r.pick(open());
        expect(resolveDelegation(state, d, r.pick(verdicts), now, emit), `seed ${seed}`).toBe(true);
        const saved = structuredClone(state);
        expect(resolveDelegation(state, d, 'failed', now, emit), `seed ${seed}`).toBe(false);
        expect(state, `seed ${seed}`).toEqual(saved);
      } else if (action >= 5) {
        const waiting = replyTurns(state).filter(turn => turn.unit && state.units[turn.unit]!.state === 'reserved');
        if (waiting.length) {
          const turn = r.pick(waiting);
          // A claim, or a reply Turn that ends without a claim.
          if (action === 5) { claimUnit(state, turn.unit); claimUnit(state, turn.unit); } else releaseUnit(state, turn.unit);
        }
      }
      check(state, initial, seed);
      observe(state);
    }
    for (const d of open()) { resolveDelegation(state, d, 'answered', now, emit); check(state, initial, seed); observe(state); }
    for (const d of Object.values(state.delegations)) expect(d.replyTurnId, `seed ${seed}`).toBeDefined();
  }
  expect([...reached].sort()).toEqual(['batch Turn', 'budget_exhausted', 'late report', 'released with no Turn', 'two open batches']);
});
