import { afterEach, expect, it } from 'vitest';
import { hash } from '@byok-sdk/example-host-execution-core';
import { openTeam, type TestTeam } from './team.test-support';
import { crossBot } from './cross-bot.test-support';
import { BOT_REPLY_MAX_BYTES } from './delegation';

let fixture: TestTeam;
afterEach(async () => { await fixture?.close(); });
const t = crossBot(() => fixture);

it('A delegates to B on the same device: queued -> running -> answered, one reply Turn, three events', async () => {
  fixture = await openTeam({ routeMessages: true });
  const [a, b] = await t.createBots(2) as [string, string];
  const root = await t.host().input('ask-b', 'Ask Bot 2 to check the numbers', a);
  const offer = t.host().snapshot().schemas[root]!;
  // Security: a normal Bot schema lists Bot ids only, and offers no management.
  expect(offer.properties!.delegate!.items!.properties!.to!.enum).toEqual([a, 'main', b]);
  for (const kind of ['create_bot', 'update_bot', 'delete_bot', 'create_room', 'update_room', 'team_note']) expect(offer.properties).not.toHaveProperty(kind);
  await t.finish(root, { delegate: [{ to: b, request: 'Check the numbers "Q3"\n' }] });
  const rootTask = t.taskOf(root);
  const d = t.delegationOf(rootTask);
  expect(d).toMatchObject({ fromBotId: a, toBotId: b, hop: 1, status: 'queued', root, batch: rootTask, chainTurnIds: [d.id] });
  expect(t.host().snapshot().turns[d.id]).toMatchObject({ botId: b, source: 'bot_request', authority: 'bot', hop: 1, root, delegationId: d.id });
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 0, reserved: 2 });

  await t.running(d.id);
  const input = fixture.ledger.snapshot().executions[t.taskOf(d.id)]!.input;
  expect(input.payload.messageEgress?.maxBytes).toBe(BOT_REPLY_MAX_BYTES);
  expect(input.agentMessageContext).toEqual({ destinationBinding: 'owner', freshnessCursor: d.id });
  expect(t.instruction(d.id)).toContain(`--- request (${Buffer.byteLength('Check the numbers "Q3"\n')} bytes) ---`);
  expect(t.context(d.id).delegation).toEqual({ delegationId: d.id, from: { botId: a, name: 'Bot 1' }, hop: 1 });
  // A's history never enters B's ContextPack.
  expect(t.instruction(d.id)).not.toContain('Ask Bot 2 to check the numbers');

  await t.finish(d.id);
  const bTask = t.taskOf(d.id);
  const resolved = t.delegation(d.id);
  const replyId = hash(['bot_reply', d.id]);
  expect(resolved).toMatchObject({ status: 'resolved', verdict: 'answered', reply: bTask, replyTurnId: replyId });
  expect(t.host().snapshot().replies[bTask]).toMatchObject({ turnId: d.id, body: '{}' });
  expect(t.events(d.id).map(e => [e.revision, e.status, e.verdict])).toEqual([[1, 'queued', undefined], [2, 'running', undefined], [3, 'resolved', 'answered']]);
  const reply = t.host().snapshot().turns[replyId]!;
  expect(reply).toMatchObject({ botId: a, source: 'bot_reply', authority: 'owner', hop: 0, root,
    replies: [{ delegationId: d.id, from: b, verdict: 'answered', reply: bTask }] });
  await t.running(replyId);
  expect(t.instruction(replyId)).toContain('--- reply 1 (2 bytes) ---');
  await t.finish(replyId);
  expect(Object.values(t.host().snapshot().turns).filter(turn => turn.source === 'bot_reply')).toHaveLength(1);
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 2, reserved: 0 });
});

it('refuses a second cross-Bot item with fan_out_not_enabled and reports it in the accepted reply Turn', async () => {
  fixture = await openTeam({ routeMessages: true });
  const [a, b] = await t.createBots(2) as [string, string];
  const root = await t.host().input('fan-out', 'Ask two Bots', a);
  await t.finish(root, { delegate: [{ to: b, request: 'first' }, { to: 'main', request: 'second' }] });
  const first = t.delegationOf(t.taskOf(root), 0), second = t.delegationOf(t.taskOf(root), 1);
  expect(second).toMatchObject({ status: 'resolved', verdict: 'refused', reason: 'fan_out_not_enabled' });
  expect(t.host().snapshot().turns[second.id]).toBeUndefined();
  expect(t.host().snapshot().rejected).toContainEqual(expect.objectContaining({ botId: a, action: 'delegate', reason: 'fan_out_not_enabled' }));
  expect(t.host().snapshot().budgets[root]).toMatchObject({ reserved: 2 });
  await t.finish(first.id);
  const replyId = hash(['bot_reply', first.id]);
  expect(t.host().snapshot().turns[replyId]!.replies!.map(r => [r.delegationId, r.verdict, r.reason])).toEqual([
    [first.id, 'answered', undefined], [second.id, 'refused', 'fan_out_not_enabled']]);
  expect(t.delegation(second.id).replyTurnId).toBe(replyId);
  await t.finish(replyId);
});

it('delivers all refused items of one outcome in one refusal report Turn whose schema has no delegate', async () => {
  fixture = await openTeam({ routeMessages: true });
  const [a, b] = await t.createBots(2) as [string, string];
  const root = await t.host().input('stale-offer', 'Ask Bot 2', a);
  await t.running(root);
  expect(t.host().snapshot().schemas[root]!.properties!.delegate!.items!.properties!.to!.enum).toContain(b);
  const archive = await t.host().input('archive', 'Archive Bot 2');
  await t.finish(archive, { delete_bot: [{ botId: b }] });
  await t.finish(root, { delegate: [{ to: b, request: 'one' }, { to: b, request: 'two' }] });
  const task = t.taskOf(root);
  expect([t.delegationOf(task, 0), t.delegationOf(task, 1)].map(d => [d.verdict, d.reason])).toEqual([
    ['refused', 'target_archived'], ['refused', 'duplicate_target']]);
  const reportId = hash(['bot_reply', task]);
  const report = t.host().snapshot().turns[reportId]!;
  expect(report).toMatchObject({ botId: a, source: 'bot_reply', refusalReport: true, hop: 0 });
  expect(report.replies).toHaveLength(2);
  await t.running(reportId);
  expect(t.host().snapshot().schemas[reportId]!.properties).not.toHaveProperty('delegate');
  await t.finish(reportId);
  expect(Object.values(t.host().snapshot().turns).filter(turn => turn.source === 'bot_reply')).toEqual([expect.objectContaining({ id: reportId })]);
  expect(t.host().snapshot().budgets[root]).toMatchObject({ delegation: 1, reserved: 0 });
  // A newer schema drops the archived Bot from the enum.
  const next = await t.host().input('after-archive', 'Ask again', a);
  expect(t.host().snapshot().schemas[next]!.properties!.delegate!.items!.properties!.to!.enum).toEqual([a, 'main']);
  await t.finish(next);
});
