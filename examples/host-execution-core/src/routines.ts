import type { DueWake, WakeScheduleInput } from '@byok-sdk/server';
import { hash, time, type LedgerState, type Routine, type RoutineDefinition } from './model';
import { cancelWake, enqueue, settle } from './transitions';
import { nextIntervalOccurrence, type NextOccurrence } from './schedule';

// The current public Embedded wake queue contract. Do not import SDK internals.
export const WAKE_HORIZON_MS = 366 * 86_400_000;
interface WakePlan { next: WakeScheduleInput | null; status: Routine['status']; completed: boolean }

export function parseRoutineWakeKey(key: string): { id: string; version: number; at: number } | undefined {
  const last = key.lastIndexOf(':'), previous = key.lastIndexOf(':', last - 1);
  if (previous < 1 || [...key].length > 256) return undefined;
  const versionText = key.slice(previous + 1, last), timeText = key.slice(last + 1);
  if (!/^[1-9][0-9]*$/.test(versionText) || !/^(0|[1-9][0-9]*)$/.test(timeText)) return undefined;
  const version = Number(versionText), at = Number(timeText);
  if (!Number.isSafeInteger(version) || !Number.isSafeInteger(at)) return undefined;
  return { id: key.slice(0, previous), version, at };
}

export function nextWake(definition: RoutineDefinition, after: number, nextTime: NextOccurrence, now: number): WakePlan {
  const slot = nextTime(structuredClone(definition), after);
  if (slot === null) return { next: null, status: 'no_occurrence_within_horizon',
    completed: definition.endAt !== undefined && (nextTime === nextIntervalOccurrence || now >= definition.endAt) };
  time(slot);
  if (slot <= after) throw new Error('Calendar must advance beyond its input time');
  if (definition.endAt !== undefined && slot > definition.endAt) return { next: null, status: 'ok', completed: true };
  const dedupKey = `${definition.id}:${definition.version}:${slot}`;
  if (!parseRoutineWakeKey(dedupKey)) throw new Error('Invalid routine wake key');
  return { next: { dedupKey, availableAt: slot }, status: slot - now > WAKE_HORIZON_MS ? 'schedule_retrying' : 'ok', completed: false };
}
export function deferSchedule(state: LedgerState, routine: Routine, now: number): void {
  if (routine.next) delete state.outbox[`schedule:${routine.next.dedupKey}`];
  routine.status = 'schedule_retrying';
  if (routine.scheduleRetryAt === undefined || routine.scheduleRetryAt <= now) {
    routine.scheduleRetryCount = (routine.scheduleRetryCount ?? 0) + 1;
    routine.scheduleRetryAt = time(now + Math.min(60_000 * 2 ** Math.min(routine.scheduleRetryCount - 1, 6), 3_600_000));
  }
}
export function scheduleNext(state: LedgerState, routine: Routine, now: number): void {
  if (routine.lifecycle === 'active' && routine.next) {
    if (routine.next.availableAt - now > WAKE_HORIZON_MS) {
      deferSchedule(state, routine, now);
      return;
    }
    routine.status = 'ok';
    delete routine.scheduleRetryAt; delete routine.scheduleRetryCount;
    delete state.outbox[`cancel:${routine.next.dedupKey}`];
    state.outbox[`schedule:${routine.next.dedupKey}`] = { kind: 'schedule', input: routine.next };
  }
}

export function auditCalendarError(routine: Routine, now: number, error: unknown, wakeKey?: string): void {
  (routine.calendarErrors ??= []).push({ at: now, ...(wakeKey === undefined ? {} : { wakeKey }),
    message: String(error instanceof Error ? error.message : error).slice(0, 1024) });
  routine.next = null; routine.status = 'calendar_error';
  delete routine.scheduleRetryAt; delete routine.scheduleRetryCount;
}

export function applyPlan(state: LedgerState, routine: Routine, plan: WakePlan, now: number): void {
  routine.next = plan.next; routine.status = plan.status;
  delete routine.scheduleRetryAt; delete routine.scheduleRetryCount;
  if (plan.completed) { routine.lifecycle = 'completed'; routine.status = 'ok'; }
  scheduleNext(state, routine, now);
}

/** Called inside the same transaction that creates the occurrence and its intent. */
export function recordOccurrence(state: LedgerState, tenant: string, wake: DueWake, now: number, nextTime: NextOccurrence): void {
  if (state.slots[hash(wake.dedupKey)]) return; // Persisted trigger wins even after a later redelivery.
  const parsed = parseRoutineWakeKey(wake.dedupKey);
  const routine = parsed ? state.routines[hash(parsed.id)] : undefined;
  if (!routine || routine.lifecycle !== 'active' || !routine.next) return;
  if (routine.next.dedupKey !== wake.dedupKey) return;
  if (routine.next.availableAt !== wake.availableAt || routine.next.payload !== wake.payload) throw new Error('Wake differs from the routine reservation');
  const definition = routine.definition;
  const trigger = { kind: now - wake.availableAt > definition.lateAfterMs ? 'catch_up' as const : 'scheduled' as const, plannedAt: wake.availableAt };
  const key = hash([definition.id, definition.version, trigger]);
  let plan: WakePlan;
  try { plan = nextWake(definition, now, nextTime, now); }
  catch (error) {
    auditCalendarError(routine, now, error, wake.dedupKey);
    plan = { next: null, status: 'calendar_error', completed: false };
  }
  const next = plan.next;

  for (const prior of Object.values(state.occurrences).filter(row => row.routineId === definition.id && !row.conclusion)) {
    const intent = state.intents[prior.intentId]!;
    // A new slot ends old retries. Keep a running occurrence and only the latest queued occurrence.
    intent.retryUntil = Math.min(intent.retryUntil ?? now, now);
    if (intent.phase === 'queued' || intent.phase === 'backoff') settle(state, intent, 'superseded');
  }
  const intent = enqueue(state, tenant, { key: `occurrence:${key}`, source: 'routine', execution: definition.execution,
    waitUntil: time(now + definition.waitMs), retry: definition.retry });
  intent.occurrence = key;
  if (next) intent.retryUntil = next.availableAt;
  state.occurrences[key] = { key, routineId: definition.id, definitionVersion: definition.version,
    trigger, wakeKey: wake.dedupKey, recordedAt: now, nextAt: next?.availableAt ?? null, intentId: intent.id, attempts: 0 };
  state.slots[hash(wake.dedupKey)] = key;
  applyPlan(state, routine, plan, now);
}

export function setLifecycle(state: LedgerState, id: string, lifecycle: Routine['lifecycle'], now: number, nextTime: NextOccurrence): void {
  const routine = state.routines[hash(id)];
  if (!routine) throw new Error('Routine not found');
  if (!['active', 'paused', 'completed'].includes(lifecycle)) throw new Error('Invalid routine lifecycle');
  if (routine.lifecycle === 'completed' && lifecycle !== 'completed') throw new Error('A completed routine cannot resume');
  if (routine.lifecycle === lifecycle) return;
  if (routine.next) cancelWake(state, routine.next.dedupKey);
  routine.lifecycle = lifecycle;
  routine.next = null; routine.status = 'ok';
  delete routine.scheduleRetryAt; delete routine.scheduleRetryCount;
  if (lifecycle === 'active') applyPlan(state, routine, nextWake(routine.definition, now, nextTime, now), now);
}
