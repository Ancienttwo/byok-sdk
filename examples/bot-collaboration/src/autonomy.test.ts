import { afterEach, expect, it, vi } from 'vitest';
import { openTeam, type TestTeam } from './team.test-support';
import { botRoutines } from './routines';

let fixture: TestTeam;
afterEach(async () => { await fixture?.close(); });
const host = () => fixture.host;
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
async function createTeam() {
  const id = await host().input('create-team', 'Create three Bots and one room');
  await finish(id, { create_bot: [1, 2, 3].map(i => ({ localId: `new_bot_${i}`, name: `Bot ${i}`, role: 'Reviewer', persona: `Persona ${i}`, model: 'default' })),
    create_room: [{ localId: 'new_room_1', name: 'Review room', members: ['new_bot_1', 'new_bot_2', 'new_bot_3'], admin: 'new_bot_1' }] });
  const profiles = Object.values(host().snapshot().team.bots).filter(bot => bot.id !== 'main');
  const room = Object.values(host().snapshot().team.rooms)[0]!;
  await vi.waitFor(async () => {
    await host().drain();
    for (const profile of profiles) expect(host().snapshot().team.bots[profile.id]?.readyRevision).toBe(host().snapshot().team.bots[profile.id]?.revision);
  }, { timeout: 5000 });
  return { profiles, room };
}
const routine = (prompt: string) => ({ localId: 'new_routine_1', schedule: { hour: 9, minute: 0, tz: 'UTC' }, prompt });
const projections = () => Object.values(fixture.ledger.snapshot().outbox).filter(row => row.kind === 'projection');

it('starts a new Bot in observe: a routine outcome is recorded, with no routine, wake or replay after the owner switches to auto', async () => {
  fixture = await openTeam({ mainAutonomy: 'observe' });
  expect(host().autonomy('main')).toBe('observe');
  const root = await host().input('routine', 'Create my daily routine');
  await finish(root, { create_routine: [routine('Daily report')] });
  const taskId = host().core.intent(root)!.taskId;
  expect(host().wouldDoRecords('main')).toEqual([expect.objectContaining({ botId: 'main', taskId, action: 'create_routine', index: 0, detail: routine('Daily report') })]);
  expect(botRoutines(Object.values(fixture.ledger.snapshot().routines))).toEqual([]);
  expect(Object.values(fixture.ledger.snapshot().outbox).filter(row => row.kind === 'schedule' || row.kind === 'cancel-wake')).toEqual([]);
  // The Host UI feed: one projection per would-do row.
  expect(projections()).toContainEqual(expect.objectContaining({ id: expect.stringMatching(/^would-do:/), value: expect.objectContaining({ action: 'create_routine' }) }));
  await host().setBotAutonomy('main', 'auto');
  expect(host().autonomy('main')).toBe('auto');
  expect(projections()).toContainEqual(expect.objectContaining({ id: expect.stringMatching(/^bot-autonomy:main:/), value: expect.objectContaining({ autonomy: 'auto' }) }));
  // Switching does not replay the observe record.
  expect(host().wouldDoRecords()).toHaveLength(1);
  expect(botRoutines(Object.values(fixture.ledger.snapshot().routines))).toEqual([]);
  const next = await host().input('routine-2', 'Create another routine');
  await finish(next, { create_routine: [routine('Weekly report')] });
  expect(botRoutines(Object.values(fixture.ledger.snapshot().routines)).map(row => row.definition.prompt)).toEqual(['Weekly report']);
  expect(host().wouldDoRecords()).toHaveLength(1);
});

it('lets only the owner switch a Bot, and refuses an unknown Bot', async () => {
  fixture = await openTeam({ mainAutonomy: 'observe' });
  await expect(host().setBotAutonomy('main', 'auto', { id: 'intruder', kind: 'human' })).rejects.toThrow('not_owner');
  await expect(host().setBotAutonomy('main', 'auto', { id: '', kind: 'human' })).rejects.toThrow('unverified_sender');
  await expect(host().setBotAutonomy('missing', 'auto')).rejects.toThrow('archived or absent');
  expect(() => host().autonomy('missing')).toThrow('Bot not found');
  expect(host().autonomy('main')).toBe('observe');
});

it('creates a new Bot in observe, and its cross-Bot delegate and routine are recorded instead of applied', async () => {
  fixture = await openTeam({ mainAutonomy: 'observe' });
  const { profiles } = await createTeam();
  const reviewer = profiles.find(profile => host().snapshot().team.bots[profile.id]?.mainBot === false)!;
  for (const profile of profiles) expect(profile.autonomy).toBe('observe');
  await host().setBotAutonomy('main', 'auto');
  const root = await host().input('delegate', 'Ask the reviewer');
  await finish(root, { delegate: [{ to: reviewer.id, request: 'Plan the report' }] });
  const delegation = Object.values(host().snapshot().delegations)[0]!;
  expect(delegation.toBotId).toBe(reviewer.id);
  const taskId = host().core.intent(delegation.requestTurnId!)!.taskId;
  await finish(delegation.requestTurnId!, { create_routine: [routine('Reviewer report')], delegate: [{ to: 'main', request: 'Report back' }] });
  // One transaction records both rows; the read order of one instant is the stable row id, so compare as a set.
  expect(host().wouldDoRecords(reviewer.id)).toHaveLength(2);
  expect(host().wouldDoRecords(reviewer.id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ taskId, action: 'create_routine', detail: routine('Reviewer report') }),
    expect.objectContaining({ taskId, action: 'delegate', index: 0, detail: { to: 'main', request: 'Report back' } }),
  ]));
  // No routine, no second delegation, no bot_request Turn back to the Main Bot.
  expect(botRoutines(Object.values(fixture.ledger.snapshot().routines))).toEqual([]);
  expect(Object.values(host().snapshot().delegations)).toHaveLength(1);
  expect(Object.values(host().snapshot().turns).filter(turn => turn.source === 'bot_request')).toHaveLength(1);
  // In auto the same Bot applies its next outcome.
  await host().setBotAutonomy(reviewer.id, 'auto');
  expect(host().wouldDoRecords(reviewer.id)).toHaveLength(2);
  const again = await host().input('delegate-2', 'Ask again');
  await finish(again, { delegate: [{ to: reviewer.id, request: 'Plan again' }] });
  const second = Object.values(host().snapshot().delegations).find(row => row.id !== delegation.id)!;
  await finish(second.requestTurnId!, { create_routine: [routine('Applied report')] });
  expect(botRoutines(Object.values(fixture.ledger.snapshot().routines)).map(row => row.definition.prompt)).toEqual(['Applied report']);
  expect(host().wouldDoRecords(reviewer.id)).toHaveLength(2);
});

it('records an observing seat room_call without a new seat, and applies one after the owner switches it to auto', async () => {
  fixture = await openTeam({ mainAutonomy: 'observe' });
  const { profiles, room } = await createTeam();
  const speaker = profiles[0]!, other = profiles[1]!;
  const round = await host().roomInput('speak', room.id, 'Discuss', [speaker.id]);
  const seat = host().snapshot().team.rounds[round]!.seats[0]!;
  await finish(seat, { speech: { kind: 'pass' }, room_call: { members: [other.id] } });
  expect(host().wouldDoRecords(speaker.id)).toEqual([expect.objectContaining({ action: 'room_call', detail: { members: [other.id] } })]);
  expect(Object.keys(host().snapshot().team.rounds)).toHaveLength(1);
  expect(Object.values(host().snapshot().team.seats)).toHaveLength(1);
  expect(host().snapshot().team.seats[seat]!.status).toBe('pass');
  await host().setBotAutonomy(speaker.id, 'auto');
  const second = await host().roomInput('speak-2', room.id, 'Discuss again', [speaker.id]);
  await finish(host().snapshot().team.rounds[second]!.seats[0]!, { speech: { kind: 'pass' }, room_call: { members: [other.id] } });
  expect(Object.keys(host().snapshot().team.rounds)).toHaveLength(2);
  expect(Object.values(host().snapshot().team.seats).map(row => row.botId)).toContain(other.id);
  expect(host().wouldDoRecords(speaker.id)).toHaveLength(1);
});

it('keeps messageEgress, confirmable_action and ask_user outside the autonomy gate', async () => {
  fixture = await openTeam({ routeMessages: true, mainAutonomy: 'observe' });
  const root = await host().input('effects', 'Send and ask');
  await finish(root, { confirmable_action: [{ action: 'send_message', summary: 'Send', draft: { text: 'Hello' } }],
    ask_user: { question: 'Go on?', answerKind: 'text' } });
  expect(Object.values(host().snapshot().cards)).toHaveLength(1);
  expect(Object.values(host().snapshot().questions)).toHaveLength(1);
  expect(host().wouldDoRecords()).toEqual([]);
});