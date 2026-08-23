import { z } from 'zod';

/** Additive daemon capability names. Server/cloud admission consumes these exactly. */
export const AGENT_EGRESS_POLICY_CAPABILITY = 'agent-egress-policy' as const;
export const AGENT_EGRESS_RELIABLE_ACK_CAPABILITY = 'agent-egress-reliable-ack' as const;
export const AGENT_CONTENT_WORKSPACE_READ_CAPABILITY = 'agent-content-workspace-read' as const;
export const AGENT_CONTENT_TRANSCRIPT_READ_CAPABILITY = 'agent-content-transcript-read' as const;
export const AGENT_CONTENT_ARTIFACT_READ_CAPABILITY = 'agent-content-artifact-read' as const;

/**
 * Agent-local/cloud egress is an explicit, versioned contract.  This module
 * owns the public policy and fact vocabulary; transport messages compose it
 * with Agent identity in `messages.ts` so the two directions do not create
 * competing policy shapes.
 */

const POLICY_REVISION = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^\u0000-\u001f\u007f\r\n]+$/u, 'policyRevision must not contain control characters');

const POSITIVE_LIMIT = z.number().int().positive().max(2_147_483_647);
export const AgentContentMimeTypeSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu, 'MIME types must be explicit type/subtype values');

/** Explicit MIME and byte policy for one independently-authorized content surface. */
export const ContentReadPolicySchema = z
  .object({
    maxBytes: POSITIVE_LIMIT,
    allowedMimeTypes: z.array(AgentContentMimeTypeSchema).min(1).max(32),
  })
  .strict();
export type ContentReadPolicy = z.infer<typeof ContentReadPolicySchema>;

export const AgentEgressActivityPolicySchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('metadata-status'),
      delivery: z.literal('latest-value'),
    })
    .strict(),
  z
    .object({
      mode: z.literal('contentful-trajectory'),
      delivery: z.literal('latest-value'),
      maxCoalesceMs: POSITIVE_LIMIT,
      maxEventBytes: POSITIVE_LIMIT,
    })
    .strict(),
]);
export type AgentEgressActivityPolicy = z.infer<typeof AgentEgressActivityPolicySchema>;

export const AgentReliableQuotaPolicySchema = z
  .object({
    maxPendingEventsPerAgent: POSITIVE_LIMIT,
    maxPendingBytesPerAgent: POSITIVE_LIMIT,
    maxPendingBytesPerTenant: POSITIVE_LIMIT,
  })
  .strict();
export type AgentReliableQuotaPolicy = z.infer<typeof AgentReliableQuotaPolicySchema>;

/**
 * The only consumable policy shape for Agent egress.  Missing/unknown policy
 * is intentionally not represented as a default: callers must select a
 * revision and all three content surfaces independently.
 */
export const AgentEgressPolicySchema = z
  .object({
    policyRevision: POLICY_REVISION,
    activity: AgentEgressActivityPolicySchema,
    reliable: AgentReliableQuotaPolicySchema,
    transfers: z
      .object({
        workspace: z.union([z.literal('disabled'), ContentReadPolicySchema]),
        transcript: z.union([z.literal('disabled'), ContentReadPolicySchema]),
        artifact: z.union([z.literal('disabled'), ContentReadPolicySchema]),
      })
      .strict(),
  })
  .strict();
export type AgentEgressPolicy = z.infer<typeof AgentEgressPolicySchema>;

/** Delivery stores are semantically distinct; this enum is never a durable boolean. */
export const AgentEgressLaneSchema = z.enum(['reliable', 'latest-value']);
export type AgentEgressLane = z.infer<typeof AgentEgressLaneSchema>;

/** Every refusal/replacement is observable rather than silently degrading to another lane. */
export const AgentEgressDropReasonSchema = z.enum([
  'policy_denied',
  'capability_missing',
  'sanitizer_rejected',
  'quota_exceeded',
  'backpressure',
  'coalesced',
  'disconnected',
  'invalid_envelope',
  'ack_mismatch',
]);
export type AgentEgressDropReason = z.infer<typeof AgentEgressDropReasonSchema>;

export const AgentContentReadSurfaceSchema = z.enum(['workspace', 'transcript', 'artifact']);
export type AgentContentReadSurface = z.infer<typeof AgentContentReadSurfaceSchema>;

/** The product-selected actor is explicit; tenant/device are bound by the authenticated transport. */
export const AgentContentActorKindSchema = z.enum(['user', 'agent', 'system']);
export type AgentContentActorKind = z.infer<typeof AgentContentActorKindSchema>;

export const AgentContentActorSchema = z
  .object({
    kind: AgentContentActorKindSchema,
    id: z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/u, 'actor id must not contain control characters'),
  })
  .strict();
export type AgentContentActor = z.infer<typeof AgentContentActorSchema>;

/** No byte/text interpretation is inferred from a target name or MIME declaration. */
export const AgentContentDecodeAsSchema = z.enum(['bytes', 'utf8']);
export type AgentContentDecodeAs = z.infer<typeof AgentContentDecodeAsSchema>;

export const AgentContentReadDecisionSchema = z.enum(['allowed', 'denied']);
export type AgentContentReadDecision = z.infer<typeof AgentContentReadDecisionSchema>;

export const AgentContentReadDenialReasonSchema = z.enum([
  'invalid-request',
  'policy-disabled',
  'capability-missing',
  'policy-revision-mismatch',
  'absolute-target',
  'non-relative-target',
  'dot-segment',
  'sensitive-name',
  'root-not-allowlisted',
  'root-invalid',
  'path-escape',
  'target-missing',
  'symlink',
  'not-regular-file',
  'byte-limit',
  'mime-not-allowlisted',
  'text-not-allowlisted',
  'text-decode-failed',
  'identity-mismatch',
]);
export type AgentContentReadDenialReason = z.infer<typeof AgentContentReadDenialReasonSchema>;

/** SHA-256 transport receipt hash, never a content byte projection. */
export const AgentEgressContentHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u, 'contentHash must be a lowercase SHA-256 digest');

export const AgentEgressPolicyRevisionSchema = POLICY_REVISION;
