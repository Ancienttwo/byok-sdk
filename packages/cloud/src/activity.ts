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
      receivedAt,
      event,
    }),
  );
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
