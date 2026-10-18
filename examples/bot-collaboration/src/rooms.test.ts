import { expect, it } from 'vitest';
import { hash, type LedgerState } from '../../host-execution-core/src/model';
import { template } from '../../host-execution-core/src/test-support';
import { stateOf, type Turn } from './model';
import { advanceRooms, applySpeech, roomInput, ROOM_GRACE_MS } from './rooms';
import { applyManagement, roomFields } from './team';
import { outcomeSchema, turnContext } from './schema';
import { validateResultOutcome } from '@byok-sdk/protocol';

function setup(count = 3, admin?: string) {
  const ledger = { application: {}, intents: {}, executions: {} } as LedgerState;
  const state = stateOf(ledger.application);
  for (let i = 0; i < count; i++) {
    const id = `b${i}`;
    state.team.bots[id] = { id, name: id, role: 'worker', persona: 'private', model: 'default', mainBot: i === 0,
      archived: false, revision: '1', readyRevision: '1', execution: template('device', id) };
  }
  state.team.rooms.r = { id: 'r', ...roomFields(state.team, { name: 'Room', members: Object.keys(state.team.bots), admin }), messages: [] };
  const rejected: string[] = [];
  const accept = (kind: string, work: () => void) => { try { work(); } catch (error) { rejected.push(`${kind}: ${(error as Error).message}`); } };
  const add = (id: string, botId: string, request: string) => { state.turns[id] = { id, root: id, botId, source: 'room_slot', request, hop: 0, status: 'queued' }; };
  const advance = (now = 0) => advanceRooms(ledger, state, now, add);
  const speech = (id: string, members?: string[], now = 0, text?: string) => applySpeech(state, state.turns[id]!, {
    speech: text === undefined ? { kind: 'pass' } : { kind: 'post', text }, ...(members ? { room_call: { members } } : {}),
  }, `task-${id}`, now, accept);
  return { ledger, state, rejected, accept, advance, speech };
}

it('uses structured mentions only, keeps their order, and deduplicates input', () => {
  const { state, advance } = setup();
  const id = roomInput(state, 'ordinary', 'r', '@b0 @all [PASS]', []);
  advance();
  expect(state.team.rounds[id]!.seats).toEqual([]);
  expect(state.turns).toEqual({});
  expect(roomInput(state, 'ordinary', 'r', '@b0 @all [PASS]', [])).toBe(id);
  expect(() => roomInput(state, 'ordinary', 'r', 'changed', [])).toThrow('identity conflict');
  const selected = roomInput(state, 'select', 'r', 'Review', ['b2', 'b1', 'b2']);
  advance();
  expect(state.team.rounds[selected]!.seats.map(s => state.team.seats[s]!.botId)).toEqual(['b2', 'b1']);
  expect(Object.values(state.turns).map(t => t.botId)).toEqual(['b2']);
  expect(() => roomInput(state, 'invalid', 'r', 'Review', ['stranger'])).toThrow('not a member');
});

it('reserves at most initial + 4 seats, with member caps and atomic batch refusal', () => {
  const { state, advance, speech, rejected } = setup();
  const id = roomInput(state, 'budget', 'r', 'Discuss', ['b0']);
  advance();
  let round = state.team.rounds[id]!;
  expect(round.limit).toBe(5);
  speech(round.seats[0]!, ['b0', 'b1', 'b2']); advance();
  speech(state.team.rounds[id]!.seats[1]!, ['b1', 'b2']);
  round = state.team.rounds[id]!;
  expect(round.seats).toHaveLength(4); // Whole two-member batch exceeded the remaining one slot.
  expect(round.counts).toEqual({ b0: 2, b1: 1, b2: 1 });
  advance(); speech(round.seats[2]!, ['b1']); advance(); speech(state.team.rounds[id]!.seats[3]!, ['b2']);
  expect(state.team.rounds[id]!.seats).toHaveLength(5);
  expect(rejected.filter(r => r.includes('Round seat budget'))).toHaveLength(2);
});

it('caps ordinary members at two and admins at four without implicit admin selection', () => {
  const { state, advance, speech, rejected } = setup(3, 'b0');
  const roundId = roomInput(state, 'admin', 'r', 'Discuss', ['b1']); advance();
  expect(state.team.rounds[roundId]!.limit).toBe(9);
  expect(Object.values(state.turns).map(t => t.botId)).toEqual(['b1']);
  speech(state.team.rounds[roundId]!.seats[0]!, ['b0', 'b1']); advance();
  speech(state.team.rounds[roundId]!.seats[1]!, ['b0']); advance();
  speech(state.team.rounds[roundId]!.seats[2]!, ['b1']); advance();
  for (let i = 0; i < 3; i++) {
    const round = state.team.rounds[roundId]!;
    const current = round.seats.find(id => !state.team.seats[id]!.released)!;
    if (current) { speech(current, ['b0']); advance(); }
  }
  expect(state.team.rounds[roundId]!.counts).toEqual({ b1: 2, b0: 4 });
  expect(rejected).toEqual(expect.arrayContaining([expect.stringContaining('Member seat budget')]));
});

it('requires explicit speech, offers management only to Main Bots, and checks current role on apply', () => {
  const { state, advance, accept, rejected } = setup();
  roomInput(state, 'schema', 'r', 'Speak', ['b1']); advance();
  const turn = Object.values(state.turns)[0]!;
  const group = outcomeSchema('b1', state, turn);
  expect(validateResultOutcome(group, {}).ok).toBe(false);
  expect(validateResultOutcome(group, { speech: { kind: 'post', text: '' } }).ok).toBe(false);
  expect(validateResultOutcome(group, { speech: { kind: 'pass' } }).ok).toBe(true);
  expect(validateResultOutcome(group, { room_call: { members: ['b0'] }, speech: { kind: 'pass' } }).ok).toBe(true);
  expect(group.properties).not.toHaveProperty('create_bot');
  const ordinary = { ...turn, source: 'user' } as Turn;
  expect(outcomeSchema('b1', state, ordinary).properties).not.toHaveProperty('speech');
  const main = outcomeSchema('b0', state, ordinary);
  expect(Object.keys(main.properties!)).toEqual(expect.arrayContaining(['create_bot', 'update_bot', 'delete_bot', 'create_room', 'team_note']));
  state.team.bots.b0!.mainBot = false;
  applyManagement(state, 'b0', 'stale-role', { team_note: { text: 'forbidden' } }, { default: template('device') }, accept);
  expect(state.team.notes).toEqual([]);
  expect(rejected).toContain('team_note: Main Bot role required');
});

it('limits late posts to ten per user root and autonomous rounds to three', () => {
  const { state, ledger, advance, speech, rejected } = setup(12);
  const roundId = roomInput(state, 'late', 'r', 'Discuss', 'all');
  let now = 0;
  for (let i = 0; i < 12; i++) {
    advance(now);
    const seat = state.team.seats[state.team.rounds[roundId]!.seats[i]!]!;
    ledger.intents[hash(seat.id)] = { taskId: seat.id } as LedgerState['intents'][string];
    ledger.executions[seat.id] = { started: true } as LedgerState['executions'][string];
    now += ROOM_GRACE_MS; advance(now);
    speech(seat.id, undefined, now, 'Late post');
  }
  expect(state.team.rooms.r!.messages.filter(m => m.late)).toHaveLength(10);
  expect(state.team.roots[roundId]!.late).toBe(10);
  expect(rejected.filter(r => r.includes('Late post budget'))).toHaveLength(2);

  const fresh = setup(1);
  const root = roomInput(fresh.state, 'autonomous', 'r', 'Discuss', ['b0']);
  for (let i = 0; i < 4; i++) {
    fresh.advance(i * ROOM_GRACE_MS);
    const seat = Object.values(fresh.state.team.seats).find(s => !s.released)!;
    fresh.ledger.intents[hash(seat.id)] = { taskId: seat.id } as LedgerState['intents'][string];
    fresh.ledger.executions[seat.id] = { started: true } as LedgerState['executions'][string];
    fresh.advance((i + 1) * ROOM_GRACE_MS);
    fresh.speech(seat.id, ['b0'], (i + 1) * ROOM_GRACE_MS, 'Next round');
  }
  expect(fresh.state.team.roots[root]!.autonomous).toBe(3);
  expect(Object.values(fresh.state.team.rounds)).toHaveLength(4);
  expect(fresh.rejected).toContain('room_call: Autonomous round budget is 3');
});

it('blocks excess room history and keeps other Bots private turns out of context', () => {
  const { state, advance } = setup();
  roomInput(state, 'context', 'r', 'Discuss', ['b1']); advance();
  const turn = Object.values(state.turns)[0]!;
  state.team.notes.push({ id: 'note', text: 'Shared rule' });
  state.turns.secret = { ...turn, id: 'secret', source: 'user', botId: 'b0', request: 'private owner message' };
  expect(JSON.stringify(turnContext(state, turn))).not.toContain('private owner message');
  expect(JSON.stringify(turnContext(state, { ...turn, source: 'user' }))).not.toContain('private owner message');
  expect(turnContext(state, turn)).toHaveProperty('teamNotes', [{ id: 'note', text: 'Shared rule' }]);
  state.team.rooms.r!.messages = Array.from({ length: 101 }, (_, i) => ({ id: String(i), from: 'b0', text: 'text', late: false }));
  expect(() => turnContext(state, turn)).toThrow('100 entries');
  state.team.rooms.r!.messages = [{ id: 'huge', from: 'user', text: 'x'.repeat(65536), late: false }];
  expect(() => turnContext(state, turn)).toThrow('64 KiB');
});

it('refuses duplicate local slots and invalid room edits without partial room mutation', () => {
  const { state, accept, rejected } = setup();
  const action = { localId: 'new_bot_1', name: 'New', role: 'Worker', persona: 'Persona', model: 'default' };
  applyManagement(state, 'b0', 'create', { create_bot: [action, action],
    create_room: [{ localId: 'new_room_1', name: 'Created', members: ['new_bot_1'] }],
  }, { default: template('device') }, accept);
  expect(Object.values(state.team.bots)).toHaveLength(4);
  const created = Object.values(state.team.rooms).find(r => r.name === 'Created')!;
  expect(created.members).toEqual([Object.values(state.team.bots).find(b => b.name === 'New')!.id]);
  expect(rejected).toContain('create_bot: Duplicate local Bot slot');
  const prior = structuredClone(state.team.rooms.r);
  applyManagement(state, 'b0', 'bad-room', { update_room: [{ roomId: 'r', admin: created.members[0]!, announcement: 'Must not apply' }] },
    { default: template('device') }, accept);
  expect(state.team.rooms.r).toEqual(prior);
  expect(rejected).toContain('update_room: Admin must be a room member');
});

it('bounds shared notes at twenty and preserves other valid actions after a refusal', () => {
  const { state, accept, rejected } = setup();
  for (let i = 0; i < 21; i++) applyManagement(state, 'b0', `note-${i}`, { team_note: { text: `Note ${i}` } }, { default: template('device') }, accept);
  expect(state.team.notes).toHaveLength(20);
  expect(rejected).toContain('team_note: Team note limit is 20');
  applyManagement(state, 'b0', 'partial', { update_bot: [{ botId: 'b1' }], update_room: [{ roomId: 'r', announcement: 'Valid' }] }, { default: template('device') }, accept);
  expect(state.team.bots.b1!.revision).toBe('1');
  expect(state.team.rooms.r!.announcement).toBe('Valid');
  expect(rejected).toContain('update_bot: An update must change a Bot field');
});
