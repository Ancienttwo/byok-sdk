import { afterEach, expect, it, vi } from 'vitest';
import { hash } from '@byok-sdk/server/execution-core';
import { openTeam, type TestTeam } from './team.test-support';
import { crossBot } from './cross-bot.test-support';
import { inboundKey, type InboundMessage, type Principal } from './channel';
import { memberMentions } from './rooms';

let fixture: TestTeam;
afterEach(async () => { await fixture?.close(); });
const t = crossBot(() => fixture);
const owner: Principal = { id: 'owner', kind: 'human' };
const member: Principal = { id: 'im:member', kind: 'human' };
const otherBot: Principal = { id: 'im:other-bot', kind: 'bot' };
const group = (roomId: string, platformMessageId: string, sender: Principal, text: string, mentions: string[] = []): InboundMessage =>
  ({ channel: 'fake', platformMessageId, conversation: { kind: 'group', id: roomId }, sender, text, mentions });
/** Real persona readback for two new Bots and one room with both. */
async function createRoom() {
  const id = await t.host().input('create-room', 'Create two Bots and a room');
  await t.finish(id, { create_bot: [1, 2].map(i => ({ localId: `new_bot_${i}`, name: `Bot ${i}`, role: 'Reviewer', persona: `Persona ${i}`, model: 'default' })),
    create_room: [{ localId: 'new_room_1', name: 'Review room', members: ['new_bot_1', 'new_bot_2'] }] });
  const team = t.host().snapshot().team, bots = Object.keys(team.bots).filter(botId => botId !== 'main') as [string, string];
  await vi.waitFor(async () => {
    await t.host().drain();
    for (const botId of bots) expect(t.host().snapshot().team.bots[botId]!.readyRevision).toBe(t.host().snapshot().team.bots[botId]!.revision);
  }, { timeout: 5000 });
  return { bots, room: Object.values(team.rooms)[0]! };
}

it('keeps a bot message with a mention entity as room background, and "@" in text selects no seat', async () => {
  fixture = await openTeam();
  const { bots: [b1], room } = await createRoom();
  const starts = fixture.adapter.starts.length;
  const background = group(room.id, 'g1', otherBot, 'Status for @Bot 1', [b1]);
  const result = await t.host().receive(background);
  expect(result).toEqual({ kind: 'bot_background', id: hash(['room-input', room.id, inboundKey(background)]) });
  const plain = await t.host().receive(group(room.id, 'g2', member, '@Bot 1 @all please review'));
  expect(plain.kind).toBe('room_input');
  await t.host().drain();
  let team = t.host().snapshot().team;
  for (const id of [result.id!, plain.id!]) expect(team.rounds[id]).toMatchObject({ seats: [], closed: true });
  expect(team.rooms[room.id]!.messages.map(m => [m.from, m.text])).toEqual([['im:other-bot', 'Status for @Bot 1'], ['im:member', '@Bot 1 @all please review']]);
  // The direct API applies the same rule to a bot principal, and refuses a given principal that is not verified.
  const api = await t.host().roomInput('api', room.id, 'Ping', 'all', otherBot);
  await expect(t.host().roomInput('bad', room.id, 'Ping', [b1], { id: '', kind: 'human' })).rejects.toThrow('unverified_sender');
  await expect(t.host().roomInput('undefined', room.id, 'Ping', [b1], undefined)).rejects.toThrow('unverified_sender');
  team = t.host().snapshot().team;
  expect(team.rounds[api]!.seats).toEqual([]);
  expect(Object.keys(team.rounds)).toEqual([result.id, plain.id, api]);
  expect(team.seats).toEqual({});
  expect(fixture.adapter.starts).toHaveLength(starts);
  expect(t.host().snapshot().audit).toEqual(Array(2).fill(`Action refused unverified_sender: roomInput ${room.id}`));
});

it('records the group sender principal on the room message and the seat request, and runs the called seat once', async () => {
  fixture = await openTeam();
  const { bots: [, b2], room } = await createRoom();
  const inbound = group(room.id, 'g1', member, 'Review the draft', [b2]);
  const result = await t.host().receive(inbound);
  expect(result.kind).toBe('room_input');
  const [seat] = t.host().snapshot().team.rounds[result.id!]!.seats as [string];
  const message = { id: result.id, from: 'im:member', text: 'Review the draft', late: false };
  expect(t.host().snapshot().team.rooms[room.id]!.messages).toEqual([message]);
  expect(JSON.parse(t.host().snapshot().turns[seat]!.request)).toMatchObject({ request: 'Review the draft', requestFrom: 'im:member' });
  expect(t.context(seat).room.messages).toEqual([message]);
  expect(await t.host().receive(inbound)).toEqual(result);
  await t.finish(seat, { speech: { kind: 'post', text: 'Looks good' } });
  const owned = await t.host().receive(group(room.id, 'g2', owner, 'Thanks'));
  const team = t.host().snapshot().team;
  expect(team.rooms[room.id]!.messages.map(m => m.from)).toEqual(['im:member', b2, 'owner']);
  expect(team.rounds[owned.id!]!.seats).toEqual([]);
  expect(Object.keys(team.seats)).toEqual([seat]);
});

it('defaults a group to execute, lets only the owner change memberMentions, and keeps an ignored non-owner mention as background (#1230)', async () => {
  fixture = await openTeam();
  const { bots: [b1], room } = await createRoom();
  // The setting is absent on a new room and reads as the ruling's default, execute.
  expect(memberMentions(t.host().snapshot().team.rooms[room.id]!)).toBe('execute');
  expect(t.host().snapshot().team.rooms[room.id]!.memberMentions).toBeUndefined();
  await expect(t.host().setMemberMentions(room.id, 'ignore', member)).rejects.toThrow('not_owner');
  expect(memberMentions(t.host().snapshot().team.rooms[room.id]!)).toBe('execute');
  expect(t.host().snapshot().audit).toContain(`Action refused not_owner: setMemberMentions ${room.id} human:im:member`);
  // With the default, a non-owner mention opens a seat, and the setting change does not touch that open root.
  const opened = await t.host().receive(group(room.id, 'g1', member, 'Review the draft', [b1]));
  const [existing] = t.host().snapshot().team.rounds[opened.id!]!.seats as [string];
  await t.finish(existing, { speech: { kind: 'post', text: 'Draft reviewed' } });
  const turns = Object.keys(t.host().snapshot().turns), intents = Object.keys(fixture.ledger.snapshot().intents);
  const starts = fixture.adapter.starts.length;
  await t.host().setMemberMentions(room.id, 'ignore', owner);
  expect(memberMentions(t.host().snapshot().team.rooms[room.id]!)).toBe('ignore');
  expect(t.host().snapshot().team.rounds[opened.id!]!.seats).toEqual([existing]);
  expect(t.host().snapshot().team.seats[existing]!.status).toBe('post');
  // A later non-owner mention opens no seat, spends no device work and no BYOK key, and stays room background.
  const ignored = await t.host().receive(group(room.id, 'g2', member, 'Look at this too', [b1]));
  expect(ignored.kind).toBe('room_input');
  expect(t.host().snapshot().team.rounds[ignored.id!]).toMatchObject({ seats: [], closed: true });
  const background = await t.host().roomInput('api', room.id, 'Also background', [b1], member);
  expect(t.host().snapshot().team.rounds[background]!.seats).toEqual([]);
  expect(t.host().snapshot().team.rooms[room.id]!.messages.map(message => [message.from, message.text])).toEqual([
    ['im:member', 'Review the draft'], [b1, 'Draft reviewed'], ['im:member', 'Look at this too'], ['im:member', 'Also background'],
  ]);
  expect(Object.keys(t.host().snapshot().turns)).toEqual(turns);
  expect(Object.keys(fixture.ledger.snapshot().intents)).toEqual(intents);
  expect(fixture.adapter.starts).toHaveLength(starts);
  // The owner's own mention still opens a seat, and that seat reads the ignored messages as context.
  const ownerCall = await t.host().receive(group(room.id, 'g3', owner, 'What do you think?', [b1]));
  const [seat] = t.host().snapshot().team.rounds[ownerCall.id!]!.seats as [string];
  expect(t.context(seat).room.messages.map((message: { text: string }) => message.text))
    .toEqual(['Review the draft', 'Draft reviewed', 'Look at this too', 'Also background', 'What do you think?']);
  await t.finish(seat, { speech: { kind: 'pass' } });
  // The setting persists, and switching back to execute applies to later messages only.
  await fixture.reopen();
  expect(memberMentions(t.host().snapshot().team.rooms[room.id]!)).toBe('ignore');
  await t.host().setMemberMentions(room.id, 'execute', owner);
  const resumed = await t.host().receive(group(room.id, 'g4', member, 'Back on', [b1]));
  expect(t.host().snapshot().team.rounds[resumed.id!]!.seats).toHaveLength(1);
});

it('refuses a non-owner delegation cancel or end with an audit row, and the owner cancel resolves it', async () => {
  fixture = await openTeam();
  const [a, b] = await t.createBots(2) as [string, string];
  const root = await t.host().input('delegate', 'Ask Bot 2', a);
  await t.finish(root, { delegate: [{ to: b, request: 'Check the draft' }] });
  const d = t.delegationOf(t.taskOf(root));
  await expect(t.host().cancelDelegation(d.id, member)).rejects.toThrow('not_owner');
  await expect(t.host().abandonDelegation(d.id, member)).rejects.toThrow('not_owner');
  await expect(t.host().cancelTurn(d.id, member)).rejects.toThrow('not_owner');
  expect(t.delegation(d.id)).not.toHaveProperty('cancel');
  expect(t.delegation(d.id)).not.toHaveProperty('verdict');
  expect(t.host().snapshot().audit).toEqual([
    `Action refused not_owner: cancelDelegation ${d.id} human:im:member`,
    `Action refused not_owner: abandonDelegation ${d.id} human:im:member`,
    `Action refused not_owner: cancelTurn ${d.id} human:im:member`,
  ]);
  await t.host().cancelDelegation(d.id);
  await vi.waitFor(async () => { await t.host().drain(); expect(t.delegation(d.id)).toMatchObject({ verdict: 'cancelled', reason: 'user_cancelled' }); }, { timeout: 5000 });
});
