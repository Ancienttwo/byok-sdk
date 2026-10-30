import type { CollectExpiredInput, CollectExpiredResult, TenantId } from '@byok-sdk/core';
import { tenantKey } from '@byok-sdk/core';
import { AgentEventOrUnknownSchema, SealedTaskOutputSchema, TaskArtifactPayloadSchema, type AgentEventOrUnknown, type SealedPayload, type TaskArtifactPayload } from '@byok-sdk/protocol';
import { z } from 'zod';
import { ByokCloudError } from './errors';
import { sealedComparisonProjection } from './sealed-comparison';

export const DEFAULT_ACTIVITY_CAPACITY = 1000;
export const MAX_ACTIVITY_BYTES = 4 * 1024 * 1024;
export const ACTIVITY_TERMINAL_TTL_MS = 10 * 60_000;
const ActivityTaskIdSchema = z.string().min(1).max(200);
const SourceEnvelopeIdSchema = z.string().max(200).regex(/\S/);
const source = { taskId: ActivityTaskIdSchema, sourceEnvelopeId: SourceEnvelopeIdSchema };
export const ActivityAppendRequestSchema = z.object({
  ...source, batchSeq: z.number().int().nonnegative(),
  events: z.array(AgentEventOrUnknownSchema), dropped: z.number().int().nonnegative(),
});
const SealedProgressSchema = z.object({
  ...source, batchSeq: z.number().int().nonnegative(),
  sealed: SealedTaskOutputSchema, dropped: z.number().int().nonnegative(),
});
const ArtifactAppendSchema = z.object({
  ...source, artifact: TaskArtifactPayloadSchema.refine(value => value.sealed === undefined, 'Sealed artifacts require #1045 item 6'),
});

export const TimelineEventSchema = z.object({
  taskId: ActivityTaskIdSchema,
  sourceEnvelopeId: SourceEnvelopeIdSchema,
  batchSeq: z.number().int().nonnegative(),
  eventIndex: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  /**
   * The producer-declared loss attached to this source batch. It travels with
   * every retained event so a replay includes it in the canonical batch
   * binding rather than treating the aggregate as an incidental counter.
   */
  sourceDropped: z.number().int().nonnegative().optional(),
  receivedAt: z.iso.datetime(),
  event: AgentEventOrUnknownSchema,
});

export type TimelineEvent = Readonly<z.infer<typeof TimelineEventSchema>>;


interface ActivityEntryFields {
  readonly taskId: string;
  readonly sourceEnvelopeId: string;
  readonly revision: number;
  readonly receivedAt: string;
}
export type ActivityTailEntry = ActivityEntryFields & (
  | { readonly kind: 'progress'; readonly batchSeq: number; readonly sourceDropped: number; readonly events: readonly AgentEventOrUnknown[] }
  | { readonly kind: 'sealed-progress'; readonly batchSeq: number; readonly sourceDropped: number; readonly sealed: SealedPayload }
  | { readonly kind: 'artifact'; readonly artifact: Extract<TaskArtifactPayload, { sealed?: undefined }> }
);

/** One durable log position. Source batch sequence is provenance, not a resume cursor. */
export interface ActivityCursor {
  readonly version: 1;
  readonly tenantId: TenantId;
  readonly taskId: string;
  readonly generation: string;
  readonly revision: number;
}
export interface ActivityReadOptions { readonly after?: ActivityCursor }
export interface ActivityTail {
  readonly tenantId: TenantId;
  readonly taskId: string;
  readonly entries: readonly ActivityTailEntry[];
  readonly cursor: ActivityCursor;
  /** Last evicted revision: a cursor strictly below this floor has a gap. */
  readonly floor: number;
  /** Exclusive lower revision served by this page; zero for an unfiltered read. */
  readonly after: number;
  readonly dropped: number;
  readonly sourceDropped: number;
  readonly capacity: number;
  readonly byteCapacity: number;
  readonly retainedBytes: number;
  readonly terminalAt?: string;
  readonly expiresAt?: string;
}
interface ActivityAppendFields {
  readonly taskId: string;
  readonly sourceEnvelopeId: string;
  /** Terminal-relative duration, never an idle timer; capped at ten minutes. */
  readonly ttlMs: number;
  readonly capacity?: number;
  readonly byteCapacity?: number;
}
export type ActivityAppendInput = ActivityAppendFields & (
  | { readonly batchSeq: number; readonly dropped: number; readonly events: readonly AgentEventOrUnknown[] }
  | { readonly batchSeq: number; readonly dropped: number; readonly sealed: SealedPayload }
  | { readonly artifact: Extract<TaskArtifactPayload, { sealed?: undefined }> }
);
export interface ActivityStore {
  collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult>;
  append(tenant: TenantId, input: ActivityAppendInput): Promise<ActivityTail>;
  read(tenant: TenantId, taskId: string, options?: ActivityReadOptions): Promise<ActivityTail | undefined>;
  /**
   * Freeze first terminal and final revision under the same task serialization as append.
   * Durable adapters must enlist this boundary in the canonical lifecycle transaction (A3).
   */
  settle(tenant: TenantId, taskId: string, terminalAt: string): Promise<ActivityTail>;
}

export function validateActivityAppend(input: ActivityAppendInput): number {
  const capacity = input.capacity ?? DEFAULT_ACTIVITY_CAPACITY;
  const byteCapacity = input.byteCapacity ?? MAX_ACTIVITY_BYTES;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > DEFAULT_ACTIVITY_CAPACITY
    || !Number.isSafeInteger(byteCapacity) || byteCapacity < 1 || byteCapacity > MAX_ACTIVITY_BYTES
    || !Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > ACTIVITY_TERMINAL_TTL_MS) {
    throw new ByokCloudError('coordination_input_invalid', 'Activity retention bounds exceed the declared limits.');
  }
  const parsed = ('artifact' in input ? ArtifactAppendSchema : 'sealed' in input ? SealedProgressSchema : ActivityAppendRequestSchema).safeParse(input);
  if (!parsed.success) throw new ByokCloudError('coordination_input_invalid', 'Activity requires a valid source envelope and output payload.');
  return capacity;
}

/** Sorted object keys give adapters one byte representation and one source fence hash. */
export function canonicalActivityJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
export function activityEntryBytes(entry: ActivityTailEntry): number {
  return new TextEncoder().encode(canonicalActivityJson(entry)).byteLength;
}
export function createActivityEntry(input: ActivityAppendInput, revision: number, receivedAt: string): ActivityTailEntry {
  const base = { taskId: input.taskId, sourceEnvelopeId: input.sourceEnvelopeId, revision, receivedAt };
  if ('artifact' in input) return { ...base, kind: 'artifact', artifact: structuredClone(input.artifact) };
  const progress = { ...base, batchSeq: input.batchSeq, sourceDropped: input.dropped };
  return 'sealed' in input ? { ...progress, kind: 'sealed-progress', sealed: structuredClone(input.sealed) }
    : { ...progress, kind: 'progress', events: structuredClone(input.events) };
}
export async function activitySourceHash(input: ActivityAppendInput): Promise<string> {
  const { capacity: _capacity, byteCapacity: _bytes, ttlMs: _ttl, ...source } = input;
  const bytes = new TextEncoder().encode(canonicalActivityJson(sealedComparisonProjection(source)));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Deterministic progress view; artifacts have their own renderer and sealed content must be opened by a member. */
export function projectTimelineEvents(entry: Extract<ActivityTailEntry, { kind: 'progress' }>): readonly TimelineEvent[] {
  return entry.events.map((event, eventIndex) => ({
    taskId: entry.taskId, sourceEnvelopeId: entry.sourceEnvelopeId, batchSeq: entry.batchSeq,
    revision: entry.revision, offset: eventIndex, eventIndex, sourceDropped: entry.sourceDropped, receivedAt: entry.receivedAt, event,
  }));
}
export function activityTailKey(tenant: TenantId, taskId: string): string { return tenantKey(tenant, taskId); }
