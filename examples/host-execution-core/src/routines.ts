import { WAKE_MAX_FUTURE_MS, type DueWake, type WakeScheduleInput } from '@byok-sdk/server';
import { canonical, hash, isSealed, time, validateInput, validateJson, validateRetry, type Conclusion, type HostOccurrenceRun, type IntentExecution,
  type IgnoredWakeAudit, type Intent, type LedgerState, type Occurrence, type Routine, type RoutineDefinition } from './model';
import { cancelWake, enqueue, settle } from './transitions';
import { nextIntervalOccurrence, type NextOccurrence } from './schedule';

// Use the public SDK admission limit for every Host horizon precheck.
export const WAKE_HORIZON_MS = WAKE_MAX_FUTURE_MS;
/** Retain the newest ignored deliveries without growing the Host JSON ledger indefinitely. */
export const IGNORED_WAKE_AUDIT_LIMIT = 128;
export function auditIgnoredWake(state: LedgerState, wake: DueWake, now: number, reason: IgnoredWakeAudit['reason']): void {
  const rows = state.ignoredWakes ??= [];
  rows.push({ at: now, reason, wakeKeyHash: hash(wake.dedupKey) });
  if (rows.length > IGNORED_WAKE_AUDIT_LIMIT) rows.splice(0, rows.length - IGNORED_WAKE_AUDIT_LIMIT);
}
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
  if (plan.completed) { routine.lifecycle = 'completed'; routine.status = 'ok'; delete routine.pending; }
  scheduleNext(state, routine, now);
}

/** The Host time, and the registered handlers a definition may name: Host job types and occurrence hook types, each mapped to its function. */
export interface RoutineValidation { now: number; hostJobs: ReadonlyMap<string, unknown>; occurrenceHooks: ReadonlyMap<string, unknown> }
/** Refuses a routine definition that the Host cannot run at `now`. Pure: it reads no ledger. */
export function validateRoutineDefinition(definition: RoutineDefinition, { now, hostJobs, occurrenceHooks }: RoutineValidation): void {
  if (!definition.id.trim() || definition.id.startsWith('host-scan:') || !Number.isSafeInteger(definition.version) || definition.version < 1
    || definition.waitMs < 1) throw new Error('Invalid routine definition');
  time(definition.waitMs); time(definition.lateAfterMs);
  time(now + definition.waitMs);
  if (definition.retry !== undefined) validateRetry(definition.retry);
  if (definition.endAt !== undefined) time(definition.endAt);
  if ([definition.execution, definition.hostJob, definition.hostOccurrence].filter(kind => kind !== undefined).length !== 1) {
    throw new Error('Supply exactly one of execution, hostJob or hostOccurrence');
  }
  if (definition.hostJob) {
    if (!definition.hostJob.type?.trim() || typeof hostJobs.get(definition.hostJob.type) !== 'function') throw new Error('Host job handler not registered');
    validateJson(definition.hostJob.input);
  } else if (definition.hostOccurrence) {
    if (!definition.hostOccurrence.type?.trim() || typeof occurrenceHooks.get(definition.hostOccurrence.type) !== 'function') {
      throw new Error('Occurrence hook not registered');
    }
    validateJson(definition.hostOccurrence.input);
  } else {
    validateInput({ key: definition.id, source: 'routine', execution: definition.execution!, waitUntil: now + definition.waitMs, retry: definition.retry });
    routineRefOf(definition.execution!, definition.id, definition.version);
  }
}

/** Routine commands in the caller's transaction. A refused command throws before it changes any state. */
export interface RoutineCommands {
  /** The rules of `addRoutine`. */
  create(definition: RoutineDefinition): void;
  /** The rules of `updateRoutine`. */
  update(definition: RoutineDefinition): void;
  /** The rules of `lifecycle()`. */
  lifecycle(id: string, lifecycle: Routine['lifecycle']): void;
  /** Copies of the routine rows, including changes earlier in this transaction. */
  list(): Routine[];
}
/** The inputs of `routineCommands`: the Host clock and calendar, and the registered handlers a definition may name. */
export interface RoutineCommandOptions extends Omit<RoutineValidation, 'now'> { now: () => number; nextTime: NextOccurrence }
/** The one path for routine commands. Each command validates and plans before it writes, so a caught refusal changes nothing. */
export function routineCommands(state: LedgerState, options: RoutineCommandOptions): RoutineCommands {
  const { now, nextTime } = options;
  const validate = (definition: RoutineDefinition) => validateRoutineDefinition(definition,
    { now: now(), hostJobs: options.hostJobs, occurrenceHooks: options.occurrenceHooks });
  return {
    create: definition => {
      validate(definition);
      createRoutine(state, definition, now(), nextTime);
    },
    update: definition => {
      validate(definition);
      nextWake(definition, now(), nextTime, now()); // Refuse a calendar error before staging.
      stageVersion(state, definition, now(), nextTime);
    },
    lifecycle: (id, lifecycle) => setLifecycle(state, id, lifecycle, now(), nextTime),
    list: () => structuredClone(Object.values(state.routines)),
  };
}

/** Creates a validated routine. The same definition is idempotent; another definition for the ID throws before any change. */
export function createRoutine(state: LedgerState, definition: RoutineDefinition, now: number, nextTime: NextOccurrence): void {
  const plan = nextWake(definition, now - 1, nextTime, now);
  const id = hash(definition.id), routine = state.routines[id];
  if (routine) {
    if (canonical(routine.definition) !== canonical(definition)) throw new Error('Routine definition is immutable in addRoutine; use updateRoutine for the next version');
    // A staged version owns the next reservation; the old chain gets no refill.
    if (routine.lifecycle === 'active' && routine.status === 'no_occurrence_within_horizon' && !routine.pending) applyPlan(state, routine, plan, now);
    return;
  }
  state.routines[id] = { definition: structuredClone(definition), lifecycle: 'active', status: 'ok', next: null };
  applyPlan(state, state.routines[id]!, plan, now);
}

/** A staged version replaces the definition only when no older work can still use it. Pure: it reads no ledger. */
export function versionSwitchDue(routine: Readonly<Routine>, occurrences: Iterable<Readonly<Occurrence>>, now: number): boolean {
  if (routine.lifecycle !== 'active' || !routine.pending) return false;
  // A due slot that is not delivered yet is old-version work too.
  if (routine.next && routine.next.availableAt <= now) return false;
  for (const occurrence of occurrences) if (occurrence.routineId === routine.definition.id && !occurrence.conclusion) return false;
  return true;
}
export function switchVersion(state: LedgerState, routine: Routine, now: number, nextTime: NextOccurrence): void {
  if (routine.next) cancelWake(state, routine.next.dedupKey);
  routine.definition = routine.pending!;
  delete routine.pending;
  try { applyPlan(state, routine, nextWake(routine.definition, now, nextTime, now), now); }
  catch (error) { auditCalendarError(routine, now, error); }
}
const destination = (definition: RoutineDefinition): string => definition.hostJob ? `host-job:${definition.hostJob.type}`
  : definition.hostOccurrence ? `host-occurrence:${definition.hostOccurrence.type}` : 'execution';
/** Stages the next version of a validated definition. The Host service assigns versions and keeps their history. */
export function stageVersion(state: LedgerState, definition: RoutineDefinition, now: number, nextTime: NextOccurrence): void {
  const routine = state.routines[hash(definition.id)];
  if (!routine) throw new Error('Routine not found');
  const text = canonical(definition);
  if (text === canonical(routine.definition) || routine.pending && text === canonical(routine.pending)) return;
  if (routine.lifecycle === 'completed') throw new Error('A completed routine cannot change');
  if (definition.version !== Math.max(routine.definition.version, routine.pending?.version ?? 0) + 1) {
    throw new Error('Routine version conflict; supply max(current, pending) + 1');
  }
  if (destination(definition) !== destination(routine.definition)) throw new Error('A routine version cannot change its destination, Host job type or occurrence hook type');
  routine.pending = structuredClone(definition);
  if (versionSwitchDue(routine, Object.values(state.occurrences), now)) switchVersion(state, routine, now, nextTime);
}

/**
 * Called inside the same transaction that creates the occurrence and its work.
 * Returns the new occurrence; a replay or an ignored wake returns undefined.
 */
export function recordOccurrence(state: LedgerState, tenant: string, wake: DueWake, now: number, nextTime: NextOccurrence): Occurrence | undefined {
  const existing = state.slots[hash(wake.dedupKey)];
  if (existing) {
    const occurrence = state.occurrences[existing]!;
    occurrence.slotReplayCount = (occurrence.slotReplayCount ?? 0) + 1;
    return; // Persisted trigger wins even after a later redelivery.
  }
  const parsed = parseRoutineWakeKey(wake.dedupKey);
  if (!parsed) return void auditIgnoredWake(state, wake, now, 'unknown_key');
  const routine = state.routines[hash(parsed.id)];
  if (!routine) return void auditIgnoredWake(state, wake, now, 'missing_routine');
  if (routine.lifecycle !== 'active') return void auditIgnoredWake(state, wake, now, 'inactive_routine');
  if (!routine.next || routine.next.dedupKey !== wake.dedupKey) return void auditIgnoredWake(state, wake, now, 'reservation_mismatch');
  if (routine.next.availableAt !== wake.availableAt || routine.next.payload !== wake.payload) throw new Error('Wake differs from the routine reservation');
  const definition = routine.definition;
  const trigger = { kind: now - wake.availableAt > definition.lateAfterMs ? 'catch_up' as const : 'scheduled' as const, plannedAt: wake.availableAt };
  const key = hash([definition.id, definition.version, trigger]);
  // A staged version stops the old chain: record this slot, but reserve no later old slot.
  let plan: WakePlan = { next: null, status: 'ok', completed: false };
  if (!routine.pending) {
    // A Host clock behind the scheduler must not reserve the delivered slot again.
    try { plan = nextWake(definition, Math.max(now, wake.availableAt), nextTime, now); }
    catch (error) {
      auditCalendarError(routine, now, error, wake.dedupKey);
      plan = { next: null, status: 'calendar_error', completed: false };
    }
  }
  const next = plan.next;

  for (const prior of Object.values(state.occurrences).filter(row => row.routineId === definition.id && !row.conclusion)) {
    if (!prior.intentId) {
      // A later promotion of this Host job or Host occurrence settles as superseded.
      const pending = prior.job ?? prior.hook;
      if (pending) pending.executionSuperseded = true;
      continue;
    }
    const intent = state.intents[prior.intentId]!;
    // A new slot ends old retries. Keep a running occurrence and only the latest queued occurrence.
    intent.retryUntil = Math.min(intent.retryUntil ?? now, now);
    if (intent.phase === 'queued' || intent.phase === 'backoff' || intent.phase === 'memory_blocked') settle(state, intent, 'superseded');
  }
  const occurrence: Occurrence = { key, routineId: definition.id, definitionVersion: definition.version,
    trigger, wakeKey: wake.dedupKey, recordedAt: now, nextAt: next?.availableAt ?? null, attempts: 0 };
  state.occurrences[key] = occurrence;
  if (definition.hostJob) {
    occurrence.job = { attempts: 0 };
    state.outbox[`host-job:${key}`] = { kind: 'host-job', occurrenceKey: key };
  } else if (definition.hostOccurrence) {
    occurrence.hook = {}; // The core runs the hook in this transaction.
  } else {
    const intent = enqueue(state, tenant, { key: `occurrence:${key}`, source: 'routine', execution: definition.execution,
      waitUntil: time(now + definition.waitMs), retry: definition.retry });
    intent.occurrence = key;
    if (next) intent.retryUntil = next.availableAt;
    occurrence.intentId = intent.id;
  }
  state.slots[hash(wake.dedupKey)] = key;
  applyPlan(state, routine, plan, now);
  return occurrence;
}

/**
 * A routine template (#654 E3d) is sealed for one routine version: its `routineRef` must name this routine and version,
 * or the device would open it for an occurrence of another one.
 */
function routineRefOf(execution: IntentExecution, routineId: string, definitionVersion: number): void {
  const ref = isSealed(execution) ? execution.payload.routineRef : undefined;
  if (ref && (ref.routineId !== routineId || ref.definitionVersion !== definitionVersion)) throw new Error('routineRef names another routine version');
}
/** A Host decision joins the existing FIFO atomically. The deadline counts from occurrence admission. */
export function promote(state: LedgerState, tenant: string, occurrence: Occurrence, execution: IntentExecution): Intent {
  routineRefOf(execution, occurrence.routineId, occurrence.definitionVersion);
  const routine = state.routines[hash(occurrence.routineId)]!;
  const intent = enqueue(state, tenant, { key: `occurrence:${occurrence.key}`, source: 'routine', execution,
    waitUntil: time(occurrence.recordedAt + routine.definition.waitMs), retry: routine.definition.retry });
  intent.occurrence = occurrence.key;
  occurrence.intentId = intent.id;
  if (occurrence.job?.executionSuperseded || occurrence.hook?.executionSuperseded) settle(state, intent, 'superseded');
  else if (routine.lifecycle === 'active' && occurrence.nextAt !== null) intent.retryUntil = occurrence.nextAt;
  return intent;
}
/** The hook input of a `hostOccurrence` occurrence of `routine`. Each call returns fresh copies. */
export function occurrenceRun(routine: Readonly<Routine>, occurrence: Readonly<Occurrence>): HostOccurrenceRun {
  const { type, input } = routine.definition.hostOccurrence!;
  return { type, input: structuredClone(input), occurrenceKey: occurrence.key, routineId: occurrence.routineId,
    definitionVersion: occurrence.definitionVersion, trigger: structuredClone(occurrence.trigger) };
}
function openHostOccurrence(state: LedgerState, occurrenceKey: string): Occurrence {
  const occurrence = Object.hasOwn(state.occurrences, occurrenceKey) ? state.occurrences[occurrenceKey]! : undefined;
  // A Host job occurrence is promoted or settled only by its handler result.
  if (!occurrence?.hook) throw new Error('Host occurrence not found');
  if (occurrence.intentId || occurrence.conclusion) throw new Error('Host occurrence is already promoted or concluded');
  return occurrence;
}
/**
 * Promotes an open `hostOccurrence` occurrence into the FIFO as intent `occurrence:<key>`.
 * Call it inside `ledger.transaction`, then `drain()`. A newer slot makes the intent settle as superseded at once.
 */
export function promoteOccurrence(state: LedgerState, tenant: string, occurrenceKey: string, execution: IntentExecution): Intent {
  return promote(state, tenant, openHostOccurrence(state, occurrenceKey), execution);
}
const CONCLUSIONS: readonly Conclusion[] = ['succeeded', 'failed', 'declined', 'cancelled', 'expired', 'superseded'];
/** Settles an open `hostOccurrence` occurrence that needs no execution. Call it inside `ledger.transaction`, then `drain()`. */
export function concludeOccurrence(state: LedgerState, occurrenceKey: string, conclusion: Conclusion): void {
  if (!CONCLUSIONS.includes(conclusion)) throw new Error('Invalid occurrence conclusion');
  openHostOccurrence(state, occurrenceKey).conclusion = conclusion;
}

export function setLifecycle(state: LedgerState, id: string, lifecycle: Routine['lifecycle'], now: number, nextTime: NextOccurrence): void {
  const routine = state.routines[hash(id)];
  if (!routine) throw new Error('Routine not found');
  if (!['active', 'paused', 'completed'].includes(lifecycle)) throw new Error('Invalid routine lifecycle');
  if (routine.lifecycle === 'completed' && lifecycle !== 'completed') throw new Error('A completed routine cannot resume');
  if (routine.lifecycle === lifecycle) return;
  // Resume plans before any change, so a calendar error leaves the routine as it was.
  const switching = lifecycle === 'active' && versionSwitchDue({ ...routine, lifecycle, next: null }, Object.values(state.occurrences), now);
  const plan = lifecycle === 'active' && !switching ? nextWake(routine.definition, now, nextTime, now) : undefined;
  if (lifecycle === 'paused' && routine.next) {
    const cancelledSlot = routine.next.availableAt;
    for (const occurrence of Object.values(state.occurrences)) {
      if (occurrence.routineId !== id || occurrence.conclusion || !occurrence.intentId) continue;
      const intent = state.intents[occurrence.intentId]!;
      // This cutoff belonged to the successor we are cancelling, not to a
      // committed superseding occurrence. Keep the independent waiting bound.
      if (intent.retryUntil === cancelledSlot) delete intent.retryUntil;
    }
  }
  if (routine.next) cancelWake(state, routine.next.dedupKey);
  routine.lifecycle = lifecycle;
  routine.next = null; routine.status = 'ok';
  delete routine.scheduleRetryAt; delete routine.scheduleRetryCount;
  if (lifecycle === 'completed') delete routine.pending;
  // Pause keeps a staged version. Resume switches to it when due; otherwise the current version continues.
  if (switching) switchVersion(state, routine, now, nextTime);
  else if (plan) applyPlan(state, routine, plan, now);
}
