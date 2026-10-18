import type { DueWake, WakeScheduleInput } from '@byok-sdk/server';
import { hash, time, type LedgerState, type Routine, type RoutineDefinition } from './model';
import { cancelWake, enqueue, settle } from './transitions';
import type { NextOccurrence } from './schedule';

export function nextWake(definition: RoutineDefinition, after: number, nextTime: NextOccurrence): WakeScheduleInput | null {
  const slot = nextTime(structuredClone(definition), after);
  if (slot === null) return null;
  time(slot);
  if (slot <= after) throw new Error('Calendar must advance beyond its input time');
  if (definition.endAt !== undefined && slot > definition.endAt) return null;
  return { dedupKey: `routine:${hash([definition.id, definition.version, slot])}`, availableAt: slot,
    payload: JSON.stringify({ hostExecutionCore: 1, kind: 'routine', routine: hash(definition.id), version: definition.version }) };
}
export function scheduleNext(state: LedgerState, routine: Routine): void {
  if (routine.lifecycle === 'active' && routine.next) {
    delete state.outbox[`cancel:${routine.next.dedupKey}`];
    state.outbox[`schedule:${routine.next.dedupKey}`] = { kind: 'schedule', input: routine.next };
  }
}

/** Called inside the same transaction that creates the occurrence and its intent. */
export function recordOccurrence(state: LedgerState, tenant: string, wake: DueWake, now: number, nextTime: NextOccurrence): void {
  if (state.slots[hash(wake.dedupKey)]) return; // Persisted trigger wins even after a later redelivery.
  const routine = Object.values(state.routines).find(row => row.next?.dedupKey === wake.dedupKey);
  if (!routine || routine.lifecycle !== 'active' || !routine.next) return;
  if (routine.next.availableAt !== wake.availableAt || routine.next.payload !== wake.payload) throw new Error('Wake differs from the routine reservation');
  const definition = routine.definition;
  const trigger = { kind: now - wake.availableAt > definition.lateAfterMs ? 'catch_up' as const : 'scheduled' as const, plannedAt: wake.availableAt };
  const key = hash([definition.id, definition.version, trigger]);
  const next = nextWake(definition, now, nextTime);

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
  routine.next = next;
  if (!next) routine.lifecycle = 'completed';
  scheduleNext(state, routine);
}

export function setLifecycle(state: LedgerState, id: string, lifecycle: Routine['lifecycle'], now: number, nextTime: NextOccurrence): void {
  const routine = state.routines[hash(id)];
  if (!routine) throw new Error('Routine not found');
  if (!['active', 'paused', 'completed'].includes(lifecycle)) throw new Error('Invalid routine lifecycle');
  if (routine.lifecycle === 'completed' && lifecycle !== 'completed') throw new Error('A completed routine cannot resume');
  if (routine.lifecycle === lifecycle) return;
  if (routine.next) cancelWake(state, routine.next.dedupKey);
  routine.lifecycle = lifecycle;
  routine.next = lifecycle === 'active' ? nextWake(routine.definition, now, nextTime) : null;
  if (lifecycle === 'active' && !routine.next) routine.lifecycle = 'completed';
  scheduleNext(state, routine);
}
