import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeviceTerminal, TaskAttempt } from '@byok-sdk/cloud';
import { hash, MIN_TOMBSTONE_RETENTION_MS, taskId, type FrozenSubmitPort, type Json, type RoutineDefinition } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import type { CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { createDefinition, ROUTINE_WAIT_MS, routineCalendar, routineTurn } from '@byok-sdk/example-bot-collaboration/routines';
import { seedCollaboration, SYNC_OPTIONS } from '@byok-sdk/example-bot-collaboration/test-support';
import { freezeIntent, HostedSubmitter } from './intents';
import { storedKey } from './layout';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import { HostedReconciler, type TaskEvidence } from './reconcile';
import { hostedRoutineCommands, loadSlice, writeSlice } from './routines';
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
/** The first slot of a routine created at `NOW`, and the next one. */
const FIRST = slotAfter(NOW - 1), SECOND = slotAfter(FIRST);
const SYNC = { ...SYNC_OPTIONS, now: NOW, history: undefined };
/** The fixture records each occurrence this long after its slot, so a time from the record differs from one from the slot. */
const RECORD_DELAY_MS = 1_000;


const routineRow = async (scope: string, id: string) => (await query<{ ordinal: string; definition: RoutineDefinition; pending: RoutineDefinition | null;
  lifecycle: string; status: string; next_at: string | null }>(`SELECT ordinal::text, definition, pending, lifecycle, status, next_at::text
  FROM ${table('routine')} WHERE scope = $1 AND id = $2`, [storedKey(scope), storedKey(id)]))[0];
const occurrenceRow = async (scope: string, key: string) => (await query<{ execution_superseded: boolean; conclusion: string | null }>(
  `SELECT execution_superseded, conclusion FROM ${table('occurrence')} WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(key)]))[0];
const intentRow = async (scope: string, key: string) => (await query<{ source: string; input: Json; wait_until: string; retry_until: string | null;
  tries: number; conclusion: string | null }>(`SELECT source, input, wait_until::text, retry_until::text, tries, conclusion FROM ${table('intent')}
  WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(key)]))[0];

/** The Host clock of the tests. */
const clock = () => NOW;
/** A device terminal that completes the task of Turn `turnId` with `document`. */
function completed(turnId: string, document: Json): TaskEvidence {
  const task = taskId(turnId, 0);
  return { terminal: { envelope: { task_id: task, type: 'task.complete', payload: { document } } } as unknown as DeviceTerminal,
    attempt: { taskId: task } as unknown as TaskAttempt };
}

describe.skipIf(POSTGRES_URL === undefined)('H routines on real Postgres (#793 D2f-2)', () => {
  // One schema for each test, because the submit and reconcile scans cover the whole schema.
  beforeEach(async () => { opened = await openStore(); });
  afterEach(async () => { await opened?.close(); });

  /** A seeded scope whose Main Bot runs on the bound device `device`. */
  async function scoped(): Promise<string> {
    const scope = `tenant:${randomUUID()}`;
    await store().seed(scope, state => seedCollaboration(state));
    await store().bindDevice(scope, 'device');
    return scope;
  }
  const locked = <T>(scope: string, work: (client: Parameters<Parameters<typeof inSchema>[2]>[0]) => Promise<T>) =>
    inSchema(opened!.pool, store().schema, async client => { await lockScope(client, storedKey(scope)); return work(client); });
  /** Freezes the intent of Turn `turnId`, then completes it with `document` through the store's terminal transaction. */
  async function finished(scope: string, turnId: string, document: Json) {
    await locked(scope, client => freezeIntent(client, scope, { key: turnId, source: 'user', execution: template('device'), waitUntil: NOW + 60_000 }));
    return store().finish(scope, turnId, completed(turnId, document), clock);
  }
  /** The seed's processing owner Turn `t1` creates one Bot routine through its outcome. Returns its id. */
  async function created(scope: string): Promise<string> {
    expect(await finished(scope, 't1', { create_routine: [{ localId: 'new_routine_1', schedule: DAILY, prompt: PROMPT }] })).toBe('succeeded');
    return hash([taskId('t1', 0), 'create_routine', 0]);
  }
  /**
   * Records the occurrence of slot `plannedAt` and its routine Turn, as the D2f-3 scheduler will: the occurrence row,
   * the routine's next slot and the `bot-routine` hook Turn. Returns the occurrence key and the Turn id.
   */
  async function fired(scope: string, id: string, plannedAt: number, version = 1) {
    const trigger = { kind: 'scheduled' as const, plannedAt }, key = hash([id, version, trigger]), next = slotAfter(plannedAt);
    await query(`INSERT INTO ${table('occurrence')} (scope, key, ordinal, routine_id, definition_version, trigger_kind, planned_at, recorded_at, next_at)
      SELECT $1, $2, coalesce(max(ordinal) + 1, 0), $3, $4, 'scheduled', $5, $6, $7 FROM ${table('occurrence')} WHERE scope = $1`,
    [storedKey(scope), storedKey(key), storedKey(id), version, plannedAt, plannedAt + RECORD_DELAY_MS, next]);
    await query(`UPDATE ${table('routine')} SET next_at = $3 WHERE scope = $1 AND id = $2`, [storedKey(scope), storedKey(id), next]);
    await store().seed(scope, state => routineTurn(state, { type: 'bot-routine', input: { owner: 'main', authority: 'owner', prompt: PROMPT },
      occurrenceKey: key, routineId: id, definitionVersion: version, trigger }));
    return { key, turn: `occurrence:${key}` };
  }
  const settled = (state: CollaborationState) => { Object.assign(state.turns.t1!, { status: 'succeeded', conclusion: 'succeeded', reported: true }); };

  it('creates a routine through an outcome action with the store\'s own ports, and the next frozen instruction lists it', async () => {
    const scope = await scoped(), id = await created(scope);
    expect(await routineRow(scope, id)).toEqual({ ordinal: '0', lifecycle: 'active', status: 'ok', next_at: String(FIRST), pending: null,
      definition: { id, version: 1, timeZone: 'UTC', rule: DAILY, waitMs: ROUTINE_WAIT_MS, lateAfterMs: 60_000,
        hostOccurrence: { type: 'bot-routine', input: { owner: 'main', authority: 'owner', prompt: PROMPT } } } });
    await store().seed(scope, state => {
      state.turns.q1 = { id: 'q1', root: 'q1', botId: 'main', source: 'user', request: 'What is planned?', hop: 0, status: 'queued', authority: 'owner' };
    });
    await store().sync(scope, SYNC);
    const instruction = ((await intentRow(scope, 'q1'))!.input as { payload: { instruction: string } }).payload.instruction;
    expect(instruction).toContain(id);
    expect(instruction).toContain(PROMPT);
  });

  it('stages, switches, pauses, resumes and completes a routine through the Main Bot owner API, and refuses another Bot', async () => {
    const scope = await scoped(), id = await created(scope);
    // No occurrence is open and no slot is due, so the staged version switches at once.
    await store().updateRoutine(scope, 'main', { routineId: id, prompt: 'Version 2' }, NOW);
    expect(await routineRow(scope, id)).toMatchObject({ pending: null, next_at: String(FIRST),
      definition: { version: 2, hostOccurrence: { input: { prompt: 'Version 2' } } } });
    await store().setRoutineLifecycle(scope, 'main', id, 'paused', NOW);
    expect(await routineRow(scope, id)).toMatchObject({ lifecycle: 'paused', next_at: null });
    await store().setRoutineLifecycle(scope, 'main', id, 'active', NOW);
    expect(await routineRow(scope, id)).toMatchObject({ lifecycle: 'active', next_at: String(FIRST) });
    await store().seed(scope, state => {
      state.team.bots.helper = { ...state.team.bots.main!, id: 'helper', name: 'Helper', mainBot: false, execution: template('device', 'helper') };
    });
    const before = await store().dump(scope);
    await expect(store().setRoutineLifecycle(scope, 'helper', id, 'paused', NOW)).rejects.toThrow('Main Bot role required');
    expect(await store().dump(scope)).toBe(before);
    await store().setRoutineLifecycle(scope, 'main', id, 'completed', NOW);
    expect(await routineRow(scope, id)).toMatchObject({ lifecycle: 'completed', next_at: null });
  });

  it('promotes a routine Turn as its occurrence intent, timed from the occurrence record, with no retry policy', async () => {
    const scope = await scoped(), id = await created(scope);
    const { key, turn } = await fired(scope, id, FIRST);
    await store().sync(scope, SYNC);
    const row = (await intentRow(scope, turn))!;
    expect(row).toMatchObject({ source: 'routine', wait_until: String(FIRST + RECORD_DELAY_MS + ROUTINE_WAIT_MS), retry_until: String(SECOND), tries: 0,
      conclusion: null });
    expect(row.input).not.toHaveProperty('retry');
    expect((row.input as { payload: { instruction: string } }).payload.instruction).toContain(PROMPT);
    expect(await occurrenceRow(scope, key)).toEqual({ execution_superseded: false, conclusion: null });
    expect((await store().read(scope)).turns[turn]).toMatchObject({ status: 'processing', source: 'routine' });
  });

  it('removes the successor retry_until of a promoted intent when its routine pauses, as K4 setLifecycle does', async () => {
    const scope = await scoped(), id = await created(scope);
    const { turn } = await fired(scope, id, FIRST);
    await store().sync(scope, SYNC);
    expect(await intentRow(scope, turn)).toMatchObject({ retry_until: String(SECOND), conclusion: null });
    await store().setRoutineLifecycle(scope, 'main', id, 'paused', FIRST);
    expect(await intentRow(scope, turn)).toMatchObject({ retry_until: null, conclusion: null });
  });

  it('updates and cancels a routine through outcome actions with the store\'s own ports', async () => {
    const scope = await scoped(), id = await created(scope);
    await store().seed(scope, state => {
      for (const turnId of ['t2', 't3']) {
        state.turns[turnId] = { id: turnId, root: turnId, botId: 'main', source: 'user', request: 'Change the plan', hop: 0, status: 'queued', authority: 'owner' };
      }
    });
    // The sync freezes both Turns with an outcome schema that lists the routine.
    await store().sync(scope, SYNC);
    expect(await store().finish(scope, 't2', completed('t2', { update_routine: [{ routineId: id, prompt: 'Version 2' }] }), clock)).toBe('succeeded');
    expect(await routineRow(scope, id)).toMatchObject({ pending: null, lifecycle: 'active', next_at: String(FIRST),
      definition: { version: 2, hostOccurrence: { input: { prompt: 'Version 2' } } } });
    expect(await store().finish(scope, 't3', completed('t3', { cancel_routine: [{ routineId: id }] }), clock)).toBe('succeeded');
    expect(await routineRow(scope, id)).toMatchObject({ lifecycle: 'completed', next_at: null });
  });

  it('promotes the routine Turn of a paused routine with no retry_until', async () => {
    const scope = await scoped(), id = await created(scope);
    const { turn } = await fired(scope, id, FIRST);
    await store().setRoutineLifecycle(scope, 'main', id, 'paused', FIRST);
    await store().sync(scope, SYNC);
    expect(await intentRow(scope, turn)).toMatchObject({ source: 'routine', retry_until: null, conclusion: null });
  });

  it('holds the routine Turn of a device with no H binding, with no promotion (#793 D2e, #956)', async () => {
    const scope = await scoped(), id = await created(scope);
    const { turn } = await fired(scope, id, FIRST);
    await store().revokeDevice(scope, 'device', NOW);
    await store().sync(scope, SYNC);
    expect((await store().read(scope)).turns[turn]).toMatchObject({ held: 'device_not_bound' });
    expect(await intentRow(scope, turn)).toBeUndefined();
  });

  it('settles the promotion of an occurrence that a newer slot superseded, and the next sync fails its Turn', async () => {
    const scope = await scoped(), id = await created(scope);
    const { key, turn } = await fired(scope, id, FIRST);
    await query(`UPDATE ${table('occurrence')} SET execution_superseded = true WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(key)]);
    await store().sync(scope, SYNC);
    expect(await intentRow(scope, turn)).toMatchObject({ source: 'routine', retry_until: null, conclusion: 'superseded' });
    await store().sync(scope, SYNC);
    expect((await store().read(scope)).turns[turn]).toMatchObject({ status: 'failed', conclusion: 'superseded' });
  });

  it('concludes the occurrence cancelled when its routine Turn ends before promotion', async () => {
    const scope = await scoped(), id = await created(scope);
    const { key, turn } = await fired(scope, id, FIRST);
    await store().commit(scope, { scope, commandId: 'cancel', command: { kind: 'cancel_turn', turnId: turn } }, clock);
    await store().sync(scope, SYNC);
    expect(await occurrenceRow(scope, key)).toEqual({ execution_superseded: false, conclusion: 'cancelled' });
    expect(await intentRow(scope, turn)).toBeUndefined();
  });

  describe('the claim checks retry_until only for an untried row', () => {
    /** An SDK tenant in memory that records each submit. */
    function fakePort() {
      const offers = new Map<string, unknown>(), submitted: string[] = [];
      const port: FrozenSubmitPort = {
        submit: async input => {
          submitted.push(input.taskId);
          offers.set(input.taskId, { taskId: input.taskId, deviceId: input.deviceId, type: 'task.offer_for_agent_with_egress_fresh',
            payload: structuredClone(input.payload), delivered: true, messageId: `offer-${input.taskId}` });
          return undefined as never;
        },
        offer: async task => offers.get(task) as never,
      };
      return { port, submitted };
    }
    const submitter = (port: FrozenSubmitPort, now: number) =>
      new HostedSubmitter(opened!.pool, store().schema, { port: () => port, now: () => now, leaseMs: 1000, backoffMs: 500 });
    /** A promoted routine intent whose `retry_until` ends before its `wait_until`, and a time between them. */
    async function bounded() {
      const scope = await scoped(), id = await created(scope);
      const { turn } = await fired(scope, id, FIRST);
      await store().sync(scope, SYNC);
      await query(`UPDATE ${table('intent')} SET retry_until = $3 WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(turn), FIRST + 1000]);
      return { scope, turn, now: FIRST + 2000 };
    }

    it('concludes an untried row superseded at retry_until, with no SDK call', async () => {
      const { scope, turn, now } = await bounded(), sdk = fakePort();
      expect(await submitter(sdk.port, now).run()).toEqual({ tried: 1, failed: [] });
      expect(sdk.submitted).toEqual([]);
      expect(await intentRow(scope, turn)).toMatchObject({ tries: 0, conclusion: 'superseded' });
    });
    it('still submits a tried row past retry_until, as K4 submit does', async () => {
      const { scope, turn, now } = await bounded(), sdk = fakePort();
      await query(`UPDATE ${table('intent')} SET tries = 1, submission = 'uncertain' WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(turn)]);
      expect(await submitter(sdk.port, now).run()).toEqual({ tried: 1, failed: [] });
      expect(sdk.submitted).toEqual([taskId(turn, 0)]);
      expect(await intentRow(scope, turn)).toMatchObject({ tries: 2, conclusion: null });
    });
  });

  describe('switches a staged version when a writer concludes the last open occurrence', () => {
    /** A routine with one promoted, untried occurrence intent, and version 2 staged behind it. */
    async function staged() {
      const scope = await scoped(), id = await created(scope);
      const { turn } = await fired(scope, id, FIRST);
      await store().sync(scope, SYNC);
      await store().updateRoutine(scope, 'main', { routineId: id, prompt: 'Version 2' }, FIRST);
      expect(await routineRow(scope, id)).toMatchObject({ definition: { version: 1 }, pending: { version: 2 } });
      return { scope, id, turn };
    }
    const switched = async (scope: string, id: string, now: number) =>
      expect(await routineRow(scope, id)).toMatchObject({ definition: { version: 2 }, pending: null, next_at: String(slotAfter(now)) });

    it('the claim expiry', async () => {
      const { scope, id, turn } = await staged(), now = FIRST + RECORD_DELAY_MS + ROUTINE_WAIT_MS;
      await new HostedSubmitter(opened!.pool, store().schema, { port: () => { throw new Error('No SDK call'); }, now: () => now }).run();
      expect(await intentRow(scope, turn)).toMatchObject({ conclusion: 'expired' });
      await switched(scope, id, now);
    });
    it('the sync cancel of an untried row', async () => {
      const { scope, id, turn } = await staged();
      await store().seed(scope, state => { state.team.bots.main!.archived = true; });
      await store().sync(scope, { ...SYNC, now: FIRST });
      expect(await intentRow(scope, turn)).toMatchObject({ conclusion: 'cancelled' });
      await switched(scope, id, FIRST);
    });
    it('the sync of a routine Turn that ended before promotion', async () => {
      const scope = await scoped(), id = await created(scope);
      const { key, turn } = await fired(scope, id, FIRST);
      await store().updateRoutine(scope, 'main', { routineId: id, prompt: 'Version 2' }, FIRST);
      await store().commit(scope, { scope, commandId: 'cancel', command: { kind: 'cancel_turn', turnId: turn } }, clock);
      await store().sync(scope, { ...SYNC, now: FIRST });
      expect(await occurrenceRow(scope, key)).toMatchObject({ conclusion: 'cancelled' });
      await switched(scope, id, FIRST);
    });
    it('the reconciliation conclude', async () => {
      const { scope, id, turn } = await staged(), now = FIRST + 1000;
      await query(`UPDATE ${table('intent')} SET submission = 'uncertain', tries = 1, cancel_reason = 'cancelled' WHERE scope = $1 AND key = $2`,
        [storedKey(scope), storedKey(turn)]);
      const none = async () => undefined;
      await new HostedReconciler(opened!.pool, store().schema, store(), { now: () => now,
        port: () => ({ offer: none, attempt: none, deviceTerminal: none, cancel: none }) }).run();
      expect(await intentRow(scope, turn)).toMatchObject({ conclusion: 'cancelled' });
      await switched(scope, id, now);
    });
    it('the owner cancel of a promoted untried Turn (#793 D2f-4)', async () => {
      const { scope, id, turn } = await staged();
      await store().commit(scope, { scope, commandId: 'cancel', command: { kind: 'cancel_turn', turnId: turn } }, clock);
      expect(await intentRow(scope, turn)).toMatchObject({ tries: 0, conclusion: 'cancelled' });
      await switched(scope, id, NOW);
    });
    it('the terminal transaction', async () => {
      const { scope, id, turn } = await staged();
      expect(await store().finish(scope, turn, completed(turn, {}), clock)).toBe('succeeded');
      await switched(scope, id, NOW);
    });
    it('the end_routine commit of another routine (§55c)', async () => {
      const { scope, id, turn } = await staged();
      // The occurrence intent concludes outside any writer, so only the next writer can switch version 2.
      await query(`UPDATE ${table('intent')} SET conclusion = 'cancelled' WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(turn)]);
      const other = await locked(scope, async client => {
        const slice = await loadSlice(client, storedKey(scope)), commands = hostedRoutineCommands(slice, NOW);
        const definition = createDefinition(commands.list(), 'main', taskId('t2', 0), 0, { localId: 'new_routine_1', schedule: DAILY, prompt: PROMPT }, 'bot');
        commands.create(definition);
        await writeSlice(client, storedKey(scope), slice);
        return definition.id;
      });
      expect(await routineRow(scope, id)).toMatchObject({ pending: { version: 2 } });
      await store().commit(scope, { scope, commandId: randomUUID(), command: { kind: 'end_routine', botId: 'main', routineId: other } }, clock);
      expect(await routineRow(scope, other)).toMatchObject({ lifecycle: 'completed' });
      await switched(scope, id, NOW);
    });
  });

  it('owns the routines port of end_routine: a refusal writes nothing, and an acceptance completes the routine (§55c)', async () => {
    const scope = await scoped(), id = await created(scope), before = await store().dump(scope);
    await expect(store().commit(scope, { scope, commandId: randomUUID(), command: { kind: 'end_routine', botId: 'main', routineId: 'missing' } }, clock))
      .rejects.toThrow('No open Bot routine has this id');
    expect(await store().dump(scope)).toBe(before);
    await store().commit(scope, { scope, commandId: randomUUID(), command: { kind: 'end_routine', botId: 'main', routineId: id } }, clock);
    expect(await routineRow(scope, id)).toMatchObject({ lifecycle: 'completed', next_at: null, pending: null });
  });

  it('refuses a routine that is not a bot-routine, on the store\'s routine port, and changes nothing', async () => {
    const scope = await scoped(), id = await created(scope);
    await locked(scope, async client => {
      const slice = await loadSlice(client, storedKey(scope)), commands = hostedRoutineCommands(slice, NOW);
      const base = commands.list()[0]!.definition, { hostOccurrence: _hook, ...rest } = base;
      const execution = { ...rest, id: 'execution-routine', execution: template('device') } as RoutineDefinition;
      expect(() => commands.create(execution)).toThrow('H runs only bot-routine routines');
      expect(() => commands.update({ ...execution, id, version: 2 })).toThrow('H runs only bot-routine routines');
      expect(commands.list().map(routine => routine.definition.id)).toEqual([id]);
    });
  });

  it('refuses retention of a routine root while its occurrence is open, and retains it once concluded', async () => {
    const scope = await scoped(), id = await created(scope);
    const { turn } = await fired(scope, id, FIRST);
    await store().seed(scope, state => {
      settled(state);
      Object.assign(state.turns[turn]!, { status: 'failed', conclusion: 'cancelled', reported: true });
      // A newer root keeps the routine Turn out of the ContextPack window.
      state.turns.r3 = { id: 'r3', root: 'r3', botId: 'main', source: 'user', request: 'r3', hop: 0, status: 'succeeded', conclusion: 'succeeded',
        reported: true, authority: 'owner' };
      delete state.questions.q1; delete state.cards.c1;
    });
    const retention = { acknowledgedRoots: [turn], now: FIRST, retentionMs: MIN_TOMBSTONE_RETENTION_MS };
    await expect(store().retain(scope, retention, { contextTurnLimit: 1 })).rejects.toThrow('A routine occurrence of the root is open');
    await store().sync(scope, { ...SYNC, now: FIRST });
    expect(await store().retain(scope, retention, { contextTurnLimit: 1 })).toMatchObject({ archivedRoots: 1 });
  });
});
