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
let clock = 0;
afterEach(async () => { await bot?.close(); await fixture?.close(); bot = undefined; fixture = undefined; });
// The routine slot is at least 11 hours away, so no routine wake becomes due in the SDK during a test.
const schedule = { minute: 0, hour: (new Date().getUTCHours() + 12) % 24, tz: 'UTC' };
const OTHER = 'device-2';
const options = (): BotOptions => ({ botId: 'main', execution: template(fixture!.deviceId), connector: async () => null, now: () => clock,
  hostIntents: { research: () => {} } });
async function setup(): Promise<BotCollaboration> {
  clock = Date.now();
  fixture = await openHost({ externalCore: true, ledgerOptions: { compactVeto: botCompactVeto }, consume: (wake, signal) => bot!.consume(wake, signal) });
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
const hostInput = (key: string, deviceId: string): IntentInput => ({ key, source: 'user', execution: template(deviceId, 'research'), waitUntil: clock + 600_000 });
const stored = () => JSON.stringify(fixture!.ledger.snapshot());
async function running(id: string) {
  await vi.waitFor(async () => {
    await bot!.drain();
    expect(fixture!.ledger.snapshot().executions[bot!.core.intent(id)!.taskId]?.started).toBe(true);
  }, { timeout: 5000 });
  return fixture!.adapter.sessions.get(bot!.core.intent(id)!.taskId)!;
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
});

it('refuses each entry that can create execution on the frozen device with device_switching, and writes nothing', async () => {
  await setup();
  await bot!.freezeForSwitch(device(), 0);
  const before = stored();
  const refusal = { code: 'device_switching', deviceId: device(), target: 'H', revision: 1 };
  await expect(bot!.input('k1', 'hello')).rejects.toMatchObject(refusal);
  await expect(bot!.input('k1', 'hello')).rejects.toBeInstanceOf(DeviceSwitchingError);
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
  clock = slot.availableAt;
  await expect(deliverRoutine(bot!, id, clock)).rejects.toBeInstanceOf(DeviceSwitchingError);
  expect(Object.values(fixture!.ledger.snapshot().occurrences)).toEqual([]);
  expect(Object.values(bot!.snapshot().turns).filter(turn => turn.source === 'routine')).toEqual([]);
  expect(routineOf(bot!, id).next).toEqual(slot);
  await bot!.abortSwitch(device(), 1);
  await deliverRoutine(bot!, id, clock, 2);
  expect(Object.values(bot!.snapshot().turns).filter(turn => turn.source === 'routine')).toHaveLength(1);
});

it('sends no Agent home write for a Bot on the frozen device, and sends it after the abort', async () => {
  await setup();
  const enqueue = vi.spyOn(fixture!.server, 'enqueueAgentHomeProjection');
  await bot!.freezeForSwitch(device(), 0);
  // A team change is not refused: it queues a persona write, as an applied snapshot does.
  fixture!.ledger.transaction(s => updateBot(stateOf(s.application), { botId: 'main', persona: 'New persona' }, { default: template(device()) }));
  await bot!.drain();
  expect(enqueue).not.toHaveBeenCalled();
  // A write that was never sent is not open work: it moves with the exported state.
  expect((await bot!.drainForSwitch(device())).homeOperations).toEqual([]);
  await bot!.abortSwitch(device(), 1);
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
  await expect(bot!.commitSwitch(device(), 1)).rejects.toThrow('still has open work');
  // The tried intent stays open after the cancel: only its terminal concludes it.
  expect(await bot!.drainForSwitch(device(), { cancel: true })).toEqual({ intents: [live], turns: [], batches: [], homeOperations: [] });
  expect(bot!.snapshot().turns.queued).toMatchObject({ status: 'failed', conclusion: 'cancelled' });
  await expect(bot!.commitSwitch(device(), 1)).rejects.toThrow('still has open work');
  session.finish({});
  await vi.waitFor(async () => {
    await bot!.drain();
    expect(await bot!.drainForSwitch(device())).toEqual({ intents: [], turns: [], batches: [], homeOperations: [] });
  }, { timeout: 5000 });
  await expect(bot!.commitSwitch(device(), 0)).rejects.toMatchObject({ code: 'stale_revision' });
  expect(await bot!.commitSwitch(device(), 1)).toEqual({ mode: 'H', revision: 2 });
});

it('refuses the device for good after the commit, also in a new Host over the same ledger', async () => {
  await setup();
  await bot!.freezeForSwitch(device(), 0);
  await bot!.commitSwitch(device(), 1);
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
  await bot.drain();
  expect(bot.snapshot().turns.t1).toMatchObject({ held: 'device_not_bound' });
  expect(bot.core.intent('t1')).toBeUndefined();
});

it('refuses to open a ledger with a malformed topology record', async () => {
  await setup();
  await bot!.close();
  bot = undefined;
  fixture!.ledger.transaction(s => { stateOf(s.application).topology = { [device()]: { mode: 'H', revision: 1, switching: 'H' } }; });
  expect(() => new BotCollaboration(fixture!.server, fixture!.ledger, options())).toThrow(`Invalid topology record for device ${device()}`);
});
