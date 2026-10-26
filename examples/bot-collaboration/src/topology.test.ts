import { afterEach, expect, it, vi } from 'vitest';
import { hash, type IntentInput } from '@byok-sdk/example-host-execution-core';
import { openHost, template, type TestHost } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration, type BotOptions } from './host';
import { addTurn, stateOf } from './model';
import { CommitConflict } from './commit';
import { roomFields, updateBot } from './team';
import { deliverRoutine, routineOf, seedRoutine } from './routines.test-support';
import { botCompactVeto } from './compaction';
import { DeviceModeError, DeviceSwitchingError } from './topology';

// #957 (§4.1): L as the old owner of a device switch. The freeze, the refusals, the hold, the drain, commit and abort.
let fixture: TestHost | undefined;
let bot: BotCollaboration | undefined;
// The Host clock runs with real time plus a jump. A frozen clock would put K4's scan wake in the SDK's past, and the SDK
// would deliver it again at once, forever.
let offset = 0;
const now = () => Date.now() + offset;
afterEach(async () => { await bot?.close(); await fixture?.close(); bot = undefined; fixture = undefined; });
// The routine slot is at least 11 hours away, so no routine wake becomes due in the SDK during a test.
const schedule = { minute: 0, hour: (new Date().getUTCHours() + 12) % 24, tz: 'UTC' };
const OTHER = 'device-2';
let extra: Partial<BotOptions> = {};
/** The template can carry message egress, so a Bot outcome can offer a card (as in `acceptance.test.ts`). */
function options(): BotOptions {
  const base = template(fixture!.deviceId);
  return { botId: 'main', execution: { ...base, agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'topology' },
    payload: { ...base.payload, messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65536 } } },
  connector: async () => null, now, hostIntents: { research: () => {} }, ...extra };
}
async function setup(rest: Partial<BotOptions> = {}): Promise<BotCollaboration> {
  offset = 0; extra = rest;
  fixture = await openHost({ externalCore: true, ledgerOptions: { compactVeto: botCompactVeto }, consume: (wake, signal) => bot!.consume(wake, signal),
    agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
  bot = new BotCollaboration(fixture.server, fixture.ledger, options());
  // A second Bot on another device, and a room with both Bots.
  fixture.ledger.transaction(s => {
    const team = stateOf(s.application).team;
    team.bots.b = { ...structuredClone(team.bots.main!), id: 'b', name: 'B', mainBot: false, execution: template(OTHER, 'b') };
    team.rooms.room = { id: 'room', ...roomFields(team, { name: 'Room', members: ['main', 'b'] }), messages: [] };
  });
  return bot;
}
const device = () => fixture!.deviceId;
/** A Turn that a path the freeze does not refuse adds, such as a Bot outcome that delegates. */
const seedTurn = (id: string, botId = 'main') => fixture!.ledger.transaction(s => {
  addTurn(stateOf(s.application), { id, root: id, source: 'user', request: 'work', botId, hop: 0, authority: 'owner' });
});
const hostInput = (key: string, deviceId: string): IntentInput => ({ key, source: 'user', execution: template(deviceId, 'research'), waitUntil: now() + 600_000 });
const stored = () => JSON.stringify(fixture!.ledger.snapshot());
async function running(id: string) {
  await vi.waitFor(async () => {
    await bot!.drain();
    expect(fixture!.ledger.snapshot().executions[bot!.core.intent(id)!.taskId]?.started).toBe(true);
  }, { timeout: 5000 });
  return fixture!.adapter.sessions.get(bot!.core.intent(id)!.taskId)!;
}
async function finish(id: string, document: unknown = {}) {
  (await running(id)).finish(document);
  await vi.waitFor(async () => { await bot!.drain(); expect(bot!.snapshot().turns[id]?.status).toBe('succeeded'); }, { timeout: 5000 });
}
const empty = { intents: [], turns: [], batches: [], homeOperations: [] };
/** A commit that the device checks refuse first, so it names no export (#975). */
const NO_EXPORT = 'no-export';
/**
 * #975: the commit away needs the receipt of an export of the whole domain, so the other Bot's device is frozen and drained
 * too. Returns the export's digest, which the new owner's receipt carries.
 */
async function exportDomain(): Promise<string> {
  if (!bot!.topology(OTHER).switching) await bot!.freezeForSwitch(OTHER, 0);
  await vi.waitFor(async () => {
    await bot!.drainForSwitch(OTHER, { cancel: true });
    expect(await bot!.drainForSwitch(OTHER)).toEqual(empty);
  }, { timeout: 5000 });
  await bot!.drain();
  // The format moves no projection, so the old owner uploads them first.
  await bot!.core.flushProjections(async () => {});
  const document = await bot!.exportForSwitch([{ deviceId: device(), expectedRevision: 1 }, { deviceId: OTHER, expectedRevision: 1 }]);
  return document.manifest.digest;
}

it('freezes one device on the expected revision, reads the record back, and refuses a stale or second freeze', async () => {
  await setup();
  expect(bot!.topology(device())).toEqual({ mode: 'L', revision: 0 });
  expect(await bot!.freezeForSwitch(device(), 0)).toEqual({ mode: 'L', revision: 1, switching: 'H' });
  expect(stateOf(fixture!.ledger.snapshot().application).topology).toEqual({ [device()]: { mode: 'L', revision: 1, switching: 'H' } });
  const before = stored();
  await expect(bot!.freezeForSwitch(device(), 0)).rejects.toMatchObject({ code: 'stale_revision' });
  await expect(bot!.freezeForSwitch(device(), 0)).rejects.toBeInstanceOf(CommitConflict);
  await expect(bot!.freezeForSwitch(device(), 1)).rejects.toThrow('already switching');
  expect(stored()).toBe(before);
  // The other device keeps its default record.
  expect(bot!.topology(OTHER)).toEqual({ mode: 'L', revision: 0 });
  // A device id is stored as an own key, whatever its text.
  expect(await bot!.freezeForSwitch('__proto__', 0)).toEqual({ mode: 'L', revision: 1, switching: 'H' });
  expect(bot!.topology('constructor')).toEqual({ mode: 'L', revision: 0 });
  expect(Object.keys(stateOf(fixture!.ledger.snapshot().application).topology!)).toEqual([device(), '__proto__']);
});

it('refuses each entry that can create execution on the frozen device with device_switching, and writes nothing', async () => {
  await setup();
  await bot!.freezeForSwitch(device(), 0);
  const before = stored();
  const refusal = { code: 'device_switching', deviceId: device(), target: 'H', revision: 1 };
  await expect(bot!.input('k1', 'hello')).rejects.toMatchObject(refusal);
  await expect(bot!.input('k1', 'hello')).rejects.toBeInstanceOf(DeviceSwitchingError);
  await expect(bot!.receive({ channel: 'fake', platformMessageId: 'm1', conversation: { kind: 'direct', id: 'main' },
    sender: { id: 'owner', kind: 'human' }, text: 'hello', mentions: [] })).rejects.toMatchObject(refusal);
  // A room input can seat any Bot member, so one member on the frozen device refuses it.
  await expect(bot!.roomInput('r1', 'room', 'hello')).rejects.toMatchObject(refusal);
  await expect(bot!.enqueueHostIntent(hostInput('host-1', device()), 'research')).rejects.toMatchObject(refusal);
  expect(stored()).toBe(before);
  // Work on the other device still starts.
  await bot!.enqueueHostIntent(hostInput('host-2', OTHER), 'research');
  expect(bot!.core.intent('host-2')).toMatchObject({ execution: { deviceId: OTHER } });
  const turn = await bot!.input('k2', 'hello', 'b');
  expect(bot!.core.intent(turn)).toMatchObject({ execution: { deviceId: OTHER } });
});

it('holds a Turn that reaches the sync during the freeze, ends the pass, and runs it after the abort', async () => {
  await setup();
  await bot!.freezeForSwitch(device(), 0);
  seedTurn('t1');
  // A held Turn does not await an offer, so the pass ends.
  await bot!.drain();
  expect(bot!.snapshot().turns.t1).toMatchObject({ held: 'device_switching', status: 'queued' });
  expect(bot!.core.intent('t1')).toBeUndefined();
  expect(fixture!.ledger.snapshot().outbox[`projection:${hash('held-switching:t1')}`])
    .toMatchObject({ value: { owner: 'main', turnId: 't1', code: 'device_switching' } });
  expect(bot!.snapshot().audit).toContain('Turn held device_switching switching: t1');
  await expect(bot!.abortSwitch(device(), 0)).rejects.toMatchObject({ code: 'stale_revision' });
  expect(await bot!.abortSwitch(device(), 1)).toEqual({ mode: 'L', revision: 2 });
  expect(bot!.snapshot().turns.t1!.held).toBeUndefined();
  expect(bot!.core.intent('t1')).toBeDefined();
  await bot!.input('k1', 'hello');
});

it('refuses a routine slot during the freeze so K4 records nothing, and runs the slot after the abort', async () => {
  await setup();
  const id = await seedRoutine(bot!, 'task-1', 'report', schedule);
  await bot!.freezeForSwitch(device(), 0);
  const slot = routineOf(bot!, id).next!;
  offset = slot.availableAt - Date.now();
  await expect(deliverRoutine(bot!, id, now())).rejects.toBeInstanceOf(DeviceSwitchingError);
  expect(Object.values(fixture!.ledger.snapshot().occurrences)).toEqual([]);
  expect(Object.values(bot!.snapshot().turns).filter(turn => turn.source === 'routine')).toEqual([]);
  expect(routineOf(bot!, id).next).toEqual(slot);
  await bot!.abortSwitch(device(), 1);
  await deliverRoutine(bot!, id, now(), 2);
  expect(Object.values(bot!.snapshot().turns).filter(turn => turn.source === 'routine')).toHaveLength(1);
});

it('sends no Agent home write for a Bot on the frozen device, and sends it after the abort', async () => {
  await setup();
  const enqueue = vi.spyOn(fixture!.server, 'enqueueAgentHomeProjection'), read = vi.spyOn(fixture!.server, 'readAgentHomeProjection');
  await bot!.freezeForSwitch(device(), 0);
  // A team change is not refused: it queues a persona write, as an applied snapshot does.
  fixture!.ledger.transaction(s => updateBot(stateOf(s.application), { botId: 'main', persona: 'New persona' }, { default: template(device()) }));
  await bot!.drain();
  // Nothing was sent, so nothing is read back.
  expect([enqueue.mock.calls.length, read.mock.calls.length]).toEqual([0, 0]);
  // A write that was never sent is not open work: it moves with the exported state.
  expect((await bot!.drainForSwitch(device())).homeOperations).toEqual([]);
  // A ledger written before the `sent` mark has only the retry time that a send sets.
  const [op] = bot!.snapshot().team.homeOperations.filter(row => row.status === 'pending');
  fixture!.ledger.transaction(s => { stateOf(s.application).team.homeOperations.find(row => row.sequence === op!.sequence)!.retryAt = now(); });
  expect((await bot!.drainForSwitch(device())).homeOperations).toEqual([op!.sequence]);
  fixture!.ledger.transaction(s => { delete stateOf(s.application).team.homeOperations.find(row => row.sequence === op!.sequence)!.retryAt; });
  await bot!.abortSwitch(device(), 1);
  expect(enqueue).toHaveBeenCalledTimes(1);
});

it('counts a home write whose send failed as sent, so the switch waits for its readback', async () => {
  await setup();
  // The server may have taken the write before the send failed.
  const enqueue = vi.spyOn(fixture!.server, 'enqueueAgentHomeProjection').mockRejectedValueOnce(new Error('connection reset'));
  fixture!.ledger.transaction(s => updateBot(stateOf(s.application), { botId: 'main', persona: 'New persona' }, { default: template(device()) }));
  await bot!.drain().catch(() => {});
  expect(enqueue).toHaveBeenCalledTimes(1);
  const [op] = bot!.snapshot().team.homeOperations.filter(row => row.status === 'pending');
  await bot!.freezeForSwitch(device(), 0);
  expect((await bot!.drainForSwitch(device(), { cancel: true })).homeOperations).toEqual([op!.sequence]);
  await expect(bot!.commitSwitch(device(), 1, NO_EXPORT)).rejects.toThrow('still has open work');
  expect(enqueue).toHaveBeenCalledTimes(1);
});

it('drains the device: lists and cancels its open work, keeps a tried intent until its terminal, then commits to H', async () => {
  await setup();
  const live = await bot!.input('k1', 'hello');
  const session = await running(live);
  await bot!.input('k2', 'hello', 'b');
  await bot!.freezeForSwitch(device(), 0);
  seedTurn('queued');
  await expect(bot!.drainForSwitch(OTHER)).rejects.toThrow('not switching');
  // The other device's work is not listed.
  expect(await bot!.drainForSwitch(device())).toEqual({ intents: [live], turns: ['queued'], batches: [], homeOperations: [] });
  await expect(bot!.commitSwitch(device(), 1, NO_EXPORT)).rejects.toThrow('still has open work');
  // The tried intent stays open after the cancel: only its terminal concludes it.
  expect(await bot!.drainForSwitch(device(), { cancel: true })).toEqual({ intents: [live], turns: [], batches: [], homeOperations: [] });
  expect(bot!.snapshot().turns.queued).toMatchObject({ status: 'failed', conclusion: 'cancelled' });
  await expect(bot!.commitSwitch(device(), 1, NO_EXPORT)).rejects.toThrow('still has open work');
  session.finish({});
  await vi.waitFor(async () => {
    await bot!.drain();
    expect(await bot!.drainForSwitch(device())).toEqual({ intents: [], turns: [], batches: [], homeOperations: [] });
  }, { timeout: 5000 });
  await expect(bot!.commitSwitch(device(), 0, NO_EXPORT)).rejects.toMatchObject({ code: 'stale_revision' });
  expect(await bot!.commitSwitch(device(), 1, await exportDomain())).toEqual({ mode: 'H', revision: 2 });
});

it('refuses the device for good after the commit, also in a new Host over the same ledger', async () => {
  await setup();
  await bot!.freezeForSwitch(device(), 0);
  await bot!.commitSwitch(device(), 1, await exportDomain());
  const owned = { code: 'device_not_bound', reason: 'mode', deviceId: device(), revision: 2 };
  await expect(bot!.input('k1', 'hello')).rejects.toMatchObject(owned);
  await expect(bot!.input('k1', 'hello')).rejects.toBeInstanceOf(DeviceModeError);
  await expect(bot!.freezeForSwitch(device(), 2)).rejects.toBeInstanceOf(DeviceModeError);
  await expect(bot!.abortSwitch(device(), 2)).rejects.toBeInstanceOf(DeviceModeError);
  await bot!.close();
  bot = new BotCollaboration(fixture!.server, fixture!.ledger, options());
  expect(bot.topology(device())).toEqual({ mode: 'H', revision: 2 });
  await expect(bot.input('k1', 'hello')).rejects.toMatchObject(owned);
  seedTurn('t1');
  // #975: the domain was exported, so the old owner runs no pass over it at all; it neither holds nor runs the Turn.
  const before = stored();
  await bot.drain();
  expect(stored()).toBe(before);
  expect(bot.core.intent('t1')).toBeUndefined();
});

it('refuses to open a ledger with a malformed topology record', async () => {
  await setup();
  await bot!.close();
  bot = undefined;
  fixture!.ledger.transaction(s => { stateOf(s.application).topology = { [device()]: { mode: 'H', revision: 1, switching: 'H' } }; });
  expect(() => new BotCollaboration(fixture!.server, fixture!.ledger, options())).toThrow(`Invalid topology record for device ${device()}`);
});

it('refuses an answer and a card decision for a Bot on the frozen device, and returns the first result of an exact replay', async () => {
  await setup();
  const root = await bot!.input('ask', 'Prepare a draft');
  await finish(root, { confirmable_action: [{ action: 'send_message', summary: 'Send', draft: { text: 'hello' } }],
    ask_user: { question: 'Continue?', answerKind: 'text' } });
  const card = Object.values(bot!.snapshot().cards)[0]!, question = Object.values(bot!.snapshot().questions)[0]!;
  const accepted = await bot!.input('before', 'hello');
  const zero = hostInput('host-0', device()), host = await bot!.enqueueHostIntent(zero, 'research');
  await bot!.freezeForSwitch(device(), 0);
  const before = stored();
  const refusal = { code: 'device_switching', deviceId: device() };
  await expect(bot!.answer(question.id, 'Yes')).rejects.toMatchObject(refusal);
  await expect(bot!.decide(card.id, 'confirmed')).rejects.toMatchObject(refusal);
  await expect(bot!.decide(card.id, 'rejected')).rejects.toMatchObject(refusal);
  expect(stored()).toBe(before);
  // A replay adds no work, so it keeps its first answer.
  expect(await bot!.input('before', 'hello')).toBe(accepted);
  expect(await bot!.enqueueHostIntent(zero, 'research')).toEqual(host);
});

it('receives no room input and no bot background for a room with a Bot member on the frozen device', async () => {
  await setup();
  await bot!.freezeForSwitch(OTHER, 0);
  const before = stored();
  const room = (platformMessageId: string, sender: { id: string; kind: 'human' | 'bot' }) => bot!.receive({ channel: 'fake', platformMessageId,
    conversation: { kind: 'group', id: 'room' }, sender, text: 'hello', mentions: [] });
  await expect(room('m1', { id: 'owner', kind: 'human' })).rejects.toMatchObject({ code: 'device_switching', deviceId: OTHER });
  await expect(room('m2', { id: 'peer', kind: 'bot' })).rejects.toMatchObject({ code: 'device_switching', deviceId: OTHER });
  expect(stored()).toBe(before);
});

it('keeps refusing and holding after a restart while frozen, and the new Host can abort', async () => {
  await setup();
  await bot!.freezeForSwitch(device(), 0);
  await bot!.close();
  bot = new BotCollaboration(fixture!.server, fixture!.ledger, options());
  expect(bot.topology(device())).toEqual({ mode: 'L', revision: 1, switching: 'H' });
  await expect(bot.input('k1', 'hello')).rejects.toBeInstanceOf(DeviceSwitchingError);
  seedTurn('t1');
  await bot.drain();
  expect(bot.snapshot().turns.t1).toMatchObject({ held: 'device_switching' });
  expect(bot.core.intent('t1')).toBeUndefined();
  await bot.abortSwitch(device(), 1);
  expect(bot.core.intent('t1')).toBeDefined();
});

it('holds the delegation Turn that a Bot outcome adds for a Bot on the frozen device', async () => {
  await setup();
  await bot!.freezeForSwitch(OTHER, 0);
  const root = await bot!.input('ask-b', 'Ask B');
  await finish(root, { delegate: [{ to: 'b', request: 'Check the totals' }] });
  const chain = Object.values(bot!.snapshot().turns).find(turn => turn.botId === 'b')!;
  expect(chain).toMatchObject({ source: 'bot_request', held: 'device_switching', status: 'queued' });
  expect(bot!.core.intent(chain.id)).toBeUndefined();
  expect((await bot!.drainForSwitch(OTHER)).turns).toEqual([chain.id]);
});

it('holds the next seat Turn of a room round for a Bot on the frozen device', async () => {
  await setup();
  const roundId = await bot!.roomInput('mention', 'room', 'Review this', ['main', 'b']);
  const round = bot!.snapshot().team.rounds[roundId]!;
  const [first, second] = round.seats.map(seat => bot!.snapshot().team.seats[seat]!);
  expect([first!.botId, second!.botId]).toEqual(['main', 'b']);
  await bot!.freezeForSwitch(OTHER, 0);
  await finish(first!.id, { speech: { kind: 'post', text: 'Done' } });
  expect(bot!.snapshot().turns[second!.id]).toMatchObject({ source: 'room_slot', held: 'device_switching' });
  expect(bot!.core.intent(second!.id)).toBeUndefined();
});

it('lists an open input batch so the commit waits, and holds its Turn when it seals during the freeze', async () => {
  await setup({ coalesce: {} });
  const first = await bot!.input('k1', 'first');
  const session = await running(first);
  // The Bot is busy, so the next input opens a batch.
  const batch = await bot!.input('k2', 'second');
  await bot!.freezeForSwitch(device(), 0);
  expect(await bot!.drainForSwitch(device())).toEqual({ ...empty, intents: [first], batches: [batch] });
  await expect(bot!.commitSwitch(device(), 1, NO_EXPORT)).rejects.toThrow('still has open work');
  offset += 11_000;
  await bot!.drain();
  expect(bot!.snapshot().turns[batch]).toMatchObject({ held: 'device_switching' });
  expect(bot!.core.intent(batch)).toBeUndefined();
  session.finish({});
  await vi.waitFor(async () => {
    await bot!.drain();
    expect(await bot!.drainForSwitch(device(), { cancel: true })).toEqual(empty);
  }, { timeout: 5000 });
  expect(bot!.snapshot().turns[batch]).toMatchObject({ conclusion: 'cancelled' });
  expect(await bot!.commitSwitch(device(), 1, await exportDomain())).toEqual({ mode: 'H', revision: 2 });
});

it('cancels a running Host intent and a running routine intent of the device through the drain', async () => {
  await setup();
  await bot!.enqueueHostIntent(hostInput('host-1', device()), 'research');
  await running('host-1');
  const id = await seedRoutine(bot!, 'task-1', 'report', schedule);
  offset = routineOf(bot!, id).next!.availableAt - Date.now();
  await deliverRoutine(bot!, id, now());
  const routine = Object.values(bot!.snapshot().turns).find(turn => turn.source === 'routine')!;
  const occurrence = bot!.ledger.snapshot().intents[Object.keys(bot!.ledger.snapshot().intents).find(key =>
    bot!.ledger.snapshot().intents[key]!.source === 'routine')!]!;
  await vi.waitFor(async () => {
    await bot!.drain();
    expect(bot!.ledger.snapshot().executions[occurrence.taskId]?.started).toBe(true);
  }, { timeout: 5000 });
  await bot!.freezeForSwitch(device(), 0);
  expect((await bot!.drainForSwitch(device())).intents.sort()).toEqual(['host-1', occurrence.key].sort());
  await bot!.drainForSwitch(device(), { cancel: true });
  await vi.waitFor(async () => {
    await bot!.drain();
    expect(await bot!.drainForSwitch(device())).toEqual(empty);
  }, { timeout: 5000 });
  expect(bot!.core.intent('host-1')).toMatchObject({ cancelReason: 'cancelled' });
  expect(bot!.snapshot().turns[routine.id]!.conclusion).toBeDefined();
});

it('sends no queued, backoff or raw core intent to the frozen device, and sends each after the abort', async () => {
  await setup();
  const first = await bot!.input('k1', 'first');
  const session = await running(first);
  // The Bot's FIFO holds the second intent queued behind the first.
  const second = await bot!.input('k2', 'second');
  expect(bot!.core.intent(second)).toMatchObject({ phase: 'queued' });
  await bot!.freezeForSwitch(device(), 0);
  session.finish({});
  await vi.waitFor(async () => { await bot!.drain(); expect(bot!.core.intent(first)!.conclusion).toBe('succeeded'); }, { timeout: 5000 });
  expect(bot!.core.intent(second)).toMatchObject({ phase: 'queued', attempts: 0 });
  // A raw core call passes no L entry, and K4 still holds it.
  await bot!.core.enqueue(hostInput('raw', device()));
  expect(bot!.core.intent('raw')).toMatchObject({ phase: 'queued', attempts: 0 });
  // A backoff intent gets no new generation while the device is frozen.
  const backoff = bot!.core.intent(first)!;
  fixture!.ledger.transaction(s => { Object.assign(s.intents[hash(second)]!, { phase: 'backoff', notBefore: 0 }); });
  await bot!.drain();
  expect(bot!.core.intent(second)).toMatchObject({ phase: 'backoff', generation: 0 });
  expect(backoff.conclusion).toBe('succeeded');
  expect(fixture!.adapter.starts).toHaveLength(1);
  await bot!.abortSwitch(device(), 1);
  await vi.waitFor(async () => {
    await bot!.drain();
    expect(bot!.core.intent(second)).toMatchObject({ phase: 'inflight', generation: 1 });
    expect(bot!.core.intent('raw')).toMatchObject({ phase: 'inflight' });
  }, { timeout: 5000 });
});
