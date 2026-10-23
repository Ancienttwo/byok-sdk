import { describe, expect, it } from 'vitest';
import { stateOf, type CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { seedCollaboration } from '@byok-sdk/example-bot-collaboration/test-support';
import { assemble, FRAME_MAX_BYTES, split } from './layout';

/** A state with each mapped map and list, optional fields in a late order, and ids that JavaScript orders itself. */
function rich(): CollaborationState {
  const state = stateOf({});
  seedCollaboration(state, 'external');
  state.revision = 4;
  for (const id of ['b', '10', '2', '__proto__', '\ud800']) {
    Object.defineProperty(state.turns, id, { value: { ...state.turns.t1!, id }, enumerable: true, writable: true, configurable: true });
  }
  state.team.rooms.r1 = { id: 'r1', name: 'Room', members: ['main'], mode: 'mention', announcement: '', visibleFrom: { main: 1 },
    messages: [{ id: 'm1', from: 'owner', text: 'a', late: false }, { id: 'm2', from: 'main', text: 'b', late: true }] };
  state.team.rooms.r2 = { id: 'r2', name: 'Empty', members: [], mode: 'mention', announcement: '', visibleFrom: {}, messages: [] };
  state.team.notes.push({ id: 'n2', text: 'second' }, { id: 'n1', text: 'first' });
  state.audit.push('one', 'two');
  state.rejected.push({ botId: 'main', taskId: 'x', action: 'a', reason: 'r' });
  state.channel = { inbounds: {}, pushRoutes: {}, deliveries: {} };
  state.commands = { i1: { evidence: 'sha256:x', result: { revision: 1, disposition: { outcome: 'accepted' }, outbox: [] } } };
  state.inputs = {};
  return state;
}

describe('H row layout (#793 D2a)', () => {
  it('rebuilds the same state bytes from its rows', () => {
    const state = rich();
    expect(JSON.stringify(assemble(split(state)))).toBe(JSON.stringify(state));
    expect(JSON.stringify(assemble(split(stateOf({}))))).toBe(JSON.stringify(stateOf({})));
  });

  it('keeps no entity, list element or record in the frame', () => {
    const rows = split(rich()), frame = JSON.parse(rows.frame);
    expect(frame.turns).toEqual({});
    expect(frame.team.rooms).toEqual({});
    expect(frame.team.notes).toEqual([]);
    expect(frame.commands).toEqual({});
    expect(frame.revision).toBe(4);
    expect(frame.team.external).toEqual({ revision: 1 });
    expect([...rows.entities.get('turn')!.keys()]).toEqual(['"2"', '"10"', '"t1"', '"b"', '"__proto__"', '"\\ud800"']);
    expect(rows.entries.get('room_message\u0000"r1"')!.bodies).toHaveLength(2);
  });

  it('refuses a state field that has no row layout once it grows', () => {
    const state = rich() as CollaborationState & { history?: string[] };
    state.history = Array.from({ length: 1000 }, (_, index) => `entry ${index}`);
    expect(() => split(state)).toThrow('Collaboration frame is too large');
  });
});
