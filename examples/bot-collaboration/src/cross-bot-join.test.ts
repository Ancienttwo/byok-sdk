import { afterEach, expect, it, vi } from 'vitest';
import { hash } from '@byok-sdk/server/execution-core';
import { openTeam, type TestTeam } from './team.test-support';
import { crossBot } from './cross-bot.test-support';
import { stateOf } from './model';

let fixture: TestTeam;
afterEach(async () => { await fixture?.close(); vi.restoreAllMocks(); });
const t = crossBot(() => fixture);
const UNCERTAIN_AFTER_MS = 30 * 60_000;

/** Records spent + reserved of one root after every ledger transaction. */
function watchBudget(root: string) {
  const transaction = fixture.ledger.transaction.bind(fixture.ledger);
  const committed: number[] = [];
  vi.spyOn(fixture.ledger, 'transaction').mockImplementation(apply => transaction((s, rows) => {
    const value = apply(s, rows);
    const budget = stateOf(s.application).budgets[root];
    if (budget) committed.push(budget.delegation + (budget.reserved ?? 0));
    return value;
  }));
  return committed;
}
/** The Host has observed the claim of this Turn. The §8.3 timer counts from that observation. */
async function claimed(id: string) {
  const session = await t.running(id);
  await vi.waitFor(async () => { await t.host().drain(); expect(t.delegation(id).claimed?.turnId).toBe(id); }, { timeout: 5000 });
  return session;
}
async function verdict(id: string) {
  await vi.waitFor(async () => { await t.host().drain(); expect(t.delegation(id).verdict).toBeDefined(); }, { timeout: 5000 });
  return t.delegation(id);
}
async function spent(unit: string) {
  await vi.waitFor(async () => { await t.host().drain(); expect(t.host().snapshot().units[unit]!.state).toBe('spent'); }, { timeout: 5000 });
}
const replyTurns = () => Object.values(t.host().snapshot().turns).filter(turn => turn.source === 'bot_reply');
async function startWithSpent(key: string, from: string, units: number) {
  const root = await t.host().input(key, 'Ask two Bots', from);
  await t.running(root);
  fixture.ledger.transaction(s => { stateOf(s.application).budgets[root]!.delegation = units; });
  return root;
}

it('spent 8 + fan-out 2 reserves 4; an uncertain sibling releases the batch, and its late verdict adds exactly one A Turn: 12, never 13', async () => {
  let clock = Date.now();
  fixture = await openTeam({ routeMessages: true, now: () => clock });
  const [a, b, c] = await t.createBots(3) as [string, string, string];
  const root = await startWithSpent('spent-8', a, 8);
  const committed = watchBudget(root);
  await t.finish(root, { delegate: [{ to: b, request: 'fast' }, { to: c, request: 'slow' }] });
  const task = t.taskOf(root), fast = t.delegationOf(task, 0), slow = t.delegationOf(task, 1);
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 8, reserved: 4 });

  const slowSession = await claimed(slow.id);
  await t.finish(fast.id);
  expect(t.delegation(fast.id).verdict).toBe('answered');
  expect(replyTurns()).toEqual([]);
  clock += UNCERTAIN_AFTER_MS; await t.host().drain();
  expect(t.delegation(slow.id)).toMatchObject({ status: 'uncertain' });
  const batchId = hash(['bot_reply', task]);
  expect(replyTurns()).toEqual([expect.objectContaining({ id: batchId,
    replies: [expect.objectContaining({ delegationId: fast.id, verdict: 'answered' })] })]);
  expect(t.delegation(slow.id).replyTurnId).toBeUndefined();
  // The batch keeps its second slot for the late report.
  expect(t.host().snapshot().units[hash([task, 'A', 1])]).toMatchObject({ state: 'reserved' });
  await t.finish(batchId);
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 11, reserved: 1 });

  slowSession.finish({});
  expect(await verdict(slow.id)).toMatchObject({ verdict: 'answered', replyTurnId: hash(['bot_reply', slow.id]) });
  const late = t.host().snapshot().turns[hash(['bot_reply', slow.id])]!;
  expect(late).toMatchObject({ unit: hash([task, 'A', 1]), replies: [expect.objectContaining({ delegationId: slow.id, verdict: 'answered' })] });
  await t.finish(late.id);
  expect(replyTurns().map(turn => turn.id)).toEqual([batchId, late.id]);
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 12, reserved: 0 });
  expect(Math.max(...committed)).toBe(12);
});

it('spent 9 + fan-out 2 refuses index 1 with budget_exhausted and commits 11', async () => {
  fixture = await openTeam({ routeMessages: true });
  const [a, b, c] = await t.createBots(3) as [string, string, string];
  const root = await startWithSpent('spent-9', a, 9);
  const committed = watchBudget(root);
  await t.finish(root, { delegate: [{ to: b, request: 'kept' }, { to: c, request: 'cut' }] });
  const task = t.taskOf(root), kept = t.delegationOf(task, 0), cut = t.delegationOf(task, 1);
  expect(kept.status).toBe('queued');
  expect(cut).toMatchObject({ verdict: 'refused', reason: 'budget_exhausted' });
  expect(t.host().snapshot().turns[cut.id]).toBeUndefined();
  expect(t.host().snapshot().rejected).toContainEqual(expect.objectContaining({ botId: a, action: 'delegate', reason: 'budget_exhausted' }));
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 9, reserved: 2 });
  await t.finish(kept.id);
  // A batch of one keeps the single reply key, and the refusal rides in it.
  const replyId = hash(['bot_reply', kept.id]);
  expect(t.host().snapshot().turns[replyId]!.replies!.map(r => [r.delegationId, r.verdict, r.reason])).toEqual([
    [kept.id, 'answered', undefined], [cut.id, 'refused', 'budget_exhausted']]);
  await t.finish(replyId);
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 11, reserved: 0 });
  expect(Math.max(...committed)).toBe(11);
});

it('interleaved batches (§6.2): the second fan-out is cut to 1, the committed total stays <= 11, and the old late report starts', async () => {
  let clock = Date.now();
  fixture = await openTeam({ routeMessages: true, now: () => clock });
  const [a, b, c] = await t.createBots(3) as [string, string, string];
  const root = await startWithSpent('interleaved', a, 5);
  await t.finish(root, { delegate: [{ to: b, request: 'old answered' }, { to: c, request: 'old uncertain' }] });
  const oldTask = t.taskOf(root), answered = t.delegationOf(oldTask, 0), open = t.delegationOf(oldTask, 1);
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 5, reserved: 4 });
  const openSession = await claimed(open.id);
  await t.finish(answered.id);
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 7, reserved: 2 });
  clock += UNCERTAIN_AFTER_MS; await t.host().drain();
  expect(t.delegation(open.id).status).toBe('uncertain');

  const batchId = hash(['bot_reply', oldTask]);
  await t.running(batchId);
  await spent(hash([oldTask, 'A', 0]));
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 8, reserved: 1 });
  const committed = watchBudget(root);
  await t.finish(batchId, { delegate: [{ to: b, request: 'new kept' }, { to: c, request: 'new cut' }] });
  const newTask = t.taskOf(batchId), kept = t.delegationOf(newTask, 0), cut = t.delegationOf(newTask, 1);
  expect([kept.status, kept.hop]).toEqual(['queued', 1]);
  expect(cut).toMatchObject({ verdict: 'refused', reason: 'budget_exhausted' });
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 8, reserved: 3 });

  openSession.finish({});
  expect(await verdict(open.id)).toMatchObject({ verdict: 'answered', replyTurnId: hash(['bot_reply', open.id]) });
  const late = hash(['bot_reply', open.id]);
  expect(t.host().snapshot().turns[late]!.unit).toBe(hash([oldTask, 'A', 1]));
  await t.running(late);
  await spent(hash([oldTask, 'A', 1]));
  await t.finish(late);
  await t.finish(kept.id);
  await t.finish(hash(['bot_reply', kept.id]));
  expect(t.host().snapshot().turns[hash(['bot_reply', kept.id])]!.replies!.map(r => r.delegationId)).toEqual([kept.id, cut.id]);
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 11, reserved: 0 });
  expect(Math.max(...committed)).toBe(11);
});
