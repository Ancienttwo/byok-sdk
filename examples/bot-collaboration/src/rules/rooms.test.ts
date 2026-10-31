import { expect, it } from 'vitest';
import { advanceRooms, applySpeech, memberMentions, roomInput, ROOM_GRACE_MS, setMemberMentions, updateRoom,
  type RoomsState, type SeatFacts } from './rooms';

/** A plain team slice. The rules need no ledger and no Host. */
function team(members = ['a', 'b', 'c']): RoomsState {
  return {
    bots: Object.fromEntries(members.map(id => [id, { archived: false }])),
    rooms: { r: { id: 'r', name: 'Room', members: [...members], mode: 'mention', announcement: '',
      visibleFrom: Object.fromEntries(members.map(id => [id, 0])), messages: [] } },
    rounds: {}, seats: {}, roots: {},
  };
}
function round(mentions: string[]) {
  const slice = team(), id = roomInput(slice, 'key', 'r', 'Review', mentions);
  return { slice, id, seats: slice.rounds[id]!.seats };
}
const rejected: string[] = [];
const accept = (kind: string, work: () => void) => { try { work(); } catch (error) { rejected.push(`${kind}: ${(error as Error).message}`); } };

it('queues one seat of a round at a time and returns its Turn with the request that the Bot can see', () => {
  const { slice, id, seats: [first, second] } = round(['b', 'a']);
  expect(advanceRooms(slice, {}, 1000)).toEqual({ cancel: [], turns: [{ id: first, botId: 'b',
    request: JSON.stringify({ roomId: 'r', roundId: id, request: 'Review', requestFrom: 'user' }) }] });
  expect(slice.seats[first!]).toMatchObject({ status: 'queued', deadline: 1000 + ROOM_GRACE_MS, released: false });
  expect(slice.seats[second!]!.status).toBe('waiting');
  expect(advanceRooms(slice, { [first!]: { admitted: true, started: false } }, 1001)).toEqual({ cancel: [], turns: [] });
});

it('runs a started seat from its first observed start and makes it late at the deadline without a cancel', () => {
  const { slice, seats: [first, second] } = round(['a', 'b']);
  advanceRooms(slice, {}, 0);
  const running = { [first!]: { admitted: true, started: true } };
  expect(advanceRooms(slice, running, 10)).toEqual({ cancel: [], turns: [] });
  expect(slice.seats[first!]).toMatchObject({ status: 'running', startedAt: 10, deadline: 10 + ROOM_GRACE_MS, released: false });
  const late = advanceRooms(slice, running, 10 + ROOM_GRACE_MS);
  expect(late.cancel).toEqual([]);
  expect(slice.seats[first!]).toMatchObject({ status: 'late', late: true, released: true });
  expect(late.turns.map(turn => turn.id)).toEqual([second]);
});

it('cancels work that has not started at the deadline; a Turn that was never admitted expires', () => {
  for (const facts of [{ admitted: true, started: false }, undefined]) {
    const { slice, id, seats: [seat] } = round(['a']);
    advanceRooms(slice, {}, 0);
    expect(advanceRooms(slice, facts ? { [seat!]: facts } : {}, ROOM_GRACE_MS)).toEqual({ cancel: [{ seatId: seat, conclusion: 'expired' }], turns: [] });
    expect(slice.seats[seat!]).toMatchObject({ status: 'busy', released: true });
    expect(slice.rounds[id]!.closed).toBe(true);
  }
});

it('releases the seat of a removed or archived member and cancels only work that has not started', () => {
  const cases: Array<[SeatFacts | undefined, boolean]> = [[undefined, true], [{ admitted: true, started: false }, true],
    [{ admitted: true, started: true }, false], [{ admitted: true, started: false, conclusion: 'succeeded' }, false]];
  for (const leave of [(slice: RoomsState) => { slice.rooms.r!.members = ['b', 'c']; }, (slice: RoomsState) => { slice.bots = { ...slice.bots, a: { archived: true } }; }]) {
    for (const [facts, cancelled] of cases) {
      const { slice, seats: [first] } = round(['a', 'b']);
      advanceRooms(slice, {}, 0);
      leave(slice);
      const result = advanceRooms(slice, facts ? { [first!]: facts } : {}, 1);
      expect(slice.seats[first!]).toMatchObject({ status: 'removed', released: true });
      expect(result.cancel).toEqual(cancelled ? [{ seatId: first, conclusion: 'cancelled' }] : []);
    }
  }
});

it('releases a concluded seat: an expired one is busy, any other conclusion fails it with that reason', () => {
  for (const [conclusion, status] of [['expired', 'busy'], ['failed', 'failed'], ['cancelled', 'failed']] as const) {
    const { slice, id, seats: [seat] } = round(['a']);
    advanceRooms(slice, {}, 0);
    expect(advanceRooms(slice, { [seat!]: { admitted: true, started: true, conclusion } }, 1)).toEqual({ cancel: [], turns: [] });
    expect(slice.seats[seat!]).toMatchObject({ status, released: true, reason: conclusion });
    expect(slice.rounds[id]!.closed).toBe(true);
  }
});

it('applies a room_call batch as a unit: a refused batch changes no seat, an accepted one changes the given slice', () => {
  rejected.length = 0;
  const refused = round(['a']);
  advanceRooms(refused.slice, {}, 0);
  applySpeech(refused.slice, refused.seats[0]!, { speech: { kind: 'pass' }, room_call: { members: ['b', 'ghost'] } }, 'task-1', 1, accept);
  expect(rejected).toEqual(['room_call: Bot is archived or absent']);
  expect(refused.slice.seats[refused.seats[0]!]).toMatchObject({ status: 'pass', released: true });
  expect(refused.slice.rounds[refused.id]).toMatchObject({ seats: [refused.seats[0]], counts: { a: 1 } });
  expect(Object.keys(refused.slice.seats)).toEqual(refused.seats);

  const { slice, id, seats: [seat] } = round(['a']);
  advanceRooms(slice, {}, 0);
  applySpeech(slice, seat!, { speech: { kind: 'post', text: 'Over to b' }, room_call: { members: ['b'] } }, 'task-2', 1, accept);
  expect(rejected).toHaveLength(1);
  const called = slice.rounds[id]!.seats[1]!;
  expect(slice.seats[called]).toMatchObject({ botId: 'b', status: 'waiting', triggerMessageId: seat });
  expect(advanceRooms(slice, {}, 2).turns).toEqual([{ id: called, botId: 'b',
    request: JSON.stringify({ roomId: 'r', roundId: id, request: 'Over to b', requestFrom: 'a' }) }]);
});

it('replays the same room input and refuses a changed one', () => {
  const slice = team(), id = roomInput(slice, 'key', 'r', 'Hello', 'all');
  expect(roomInput(slice, 'key', 'r', 'Hello', 'all')).toBe(id);
  expect(() => roomInput(slice, 'key', 'r', 'Changed', 'all')).toThrow('Room input identity conflict');
  expect(slice.rounds[id]!.seats.map(seat => slice.seats[seat]!.botId)).toEqual(['a', 'b', 'c']);
});

it('defaults the memberMentions setting to execute, stores an owner change, and leaves an open round alone (#1230)', () => {
  const slice = team();
  expect(memberMentions(slice.rooms.r!)).toBe('execute');
  expect(slice.rooms.r!.memberMentions).toBeUndefined();
  const opened = roomInput(slice, 'key', 'r', 'First', ['b']);
  const [seat] = slice.rounds[opened]!.seats;
  setMemberMentions(slice, 'r', 'ignore');
  expect(memberMentions(slice.rooms.r!)).toBe('ignore');
  expect(slice.rounds[opened]!.seats).toEqual([seat]);
  expect(slice.rooms.r!.messages.map(message => message.text)).toEqual(['First']);
  // A team command keeps the Host setting on the room row.
  updateRoom(slice, 'r', { name: 'Renamed' });
  expect(memberMentions(slice.rooms.r!)).toBe('ignore');
  expect(() => setMemberMentions(slice, 'missing', 'ignore')).toThrow('Room not found');
  expect(() => setMemberMentions(slice, 'r', 'ignore-all' as never)).toThrow('memberMentions is execute or ignore');
});
