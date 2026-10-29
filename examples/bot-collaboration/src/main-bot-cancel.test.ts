import { afterEach, expect, it, vi } from 'vitest';
import { hash } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { openTeam, type TestTeam } from './team.test-support';
import { crossBot } from './cross-bot.test-support';
import { stateOf, type Delegation, type Turn } from './model';
import { outcomeSchema, turnContext } from './schema';
import { OPEN_DELEGATIONS_MAX_ITEMS } from './delegation';
import { routineViews } from './routines.test-support';

let fixture: TestTeam | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; vi.restoreAllMocks(); });
const t = crossBot(() => fixture!);

/** Bot 1 delegates to Bot 2. The Main Bot is `main`, outside the delegation. */
async function delegated(key: string) {
  const [a, b] = await t.createBots(2) as [string, string];
  const root = await t.host().input(key, 'Ask Bot 2', a);
  await t.finish(root, { delegate: [{ to: b, request: 'Check the draft' }] });
  return { a, b, d: t.delegationOf(t.taskOf(root)) };
}
const schemaOf = (turnId: string) => t.host().snapshot().schemas[turnId]!;
const cancelEnum = (turnId: string) => schemaOf(turnId).properties!.cancel_delegation?.items!.properties!.delegationId!.enum;
const reportsTo = (botId: string) => Object.values(t.host().snapshot().turns).filter(turn => turn.source === 'bot_reply' && turn.botId === botId);

it('Main Bot with owner authority cancels a running delegation -> one cancelled verdict, A receives one report', async () => {
  fixture = await openTeam({ routeMessages: true });
  const { a, d } = await delegated('main-cancel');
  await t.running(d.id);
  // The Main Bot offer freezes after the Host has observed B's claim.
  await vi.waitFor(async () => { await t.host().drain(); expect(t.delegation(d.id).status).toBe('running'); }, { timeout: 5000 });
  const order = await t.host().input('order-cancel', 'Stop the review by Bot 2');
  await t.running(order);
  expect(cancelEnum(order)).toEqual([d.id]);
  expect(t.context(order).openDelegations).toEqual({ items: [{ id: d.id, from: a, to: d.toBotId, status: 'running', request: 'Check the draft' }],
    omitted: 0, notice: null });
  await t.finish(order, { cancel_delegation: [{ delegationId: d.id }] });
  expect(t.delegation(d.id).cancel).toMatchObject({ targetTurnId: d.id, delivered: true, reason: 'main_bot_cancelled' });
  expect(t.host().core.intent(d.id)!.cancelReason).toBe('cancelled');
  await vi.waitFor(async () => { await t.host().drain(); expect(t.delegation(d.id).verdict).toBe('cancelled'); }, { timeout: 5000 });
  expect(t.delegation(d.id)).toMatchObject({ verdict: 'cancelled', reason: 'main_bot_cancelled' });
  expect(t.events(d.id).filter(e => e.status === 'resolved')).toEqual([expect.objectContaining({ verdict: 'cancelled', reason: 'main_bot_cancelled' })]);
  const reports = reportsTo(a);
  expect(reports).toHaveLength(1);
  expect(reports[0]!.replies).toEqual([expect.objectContaining({ delegationId: d.id, verdict: 'cancelled', reason: 'main_bot_cancelled' })]);
  expect(t.host().snapshot().rejected.filter(r => r.action === 'cancel_delegation')).toEqual([]);
  await t.finish(reports[0]!.id);
  await t.host().drain();
  expect(reportsTo(a)).toHaveLength(1);
  expect(t.events(d.id).filter(e => e.status === 'resolved')).toHaveLength(1);
});

it('offers cancel_delegation only to the Main Bot on an owner Turn: a normal Bot and a Main Bot bot_request get none', async () => {
  fixture = await openTeam({ routeMessages: true });
  const [a, b] = await t.createBots(2) as [string, string];
  // Bot 1 asks the Main Bot. That delegation stays open while each schema below is frozen.
  const root = await t.host().input('ask-main', 'Ask the Main Bot', a);
  await t.finish(root, { delegate: [{ to: 'main', request: 'Plan the week' }] });
  const d = t.delegationOf(t.taskOf(root));
  await t.running(d.id);
  expect(t.host().snapshot().turns[d.id]).toMatchObject({ botId: 'main', source: 'bot_request', authority: 'bot' });
  expect(schemaOf(d.id).properties).not.toHaveProperty('cancel_delegation');
  expect(t.context(d.id)).not.toHaveProperty('openDelegations');
  const normal = await t.host().input('normal', 'Any open work?', b);
  await t.running(normal);
  expect(schemaOf(normal).properties).not.toHaveProperty('cancel_delegation');
  expect(t.context(normal)).not.toHaveProperty('openDelegations');
  // Control: the Main Bot's owner Turn at the same time lists the open delegation. Its schema freezes at admission.
  const owner = await t.host().input('owner', 'Any open work?');
  expect(cancelEnum(owner)).toEqual([d.id]);
  await t.finish(d.id);
  await t.finish(normal);
  await t.finish(owner);
});

it('a resolved target -> rejected action already_resolved, no second verdict; the Main Bot sees the rejection next', async () => {
  fixture = await openTeam({ routeMessages: true });
  const { a, d } = await delegated('resolved-target');
  const session = await t.running(d.id);
  // The Main Bot offer is frozen while the delegation is open.
  const order = await t.host().input('late-order', 'Stop the review by Bot 2');
  await t.running(order);
  expect(cancelEnum(order)).toEqual([d.id]);
  session.finish({});
  await vi.waitFor(async () => { await t.host().drain(); expect(t.delegation(d.id).verdict).toBe('answered'); }, { timeout: 5000 });
  const resolved = t.events(d.id);
  await t.finish(order, { cancel_delegation: [{ delegationId: d.id }] });
  const state = t.host().snapshot();
  expect(state.delegations[d.id]).toMatchObject({ verdict: 'answered' });
  expect(state.delegations[d.id]!.cancel).toBeUndefined();
  expect(state.rejected.filter(r => r.action === 'cancel_delegation')).toEqual([
    { botId: 'main', taskId: t.taskOf(order), action: 'cancel_delegation', reason: 'already_resolved' }]);
  expect(t.events(d.id)).toEqual(resolved);
  expect(reportsTo(a)).toHaveLength(1);
  const next = await t.host().input('after-order', 'Did the cancel work?');
  await t.running(next);
  expect(t.context(next).rejectedActions).toEqual([expect.objectContaining({ action: 'cancel_delegation', reason: 'already_resolved' })]);
  expect(schemaOf(next).properties).not.toHaveProperty('cancel_delegation');
  await t.finish(next);
  await t.finish(reportsTo(a)[0]!.id);
});

it('apply rechecks the Main Bot role: an offer frozen before the role change is rejected and the delegation stays open', async () => {
  fixture = await openTeam({ routeMessages: true });
  const { d } = await delegated('role-change');
  await t.running(d.id);
  const order = await t.host().input('order-role', 'Stop the review by Bot 2');
  await t.running(order);
  expect(cancelEnum(order)).toEqual([d.id]);
  await t.host().setMainBot('main', false);
  await t.finish(order, { cancel_delegation: [{ delegationId: d.id }] });
  expect(t.host().snapshot().rejected.filter(r => r.action === 'cancel_delegation')).toEqual([
    expect.objectContaining({ botId: 'main', reason: 'Main Bot role required' })]);
  expect(t.delegation(d.id).cancel).toBeUndefined();
  expect(t.delegation(d.id).verdict).toBeUndefined();
  await t.finish(d.id);
  expect(t.delegation(d.id).verdict).toBe('answered');
});

function team(bots: number) {
  const state = stateOf({});
  const ids = Array.from({ length: bots }, (_, i) => hash(['bot', i]));
  for (const [i, id] of ids.entries()) state.team.bots[id] = { id, name: `Bot ${i}`, role: 'r', persona: '', model: 'default',
    mainBot: i === 0, archived: false, revision: '1', readyRevision: '1', execution: template('device', id) };
  const open = (n: number, fields: Partial<Delegation> = {}) => {
    const id = hash(['d', n]);
    state.delegations[id] = { id, root: 'r', fromBotId: ids[0]!, fromTurnId: 'o', fromTaskId: 't', index: 0, toBotId: ids.at(-1)!,
      request: `request ${n}`, hop: 1, chainTurnIds: [id], batch: 't', status: 'running', revision: 1, ...fields };
    return id;
  };
  const owner: Turn = { id: 'owner', root: 'owner', botId: ids[0]!, source: 'user', request: 'x', hop: 0, status: 'queued', authority: 'owner' };
  return { state, ids, open, owner };
}

it('lists open delegations newest first, at most 24, and counts the rest in the ContextPack notice', () => {
  const { state, ids, open, owner } = team(2);
  const listed = Array.from({ length: OPEN_DELEGATIONS_MAX_ITEMS + 2 }, (_, n) => open(n));
  // Resolved, already cancelled, and uncertain or held delegations are not cancellable by this action.
  open(100, { status: 'resolved', verdict: 'answered' });
  open(101, { cancel: { requestedAt: 0, targetTurnId: hash(['d', 101]), delivered: true } });
  open(102, { status: 'uncertain' }); open(103, { status: 'reply_held' });
  const newest = listed.reverse().slice(0, OPEN_DELEGATIONS_MAX_ITEMS);
  expect(outcomeSchema(ids[0]!, state, owner).properties!.cancel_delegation!.items!.properties!.delegationId!.enum).toEqual(newest);
  const context = turnContext(state, owner);
  expect(context.openDelegations!.items.map(item => item.id)).toEqual(newest);
  expect(context.openDelegations).toMatchObject({ omitted: 2, notice: '2 more open delegations are not listed. The owner can cancel them.' });
});

it('measures the Main Bot schema with 24 Bots, 8 routines and 24 open delegations within the schema cap', async () => {
  const protocol = await import('@byok-sdk/protocol');
  const { state, ids, open, owner } = team(24);
  for (let n = 0; n < OPEN_DELEGATIONS_MAX_ITEMS; n++) open(n);
  const schema = outcomeSchema(ids[0]!, state, owner, ['default'], routineViews(ids[0]!, 8));
  expect(schema.properties!.cancel_delegation!.items!.properties!.delegationId!.enum).toHaveLength(OPEN_DELEGATIONS_MAX_ITEMS);
  expect(schema.properties!.cancel_delegation!.maxItems).toBe(2);
  expect(Buffer.byteLength(JSON.stringify(schema))).toBe(15_949);
  expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThanOrEqual(protocol.RESULT_SCHEMA_MAX_BYTES);
  expect(protocol.resultOutcomeMaxBytes(schema)).toBeLessThanOrEqual(protocol.RESULT_OUTCOME_MAX_BYTES);
});
