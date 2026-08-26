import { z } from 'zod';
import { AgentEgressContentHashSchema, AgentEgressPolicyRevisionSchema } from './agent-egress';
import { AgentRefSchema, RuntimeIdSchema } from './messages';

/** Capability required before the optional hosted Agent-memory projection can be used. */
export const AGENT_MEMORY_PROJECTION_CAPABILITY = 'agent.memory.projection' as const;

/** One hosted projection is bounded before it enters the redaction or storage seam. */
export const AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES = 512 * 1024;

/** PostgreSQL `integer` ceiling shared by writer epochs and source sequences. */
export const AGENT_MEMORY_PROJECTION_MAX_ORDERING_VALUE = 2_147_483_647;

const OPAQUE_REFERENCE_MAX_BYTES = 512;
const opaqueReference = (field: string) => z
  .string()
  .min(1)
  .max(OPAQUE_REFERENCE_MAX_BYTES)
  .refine((value) => new TextEncoder().encode(value).byteLength <= OPAQUE_REFERENCE_MAX_BYTES, {
    message: `${field} must not exceed ${OPAQUE_REFERENCE_MAX_BYTES} UTF-8 bytes`,
  })
  .regex(/^[^\u0000-\u001f\u007f\r\n]+$/u, `${field} must not contain control characters`);

/** Opaque, embedder-issued authorization grant. It is never interpreted as a consent boolean. */
export const AgentMemoryProjectionGrantRefSchema = opaqueReference('grantRef');
export type AgentMemoryProjectionGrantRef = z.infer<typeof AgentMemoryProjectionGrantRefSchema>;

/** Exact local runtime session identity. No cwd or local source path is portable. */
export const AgentMemoryProjectionSessionRefSchema = opaqueReference('sessionRef');
export type AgentMemoryProjectionSessionRef = z.infer<typeof AgentMemoryProjectionSessionRefSchema>;

/** Positive epoch that changes only when the local single-writer authority changes. */
export const AgentMemoryProjectionWriterEpochSchema = z
  .number()
  .int()
  .positive()
  .max(AGENT_MEMORY_PROJECTION_MAX_ORDERING_VALUE);
export type AgentMemoryProjectionWriterEpoch = z.infer<typeof AgentMemoryProjectionWriterEpochSchema>;

/** Positive sequence within one writer epoch. A new epoch starts at one. */
export const AgentMemoryProjectionSourceSeqSchema = z
  .number()
  .int()
  .positive()
  .max(AGENT_MEMORY_PROJECTION_MAX_ORDERING_VALUE);
export type AgentMemoryProjectionSourceSeq = z.infer<typeof AgentMemoryProjectionSourceSeqSchema>;

/** Byte length implied by the unpadded base64url transport string. */
export function agentMemoryProjectionBase64UrlByteLength(value: string): number | undefined {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) return undefined;
  const complete = Math.floor(value.length / 4) * 3;
  const tail = value.length % 4;
  return complete + (tail === 0 ? 0 : tail - 1);
}

/**
 * The only body-bearing field in the hosted contract. It is already redacted
 * by the embedder; source bytes, raw-source hashes, cwd, and local paths never
 * cross this boundary. The hosted store re-hashes these bytes before commit.
 */
export const AgentMemoryProjectionSnapshotSchema = z
  .object({
    redactedHash: AgentEgressContentHashSchema,
    redactedByteCount: z.number().int().nonnegative().max(AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES),
    redactedBytes: z.string().max(Math.ceil(AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES / 3) * 4),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const actual = agentMemoryProjectionBase64UrlByteLength(snapshot.redactedBytes);
    if (actual === undefined) {
      ctx.addIssue({ code: 'custom', path: ['redactedBytes'], message: 'redactedBytes must be unpadded base64url' });
      return;
    }
    if (actual !== snapshot.redactedByteCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['redactedByteCount'],
        message: 'redactedByteCount must equal the decoded redactedBytes length',
      });
    }
  });
export type AgentMemoryProjectionSnapshot = z.infer<typeof AgentMemoryProjectionSnapshotSchema>;

/**
 * Device -> hosted mutation for one redacted full snapshot. It intentionally
 * contains no tenant/device identity: authenticated transport supplies both.
 * The snapshot is a one-way copy of local `MEMORY.md` plus local `notes/`, not
 * a remote authoring, merge, import, history, or RAG contract.
 */
export const AgentMemoryProjectionMutationSchema = z
  .object({
    taskId: z.string().min(1).max(512),
    agentRef: AgentRefSchema,
    sessionRef: AgentMemoryProjectionSessionRefSchema,
    runtimeId: RuntimeIdSchema,
    grantRef: AgentMemoryProjectionGrantRefSchema,
    writerEpoch: AgentMemoryProjectionWriterEpochSchema,
    sourceSeq: AgentMemoryProjectionSourceSeqSchema,
    mutationId: z.uuid(),
    policyRevision: AgentEgressPolicyRevisionSchema,
    snapshot: AgentMemoryProjectionSnapshotSchema,
  })
  .strict();
export type AgentMemoryProjectionMutation = z.infer<typeof AgentMemoryProjectionMutationSchema>;

/** Stable meter receipt for one accepted redacted snapshot; it never carries the snapshot body. */
export const AgentMemoryProjectionMeteringReceiptSchema = z
  .object({
    meteringReceiptId: z.uuid(),
    acceptedRedactedBytes: z.number().int().nonnegative().max(AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES),
    recordedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type AgentMemoryProjectionMeteringReceipt = z.infer<typeof AgentMemoryProjectionMeteringReceiptSchema>;

/** Immutable commit readback. It repeats identity and redacted metadata, never redacted bytes. */
export const AgentMemoryProjectionReceiptSchema = z
  .object({
    outcome: z.enum(['accepted', 'idempotent']),
    tenantId: z.string().min(1),
    deviceId: z.string().min(1),
    taskId: z.string().min(1).max(512),
    agentRef: AgentRefSchema,
    sessionRef: AgentMemoryProjectionSessionRefSchema,
    runtimeId: RuntimeIdSchema,
    grantRef: AgentMemoryProjectionGrantRefSchema,
    writerEpoch: AgentMemoryProjectionWriterEpochSchema,
    sourceSeq: AgentMemoryProjectionSourceSeqSchema,
    mutationId: z.uuid(),
    policyRevision: AgentEgressPolicyRevisionSchema,
    redactedHash: AgentEgressContentHashSchema,
    redactedByteCount: z.number().int().nonnegative().max(AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES),
    metering: AgentMemoryProjectionMeteringReceiptSchema,
  })
  .strict();
export type AgentMemoryProjectionReceipt = z.infer<typeof AgentMemoryProjectionReceiptSchema>;

/**
 * Server-side erase result. The returned epoch is the minimum legal epoch for
 * a later host-issued writer grant; erased source epochs can never re-enter.
 */
export const AgentMemoryProjectionEraseResultSchema = z
  .object({ nextWriterEpoch: AgentMemoryProjectionWriterEpochSchema })
  .strict();
export type AgentMemoryProjectionEraseResult = z.infer<typeof AgentMemoryProjectionEraseResultSchema>;
