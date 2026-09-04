import { tenantKey, type TenantId } from '@byok-sdk/core';
import { z } from 'zod';
import { ByokCloudError } from './errors';

export const DEFAULT_APPROVAL_TIMELINE_CAPACITY = 50;
export const DEFAULT_APPROVAL_TIMELINE_TTL_MS = 10 * 60 * 1_000;
export const APPROVAL_SUMMARY_MAX_BYTES = 16 * 1_024;

const NonBlankIdSchema = z.string().max(200).regex(/\S/, 'value must not be blank');
const TaskIdSchema = z.string().min(1).max(200);

export const ApprovalTimelineEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('approval_requested'),
    summary: z.string(),
    approvalId: NonBlankIdSchema.optional(),
  }),
  z.object({
    type: z.literal('approval_resolved'),
    // Absent only when a host resolves the single outstanding request from a
    // pre-M5 daemon, which never supplied native approval identity. This is
    // explicit unpaired source data; no id is synthesized.
    approvalId: NonBlankIdSchema.optional(),
    decision: z.enum(['approve', 'reject']),
    /**
     * WHO resolved it. `'local'` is the daemon's own `task.approval_resolved`
     * (the wire value, `TaskApprovalResolvedPayloadSchema`); no device can
     * produce anything else. `'host'` is the control plane resolving it
     * through `ByokCloud.approveTask`/`rejectTask` — an embedded composition
     * (`@byok-sdk/server`) treats a host decision as authoritative the moment
     * it is enqueued, and the pending-approval slot is DERIVED from this tail
     * (`approval-control.ts`), so a host resolution left unrecorded would make
     * the one authority keep claiming an approval is outstanding that the
     * operator has already answered. Additive: `pendingApproval`'s fold reads
     * both values identically and no gate branches on this field.
     */
    resolvedBy: z.enum(['local', 'host']),
    at: z.iso.datetime({ offset: true }),
  }),
]);

export type ApprovalTimelineEvent = Readonly<z.infer<typeof ApprovalTimelineEventSchema>>;

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
  readonly expiresAt: string;
}

export interface ApprovalTimelineAppendInput {
  readonly taskId: string;
  readonly sourceEnvelopeId: string;
  readonly event: ApprovalTimelineEvent;
  readonly ttlMs?: number;
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
  readonly ttlMs: number;
  readonly event: ApprovalTimelineEvent;
}

export function validateApprovalTimelineAppend(
  input: ApprovalTimelineAppendInput,
): ValidatedApprovalTimelineAppend {
  const capacity = input.capacity ?? DEFAULT_APPROVAL_TIMELINE_CAPACITY;
  const ttlMs = input.ttlMs ?? DEFAULT_APPROVAL_TIMELINE_TTL_MS;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new ByokCloudError(
      'coordination_input_invalid',
      `Approval timeline capacity must be a positive integer, received ${String(capacity)}.`,
    );
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new ByokCloudError(
      'coordination_input_invalid',
      `Approval timeline ttl must be a positive number of milliseconds, received ${String(ttlMs)}.`,
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
    parsed.data.event.type === 'approval_requested' &&
    new TextEncoder().encode(parsed.data.event.summary).byteLength > APPROVAL_SUMMARY_MAX_BYTES
  ) {
    throw new ByokCloudError(
      'coordination_input_invalid',
      `Approval summary exceeds ${APPROVAL_SUMMARY_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  return { capacity, ttlMs, event: parsed.data.event };
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
