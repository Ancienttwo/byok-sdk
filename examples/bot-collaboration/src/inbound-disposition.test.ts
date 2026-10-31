import { afterEach, expect, it, vi } from 'vitest';
import { openTeam, type TestTeam } from './team.test-support';
import { inboundKey, type InboundMessage, type Principal } from './channel';

let fixture: TestTeam;
afterEach(async () => { await fixture?.close(); });
const host = () => fixture.host;
const owner: Principal = { id: 'owner', kind: 'human' };
const member: Principal = { id: 'im:member', kind: 'human' };
const direct = (platformMessageId: string, sender: Principal | undefined, text = 'Hello'): InboundMessage =>
  ({ channel: 'fake', platformMessageId, conversation: { kind: 'direct', id: 'main' }, sender, text, mentions: [] });
async function running(id: string) {
  let drained = false;
  await vi.waitFor(async () => {
    if (!drained) { await host().drain(); drained = true; }
    expect(fixture.adapter.sessions.has(host().core.intent(id)!.taskId)).toBe(true);
  }, { timeout: 5000 });
  return fixture.adapter.sessions.get(host().core.intent(id)!.taskId)!;
}
async function finish(id: string, document: unknown = {}) {
  (await running(id)).finish(document);
  await vi.waitFor(async () => { await host().drain(); expect(host().snapshot().turns[id]?.status).toBe('succeeded'); }, { timeout: 5000 });
}
const disposition = (id: string) => host().inboundDispositions().find(row => row.id === id);

it('gives every refused human message a filtered destination and keeps its audit row', async () => {
  fixture = await openTeam();
  const unverified = direct('m1', undefined), notOwner = direct('m2', member);
  expect(await host().receive(unverified)).toEqual({ kind: 'unverified_sender' });
  expect(await host().receive(notOwner)).toEqual({ kind: 'not_owner' });
  expect(host().inboundDispositions()).toEqual([
    { id: inboundKey(unverified), disposition: 'filtered', code: 'unverified_sender' },
    { id: inboundKey(notOwner), disposition: 'filtered', code: 'not_owner' },
  ]);
  expect(host().snapshot().audit).toEqual([
    'Inbound unverified_sender: fake direct:main m1',
    'Inbound not_owner: fake direct:main m2 human:im:member',
  ]);
  // The Host UI can also read the projection rows; each has a stable id and one value.
  await host().drain();
  const projections = Object.values(fixture.ledger.snapshot().outbox)
    .flatMap(row => row.kind === 'projection' && row.id.startsWith('inbound:') ? [row.id] : []);
  expect(projections).toEqual(expect.arrayContaining([
    `inbound:${inboundKey(unverified)}:filtered:unverified_sender`,
    `inbound:${inboundKey(notOwner)}:filtered:not_owner`,
  ]));
});

it('reports a merged input as coalesced, then answered, and keeps the ledger order across a restart', async () => {
  fixture = await openTeam({ bot: { coalesce: {} } });
  const busy = await host().input('busy', 'Long work');
  await running(busy);
  const first = direct('m1', owner, 'One'), second = direct('m2', owner, 'Two');
  const batch = (await host().receive(first)).id!;
  expect((await host().receive(second)).id).toBe(batch);
  // Both messages name the open batch, which is the Turn that will answer them.
  expect(disposition(inboundKey(first))).toEqual({ id: inboundKey(first), disposition: 'coalesced', turnId: batch });
  expect(disposition(inboundKey(second))).toEqual({ id: inboundKey(second), disposition: 'coalesced', turnId: batch });
  await finish(busy);
  await host().drain();
  await finish(batch);
  const answered = [
    { id: inboundKey(first), disposition: 'answered', turnId: batch },
    { id: inboundKey(second), disposition: 'answered', turnId: batch },
  ];
  expect(host().inboundDispositions()).toEqual(answered);
  await fixture.reopen();
  // A restart reads the same ledger rows, so the destinations and their order do not change.
  expect(host().inboundDispositions()).toEqual(answered);
});

it('reports a cancelled destination when the owner cancels the open batch', async () => {
  fixture = await openTeam({ bot: { coalesce: {} } });
  const busy = await host().input('busy', 'Long work');
  await running(busy);
  const message = direct('m1', owner, 'One');
  const batch = (await host().receive(message)).id!;
  await host().cancelTurn(batch);
  expect(disposition(inboundKey(message))).toEqual({ id: inboundKey(message), disposition: 'cancelled', turnId: batch });
});

it('reports a room input through its round root and the seat Turn that answers it', async () => {
  fixture = await openTeam();
  const created = await host().input('create-team', 'Create three Bots and one room');
  await finish(created, { create_bot: [1, 2, 3].map(i => ({ localId: `new_bot_${i}`, name: `Bot ${i}`, role: 'Reviewer', persona: `Persona ${i}`, model: 'default' })),
    create_room: [{ localId: 'new_room_1', name: 'Review room', members: ['new_bot_1', 'new_bot_2', 'new_bot_3'] }] });
  const profiles = Object.values(host().snapshot().team.bots).filter(bot => bot.id !== 'main');
  await vi.waitFor(async () => {
    await host().drain();
    for (const profile of profiles) expect(host().snapshot().team.bots[profile.id]?.readyRevision).toBe(host().snapshot().team.bots[profile.id]?.revision);
  }, { timeout: 5000 });
  const room = Object.values(host().snapshot().team.rooms)[0]!;
  const message: InboundMessage = { channel: 'fake', platformMessageId: 'r1', conversation: { kind: 'group', id: room.id },
    sender: member, text: 'Review this', mentions: [profiles[0]!.id] };
  const round = (await host().receive(message)).id!;
  // The round root is the inbound root; its seat Turn is still open.
  expect(disposition(inboundKey(message))).toEqual({ id: inboundKey(message), disposition: 'coalesced', turnId: round });
  const seat = host().snapshot().team.rounds[round]!.seats[0]!;
  await finish(seat, { speech: { kind: 'pass' } });
  expect(disposition(inboundKey(message))).toEqual({ id: inboundKey(message), disposition: 'answered', turnId: round });
});

it('reports a failed destination when the Turn fails', async () => {
  fixture = await openTeam();
  const message = direct('m1', owner, 'Do it');
  const turn = (await host().receive(message)).id!;
  const session = await running(turn);
  // The frozen schema refuses this document, so K4 settles the intent failed and the Turn follows.
  session.finish({ ask_user: { question: 'Missing answerKind' } });
  await vi.waitFor(async () => { await host().drain(); expect(host().snapshot().turns[turn]?.status).toBe('failed'); }, { timeout: 5000 });
  expect(disposition(inboundKey(message))).toEqual({ id: inboundKey(message), disposition: 'failed', turnId: turn });
});
