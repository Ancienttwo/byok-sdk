import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { hash } from '@byok-sdk/server/execution-core';
import { openTeam, type TestTeam } from './team.test-support';
import { crossBot } from './cross-bot.test-support';
import { waitForTaskCleanup } from '../../basic/goal-btw.test-support';

let fixture: TestTeam;
afterEach(async () => { await fixture?.close(); });
const t = crossBot(() => fixture);
async function finishLocal(id: string, document: unknown = {}) {
  const session = await t.running(id);
  await t.finish(id, document);
  await waitForTaskCleanup(fixture.daemon, session);
}

async function createRemoteBot() {
  const root = await t.host().input('create-remote', 'Create a Bot on the second device');
  await finishLocal(root, { create_bot: [{ localId: 'new_bot_1', name: 'Remote reviewer', role: 'Reviewer', persona: 'Check the totals.', model: 'remote' }] });
  const botId = Object.keys(t.host().snapshot().team.bots).find(id => id !== 'main')!;
  await vi.waitFor(async () => {
    await t.host().drain();
    expect(t.host().snapshot().team.bots[botId]!.readyRevision).toBe('1');
  }, { timeout: 5000 });
  return botId;
}

async function remoteRunning(id: string) {
  const device = fixture.secondDevice!;
  await vi.waitFor(async () => {
    await t.host().drain();
    expect(device.adapter.sessions.has(t.taskOf(id))).toBe(true);
    expect(t.host().snapshot().delegations[t.host().snapshot().turns[id]!.delegationId!]!.status).toBe('running');
  }, { timeout: 5000 });
  return device.adapter.sessions.get(t.taskOf(id))!;
}

async function remoteFinish(id: string) {
  const session = await remoteRunning(id);
  session.finish({});
  await vi.waitFor(async () => {
    await t.host().drain();
    expect(t.host().snapshot().turns[id]!.status).toBe('succeeded');
  }, { timeout: 5000 });
  await waitForTaskCleanup(fixture.secondDevice!.daemon, session);
}

async function stopRemote() {
  await fixture.secondDevice!.offline();
  await vi.waitFor(async () => {
    expect((await fixture.server.machines.list()).find(d => d.deviceId === fixture.secondDevice!.deviceId)?.connected).toBe(false);
  }, { timeout: 5000 });
}

it('routes A -> B -> A through two enrolled daemons with separate homes and no Host on device B', async () => {
  fixture = await openTeam({ routeMessages: true, secondDevice: true });
  const remote = fixture.secondDevice!, b = await createRemoteBot();
  expect(remote.deviceId).not.toBe(fixture.deviceId);
  expect((await fixture.server.machines.list()).map(d => d.deviceId).sort()).toEqual([fixture.deviceId, remote.deviceId].sort());
  expect(await readFile(join(remote.root, 'homes', 'agents', b, 'AGENTS.md'), 'utf8')).toBe('Check the totals.');
  await expect(access(join(fixture.root, 'homes', 'agents', b))).rejects.toThrow();
  await expect(access(join(remote.root, 'host.sqlite'))).rejects.toThrow();

  const root = await t.host().input('ask-remote', 'Ask the remote reviewer');
  await finishLocal(root, { delegate: [{ to: b, request: 'Check the totals' }] });
  const d = t.delegationOf(t.taskOf(root));
  await remoteRunning(d.id);
  const task = t.taskOf(d.id), intent = t.host().core.intent(d.id)!;
  expect(intent.execution.deviceId).toBe(remote.deviceId);
  expect(t.delegation(d.id)).toMatchObject({ status: 'running', toDeviceId: remote.deviceId, toAgentRef: { agentId: b, profileRevision: '1' } });
  expect(await fixture.server.tasks.attempt(task)).toMatchObject({ deviceId: remote.deviceId, ownerDeviceId: remote.deviceId });
  expect(fixture.adapter.sessions.has(task)).toBe(false);
  await remoteFinish(d.id);
  expect(fixture.received.find(message => message.taskId === task)).toMatchObject({ deviceId: remote.deviceId, payload: { agentRef: { agentId: b, profileRevision: '1' } } });
  expect(t.delegation(d.id)).toMatchObject({ verdict: 'answered', reply: task, replyTurnId: hash(['bot_reply', d.id]) });
  const report = t.delegation(d.id).replyTurnId!;
  await finishLocal(report);
  expect(t.host().core.intent(report)!.execution.deviceId).toBe(fixture.deviceId);
  expect(remote.adapter.sessions.has(t.taskOf(report))).toBe(false);
  expect(t.events(d.id).map(event => event.status)).toEqual(['queued', 'running', 'resolved']);
  await fixture.reopen(); await t.host().recover();
  expect(Object.values(t.host().snapshot().turns).filter(turn => turn.source === 'bot_reply')).toHaveLength(1);
  expect(remote.adapter.starts.filter(start => start.manifest.taskId === task)).toHaveLength(1);
});

it('shows waiting_device, expires an unclaimed offline offer, and reports once across recovery and reconnect', async () => {
  let now: number | undefined;
  fixture = await openTeam({ routeMessages: true, secondDevice: true, now: () => now ?? Date.now() });
  const b = await createRemoteBot(), remote = fixture.secondDevice!;
  await stopRemote();
  const root = await t.host().input('offline-remote', 'Ask the offline reviewer');
  await finishLocal(root, { delegate: [{ to: b, request: 'Check when online' }] });
  const d = t.delegationOf(t.taskOf(root)), task = t.taskOf(d.id);
  expect(t.delegation(d.id)).toMatchObject({ status: 'waiting_device', toDeviceId: remote.deviceId });
  expect(await fixture.server.tasks.attempt(task)).toMatchObject({ status: 'offered', deviceId: remote.deviceId });
  expect(remote.adapter.sessions.has(task)).toBe(false);
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 0, reserved: 2 });
  const deadline = t.host().core.intent(d.id)!.waitUntil;
  await fixture.reopen();
  expect(t.host().core.intent(d.id)!.waitUntil).toBe(deadline);
  now = deadline - 1; await t.host().drain();
  expect(t.delegation(d.id).verdict).toBeUndefined();
  now = deadline; await t.host().drain();
  const report = hash(['bot_reply', d.id]);
  expect(t.delegation(d.id)).toMatchObject({ status: 'resolved', verdict: 'expired', replyTurnId: report });
  expect(t.delegation(d.id).reply).toBeUndefined();
  expect(await fixture.server.tasks.attempt(task)).toMatchObject({ status: 'cancelled', cancellation: { reason: 'expired' } });
  expect(t.host().snapshot().turns[report]!.replies).toEqual([expect.objectContaining({ delegationId: d.id, verdict: 'expired' })]);
  await finishLocal(report);
  await fixture.reopen(); await remote.online(); await t.host().recover();
  expect(remote.adapter.sessions.has(task)).toBe(false);
  expect(t.host().core.intent(d.id)!.generation).toBe(0);
  expect(Object.values(t.host().snapshot().turns).filter(turn => turn.source === 'bot_reply')).toHaveLength(1);
  expect(t.events(d.id).map(event => event.status)).toEqual(['queued', 'waiting_device', 'resolved']);
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 1, reserved: 0 });
});

it('starts the same frozen offer when the second device returns before its deadline', async () => {
  fixture = await openTeam({ routeMessages: true, secondDevice: true });
  const b = await createRemoteBot(), remote = fixture.secondDevice!;
  await stopRemote();
  const root = await t.host().input('reconnect-remote', 'Ask the reviewer');
  await finishLocal(root, { delegate: [{ to: b, request: 'Resume on reconnect' }] });
  const d = t.delegationOf(t.taskOf(root)), task = t.taskOf(d.id);
  expect(t.delegation(d.id).status).toBe('waiting_device');
  const frozen = structuredClone(fixture.ledger.snapshot().executions[task]!.input);
  await remote.online(); await remoteFinish(d.id);
  expect(t.delegation(d.id).verdict).toBe('answered');
  expect(fixture.ledger.snapshot().executions[task]!.input).toEqual(frozen);
  expect(t.host().core.intent(d.id)!.generation).toBe(0);
  expect(remote.adapter.starts.filter(start => start.manifest.taskId === task)).toHaveLength(1);
  await finishLocal(t.delegation(d.id).replyTurnId!);
});

it('cancels a waiting_device delegation without a claim and delivers one cancelled report', async () => {
  fixture = await openTeam({ routeMessages: true, secondDevice: true });
  const b = await createRemoteBot();
  await stopRemote();
  const root = await t.host().input('cancel-offline', 'Ask the reviewer');
  await finishLocal(root, { delegate: [{ to: b, request: 'Cancel before reconnect' }] });
  const d = t.delegationOf(t.taskOf(root));
  expect(t.delegation(d.id).status).toBe('waiting_device');
  await t.host().cancelDelegation(d.id);
  expect(t.delegation(d.id)).toMatchObject({ verdict: 'cancelled', cancel: { delivered: true }, replyTurnId: hash(['bot_reply', d.id]) });
  await fixture.secondDevice!.online();
  await finishLocal(t.delegation(d.id).replyTurnId!);
  expect(fixture.secondDevice!.adapter.sessions.has(t.taskOf(d.id))).toBe(false);
  expect(Object.values(t.host().snapshot().turns).filter(turn => turn.source === 'bot_reply')).toHaveLength(1);
});
