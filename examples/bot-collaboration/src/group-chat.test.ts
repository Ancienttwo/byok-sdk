import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openTeam, type TestTeam } from './team.test-support';
import { ROOM_GRACE_MS } from './rooms';
import { stateOf } from './model';
import { HostLedger, MIN_TOMBSTONE_RETENTION_MS } from '@byok-sdk/example-host-execution-core';
import { HISTORY_MAX_BYTES } from './history';
import type { BotProfile } from './team-model';

// Hints are an optimization. The real mailbox and HTTP poll remain authoritative.
const wakeFault = vi.hoisted(() => ({ dropHints: false, dropped: 0 }));
vi.mock('@byok-sdk/cloud', async importOriginal => {
  const actual = await importOriginal<typeof import('@byok-sdk/cloud')>();
  return { ...actual, createInProcessMailboxWake: (...args: Parameters<typeof actual.createInProcessMailboxWake>) => {
    const wake = actual.createInProcessMailboxWake(...args);
    return { ...wake, appended(...input: Parameters<typeof wake.appended>) {
      if (wakeFault.dropHints) wakeFault.dropped++;
      else wake.appended(...input);
    } };
  } };
});

let fixture: TestTeam;
let releaseProjection: (() => void) | undefined;
afterEach(async () => { wakeFault.dropHints = false; wakeFault.dropped = 0; releaseProjection?.(); releaseProjection = undefined; await fixture?.close(); });
const host = () => fixture.host;
async function running(id: string) {
  // Commands and the connected wake consumer already advance the Host. Repeated
  // reconciliation while observing daemon startup blocks its filesystem work.
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

it('releases the seat of a room Turn whose intent a writer without the veto compacted, and runs the next seat', async () => {
  let now = Date.now(); fixture = await openTeam({ now: () => now });
  const { profiles, room } = await createTeam(); await ready(profiles);
  const round = await host().roomInput('retired-seat', room.id, 'Review', [profiles[0]!.id, profiles[1]!.id]);
  const first = seats(round)[0]!, second = seats(round)[1]!;
  // K4 settles the seat intent outside a K8 pass, and a maintenance writer without the veto compacts it.
  await host().core.cancel(first.id);
  await host().core.flushProjections(async () => {});
  const other = new HostLedger(join(fixture.root, 'host.sqlite'), fixture.ledger.tenant);
  try {
    expect(other.compact({ acknowledgedIntentKeys: [first.id], now, tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS })).toMatchObject({ compactedIntents: 1 });
  } finally { other.close(); }
  await host().drain();
  expect(seats(round)[0]).toMatchObject({ status: 'failed', released: true, reason: 'result_retired' });
  expect(host().snapshot().turns[first.id]).toMatchObject({ status: 'failed', conclusion: 'failed', reported: true });
  // The next seat starts without waiting for the room grace.
  expect(host().core.intent(second.id)).toBeDefined();
  await finish(second.id, { speech: { kind: 'pass' } });
  expect(host().snapshot().team.rounds[round]!.closed).toBe(true);
  expect(host().snapshot().turns[first.id]!.conclusion).toBe('failed');
});

it('invalidates waiting seats and audits running results after member removal', async () => {
  fixture = await openTeam();
  const { profiles, room } = await createTeam(); await ready(profiles);
  const round = await host().roomInput('remove', room.id, 'Discuss', profiles.map(b => b.id));
  const first = seats(round)[0]!; await running(first.id);
  await vi.waitFor(async () => { await host().drain(); expect(fixture.ledger.snapshot().executions[host().core.intent(first.id)!.taskId]?.started).toBe(true); }, { timeout: 5000 });
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

it('rechecks Main Bot role and lets a seat speak after history selection adds a truncation notice', async () => {
  fixture = await openTeam();
  const stale = await host().input('stale-main', 'Write a note'); await running(stale);
  await host().setMainBot('main', false);
  await finish(stale, { team_note: { text: 'No authority now' } });
  expect(host().snapshot().team.notes).toEqual([]);
  expect(host().snapshot().rejected).toContainEqual(expect.objectContaining({ action: 'team_note', reason: 'Main Bot role required' }));
  await host().setMainBot('main', true);
  const { profiles, room } = await createTeam(); await ready(profiles);
  fixture.ledger.transaction(s => { stateOf(s.application).team.rooms[room.id]!.messages = Array.from({ length: 100 }, (_, i) => ({ id: String(i), from: 'user', text: 'History', late: false })); });
  const round = await host().roomInput('over-context', room.id, 'This makes 101 entries', [profiles[1]!.id]);
  const seat = seats(round)[0]!;
  await running(seat.id);
  expect(host().snapshot().turns[seat.id]).not.toHaveProperty('blockedReason');
  const offer = await fixture.server.tasks.offer(host().core.intent(seat.id)!.taskId);
  if (!offer || !('instruction' in offer.payload) || typeof offer.payload.instruction !== 'string') throw new Error('Missing room offer');
  const context = JSON.parse(offer.payload.instruction.split('ContextPack:\n')[1]!);
  expect(context.room.messages).toHaveLength(100);
  expect(context.room.messages[0].id).toBe('1');
  expect(context.room.messages.at(-1).text).toBe('This makes 101 entries');
  expect(context.historyWindow.omittedMessages).toBe(1);
  expect(context.historyWindow.notice).toContain('Earlier history was omitted');
  expect(host().snapshot().team.rooms[room.id]!.messages).toHaveLength(101);
  await finish(seat.id, { speech: { kind: 'post', text: 'I can speak after history selection.' } });
  expect(seats(round)[0]!.status).toBe('post');
  expect(host().snapshot().team.rooms[room.id]!.messages.at(-1)!.text).toBe('I can speak after history selection.');
});

it.each(['failure', 'missing outcome', 'cancellation'] as const)('settles a running late seat after real SDK %s without writing a post', async cause => {
  let now = Date.now(); fixture = await openTeam({ now: () => now });
  const { profiles, room } = await createTeam(); await ready(profiles);
  const round = await host().roomInput('late-terminal', room.id, 'Review', [profiles[0]!.id, profiles[1]!.id]);
  const first = seats(round)[0]!, second = seats(round)[1]!;
  const session = await running(first.id);
  await vi.waitFor(async () => { await host().drain(); expect(seats(round)[0]!.startedAt).toBe(now); }, { timeout: 5000 });
  now += ROOM_GRACE_MS; await host().drain();
  expect(seats(round)[0]!.status).toBe('late'); await running(second.id);
  if (cause === 'failure') session.fail();
  else if (cause === 'missing outcome') session.finish({}, false);
  else await host().cancelTurn(first.id);
  await vi.waitFor(async () => { await host().drain(); expect(seats(round)[0]!.status).toBe('failed'); }, { timeout: 5000 });
  expect(seats(round)[0]!.reason).toBe(cause === 'cancellation' ? 'cancelled' : 'failed');
  await finish(second.id, { speech: { kind: 'pass' } });
  await fixture.reopen();
  expect(seats(round)[0]!.status).toBe('failed');
  expect(host().snapshot().team.rooms[room.id]!.messages.some(m => m.id === first.id)).toBe(false);
});

it('keeps background messages, persists join visibility, and freezes each selected history window', async () => {
  fixture = await openTeam();
  const { profiles, room } = await createTeam(); await ready(profiles);
  const late = profiles[2]!;
  await host().updateRoom(room.id, { members: profiles.slice(0, 2).map(b => b.id) });
  const before = await host().roomInput('pre-join', room.id, 'PRE-JOIN-SECRET', []);
  expect(seats(before)).toEqual([]);
  const join = await host().input('join-member', 'Add the member');
  await finish(join, { update_room: [{ roomId: room.id, members: profiles.map(b => b.id) }] });
  const background = await host().roomInput('after-join', room.id, 'Visible background after join', []);
  expect(seats(background)).toEqual([]);
  expect(fixture.adapter.starts).toHaveLength(2);
  await fixture.reopen();
  const round = await host().roomInput('late-request', room.id, 'Current visible request', [late.id]);
  const seat = seats(round)[0]!; await running(seat.id);
  const offer = await fixture.server.tasks.offer(host().core.intent(seat.id)!.taskId);
  if (!offer || !('instruction' in offer.payload) || typeof offer.payload.instruction !== 'string') throw new Error('Missing room offer');
  const frozen = offer.payload.instruction;
  const context = JSON.parse(frozen.split('ContextPack:\n')[1]!);
  expect(context.room.messages.map((m: { text: string }) => m.text)).toEqual(['Visible background after join', 'Current visible request']);
  expect(frozen).not.toContain('PRE-JOIN-SECRET');
  await host().roomInput('later-background', room.id, 'Appended after the offer', []);
  expect((await fixture.server.tasks.offer(host().core.intent(seat.id)!.taskId))?.payload).toHaveProperty('instruction', frozen);
  await finish(seat.id, { speech: { kind: 'post', text: 'Visible reply' } });
  await host().updateRoom(room.id, { members: profiles.slice(0, 2).map(b => b.id) });
  await host().roomInput('absent', room.id, 'ABSENT-SECRET', []);
  await host().updateRoom(room.id, { members: profiles.map(b => b.id) });
  const rejoined = await host().roomInput('rejoined', room.id, 'After rejoin only', [late.id]);
  const next = seats(rejoined)[0]!; await running(next.id);
  const nextOffer = await fixture.server.tasks.offer(host().core.intent(next.id)!.taskId);
  if (!nextOffer || !('instruction' in nextOffer.payload) || typeof nextOffer.payload.instruction !== 'string') throw new Error('Missing rejoined offer');
  const nextContext = JSON.parse(nextOffer.payload.instruction.split('ContextPack:\n')[1]!);
  expect(nextContext.room.messages.map((m: { text: string }) => m.text)).toEqual(['After rejoin only']);
  expect(nextOffer.payload.instruction).not.toContain('ABSENT-SECRET');
  expect(nextOffer.payload.instruction).not.toContain('Visible background after join');
  await finish(next.id, { speech: { kind: 'pass' } });
});

it('blocks an over-limit current Unicode Request with a measured reason and no SDK offer', async () => {
  fixture = await openTeam();
  const { profiles, room } = await createTeam(); await ready(profiles);
  const request = '😀'.repeat(18000) + ' CURRENT-END';
  const round = await host().roomInput('over-limit-current', room.id, request, [profiles[0]!.id]);
  const seat = seats(round)[0]!;
  const turn = host().snapshot().turns[seat.id]!;
  const bytes = Buffer.byteLength(turn.request, 'utf8');
  expect(bytes).toBeGreaterThan(HISTORY_MAX_BYTES);
  const reason = `Current Request is ${bytes} UTF-8 bytes; budget is ${HISTORY_MAX_BYTES} bytes. Shorten the request and send it again.`;
  expect(turn.blockedReason).toBe(reason);
  expect(seat).toMatchObject({ status: 'blocked', released: true, reason });
  expect(host().core.intent(seat.id)).toBeUndefined();
  expect(fixture.adapter.starts).toHaveLength(1);
  expect(host().snapshot().team.rooms[room.id]!.messages.at(-1)!.text).toBe(request);
  expect(Object.values(fixture.ledger.snapshot().outbox)).toContainEqual(expect.objectContaining({
    kind: 'projection', id: `blocked:${seat.id}`, value: { owner: turn.botId, turnId: seat.id, reason },
  }));
});

it('runs every seat of a round whose seat Turns all block in one pass, so no waiting seat is left without a Turn', async () => {
  fixture = await openTeam();
  const { profiles: first } = await createTeam();
  // A Turn creates at most three Bots, so a second one adds a Bot and a room of all five, with the Main Bot.
  const more = await host().input('create-more', 'Create one more Bot and a room of five');
  await finish(more, { create_bot: [{ localId: 'new_bot_1', name: 'Bot 4', role: 'Reviewer', persona: 'Persona 4', model: 'default' }],
    create_room: [{ localId: 'new_room_1', name: 'Five', members: ['main', ...first.map(profile => profile.id), 'new_bot_1'] }] });
  const profiles = Object.values(host().snapshot().team.bots);
  const room = Object.values(host().snapshot().team.rooms).find(row => row.name === 'Five')!;
  expect(room.members).toHaveLength(5);
  await ready(profiles);
  // Each seat Turn blocks in its Turn step, which releases its seat. One pass of the Host syncs four times.
  const round = await host().roomInput('over-limit-all', room.id, '😀'.repeat(18000), profiles.map(profile => profile.id));
  expect(seats(round).map(seat => [seat.status, seat.released])).toEqual(profiles.map(() => ['blocked', true]));
  expect(host().snapshot().team.rounds[round]).toMatchObject({ closed: true });
});

it.each([false, true])('counts a large in-limit Unicode Request in the budget and still posts through the real SDK (lost wake hints: %s)', async dropHints => {
  wakeFault.dropHints = dropHints;
  fixture = await openTeam();
  const { profiles, room } = await createTeam(); await ready(profiles);
  await host().roomInput('large-background', room.id, 'Old '.repeat(20000), []);
  const request = '😀'.repeat(4096) + ' CURRENT-END';
  const round = await host().roomInput('large-current', room.id, request, [profiles[0]!.id]);
  const seat = seats(round)[0]!;
  const turn = host().snapshot().turns[seat.id]!;
  const offer = await fixture.server.tasks.offer(host().core.intent(seat.id)!.taskId);
  if (!offer || !('instruction' in offer.payload) || typeof offer.payload.instruction !== 'string') throw new Error('Missing room offer');
  const [requestSection, contextSection] = offer.payload.instruction.split('ContextPack:\n');
  expect(requestSection).toContain(request);
  const context = JSON.parse(contextSection!);
  expect(context.room.messages).toEqual([]);
  expect(context.historyWindow.notice).toContain('Earlier history was omitted');
  expect(context.historyWindow.omittedMessages).toBe(2);
  expect(context.historyWindow.currentRequestBytes).toBe(Buffer.byteLength(turn.request, 'utf8'));
  expect(Buffer.byteLength(contextSection!, 'utf8') + context.historyWindow.currentRequestBytes).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
  await running(seat.id);
  await finish(seat.id, { speech: { kind: 'post', text: 'The complete current request was available.' } });
  expect(seats(round)[0]!.status).toBe('post');
  if (dropHints) expect(wakeFault.dropped).toBeGreaterThan(0);
});

it('trims byte-heavy history and still posts for a normal current request', async () => {
  fixture = await openTeam();
  const { profiles, room } = await createTeam(); await ready(profiles);
  await host().roomInput('byte-heavy-background', room.id, '😀'.repeat(20000), []);
  const request = 'Answer the current small request';
  const round = await host().roomInput('byte-heavy-current', room.id, request, [profiles[1]!.id]);
  const seat = seats(round)[0]!;
  const offer = await fixture.server.tasks.offer(host().core.intent(seat.id)!.taskId);
  if (!offer || !('instruction' in offer.payload) || typeof offer.payload.instruction !== 'string') throw new Error('Missing room offer');
  const contextText = offer.payload.instruction.split('ContextPack:\n')[1]!;
  const context = JSON.parse(contextText);
  expect(context.room.messages.map((message: { text: string }) => message.text)).toEqual([request]);
  expect(context.historyWindow.omittedMessages).toBe(1);
  expect(context.historyWindow.notice).toContain('Earlier history was omitted');
  expect(Buffer.byteLength(contextText, 'utf8') + Buffer.byteLength(host().snapshot().turns[seat.id]!.request, 'utf8')).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
  expect(host().snapshot().turns[seat.id]).not.toHaveProperty('blockedReason');
  await finish(seat.id, { speech: { kind: 'post', text: 'The byte window still permits speech.' } });
  expect(seats(round)[0]!.status).toBe('post');
});
