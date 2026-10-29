import { afterEach, expect, it } from 'vitest';
import { hash } from '@byok-sdk/server/execution-core';
import { openTeam, type TestTeam } from './team.test-support';
import { crossBot } from './cross-bot.test-support';
import { stateOf } from './model';
import { outcomeSchema } from './schema';

let fixture: TestTeam;
afterEach(async () => { await fixture?.close(); });
const t = crossBot(() => fixture);
const MANAGEMENT = ['create_bot', 'update_bot', 'delete_bot', 'create_room', 'update_room', 'team_note'];

it('A -> B -> A ping-pong: hop 4, then a self continuation keeps hop 4, then an external delegate is refused at hop 5', async () => {
  fixture = await openTeam({ routeMessages: true });
  const [b] = await t.createBots(1) as [string];
  const root = await t.host().input('ping-pong', 'Start the chain');
  const send = async (id: string, to: string, request: string) => { await t.finish(id, { delegate: [{ to, request }] }); return t.delegationOf(t.taskOf(id)); };
  const d1 = await send(root, b, 'r1');
  const d2 = await send(d1.id, 'main', 'r2');
  const d3 = await send(d2.id, b, 'r3');
  await t.finish(hash(['bot_reply', d1.id]));
  const d4 = await send(d3.id, 'main', 'r4');
  expect([d1, d2, d3, d4].map(d => t.host().snapshot().turns[d.id]!.hop)).toEqual([1, 2, 3, 4]);
  expect(t.host().snapshot().turns[d2.id]).toMatchObject({ botId: 'main', authority: 'bot', source: 'bot_request' });
  expect(t.host().snapshot().turns[hash(['bot_reply', d2.id])]).toMatchObject({ botId: b, hop: 1, authority: 'bot' });
  // Main's FIFO order is d4, the d3 reply, then the continuation.
  await t.finish(d4.id, { delegate: [{ to: 'main', request: 'continue at hop 4' }] });
  await t.finish(hash(['bot_reply', d3.id]));
  const continuation = hash([t.taskOf(d4.id), 'delegate', 0]);
  expect(t.host().snapshot().turns[continuation]).toMatchObject({ source: 'continuation', hop: 4, authority: 'bot', delegationId: d4.id });
  expect(t.delegation(d4.id).chainTurnIds).toEqual([d4.id, continuation]);
  expect(t.delegation(d4.id).verdict).toBeUndefined();
  await t.finish(continuation, { delegate: [{ to: b, request: 'too deep' }] });
  const d5 = t.delegationOf(t.taskOf(continuation));
  expect(d5).toMatchObject({ hop: 5, verdict: 'refused', reason: 'hop_limit' });
  expect(t.host().snapshot().turns[d5.id]).toBeUndefined();
  const report = t.host().snapshot().turns[hash(['bot_reply', t.taskOf(continuation)])]!;
  expect(report).toMatchObject({ botId: 'main', refusalReport: true, hop: 4, authority: 'bot', replies: [expect.objectContaining({ reason: 'hop_limit' })] });
  expect(t.delegation(d4.id)).toMatchObject({ verdict: 'answered', reply: t.taskOf(continuation) });
  const budget = t.host().snapshot().budgets[root]!;
  expect(budget.delegation + budget.reserved!).toBe(9);
});

it('normal A -> Main Bot B -> B continues itself: no management fragments, and apply refuses management from an older offer', async () => {
  fixture = await openTeam({ routeMessages: true });
  const [a] = await t.createBots(1) as [string];
  const busy = await t.host().input('main-busy', 'Keep the Main Bot busy');
  await t.running(busy);
  const ask = await t.host().input('ask-main', 'Ask the Main Bot', a);
  await t.finish(ask, { delegate: [{ to: 'main', request: 'Create a Bot and write a note' }] });
  const d = t.delegationOf(t.taskOf(ask));
  const request = t.host().snapshot().turns[d.id]!;
  expect(request).toMatchObject({ botId: 'main', authority: 'bot' });
  for (const kind of MANAGEMENT) expect(t.host().snapshot().schemas[d.id]!.properties).not.toHaveProperty(kind);
  // Simulate an offer frozen before the authority gate: the queued input still carries management.
  const older = outcomeSchema('main', t.host().snapshot(), { ...request, authority: 'owner' });
  expect(older.properties).toHaveProperty('team_note');
  fixture.ledger.transaction(s => {
    const intent = s.intents[hash(d.id)]!;
    expect(intent.phase).toBe('queued');
    stateOf(s.application).schemas[d.id] = older;
    for (const execution of [intent.execution, s.executions[intent.taskId]!.input]) {
      execution.payload.terminalProjection = { ...execution.payload.terminalProjection!, schema: older } as typeof execution.payload.terminalProjection;
    }
  });
  await t.finish(busy);
  await t.finish(d.id, { team_note: { text: 'From another Bot' }, delegate: [{ to: 'main', request: 'continue' }] });
  expect(t.host().snapshot().team.notes).toEqual([]);
  expect(t.host().snapshot().rejected).toContainEqual(expect.objectContaining({ botId: 'main', action: 'team_note', reason: 'Management needs owner authority' }));
  const continuation = hash([t.taskOf(d.id), 'delegate', 0]);
  expect(t.host().snapshot().turns[continuation]).toMatchObject({ authority: 'bot', hop: 1, delegationId: d.id });
  await t.running(continuation);
  for (const kind of MANAGEMENT) expect(t.host().snapshot().schemas[continuation]!.properties).not.toHaveProperty(kind);
  // The Main Bot keeps management on its owner-rooted Turns.
  const own = await t.host().input('main-owner', 'Owner request');
  await t.finish(continuation);
  await t.finish(hash(['bot_reply', d.id]));
  expect(t.host().snapshot().schemas[own]!.properties).toHaveProperty('team_note');
});

it('the last allowed continuation proposes another: refused, and the verdict comes from that Turn\'s accepted reply', async () => {
  fixture = await openTeam({ routeMessages: true });
  const [a, b] = await t.createBots(2) as [string, string];
  const root = await t.host().input('long-task', 'Delegate a long task', a);
  await t.finish(root, { delegate: [{ to: b, request: 'Long task' }] });
  const d = t.delegationOf(t.taskOf(root));
  let current = d.id;
  for (let step = 1; step <= 4; step++) {
    await t.finish(current, { delegate: [{ to: b, request: `step ${step}` }] });
    current = hash([t.taskOf(current), 'delegate', 0]);
    expect(t.delegation(d.id).verdict).toBeUndefined();
  }
  await t.finish(current, { delegate: [{ to: b, request: 'step 5' }] });
  expect(t.host().snapshot().budgets[root]!.continuation).toBe(4);
  expect(t.host().snapshot().rejected).toContainEqual(expect.objectContaining({ botId: b, action: 'delegate', reason: 'Continuation budget is 4' }));
  expect(t.delegation(d.id)).toMatchObject({ verdict: 'answered', reply: t.taskOf(current), continuationRefused: true });
  expect(t.delegation(d.id).chainTurnIds).toHaveLength(5);
  const reply = t.host().snapshot().turns[hash(['bot_reply', d.id])]!;
  expect(reply.replies).toEqual([expect.objectContaining({ verdict: 'answered', continuationRefused: true, reply: t.taskOf(current) })]);
  await t.running(reply.id);
  expect(t.instruction(reply.id)).toContain('"continuationRefused":true');
});
