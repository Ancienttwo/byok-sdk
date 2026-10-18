import { checkRoutineSchedule, nextRoutineOccurrence } from '@byok-sdk/core';
import type { DueWake } from '@byok-sdk/server';
import type { CreateRoutineAction, UpdateRoutineAction } from '@byok-sdk/protocol';
import { hash } from '../../host-execution-core/src/model';
import { parseRoutineWakeKey } from '../../host-execution-core/src/routines';
import type { CollaborationState, Definition, Routine, Slot } from './model';

export function operation(state: CollaborationState, routine: Routine, kind: 'schedule' | 'cancel', slot: Slot): void {
  state.operations.push({ sequence: ++state.sequence, routineId: routine.id, generation: routine.generation, kind, slot, state: 'pending' });
}
export function arm(state: CollaborationState, routine: Routine, after: number, now: number, wakeKey?: string): void {
  try {
    const at = nextRoutineOccurrence(routine.versions[routine.current]!.schedule, after);
    routine.armed = at === null ? null : { version: routine.current, at, key: `${routine.id}:${routine.current}:${at}` };
    routine.status = at === null ? 'no_occurrence_within_horizon' : 'ok';
    if (routine.armed) operation(state, routine, 'schedule', routine.armed);
  } catch (error) {
    routine.armed = null; routine.status = 'calendar_error';
    routine.errors.push({ at: now, wakeKey, message: String(error instanceof Error ? error.message : error).slice(0, 1024) });
  }
}
function check(definition: Definition): void {
  const check = checkRoutineSchedule(definition.schedule);
  if (!check.ok) throw new Error(`${check.code}: ${check.message}`);
}
export function createRoutine(state: CollaborationState, owner: string, taskId: string, index: number, action: CreateRoutineAction, now: number): Routine {
  if (action.target !== undefined) throw new Error('An ordinary Bot cannot supply target');
  if (Object.values(state.routines).filter(r => r.owner === owner && r.lifecycle !== 'completed').length >= 8) throw new Error('Routine limit is 8');
  const definition = { version: 1, schedule: action.schedule, prompt: action.prompt, target: owner };
  check(definition);
  const id = hash([taskId, 'create_routine', index]);
  const routine: Routine = { id, owner, current: 1, pending: null, generation: 1, versions: { 1: definition }, lifecycle: 'active',
    armed: null, inflight: [], status: 'ok', errors: [] };
  state.routines[id] = routine;
  arm(state, routine, now, now);
  return routine;
}
export function owned(state: CollaborationState, owner: string, id: string): Routine {
  const routine = state.routines[id];
  if (!routine || routine.owner !== owner || routine.lifecycle === 'completed') throw new Error('Routine is unavailable to this Bot');
  return routine;
}
export function switchVersion(state: CollaborationState, routine: Routine, now: number): void {
  if (routine.armed) operation(state, routine, 'cancel', routine.armed);
  if (routine.pending !== null) routine.current = routine.pending;
  routine.pending = null; routine.generation++;
  arm(state, routine, now, now);
}
export function updateRoutine(state: CollaborationState, owner: string, action: UpdateRoutineAction, now: number): void {
  const routine = owned(state, owner, action.routineId);
  const version = Math.max(...Object.keys(routine.versions).map(Number)) + 1;
  const prior = routine.versions[routine.pending ?? routine.current]!;
  const definition: Definition = { ...prior, version, schedule: action.schedule ?? prior.schedule, prompt: action.prompt ?? prior.prompt };
  check(definition);
  routine.versions[version] = definition; routine.pending = version;
  // A due undelivered armed slot is old work too. Do not replace its snapshot.
  if (!routine.inflight.length && !(routine.armed && routine.armed.at <= now) && routine.lifecycle === 'active') switchVersion(state, routine, now);
}
export function lifecycle(state: CollaborationState, routine: Routine, value: Routine['lifecycle'], now: number): void {
  if (routine.lifecycle === value) return;
  if (routine.lifecycle === 'completed') throw new Error('A completed routine cannot resume');
  if (routine.armed) operation(state, routine, 'cancel', routine.armed);
  routine.armed = null; routine.lifecycle = value; routine.generation++;
  if (value === 'active') {
    if (routine.pending !== null && !routine.inflight.length) switchVersion(state, routine, now);
    else arm(state, routine, now, now);
  }
}
export function consumeRoutine(state: CollaborationState, wake: DueWake, now: number, addTurn: (id: string, request: string) => void): void {
  if (state.occurrences[wake.dedupKey]) return;
  const parsed = parseRoutineWakeKey(wake.dedupKey);
  if (!parsed) { state.audit.push(`Invalid routine wake: ${wake.dedupKey.slice(0, 256)}`); return; }
  const routine = state.routines[parsed.id];
  const decision = !routine || routine.lifecycle !== 'active' ? 'skipped'
    : routine.armed?.key !== wake.dedupKey ? 'superseded' : routine.inflight.length >= 2 ? 'capacity' : 'run';
  const row = state.occurrences[wake.dedupKey] = { key: wake.dedupKey, routineId: parsed.id, version: parsed.version, at: parsed.at,
    deliveredAt: wake.deliveredAt, decision, trigger: wake.deliveredAt - parsed.at > 60_000 ? 'catch_up' as const : 'scheduled' as const,
    settled: decision !== 'run' };
  if (!routine || decision === 'skipped' || decision === 'superseded') return;
  if (wake.availableAt !== parsed.at) throw new Error('Wake time differs from reservation');
  routine.armed = null;
  if (decision === 'run') {
    const definition = structuredClone(routine.versions[parsed.version]!);
    const turnId = hash(['routine', wake.dedupKey]);
    Object.assign(row, { definition, turnId });
    routine.inflight.push(wake.dedupKey);
    addTurn(turnId, definition.prompt);
  }
  // Pending updates drain accepted work. They never refill the old chain.
  if (routine.pending === null) arm(state, routine, Math.max(wake.deliveredAt, parsed.at), now, wake.dedupKey);
  else if (!routine.inflight.length) switchVersion(state, routine, now);
}
