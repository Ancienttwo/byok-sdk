import { checkRoutineSchedule, nextRoutineOccurrence, type RoutineSchedule } from '@byok-sdk/core';
import { TaskOfferSealedPayloadSchema, type CreateRoutineAction, type RoutineScheduleFields, type UpdateRoutineAction } from '@byok-sdk/protocol';
import { canonical, concludeOccurrence, hash, occurrenceIntentKey, occurrenceOfIntentKey, type ExecutionTemplate, type HostOccurrenceRoutineDefinition, type HostOccurrenceRun, type LedgerState,
  type NextOccurrence, type Routine } from '@byok-sdk/server/execution-core';
import { addTurn, json, type Authority, type CollaborationState, type Turn } from './model';
import { SYSTEM_PROMPT } from './rules/schema';
import type { SealedRoutineTemplate } from './rules/sync';
import type { SealedRoutineRef } from './rules/turn';

export type { SealedRoutineTemplate } from './rules/sync';

// Bot policy over K4 routines. K4 owns the routine rows, versions, slots, occurrences and wakes.

/** The K4 occurrence hook of Bot routines. Other K4 routines of the Host are not Bot routines. */
export const BOT_ROUTINE = 'bot-routine';
/** A routine Turn expires this long after K4 records its occurrence. */
export const ROUTINE_WAIT_MS = 300_000;
/** A delivery later than this after its planned time is a catch-up. */
export const ROUTINE_LATE_AFTER_MS = 60_000;

/** Fixed at creation. Owner and authority never change between versions, and a routine stays plain or sealed. */
export type BotRoutineInput = { owner: string; authority: Authority; prompt: string }
  | { owner: string; authority: 'owner'; sealed: SealedRoutineTemplate };
const sealedOf = (input: BotRoutineInput): SealedRoutineTemplate | undefined => 'sealed' in input ? input.sealed : undefined;
/**
 * What the owner's member endpoint sends to create or reseal a routine: the schedule and one template, sealed for routine
 * `routineId` version `definitionVersion`.
 */
export interface SealedRoutineAction { routineId: string; definitionVersion: number; schedule: RoutineScheduleFields; sealed: SealedRoutineTemplate }
/** The member sealed for another version than the one this command stages. Nothing is written; read the routine again. */
export class SealedRoutineVersionError extends Error {
  readonly code = 'sealed_routine_version';
  constructor(readonly expected: number) { super(`Seal the template for version ${expected}`); this.name = 'SealedRoutineVersionError'; }
}
/** A sealed routine allows only `task-input`: K8 reads the Bot outcome to settle the Turn, so the output stays plaintext. */
const SEALED_ROUTINE_CATEGORIES = ['task-input'];
/** The ContextPack view of one Bot routine. */
export interface BotRoutine {
  id: string; owner: string; current: number; pending: number | null; lifecycle: Routine['lifecycle']; status: Routine['status'];
  /** A sealed routine has no `prompt` and shows nothing else of its template: the view goes into each ContextPack. */
  definition: { version: number; schedule: RoutineScheduleFields; prompt?: string; sealed?: true; target: string };
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
  return spec?.type === BOT_ROUTINE ? spec.input as unknown as BotRoutineInput : undefined;
}
function definition(id: string, version: number, schedule: RoutineScheduleFields, input: BotRoutineInput): HostOccurrenceRoutineDefinition {
  const check = checkRoutineSchedule(schedule);
  if (!check.ok) throw new Error(`${check.code}: ${check.message}`);
  const rule = 'daysOfWeek' in schedule ? { ...schedule, daysOfWeek: [...new Set(schedule.daysOfWeek)] } : schedule;
  return { id, version, timeZone: schedule.tz, rule: json(rule), waitMs: ROUTINE_WAIT_MS, lateAfterMs: ROUTINE_LATE_AFTER_MS,
    hostOccurrence: { type: BOT_ROUTINE, input: json(input) } };
}
/** The Bot routines among the Host's K4 routine rows. */
export function botRoutines(routines: Iterable<Routine>): BotRoutine[] {
  const views: BotRoutine[] = [];
  for (const routine of routines) {
    const input = fields(routine);
    if (!input) continue;
    const { id, version, rule } = routine.definition;
    views.push({ id, owner: input.owner, current: version, pending: routine.pending?.version ?? null, lifecycle: routine.lifecycle, status: routine.status,
      definition: { version, schedule: rule as unknown as RoutineScheduleFields,
        ...('sealed' in input ? { sealed: true as const } : { prompt: input.prompt }), target: input.owner },
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
/**
 * The routine that `end_routine` completes (§55c): any Bot routine that is open, whatever its owner, so the Main Bot can end
 * the routine of an archived Bot. The command checks the Main Bot role.
 */
export function endable(routines: readonly Routine[], id: string): Routine {
  const routine = routines.find(row => row.definition.id === id);
  if (!routine || !fields(routine) || routine.lifecycle === 'completed') throw new Error('No open Bot routine has this id');
  return routine;
}
/** The next version for `RoutineCommands.update`. It builds on `pending` when one is staged. */
export function updateDefinition(routines: readonly Routine[], owner: string, action: UpdateRoutineAction): HostOccurrenceRoutineDefinition {
  const routine = owned(routines, owner, action.routineId);
  if (action.schedule === undefined && action.prompt === undefined) throw new Error('An update must change schedule or prompt');
  const prior = routine.pending ?? routine.definition, input = prior.hostOccurrence!.input as unknown as BotRoutineInput;
  // Only the member can seal a new version, so neither a Bot nor an owner prompt edit reaches a sealed routine.
  if ('sealed' in input) throw new Error('A sealed routine changes only through resealRoutine');
  return definition(prior.id, prior.version + 1, action.schedule ?? prior.rule as unknown as RoutineScheduleFields,
    { ...input, prompt: action.prompt ?? input.prompt });
}

/**
 * The member side of a sealed Bot routine: the whole Turn instruction it seals. It is the K8 Bot Turn frame with every
 * action and no ContextPack, because v1 has no plaintext field for Host content next to a sealed instruction. The Turn's
 * frozen outcome schema stays the authority on which actions the Bot may take.
 */
export function sealedRoutineInstruction(prompt: string): string { return `${SYSTEM_PROMPT}\n\nRequest:\n${prompt}`; }

/**
 * Checks one sealed template for routine `id` version `version` of a Bot with execution template `execution`: the
 * categories, the Agent, and the offer that each occurrence will carry. It runs at create and at reseal.
 */
function checkSealed(id: string, version: number, sealed: SealedRoutineTemplate, execution: ExecutionTemplate): void {
  if (canonical(sealed.sealing.categories) !== canonical(SEALED_ROUTINE_CATEGORIES)) throw new Error('A sealed routine seals task-input only');
  const { agentRef } = execution.payload;
  if (canonical(sealed.agentRef) !== canonical({ agentId: agentRef.agentId, profileRevision: agentRef.profileRevision })) {
    throw new Error('The template is sealed for another Agent revision');
  }
  const { instruction: _, ...plain } = execution.payload;
  const offer = { ...plain, sealing: sealed.sealing, sealed: sealed.template, routineRef: { routineId: id, definitionVersion: version, notAfter: sealed.notAfter } };
  if (!TaskOfferSealedPayloadSchema.safeParse(offer).success) throw new Error('Supply a valid sealed template');
  if ('ciphertextRef' in sealed.template) throw new Error('A sealed routine template must be inline');
}
/**
 * The definition of a new sealed routine. The member picks `routineId` (a fresh UUID), because the template binds it, and
 * seals version 1. An id that any routine row already has is refused, whatever its lifecycle, except an exact retry: the
 * version 1 that the same command made, which K4 `create` takes as a no-op. It counts toward the limit of 8 open routines
 * of the owner.
 */
export function sealedDefinition(routines: readonly Routine[], owner: string, action: SealedRoutineAction,
  execution: ExecutionTemplate): HostOccurrenceRoutineDefinition {
  if (action.definitionVersion !== 1) throw new SealedRoutineVersionError(1);
  const next = definition(action.routineId, 1, action.schedule, { owner, authority: 'owner', sealed: action.sealed });
  const existing = routines.find(routine => routine.definition.id === action.routineId);
  // A member retry after a lost response resends the same bytes.
  if (existing) {
    if (canonical(existing.definition) === canonical(next)) return next;
    throw new Error('A routine already has this id');
  }
  if (routines.filter(routine => fields(routine)?.owner === owner && routine.lifecycle !== 'completed').length >= 8) throw new Error('Routine limit is 8');
  checkSealed(action.routineId, 1, action.sealed, execution);
  return next;
}
/**
 * The next version of a sealed routine, with a new template. Only a routine that is already sealed takes one, and it keeps
 * its owner and authority. The template must be sealed for `max(current, pending) + 1`, else `SealedRoutineVersionError`.
 * A retry resends the same template bytes; K4 treats the same definition as a no-op.
 */
export function resealDefinition(routines: readonly Routine[], owner: string, action: SealedRoutineAction,
  execution: ExecutionTemplate): HostOccurrenceRoutineDefinition {
  const version = action.definitionVersion;
  const routine = owned(routines, owner, action.routineId);
  const prior = routine.pending ?? routine.definition, input = prior.hostOccurrence!.input as unknown as BotRoutineInput;
  if (!('sealed' in input)) throw new Error('Only a sealed routine takes a new template');
  const next = definition(action.routineId, version, action.schedule, { owner: input.owner, authority: input.authority, sealed: action.sealed });
  // A member retry resends the same bytes: the current or staged version it made already is a K4 no-op.
  if ([routine.definition, routine.pending].some(row => canonical(row) === canonical(next))) return next;
  if (version !== prior.version + 1) throw new SealedRoutineVersionError(prior.version + 1);
  checkSealed(action.routineId, version, action.sealed, execution);
  return next;
}
/** The sealed template of one routine version: the K8 `sealedTemplate` lookup of a Host sync. */
export function sealedTemplate(routines: Iterable<Routine>, ref: SealedRoutineRef): SealedRoutineTemplate | undefined {
  for (const routine of routines) {
    for (const row of [routine.definition, routine.pending]) {
      if (row?.id === ref.routineId && row.version === ref.definitionVersion) {
        const input = fields({ ...routine, definition: row });
        return input && sealedOf(input);
      }
    }
  }
  return undefined;
}
/** The `bot-routine` occurrence hook. It writes the routine Turn in the occurrence commit. `sync` promotes it. */
export function routineTurn(state: CollaborationState, run: HostOccurrenceRun): void {
  const input = run.input as unknown as BotRoutineInput, id = occurrenceIntentKey(run.occurrenceKey);
  // A sealed routine Turn names its routine version; the sync freezes that version's template, and the Host keeps no request.
  addTurn(state, { id, root: id, source: 'routine', botId: input.owner, hop: 0, authority: input.authority,
    ...('sealed' in input ? { request: '', sealedRoutine: { routineId: run.routineId, definitionVersion: run.definitionVersion } } : { request: input.prompt }) });
}
/** A routine Turn id is its K4 intent key, `occurrenceIntentKey(<occurrence key>)`. */
export function routineOccurrence(turn: Pick<Turn, 'id'>): string {
  const key = occurrenceOfIntentKey(turn.id);
  if (key === undefined) throw new Error(`Routine Turn ${turn.id} names no occurrence`);
  return key;
}
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
