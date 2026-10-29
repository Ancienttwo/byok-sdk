import { afterEach, expect, it, vi } from 'vitest';
import type { ByokServer } from '@byok-sdk/server';
import { hash } from '@byok-sdk/server/execution-core';
import { openTeam, type TestTeam } from './team.test-support';
import { crossBot } from './cross-bot.test-support';
import { stateOf } from './model';
import { ROOT_BOT_BUDGET } from './delegation';
import { BotCollaboration } from './host';

let fixture: TestTeam;
afterEach(async () => { await fixture?.close(); vi.restoreAllMocks(); });
const t = crossBot(() => fixture);
type Readback = Awaited<ReturnType<ByokServer['tasks']['agentMessage']>>;

it('B success terminal without a Host record -> reply_pending -> answered by the example loop, without a K4 scan', async () => {
  // The server consumer accepts without the Host. The test then commits the Host record late
  // with the real received payload. This simulates a Host record that commits after the terminal.
  fixture = await openTeam();
  const [a, b] = await t.createBots(2) as [string, string];
  const root = await t.host().input('pending', 'Ask Bot 2', a);
  await t.finish(root, { delegate: [{ to: b, request: 'Answer later' }] });
  const d = t.delegationOf(t.taskOf(root));
  await t.finish(d.id);
  const task = t.taskOf(d.id);
  expect(t.delegation(d.id)).toMatchObject({ status: 'reply_pending', checks: 1 });
  expect(fixture.ledger.snapshot().scanWake).toBeNull();
  expect(await fixture.server.tasks.agentMessage(task, fixture.deviceId, t.host().core.intent(d.id)!.execution.payload.agentRef))
    .toMatchObject({ disposition: { outcome: 'accepted' } });
  const message = fixture.received.find(row => row.taskId === task)!;
  expect(await t.host().consumeMessage(message)).toEqual({ outcome: 'accepted' });
  // No drain, wake or K4 scan: the Host timer converges on the persisted check time.
  await vi.waitFor(() => expect(t.delegation(d.id).verdict).toBe('answered'), { timeout: 5000 });
  expect(t.delegation(d.id).reply).toBe(task);
  expect(t.events(d.id).map(e => e.status)).toEqual(['queued', 'running', 'reply_pending', 'resolved']);
  await t.finish(hash(['bot_reply', d.id]));
});

it('held readback -> reply_held -> End -> abandoned; no message -> failed (no_reply)', async () => {
  // Injected SDK readback states. The current daemon publishes success only after an accepted
  // disposition, so a real held or missing message cannot pair with a success terminal.
  let readback: (real: Readback) => Readback = real => real && { payload: real.payload, context: real.context };
  fixture = await openTeam({ wrapServer: server => ({ ...server, tasks: { ...server.tasks,
    agentMessage: async (...args) => readback(await server.tasks.agentMessage(...args)) } }) });
  const [a, b] = await t.createBots(2) as [string, string];
  const root = await t.host().input('held', 'Ask Bot 2', a);
  await t.finish(root, { delegate: [{ to: b, request: 'Reply' }] });
  const d = t.delegationOf(t.taskOf(root));
  await t.finish(d.id);
  expect(t.delegation(d.id)).toMatchObject({ status: 'reply_pending', checks: 1 });
  readback = real => real && { ...real, disposition: { ...real.disposition!, outcome: 'held' } };
  await vi.waitFor(() => expect(t.delegation(d.id).status).toBe('reply_held'), { timeout: 5000 });
  expect(t.delegation(d.id).verdict).toBeUndefined();
  expect(t.delegation(d.id).nextCheckAt).toBeUndefined();
  await t.host().abandonDelegation(d.id);
  expect(t.delegation(d.id)).toMatchObject({ verdict: 'abandoned', reason: 'reply_held', replyTurnId: hash(['bot_reply', d.id]) });
  await expect(t.host().abandonDelegation(d.id)).rejects.toThrow('cannot be ended');
  await t.finish(hash(['bot_reply', d.id]));

  readback = () => undefined;
  const second = await t.host().input('no-message', 'Ask again', a);
  await t.finish(second, { delegate: [{ to: b, request: 'Reply again' }] });
  const d2 = t.delegationOf(t.taskOf(second));
  await t.finish(d2.id);
  expect(t.delegation(d2.id)).toMatchObject({ verdict: 'failed', reason: 'no_reply' });
  expect(t.host().snapshot().turns[hash(['bot_reply', d2.id])]!.replies).toEqual([expect.objectContaining({ verdict: 'failed', reason: 'no_reply' })]);
});

it('recovers B after a crash between the delegation write and submit, then ignores a replayed message and recovery', async () => {
  let blocked: string | undefined;
  fixture = await openTeam({ routeMessages: true, wrapServer: server => ({ ...server, executions: { submit: async input => {
    if (input.payload.agentRef.agentId === blocked) throw new Error('crash boundary before executions.submit');
    return server.executions.submit(input);
  } } }) });
  const [a, b] = await t.createBots(2) as [string, string];
  blocked = b;
  const root = await t.host().input('crash', 'Ask Bot 2', a);
  await t.finish(root, { delegate: [{ to: b, request: 'Survive the crash' }] });
  const d = t.delegationOf(t.taskOf(root));
  const task = t.taskOf(d.id);
  const frozen = structuredClone(fixture.ledger.snapshot().executions[task]!.input);
  expect(await fixture.server.tasks.offer(task)).toBeUndefined();
  blocked = undefined;
  await fixture.reopen();
  await t.finish(d.id);
  expect(fixture.ledger.snapshot().executions[task]!.input).toEqual(frozen);
  expect(fixture.adapter.starts.filter(start => start.manifest.taskId === task)).toHaveLength(1);
  expect(t.delegation(d.id).verdict).toBe('answered');
  await t.finish(hash(['bot_reply', d.id]));

  const saved = { delegations: t.host().snapshot().delegations, units: t.host().snapshot().units, budgets: t.host().snapshot().budgets };
  const message = fixture.received.find(row => row.taskId === task)!;
  expect(await t.host().consumeMessage(message)).toEqual({ outcome: 'accepted' });
  expect(await t.host().consumeMessage({ ...message, payload: { ...message.payload, messageId: crypto.randomUUID() } }))
    .toEqual({ outcome: 'refused', reasonCode: 'message_conflict' });
  await fixture.reopen(); await t.host().recover();
  const after = t.host().snapshot();
  expect({ delegations: after.delegations, units: after.units, budgets: after.budgets }).toEqual(saved);
  expect(Object.values(after.turns).filter(turn => turn.source === 'bot_reply')).toHaveLength(1);
  expect(t.events(d.id)).toHaveLength(3);
});

it.each(['failure', 'missing outcome', 'outcome outside the schema'] as const)('B %s -> failed, one report, B unit spent', async cause => {
  fixture = await openTeam({ routeMessages: true });
  const [a, b] = await t.createBots(2) as [string, string];
  const root = await t.host().input('b-fails', 'Ask Bot 2', a);
  await t.finish(root, { delegate: [{ to: b, request: 'Try' }] });
  const d = t.delegationOf(t.taskOf(root));
  const session = await t.running(d.id);
  if (cause === 'failure') session.fail();
  else if (cause === 'missing outcome') session.finish({}, false);
  else session.finish({ delegate: [{ to: 'not-a-team-bot', request: 'x' }] });
  await vi.waitFor(async () => { await t.host().drain(); expect(t.delegation(d.id).verdict).toBe('failed'); }, { timeout: 5000 });
  expect(t.host().snapshot().turns[d.id]!.status).toBe('failed');
  expect(Object.values(t.host().snapshot().turns).filter(turn => turn.source === 'bot_reply')).toEqual([
    expect.objectContaining({ id: hash(['bot_reply', d.id]), replies: [expect.objectContaining({ verdict: 'failed' })] })]);
  expect(t.host().snapshot().units[hash([d.id, 'B'])]!.state).toBe('spent');
});

it('B runs in its own conversation: the bot_request waits in B\'s FIFO', async () => {
  fixture = await openTeam({ routeMessages: true });
  const [a, b] = await t.createBots(2) as [string, string];
  const own = await t.host().input('b-own', 'Own work', b);
  await t.running(own);
  const root = await t.host().input('ask-busy-b', 'Ask Bot 2', a);
  await t.finish(root, { delegate: [{ to: b, request: 'After your own work' }] });
  const d = t.delegationOf(t.taskOf(root));
  await t.host().drain();
  expect(t.host().core.intent(d.id)?.phase).toBe('queued');
  expect(await fixture.server.tasks.offer(t.taskOf(d.id))).toBeUndefined();
  expect(t.delegation(d.id).status).toBe('queued');
  await t.finish(own);
  await t.finish(d.id);
  expect(t.delegation(d.id).verdict).toBe('answered');
});

it('Main Bot changes B\'s profile during a delegation: the running execution keeps its revision, the next one waits for readback', async () => {
  fixture = await openTeam({ routeMessages: true });
  const [a, b] = await t.createBots(2) as [string, string];
  const first = await t.host().input('profile-1', 'Ask Bot 2', a);
  await t.finish(first, { delegate: [{ to: b, request: 'Old profile' }] });
  const d1 = t.delegationOf(t.taskOf(first));
  await t.running(d1.id);
  const update = await t.host().input('update-b', 'Update Bot 2');
  await t.finish(update, { update_bot: [{ botId: b, persona: 'New persona' }] });
  expect(t.host().core.intent(d1.id)!.execution.payload.agentRef.profileRevision).toBe('1');
  await t.finish(d1.id);
  await t.finish(hash(['bot_reply', d1.id]));
  const second = await t.host().input('profile-2', 'Ask Bot 2 again', a);
  await t.finish(second, { delegate: [{ to: b, request: 'New profile' }] });
  const d2 = t.delegationOf(t.taskOf(second));
  await t.running(d2.id);
  expect(t.host().core.intent(d2.id)!.execution.payload.agentRef.profileRevision).toBe('2');
  expect(t.delegation(d2.id).toAgentRef).toEqual({ agentId: b, profileRevision: '2' });
  await t.finish(d2.id);
});

it('spent 11: the refusal report starts with the last unit; free balance 0: the report is delivery only', async () => {
  fixture = await openTeam({ routeMessages: true });
  const [a, b] = await t.createBots(2) as [string, string];
  const root = await t.host().input('budget-11', 'Ask Bot 2', a);
  await t.running(root);
  fixture.ledger.transaction(s => { stateOf(s.application).budgets[root]!.delegation = 11; });
  await t.finish(root, { delegate: [{ to: b, request: 'Over budget' }] });
  expect(t.delegationOf(t.taskOf(root))).toMatchObject({ verdict: 'refused', reason: 'budget_exhausted' });
  const report = hash(['bot_reply', t.taskOf(root)]);
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 11, reserved: 1 });
  await t.finish(report);
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 12, reserved: 0 });

  const full = await t.host().input('budget-12', 'Ask Bot 2 again', a);
  await t.running(full);
  fixture.ledger.transaction(s => { stateOf(s.application).budgets[full]!.delegation = 12; });
  await t.finish(full, { delegate: [{ to: b, request: 'No unit left' }] });
  const delivered = t.host().snapshot().turns[hash(['bot_reply', t.taskOf(full)])]!;
  expect(delivered).toMatchObject({ status: 'delivered', conclusion: 'delivered', refusalReport: true });
  expect(delivered.unit).toBeUndefined();
  expect(t.host().core.intent(delivered.id)).toBeUndefined();
  expect(t.host().snapshot().budgets[full]).toMatchObject({ delegation: 12, reserved: 0 });
  const next = await t.host().input('after-delivery', 'What happened?', a);
  await t.running(next);
  expect(t.context(next).turns).toContainEqual(expect.objectContaining({ id: delivered.id, status: 'delivered', request: expect.stringContaining('budget_exhausted') }));
});

it('keeps spent + reserved <= 12 inside every ledger transaction of a delegation flow with recovery', async () => {
  fixture = await openTeam({ routeMessages: true });
  const [a, b] = await t.createBots(2) as [string, string];
  const transaction = fixture.ledger.transaction.bind(fixture.ledger);
  let checked = 0;
  const violations: unknown[] = [];
  vi.spyOn(fixture.ledger, 'transaction').mockImplementation(apply => transaction((s, rows) => {
    const value = apply(s, rows);
    for (const budget of Object.values(stateOf(s.application).budgets)) {
      if (budget.delegation + (budget.reserved ?? 0) > ROOT_BOT_BUDGET) violations.push(structuredClone(budget));
    }
    checked++;
    return value;
  }));
  const root = await t.host().input('invariant', 'Ask Bot 2', a);
  fixture.ledger.transaction(s => { stateOf(s.application).budgets[root]!.delegation = 9; });
  await t.finish(root, { delegate: [{ to: b, request: 'Within budget' }] });
  const d = t.delegationOf(t.taskOf(root));
  await t.finish(d.id, { delegate: [{ to: a, request: 'Ask back' }] });
  const back = t.delegationOf(t.taskOf(d.id));
  expect(back).toMatchObject({ verdict: 'refused', reason: 'budget_exhausted' });
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 10, reserved: 2 });
  await t.finish(hash(['bot_reply', d.id]));
  await t.finish(hash(['bot_reply', t.taskOf(d.id)]));
  const settled = structuredClone(t.host().snapshot().units);
  // Recovery replays sync on the same ledger object, so the spy still checks each transaction.
  await t.host().close();
  const recovered = new BotCollaboration(fixture.server, fixture.ledger, fixture.botOptions);
  await recovered.recover(); await recovered.recover();
  expect(stateOf(fixture.ledger.snapshot().application).units).toEqual(settled);
  expect(stateOf(fixture.ledger.snapshot().application).budgets[root]).toMatchObject({ delegation: 12, reserved: 0 });
  await recovered.close();
  expect(checked).toBeGreaterThan(0);
  expect(violations).toEqual([]);
  vi.restoreAllMocks();
  await fixture.reopen();
});

it('keeps a target with a pending newer profile in the enum; its bot_request waits for the readback', async () => {
  let hold: Promise<void> | undefined, release!: () => void;
  fixture = await openTeam({ routeMessages: true, holdProjection: () => hold ?? Promise.resolve() });
  const [a, b] = await t.createBots(2) as [string, string];
  hold = new Promise(resolve => { release = resolve; });
  const update = await t.host().input('pending-profile', 'Update Bot 2');
  await t.finish(update, { update_bot: [{ botId: b, persona: 'Pending persona' }] });
  expect(t.host().snapshot().team.bots[b]).toMatchObject({ revision: '2', readyRevision: null });
  const root = await t.host().input('ask-pending', 'Ask Bot 2', a);
  await t.running(root);
  expect(t.host().snapshot().schemas[root]!.properties!.delegate!.items!.properties!.to!.enum).toEqual([a, 'main', b]);
  await t.finish(root, { delegate: [{ to: b, request: 'After your new profile' }] });
  const d = t.delegationOf(t.taskOf(root));
  expect(d).toMatchObject({ status: 'queued', toAgentRef: { agentId: b, profileRevision: '2' } });
  await t.host().drain();
  expect(t.host().core.intent(d.id)).toBeUndefined();
  release(); hold = undefined;
  await t.running(d.id);
  expect(t.host().core.intent(d.id)!.execution.payload.agentRef.profileRevision).toBe('2');
  await t.finish(d.id);
  expect(t.delegation(d.id).verdict).toBe('answered');
});
