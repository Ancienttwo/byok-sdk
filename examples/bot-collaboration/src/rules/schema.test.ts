import { expect, it } from 'vitest';
import { addTurn } from './turn';
import { NEW_BOTS, outcomeSchema, type ContextState } from './schema';

type RoomAction = { items: { properties: { members: { items: { enum: string[] } }; admin: { enum: string[] } } } };

/** The member and admin ids of the room actions in an owner Main Bot Turn's schema. */
function roomIds(external: boolean) {
  const bot = (id: string, mainBot: boolean) => ({ id, name: id, role: 'Helper', mainBot, archived: false, readyRevision: '1' });
  const state = {
    team: { bots: { main: bot('main', true), helper: bot('helper', false) }, notes: [], homeOperations: [], rounds: {}, seats: {},
      rooms: { r1: { id: 'r1', name: 'Room', members: ['main', 'helper'], mode: 'mention', announcement: '', messages: [] } },
      ...(external ? { external: { revision: 1 } } : {}) },
    turns: {}, budgets: {}, delegations: {}, batches: {}, units: {}, replies: {},
  };
  const turn = addTurn(state as never, { id: 't1', root: 't1', source: 'user', request: 'Make a room', botId: 'main', hop: 0, authority: 'owner' });
  const { properties } = outcomeSchema('main', state as unknown as ContextState, turn) as { properties: Record<string, RoomAction> };
  return Object.fromEntries((['create_room', 'update_room'] as const).map(action => [action, {
    members: properties[action]!.items.properties.members.items.enum, admin: properties[action]!.items.properties.admin.enum }]));
}

it('#881: external team mode offers only current Bots as room members, because it offers no create_bot', () => {
  const current = { members: ['main', 'helper'], admin: ['main', 'helper'] };
  expect(roomIds(true)).toEqual({ create_room: current, update_room: current });
  // Local mode: a room can name a Bot that the same outcome creates.
  const local = { members: ['main', 'helper', ...NEW_BOTS], admin: ['main', 'helper', ...NEW_BOTS] };
  expect(roomIds(false)).toEqual({ create_room: local, update_room: local });
});
