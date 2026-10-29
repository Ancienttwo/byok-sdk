import type { MemoryState } from './memory';
import { canonical, hash } from './canonical';
import type { AgentExecutionInput } from '@byok-sdk/cloud';
import type { ByokServer } from '../index';
import type { WakeScheduleInput } from '../wakes/types';
import { HarnessIdSchema, RuntimeIdSchema, TaskOfferSealedPayloadSchema, type AgentMessageServerContext,
  type TaskOfferSealedPayload } from '@byok-sdk/protocol';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ExecutionTemplate = Omit<AgentExecutionInput, 'taskId'>;
/**
 * The input of the cloud's `submitSealedAgentExecution` (#654): a fresh sealed `task.offer` payload
 * with its terminal projection. A routine template rides in `sealed`, with its plaintext `routineRef`.
 */
export interface SealedAgentExecutionInput {
  taskId: string;
  deviceId: string;
  payload: TaskOfferSealedPayload & { session: { mode: 'fresh' }; terminalProjection: NonNullable<TaskOfferSealedPayload['terminalProjection']> };
  agentMessageContext?: AgentMessageServerContext;
}
export type SealedExecutionTemplate = Omit<SealedAgentExecutionInput, 'taskId'>;
/** What an intent runs: a plain execution, or a sealed one whose task input only a member and the device can read. */
export type IntentExecution = ExecutionTemplate | SealedExecutionTemplate;
export type FrozenExecutionInput = AgentExecutionInput | SealedAgentExecutionInput;
/** A sealed execution carries the task's `sealing`; a plain one never does (the cloud's plain lane refuses it). */
export function isSealed<T extends { payload: object }>(execution: T): execution is Extract<T, { payload: { sealing: unknown } }> {
  return 'sealing' in execution.payload;
}
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
/** An intent as the ledger takes it: a routine occurrence may also run a sealed template. */
export type LedgerIntentInput = Omit<IntentInput, 'execution'> & { execution: IntentExecution };
export interface Intent extends LedgerIntentInput {
  id: string; agent: string; sequence: number; retry: RetryPolicy;
  phase: 'queued' | 'inflight' | 'backoff' | 'memory_blocked' | 'settled';
  memoryBlocked?: { resume: 'queued' | 'backoff'; reason: string };
  preparationError?: string;
  generation: number; taskId: string; notBefore: number; attempts: number;
  occurrence?: string; retryUntil?: number;
  cancelReason?: 'expired' | 'cancelled'; conclusion?: Conclusion;
}
export interface Execution {
  input: FrozenExecutionInput;
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
export type AgentRoutineDefinition = RoutineSchedule & { execution: IntentExecution; hostJob?: never; hostOccurrence?: never };
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
export { canonical, hash };
export function taskId(key: string, generation: number): string { return hash([key, generation]); }
/** The frozen execution input of one generation of an intent: its execution with that generation's task id. */
export function frozenInput(execution: IntentExecution, task: string): FrozenExecutionInput {
  return { ...structuredClone(execution), taskId: task } as FrozenExecutionInput;
}
const OCCURRENCE_INTENT_KEY = /^occurrence:[0-9a-f]{64}$/;
/** The intent key of a routine occurrence, from its occurrence key (a SHA-256 hex digest). */
export function occurrenceIntentKey(occurrenceKey: string): string { return `occurrence:${occurrenceKey}`; }
/** Whether an intent key is a routine occurrence's. Any other key is the Host's own. */
export function isOccurrenceIntentKey(key: string): boolean { return OCCURRENCE_INTENT_KEY.test(key); }
/** The occurrence key that a routine occurrence's intent key names, or undefined for any other key. */
export function occurrenceOfIntentKey(key: string): string | undefined {
  return isOccurrenceIntentKey(key) ? key.slice('occurrence:'.length) : undefined;
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
export function validateInput(input: LedgerIntentInput): void {
  if (!input.key.trim() || !['user', 'bot', 'routine'].includes(input.source)) throw new Error('Invalid intent identity');
  time(input.waitUntil);
  const { execution } = input;
  const { runtime, harnessId } = execution.payload;
  const validIdentity = runtime !== undefined
    ? harnessId === undefined && RuntimeIdSchema.safeParse(runtime).success
    : HarnessIdSchema.safeParse(harnessId).success;
  if (!execution.deviceId || !execution.payload.agentRef?.agentId || !execution.payload.agentRef.profileRevision
    || !validIdentity || !execution.payload.egressPolicy || !execution.payload.terminalProjection
    || execution.payload.session?.mode !== 'fresh' || 'taskId' in execution) throw new Error('Supply a complete fresh execution template');
  if (isSealed(execution)) validateSealed(execution, input.source);
  validateRetry(input.retry ?? DEFAULT_RETRY);
}
/**
 * K4 runs a sealed execution only as a routine template that seals task input alone:
 * - A task-bound ciphertext names one task id, and a retry generation gets a new one, so only the routine template binding,
 *   which names no task, survives a retry.
 * - K4 settles from the plaintext terminal and reads its outcome, so the output stays plaintext.
 * - The template must be inline: between occurrences no task holds a `ciphertextRef` blob, so orphan GC may delete it.
 */
function validateSealed(execution: SealedExecutionTemplate, source: IntentInput['source']): void {
  if (!TaskOfferSealedPayloadSchema.safeParse(execution.payload).success) throw new Error('Supply a valid sealed execution template');
  const { sealing, sealed, routineRef } = execution.payload;
  if (routineRef === undefined || source !== 'routine') throw new Error('A sealed execution must be a routine template occurrence');
  if (sealing.categories.length !== 1 || sealing.categories[0] !== 'task-input') throw new Error('A sealed execution seals task-input only');
  if (sealed !== undefined && 'ciphertextRef' in sealed) throw new Error('A sealed execution template must be inline');
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
