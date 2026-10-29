import { afterEach, expect, it, vi } from 'vitest';
import { hash, taskId } from '@byok-sdk/server/execution-core';
import { openTeam, type TestTeam } from './team.test-support';
import { crossBot } from './cross-bot.test-support';
import type { AgentMessageInput } from './host';

let fixture: TestTeam;
afterEach(async () => { await fixture?.close(); vi.restoreAllMocks(); });
const t = crossBot(() => fixture);

/** Holds one B message at one stage of the server consumer, around the Host acceptance transaction. */
function messageGate(stage: 'before' | 'after') {
  let task: string | undefined, arrive!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { arrive = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { arrived, release, arm(id: string) { task = id; },
    async hook(input: AgentMessageInput, at: 'before' | 'after') {
      if (at !== stage || input.taskId !== task) return;
      task = undefined; arrive(); await released;
    } };
}
async function delegated(fixtureKey: string) {
  const [a, b] = await t.createBots(2) as [string, string];
  const root = await t.host().input(fixtureKey, 'Ask Bot 2', a);
  await t.finish(root, { delegate: [{ to: b, request: 'Check the draft' }] });
  return { a, b, root, d: t.delegationOf(t.taskOf(root)) };
}
/** B's session runs and the Host has observed its claim. The §8.3 timer counts from that observation. */
async function claimed(id: string) {
  const session = await t.running(id);
  await vi.waitFor(async () => { await t.host().drain(); expect(t.delegation(id).claimed?.turnId).toBe(id); }, { timeout: 5000 });
  return session;
}
async function verdict(id: string) {
  await vi.waitFor(async () => { await t.host().drain(); expect(t.delegation(id).verdict).toBeDefined(); }, { timeout: 5000 });
  return t.delegation(id);
}

it('cancel commits before acceptance -> B message refused, cancelled with no reply, B outcome not applied', async () => {
  const gate = messageGate('before');
  fixture = await openTeam({ routeMessages: true, holdMessage: (input, stage) => gate.hook(input, stage) });
  const { d } = await delegated('cancel-first');
  const task = t.taskOf(d.id);
  gate.arm(task);
  (await t.running(d.id)).finish({});
  await gate.arrived;
  await t.host().cancelDelegation(d.id);
  expect(t.delegation(d.id).cancel).toMatchObject({ targetTurnId: d.id, delivered: true });
  expect(t.host().core.intent(d.id)!.cancelReason).toBe('cancelled');
  gate.release();
  expect(await verdict(d.id)).toMatchObject({ verdict: 'cancelled', reason: 'user_cancelled' });
  const state = t.host().snapshot();
  expect(state.replies[task]).toBeUndefined();
  expect(state.audit).toContain(`Delegation message after cancel: ${d.id} ${task}`);
  expect(state.delegations[d.id]!.reply).toBeUndefined();
  expect(state.turns[d.id]!.outcome).toBeUndefined();
  expect(state.turns[hash(['bot_reply', d.id])]!.replies).toEqual([expect.not.objectContaining({ reply: expect.anything() })]);
  expect(t.events(d.id).map(e => [e.status, e.verdict])).toEqual([['queued', undefined], ['running', undefined], ['resolved', 'cancelled']]);
  await expect(t.host().cancelDelegation(d.id)).rejects.toThrow('already resolved');
  await t.finish(hash(['bot_reply', d.id]));
});

it('acceptance commits before cancel -> cancelled with the accepted body marked partial', async () => {
  const gate = messageGate('after');
  fixture = await openTeam({ routeMessages: true, holdMessage: (input, stage) => gate.hook(input, stage) });
  const { d } = await delegated('accept-first');
  const task = t.taskOf(d.id);
  gate.arm(task);
  (await t.running(d.id)).finish({});
  await gate.arrived;
  expect(t.host().snapshot().replies[task]?.body).toBeDefined();
  await t.host().cancelDelegation(d.id);
  gate.release();
  expect(await verdict(d.id)).toMatchObject({ verdict: 'cancelled', reason: 'user_cancelled', reply: task, partial: true });
  const reply = hash(['bot_reply', d.id]);
  expect(t.host().snapshot().turns[reply]!.replies).toEqual([expect.objectContaining({ verdict: 'cancelled', reply: task, partial: true })]);
  await t.running(reply);
  expect(t.instruction(reply)).toContain('"partial":true');
  expect(t.instruction(reply)).toContain(t.host().snapshot().replies[task]!.body!);
  await t.finish(reply);
});

it('cancel while the target waits for persona readback -> cancelled at once, no core.cancel, B never runs', async () => {
  let hold: Promise<void> | undefined, release!: () => void;
  fixture = await openTeam({ routeMessages: true, holdProjection: () => hold ?? Promise.resolve() });
  const [a, b] = await t.createBots(2) as [string, string];
  hold = new Promise(resolve => { release = resolve; });
  const update = await t.host().input('pending-profile', 'Update Bot 2');
  await t.finish(update, { update_bot: [{ botId: b, persona: 'Pending persona' }] });
  const root = await t.host().input('ask-pending', 'Ask Bot 2', a);
  await t.finish(root, { delegate: [{ to: b, request: 'After your new profile' }] });
  const d = t.delegationOf(t.taskOf(root));
  expect(d.status).toBe('queued');
  expect(t.host().core.intent(d.id)).toBeUndefined();
  const cancel = vi.spyOn(t.host().core, 'cancel');
  await t.host().cancelDelegation(d.id);
  expect(cancel).not.toHaveBeenCalled();
  expect(t.delegation(d.id)).toMatchObject({ verdict: 'cancelled', reason: 'user_cancelled',
    cancel: { targetTurnId: d.id, delivered: true } });
  expect(t.host().snapshot().turns[d.id]).toMatchObject({ status: 'failed', conclusion: 'cancelled' });
  release();
  await vi.waitFor(async () => {
    await t.host().drain();
    expect(t.host().snapshot().team.bots[b]!.readyRevision).toBe('2');
  }, { timeout: 5000 });
  await t.finish(hash(['bot_reply', d.id]));
  expect(t.host().core.intent(d.id)).toBeUndefined();
  expect(fixture.adapter.starts.filter(start => start.manifest.taskId === taskId(d.id, 0))).toHaveLength(0);
});

it('crash after the arbitration commit and before core.cancel -> restart delivers the cancel to the frozen target', async () => {
  fixture = await openTeam({ routeMessages: true });
  const { d } = await delegated('cancel-crash');
  await claimed(d.id);
  vi.spyOn(t.host().core, 'cancel').mockRejectedValueOnce(new Error('crash boundary before core.cancel'));
  await expect(t.host().cancelDelegation(d.id)).rejects.toThrow('crash boundary');
  expect(t.delegation(d.id)).toMatchObject({ status: 'running', cancel: { targetTurnId: d.id, delivered: false } });
  expect(t.delegation(d.id).verdict).toBeUndefined();
  expect(t.host().core.intent(d.id)!.cancelReason).toBeUndefined();
  await fixture.reopen();
  expect(t.delegation(d.id).cancel).toMatchObject({ targetTurnId: d.id, delivered: true });
  expect(t.host().core.intent(d.id)!.cancelReason).toBe('cancelled');
  expect(await verdict(d.id)).toMatchObject({ verdict: 'cancelled', reason: 'user_cancelled' });
  expect(t.delegation(d.id).chainTurnIds).toEqual([d.id]);
  await t.finish(hash(['bot_reply', d.id]));
});

it('B drops while running; cancel finds no terminal -> uncertain, no resubmit; End -> abandoned; later terminal -> audit only', async () => {
  let clock = Date.now();
  fixture = await openTeam({ routeMessages: true, now: () => clock });
  const { d } = await delegated('b-drops');
  const task = t.taskOf(d.id);
  await claimed(d.id);
  await fixture.offline();
  await t.host().cancelDelegation(d.id);
  expect(t.delegation(d.id)).toMatchObject({ status: 'running', cancel: { delivered: true } });
  clock += 59_999; await t.host().drain();
  expect(t.delegation(d.id).status).toBe('running');
  clock += 1; await t.host().drain();
  expect(t.delegation(d.id)).toMatchObject({ status: 'uncertain', uncertainSince: clock });
  expect(t.delegation(d.id).verdict).toBeUndefined();
  await expect(t.host().cancelDelegation(d.id)).resolves.toBeUndefined();
  // No resubmit and no new generation.
  expect(t.host().core.intent(d.id)).toMatchObject({ generation: 0, taskId: task });
  expect(fixture.adapter.starts.filter(start => start.manifest.taskId === task)).toHaveLength(1);
  await t.host().abandonDelegation(d.id);
  expect(t.delegation(d.id)).toMatchObject({ verdict: 'abandoned', lateTurnId: d.id });
  const resolved = t.events(d.id);
  expect(resolved.map(e => e.status)).toEqual(['queued', 'running', 'uncertain', 'resolved']);
  await fixture.online();
  await vi.waitFor(async () => { await t.host().drain(); expect(t.host().core.intent(d.id)!.conclusion).toBeDefined(); }, { timeout: 10_000 });
  await t.host().drain();
  const state = t.host().snapshot();
  expect(state.audit).toContain(`Delegation terminal after verdict: ${d.id} ${task}`);
  expect(state.delegations[d.id]).toMatchObject({ verdict: 'abandoned' });
  expect(state.delegations[d.id]!.lateTurnId).toBeUndefined();
  expect(t.events(d.id)).toEqual(resolved);
  expect(Object.values(state.turns).filter(turn => turn.source === 'bot_reply')).toHaveLength(1);
  await t.finish(hash(['bot_reply', d.id]));
});

it('claimed with no terminal for uncertainAfterMs -> uncertain, then a later terminal gives the normal verdict', async () => {
  let clock = Date.now();
  fixture = await openTeam({ routeMessages: true, now: () => clock });
  const { d } = await delegated('slow-b');
  const session = await claimed(d.id);
  expect(t.delegation(d.id).claimed?.at).toBe(clock);
  clock += 30 * 60_000; await t.host().drain();
  expect(t.delegation(d.id)).toMatchObject({ status: 'uncertain', uncertainSince: clock });
  await expect(t.host().cancelDelegation(d.id)).rejects.toThrow('use abandonDelegation');
  session.finish({});
  expect(await verdict(d.id)).toMatchObject({ verdict: 'answered', reply: t.taskOf(d.id) });
  expect(t.events(d.id).map(e => e.status)).toEqual(['queued', 'running', 'uncertain', 'resolved']);
  await t.finish(hash(['bot_reply', d.id]));
});

it('cancelTurn on B\'s bot_request Turn runs the delegation cancel', async () => {
  fixture = await openTeam({ routeMessages: true });
  const { d } = await delegated('cancel-turn');
  await t.running(d.id);
  await t.host().cancelTurn(d.id);
  expect(t.delegation(d.id).cancel).toMatchObject({ targetTurnId: d.id, delivered: true });
  expect(await verdict(d.id)).toMatchObject({ verdict: 'cancelled', reason: 'user_cancelled' });
  await t.finish(hash(['bot_reply', d.id]));
});

it('B terminal reaches K4 after the cancel commit, without an SDK cancellation -> outcome audit only, no successor, partial reply', async () => {
  // The server hides B's terminal until the Host commits the cancel fact. K4 then sees task.complete
  // with no attempt.cancellation, so applyOutcome runs on a cancelled chain.
  let watch: { task: string; delegation: string } | undefined;
  fixture = await openTeam({ routeMessages: true, wrapServer: server => ({ ...server, tasks: { ...server.tasks,
    deviceTerminal: async id => id === watch?.task && !fixture.host.snapshot().delegations[watch.delegation]!.cancel
      ? undefined : server.tasks.deviceTerminal(id) } }) });
  const { b, d } = await delegated('terminal-first');
  const task = t.taskOf(d.id);
  watch = { task, delegation: d.id };
  (await t.running(d.id)).finish({ delegate: [{ to: b, request: 'Continue alone' }] });
  await vi.waitFor(async () => expect(await fixture.server.tasks.deviceTerminal(task)).toBeDefined(), { timeout: 5000 });
  expect(t.host().snapshot().replies[task]?.body).toBeDefined();
  expect(t.host().core.intent(d.id)!.conclusion).toBeUndefined();
  await t.host().cancelDelegation(d.id);
  expect(await verdict(d.id)).toMatchObject({ verdict: 'cancelled', reason: 'user_cancelled', reply: task, partial: true, chainTurnIds: [d.id] });
  const state = t.host().snapshot();
  expect(t.host().core.intent(d.id)!.conclusion).toBe('succeeded');
  expect(state.audit).toContain(`Outcome audit only: ${task}`);
  expect(state.turns[hash([task, 'delegate', 0])]).toBeUndefined();
  expect(state.turns[d.id]!.outcome).toBeUndefined();
  await t.finish(hash(['bot_reply', d.id]));
});
