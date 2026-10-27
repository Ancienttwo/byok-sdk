import type { CollectExpiredInput, CollectExpiredResult } from '@byok-sdk/core';
import { tenantKey, type TenantId } from '@byok-sdk/core';
import { AgentEventOrUnknownSchema, SealedTaskOutputSchema, type AgentEventOrUnknown, type SealedPayload } from '@byok-sdk/protocol';
import { z } from 'zod';
import { ByokCloudError } from './errors';
import { sameSealedProjection } from './sealed-comparison';

export const DEFAULT_ACTIVITY_CAPACITY = 50;

const ActivityTaskIdSchema = z.string().min(1).max(200);
const SourceEnvelopeIdSchema = z
  .string()
  .max(200)
  .regex(/\S/, 'sourceEnvelopeId must not be blank');

export const ActivityAppendRequestSchema = z.object({
  taskId: ActivityTaskIdSchema,
  sourceEnvelopeId: SourceEnvelopeIdSchema,
  batchSeq: z.number().int().nonnegative(),
  events: z.array(AgentEventOrUnknownSchema).min(1),
  dropped: z.number().int().nonnegative(),
});

/** One sealed `task.progress` batch: its events stay in `sealed` (#654 12e). */
const SealedActivityAppendRequestSchema = z.object({
  taskId: ActivityTaskIdSchema,
  sourceEnvelopeId: SourceEnvelopeIdSchema,
  batchSeq: z.number().int().nonnegative(),
  sealed: SealedTaskOutputSchema,
  dropped: z.number().int().nonnegative(),
});

export const TimelineEventSchema = z.object({
  taskId: ActivityTaskIdSchema,
  sourceEnvelopeId: SourceEnvelopeIdSchema,
  batchSeq: z.number().int().nonnegative(),
  eventIndex: z.number().int().nonnegative(),
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

/**
 * One sealed batch in the tail (#654 12e). A sealed member covers the whole
 * batch, so the tail keeps one entry for it, and the tail capacity counts
 * batches. `eventIndex` is always 0, so the order key of a batch is the same
 * as for its first plaintext event. A member opens `sealed`.
 */
export const SealedActivityBatchSchema = z.object({
  taskId: ActivityTaskIdSchema,
  sourceEnvelopeId: SourceEnvelopeIdSchema,
  batchSeq: z.number().int().nonnegative(),
  eventIndex: z.literal(0),
  sourceDropped: z.number().int().nonnegative().optional(),
  receivedAt: z.iso.datetime(),
  sealed: SealedTaskOutputSchema,
});

export type SealedActivityBatch = Readonly<z.infer<typeof SealedActivityBatchSchema>>;

/** One tail entry: a plaintext event, or a sealed batch. */
export type ActivityTailEntry = TimelineEvent | SealedActivityBatch;

const ActivityTailEntrySchema = z.union([TimelineEventSchema, SealedActivityBatchSchema]);

export interface ActivityCursor {
  readonly batchSeq: number;
  readonly eventIndex: number;
}

export interface ActivityTail {
  readonly tenantId: TenantId;
  readonly taskId: string;
  readonly entries: readonly ActivityTailEntry[];
  readonly cursor?: ActivityCursor;
  readonly dropped: number;
  readonly capacity: number;
  readonly expiresAt: string;
}

interface ActivityAppendFields {
  readonly taskId: string;
  readonly sourceEnvelopeId: string;
  readonly batchSeq: number;
  readonly dropped: number;
  readonly ttlMs: number;
  readonly capacity?: number;
}

/** One batch to append: plaintext events, or one sealed member that covers the batch. */
export type ActivityAppendInput =
  | (ActivityAppendFields & { readonly events: readonly AgentEventOrUnknown[] })
  | (ActivityAppendFields & { readonly sealed: SealedPayload });

export interface ActivityStore {
  collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult>;
  /**
   * `sourceEnvelopeId` is the per-envelope idempotency authority. Repeating
   * its exact canonical batch returns the existing tail; changing any batch
   * fact under that identity is rejected rather than appended as a second
   * observation.
   */
  append(tenant: TenantId, input: ActivityAppendInput): Promise<ActivityTail>;
  read(tenant: TenantId, taskId: string): Promise<ActivityTail | undefined>;
}

export function validateActivityAppend(input: ActivityAppendInput): number {
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    throw new ByokCloudError(
      'coordination_input_invalid',
      `Activity ttl must be a positive number of milliseconds, received ${String(input.ttlMs)}.`,
    );
  }
  const capacity = input.capacity ?? DEFAULT_ACTIVITY_CAPACITY;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new ByokCloudError(
      'coordination_input_invalid',
      `Activity capacity must be a positive integer, received ${String(capacity)}.`,
    );
  }
  const parsed = ('sealed' in input ? SealedActivityAppendRequestSchema : ActivityAppendRequestSchema).safeParse(input);
  if (!parsed.success) {
    throw new ByokCloudError(
      'coordination_input_invalid',
      'Activity batches require stable source identity, order, at least one valid event, and a non-negative dropped count.',
    );
  }
  return capacity;
}

export function projectTimelineEvents(
  input: ActivityAppendInput,
  receivedAt: string,
): readonly ActivityTailEntry[] {
  if ('sealed' in input) {
    return [SealedActivityBatchSchema.parse({
      taskId: input.taskId,
      sourceEnvelopeId: input.sourceEnvelopeId,
      batchSeq: input.batchSeq,
      eventIndex: 0,
      sourceDropped: input.dropped,
      receivedAt,
      sealed: input.sealed,
    })];
  }
  return input.events.map((event, eventIndex) =>
    TimelineEventSchema.parse({
      taskId: input.taskId,
      sourceEnvelopeId: input.sourceEnvelopeId,
      batchSeq: input.batchSeq,
      eventIndex,
      sourceDropped: input.dropped,
      receivedAt,
      event,
    }),
  );
}

/**
 * Whether one live tail already contains this source envelope's canonical
 * batch. `conflict` includes a partially retained source: its missing events
 * are not evidence that a different batch may reuse the same source identity.
 */
export function activitySourceBatchState(
  entries: readonly ActivityTailEntry[],
  input: ActivityAppendInput,
): 'absent' | 'same' | 'conflict' {
  const existing = entries
    .filter((entry) => entry.sourceEnvelopeId === input.sourceEnvelopeId)
    .sort((left, right) => left.eventIndex - right.eventIndex);
  if (existing.length === 0) return 'absent';
  if ('sealed' in input) {
    // A retry that sealed the same batch again is the same batch (§9.2).
    const stored = existing[0];
    return existing.length === 1 && stored !== undefined && 'sealed' in stored
      && stored.taskId === input.taskId && stored.batchSeq === input.batchSeq && stored.sourceDropped === input.dropped
      && sameSealedProjection({ sealed: stored.sealed }, { sealed: input.sealed })
      ? 'same'
      : 'conflict';
  }
  if (existing.length !== input.events.length) return 'conflict';
  for (const [eventIndex, event] of input.events.entries()) {
    const stored = existing[eventIndex];
    if (
      stored === undefined ||
      !('event' in stored) ||
      stored.taskId !== input.taskId ||
      stored.batchSeq !== input.batchSeq ||
      stored.eventIndex !== eventIndex ||
      stored.sourceDropped !== input.dropped ||
      JSON.stringify(stored.event) !== JSON.stringify(event)
    ) {
      return 'conflict';
    }
  }
  return 'same';
}

export function parseTimelineEvents(value: unknown): readonly ActivityTailEntry[] {
  return z.array(ActivityTailEntrySchema).parse(value) as readonly ActivityTailEntry[];
}

export function compareTimelineEvents(left: ActivityTailEntry, right: ActivityTailEntry): number {
  return left.batchSeq - right.batchSeq || left.eventIndex - right.eventIndex;
}

export function activityCursor(
  entries: readonly ActivityTailEntry[],
): ActivityCursor | undefined {
  const last = entries.at(-1);
  return last === undefined ? undefined : { batchSeq: last.batchSeq, eventIndex: last.eventIndex };
}

export function activityTailKey(tenant: TenantId, taskId: string): string {
  return tenantKey(tenant, taskId);
}
