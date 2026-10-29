import { afterEach, expect, it, vi } from 'vitest';
import { hash } from '@byok-sdk/server/execution-core';
import { openTeam, type TestTeam } from './team.test-support';
import { crossBot } from './cross-bot.test-support';

let fixture: TestTeam;
afterEach(async () => { await fixture?.close(); });
const idOf = (key: string, botId = 'main') => hash(['user', botId, key]);

it('seals the open batch of a Bot before its bot_request, bot_reply and room_slot Turns (S5)', async () => {
  fixture = await openTeam({ routeMessages: true });
  const t = crossBot(() => fixture), host = () => fixture.host, seq = (id: string) => host().core.intent(id)!.sequence;
  const created = await host().input('create', 'Create a Bot and a room');
  await t.finish(created, { create_bot: [{ localId: 'new_bot_1', name: 'Bot 1', role: 'Reviewer', persona: 'Persona 1', model: 'default' }],
    create_room: [{ localId: 'new_room_1', name: 'Room', members: ['new_bot_1'] }] });
  const other = Object.keys(host().snapshot().team.bots).find(id => id !== 'main')!, room = Object.values(host().snapshot().team.rooms)[0]!;
  await vi.waitFor(async () => { await host().drain(); expect(host().snapshot().team.bots[other]!.readyRevision).toBe('1'); }, { timeout: 5000 });
  // The Host restarts with input coalescing on.
  fixture.botOptions.coalesce = {};
  await fixture.reopen();

  const otherBusy = await host().input('other-busy', 'Long work', other);
  await t.running(otherBusy);
  const queued = await host().input('other-queued', 'Queued for Bot 1', other);
  const ask = await host().input('ask', 'Ask Bot 1');
  await t.finish(ask, { delegate: [{ to: other, request: 'Check this' }] });
  const delegation = t.delegationOf(t.taskOf(ask));
  expect(host().snapshot().inputBatches![queued]).toMatchObject({ state: 'sealed', sealReason: 'boundary', inputIds: [queued] });
  expect(seq(queued)).toBeLessThan(seq(delegation.id));

  const mainBusy = await host().input('main-busy', 'Long work');
  await t.running(mainBusy);
  const mainQueued = await host().input('main-queued', 'Queued for Main');
  for (const id of [otherBusy, queued, delegation.id]) await t.finish(id);
  const reply = hash(['bot_reply', delegation.id]);
  await vi.waitFor(async () => { await host().drain(); expect(host().core.intent(reply)).toBeDefined(); }, { timeout: 5000 });
  expect(host().snapshot().inputBatches![mainQueued]).toMatchObject({ state: 'sealed', sealReason: 'boundary', inputIds: [mainQueued] });
  expect(seq(mainQueued)).toBeLessThan(seq(reply));

  const otherBusyAgain = await host().input('other-busy-2', 'More work', other);
  await t.running(otherBusyAgain);
  const roomQueued = await host().input('other-queued-2', 'Queued again', other);
  const round = await host().roomInput('room', room.id, 'Review this', [other]);
  const seat = host().snapshot().team.rounds[round]!.seats[0]!;
  expect(host().snapshot().inputBatches![roomQueued]).toMatchObject({ state: 'sealed', sealReason: 'boundary', inputIds: [roomQueued] });
  expect(seq(roomQueued)).toBeLessThan(seq(seat));
  expect([queued, mainQueued, roomQueued]).toEqual([idOf('other-queued', other), idOf('main-queued'), idOf('other-queued-2', other)]);
});
