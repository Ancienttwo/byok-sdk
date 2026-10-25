import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe } from 'vitest';
import type { DeviceTerminal, TaskAttempt } from '@byok-sdk/cloud';
import { hash, taskId, type Conclusion, type FrozenInput, type FrozenSubmitPort, type Intent, type RoutineDefinition } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import type { CommitResult } from '@byok-sdk/example-bot-collaboration/rules/commit';
import { routineVectors, type OccurrenceRow, type RoutineSubject } from '@byok-sdk/example-bot-collaboration/routine-vectors';
import { createDefinition } from '@byok-sdk/example-bot-collaboration/routines';
import { SYNC_OPTIONS } from '@byok-sdk/example-bot-collaboration/test-support';
import { HostedSubmitter } from './intents';
import { storedKey } from './layout';
import { openStore, POSTGRES_URL } from './postgres.test-support';
import type { TaskEvidence } from './reconcile';
import { hostedRoutineCommands, loadSlice, writeSlice } from './routines';
import { inSchema, lockScope } from './store';

let opened: Awaited<ReturnType<typeof openStore>> | undefined;
const store = () => opened!.store;
const table = (name: string) => `"${store().schema}".${name}`;
const query = <T extends object>(text: string, values: unknown[]) => opened!.pool.query<T>(text, values).then(found => found.rows);

/** An SDK tenant in memory that takes every submit. */
function fakePort(): FrozenSubmitPort {
  const offers = new Map<string, unknown>();
  return {
    submit: async input => {
      offers.set(input.taskId, { taskId: input.taskId, deviceId: input.deviceId, type: 'task.offer_for_agent_with_egress_fresh',
        payload: structuredClone(input.payload), delivered: true, messageId: `offer-${input.taskId}` });
      return undefined as never;
    },
    offer: async task => offers.get(task) as never,
  };
}
const turnOf = (result: CommitResult): string => {
  if (result.disposition.outcome !== 'accepted' || typeof result.disposition.value !== 'string') throw new Error('Input command has no Turn id');
  return result.disposition.value;
};

/** The H subject of the D2f-1 routine vectors: one scope of the shared test schema, seeded as the L Bot Host starts. */
async function hostedSubject(): Promise<RoutineSubject> {
  const scope = `tenant:${randomUUID()}`, execution = template('device', 'main'), revision = execution.payload.agentRef.profileRevision;
  let clock = Date.UTC(2026, 0, 1, 3);
  await store().seed(scope, state => {
    state.team.bots.main = { id: 'main', name: 'Main Bot', role: 'Team owner', persona: '', model: 'default', mainBot: true, archived: false,
      revision, readyRevision: revision, execution: structuredClone(execution) };
  });
  await store().bindDevice(scope, 'device');
  const submitter = new HostedSubmitter(opened!.pool, store().schema, { port: () => fakePort(), now: () => clock, leaseMs: 60_000, backoffMs: 1000 });
  const hostClock = () => clock;
  /** Runs the Host as the L pass does: the sync, then the submit of each FIFO head, then the sync again. */
  const run = async () => {
    await store().sync(scope, { ...SYNC_OPTIONS, now: clock, history: undefined });
    await submitter.run();
    await store().sync(scope, { ...SYNC_OPTIONS, now: clock, history: undefined });
  };
  const intentRow = async (key: string) => (await query<{ key: string; source: Intent['source']; input: FrozenInput; wait_until: string;
    retry_until: string | null; conclusion: Conclusion | null; tries: number }>(`SELECT key, source, input, wait_until::text, retry_until::text,
    conclusion, tries FROM ${table('intent')} WHERE scope = $1 AND key = $2`, [storedKey(scope), storedKey(key)]))[0];
  return {
    now: () => clock,
    at: now => { clock = now; },
    change: edit => store().seed(scope, edit),
    addRoutine: (owner, schedule) => inSchema(opened!.pool, store().schema, async client => {
      await lockScope(client, storedKey(scope));
      const slice = await loadSlice(client, storedKey(scope)), commands = hostedRoutineCommands(slice, clock);
      const definition = createDefinition(commands.list(), owner, taskId(`seed:${owner}`, 0), 0, { localId: 'new_routine_1', schedule, prompt: 'Daily report' }, 'bot');
      commands.create(definition);
      await writeSlice(client, storedKey(scope), slice);
      return definition.id;
    }),
    input: async (key, request) => {
      const result = await store().commit(scope, { scope, commandId: hash(['input', 'main', key]),
        command: { kind: 'input', botId: 'main', key, request, sender: 'owner' } }, hostClock);
      await run();
      return turnOf(result);
    },
    start: async turnId => {
      await run();
      if (!((await intentRow(turnId))!.tries > 0)) throw new Error('The submitter did not try the intent');
    },
    finish: async (turnId, document) => {
      const task = taskId(turnId, 0);
      const evidence = { terminal: { envelope: { task_id: task, type: 'task.complete', payload: { document } } } as unknown as DeviceTerminal,
        attempt: { taskId: task } as unknown as TaskAttempt } satisfies TaskEvidence;
      await store().finish(scope, turnId, evidence, hostClock);
      await run();
    },
    fire: async id => { await store().fire(scope, id, clock); await run(); },
    sync: run,
    // A keyless owner command, as L `cancelTurn`: its id is new at each call.
    cancelTurn: async turnId => {
      await store().commit(scope, { scope, commandId: randomUUID(), command: { kind: 'cancel_turn', turnId } }, hostClock);
      await run();
    },
    update: async action => { await store().updateRoutine(scope, 'main', action, clock); await run(); },
    lifecycle: async (id, value) => { await store().setRoutineLifecycle(scope, 'main', id, value, clock); await run(); },
    // A keyless owner command, as L `endRoutine`, by the Main Bot.
    end: async id => {
      await store().commit(scope, { scope, commandId: randomUUID(), command: { kind: 'end_routine', botId: 'main', routineId: id } }, hostClock);
      await run();
    },
    routine: async id => {
      const row = (await query<{ definition: RoutineDefinition; pending: RoutineDefinition | null; lifecycle: RoutineSubjectRow['lifecycle'];
        status: RoutineSubjectRow['status']; next_at: string | null; calendar_errors: unknown[] | null }>(`SELECT definition, pending, lifecycle, status,
        next_at::text, calendar_errors FROM ${table('routine')} WHERE scope = $1 AND id = $2`, [storedKey(scope), storedKey(id)]))[0];
      return row && { id, version: row.definition.version, pending: row.pending?.version ?? null, lifecycle: row.lifecycle, status: row.status,
        nextAt: row.next_at === null ? null : Number(row.next_at), calendarErrors: row.calendar_errors?.length ?? 0 };
    },
    // The predicate of the scheduler's `routine_due` index.
    reserved: async id => (await query<{ next_at: string }>(`SELECT next_at::text FROM ${table('routine')} WHERE scope = $1 AND id = $2
      AND lifecycle = 'active' AND next_at IS NOT NULL`, [storedKey(scope), storedKey(id)])).map(row => Number(row.next_at)),
    occurrences: async id => (await query<{ key: string; definition_version: number; trigger_kind: OccurrenceRow['trigger']['kind']; planned_at: string;
      recorded_at: string; next_at: string | null; execution_superseded: boolean; conclusion: Conclusion | null; intent: string | null;
      intent_conclusion: Conclusion | null }>(`SELECT o.key, o.definition_version, o.trigger_kind, o.planned_at::text, o.recorded_at::text, o.next_at::text,
      o.execution_superseded, o.conclusion, i.key AS intent, i.conclusion AS intent_conclusion FROM ${table('occurrence')} o
      LEFT JOIN ${table('intent')} i ON i.scope = o.scope AND i.key = '"occurrence:' || (o.key::json #>> '{}') || '"'
      WHERE o.scope = $1 AND o.routine_id = $2 ORDER BY o.planned_at`, [storedKey(scope), storedKey(id)]))
      .map(row => ({ key: JSON.parse(row.key) as string, routineId: id, version: row.definition_version,
        trigger: { kind: row.trigger_kind, plannedAt: Number(row.planned_at) }, recordedAt: Number(row.recorded_at),
        nextAt: row.next_at === null ? null : Number(row.next_at), executionSuperseded: row.execution_superseded, promoted: row.intent !== null,
        conclusion: row.intent !== null ? row.intent_conclusion : row.conclusion })),
    intent: async key => {
      const row = await intentRow(key);
      return row && { key: JSON.parse(row.key) as string, source: row.source, waitUntil: Number(row.wait_until),
        retryUntil: row.retry_until === null ? null : Number(row.retry_until), conclusion: row.conclusion, tried: row.tries > 0,
        instruction: row.input.payload.instruction as string };
    },
    state: () => store().read(scope),
  };
}
type RoutineSubjectRow = NonNullable<Awaited<ReturnType<RoutineSubject['routine']>>>;

describe.skipIf(POSTGRES_URL === undefined)('H routine vectors on real Postgres (#793 D2f-4)', () => {
  beforeAll(async () => { opened = await openStore(); });
  afterAll(async () => { await opened?.close(); });
  routineVectors('H HostedCollaborationStore on Postgres', hostedSubject);
});
