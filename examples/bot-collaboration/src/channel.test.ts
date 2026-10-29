import { expect, it } from 'vitest';
import { hash, type LedgerState } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { classifyInbound, inboundKey, isOwner, type InboundMessage, type Principal } from './channel';
import { stateOf } from './model';
import { advanceRooms, roomInput } from './rooms';
import { roomFields } from './team';

const owner: Principal = { id: 'owner', kind: 'human' };
const member: Principal = { id: 'im:member', kind: 'human' };
const otherBot: Principal = { id: 'im:other-bot', kind: 'bot' };
function message(fields: Partial<InboundMessage> & { group?: boolean } = {}): InboundMessage {
  const { group, ...rest } = fields;
  return { channel: 'fake', platformMessageId: 'm1', conversation: group ? { kind: 'group', id: 'r' } : { kind: 'direct', id: 'main' },
    sender: owner, text: 'Hello', mentions: [], ...rest };
}

it('classifies inbound messages in the guide order', () => {
  const rows: Array<[InboundMessage, string]> = [
    [message({ sender: undefined }), 'unverified_sender'],
    [message({ group: true, sender: undefined, mentions: ['b1'] }), 'unverified_sender'],
    [message({ sender: otherBot }), 'bot_audit'],
    [message({ group: true, sender: otherBot, mentions: ['b1'] }), 'bot_background'],
    [message(), 'owner_input'],
    [message({ sender: member }), 'not_owner'],
    [message({ group: true, sender: member, mentions: ['b1'] }), 'room_input'],
    [message({ group: true }), 'room_input'],
    // A bot account with the owner id is still a bot.
    [message({ sender: { id: 'owner', kind: 'bot' } }), 'bot_audit'],
  ];
  for (const [inbound, kind] of rows) expect(classifyInbound(inbound, 'owner')).toBe(kind);
});

it('refuses a sender without a non-empty id and a known kind as unverified', () => {
  const malformed = [{ id: '', kind: 'human' }, { id: 'owner', kind: 'admin' }, { id: 42, kind: 'human' }, { kind: 'human' }, null];
  for (const sender of malformed) {
    for (const group of [false, true]) expect(classifyInbound(message({ group, sender: sender as unknown as Principal }), 'owner')).toBe('unverified_sender');
  }
});

it('gives owner authority only to the human principal with the owner id', () => {
  expect(isOwner(owner, 'owner')).toBe(true);
  expect(isOwner({ id: 'owner', kind: 'bot' }, 'owner')).toBe(false);
  expect(isOwner(member, 'owner')).toBe(false);
  expect(isOwner(member, 'im:member')).toBe(true);
  expect(classifyInbound(message(), 'im:member')).toBe('not_owner');
  expect(classifyInbound(message({ sender: member }), 'im:member')).toBe('owner_input');
});

it('derives the input key from channel, conversation and platform message id only', () => {
  const key = inboundKey(message());
  expect(key).toBe(hash(['fake', 'main', 'm1']));
  expect(inboundKey(message({ text: 'Edited', sender: member, mentions: ['b1'] }))).toBe(key);
  expect(inboundKey(message({ channel: 'other' }))).not.toBe(key);
  expect(inboundKey(message({ conversation: { kind: 'direct', id: 'b1' } }))).not.toBe(key);
  expect(inboundKey(message({ platformMessageId: 'm2' }))).not.toBe(key);
});

function room() {
  const ledger = { application: {}, intents: {}, executions: {} } as LedgerState;
  const state = stateOf(ledger.application);
  for (const id of ['b0', 'b1']) state.team.bots[id] = { id, name: id, role: 'worker', persona: '', model: 'default', mainBot: id === 'b0',
    archived: false, revision: '1', readyRevision: '1', execution: template('device', id) };
  state.team.rooms.r = { id: 'r', ...roomFields(state.team, { name: 'Room', members: ['b0', 'b1'] }), messages: [] };
  const add = (id: string, botId: string, request: string) => { state.turns[id] = { id, root: id, botId, source: 'room_slot', request, hop: 0, status: 'queued' }; };
  return { state, advance: () => advanceRooms(ledger, state, 0, add) };
}

it('records the sender principal id on the room message and the seat request', () => {
  const { state, advance } = room();
  const id = roomInput(state, 'k', 'r', 'Review', ['b1'], 'im:member');
  advance();
  expect(state.team.rooms.r!.messages).toEqual([{ id, from: 'im:member', text: 'Review', late: false }]);
  const seat = state.team.rounds[id]!.seats[0]!;
  expect(JSON.parse(state.turns[seat]!.request)).toMatchObject({ request: 'Review', requestFrom: 'im:member' });
  expect(roomInput(state, 'k', 'r', 'Review', ['b1'], 'im:member')).toBe(id);
  expect(() => roomInput(state, 'k', 'r', 'Review', ['b1'], 'im:someone-else')).toThrow('Room input identity conflict');
  expect(() => roomInput(state, 'k', 'r', 'Review', ['b1'])).toThrow('Room input identity conflict');
});

it('keeps the K8b sender and input identity without a principal', () => {
  const { state } = room();
  const id = roomInput(state, 'legacy', 'r', 'Hello', ['b1']);
  expect(state.team.rooms.r!.messages.at(-1)).toEqual({ id, from: 'user', text: 'Hello', late: false });
  expect(state.team.rounds[id]!.input).toBe(JSON.stringify({ text: 'Hello', mentions: ['b1'] }));
  expect(roomInput(state, 'legacy', 'r', 'Hello', ['b1'])).toBe(id);
});
