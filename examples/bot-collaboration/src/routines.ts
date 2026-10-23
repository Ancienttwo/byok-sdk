import { checkRoutineSchedule, nextRoutineOccurrence, type RoutineSchedule } from '@byok-sdk/core';
import type { CreateRoutineAction, RoutineScheduleFields, UpdateRoutineAction } from '@byok-sdk/protocol';
import { concludeOccurrence, hash, type HostOccurrenceRoutineDefinition, type HostOccurrenceRun, type LedgerState, type NextOccurrence,
  type Routine } from '@byok-sdk/example-host-execution-core';
import { addTurn, json, type Authority, type CollaborationState, type Turn } from './model';

// Bot policy over K4 routines. K4 owns the routine rows, versions, slots, occurrences and wakes.

/** The K4 occurrence hook of Bot routines. Other K4 routines of the Host are not Bot routines. */
export const BOT_ROUTINE = 'bot-routine';
/** A routine Turn expires this long after K4 records its occurrence. */
export const ROUTINE_WAIT_MS = 300_000;
/** A delivery later than this after its planned time is a catch-up. */
export const ROUTINE_LATE_AFTER_MS = 60_000;
/** A routine Turn id is its K4 intent key: `occurrence:<occurrence key>`. */
const ROUTINE_TURN = 'occurrence:';

/** Fixed at creation. Owner and authority never change between versions. */
export type BotRoutineInput = { owner: string; authority: Authority; prompt: string };
/** The ContextPack view of one Bot routine. */
export interface BotRoutine {
  id: string; owner: string; current: number; pending: number | null; lifecycle: Routine['lifecycle']; status: Routine['status'];
  definition: { version: number; schedule: RoutineScheduleFields; prompt: string; target: string };
  lastError?: { at: number; message: string; wakeKey?: string };
}

/** The K4 calendar of the Bot Host core. A rule is a `RoutineSchedule` whose `tz` is the definition time zone. */
export const routineCalendar: NextOccurrence = (definition, after) => {
  const schedule = definition.rule;
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule) || schedule.tz !== definition.timeZone) {
    throw new Error('A routine rule is a RoutineSchedule in the definition time zone');
  }
  return nextRoutineOccurrence(schedule as unknown as RoutineSchedule, after);
};
function fields(routine: Routine): BotRoutineInput | undefined {
  const spec = routine.definition.hostOccurrence;
  return spec?.type === BOT_ROUTINE ? spec.input as BotRoutineInput : undefined;
}
function definition(id: string, version: number, schedule: RoutineScheduleFields, input: BotRoutineInput): HostOccurrenceRoutineDefinition {
  const check = checkRoutineSchedule(schedule);
  if (!check.ok) throw new Error(`${check.code}: ${check.message}`);
  const rule = 'daysOfWeek' in schedule ? { ...schedule, daysOfWeek: [...new Set(schedule.daysOfWeek)] } : schedule;
  return { id, version, timeZone: schedule.tz, rule: json(rule), waitMs: ROUTINE_WAIT_MS, lateAfterMs: ROUTINE_LATE_AFTER_MS,
    hostOccurrence: { type: BOT_ROUTINE, input } };
}
/** The Bot routines among the Host's K4 routine rows. */
export function botRoutines(routines: Iterable<Routine>): BotRoutine[] {
  const views: BotRoutine[] = [];
  for (const routine of routines) {
    const input = fields(routine);
    if (!input) continue;
    const { id, version, rule } = routine.definition;
    views.push({ id, owner: input.owner, current: version, pending: routine.pending?.version ?? null, lifecycle: routine.lifecycle, status: routine.status,
      definition: { version, schedule: rule as unknown as RoutineScheduleFields, prompt: input.prompt, target: input.owner },
      ...(routine.calendarErrors?.length ? { lastError: routine.calendarErrors.at(-1)! } : {}) });
  }
  return views;
}
/** The definition for `RoutineCommands.create`. Each owner has at most 8 routines that are not completed. */
export function createDefinition(routines: readonly Routine[], owner: string, taskId: string, index: number, action: CreateRoutineAction,
  authority: Authority): HostOccurrenceRoutineDefinition {
  if (action.target !== undefined) throw new Error('An ordinary Bot cannot supply target');
  if (routines.filter(routine => fields(routine)?.owner === owner && routine.lifecycle !== 'completed').length >= 8) throw new Error('Routine limit is 8');
  return definition(hash([taskId, 'create_routine', index]), 1, action.schedule, { owner, authority, prompt: action.prompt });
}
export function owned(routines: readonly Routine[], owner: string, id: string): Routine {
  const routine = routines.find(row => row.definition.id === id);
  if (!routine || fields(routine)?.owner !== owner || routine.lifecycle === 'completed') throw new Error('Routine is unavailable to this Bot');
  return routine;
}
/** The next version for `RoutineCommands.update`. It builds on `pending` when one is staged. */
export function updateDefinition(routines: readonly Routine[], owner: string, action: UpdateRoutineAction): HostOccurrenceRoutineDefinition {
  const routine = owned(routines, owner, action.routineId);
  if (action.schedule === undefined && action.prompt === undefined) throw new Error('An update must change schedule or prompt');
  const prior = routine.pending ?? routine.definition, input = prior.hostOccurrence!.input as BotRoutineInput;
  return definition(prior.id, prior.version + 1, action.schedule ?? prior.rule as unknown as RoutineScheduleFields,
    { ...input, prompt: action.prompt ?? input.prompt });
}
/** The `bot-routine` occurrence hook. It writes the routine Turn in the occurrence commit. `sync` promotes it. */
export function routineTurn(state: CollaborationState, run: HostOccurrenceRun): void {
  const input = run.input as BotRoutineInput, id = `${ROUTINE_TURN}${run.occurrenceKey}`;
  addTurn(state, { id, root: id, source: 'routine', request: input.prompt, botId: input.owner, hop: 0, authority: input.authority });
}
export function routineOccurrence(turn: Turn): string { return turn.id.slice(ROUTINE_TURN.length); }
/**
 * A routine Turn that ends without an intent concludes its open occurrence.
 * Then a staged version can switch, and `compact` can remove the row.
 */
export function concludeRoutineTurn(s: LedgerState, turn: Turn): boolean {
  const key = routineOccurrence(turn), occurrence = s.occurrences[key];
  if (!occurrence?.hook || occurrence.intentId || occurrence.conclusion) return false;
  concludeOccurrence(s, key, 'cancelled');
  return true;
}
