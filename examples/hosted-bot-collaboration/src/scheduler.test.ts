import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeviceTerminal, TaskAttempt } from '@byok-sdk/cloud';
import { hash, taskId, WAKE_HORIZON_MS, type Json, type RoutineDefinition } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { ROUTINE_LATE_AFTER_MS, routineCalendar } from '@byok-sdk/example-bot-collaboration/routines';
import { seedCollaboration, SYNC_OPTIONS } from '@byok-sdk/example-bot-collaboration/test-support';
import { DeviceBindingError } from './binding';
import { freezeIntent } from './intents';
import { storedKey } from './layout';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import type { TaskEvidence } from './reconcile';
import { HostedRoutineScheduler, type SchedulerOptions } from './scheduler';
import { inSchema, lockScope } from './store';

let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
const table = (name: string) => `"${store().schema}".${name}`;
const query = <T extends object>(text: string, values: unknown[]) => opened!.pool.query<T>(text, values).then(found => found.rows);

const DAILY = { minute: 0, hour: 9, tz: 'UTC' };
const PROMPT = 'Daily report';
const slotAfter = (after: number) => routineCalendar({ rule: DAILY, timeZone: 'UTC' } as unknown as RoutineDefinition, after)!;
/** The K8 calendar takes epoch times in [2000, 2200). */
const NOW = Date.UTC(2026, 0, 1);
/** The first slot of a routine created at `NOW`, and the next two. */
const FIRST = slotAfter(NOW - 1), SECOND = slotAfter(FIRST), THIRD = slotAfter(SECOND);
const SYNC = { ...SYNC_OPTIONS, now: NOW, history: undefined };
/** The Host clock of the tests. */
const hostClock = () => NOW;
const occurrenceKey = (id: string, kind: 'scheduled' | 'catch_up', plannedAt: number, version = 1) => hash([id, version, { kind, plannedAt }]);

const routineRow = async (scope: string, id: string) => (await query<{ definition: RoutineDefinition; pending: RoutineDefinition | null; status: string;
  next_at: string | null }>(`SELECT definition, pending, status, next_at::text FROM ${table('routine')} WHERE scope = $1 AND id = $2`,
[storedKey(scope), storedKey(id)]))[0];
const occurrences = (scope: string) => query<{ key: string; trigger_kind: string; planned_at: string; recorded_at: string; next_at: string | null;
  execution_superseded: boolean; conclusion: string | null }>(`SELECT key, trigger_kind, planned_at::text, recorded_at::text, next_at::text,
  execution_superseded, conclusion FROM ${table('occurrence')} WHERE scope = $1 ORDER BY ordinal`, [storedKey(scope)]);
const intentRow = async (scope: string, key: string) => (await query<{ retry_until: string | null; tries: number; conclusion: string | null }>(
  `SELECT retry_until::text, tries, conclusion FROM ${table('intent')} WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(key)]))[0];

describe.skipIf(POSTGRES_URL === undefined)('H routine scheduler on real Postgres (#793 D2f-3)', () => {
  // One schema for each test, because a pass covers the whole schema.
  beforeEach(async () => { opened = await openStore(); });
  afterEach(async () => { await opened?.close(); });

  let clock = NOW;
  beforeEach(() => { clock = NOW; });
  const scheduler = (options: SchedulerOptions = {}) => new HostedRoutineScheduler(opened!.pool, store(), { now: () => clock, ...options });

  /** A seeded scope, named `tenant:<prefix>-<uuid>`, whose Main Bot runs on the bound device `device`. */
  async function scoped(prefix = 'a'): Promise<string> {
    const scope = `tenant:${prefix}-${randomUUID()}`;
    await store().seed(scope, state => seedCollaboration(state));
    await store().bindDevice(scope, 'device');
    return scope;
  }
  /** The seed's processing owner Turn `t1` creates one Bot routine through its outcome. Returns its id. */
  async function created(scope: string): Promise<string> {
    await inSchema(opened!.pool, store().schema, async client => {
      await lockScope(client, storedKey(scope));
      await freezeIntent(client, scope, { key: 't1', source: 'user', execution: template('device'), waitUntil: NOW + 60_000 });
    });
    const document: Json = { create_routine: [{ localId: 'new_routine_1', schedule: DAILY, prompt: PROMPT }] };
    const evidence = { terminal: { envelope: { task_id: taskId('t1', 0), type: 'task.complete', payload: { document } } } as unknown as DeviceTerminal,
      attempt: { taskId: taskId('t1', 0) } as unknown as TaskAttempt } satisfies TaskEvidence;
    expect(await store().finish(scope, 't1', evidence, hostClock)).toBe('succeeded');
    return hash([taskId('t1', 0), 'create_routine', 0]);
  }

  it('fires a due slot as scheduled: the occurrence, the next slot and the routine Turn commit together, with no command record', async () => {
    const scope = await scoped(), id = await created(scope), key = occurrenceKey(id, 'scheduled', FIRST);
    clock = FIRST;
    expect(await scheduler().run()).toEqual({ fired: 1, fenced: [], failed: [] });
    expect(await occurrences(scope)).toEqual([{ key: storedKey(key), trigger_kind: 'scheduled', planned_at: String(FIRST), recorded_at: String(FIRST),
      next_at: String(SECOND), execution_superseded: false, conclusion: null }]);
    expect(await routineRow(scope, id)).toMatchObject({ status: 'ok', next_at: String(SECOND) });
    expect((await store().read(scope)).turns[`occurrence:${key}`]).toMatchObject({ source: 'routine', botId: 'main', request: PROMPT, status: 'queued' });
    expect(await query(`SELECT 1 FROM ${table('command')} WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(key)])).toEqual([]);
    // The slot moved on, so a second pass at the same time fires nothing.
    expect(await scheduler().run()).toEqual({ fired: 0, fenced: [], failed: [] });
    await store().sync(scope, SYNC);
    expect(await intentRow(scope, `occurrence:${key}`)).toMatchObject({ retry_until: String(SECOND), tries: 0, conclusion: null });
  });

  it('fires a slot later than the K8 late bound as catch_up', async () => {
    const scope = await scoped(), id = await created(scope);
    clock = FIRST + ROUTINE_LATE_AFTER_MS + 1;
    expect(await scheduler().run()).toMatchObject({ fired: 1 });
    expect(await occurrences(scope)).toMatchObject([{ key: storedKey(occurrenceKey(id, 'catch_up', FIRST)), trigger_kind: 'catch_up',
      recorded_at: String(clock), next_at: String(SECOND) }]);
  });

  it('supersedes an earlier untried intent in the fire, and keeps a tried one running, as K4 does', async () => {
    const scope = await scoped(), id = await created(scope);
    const untried = `occurrence:${occurrenceKey(id, 'scheduled', FIRST)}`, tried = `occurrence:${occurrenceKey(id, 'scheduled', SECOND)}`;
    clock = FIRST;
    await scheduler().run();
    await store().sync(scope, SYNC);
    clock = SECOND;
    await scheduler().run();
    expect(await intentRow(scope, untried)).toMatchObject({ tries: 0, conclusion: 'superseded' });
    await store().sync(scope, SYNC);
    // No bound yet, so only the fire's write can set it.
    await query(`UPDATE ${table('intent')} SET tries = 1, submission = 'uncertain', retry_until = NULL WHERE scope = $1 AND key = $2`,
      [storedKey(scope), storedKey(tried)]);
    clock = THIRD;
    await scheduler().run();
    expect(await intentRow(scope, tried)).toMatchObject({ tries: 1, retry_until: String(THIRD), conclusion: null });
  });

  it('marks an earlier unpromoted occurrence superseded, and one sync settles its promotion and fails its Turn (fixed point)', async () => {
    const scope = await scoped(), id = await created(scope), first = occurrenceKey(id, 'scheduled', FIRST);
    clock = FIRST;
    await scheduler().run();
    clock = SECOND;
    await scheduler().run();
    expect((await occurrences(scope))[0]).toMatchObject({ key: storedKey(first), execution_superseded: true, conclusion: null });
    await store().sync(scope, SYNC);
    expect(await intentRow(scope, `occurrence:${first}`)).toMatchObject({ conclusion: 'superseded' });
    expect((await store().read(scope)).turns[`occurrence:${first}`]).toMatchObject({ status: 'failed', conclusion: 'superseded' });
  });

  it('fences a routine whose Bot device has no active H binding: nothing is written, and the row does not fill the batch', async () => {
    const fenced = await scoped('a'), healthy = await scoped('b');
    const [fencedId, healthyId] = [await created(fenced), await created(healthy)];
    await store().revokeDevice(fenced, 'device', NOW);
    const before = await store().dump(fenced);
    clock = FIRST;
    const pass = await scheduler({ batch: 1 }).run();
    expect(pass).toMatchObject({ fired: 1, failed: [], fenced: [{ scope: fenced, routineId: fencedId }] });
    expect(pass.fenced[0]!.error).toBeInstanceOf(DeviceBindingError);
    expect(await store().dump(fenced)).toBe(before);
    expect(await routineRow(healthy, healthyId)).toMatchObject({ next_at: String(SECOND) });
    // A revoke is final, so the owner moves the Bot to a new bound device. The next pass fires the slot, now late.
    await store().seed(fenced, state => { state.team.bots.main!.execution = template('device2', 'main'); });
    await store().bindDevice(fenced, 'device2');
    clock = FIRST + ROUTINE_LATE_AFTER_MS + 1;
    expect(await scheduler().run()).toMatchObject({ fired: 1, fenced: [] });
    expect(await occurrences(fenced)).toMatchObject([{ trigger_kind: 'catch_up', planned_at: String(FIRST) }]);
  });

  it('fires the routine of an archived owner Bot on a revoked device: the sync ends its Turn, no intent row is written', async () => {
    const archived = await scoped('a'), healthy = await scoped('b');
    const [archivedId, healthyId] = [await created(archived), await created(healthy)];
    // A Bot that created a routine and was then archived, on a device whose binding was then revoked. Both are final.
    await store().seed(archived, state => { state.team.bots.helper = { ...state.team.bots.main!, id: 'helper', name: 'Helper', mainBot: false,
      archived: true, execution: template('device2', 'helper') }; });
    await store().bindDevice(archived, 'device2');
    await store().revokeDevice(archived, 'device2', NOW);
    await query(`UPDATE ${table('routine')} SET definition = jsonb_set(definition::jsonb, '{hostOccurrence,input,owner}', '"helper"')::json
      WHERE scope = $1`, [storedKey(archived)]);
    const key = occurrenceKey(archivedId, 'scheduled', FIRST), turn = `occurrence:${key}`;
    clock = FIRST;
    expect(await scheduler().run()).toEqual({ fired: 2, fenced: [], failed: [] });
    expect(await routineRow(healthy, healthyId)).toMatchObject({ next_at: String(SECOND) });
    expect((await store().read(archived)).turns[turn]).toMatchObject({ botId: 'helper', status: 'queued' });
    await store().sync(archived, { ...SYNC, now: FIRST });
    expect((await store().read(archived)).turns[turn]).toMatchObject({ status: 'failed', conclusion: 'cancelled' });
    expect(await intentRow(archived, turn)).toBeUndefined();
    expect(await occurrences(archived)).toMatchObject([{ key: storedKey(key), conclusion: 'cancelled' }]);
    expect(await routineRow(archived, archivedId)).toMatchObject({ next_at: String(SECOND) });
  });

  it('does not let failing or fenced routines delay a healthy one: only fires count against the batch, and both back off', async () => {
    const [failing, fenced, healthy] = [await scoped('a'), await scoped('b'), await scoped('c')];
    const [failingId, fencedId, healthyId] = [await created(failing), await created(fenced), await created(healthy)];
    await query(`INSERT INTO ${table('occurrence')} (scope, key, ordinal, routine_id, definition_version, trigger_kind, planned_at, recorded_at, next_at)
      VALUES ($1, $2, 0, $3, 1, 'scheduled', $4, $4, $5)`, [storedKey(failing), storedKey('other'), storedKey(failingId), FIRST, SECOND]);
    await store().revokeDevice(fenced, 'device', NOW);
    const runner = scheduler({ batch: 1, backoffMs: 1000 });
    clock = FIRST;
    // Both stuck rows sort ahead of the healthy one, in slot and then scope order.
    expect(await runner.run()).toMatchObject({ fired: 1, failed: [{ scope: failing, routineId: failingId }], fenced: [{ scope: fenced, routineId: fencedId }] });
    expect(await routineRow(healthy, healthyId)).toMatchObject({ next_at: String(SECOND) });
    expect(await runner.run()).toEqual({ fired: 0, fenced: [], failed: [] });
    clock = FIRST + 1000;
    expect(await runner.run()).toMatchObject({ fired: 0, failed: [{ routineId: failingId }], fenced: [{ routineId: fencedId }] });
    // Routines that stop being due leave the backoff map once their wait ends.
    await query(`UPDATE ${table('routine')} SET lifecycle = 'paused' WHERE scope = ANY($1)`, [[storedKey(failing), storedKey(fenced)]]);
    expect(runner['retryAt'].size).toBe(2);
    clock = FIRST + 2000;
    expect(await runner.run()).toEqual({ fired: 0, fenced: [], failed: [] });
    expect(runner['retryAt'].size).toBe(0);
  });

  it('reads the clock for each fire, as K4 does when it consumes a wake', async () => {
    const [first, second] = [await scoped('a'), await scoped('b')];
    await created(first); await created(second);
    clock = FIRST;
    const ticking = () => { const at = clock; clock += 7; return at; };
    expect(await scheduler({ now: ticking }).run()).toMatchObject({ fired: 2 });
    expect(await occurrences(first)).toMatchObject([{ trigger_kind: 'scheduled', planned_at: String(FIRST), recorded_at: String(FIRST + 7) }]);
    expect(await occurrences(second)).toMatchObject([{ trigger_kind: 'scheduled', planned_at: String(FIRST), recorded_at: String(FIRST + 14) }]);
  });

  it('keeps a staged version through a fire, which reserves no later old slot, and switches it when the occurrence concludes', async () => {
    const scope = await scoped(), id = await created(scope), key = occurrenceKey(id, 'scheduled', FIRST);
    // The slot is due and has not fired, so K4 stages the version.
    await store().updateRoutine(scope, 'main', { routineId: id, prompt: 'Version 2' }, FIRST);
    expect(await routineRow(scope, id)).toMatchObject({ definition: { version: 1 }, pending: { version: 2 }, next_at: String(FIRST) });
    clock = FIRST;
    expect(await scheduler().run()).toMatchObject({ fired: 1 });
    expect(await occurrences(scope)).toMatchObject([{ key: storedKey(key), next_at: null, conclusion: null }]);
    expect(await routineRow(scope, id)).toMatchObject({ definition: { version: 1 }, pending: { version: 2 }, next_at: null });
    await store().commit(scope, { scope, commandId: 'cancel', command: { kind: 'cancel_turn', turnId: `occurrence:${key}` } }, hostClock);
    await store().sync(scope, { ...SYNC, now: FIRST });
    expect(await occurrences(scope)).toMatchObject([{ key: storedKey(key), conclusion: 'cancelled' }]);
    expect(await routineRow(scope, id)).toMatchObject({ definition: { version: 2 }, pending: null, next_at: String(SECOND) });
  });

  it('records one occurrence when two fires race on one slot', async () => {
    const scope = await scoped(), id = await created(scope);
    const results = await Promise.all([store().fire(scope, id, FIRST), store().fire(scope, id, FIRST)]);
    expect(results.sort()).toEqual(['fired', 'skipped']);
    expect(await occurrences(scope)).toHaveLength(1);
  });

  it('writes nothing when a fire throws, and backs the routine off in memory before its next try', async () => {
    const scope = await scoped(), id = await created(scope);
    // Another occurrence row holds the slot, so the occurrence insert throws after the routine Turn was committed in memory.
    await query(`INSERT INTO ${table('occurrence')} (scope, key, ordinal, routine_id, definition_version, trigger_kind, planned_at, recorded_at, next_at)
      VALUES ($1, $2, 0, $3, 1, 'scheduled', $4, $4, $5)`, [storedKey(scope), storedKey('other'), storedKey(id), FIRST, SECOND]);
    const before = await store().dump(scope), runner = scheduler({ backoffMs: 1000 });
    clock = FIRST;
    const pass = await runner.run();
    expect(pass).toMatchObject({ fired: 0, fenced: [], failed: [{ scope, routineId: id }] });
    expect(await store().dump(scope)).toBe(before);
    expect(await runner.run()).toEqual({ fired: 0, fenced: [], failed: [] });
    clock = FIRST + 1000;
    expect(await runner.run()).toMatchObject({ fired: 0, failed: [{ scope, routineId: id }] });
  });

  it('reports each scope where the pass committed a fire, in fire order, and no fenced or failed routine (#793 D2f-5)', async () => {
    const [failing, fenced, first, second] = [await scoped('a'), await scoped('b'), await scoped('c'), await scoped('d')];
    const failingId = await created(failing);
    for (const scope of [fenced, first, second]) await created(scope);
    await query(`INSERT INTO ${table('occurrence')} (scope, key, ordinal, routine_id, definition_version, trigger_kind, planned_at, recorded_at, next_at)
      VALUES ($1, $2, 0, $3, 1, 'scheduled', $4, $4, $5)`, [storedKey(failing), storedKey('other'), storedKey(failingId), FIRST, SECOND]);
    await store().revokeDevice(fenced, 'device', NOW);
    const changed: string[] = [], runner = scheduler({ changed: scope => { changed.push(scope); } });
    clock = FIRST;
    expect(await runner.run()).toMatchObject({ fired: 2, failed: [{ scope: failing }], fenced: [{ scope: fenced }] });
    expect(changed).toEqual([first, second]);
    // A pass with no fire reports nothing.
    clock = FIRST + 1;
    changed.length = 0;
    expect(await runner.run()).toEqual({ fired: 0, fenced: [], failed: [] });
    expect(changed).toEqual([]);
  });

  it('lets a throw from the changed callback propagate, after the fire committed (#793 D2f-5)', async () => {
    const scope = await scoped(), id = await created(scope);
    clock = FIRST;
    await expect(scheduler({ changed: () => { throw new Error('Host sync refused'); } }).run()).rejects.toThrow('Host sync refused');
    expect(await occurrences(scope)).toMatchObject([{ key: storedKey(occurrenceKey(id, 'scheduled', FIRST)) }]);
  });

  it('refuses a pass interval at or above the K8 late bound, and defaults to 5 s', () => {
    expect(() => scheduler({ intervalMs: ROUTINE_LATE_AFTER_MS })).toThrow('The routine pass interval must be at least 1 ms');
    expect(() => scheduler({ intervalMs: 0 })).toThrow('The routine pass interval must be at least 1 ms');
    expect(scheduler().intervalMs).toBe(5_000);
    expect(scheduler({ intervalMs: ROUTINE_LATE_AFTER_MS - 1 }).intervalMs).toBe(ROUTINE_LATE_AFTER_MS - 1);
  });

  describe('schedule upkeep', () => {
    it('re-plans an active routine with no slot within the horizon at start, as K4 recover', async () => {
      const scope = await scoped(), id = await created(scope);
      await query(`UPDATE ${table('routine')} SET status = 'no_occurrence_within_horizon', next_at = NULL WHERE scope = $1`, [storedKey(scope)]);
      clock = SECOND;
      expect(await scheduler().start()).toEqual([]);
      expect(await routineRow(scope, id)).toMatchObject({ status: 'ok', next_at: String(THIRD) });
    });

    it('switches a staged version at start once no old work can use it', async () => {
      const scope = await scoped(), id = await created(scope);
      const definition = (await routineRow(scope, id))!.definition;
      await query(`UPDATE ${table('routine')} SET pending = $2::json WHERE scope = $1`, [storedKey(scope), JSON.stringify({ ...definition, version: 2 })]);
      expect(await scheduler().start()).toEqual([]);
      expect(await routineRow(scope, id)).toMatchObject({ pending: null, definition: { version: 2 }, next_at: String(FIRST) });
    });

    it('sets ok on a schedule_retrying routine once its slot is within the horizon, on each pass', async () => {
      const [near, far] = [await scoped('a'), await scoped('b')];
      const [nearId, farId] = [await created(near), await created(far)];
      const within = slotAfter(NOW + WAKE_HORIZON_MS - 2 * 86_400_000), beyond = slotAfter(NOW + WAKE_HORIZON_MS);
      await query(`UPDATE ${table('routine')} SET status = 'schedule_retrying', next_at = $2 WHERE scope = $1`, [storedKey(near), within]);
      await query(`UPDATE ${table('routine')} SET status = 'schedule_retrying', next_at = $2 WHERE scope = $1`, [storedKey(far), beyond]);
      expect(await scheduler().run()).toEqual({ fired: 0, fenced: [], failed: [] });
      expect(await routineRow(near, nearId)).toMatchObject({ status: 'ok', next_at: String(within) });
      expect(await routineRow(far, farId)).toMatchObject({ status: 'schedule_retrying', next_at: String(beyond) });
    });
  });
});
