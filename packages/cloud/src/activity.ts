import { tenantKey, type TenantId } from '@byok-sdk/core';
import { AgentEventOrUnknownSchema, type AgentEventOrUnknown } from '@byok-sdk/protocol';
import { z } from 'zod';
import { ByokCloudError } from './errors';

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

export interface ActivityCursor {
  readonly batchSeq: number;
  readonly eventIndex: number;
}

export interface ActivityTail {
  readonly tenantId: TenantId;
  readonly taskId: string;
  readonly entries: readonly TimelineEvent[];
  readonly cursor?: ActivityCursor;
  readonly dropped: number;
  readonly capacity: number;
  readonly expiresAt: string;
}

export interface ActivityAppendInput {
  readonly taskId: string;
  readonly sourceEnvelopeId: string;
  readonly batchSeq: number;
  readonly events: readonly AgentEventOrUnknown[];
  readonly dropped: number;
  readonly ttlMs: number;
  readonly capacity?: number;
}

export interface ActivityStore {
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
  const parsed = ActivityAppendRequestSchema.safeParse(input);
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
): readonly TimelineEvent[] {
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
  entries: readonly TimelineEvent[],
  input: ActivityAppendInput,
): 'absent' | 'same' | 'conflict' {
  const existing = entries
    .filter((entry) => entry.sourceEnvelopeId === input.sourceEnvelopeId)
    .sort((left, right) => left.eventIndex - right.eventIndex);
  if (existing.length === 0) return 'absent';
  if (existing.length !== input.events.length) return 'conflict';
  for (const [eventIndex, event] of input.events.entries()) {
    const stored = existing[eventIndex];
    if (
      stored === undefined ||
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

export function parseTimelineEvents(value: unknown): readonly TimelineEvent[] {
  return z.array(TimelineEventSchema).parse(value) as readonly TimelineEvent[];
}

export function compareTimelineEvents(left: TimelineEvent, right: TimelineEvent): number {
  return left.batchSeq - right.batchSeq || left.eventIndex - right.eventIndex;
}

export function activityCursor(
  entries: readonly TimelineEvent[],
): ActivityCursor | undefined {
  const last = entries.at(-1);
  return last === undefined ? undefined : { batchSeq: last.batchSeq, eventIndex: last.eventIndex };
}

export function activityTailKey(tenant: TenantId, taskId: string): string {
  return tenantKey(tenant, taskId);
}
