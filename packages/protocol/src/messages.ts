import { z } from 'zod';
import { BlobRefSchema } from './blob';
import { PermissionPolicySchema } from './permission';
import { AgentEventSchema } from './agent-event';

/** Max size of an inlined artifact payload, per the delivery-model spec (<=64KB). */
const MAX_INLINE_BYTES = 64 * 1024;

function isWithinInlineByteLimit(value: string): boolean {
  return new TextEncoder().encode(value).length <= MAX_INLINE_BYTES;
}

// ---------------------------------------------------------------------------
// conn.* — connection handshake
// ---------------------------------------------------------------------------

/** daemon -> server: opening handshake. */
export const ConnHelloPayloadSchema = z.object({
  protocolVersions: z.array(z.number().int()),
  capabilities: z.array(z.string()),
  deviceId: z.string(),
  productId: z.string(),
  agents: z.unknown().optional(),
});
export type ConnHelloPayload = z.infer<typeof ConnHelloPayloadSchema>;

/** server -> daemon: handshake acknowledgement. */
export const ConnAckPayloadSchema = z.object({
  protocolVersion: z.number().int(),
  capabilities: z.array(z.string()),
  serverTime: z.iso.datetime({ offset: true }),
});
export type ConnAckPayload = z.infer<typeof ConnAckPayloadSchema>;

// ---------------------------------------------------------------------------
// server -> daemon: task.*
// ---------------------------------------------------------------------------

export const RuntimeIdSchema = z.enum(['pi', 'claude', 'codex']);
export type RuntimeId = z.infer<typeof RuntimeIdSchema>;

/** server -> daemon: offer a task for a device to claim. */
export const TaskOfferPayloadSchema = z.object({
  taskId: z.string(),
  instruction: z.union([z.string(), z.object({ blobRef: BlobRefSchema })]),
  policy: PermissionPolicySchema,
  runtime: RuntimeIdSchema.optional(),
  sessionRef: z.string().optional(),
  workspaceHint: z.string().optional(),
  limits: z
    .object({
      maxDurationMs: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .optional(),
});
export type TaskOfferPayload = z.infer<typeof TaskOfferPayloadSchema>;

/** server -> daemon: approve a pending `task.await_approval` request. */
export const TaskApprovePayloadSchema = z.object({});
export type TaskApprovePayload = z.infer<typeof TaskApprovePayloadSchema>;

/** server -> daemon: reject a pending `task.await_approval` request. */
export const TaskRejectPayloadSchema = z.object({
  reason: z.string().optional(),
});
export type TaskRejectPayload = z.infer<typeof TaskRejectPayloadSchema>;

/** server -> daemon: cancel a task in any non-terminal state. */
export const TaskCancelPayloadSchema = z.object({
  reason: z.string().optional(),
});
export type TaskCancelPayload = z.infer<typeof TaskCancelPayloadSchema>;

/** server -> daemon: inject steering text into a running task. */
export const TaskSteerPayloadSchema = z.object({
  text: z.string(),
});
export type TaskSteerPayload = z.infer<typeof TaskSteerPayloadSchema>;

// ---------------------------------------------------------------------------
// daemon -> server: task.*
// ---------------------------------------------------------------------------

/** daemon -> server: claim an offered task (idempotent CAS on the server side). */
export const TaskClaimPayloadSchema = z.object({
  taskId: z.string(),
  deviceId: z.string(),
  agentId: z.string().optional(),
});
export type TaskClaimPayload = z.infer<typeof TaskClaimPayloadSchema>;

/** daemon -> server: batch of normalized agent events. */
export const TaskProgressPayloadSchema = z.object({
  seq: z.number().int(),
  events: z.array(AgentEventSchema),
});
export type TaskProgressPayload = z.infer<typeof TaskProgressPayloadSchema>;

/** daemon -> server: an artifact produced by the task, inline or by blob ref. */
export const TaskArtifactPayloadSchema = z.object({
  name: z.string(),
  contentType: z.string(),
  inline: z
    .string()
    .refine(isWithinInlineByteLimit, {
      message: 'inline artifact payload exceeds 64KB limit',
    })
    .optional(),
  blobRef: BlobRefSchema.optional(),
});
export type TaskArtifactPayload = z.infer<typeof TaskArtifactPayloadSchema>;

/** daemon -> server: task is blocked on an out-of-band approval. */
export const TaskAwaitApprovalPayloadSchema = z.object({
  summary: z.string(),
});
export type TaskAwaitApprovalPayload = z.infer<typeof TaskAwaitApprovalPayloadSchema>;

/** daemon -> server: task finished successfully. */
export const TaskCompletePayloadSchema = z.object({
  summary: z.string(),
  sessionRef: z.string(),
  artifactRefs: z.array(BlobRefSchema).optional(),
});
export type TaskCompletePayload = z.infer<typeof TaskCompletePayloadSchema>;

/** daemon -> server: task failed. */
export const TaskFailPayloadSchema = z.object({
  reason: z.string(),
  retryable: z.boolean().optional(),
});
export type TaskFailPayload = z.infer<typeof TaskFailPayloadSchema>;

// ---------------------------------------------------------------------------
// registry — single source of truth mapping message type -> payload schema
// ---------------------------------------------------------------------------

export const MESSAGE_PAYLOAD_SCHEMAS = {
  'conn.hello': ConnHelloPayloadSchema,
  'conn.ack': ConnAckPayloadSchema,
  'task.offer': TaskOfferPayloadSchema,
  'task.approve': TaskApprovePayloadSchema,
  'task.reject': TaskRejectPayloadSchema,
  'task.cancel': TaskCancelPayloadSchema,
  'task.steer': TaskSteerPayloadSchema,
  'task.claim': TaskClaimPayloadSchema,
  'task.progress': TaskProgressPayloadSchema,
  'task.artifact': TaskArtifactPayloadSchema,
  'task.await_approval': TaskAwaitApprovalPayloadSchema,
  'task.complete': TaskCompletePayloadSchema,
  'task.fail': TaskFailPayloadSchema,
} as const;

export type MessageType = keyof typeof MESSAGE_PAYLOAD_SCHEMAS;

export const MESSAGE_TYPES = Object.keys(MESSAGE_PAYLOAD_SCHEMAS) as MessageType[];
