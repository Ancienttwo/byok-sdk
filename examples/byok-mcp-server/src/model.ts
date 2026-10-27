import { createHash } from 'node:crypto';
import { AgentRefSchema, RuntimeIdSchema, type AgentRef, type RuntimeId } from '@byok-sdk/protocol';

export const SCOPES = ['tasks.dispatch', 'tasks.read', 'tasks.cancel', 'artifacts.read',
  'routines.read', 'routines.write', 'memory.read', 'memory.write'] as const;
export type Scope = typeof SCOPES[number];
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Quota { runningTasks: number; submitsPerHour: number; routines: number; statusPerMinute: number }
export const DEFAULT_QUOTA: Readonly<Quota> = Object.freeze({ runningTasks: 4, submitsPerHour: 60, routines: 8, statusPerMinute: 120 });
export const WINDOW_MS = 15 * 60_000;
export const MAX_INSTRUCTION_BYTES = 32 * 1024;
export const MAX_ARGUMENT_BYTES = 4 * 1024 * 1024;

export type RefusalCode = 'unauthorized' | 'forbidden' | 'not_found' | 'invalid_input' | 'quota_exceeded' | 'rate_limited' | 'idempotency_conflict' | 'unavailable';
export class BetaError extends Error {
  constructor(readonly code: RefusalCode, message: string, readonly retryAfterSeconds?: number) {
    super(message); this.name = 'BetaError';
  }
}
export function invalid(): never { throw new BetaError('invalid_input', 'Invalid beta input'); }

export interface KeySpec {
  label: string;
  scopes: readonly Scope[];
  deviceIds: readonly string[];
  runtimes: readonly RuntimeId[];
  agentRef?: Readonly<AgentRef>;
  quota?: Partial<Quota>;
}
export interface KeyInfo extends Omit<KeySpec, 'quota'> {
  readonly keyId: string;
  readonly tenant: string;
  readonly quota: Readonly<Quota>;
  readonly createdAt: number;
  readonly revokedAt?: number;
}
/** The ledger recognizes the actual authenticated object, not these public fields. */
export interface Caller extends KeyInfo {}
export interface TaskArguments {
  runtime: RuntimeId;
  instruction: string;
  workspace?: string;
  toolsets?: readonly string[];
  resultSchema?: Readonly<Record<string, Json>>;
  clientRequestId?: string;
}
export interface TaskBinding {
  readonly deviceId: string;
  readonly agentRef?: Readonly<AgentRef>;
  readonly arguments: Readonly<TaskArguments>;
}
export interface TaskReservation {
  readonly taskId: string;
  readonly keyId: string;
  readonly binding: TaskBinding;
  readonly createdAt: number;
  readonly slotReleased: boolean;
  readonly deduplicated: boolean;
}
export interface RoutineReservation {
  readonly routineId: string;
  readonly keyId: string;
  readonly localId: string;
  readonly createdAt: number;
  readonly slotReleased: boolean;
  readonly deduplicated: boolean;
}
export interface QuotaSnapshot {
  runningTasks: number;
  remainingSubmits: number;
  routines: number;
  remainingStatusReads: number;
}

export function text(value: unknown, maxBytes = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || Buffer.byteLength(value) > maxBytes) invalid();
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !(key in value))) invalid();
}
function list<T>(value: unknown, parse: (item: unknown) => T, allowEmpty = false): T[] {
  if (!Array.isArray(value) || value.length > 64 || (!allowEmpty && value.length === 0)) invalid();
  const parsed = value.map(parse);
  if (new Set(parsed).size !== parsed.length) invalid();
  return parsed;
}
export function scope(value: unknown): Scope {
  if (typeof value !== 'string' || !SCOPES.includes(value as Scope)) invalid();
  return value as Scope;
}
export function agentScope(value: Scope): boolean { return value === 'tasks.dispatch' || value.startsWith('memory.') || value.startsWith('routines.'); }
function runtime(value: unknown): RuntimeId {
  const parsed = RuntimeIdSchema.safeParse(value);
  if (!parsed.success) invalid();
  return parsed.data;
}
export function keySpec(value: unknown, stored = false): Omit<KeySpec, 'quota'> & { quota: Quota } {
  const input = object(JSON.parse(canonicalJson(value)));
  keys(input, ['label', 'scopes', 'deviceIds', 'runtimes', 'agentRef', 'quota'], ['label', 'scopes', 'deviceIds', 'runtimes', ...(stored ? ['quota'] : [])]);
  const quota = { ...DEFAULT_QUOTA };
  if (input.quota !== undefined) {
    const proposed = object(input.quota);
    keys(proposed, Object.keys(quota), stored ? Object.keys(quota) : []);
    for (const name of Object.keys(quota) as Array<keyof Quota>) {
      const limit = proposed[name];
      if (limit === undefined) continue;
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) invalid();
      quota[name] = limit;
    }
  }
  const scopes = list(input.scopes, scope, true);
  const parsedAgent = input.agentRef === undefined ? undefined : AgentRefSchema.safeParse(input.agentRef);
  if (parsedAgent && !parsedAgent.success || !parsedAgent && scopes.some(agentScope)) invalid();
  return { label: text(input.label, 128), scopes, deviceIds: list(input.deviceIds, item => text(item)), runtimes: list(input.runtimes, runtime),
    ...(parsedAgent?.success ? { agentRef: parsedAgent.data } : {}), quota };
}
export function taskArguments(value: unknown): TaskArguments {
  const input = object(JSON.parse(canonicalJson(value)));
  keys(input, ['runtime', 'instruction', 'workspace', 'toolsets', 'resultSchema', 'clientRequestId'], ['runtime', 'instruction']);
  if (typeof input.instruction !== 'string' || !input.instruction.trim() || Buffer.byteLength(input.instruction) > MAX_INSTRUCTION_BYTES) invalid();
  const requestId = input.clientRequestId === undefined ? undefined : text(input.clientRequestId);
  if (requestId !== undefined && !/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) invalid();
  const workspace = input.workspace === undefined ? undefined : text(input.workspace);
  if (workspace !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(workspace))) invalid();
  return { runtime: runtime(input.runtime), instruction: input.instruction,
    ...(workspace === undefined ? {} : { workspace }),
    ...(input.toolsets === undefined ? {} : { toolsets: list(input.toolsets, item => text(item), true) }),
    ...(input.resultSchema === undefined ? {} : { resultSchema: object(input.resultSchema) as Record<string, Json> }),
    ...(requestId === undefined ? {} : { clientRequestId: requestId }) };
}

/** Bounded, deterministic JSON. Reject lossy values before they become identity. */
export function canonicalJson(value: unknown): string {
  const parts: string[] = [];
  const active = new Set<object>();
  let bytes = 0; let nodes = 0;
  const append = (part: string) => { bytes += Buffer.byteLength(part); if (bytes > MAX_ARGUMENT_BYTES) invalid(); parts.push(part); };
  const walk = (item: unknown, depth: number): void => {
    if (++nodes > 10_000 || depth > 32) invalid();
    if (item === null || typeof item === 'boolean' || typeof item === 'string' || typeof item === 'number' && Number.isFinite(item)) {
      append(JSON.stringify(item)); return;
    }
    if (!item || typeof item !== 'object' || active.has(item)) invalid();
    const array = Array.isArray(item);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) invalid();
    if (Object.getOwnPropertySymbols(item).length) invalid();
    const names = array ? Object.keys(item) : Object.keys(item).sort();
    if (array && names.length !== item.length) invalid();
    active.add(item); append(array ? '[' : '{');
    names.forEach((name, index) => {
      if (array && name !== String(index)) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(item, name)!;
      if (!('value' in descriptor)) invalid();
      if (index) append(',');
      if (!array) { append(JSON.stringify(name)); append(':'); }
      walk(descriptor.value, depth + 1);
    });
    append(array ? ']' : '}'); active.delete(item);
  };
  walk(value, 0); return parts.join('');
}
export function hash(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
