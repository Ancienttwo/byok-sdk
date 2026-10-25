import type { PoolClient } from 'pg';
import { applyPlan, auditCalendarError, canonical, DEFAULT_RETRY, hash, nextWake, recordOccurrence, routineCommands, scheduleNext, switchVersion,
  versionSwitchDue, type FrozenInput, type HostJobHandler, type Intent, type Json, type LedgerState, type Occurrence, type Routine,
  type RoutineCommands, type RoutineDefinition } from '@byok-sdk/example-host-execution-core';
import { BOT_ROUTINE, createDefinition, owned, routineCalendar, routineTurn, updateDefinition } from '@byok-sdk/example-bot-collaboration/routines';
import type { CommandPorts } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { storedKey } from './layout';

/**
 * The K4 routine rows of one scope, loaded under the scope lock (#793 D2f). H runs the K4 routine rules on this slice and
 * writes back what changed, so it re-derives no routine rule in SQL (scheduler note §2.0).
 */
export interface RoutineSlice {
  readonly state: LedgerState;
  /** The loaded rows, to diff against after the K4 calls. */
  readonly before: Pick<LedgerState, 'routines' | 'occurrences' | 'intents'>;
}
type RoutineRow = { id: string; definition: RoutineDefinition; pending: RoutineDefinition | null; lifecycle: Routine['lifecycle'];
  status: Routine['status']; next_at: string | null; calendar_errors: Routine['calendarErrors'] | null };
type OccurrenceRow = { key: string; routine_id: string; definition_version: number; trigger_kind: Occurrence['trigger']['kind']; planned_at: string;
  recorded_at: string; next_at: string | null; execution_superseded: boolean; job: { summary?: Json } | null };
type IntentRow = OccurrenceRow & { intent_key: string; ordinal: string; agent: string; input: FrozenInput; wait_until: string; tries: number;
  retry_until: string | null; cancel_reason: Intent['cancelReason'] | null };

const OCCURRENCE_COLUMNS = `o.key, o.routine_id, o.definition_version, o.trigger_kind, o.planned_at::text, o.recorded_at::text, o.next_at::text,
  o.execution_superseded, o.job`;
// The intent key of an occurrence: JSON.stringify(`occurrence:${key}`). A K4 occurrence key is hex, so JSON adds no escapes.
const INTENT_OF = `'"occurrence:' || (o.key::json #>> '{}') || '"'`;
// The occurrence key of a routine intent, so the join uses the occurrence primary key: 'occurrence:' is 11 characters.
const OCCURRENCE_OF = `'"' || substr(i.key::json #>> '{}', 12) || '"'`;
const slot = (id: string, version: number, at: number) => `${id}:${version}:${at}`;
/** The outbox key of the Host job row of occurrence `occurrenceKey` (#793 S14). */
export const hostJobRowKey = (occurrenceKey: string) => JSON.stringify(['host_job', occurrenceKey]);

function occurrence(row: OccurrenceRow, intentKey?: string): Occurrence {
  const routineId = JSON.parse(row.routine_id) as string, plannedAt = Number(row.planned_at);
  const superseded = row.execution_superseded ? { executionSuperseded: true as const } : {};
  // A Host job keeps its tries in its outbox row, so `attempts` here is 0: no K4 routine rule reads it.
  const pending = row.job ? { job: { attempts: 0, ...row.job, ...superseded } } : { hook: superseded };
  return { key: JSON.parse(row.key) as string, routineId, definitionVersion: row.definition_version, trigger: { kind: row.trigger_kind, plannedAt },
    wakeKey: slot(routineId, row.definition_version, plannedAt), recordedAt: Number(row.recorded_at), nextAt: row.next_at === null ? null : Number(row.next_at),
    attempts: 0, ...pending, ...(intentKey === undefined ? {} : { intentId: hash(intentKey) }) };
}

/**
 * Loads every routine of the scope in insertion order, and its open occurrences: one with no intent and no conclusion, or
 * one whose intent `occurrence:<key>` has no conclusion. A promoted occurrence keeps `conclusion IS NULL` for good (DDL D5),
 * so its intent decides whether it is open. The caller holds the scope lock.
 */
export async function loadSlice(client: PoolClient, scopeKey: string): Promise<RoutineSlice> {
  const state: LedgerState = { version: 1, sequence: 0, scanSequence: 0, intents: {}, executions: {}, routines: {}, occurrences: {}, slots: {},
    outbox: {}, applied: {}, application: {}, scanWake: null };
  const routines = await client.query<RoutineRow>(`SELECT id, definition, pending, lifecycle, status, next_at::text, calendar_errors FROM routine
    WHERE scope = $1 ORDER BY ordinal`, [scopeKey]);
  for (const row of routines.rows) {
    const nextAt = row.next_at === null ? null : Number(row.next_at);
    state.routines[hash(row.definition.id)] = { definition: row.definition, ...(row.pending ? { pending: row.pending } : {}), lifecycle: row.lifecycle,
      status: row.status, next: nextAt === null ? null : { dedupKey: slot(row.definition.id, row.definition.version, nextAt), availableAt: nextAt },
      ...(row.calendar_errors ? { calendarErrors: row.calendar_errors } : {}) };
  }
  const unpromoted = await client.query<OccurrenceRow>(`SELECT ${OCCURRENCE_COLUMNS} FROM occurrence o WHERE o.scope = $1 AND o.conclusion IS NULL
    AND NOT EXISTS (SELECT 1 FROM intent i WHERE i.scope = o.scope AND i.key = ${INTENT_OF}) ORDER BY o.ordinal`, [scopeKey]);
  for (const row of unpromoted.rows) state.occurrences[JSON.parse(row.key) as string] = occurrence(row);
  const promoted = await client.query<IntentRow>(`SELECT ${OCCURRENCE_COLUMNS}, i.key AS intent_key, i.ordinal::text, i.agent, i.input, i.wait_until::text,
    i.tries, i.retry_until::text, i.cancel_reason FROM intent i JOIN occurrence o ON o.scope = i.scope AND o.key = ${OCCURRENCE_OF}
    WHERE i.scope = $1 AND i.source = 'routine' AND i.conclusion IS NULL ORDER BY i.ordinal`, [scopeKey]);
  for (const row of promoted.rows) {
    const key = JSON.parse(row.intent_key) as string, { taskId, ...execution } = row.input;
    state.occurrences[JSON.parse(row.key) as string] = occurrence(row, key);
    // Only the fields that K4 routine rules read. H has no generations, so a tried row is inflight. `retry` is the K4
    // default in memory only: H stores no retry policy and never retries.
    state.intents[hash(key)] = { id: hash(key), key, source: 'routine', execution, waitUntil: Number(row.wait_until), retry: DEFAULT_RETRY, agent: row.agent,
      sequence: Number(row.ordinal), phase: row.tries === 0 ? 'queued' : 'inflight', generation: 0, taskId, notBefore: 0, attempts: row.tries,
      occurrence: JSON.parse(row.key) as string, ...(row.retry_until === null ? {} : { retryUntil: Number(row.retry_until) }),
      ...(row.cancel_reason === null ? {} : { cancelReason: row.cancel_reason }) };
  }
  return { state, before: structuredClone({ routines: state.routines, occurrences: state.occurrences, intents: state.intents }) };
}

const routineColumns = (routine: Routine) => [JSON.stringify(routine.definition), routine.pending ? JSON.stringify(routine.pending) : null,
  routine.lifecycle, routine.status, routine.next?.availableAt ?? null, routine.calendarErrors?.length ? JSON.stringify(routine.calendarErrors) : null];

/**
 * Writes the slice diff: routine rows, the superseded flag and the conclusion of an occurrence with no intent, and the
 * `retry_until` and conclusion of loaded intents. The K4 fields with no H reader stay behind: the slice outbox,
 * `attempts`, `slotReplayCount`, `ignoredWakes`, `sequence`, and the conclusion that K4 copies onto a promoted occurrence.
 * A promotion writes its own intent row. Only the scheduler's fire adds an occurrence: `recorded` is its key. A Host job
 * occurrence gets its `host_job` outbox row with it, in place of the K4 `host-job:<key>` row (#793 S14); only the Host job
 * settle writes its summary. The caller holds the scope lock.
 */
export async function writeSlice(client: PoolClient, scopeKey: string, slice: RoutineSlice, recorded?: string): Promise<void> {
  const { state, before } = slice;
  for (const id of Object.keys(before.routines)) if (!state.routines[id]) throw new Error('A routine row cannot be removed');
  for (const [id, routine] of Object.entries(state.routines)) {
    const { definition, next } = routine;
    // H stores only `next_at`, so the K4 reservation must be the one that `next_at` rebuilds.
    if (next && (next.payload !== undefined || next.dedupKey !== slot(definition.id, definition.version, next.availableAt))) {
      throw new Error('A routine reservation differs from its stored slot');
    }
    if (definition.hostOccurrence?.type !== BOT_ROUTINE && !definition.hostJob) throw new Error('H runs only bot-routine and Host job routines');
    const prior = before.routines[id];
    if (!prior) {
      await client.query(`INSERT INTO routine (scope, id, ordinal, definition, pending, lifecycle, status, next_at, calendar_errors)
        SELECT $1, $2, coalesce(max(ordinal) + 1, 0), $3::json, $4::json, $5, $6, $7, $8::json FROM routine WHERE scope = $1`,
      [scopeKey, storedKey(definition.id), ...routineColumns(routine)]);
    } else if (canonical(routineColumns(prior)) !== canonical(routineColumns(routine))) {
      await client.query(`UPDATE routine SET definition = $3::json, pending = $4::json, lifecycle = $5, status = $6, next_at = $7, calendar_errors = $8::json
        WHERE scope = $1 AND id = $2`, [scopeKey, storedKey(definition.id), ...routineColumns(routine)]);
    }
  }
  for (const [key, row] of Object.entries(state.occurrences)) {
    const prior = before.occurrences[key];
    if (!prior) {
      if (key !== recorded) throw new Error('H records occurrences only in its scheduler');
      await client.query(`INSERT INTO occurrence (scope, key, ordinal, routine_id, definition_version, trigger_kind, planned_at, recorded_at, next_at, job)
        SELECT $1, $2, coalesce(max(ordinal) + 1, 0), $3, $4, $5, $6, $7, $8, $9::json FROM occurrence WHERE scope = $1`,
      [scopeKey, storedKey(key), storedKey(row.routineId), row.definitionVersion, row.trigger.kind, row.trigger.plannedAt, row.recordedAt, row.nextAt,
        row.job ? '{}' : null]);
      if (row.job) {
        await client.query(`INSERT INTO outbox (scope, key, ordinal, kind) SELECT $1, $2, coalesce(max(ordinal) + 1, 0), 'host_job'
          FROM outbox WHERE scope = $1`, [scopeKey, hostJobRowKey(key)]);
      }
      continue;
    }
    if (prior.intentId !== undefined || row.intentId !== undefined) continue;
    const superseded = (o: Occurrence) => !!(o.job ?? o.hook)?.executionSuperseded;
    if (superseded(row) !== superseded(prior) || row.conclusion !== prior.conclusion) {
      await client.query(`UPDATE occurrence SET execution_superseded = $3, conclusion = $4 WHERE scope = $1 AND key = $2 AND conclusion IS NULL`,
        [scopeKey, storedKey(key), superseded(row), row.conclusion ?? null]);
    }
  }
  for (const [id, prior] of Object.entries(before.intents)) {
    const row = state.intents[id]!;
    if (row.retryUntil === prior.retryUntil && row.conclusion === prior.conclusion) continue;
    await client.query('UPDATE intent SET retry_until = $3, conclusion = coalesce(conclusion, $4) WHERE scope = $1 AND key = $2',
      [scopeKey, storedKey(row.key), row.retryUntil ?? null, row.conclusion ?? null]);
  }
}

/**
 * K4 `switchVersions` for H, which has no drain: each transaction that can conclude routine work calls it last, after its
 * own writes, so the fresh slice sees them (scheduler note §2.5). A staged version replaces the definition once no old
 * work can use it. The caller holds the scope lock.
 */
export async function switchDueVersions(client: PoolClient, scopeKey: string, now: number): Promise<void> {
  if (!(await client.query('SELECT 1 FROM routine WHERE scope = $1 AND pending IS NOT NULL LIMIT 1', [scopeKey])).rows[0]) return;
  const slice = await loadSlice(client, scopeKey);
  for (const routine of Object.values(slice.state.routines)) {
    if (versionSwitchDue(routine, Object.values(slice.state.occurrences), now)) switchVersion(slice.state, routine, now, routineCalendar);
  }
  await writeSlice(client, scopeKey, slice);
}

/** Routine `id` when it is active and its reserved slot is due at `now`. */
export function dueRoutine(slice: RoutineSlice, id: string, now: number): Routine | undefined {
  const routine = slice.state.routines[hash(id)];
  return routine?.lifecycle === 'active' && routine.next && routine.next.availableAt <= now ? routine : undefined;
}
/**
 * K4 `recordOccurrence` for the due slot of `routine` (scheduler note §2.2 step 4). The wake comes from the row that the caller
 * holds under the scope lock, so the K4 reservation checks pass. H has no SDK wake: K4 reads only the slot key, its time and
 * the absent payload.
 */
export function recordDue(slice: RoutineSlice, scope: string, routine: Routine, now: number): Occurrence {
  const { dedupKey, availableAt } = routine.next!;
  const occurrence = recordOccurrence(slice.state, scope, { wakeId: dedupKey, dedupKey, availableAt, deliveredAt: now, delivery: 1 }, now, routineCalendar);
  if (!occurrence?.hook && !occurrence?.job) throw new Error('A due routine slot recorded no occurrence');
  return occurrence;
}

/**
 * The K4 schedule upkeep of one scope's routines (scheduler note §2.6). `start`: K4 `recover` re-plans an active routine
 * that had no slot within the horizon. Each pass: K4 `scheduleNext` sets `ok` once a `schedule_retrying` slot is within the
 * horizon. H keeps no wake, so the K4 outbox rows that these functions write stay behind.
 */
export function planSlice(slice: RoutineSlice, now: number, phase: 'start' | 'pass'): void {
  for (const routine of Object.values(slice.state.routines)) {
    if (phase === 'start' && routine.lifecycle === 'active' && routine.status === 'no_occurrence_within_horizon' && !routine.pending) {
      try { applyPlan(slice.state, routine, nextWake(routine.definition, now, routineCalendar, now), now); }
      catch (error) { auditCalendarError(routine, now, error); }
    } else if (routine.status === 'schedule_retrying') scheduleNext(slice.state, routine, now);
  }
}

/**
 * A Bot and the owner add only `bot-routine` routines (#793 §53c). Host code adds Host job routines through `hostJobCommands`
 * (#793 S14). An `execution` routine stays refused: no K8 Turn could settle its intent.
 */
function botRoutineOnly(definition: RoutineDefinition): void {
  if (definition.hostOccurrence?.type !== BOT_ROUTINE || definition.execution !== undefined || definition.hostJob !== undefined) {
    throw new Error('H runs only bot-routine routines');
  }
}
/** The K4 routine commands on the slice, with the K8 calendar and the `bot-routine` hook. A refused command changes nothing. */
export function hostedRoutineCommands(slice: RoutineSlice, now: number): RoutineCommands {
  const commands = routineCommands(slice.state, { now: () => now, nextTime: routineCalendar, hostJobs: new Map(),
    occurrenceHooks: new Map([[BOT_ROUTINE, routineTurn]]) });
  return { ...commands,
    create: definition => { botRoutineOnly(definition); commands.create(definition); },
    update: definition => { botRoutineOnly(definition); commands.update(definition); } };
}
/**
 * The K4 routine commands of the Host's own Host job routines (#793 S14), as L's `core.addRoutine`, `updateRoutine` and
 * `lifecycle`, with the Host's handlers. They take only Host job routines, so a Bot routine stays under its Bot policy.
 */
export function hostJobCommands(slice: RoutineSlice, now: number, hostJobs: ReadonlyMap<string, HostJobHandler>): Omit<RoutineCommands, 'list'> {
  const commands = routineCommands(slice.state, { now: () => now, nextTime: routineCalendar, hostJobs, occurrenceHooks: new Map() });
  const hostJobOnly = (definition: RoutineDefinition) => {
    if (definition.hostJob === undefined) throw new Error('Host code adds only Host job routines');
  };
  return {
    create: definition => { hostJobOnly(definition); commands.create(definition); },
    update: definition => { hostJobOnly(definition); commands.update(definition); },
    lifecycle: (id, lifecycle) => {
      if (!commands.list().find(row => row.definition.id === id)?.definition.hostJob) throw new Error('No Host job routine has this id');
      commands.lifecycle(id, lifecycle);
    },
  };
}
/** The outcome ports of the routine actions of task `taskId`, with the K8 Bot policy, as L binds them (K8 host.ts:291-293). */
export function outcomeRoutinePorts(slice: RoutineSlice, now: number, taskId: string): Pick<NonNullable<CommandPorts['outcome']>,
  'createRoutine' | 'updateRoutine' | 'cancelRoutine'> {
  const commands = hostedRoutineCommands(slice, now);
  return {
    createRoutine: (turn, action, index) => commands.create(createDefinition(commands.list(), turn.botId, taskId, index, action, turn.authority ?? 'bot')),
    updateRoutine: (turn, action) => commands.update(updateDefinition(commands.list(), turn.botId, action)),
    cancelRoutine: (turn, action) => commands.lifecycle(owned(commands.list(), turn.botId, action.routineId).definition.id, 'completed'),
  };
}
