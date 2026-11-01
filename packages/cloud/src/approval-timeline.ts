import type { CollectExpiredInput, CollectExpiredResult } from '@byok-sdk/core';
import { tenantKey, type TenantId } from '@byok-sdk/core';
import { SealedTaskOutputSchema } from '@byok-sdk/protocol';
import { z } from 'zod';
import { ByokCloudError } from './errors';
import { sameSealedProjection } from './sealed-comparison';

export const DEFAULT_APPROVAL_TIMELINE_CAPACITY = 50;
/** How long a timeline stays readable after its task's output closes; there is no idle expiry (#1113 A3). */
export const DEFAULT_APPROVAL_TIMELINE_TTL_MS = 10 * 60 * 1_000;
/** Serialized UTF-8 bytes a timeline retains, counted over its observations' JSON. */
export const MAX_APPROVAL_TIMELINE_BYTES = 1024 * 1024;
/**
 * One event's serialized bound: half the timeline less room for observation
 * metadata, so the pending request and the next observation always fit.
 */
export const MAX_APPROVAL_EVENT_BYTES = MAX_APPROVAL_TIMELINE_BYTES / 2 - 4 * 1024;
export const APPROVAL_SUMMARY_MAX_BYTES = 16 * 1_024;

const NonBlankIdSchema = z.string().max(200).regex(/\S/, 'value must not be blank');
const TaskIdSchema = z.string().min(1).max(200);

const ApprovalRequestedEventSchema = z
  .object({
    type: z.literal('approval_requested'),
    summary: z.string(),
    approvalId: NonBlankIdSchema.optional(),
  })
  .strict();

/** A sealed `task.await_approval` request: the summary stays in `sealed` (#654 12e). */
const SealedApprovalRequestedEventSchema = z
  .object({
    type: z.literal('approval_requested'),
    approvalId: NonBlankIdSchema,
    sealed: SealedTaskOutputSchema,
  })
  .strict();

const LocalApprovalResolutionEventSchema = z
  .object({
    type: z.literal('approval_resolved'),
    // Absent only when a daemon resolved the single outstanding request without
    // native approval identity. No id is synthesized.
    approvalId: NonBlankIdSchema.optional(),
    decision: z.enum(['approve', 'reject']),
    // A daemon's `task.approval_resolved` is pure wire observation; it cannot
    // declare a host command payload.
    resolvedBy: z.literal('local'),
    at: z.iso.datetime({ offset: true }),
  })
  .strict();

const HostApprovalResolutionEventSchema = z
  .object({
    type: z.literal('approval_resolved'),
    approvalId: NonBlankIdSchema.optional(),
    decision: z.literal('approve'),
    resolvedBy: z.literal('host'),
    at: z.iso.datetime({ offset: true }),
  })
  .strict();

const HostRejectResolutionEventSchema = z
  .object({
    type: z.literal('approval_resolved'),
    approvalId: NonBlankIdSchema.optional(),
    decision: z.literal('reject'),
    resolvedBy: z.literal('host'),
    // Required even when the host deliberately omitted a wire reason. `null`
    // records that complete payload, so a historical host reject with no field
    // cannot be mistaken for a recoverable executable command.
    reason: z.string().nullable(),
    at: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ApprovalTimelineEventSchema = z.union([
  ApprovalRequestedEventSchema,
  SealedApprovalRequestedEventSchema,
  LocalApprovalResolutionEventSchema,
  HostApprovalResolutionEventSchema,
  HostRejectResolutionEventSchema,
]);

export type ApprovalTimelineEvent = Readonly<z.infer<typeof ApprovalTimelineEventSchema>>;

/**
 * True when two observations of one source envelope are the same event. A
 * sealed request compares by its comparison projection, so a retry that
 * sealed the same summary again is the same request (§9.2).
 */
export function sameApprovalTimelineEvent(left: ApprovalTimelineEvent, right: ApprovalTimelineEvent): boolean {
  return 'sealed' in left && 'sealed' in right
    ? sameSealedProjection(left, right)
    : JSON.stringify(left) === JSON.stringify(right);
}

export const ApprovalObservationSchema = z.object({
  taskId: TaskIdSchema,
  sourceEnvelopeId: NonBlankIdSchema,
  revision: z.number().int().positive(),
  receivedAt: z.iso.datetime(),
  event: ApprovalTimelineEventSchema,
});

export type ApprovalObservation = Readonly<z.infer<typeof ApprovalObservationSchema>>;

export interface ApprovalTimelineTail {
  readonly tenantId: TenantId;
  readonly taskId: string;
  readonly entries: readonly ApprovalObservation[];
  readonly cursor?: number;
  readonly dropped: number;
  readonly capacity: number;
  /**
   * When the task's output closed: its first terminal or an accepted Host
   * cancellation. From then on no observation or decision is admitted.
   */
  readonly terminalAt?: string;
  /** {@link DEFAULT_APPROVAL_TIMELINE_TTL_MS} after `terminalAt`; absent while the task is open. */
  readonly expiresAt?: string;
}

export interface ApprovalTimelineAppendInput {
  readonly taskId: string;
  readonly sourceEnvelopeId: string;
  readonly event: ApprovalTimelineEvent;
  /** Retained observations, 2 to {@link DEFAULT_APPROVAL_TIMELINE_CAPACITY}. */
  readonly capacity?: number;
}

/**
 * One host decision against the exact unresolved request it observed.
 *
 * The expected source/revision pair is the durable request identity.  A
 * resolver must not turn a stale read into a decision for a request which has
 * since been superseded, and it must not split one logical decision into
 * several mailbox controls.  Implementations serialize this comparison and
 * append under the timeline's per-task authority.
 */
export interface ApprovalTimelineResolvePendingInput extends ApprovalTimelineAppendInput {
  readonly expectedSourceEnvelopeId: string;
  readonly expectedRevision: number;
}

/** Result of a conditional host-decision append. Logical conflicts are data, not transport failures. */
export type ApprovalTimelineResolvePendingResult =
  | { readonly status: 'applied' | 'replayed'; readonly tail: ApprovalTimelineTail }
  | { readonly status: 'conflict' | 'superseded' | 'absent'; readonly tail?: ApprovalTimelineTail };

export interface ApprovalTimelineStore {
  collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult>;
  append(tenant: TenantId, input: ApprovalTimelineAppendInput): Promise<ApprovalTimelineTail>;
  /** Atomically append one host resolution only if its request remains current. */
  resolvePending(
    tenant: TenantId,
    input: ApprovalTimelineResolvePendingInput,
  ): Promise<ApprovalTimelineResolvePendingResult>;
  read(tenant: TenantId, taskId: string): Promise<ApprovalTimelineTail | undefined>;
}

export interface ValidatedApprovalTimelineAppend {
  readonly capacity: number;
  readonly event: ApprovalTimelineEvent;
}

export function validateApprovalTimelineAppend(
  input: ApprovalTimelineAppendInput,
): ValidatedApprovalTimelineAppend {
  const capacity = input.capacity ?? DEFAULT_APPROVAL_TIMELINE_CAPACITY;
  // Two keeps room for the pending request and the observation that follows it.
  if (!Number.isSafeInteger(capacity) || capacity < 2 || capacity > DEFAULT_APPROVAL_TIMELINE_CAPACITY) {
    throw new ByokCloudError(
      'coordination_input_invalid',
      `Approval timeline capacity must be an integer from 2 to ${DEFAULT_APPROVAL_TIMELINE_CAPACITY}, received ${String(capacity)}.`,
    );
  }
  const parsed = z
    .object({
      taskId: TaskIdSchema,
      sourceEnvelopeId: NonBlankIdSchema,
      event: ApprovalTimelineEventSchema,
    })
    .safeParse(input);
  if (!parsed.success) {
    throw new ByokCloudError(
      'coordination_input_invalid',
      'Approval observations require stable source identity and a valid native lifecycle event.',
    );
  }
  if (
    'summary' in parsed.data.event &&
    new TextEncoder().encode(parsed.data.event.summary).byteLength > APPROVAL_SUMMARY_MAX_BYTES
  ) {
    throw new ByokCloudError(
      'coordination_input_invalid',
      `Approval summary exceeds ${APPROVAL_SUMMARY_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  if (new TextEncoder().encode(JSON.stringify(parsed.data.event)).byteLength > MAX_APPROVAL_EVENT_BYTES) {
    throw new ByokCloudError('coordination_input_invalid', `Approval event exceeds ${MAX_APPROVAL_EVENT_BYTES} serialized UTF-8 bytes.`);
  }
  return { capacity, event: parsed.data.event };
}

export function validateApprovalTimelineResolve(
  input: ApprovalTimelineResolvePendingInput,
): ValidatedApprovalTimelineAppend {
  const validated = validateApprovalTimelineAppend(input);
  const expected = z
    .object({
      expectedSourceEnvelopeId: NonBlankIdSchema,
      expectedRevision: z.number().int().positive(),
    })
    .safeParse(input);
  if (!expected.success || validated.event.type !== 'approval_resolved' || validated.event.resolvedBy !== 'host') {
    throw new ByokCloudError(
      'coordination_input_invalid',
      'Host approval resolution requires an exact pending source/revision and a host resolution event.',
    );
  }
  return validated;
}

export function approvalTimelineKey(tenant: TenantId, taskId: string): string {
  return tenantKey(tenant, taskId);
}

export function parseApprovalObservations(value: unknown): readonly ApprovalObservation[] {
  return z.array(ApprovalObservationSchema).parse(value) as readonly ApprovalObservation[];
}

export function approvalTimelineCursor(
  entries: readonly ApprovalObservation[],
): number | undefined {
  return entries.at(-1)?.revision;
}

/**
 * The unresolved request: the latest request no later resolution names. A
 * resolution without an id resolves the single outstanding request.
 */
export function pendingApprovalObservation(entries: readonly ApprovalObservation[]): ApprovalObservation | undefined {
  let pending: ApprovalObservation | undefined;
  for (const entry of entries) {
    if (entry.event.type === 'approval_requested') {
      pending = entry;
      continue;
    }
    if (pending !== undefined && (pending.event.approvalId === undefined || pending.event.approvalId === entry.event.approvalId)) {
      pending = undefined;
    }
  }
  return pending;
}

function observationBytes(entry: ApprovalObservation): number {
  return new TextEncoder().encode(JSON.stringify(entry)).byteLength;
}

/**
 * Appends `observation` and evicts the oldest observations until at most
 * `capacity` remain within {@link MAX_APPROVAL_TIMELINE_BYTES}. The pending
 * request is never evicted: validation bounds every event to half the bytes
 * and capacity to at least two, so it and the new observation always fit.
 */
export function retainApprovalObservations(
  entries: readonly ApprovalObservation[],
  observation: ApprovalObservation,
  capacity: number,
): { readonly entries: readonly ApprovalObservation[]; readonly evicted: number } {
  const retained = [...entries, observation];
  const pending = pendingApprovalObservation(retained);
  let bytes = retained.reduce((total, entry) => total + observationBytes(entry), 0);
  let evicted = 0;
  while (retained.length > capacity || bytes > MAX_APPROVAL_TIMELINE_BYTES) {
    const index = retained.findIndex((entry) => entry !== pending);
    bytes -= observationBytes(retained.splice(index, 1)[0]!);
    evicted += 1;
  }
  return { entries: retained, evicted };
}
