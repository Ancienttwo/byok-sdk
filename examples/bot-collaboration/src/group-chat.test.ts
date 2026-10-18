import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openTeam, type TestTeam } from './team.test-support';
import { ROOM_GRACE_MS } from './rooms';
import { stateOf } from './model';
import type { BotProfile } from './team-model';

let fixture: TestTeam;
let releaseProjection: (() => void) | undefined;
afterEach(async () => { releaseProjection?.(); releaseProjection = undefined; await fixture?.close(); });
const host = () => fixture.host;
async function running(id: string) {
  await vi.waitFor(async () => { await host().drain(); expect(fixture.adapter.sessions.has(host().core.intent(id)!.taskId)).toBe(true); }, { timeout: 5000 });
  return fixture.adapter.sessions.get(host().core.intent(id)!.taskId)!;
}
async function finish(id: string, document: unknown = {}) {
  (await running(id)).finish(document);
  await vi.waitFor(async () => { await host().drain(); expect(host().snapshot().turns[id]?.status).toBe('succeeded'); }, { timeout: 5000 });
}
async function createTeam() {
  const id = await host().input('create-team', 'Create three Bots and one room');
  await finish(id, { create_bot: [1, 2, 3].map(i => ({ localId: `new_bot_${i}`, name: `Bot ${i}`, role: 'Reviewer', persona: `Persona ${i}`, model: 'default' })),
    create_room: [{ localId: 'new_room_1', name: 'Review room', members: ['new_bot_1', 'new_bot_2', 'new_bot_3'], admin: 'new_bot_1' }],
    team_note: { text: 'State the evidence.' },
  });
  const profiles = Object.values(host().snapshot().team.bots).filter(b => b.id !== 'main');
  const room = Object.values(host().snapshot().team.rooms)[0]!;
  return { profiles, room };
}
async function ready(profiles: BotProfile[]) {
  await vi.waitFor(async () => {
    await host().drain();
    for (const profile of profiles) expect(host().snapshot().team.bots[profile.id]?.readyRevision).toBe(host().snapshot().team.bots[profile.id]?.revision);
  }, { timeout: 5000 });
}
function seats(roundId: string) { const team = host().snapshot().team; return team.rounds[roundId]!.seats.map(id => team.seats[id]!); }

it('creates 3 Bots and a room atomically; waits for real persona readback; uses mention-only result-document speech', async () => {
  const held = new Promise<void>(resolve => { releaseProjection = resolve; });
  fixture = await openTeam({ holdProjection: () => held });
  const { profiles, room } = await createTeam();
  expect(profiles).toHaveLength(3);
  expect(room.mode).toBe('mention');
  expect(host().snapshot().team.homeOperations.every(o => o.status === 'pending')).toBe(true);
  const noMention = await host().roomInput('body-only', room.id, '@all @Bot 1 [PASS]');
  expect(seats(noMention)).toEqual([]);
  const round = await host().roomInput('mention', room.id, 'Review this', [profiles[1]!.id]);
  expect(seats(round)).toHaveLength(1);
  const seat = seats(round)[0]!;
  expect(host().core.intent(seat.id)).toBeUndefined();
  expect(fixture.adapter.starts).toHaveLength(1);
  releaseProjection!(); await ready(profiles);
  const session = await running(seat.id);
  const offer = await fixture.server.tasks.offer(host().core.intent(seat.id)!.taskId);
  expect(offer?.payload).not.toHaveProperty('messageEgress');
  expect(offer?.payload).not.toHaveProperty('sessionRef');
  expect(offer?.payload).toMatchObject({ agentRef: { agentId: profiles[1]!.id, profileRevision: '1' } });
  if (!offer || !('instruction' in offer.payload)) throw new Error('Missing fresh offer');
  expect(offer.payload.instruction).toContain('State the evidence.');
  expect(offer.payload.instruction).toContain('Review room');
  expect(await readFile(join(fixture.root, 'homes', 'agents', profiles[1]!.id, 'AGENTS.md'), 'utf8')).toBe('Persona 2');
  session.finish({ speech: { kind: 'post', text: 'Review complete. @Bot 3' } });
  await vi.waitFor(async () => { await host().drain(); expect(seats(round)[0]?.status).toBe('post'); }, { timeout: 5000 });
  await host().roomInput('mention', room.id, 'Review this', [profiles[1]!.id]);
  await fixture.reopen();
  const team = host().snapshot().team;
  expect(team.rooms[room.id]!.messages.filter(m => m.id === seat.id)).toHaveLength(1);
  expect(Object.values(team.seats).map(s => s.botId)).toEqual([profiles[1]!.id]);
  expect(fixture.adapter.starts).toHaveLength(2);
  expect(team.homeOperations.every(o => o.status === 'applied')).toBe(true);
});

it('queues structured room_call seats; distinguishes explicit pass, blank post, failure, and missing outcome', async () => {
  fixture = await openTeam();
  const { profiles, room } = await createTeam(); await ready(profiles);
  const round = await host().roomInput('speak', room.id, 'Discuss', [profiles[0]!.id]);
  await finish(seats(round)[0]!.id, { speech: { kind: 'pass' }, room_call: { members: [profiles[1]!.id, profiles[2]!.id] } });
  expect(seats(round)[0]!.status).toBe('pass');
  await finish(seats(round)[1]!.id, { speech: { kind: 'post', text: '   ' } });
  expect(seats(round)[1]!.status).toBe('failed');
  (await running(seats(round)[2]!.id)).fail();
  await vi.waitFor(async () => { await host().drain(); expect(seats(round)[2]!.status).toBe('failed'); }, { timeout: 5000 });
  const missing = await host().roomInput('missing', room.id, 'Respond', [profiles[1]!.id]);
  (await running(seats(missing)[0]!.id)).finish({}, false);
  await vi.waitFor(async () => { await host().drain(); expect(seats(missing)[0]!.status).toBe('failed'); }, { timeout: 5000 });
  expect(host().snapshot().team.rooms[room.id]!.messages.filter(m => m.from !== 'user')).toEqual([]);
});

it('continues after running grace, keeps the writer in FIFO, and writes a late terminal only once across recovery', async () => {
  let now = Date.now(); fixture = await openTeam({ now: () => now });
  const { profiles, room } = await createTeam(); await ready(profiles);
  const round = await host().roomInput('late', room.id, 'Review', [profiles[0]!.id, profiles[1]!.id]);
  const first = seats(round)[0]!, second = seats(round)[1]!;
  await running(first.id);
  await vi.waitFor(async () => { await host().drain(); expect(fixture.ledger.snapshot().executions[host().core.intent(first.id)!.taskId]?.started).toBe(true); }, { timeout: 5000 });
  now += ROOM_GRACE_MS;
  await host().drain(); await running(second.id);
  expect(seats(round)[0]).toMatchObject({ status: 'late', released: true });
  const own = await host().input('own-after-late', 'Own conversation', profiles[0]!.id);
  expect(host().core.intent(own)?.phase).toBe('queued');
  expect(fixture.adapter.sessions.has(host().core.intent(own)!.taskId)).toBe(false);
  await finish(second.id, { speech: { kind: 'pass' } });
  await finish(first.id, { speech: { kind: 'post', text: 'Late evidence' } });
  await finish(own);
  await fixture.reopen(); await host().recover();
  expect(host().snapshot().team.rooms[room.id]!.messages.filter(m => m.id === first.id)).toEqual([
    { id: first.id, from: profiles[0]!.id, text: 'Late evidence', late: true },
  ]);
});

it('skips a queued busy member without starting it, then runs the next selected member', async () => {
  let now = Date.now(); fixture = await openTeam({ now: () => now });
  const { profiles, room } = await createTeam(); await ready(profiles);
  const own = await host().input('busy-own', 'Keep working', profiles[0]!.id); await running(own);
  const round = await host().roomInput('busy-room', room.id, 'Review', [profiles[0]!.id, profiles[1]!.id]);
  const first = seats(round)[0]!, second = seats(round)[1]!;
  expect(host().core.intent(first.id)?.phase).toBe('queued');
  now += ROOM_GRACE_MS; await host().drain();
  expect(seats(round)[0]!.status).toBe('busy');
  expect(host().core.intent(first.id)?.conclusion).toBe('cancelled');
  await finish(second.id, { speech: { kind: 'pass' } }); await finish(own);
  expect(fixture.adapter.sessions.has(host().core.intent(first.id)!.taskId)).toBe(false);
});

it('invalidates waiting seats and audits running results after member removal', async () => {
  fixture = await openTeam();
  const { profiles, room } = await createTeam(); await ready(profiles);
  const round = await host().roomInput('remove', room.id, 'Discuss', profiles.map(b => b.id));
  const first = seats(round)[0]!; await running(first.id);
  await host().updateRoom(room.id, { members: [profiles[2]!.id] });
  expect(seats(round).slice(0, 2).every(s => s.status === 'removed')).toBe(true);
  expect(host().core.intent(seats(round)[1]!.id)).toBeUndefined();
  await finish(seats(round)[2]!.id, { speech: { kind: 'post', text: 'Still a member' } });
  await finish(first.id, { speech: { kind: 'post', text: 'Removed member result' } });
  expect(host().snapshot().audit).toContain(`Outcome audit only: ${host().core.intent(first.id)!.taskId}`);
  expect(host().snapshot().team.rooms[room.id]!.messages.some(m => m.text === 'Removed member result')).toBe(false);
});

it('freezes old profiles, applies update_bot and update_room, and archives delete_bot without deleting home', async () => {
  fixture = await openTeam();
  const { profiles, room } = await createTeam(); await ready(profiles);
  const old = await host().input('old-profile', 'Old profile execution', profiles[0]!.id); await running(old);
  const update = await host().input('update', 'Update the Bot and room');
  await finish(update, { update_bot: [{ botId: profiles[0]!.id, name: 'Updated Bot', persona: 'Updated persona' }],
    update_room: [{ roomId: room.id, announcement: 'New announcement', members: profiles.map(b => b.id) }],
  });
  const next = await host().input('new-profile', 'Next execution', profiles[0]!.id);
  expect(host().core.intent(old)?.execution.payload.agentRef.profileRevision).toBe('1');
  expect(host().core.intent(next)).toBeUndefined();
  await finish(old); await ready(profiles);
  await running(next);
  expect(host().core.intent(next)?.execution.payload.agentRef.profileRevision).toBe('2');
  expect(await readFile(join(fixture.root, 'homes', 'agents', profiles[0]!.id, 'AGENTS.md'), 'utf8')).toBe('Updated persona');
  expect(host().snapshot().team.rooms[room.id]!.announcement).toBe('New announcement');
  const queued = await host().input('to-archive', 'Must not execute', profiles[0]!.id);
  const remove = await host().input('delete', 'Archive the Bot');
  await finish(remove, { delete_bot: [{ botId: profiles[0]!.id }] });
  expect(host().snapshot().team.bots[profiles[0]!.id]!.archived).toBe(true);
  expect(host().core.intent(queued)?.conclusion).toBe('cancelled');
  await finish(next);
  expect(fixture.adapter.sessions.has(host().core.intent(queued)!.taskId)).toBe(false);
  expect((await stat(join(fixture.root, 'homes', 'agents', profiles[0]!.id))).isDirectory()).toBe(true);
  await expect(host().input('archived', 'No', profiles[0]!.id)).rejects.toThrow('archived');
});

it('rechecks Main Bot role at terminal apply and blocks over-budget context without truncation', async () => {
  fixture = await openTeam();
  const stale = await host().input('stale-main', 'Write a note'); await running(stale);
  await host().setMainBot('main', false);
  await finish(stale, { team_note: { text: 'No authority now' } });
  expect(host().snapshot().team.notes).toEqual([]);
  expect(host().snapshot().rejected).toContainEqual(expect.objectContaining({ action: 'team_note', reason: 'Main Bot role required' }));
  await host().setMainBot('main', true);
  const { profiles, room } = await createTeam(); await ready(profiles);
  fixture.ledger.transaction(s => { stateOf(s.application).team.rooms[room.id]!.messages = Array.from({ length: 100 }, (_, i) => ({ id: String(i), from: 'user', text: 'History', late: false })); });
  const blocked = await host().roomInput('over-context', room.id, 'This makes 101 entries', [profiles[1]!.id]);
  expect(seats(blocked)[0]).toMatchObject({ status: 'blocked', reason: 'Room ContextPack exceeds 100 entries' });
  expect(host().core.intent(seats(blocked)[0]!.id)).toBeUndefined();
  expect(host().snapshot().team.rooms[room.id]!.messages).toHaveLength(101);
});
