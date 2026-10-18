/** One Host-owned, one-shot wall-clock wake. Periodic rules remain in the Host. */
export interface WakeScheduleInput {
  dedupKey: string;
  availableAt: number;
  payload?: string;
}
export interface WakeScheduleResult { wakeId: string; accepted: boolean }
export interface DueWake {
  wakeId: string;
  dedupKey: string;
  availableAt: number;
  deliveredAt: number;
  delivery: number;
  payload?: string;
}
export interface WakeRecord {
  wakeId: string;
  dedupKey: string;
  availableAt: number;
  state: 'queued' | 'delivering';
  deliveries: number;
  lastError?: string;
  retryAt?: number;
  payload?: string;
}
export interface WakeConsumer { consume(wake: DueWake, signal: AbortSignal): Promise<void> }
export class WakeHookMissingError extends Error {
  constructor() { super('A wake.consume hook is required for scheduled or unfinished wakes'); this.name = 'WakeHookMissingError'; }
}
export class WakeConflictError extends Error {
  constructor() { super('Wake dedupKey already exists with different availableAt or payload'); this.name = 'WakeConflictError'; }
}
export type WakeInputErrorCode = 'WAKE_DEDUP_KEY_INVALID' | 'WAKE_AVAILABLE_AT_INVALID' | 'WAKE_PAYLOAD_TOO_LARGE';
export class WakeInputError extends Error {
  constructor(readonly code: WakeInputErrorCode) { super(code); this.name = 'WakeInputError'; }
}
export class WakeClosedError extends Error {
  constructor() { super('Embedded wake queue is closed'); this.name = 'WakeClosedError'; }
}
export const WAKE_WAIT_MS = 60_000;
export const WAKE_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Maximum allowed delay from the current time for a scheduled wake. */
export const MAX_FUTURE_MS = 368 * 24 * 60 * 60_000;
export function validateWakeKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length < 1 || [...key].length > 256) throw new WakeInputError('WAKE_DEDUP_KEY_INVALID');
}
export function validateWakeInput(input: WakeScheduleInput, now: number): WakeScheduleInput {
  validateWakeKey(input?.dedupKey);
  if (!Number.isSafeInteger(input.availableAt) || input.availableAt < 0 || input.availableAt - now > MAX_FUTURE_MS) {
    throw new WakeInputError('WAKE_AVAILABLE_AT_INVALID');
  }
  if (input.payload !== undefined && (typeof input.payload !== 'string' || Buffer.byteLength(input.payload, 'utf8') > 4096)) {
    throw new WakeInputError('WAKE_PAYLOAD_TOO_LARGE');
  }
  return { dedupKey: input.dedupKey, availableAt: input.availableAt, ...(input.payload === undefined ? {} : { payload: input.payload }) };
}
