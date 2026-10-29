import { checkRoutineSchedule, nextRoutineOccurrence, type RoutineSchedule } from '@byok-sdk/core';
import { hash as hostKey, type ExecutionTemplate, type HostExecutionCore, type Json, type LedgerState, type NextOccurrence,
  type Routine, type AgentRoutineDefinition } from '@byok-sdk/server/execution-core';
import type { ByokServer } from '@byok-sdk/server';
import { RequiredToolsetsSchema, TerminalProjectionSelectionSchema, type TerminalProjectionSelection } from '@byok-sdk/protocol';
import type { ScopedTool } from './http';
import type { BetaLedger } from './ledger';
import { BetaError, canonicalJson, invalid, object, taskArguments, text, type Caller, type RoutineReservation,
  type TaskArguments } from './model';
import { input, integer, json, selectDevice } from './tools';

/** Opaque result contract on the offers of routines that send a resultSchema. */
export const ROUTINE_RESULT_CONTRACT = 'byok-mcp-routine-v1';

/**
 * The K4 calendar for beta routines. Inject it as the Host core's `nextOccurrence`.
 * The rule is the `RoutineSchedule` itself, and its `tz` is the definition's time zone.
 */
export const routineScheduleCalendar: NextOccurrence = (definition, after) => {
  const schedule = definition.rule;
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule) || schedule.tz !== definition.timeZone) {
    throw new Error('A beta routine rule is a RoutineSchedule in the definition time zone');
  }
  return nextRoutineOccurrence(schedule as unknown as RoutineSchedule, after);
};

export interface RoutineToolOptions {
  readonly sdk: Pick<ByokServer, 'machines'>;
  readonly ledger: BetaLedger;
  /**
   * The Host's own K4 core, created with `nextOccurrence: routineScheduleCalendar`
   * and installed as the SDK's `wake.consume`. The tools create no second scheduler.
   */
  readonly core: Pick<HostExecutionCore, 'addRoutine' | 'lifecycle' | 'ledger'>;
  /** The Host's egress policy for routine occurrences. The device must accept it. */
  readonly egressPolicy: ExecutionTemplate['payload']['egressPolicy'];
  /** How long one occurrence may wait for its device before it expires. */
  readonly waitMs: number;
  /** An occurrence recorded later than this after its planned time is a catch-up. */
  readonly lateAfterMs: number;
}

const MAX_LIST_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 20;
const routineIdProperty = { type: 'string', description: 'A routineId that byok_routine_create returned to this key.' } as const;

interface RoutineInput {
  readonly localId: string;
  /** The idempotency definition. Its hash binds the local ID. */
  readonly definition: { schedule: RoutineSchedule; task: TaskArguments };
  readonly terminalProjection: TerminalProjectionSelection;
}
function routineInput(args: Readonly<Record<string, unknown>> | undefined): RoutineInput {
  const value = input(args, ['localId', 'schedule', 'task'], ['localId', 'schedule', 'task']);
  const localId = text(value.localId);
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(localId)) invalid();
  const schedule = object(JSON.parse(canonicalJson(value.schedule))) as unknown as RoutineSchedule;
  const check = checkRoutineSchedule(schedule);
  if (!check.ok) throw new BetaError('invalid_input', `${check.code}: ${check.message}`);
  const task = taskArguments(value.task);
  // An occurrence takes its identity from (routineId, version, t), and the SDK has no workspace selection.
  if (task.clientRequestId !== undefined) throw new BetaError('invalid_input', 'A routine task takes no clientRequestId');
  if (task.workspace !== undefined) throw new BetaError('invalid_input', 'workspace selection is not available for beta routines');
  if (task.toolsets !== undefined && !RequiredToolsetsSchema.safeParse(task.toolsets).success) invalid();
  const projection = TerminalProjectionSelectionSchema.safeParse(task.resultSchema === undefined ? { mode: 'none' }
    : { mode: 'result-document', contract: ROUTINE_RESULT_CONTRACT, schema: task.resultSchema });
  if (!projection.success) throw new BetaError('invalid_input', 'resultSchema is not a supported result schema');
  return { localId, definition: { schedule, task }, terminalProjection: projection.data };
}
function iso(at: number | undefined): string | null { return at === undefined ? null : new Date(at).toISOString(); }
const routineOf = (state: LedgerState, routineId: string): (Routine & { definition: AgentRoutineDefinition }) | undefined => {
  const routine = state.routines[hostKey(routineId)];
  if (!routine) return undefined;
  if (!routine.definition.execution || routine.definition.hostJob) throw new Error('MCP routine must have an Agent execution');
  return { ...routine, definition: routine.definition };
};

/** Completes one routine on K4, then frees its slot. K4 commits before it flushes the wake cancellation. */
async function complete(ledger: BetaLedger, core: RoutineToolOptions['core'], routineId: string, slotReleased: boolean): Promise<void> {
  const routine = routineOf(core.ledger.snapshot(), routineId);
  if (routine && routine.lifecycle !== 'completed') {
    try { await core.lifecycle(routineId, 'completed'); }
    catch (error) { if (routineOf(core.ledger.snapshot(), routineId)?.lifecycle !== 'completed') throw error; }
  }
  // Without a K4 routine nothing is scheduled. Releasing the slot also stops a retried create from scheduling it.
  if (!slotReleased) ledger.releaseRoutineSlot(routineId);
}

/**
 * A revoked key starts no new routine occurrence; one already started finishes.
 * `createRoutineTools` runs this on each revocation. Call it at Host startup too,
 * after `core.recover()`, to finish a retirement that a crash interrupted.
 */
export async function retireRevokedRoutines(ledger: BetaLedger, core: RoutineToolOptions['core']): Promise<void> {
  // lifecycle commits synchronously before awaiting wake I/O. Start every retirement
  // first, so one slow cancellation cannot leave another revoked routine active.
  await Promise.all(ledger.revokedRoutines().map(routineId => complete(ledger, core, routineId, false)));
}

/** The B4 routine catalogue on K4's routine ledger. The beta ledger owns only key ownership and the routine slot. */
export function createRoutineTools(options: RoutineToolOptions): ScopedTool[] {
  const { sdk, ledger, core } = options;
  // Revocation is durable before listeners run; a failure here is finished by the next startup retirement.
  ledger.onRevocation(() => { void retireRevokedRoutines(ledger, core).catch(() => undefined); });
  const current = (routineId: string) => routineOf(core.ledger.snapshot(), routineId);

  function definition(caller: Caller, reservation: RoutineReservation, deviceId: string, parsed: RoutineInput): AgentRoutineDefinition {
    const key = ledger.authorize(caller, 'routines.write');
    if (!key.agentRef) throw new Error('A routine grant has no AgentRef');
    const { schedule, task } = parsed.definition;
    return { id: reservation.routineId, version: 1, timeZone: schedule.tz, rule: schedule as unknown as Json,
      execution: { deviceId, payload: { runtime: task.runtime, session: { mode: 'fresh' }, instruction: task.instruction, agentRef: key.agentRef,
        egressPolicy: options.egressPolicy, terminalProjection: parsed.terminalProjection,
        ...(task.toolsets ? { requiredToolsets: [...task.toolsets] } : {}) } },
      waitMs: options.waitMs, lateAfterMs: options.lateAfterMs };
  }
  /** The routine as K4 holds it. A reservation that K4 never committed is `reserved`; a released one is `completed`. */
  function view(state: LedgerState, reservation: RoutineReservation) {
    const routine = routineOf(state, reservation.routineId);
    return { routineId: reservation.routineId,
      lifecycle: routine?.lifecycle ?? (reservation.slotReleased ? 'completed' : 'reserved'),
      ...(routine ? { status: routine.status } : {}),
      nextAt: iso(routine?.next?.availableAt) };
  }
  /** The newest occurrence and its K4 conclusion. The document is K4's terminal record, not a second copy. */
  function lastOccurrence(state: LedgerState, routineId: string) {
    let last: LedgerState['occurrences'][string] | undefined;
    for (const row of Object.values(state.occurrences)) {
      if (row.routineId === routineId && (!last || row.trigger.plannedAt > last.trigger.plannedAt)) last = row;
    }
    if (!last) return undefined;
    if (!last.intentId) throw new Error('MCP routine occurrence must have an Agent intent');
    const intent = state.intents[last.intentId]!;
    const envelope = state.executions[intent.taskId]?.terminal?.envelope;
    const document = intent.conclusion === 'succeeded' && envelope?.type === 'task.complete' && envelope.payload.sealed === undefined ? envelope.payload.document : undefined;
    return { plannedAt: iso(last.trigger.plannedAt), trigger: last.trigger.kind, taskId: intent.taskId, attempts: intent.attempts,
      ...(intent.conclusion === undefined ? {} : { conclusion: intent.conclusion }), ...(document === undefined ? {} : { document }) };
  }

  return [
    {
      scope: 'routines.write',
      definition: { name: 'byok_routine_create',
        description: 'Run a coding task on a schedule on a paired byok device. Each due time starts one task. '
          + 'The same localId with the same arguments returns the same routine (deduplicated: true). A routine never changes; '
          + 'to change one, cancel it and create another with a new localId.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['localId', 'schedule', 'task'], properties: {
          localId: { type: 'string', description: 'Your own id for this routine: 1-160 letters, digits, dot, underscore, colon or hyphen.' },
          schedule: { type: 'object', description: 'One local time on matching days: { minute, hour, tz } plus optional daysOfWeek '
            + '(mon..sun) or dayOfMonth (1-31, optional month 1-12). tz is an IANA zone name.' },
          task: { type: 'object', additionalProperties: false, required: ['runtime', 'instruction'], properties: {
            runtime: { type: 'string', description: 'A runtime this key may use (see byok_runtimes).' },
            instruction: { type: 'string', description: 'The task for the coding agent. At most 32 KiB.' },
            toolsets: { type: 'array', items: { type: 'string' }, description: 'Device-configured MCP toolset ids the task needs.' },
            resultSchema: { type: 'object', description: 'Optional JSON schema of the structured result each run must submit.' },
          } },
        } } },
      async call(caller, args) {
        const parsed = routineInput(args);
        let reservation = ledger.lookupRoutine(caller, parsed.localId, parsed.definition);
        let deviceId: string | undefined;
        if (!reservation) {
          const key = ledger.authorize(caller, 'routines.write');
          if (!key.runtimes.includes(parsed.definition.task.runtime)) throw new BetaError('forbidden', 'Device or runtime not granted');
          deviceId = await selectDevice(sdk, key, parsed.definition.task.runtime);
          reservation = ledger.reserveRoutine(caller, parsed.localId, parsed.definition);
        } else if (!reservation.slotReleased && !current(reservation.routineId)) {
          // A retry after a failure before K4 committed the routine. Select again, then reread the reservation.
          deviceId = await selectDevice(sdk, ledger.authorize(caller, 'routines.write'), parsed.definition.task.runtime);
          reservation = ledger.lookupRoutine(caller, parsed.localId, parsed.definition)!;
        }
        // A released reservation reads back only; it never schedules again. K4 commits in addRoutine's synchronous
        // part, so no other call can release the slot between this check and that commit.
        if (deviceId !== undefined && !reservation.slotReleased && !current(reservation.routineId)) {
          try { await core.addRoutine(definition(caller, reservation, deviceId, parsed)); }
          catch {
            // A failed wake flush leaves the committed routine and its durable outbox. Only a missing routine fails.
            if (!current(reservation.routineId)) throw new BetaError('unavailable', 'The routine was admitted but not scheduled. Retry the same call.', 1);
          }
        }
        const { routineId, lifecycle, nextAt } = view(core.ledger.snapshot(), reservation);
        return json({ routineId, lifecycle, nextAt, deduplicated: reservation.deduplicated });
      },
    },
    {
      scope: 'routines.read',
      definition: { name: 'byok_routine_list', description: 'List the routines this key created, newest first, with the next run time '
          + 'and the last run: its taskId, conclusion and, when it succeeded, its result document.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {
          cursor: { type: 'string', description: 'nextCursor from the previous page.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT },
        } } },
      async call(caller, args) {
        const value = input(args, ['cursor', 'limit']);
        const page = ledger.listRoutines(caller, { limit: integer(value.limit, 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT),
          ...(value.cursor === undefined ? {} : { cursor: text(value.cursor) }) });
        const state = core.ledger.snapshot();
        const routines = page.routines.map(reservation => {
          const routine = routineOf(state, reservation.routineId);
          // K4 completion is the only authority that frees a routine slot.
          if (routine?.lifecycle === 'completed' && !reservation.slotReleased) ledger.releaseRoutineSlot(reservation.routineId);
          const execution = routine?.definition.execution.payload;
          const last = lastOccurrence(state, reservation.routineId);
          return { ...view(state, reservation), localId: reservation.localId, createdAt: iso(reservation.createdAt),
            ...(routine ? { schedule: routine.definition.rule, runtime: execution?.runtime } : {}),
            ...(last ? { lastOccurrence: last } : {}) };
        });
        return json({ routines, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
      },
    },
    {
      scope: 'routines.write',
      definition: { name: 'byok_routine_cancel', description: 'Stop a routine. It starts no new runs; a run already started finishes. '
          + 'Safe to repeat. A cancelled routine cannot resume.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['routineId'], properties: { routineId: routineIdProperty } } },
      async call(caller, args) {
        const value = input(args, ['routineId'], ['routineId']);
        const reservation = ledger.requireRoutine(caller, text(value.routineId), 'routines.write');
        await complete(ledger, core, reservation.routineId, reservation.slotReleased);
        return json({ routineId: reservation.routineId, state: 'completed' });
      },
    },
  ];
}
