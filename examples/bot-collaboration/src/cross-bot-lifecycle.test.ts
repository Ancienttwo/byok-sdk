import { afterEach, expect, it, vi } from 'vitest';
import { hash } from '@byok-sdk/server/execution-core';
import { openTeam, type TestTeam } from './team.test-support';
import { crossBot } from './cross-bot.test-support';
import { DEFAULT_CANCEL_GRACE_MS } from './delegation';

let fixture: TestTeam;
afterEach(async () => { await fixture?.close(); vi.restoreAllMocks(); });
const t = crossBot(() => fixture);

const replyTurns = () => Object.values(t.host().snapshot().turns).filter(turn => turn.source === 'bot_reply');
const toEnum = (id: string) => t.host().snapshot().schemas[id]!.properties!.delegate!.items!.properties!.to!.enum;
async function verdict(id: string) {
  await vi.waitFor(async () => { await t.host().drain(); expect(t.delegation(id).verdict).toBeDefined(); }, { timeout: 10_000 });
  return t.delegation(id);
}
/** The Main Bot archives `botId` with delete_bot. */
async function archive(key: string, botId: string) {
  const id = await t.host().input(key, 'Archive a Bot');
  await t.finish(id, { delete_bot: [{ botId }] });
}
/**
 * One `refused` verdict, one resolved event, and exactly one A report that
 * carries it. Then A's report runs once.
 */
async function refusedOnce(d: string, a: string) {
  const reply = hash(['bot_reply', d]);
  expect(t.delegation(d)).toMatchObject({ status: 'resolved', verdict: 'refused', reason: 'target_archived', replyTurnId: reply });
  expect(t.delegation(d).reply).toBeUndefined();
  expect(t.events(d).filter(e => e.status === 'resolved')).toHaveLength(1);
  expect(replyTurns()).toEqual([expect.objectContaining({ id: reply, botId: a,
    replies: [{ delegationId: d, from: expect.any(String), request: expect.any(String), verdict: 'refused', reason: 'target_archived' }] })]);
  await t.finish(reply);
  expect(replyTurns()).toHaveLength(1);
}

it('§8.4 queued, no K4 intent (target waits for persona readback) -> refused, B never runs, A receives one report', async () => {
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
  await archive('archive-pending', b);
  // No intent: the arbitration closes queue eligibility and needs no core.cancel.
  expect(cancel).not.toHaveBeenCalled();
  expect(t.delegation(d.id).cancel).toMatchObject({ reason: 'target_archived', targetTurnId: d.id, delivered: true });
  expect(t.host().snapshot().turns[d.id]).toMatchObject({ status: 'failed', conclusion: 'cancelled' });
  release(); hold = undefined;
  await refusedOnce(d.id, a);
  expect(t.host().core.intent(d.id)).toBeUndefined();
  expect(t.host().snapshot().budgets[root]).toMatchObject({ reserved: 0 });
});

it('§8.4 queued K4 intent behind B\'s own Turn -> cancelReason cancelled, refused, B\'s own Turn continues', async () => {
  fixture = await openTeam({ routeMessages: true });
  const [a, b] = await t.createBots(2) as [string, string];
  const own = await t.host().input('b-own', 'Own work', b);
  const session = await t.running(own);
  const root = await t.host().input('ask-busy', 'Ask Bot 2', a);
  await t.finish(root, { delegate: [{ to: b, request: 'Wait in the FIFO' }] });
  const d = t.delegationOf(t.taskOf(root));
  const intent = t.host().core.intent(d.id)!;
  expect(intent.phase).toBe('queued');
  expect(await fixture.server.tasks.attempt(intent.taskId)).toBeUndefined();
  await archive('archive-busy', b);
  expect(await verdict(d.id)).toMatchObject({ verdict: 'refused', reason: 'target_archived', cancel: { reason: 'target_archived', targetTurnId: d.id } });
  expect(t.host().core.intent(d.id)).toMatchObject({ cancelReason: 'cancelled', conclusion: 'cancelled' });
  expect(await fixture.server.tasks.attempt(intent.taskId)).toBeUndefined();
  // Only delegated work is cancelled. B's own claimed Turn runs to its terminal, and its outcome is audit only.
  expect(session.interrupted).toBe(false);
  session.finish({});
  await vi.waitFor(async () => { await t.host().drain(); expect(t.host().snapshot().turns[own]!.status).toBe('succeeded'); }, { timeout: 5000 });
  expect(t.host().snapshot().audit).toContain(`Outcome audit only: ${t.taskOf(own)}`);
  await refusedOnce(d.id, a);
});

it('§8.4 submitted, not claimed -> tasks.cancel, attempt reads back cancelled, refused; B never starts', async () => {
  let hidden: string | undefined, offlineBefore: string | undefined;
  fixture = await openTeam({ routeMessages: true, wrapServer: server => ({ ...server,
    // The daemon goes offline just before B's submit, so the offer is delivered and never claimed.
    executions: { submit: async input => {
      if (input.payload.agentRef.agentId === offlineBefore) { offlineBefore = undefined; await fixture.offline(); }
      return server.executions.submit(input);
    } },
    tasks: { ...server.tasks, deviceTerminal: async id => id === hidden ? undefined : server.tasks.deviceTerminal(id) } }) });
  const [a, b] = await t.createBots(2) as [string, string];
  // The archive terminal reaches the server first. The Host reads it after B's submit.
  const archiveTurn = await t.host().input('archive-later', 'Archive Bot 2');
  hidden = t.taskOf(archiveTurn);
  (await t.running(archiveTurn)).finish({ delete_bot: [{ botId: b }] });
  await vi.waitFor(async () => expect(await fixture.server.tasks.deviceTerminal(hidden!)).toBeDefined(), { timeout: 5000 });
  const root = await t.host().input('ask-unclaimed', 'Ask Bot 2', a);
  offlineBefore = b;
  await t.finish(root, { delegate: [{ to: b, request: 'Never claimed' }] });
  const d = t.delegationOf(t.taskOf(root));
  const task = t.taskOf(d.id);
  await vi.waitFor(async () => { await t.host().drain(); expect(await fixture.server.tasks.attempt(task)).toBeDefined(); }, { timeout: 5000 });
  expect(await fixture.server.tasks.attempt(task)).not.toHaveProperty('claimedRuntime');
  expect(t.delegation(d.id).status).toBe('queued');
  hidden = undefined;
  expect(await verdict(d.id)).toMatchObject({ verdict: 'refused', reason: 'target_archived', cancel: { reason: 'target_archived', targetTurnId: d.id } });
  const attempt = await fixture.server.tasks.attempt(task);
  expect(attempt).toMatchObject({ status: 'cancelled' });
  expect(attempt?.claimedRuntime).toBeUndefined();
  expect(t.host().core.intent(d.id)).toMatchObject({ conclusion: 'cancelled' });
  await fixture.online();
  await refusedOnce(d.id, a);
  expect(fixture.adapter.starts.filter(start => start.manifest.taskId === task)).toHaveLength(0);
});

it('§8.4 claimed and running -> tasks.cancel interrupts B, refused at the terminal; enums refresh', async () => {
  fixture = await openTeam({ routeMessages: true });
  const [a, b] = await t.createBots(2) as [string, string];
  const root = await t.host().input('ask-running', 'Ask Bot 2', a);
  expect(toEnum(root)).toEqual([a, 'main', b]);
  await t.finish(root, { delegate: [{ to: b, request: 'Long work' }] });
  const d = t.delegationOf(t.taskOf(root));
  const session = await t.running(d.id);
  await archive('archive-running', b);
  expect(t.delegation(d.id).cancel).toMatchObject({ reason: 'target_archived', targetTurnId: d.id });
  await vi.waitFor(async () => { await t.host().drain(); expect(session.interrupted).toBe(true); }, { timeout: 5000 });
  expect(await verdict(d.id)).toMatchObject({ verdict: 'refused', reason: 'target_archived' });
  expect(t.host().core.intent(d.id)!.conclusion).toBe('cancelled');
  expect(t.host().snapshot().turns[d.id]!.outcome).toBeUndefined();
  await refusedOnce(d.id, a);
  // Enum refresh (§2.4): the next schema and roster drop the archived Bot.
  const next = await t.host().input('after-archive', 'Ask again', a);
  expect(toEnum(next)).toEqual([a, 'main']);
  expect(t.context(next).roster.map((bot: { id: string }) => bot.id)).not.toContain(b);
  await t.finish(next);
});

it('§8.4 claimed, reply accepted before the archive -> refused at the terminal, the body is audit only', async () => {
  // The server hides B's terminal until the archive cancel is committed, so K4 reads it after the cancel.
  let watch: { task: string; delegation: string } | undefined;
  fixture = await openTeam({ routeMessages: true, wrapServer: server => ({ ...server, tasks: { ...server.tasks,
    deviceTerminal: async id => id === watch?.task && !fixture.host.snapshot().delegations[watch.delegation]!.cancel
      ? undefined : server.tasks.deviceTerminal(id) } }) });
  const [a, b] = await t.createBots(2) as [string, string];
  const root = await t.host().input('ask-replied', 'Ask Bot 2', a);
  await t.finish(root, { delegate: [{ to: b, request: 'Reply then stop' }] });
  const d = t.delegationOf(t.taskOf(root));
  const session = await t.running(d.id);
  const task = t.taskOf(d.id);
  watch = { task, delegation: d.id };
  session.finish({});
  await vi.waitFor(async () => expect(await fixture.server.tasks.deviceTerminal(task)).toBeDefined(), { timeout: 5000 });
  const body = t.host().snapshot().replies[task]!.body!;
  expect(t.host().core.intent(d.id)!.conclusion).toBeUndefined();
  await archive('archive-replied', b);
  expect(await verdict(d.id)).toMatchObject({ verdict: 'refused', reason: 'target_archived' });
  const state = t.host().snapshot();
  expect(state.audit).toEqual(expect.arrayContaining([`Outcome audit only: ${task}`, `Delegation reply after archive: ${d.id} ${task}`]));
  expect(state.delegations[d.id]).toMatchObject({ cancel: { reason: 'target_archived', targetTurnId: d.id } });
  expect(state.delegations[d.id]!.partial).toBeUndefined();
  const reply = hash(['bot_reply', d.id]);
  await t.running(reply);
  expect(t.instruction(reply)).not.toContain(`(${Buffer.byteLength(body)} bytes) ---\n`);
  expect(t.instruction(reply)).toContain('--- reply 1 (0 bytes) ---');
  await refusedOnce(d.id, a);
});

/** B is claimed. The archive terminal reaches the Host only after B's device is offline, so the cancel finds no terminal. */
async function archivedOffline(key: string) {
  let hidden: string | undefined;
  let clock = Date.now();
  fixture = await openTeam({ routeMessages: true, now: () => clock, wrapServer: server => ({ ...server, tasks: { ...server.tasks,
    deviceTerminal: async id => id === hidden ? undefined : server.tasks.deviceTerminal(id) } }) });
  const [a, b] = await t.createBots(2) as [string, string];
  const root = await t.host().input(key, 'Ask Bot 2', a);
  await t.finish(root, { delegate: [{ to: b, request: 'Run while I go away' }] });
  const d = t.delegationOf(t.taskOf(root));
  const session = await t.running(d.id);
  await vi.waitFor(async () => { await t.host().drain(); expect(t.delegation(d.id).claimed?.turnId).toBe(d.id); }, { timeout: 5000 });
  const archiveTurn = await t.host().input(`${key}-archive`, 'Archive Bot 2');
  hidden = t.taskOf(archiveTurn);
  (await t.running(archiveTurn)).finish({ delete_bot: [{ botId: b }] });
  await vi.waitFor(async () => expect(await fixture.server.tasks.deviceTerminal(hidden!)).toBeDefined(), { timeout: 5000 });
  await fixture.offline();
  hidden = undefined;
  await vi.waitFor(async () => { await t.host().drain(); expect(t.delegation(d.id).cancel?.delivered).toBe(true); }, { timeout: 5000 });
  expect(t.delegation(d.id)).toMatchObject({ status: 'running', cancel: { reason: 'target_archived' } });
  // The Main Bot cancel enum drops a delegation that the archive already cancelled.
  const check = await t.host().input(`${key}-check`, 'List open work');
  expect(t.host().snapshot().schemas[check]!.properties).not.toHaveProperty('cancel_delegation');
  clock += DEFAULT_CANCEL_GRACE_MS; await t.host().drain();
  expect(t.delegation(d.id)).toMatchObject({ status: 'uncertain', uncertainSince: clock });
  expect(t.delegation(d.id).verdict).toBeUndefined();
  return { a, d: d.id, session, check };
}

it('§8.4 no terminal -> uncertain; the later terminal gives one refused verdict and one report', async () => {
  const { a, d, session, check } = await archivedOffline('no-terminal-late');
  await fixture.online();
  await vi.waitFor(async () => { await t.host().drain(); expect(session.interrupted).toBe(true); }, { timeout: 10_000 });
  expect(await verdict(d)).toMatchObject({ verdict: 'refused', reason: 'target_archived' });
  expect(t.events(d).map(e => e.status)).toEqual(['queued', 'running', 'uncertain', 'resolved']);
  await t.finish(check);
  await refusedOnce(d, a);
});

it('§8.4 no terminal -> uncertain; End -> abandoned, A receives one report, the later terminal is audit only', async () => {
  const { a, d, check } = await archivedOffline('no-terminal-end');
  await t.host().abandonDelegation(d);
  expect(t.delegation(d)).toMatchObject({ verdict: 'abandoned', lateTurnId: d, replyTurnId: hash(['bot_reply', d]) });
  await fixture.online();
  await vi.waitFor(async () => { await t.host().drain(); expect(t.delegation(d).lateTurnId).toBeUndefined(); }, { timeout: 10_000 });
  const task = t.taskOf(d);
  expect(t.host().snapshot().audit).toContain(`Delegation terminal after verdict: ${d} ${task}`);
  expect(t.events(d).filter(e => e.status === 'resolved')).toHaveLength(1);
  expect(replyTurns()).toEqual([expect.objectContaining({ botId: a, replies: [expect.objectContaining({ delegationId: d, verdict: 'abandoned' })] })]);
  await t.finish(check);
  await t.finish(hash(['bot_reply', d]));
});

it('archive in reply_held (outside the user-cancellable states) -> refused at once, A receives one report', async () => {
  // Injected SDK readback state, as in the reliability tests: a real held message cannot pair with a success terminal.
  fixture = await openTeam({ wrapServer: server => ({ ...server, tasks: { ...server.tasks,
    agentMessage: async (...args) => {
      const real = await server.tasks.agentMessage(...args);
      return real && { ...real, disposition: { ...real.disposition!, outcome: 'held' } };
    } } }) });
  const [a, b] = await t.createBots(2) as [string, string];
  const root = await t.host().input('ask-held', 'Ask Bot 2', a);
  await t.finish(root, { delegate: [{ to: b, request: 'Reply' }] });
  const d = t.delegationOf(t.taskOf(root));
  await t.finish(d.id);
  await vi.waitFor(() => expect(t.delegation(d.id).status).toBe('reply_held'), { timeout: 5000 });
  await expect(t.host().cancelDelegation(d.id)).rejects.toThrow('use abandonDelegation');
  await archive('archive-held', b);
  expect(t.delegation(d.id)).toMatchObject({ cancel: { reason: 'target_archived', targetTurnId: d.id, delivered: true } });
  await refusedOnce(d.id, a);
});

it('§8.5 initiator archived -> B continues, the verdict is written, no reply Turn, the projection shows initiator_archived', async () => {
  fixture = await openTeam({ routeMessages: true });
  const [a, b] = await t.createBots(2) as [string, string];
  const root = await t.host().input('ask-then-leave', 'Ask Bot 2', a);
  await t.finish(root, { delegate: [{ to: b, request: 'Finish without me' }] });
  const d = t.delegationOf(t.taskOf(root));
  const session = await t.running(d.id);
  await archive('archive-a', a);
  expect(session.interrupted).toBe(false);
  expect(t.delegation(d.id).cancel).toBeUndefined();
  await t.finish(d.id);
  const task = t.taskOf(d.id);
  expect(await verdict(d.id)).toMatchObject({ status: 'resolved', verdict: 'answered', reply: task, undelivered: 'initiator_archived' });
  expect(t.delegation(d.id).replyTurnId).toBeUndefined();
  expect(t.host().snapshot().turns[hash(['bot_reply', d.id])]).toBeUndefined();
  expect(replyTurns()).toEqual([]);
  expect(t.events(d.id).at(-1)).toMatchObject({ status: 'resolved', verdict: 'answered', undelivered: 'initiator_archived' });
  // The prepaid A slot is released; the B unit is spent.
  expect(t.host().snapshot().units[hash([t.taskOf(root), 'A', 0])]!.state).toBe('released');
  expect(t.host().snapshot().budgets[root]).toMatchObject({ reserved: 0 });
});
