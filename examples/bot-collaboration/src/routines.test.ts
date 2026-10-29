import { afterEach, expect, it, vi } from 'vitest';
import { WAKE_MAX_FUTURE_MS } from '@byok-sdk/server';
import { ROUTINE_HORIZON_MS } from '@byok-sdk/core';
import { validateResultOutcome, type RoutineScheduleFields } from '@byok-sdk/protocol';
import { join } from 'node:path';
import { hash, HostLedger, MIN_TOMBSTONE_RETENTION_MS, WAKE_HORIZON_MS, type HostJobHandler, type HostJobRoutineDefinition } from '@byok-sdk/server/execution-core';
import { openHost, template, type TestHost } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration, type BotOptions } from './host';
import { json, stateOf } from './model';
import { botRoutines, createDefinition, endable, owned, routineOccurrence, updateDefinition } from './routines';
import { DAILY, deliverRoutine, routineOf, routineRow, seedRoutine } from './routines.test-support';
import { outcomeSchema } from './schema';
import { botCompactVeto } from './compaction';

const action = (prompt: string, schedule = DAILY) => ({ localId: 'new_routine_1', schedule, prompt });
const hostJob = (id: string, schedule = DAILY): HostJobRoutineDefinition => ({ id, version: 1, timeZone: schedule.tz, rule: json(schedule),
  waitMs: 60_000, lateAfterMs: 60_000, hostJob: { type: 'digest', input: { report: id } } });

let fixture: TestHost | undefined;
let bot: BotCollaboration | undefined;
let clock = 0;
afterEach(async () => { await bot?.close(); await fixture?.close(); bot = undefined; fixture = undefined; vi.restoreAllMocks(); });
// Only the Bot Host and its core read this clock. The SDK keeps real time, and the slots are at least 11 hours away,
// so no routine wake becomes due in the SDK during a test.
const schedule: RoutineScheduleFields = { minute: 0, hour: (new Date().getUTCHours() + 12) % 24, tz: 'UTC' };
async function setup(rest: Partial<BotOptions> = {}): Promise<BotCollaboration> {
  clock = Date.now();
  fixture = await openHost({ externalCore: true, ledgerOptions: { compactVeto: botCompactVeto }, consume: (wake, signal) => bot!.consume(wake, signal) });
  bot = new BotCollaboration(fixture.server, fixture.ledger, { botId: 'main', execution: template(fixture.deviceId), connector: async () => null,
    now: () => clock, ...rest });
  return bot;
}
const view = (id: string) => botRoutines([routineOf(bot!, id)])[0]!;
const turns = () => Object.values(bot!.snapshot().turns).filter(turn => turn.source === 'routine');
const occurrences = (id: string) => Object.values(fixture!.ledger.snapshot().occurrences).filter(row => row.routineId === id)
  .sort((a, b) => a.trigger.plannedAt - b.trigger.plannedAt);
/** Moves the clock to the reserved slot, plus `late`, and delivers it. */
async function due(id: string, late = 0) {
  clock = routineOf(bot!, id).next!.availableAt + late;
  return deliverRoutine(bot!, id, clock);
}
const redeliver = (slot: { dedupKey: string; availableAt: number }, delivery = 2) => bot!.consume({ wakeId: `again:${slot.dedupKey}`,
  dedupKey: slot.dedupKey, availableAt: slot.availableAt, deliveredAt: clock, delivery }, new AbortController().signal);
async function running(id: string) {
  // K4 must observe the claim before the clock moves, or the wait limit expires the Turn.
  await vi.waitFor(async () => {
    await bot!.drain();
    expect(fixture!.ledger.snapshot().executions[bot!.core.intent(id)!.taskId]?.started).toBe(true);
  }, { timeout: 5000 });
  return fixture!.adapter.sessions.get(bot!.core.intent(id)!.taskId)!;
}
async function finish(id: string) {
  (await running(id)).finish({});
  await vi.waitFor(async () => { await bot!.drain(); expect(bot!.snapshot().turns[id]?.status).toBe('succeeded'); }, { timeout: 5000 });
}

it('keeps the SDK, routine calendar and K4 horizon at 368 days', () => {
  expect(WAKE_HORIZON_MS).toBe(368 * 86_400_000);
  expect(WAKE_HORIZON_MS).toBe(WAKE_MAX_FUTURE_MS);
  expect(WAKE_HORIZON_MS).toBe(ROUTINE_HORIZON_MS);
});

it('offers all ordinary Bot actions and rejects a target field', () => {
  const routines = botRoutines([routineRow(createDefinition([], 'main', 'task-1', 0, action('old prompt'), 'bot'))]);
  const schema = outcomeSchema('main', stateOf({}), undefined, ['default'], routines);
  expect(Object.keys(schema.properties!)).toEqual(['delegate', 'ask_user', 'confirmable_action', 'create_routine', 'update_routine', 'cancel_routine']);
  expect(validateResultOutcome(schema, { create_routine: [{ localId: 'new_routine_1', schedule: DAILY, prompt: 'test', target: 'other' }] }).ok).toBe(false);
  expect(validateResultOutcome(schema, { delegate: [{ to: 'other', request: 'test' }] }).ok).toBe(false);
  expect(validateResultOutcome(schema, { update_routine: [{ routineId: routines[0]!.id, prompt: 'new' }] }).ok).toBe(true);
});

it('builds a K4 hostOccurrence definition with the Bot policy: self only, checked schedule, at most eight open routines per owner', () => {
  expect(createDefinition([], 'main', 'task-1', 0, action('old prompt'), 'owner')).toEqual({ id: hash(['task-1', 'create_routine', 0]), version: 1,
    timeZone: 'UTC', rule: DAILY, waitMs: 300_000, lateAfterMs: 60_000,
    hostOccurrence: { type: 'bot-routine', input: { owner: 'main', authority: 'owner', prompt: 'old prompt' } } });
  expect(() => createDefinition([], 'main', 'task-1', 0, { ...action('test'), target: 'other' }, 'bot')).toThrow('An ordinary Bot cannot supply target');
  expect(() => createDefinition([], 'main', 'task-1', 0, action('test', { ...DAILY, dayOfMonth: 31, month: 4 }), 'bot')).toThrow('schedule_unreachable');
  const rows = Array.from({ length: 8 }, (_, n) => routineRow(createDefinition([], 'main', `seed-${n}`, 0, action('r'), 'bot')));
  expect(() => createDefinition(rows, 'main', 'ninth', 0, action('r'), 'bot')).toThrow('Routine limit is 8');
  // A completed routine, another owner's routine and a Host job routine do not count.
  rows[0]!.lifecycle = 'completed';
  const others = [routineRow(createDefinition([], 'other', 'seed-0', 0, action('r'), 'bot')), routineRow(hostJob('nightly'))];
  expect(createDefinition([...rows, ...others], 'main', 'ninth', 0, action('r'), 'bot').id).toBe(hash(['ninth', 'create_routine', 0]));
});

it('rejects empty updates, builds on pending, keeps owner and authority, and stores duplicate weekdays as a set', () => {
  const row = routineRow(createDefinition([], 'main', 'task-1', 0, action('old prompt'), 'owner'));
  const id = row.definition.id;
  expect(() => updateDefinition([row], 'main', { routineId: id })).toThrow('An update must change schedule or prompt');
  const weekly = { ...DAILY, daysOfWeek: ['mon', 'mon'] } as RoutineScheduleFields;
  row.pending = updateDefinition([row], 'main', { routineId: id, schedule: weekly });
  expect(row.pending).toMatchObject({ version: 2, rule: { ...DAILY, daysOfWeek: ['mon'] },
    hostOccurrence: { input: { owner: 'main', authority: 'owner', prompt: 'old prompt' } } });
  expect(updateDefinition([row], 'main', { routineId: id, prompt: 'third' })).toMatchObject({ version: 3, rule: { daysOfWeek: ['mon'] },
    hostOccurrence: { input: { owner: 'main', authority: 'owner', prompt: 'third' } } });
  const job = routineRow(hostJob('nightly'));
  for (const [rows, owner, target] of [[[row], 'other', id], [[job], 'main', 'nightly']] as const) {
    expect(() => owned(rows, owner, target)).toThrow('Routine is unavailable to this Bot');
  }
  row.lifecycle = 'completed';
  expect(() => updateDefinition([row], 'main', { routineId: id, prompt: 'late' })).toThrow('Routine is unavailable to this Bot');
});

it('ends any open Bot routine whatever its owner, and refuses a Host job routine, a completed one and a missing id (§55c)', () => {
  const row = routineRow(createDefinition([], 'other', 'task-1', 0, action('r'), 'bot')), job = routineRow(hostJob('nightly'));
  expect(endable([row, job], row.definition.id)).toBe(row);
  for (const target of ['nightly', 'missing']) expect(() => endable([row, job], target)).toThrow('No open Bot routine has this id');
  row.lifecycle = 'completed';
  expect(() => endable([row], row.definition.id)).toThrow('No open Bot routine has this id');
});

it('shows only Bot routines, with the current definition, the pending version and the last calendar error', () => {
  const row = routineRow(createDefinition([], 'main', 'task-1', 0, action('old prompt'), 'bot'));
  row.pending = updateDefinition([row], 'main', { routineId: row.definition.id, prompt: 'new prompt' });
  row.status = 'calendar_error';
  row.calendarErrors = [{ at: 1, message: 'first' }, { at: 2, message: 'last', wakeKey: 'slot' }];
  expect(botRoutines([row, routineRow(hostJob('nightly'))])).toEqual([{ id: row.definition.id, owner: 'main', current: 1, pending: 2,
    lifecycle: 'active', status: 'calendar_error', definition: { version: 1, schedule: DAILY, prompt: 'old prompt', target: 'main' },
    lastError: { at: 2, message: 'last', wakeKey: 'slot' } }]);
});

it('writes the routine Turn in the occurrence commit, promotes it as occurrence:<key>, and waits from the occurrence record', async () => {
  await setup();
  const id = await seedRoutine(bot!, 'task-1', 'old prompt', schedule);
  const slot = await due(id, 30_000);
  const [occurrence] = occurrences(id);
  expect(occurrence).toMatchObject({ recordedAt: clock, trigger: { kind: 'scheduled', plannedAt: slot.availableAt }, hook: {} });
  const turn = bot!.snapshot().turns[`occurrence:${occurrence!.key}`]!;
  expect(turn).toMatchObject({ root: turn.id, botId: 'main', source: 'routine', request: 'old prompt', hop: 0, authority: 'bot', status: 'processing' });
  expect(routineOccurrence(turn)).toBe(occurrence!.key);
  expect(bot!.core.intent(turn.id)).toMatchObject({ source: 'routine', occurrence: occurrence!.key, waitUntil: occurrence!.recordedAt + 300_000 });
  expect(occurrences(id)[0]!.intentId).toBe(hash(turn.id));
  // A redelivery reads the stored occurrence. The hook does not run again.
  clock += 86_400_000;
  await redeliver(slot);
  expect(turns()).toEqual([bot!.snapshot().turns[turn.id]]);
  expect(occurrences(id)).toHaveLength(1);
});

it('keeps a running routine Turn and only the latest queued one when slots overlap', async () => {
  await setup();
  const id = await seedRoutine(bot!, 'task-1', 'report', schedule);
  await due(id);
  await running(turns()[0]!.id);
  await due(id);
  await due(id);
  expect(occurrences(id).map(row => row.conclusion)).toEqual([undefined, 'superseded', undefined]);
  expect(turns().map(turn => turn.conclusion)).toEqual([undefined, 'superseded', undefined]);
  expect(turns().map(turn => turn.status)).toEqual(['processing', 'failed', 'processing']);
});

it('holds a due undelivered slot on update, runs it with the old version, and switches when its Turn settles', async () => {
  await setup();
  const id = await seedRoutine(bot!, 'task-1', 'old prompt', schedule);
  const slot = routineOf(bot!, id).next!;
  clock = slot.availableAt + 1;
  await bot!.updateRoutine({ routineId: id, prompt: 'new prompt' });
  expect(view(id)).toMatchObject({ current: 1, pending: 2 });
  expect(routineOf(bot!, id).next).toEqual(slot);
  await due(id, 120_000);
  expect(occurrences(id)[0]).toMatchObject({ definitionVersion: 1, trigger: { kind: 'catch_up', plannedAt: slot.availableAt } });
  const [turn] = turns();
  expect(turn!.request).toBe('old prompt');
  // The staged version stops the old chain.
  expect(routineOf(bot!, id).next).toBeNull();
  await finish(turn!.id);
  expect(occurrences(id)[0]!.conclusion).toBe('succeeded');
  expect(view(id)).toMatchObject({ current: 2, pending: null, definition: { prompt: 'new prompt' } });
  expect(routineOf(bot!, id).next!.dedupKey).toMatch(new RegExp(`^${id}:2:`));
});

it('resumes the current version while pending work is unsettled', async () => {
  await setup();
  const id = await seedRoutine(bot!, 'task-1', 'report', schedule);
  await due(id);
  await running(turns()[0]!.id);
  await bot!.updateRoutine({ routineId: id, prompt: 'pending' });
  await bot!.setRoutineLifecycle(id, 'paused');
  expect(routineOf(bot!, id).next).toBeNull();
  await bot!.setRoutineLifecycle(id, 'active');
  expect(view(id)).toMatchObject({ current: 1, pending: 2, lifecycle: 'active' });
  expect(routineOf(bot!, id).next!.dedupKey).toMatch(new RegExp(`^${id}:1:`));
  expect(occurrences(id).filter(row => !row.conclusion)).toHaveLength(1);
});

it('cancels new occurrences on completion and retains unsettled work', async () => {
  await setup();
  const id = await seedRoutine(bot!, 'task-1', 'report', schedule);
  await due(id);
  const [turn] = turns();
  await running(turn!.id);
  const successor = routineOf(bot!, id).next!;
  await bot!.setRoutineLifecycle(id, 'completed');
  expect(routineOf(bot!, id)).toMatchObject({ lifecycle: 'completed', next: null });
  expect((await fixture!.server.wakes.pending()).map(wake => wake.dedupKey)).not.toContain(successor.dedupKey);
  clock = successor.availableAt;
  await redeliver(successor, 1);
  expect(fixture!.ledger.snapshot().ignoredWakes!.at(-1)).toMatchObject({ reason: 'inactive_routine', wakeKeyHash: hash(successor.dedupKey) });
  expect(turns()).toEqual([bot!.snapshot().turns[turn!.id]]);
  expect(turns()[0]!.conclusion).toBeUndefined();
  await expect(bot!.setRoutineLifecycle(id, 'active')).rejects.toThrow('Routine is unavailable to this Bot');
});

it('switches at once when idle, ignores a late wake of the old version, and refuses an invalid update without a change', async () => {
  await setup();
  const id = await seedRoutine(bot!, 'task-1', 'old prompt', schedule);
  const old = routineOf(bot!, id).next!;
  await bot!.updateRoutine({ routineId: id, prompt: 'v2' });
  await bot!.updateRoutine({ routineId: id, prompt: 'v3' });
  expect(view(id)).toMatchObject({ current: 3, pending: null, definition: { prompt: 'v3' } });
  clock = old.availableAt;
  await redeliver(old, 1);
  expect(fixture!.ledger.snapshot().ignoredWakes!.at(-1)).toMatchObject({ reason: 'reservation_mismatch', wakeKeyHash: hash(old.dedupKey) });
  expect(occurrences(id)).toEqual([]);
  expect(turns()).toEqual([]);
  const before = routineOf(bot!, id);
  await expect(bot!.updateRoutine({ routineId: id, schedule: { ...schedule, dayOfMonth: 31, month: 4 } })).rejects.toThrow('schedule_unreachable');
  expect(routineOf(bot!, id)).toEqual(before);
});

it('rejects a wake that differs from its reservation, keeps the slot, and accepts the reserved wake later', async () => {
  await setup();
  const id = await seedRoutine(bot!, 'task-1', 'report', schedule);
  const slot = routineOf(bot!, id).next!;
  clock = slot.availableAt;
  await expect(bot!.consume({ wakeId: 'mismatch', dedupKey: slot.dedupKey, availableAt: slot.availableAt + 1, deliveredAt: clock, delivery: 1 },
    new AbortController().signal)).rejects.toThrow('Wake differs from the routine reservation');
  expect(occurrences(id)).toEqual([]);
  expect(routineOf(bot!, id).next).toEqual(slot);
  expect(turns()).toEqual([]);
  await redeliver(slot);
  expect(turns()).toHaveLength(1);
});

it('removes settled routine rows with K4 compact: a finished Turn through its intent, a cancelled unpromoted Turn through its occurrence', async () => {
  await setup();
  const done = await seedRoutine(bot!, 'done', 'report', schedule);
  // The request alone exceeds the ContextPack budget, so this Turn blocks before K4 enqueue.
  const held = await seedRoutine(bot!, 'held', 'x'.repeat(40_000), schedule);
  const heldSlot = routineOf(bot!, held).next!;
  await due(done);
  await deliverRoutine(bot!, held, clock);
  const doneTurn = turns().find(turn => turn.request === 'report')!, heldTurn = turns().find(turn => turn.request !== 'report')!;
  expect(heldTurn.status).toBe('blocked');
  await finish(doneTurn.id);
  await bot!.cancelTurn(heldTurn.id);
  expect(occurrences(held)[0]).toMatchObject({ conclusion: 'cancelled' });
  expect(occurrences(held)[0]!.intentId).toBeUndefined();
  await bot!.core.flushProjections(async () => {});
  expect(fixture!.ledger.compact({ acknowledgedIntentKeys: [doneTurn.id], acknowledgedOccurrenceKeys: [routineOccurrence(heldTurn)], now: clock,
    tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS })).toMatchObject({ compactedIntents: 1, occurrences: 2 });
  expect(fixture!.ledger.snapshot().occurrences).toEqual({});
  // The slot tombstone answers a late redelivery. No new Turn appears.
  await redeliver(heldSlot);
  expect(turns()).toHaveLength(2);
});

it('runs a Host job routine and a Bot routine on one Bot Host core, and keeps the Host job out of Bot policy', async () => {
  const digest = vi.fn<HostJobHandler>(async run => ({ summary: { report: run.routineId } }));
  await setup({ hostJobs: { digest } });
  const id = await seedRoutine(bot!, 'task-1', 'report', schedule);
  await bot!.core.addRoutine(hostJob('nightly', schedule));
  const routines = botRoutines(Object.values(fixture!.ledger.snapshot().routines));
  expect(routines.map(row => row.id)).toEqual([id]);
  const enums = outcomeSchema('main', bot!.snapshot(), undefined, ['default'], routines).properties!;
  expect([enums.update_routine!.items!.properties!.routineId!.enum, enums.cancel_routine!.items!.properties!.routineId!.enum]).toEqual([[id], [id]]);
  await expect(bot!.setRoutineLifecycle('nightly', 'paused')).rejects.toThrow('Routine is unavailable to this Bot');
  await due('nightly');
  await deliverRoutine(bot!, id, clock);
  await vi.waitFor(async () => { await bot!.drain(); expect(occurrences('nightly')[0]?.conclusion).toBe('succeeded'); }, { timeout: 5000 });
  expect(digest).toHaveBeenCalledTimes(1);
  expect(occurrences('nightly')[0]!.job).toMatchObject({ summary: { report: 'nightly' } });
  const [turn] = turns();
  expect(turns()).toHaveLength(1);
  await finish(turn!.id);
  expect(occurrences(id)[0]!.conclusion).toBe('succeeded');
  expect(routineOf(bot!, 'nightly').next!.dedupKey).toMatch(/^nightly:1:/);
  expect(routineOf(bot!, id).next!.dedupKey).toMatch(new RegExp(`^${id}:1:`));
});

it('concludes a Host job result with execution as failed, with no intent and no Turn, as H does (#793 K5)', async () => {
  const digest = vi.fn<HostJobHandler>(async () => ({ summary: { escalate: true }, execution: template(fixture!.deviceId) }));
  await setup({ hostJobs: { digest } });
  await bot!.core.addRoutine(hostJob('nightly', schedule));
  await expect(due('nightly')).rejects.toThrow('Wake dispatch failed');
  expect(occurrences('nightly')[0]).toMatchObject({ conclusion: 'failed', job: { summary: { escalate: true } } });
  expect(fixture!.ledger.snapshot().intents).toEqual({});
  expect(turns()).toEqual([]);
  await bot!.drain();
  expect(digest).toHaveBeenCalledTimes(1);
});

it('refuses an execution routine on the Bot Host core and writes no routine row, as H does (#954)', async () => {
  await setup();
  await expect(bot!.core.addRoutine({ id: 'raw', version: 1, timeZone: 'UTC', rule: json(schedule), waitMs: 60_000, lateAfterMs: 60_000,
    execution: template(fixture!.deviceId) })).rejects.toThrow('Execution routines are refused by this Host');
  expect(fixture!.ledger.snapshot().routines).toEqual({});
});

it('refuses a version 1 ledger with a clear error and leaves it unchanged', async () => {
  const options = { botId: 'main', execution: template('device'), connector: async () => null };
  await setup();
  await bot!.close();
  const saved = json({ version: 1, routines: { old: { owner: 'main' } }, occurrences: {}, operations: [] });
  fixture!.ledger.transaction(s => { s.application.collaboration = saved; });
  expect(() => new BotCollaboration(fixture!.server, fixture!.ledger, options))
    .toThrow('Bot collaboration state version 1 is not supported. Bot routines moved to K4 routines.');
  expect(fixture!.ledger.snapshot().application.collaboration).toEqual(saved);
});

it('fails a promoted routine Turn whose intent a writer without the veto compacted, after the tombstone expired', async () => {
  await setup();
  const id = await seedRoutine(bot!, 'task-1', 'report', schedule);
  await due(id);
  const [turn] = turns();
  expect(fixture!.ledger.snapshot().intents[hash(turn!.id)]).toBeDefined();
  await bot!.core.cancel(turn!.id);
  await bot!.core.flushProjections(async () => {});
  const other = new HostLedger(join(fixture!.root, 'host.sqlite'), fixture!.ledger.tenant);
  try {
    expect(other.compact({ acknowledgedIntentKeys: [turn!.id], now: clock, tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS }))
      .toMatchObject({ compactedIntents: 1 });
  } finally { other.close(); }
  expect(fixture!.ledger.snapshot().occurrences[routineOccurrence(turn!)]).toBeUndefined();
  clock += MIN_TOMBSTONE_RETENTION_MS + 1;
  expect(fixture!.ledger.hasTombstone('intent', turn!.id, clock)).toBe(false);
  await bot!.drain();
  await bot!.drain();
  // The K4 rows of this Turn are gone, so it fails once, with an audit line and one report, and new work runs.
  const state = bot!.snapshot();
  expect(state.turns[turn!.id]).toMatchObject({ status: 'failed', conclusion: 'failed', reported: true });
  expect(state.audit.filter(line => line === `Turn result retired before sync: ${turn!.id}`)).toHaveLength(1);
  const reports = Object.values(fixture!.ledger.snapshot().outbox).filter(row => row.kind === 'projection' && row.id === `bot-turn:${turn!.id}`);
  expect(reports).toEqual([expect.objectContaining({ value: expect.objectContaining({ conclusion: 'failed', reason: 'result_retired' }) })]);
  const next = await bot!.input('k2', 'next');
  expect(fixture!.ledger.snapshot().intents[hash(next)]).toBeDefined();
});

it('reads a routine Turn\'s occurrence from its id, and throws for an id that names none', () => {
  const key = hash(['r1', 1, 'slot']);
  expect(routineOccurrence({ id: `occurrence:${key}` })).toBe(key);
  for (const id of ['t1', 'occurrence:', 'occurrence:k', `occurrence:${key}0`]) {
    expect(() => routineOccurrence({ id }), id).toThrow(`Routine Turn ${id} names no occurrence`);
  }
});
