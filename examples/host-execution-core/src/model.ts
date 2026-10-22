import type { MemoryState } from './memory';
import { createHash } from 'node:crypto';
import type { AgentExecutionInput, ByokServer, WakeScheduleInput } from '@byok-sdk/server';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ExecutionTemplate = Omit<AgentExecutionInput, 'taskId'>;
export type Terminal = NonNullable<Awaited<ReturnType<ByokServer['tasks']['deviceTerminal']>>>;
export type Attempt = NonNullable<Awaited<ReturnType<ByokServer['tasks']['attempt']>>>;
export type Conclusion = 'succeeded' | 'failed' | 'declined' | 'cancelled' | 'expired' | 'superseded';
export interface RetryPolicy { maxAttempts: number; delaysMs: number[]; retryFailures: boolean }
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, delaysMs: [300_000, 900_000], retryFailures: false };
export interface IntentInput {
  key: string;
  source: 'user' | 'bot' | 'routine';
  execution: ExecutionTemplate;
  waitUntil: number;
  retry?: RetryPolicy;
}
export interface Intent extends IntentInput {
  id: string; agent: string; sequence: number; retry: RetryPolicy;
  phase: 'queued' | 'inflight' | 'backoff' | 'memory_blocked' | 'settled';
  memoryBlocked?: { resume: 'queued' | 'backoff'; reason: string };
  preparationError?: string;
  generation: number; taskId: string; notBefore: number; attempts: number;
  occurrence?: string; retryUntil?: number;
  cancelReason?: 'expired' | 'cancelled'; conclusion?: Conclusion;
}
export interface Execution {
  input: AgentExecutionInput;
  submission: 'reserved' | 'uncertain' | 'delivered';
  started: boolean;
  /** At most one acceptance per execution; retained/compacted with its execution. */
  messageReceipt?: { messageId: string; contentHash: string };
  attempt?: Attempt;
  terminal?: Terminal;
}
interface RoutineSchedule {
  id: string; version: number; timeZone: string; rule: Json;
  waitMs: number; lateAfterMs: number; retry?: RetryPolicy;
  endAt?: number;
}
export interface HostJobSpec { type: string; input: Json }
export type AgentRoutineDefinition = RoutineSchedule & { execution: ExecutionTemplate; hostJob?: never; hostOccurrence?: never };
export type HostJobRoutineDefinition = RoutineSchedule & { hostJob: HostJobSpec; execution?: never; hostOccurrence?: never };
/** The registered occurrence hook `type` runs in the occurrence commit. The Host later promotes or concludes the occurrence. */
export type HostOccurrenceRoutineDefinition = RoutineSchedule & { hostOccurrence: { type: string; input: Json }; execution?: never; hostJob?: never };
export type RoutineDefinition = AgentRoutineDefinition | HostJobRoutineDefinition | HostOccurrenceRoutineDefinition;
export interface HostJobRun {
  type: string; input: Json; occurrenceKey: string; routineId: string; definitionVersion: number;
  trigger: Occurrence['trigger']; attempt: number; signal: AbortSignal;
}
export interface HostJobResult { summary: Json; execution?: ExecutionTemplate }
export type HostJobHandler = (run: HostJobRun) => HostJobResult | Promise<HostJobResult>;
export type HostOccurrenceRun = Omit<HostJobRun, 'attempt' | 'signal'>;
export interface Routine {
  definition: RoutineDefinition;
  /** The next version from `updateRoutine`. It replaces `definition` when `versionSwitchDue` is true. */
  pending?: RoutineDefinition;
  lifecycle: 'active' | 'paused' | 'completed';
  status: 'ok' | 'schedule_retrying' | 'no_occurrence_within_horizon' | 'calendar_error';
  next: WakeScheduleInput | null;
  scheduleRetryAt?: number;
  scheduleRetryCount?: number;
  /** Last SDK schedule rejection. Retained after recovery. */
  lastError?: { code: string; message: string };
  calendarErrors?: Array<{ at: number; wakeKey?: string; message: string }>;
}
export interface Occurrence {
  key: string; routineId: string; definitionVersion: number;
  trigger: { kind: 'scheduled' | 'catch_up'; plannedAt: number };
  wakeKey: string; recordedAt: number; nextAt: number | null; intentId?: string;
  job?: { attempts: number; summary?: Json; executionSuperseded?: true };
  /** A `hostOccurrence` occurrence. It stays unsettled until the Host promotes or concludes it. */
  hook?: { executionSuperseded?: true };
  attempts: number; conclusion?: Conclusion;
  slotReplayCount?: number;
}
export type Outbox =
  | { kind: 'host-job'; occurrenceKey: string; lastError?: string }
  | { kind: 'intent'; intentId: string; lastError?: string }
  | { kind: 'schedule'; input: WakeScheduleInput; lastError?: string }
  | { kind: 'cancel-wake'; key: string; lastError?: string }
  | { kind: 'projection'; id: string; value: Json; lastError?: string };
export interface IgnoredWakeAudit {
  at: number;
  reason: 'unknown_key' | 'stale_scan' | 'missing_routine' | 'inactive_routine' | 'reservation_mismatch';
  /** SHA-256 of canonical(dedupKey); raw keys, IDs and payloads are not retained. */
  wakeKeyHash: string;
}
export interface LedgerState {
  version: 1; sequence: number; scanSequence: number;
  memory?: MemoryState;
  /** Bounded diagnostic history; absent until the first ignored delivery. */
  ignoredWakes?: IgnoredWakeAudit[];
  intents: Record<string, Intent>; executions: Record<string, Execution>;
  routines: Record<string, Routine>; occurrences: Record<string, Occurrence>;
  slots: Record<string, string>; outbox: Record<string, Outbox>;
  applied: Record<string, true>; application: Record<string, Json>;
  scanWake: WakeScheduleInput | null;
}
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function taskId(key: string, generation: number): string { return hash([key, generation]); }
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
export function time(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Time must be a nonnegative safe integer');
  return value;
}
/** Reject values that would change meaning when the ledger serializes them. */
export function validateJson(value: unknown, ancestors = new Set<object>()): asserts value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)
    || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error('Routine input and Host job summary must be JSON');
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error('Routine input and Host job summary must be JSON');
    for (let i = 0; i < value.length; i++) validateJson(value[i], ancestors);
  } else {
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) throw new Error('Routine input and Host job summary must be JSON');
    for (const item of Object.values(value)) validateJson(item, ancestors);
  }
  ancestors.delete(value);
}
export function validateInput(input: IntentInput): void {
  if (!input.key.trim() || !['user', 'bot', 'routine'].includes(input.source)) throw new Error('Invalid intent identity');
  time(input.waitUntil);
  const { execution } = input;
  if (!execution.deviceId || !execution.payload.agentRef?.agentId || !execution.payload.agentRef.profileRevision
    || !execution.payload.runtime || !execution.payload.egressPolicy || !execution.payload.terminalProjection
    || 'sessionRef' in execution.payload || 'taskId' in execution) throw new Error('Supply a complete fresh execution template');
  validateRetry(input.retry ?? DEFAULT_RETRY);
}
export function validateRetry(retry: RetryPolicy): void {
  if (!Number.isSafeInteger(retry.maxAttempts) || retry.maxAttempts < 1 || retry.maxAttempts > 100
    || retry.delaysMs.length < retry.maxAttempts - 1 || typeof retry.retryFailures !== 'boolean') throw new Error('Invalid retry policy');
  retry.delaysMs.forEach(time);
}
export function project(state: LedgerState, id: string, value: Json): void {
  const key = `projection:${hash(id)}`;
  const prior = state.outbox[key];
  if (prior && (prior.kind !== 'projection' || prior.id !== id || canonical(prior.value) !== canonical(value))) throw new Error('Projection identity conflict');
  state.outbox[key] = { kind: 'projection', id, value };
}
