import { afterEach, expect, it, vi } from 'vitest';
import { canonical, hash } from '@byok-sdk/example-host-execution-core';
import { openTeam, type TestTeam } from './team.test-support';
import { ROOM_GRACE_MS, type RoomMessage } from './rooms';

/** #883: a seat ContextPack reads its room messages from an external room history authority. */
let fixture: TestTeam;
afterEach(async () => { await fixture?.close(); });
const host = () => fixture.host;

const ROWS: RoomMessage[] = [
  { id: 'cloud-m1', from: 'user', text: 'Cloud question about the position', late: false },
  { id: 'cloud-m2', from: 'main', text: 'Cloud post from the Main Bot', late: true },
];
type RoomPack = { room: { messages: RoomMessage[] }; historyWindow: { omittedMessages: number } };
function contextOf(turnId: string): RoomPack {
  const instruction = host().core.intent(turnId)!.execution.payload.instruction;
  if (typeof instruction !== 'string') throw new Error('Expected an inline instruction');
  return JSON.parse(instruction.split('ContextPack:\n')[1]!) as RoomPack;
}
async function finish(id: string, document: unknown) {
  await vi.waitFor(async () => { await host().drain(); expect(fixture.adapter.sessions.has(host().core.intent(id)!.taskId)).toBe(true); }, { timeout: 5000 });
  fixture.adapter.sessions.get(host().core.intent(id)!.taskId)!.finish(document);
  await vi.waitFor(async () => { await host().drain(); expect(host().snapshot().turns[id]?.status).toBe('succeeded'); }, { timeout: 5000 });
}
/** A team with one more Bot and a room of both. The Host then restarts with the room history authority. */
async function open(roomHistory: NonNullable<TestTeam['botOptions']['roomHistory']>, now?: () => number) {
  fixture = await openTeam({ now });
  const created = await host().input('create', 'Create a Bot and a room');
  await finish(created, { create_bot: [{ localId: 'new_bot_1', name: 'Bot 1', role: 'Reviewer', persona: 'Persona 1', model: 'default' }],
    create_room: [{ localId: 'new_room_1', name: 'Room', members: ['main', 'new_bot_1'] }] });
  const other = Object.keys(host().snapshot().team.bots).find(id => id !== 'main')!, room = Object.values(host().snapshot().team.rooms)[0]!;
  await vi.waitFor(async () => { await host().drain(); expect(host().snapshot().team.bots[other]!.readyRevision).toBe('1'); }, { timeout: 5000 });
  fixture.botOptions.roomHistory = roomHistory;
  await fixture.reopen();
  return { other, room };
}

it('#883 acceptance 1: the seat ContextPack has the injected room messages, and the Turn stores only their hash', async () => {
  const reads: Array<{ roomId: string; botId: string; turnId: string }> = [];
  const { other, room } = await open(async input => { reads.push(input); return ROWS; });
  const round = await host().roomInput('ask', room.id, 'Local room input text', [other]);
  const seat = host().snapshot().team.rounds[round]!.seats[0]!;
  await vi.waitFor(async () => { await host().drain(); expect(host().core.intent(seat)).toBeDefined(); }, { timeout: 5000 });
  expect(reads).toContainEqual({ roomId: room.id, botId: other, turnId: seat });
  // The authority selected the rows for this Bot, so K8 applies no visibility of its own (Q2b).
  expect(contextOf(seat).room.messages).toEqual(ROWS);
  expect(host().snapshot().turns[seat]!.historyDigest).toBe(hash(canonical(ROWS)));
  const stored = JSON.stringify(host().snapshot());
  for (const row of ROWS) expect(stored).not.toContain(row.text);
  // Q2c: K8 still writes `room.messages`, which gives the seat its request text.
  expect(host().snapshot().team.rooms[room.id]!.messages.map(m => m.text)).toEqual(['Local room input text']);
  expect(JSON.parse(host().snapshot().turns[seat]!.request)).toMatchObject({ request: 'Local room input text' });
  await finish(seat, { speech: { kind: 'post', text: 'Seat post' } });
  // The digest is stored state, so a restart keeps it.
  await fixture.reopen();
  expect(host().snapshot().turns[seat]!.historyDigest).toBe(hash(canonical(ROWS)));
});

it('#883 acceptance 3: a failed or malformed read leaves the seat queued, and a good read freezes it', async () => {
  // The timer can read again at any time, so each answer holds until the test changes it.
  let mode: 'offline' | 'bad' | 'good' = 'offline';
  const { other, room } = await open(async () => {
    if (mode === 'offline') throw new Error('authority offline');
    return (mode === 'bad' ? [{ id: 'bad', from: 'user', text: 'x' }] : ROWS) as readonly RoomMessage[];
  });
  const round = await host().roomInput('ask', room.id, 'Review', [other]);
  const seat = host().snapshot().team.rounds[round]!.seats[0]!;
  await host().drain();
  expect(host().core.intent(seat)).toBeUndefined();
  expect([host().snapshot().turns[seat]!.status, host().snapshot().team.seats[seat]!.status]).toEqual(['queued', 'queued']);
  mode = 'bad';
  await host().drain();
  expect(host().core.intent(seat)).toBeUndefined();
  mode = 'good';
  await host().drain();
  expect(contextOf(seat).room.messages).toEqual(ROWS);
});

it('counts a room read still open at the seat deadline as failed, so the seat expires and the Host keeps working', async () => {
  let now = Date.now(), stall = false;
  const { other, room } = await open(async () => {
    if (stall) return new Promise<never>(() => {});
    throw new Error('authority offline');
  }, () => now);
  const round = await host().roomInput('ask', room.id, 'Review', [other]);
  const seat = host().snapshot().team.rounds[round]!.seats[0]!;
  stall = true;
  now += ROOM_GRACE_MS;
  await host().drain();
  expect(host().snapshot().team.seats[seat]).toMatchObject({ status: 'busy', released: true });
  expect(host().snapshot().turns[seat]).toMatchObject({ status: 'failed', conclusion: 'expired' });
  // The exclusive queue is free: an unrelated input still commits.
  await expect(host().input('after', 'Still working')).resolves.toEqual(expect.any(String));
});

it('releases a seat whose room read never succeeds at its deadline', async () => {
  let now = Date.now();
  const { other, room } = await open(async () => { throw new Error('authority offline'); }, () => now);
  const round = await host().roomInput('ask', room.id, 'Review', [other]);
  const seat = host().snapshot().team.rounds[round]!.seats[0]!;
  await host().drain();
  expect(host().core.intent(seat)).toBeUndefined();
  now += ROOM_GRACE_MS;
  await host().drain();
  expect(host().snapshot().team.seats[seat]).toMatchObject({ status: 'busy', released: true });
  expect(host().snapshot().turns[seat]).toMatchObject({ status: 'failed', conclusion: 'expired' });
  expect(host().core.intent(seat)).toBeUndefined();
});

it('reads the room history of a seat that a released seat queued in the same sync, before it freezes or blocks', async () => {
  const reads: string[] = [];
  const { other, room } = await open(async input => { reads.push(input.turnId); return ROWS; });
  // Each seat Turn blocks in its Turn step. The second seat is queued after the first one's read, so it is read on the next sync.
  const round = await host().roomInput('over-limit', room.id, '😀'.repeat(18000), [other, 'main']);
  await host().drain();
  const seats = host().snapshot().team.rounds[round]!.seats;
  expect(seats.map(id => host().snapshot().team.seats[id]!)).toMatchObject([{ status: 'blocked', released: true }, { status: 'blocked', released: true }]);
  expect(host().snapshot().team.rounds[round]).toMatchObject({ closed: true });
  expect(reads).toEqual(expect.arrayContaining(seats));
});
