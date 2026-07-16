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

export const RuntimeIdSchema = z.enum(['pi', 'claude', 'codex']);
export type RuntimeId = z.infer<typeof RuntimeIdSchema>;

/**
 * Runtime detection info reported in `conn.hello`. Supersedes the M0
 * `agents: unknown` field (M1 gap #4): typed, so the server no longer has to
 * best-effort-normalize an untyped blob.
 */
export const RuntimeInfoSchema = z.object({
  id: RuntimeIdSchema,
  version: z.string().optional(),
  authPresent: z.boolean().optional(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

/** daemon -> server: opening handshake. */
export const ConnHelloPayloadSchema = z.object({
  protocolVersions: z.array(z.number().int()),
  capabilities: z.array(z.string()),
  deviceId: z.string(),
  productId: z.string(),
  /** Runtimes detected on this device (M1 gap #4; replaces `agents`). */
  runtimes: z.array(RuntimeInfoSchema).optional(),
  /**
   * Last `seq` this device has seen from the server (M1 redelivery cursor).
   * Omitted on a device's first-ever connection. The server replays any
   * server->daemon envelopes with `seq > cursor` it still holds — see
   * docs/protocol.md "At-least-once delivery".
   */
  cursor: z.number().int().optional(),
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
//
// Every type in this section carries a *required* envelope `task_id` (M1 gap
// #1) and a *required* envelope `seq` — a per-device monotonic counter the
// daemon uses as a redelivery cursor (M1 gap; see `conn.hello.cursor` above
// and docs/protocol.md "At-least-once delivery"). None of these payloads
// duplicate `taskId` at the payload level (M1 gap #7): the envelope's
// `task_id` is the single routing key.
// ---------------------------------------------------------------------------

/**
 * server -> daemon: offer a task for a device to claim.
 *
 * `taskId` used to be duplicated here; it is now carried only by the
 * envelope's `task_id` (M1 gap #7 — single source of truth for routing).
 */
export const TaskOfferPayloadSchema = z.object({
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

/**
 * server -> daemon: approve a pending `task.await_approval` request.
 *
 * Semantics (M1 gap #3): the server's own state is authoritative on its own
 * action — calling the server-side `approve()` API moves the task record
 * `AwaitApproval -> Running` immediately. This wire message is a best-effort
 * *notification* telling the daemon to resume the paused runtime session; the
 * daemon does not send a dedicated ack. Its outcome is observable through the
 * task's existing message stream (e.g. `task.progress` resuming, or
 * `task.fail`/`task.cancelled` if resuming turns out to be impossible) — no
 * new ack message type is introduced. See docs/protocol.md "Approval flow".
 */
export const TaskApprovePayloadSchema = z.object({});
export type TaskApprovePayload = z.infer<typeof TaskApprovePayloadSchema>;

/**
 * server -> daemon: reject a pending `task.await_approval` request.
 *
 * Same best-effort-notification semantics as `task.approve` (M1 gap #3): the
 * server moves its own record `AwaitApproval -> Failed` immediately; this
 * message just tells the daemon to stop, and the daemon reports the outcome
 * via its existing `task.fail` terminal message.
 */
export const TaskRejectPayloadSchema = z.object({
  reason: z.string().optional(),
});
export type TaskRejectPayload = z.infer<typeof TaskRejectPayloadSchema>;

/**
 * server -> daemon: cancel a task in any non-terminal state.
 *
 * Same best-effort-notification semantics (M1 gap #3): the server moves its
 * own record to `Cancelled` immediately on its own action and does not wait
 * for a daemon ack; this message just tells the daemon to stop local work.
 * The daemon reports the outcome via the explicit `task.cancelled` terminal
 * message (M1 gap #6) — not `task.fail`.
 */
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
//
// Every type in this section carries a *required* envelope `task_id` (M1 gap
// #1 — these all route by task id). Envelope `seq` (the redelivery cursor)
// stays optional in this direction: M1 only specifies at-least-once
// server->daemon redelivery, not a daemon->server one (see
// docs/protocol.md).
// ---------------------------------------------------------------------------

/**
 * daemon -> server: claim an offered task (idempotent CAS on the server
 * side). `taskId` used to be duplicated here; it is now carried only by the
 * envelope's `task_id` (M1 gap #7).
 *
 * Claiming no longer implies the task is `Running` (M1 gap #2) — see
 * `task.started`.
 */
export const TaskClaimPayloadSchema = z.object({
  deviceId: z.string(),
  agentId: z.string().optional(),
});
export type TaskClaimPayload = z.infer<typeof TaskClaimPayloadSchema>;

/**
 * daemon -> server: explicit `Claimed -> Running` transition (M1 gap #2).
 * A `task.claim` no longer implies the task started running; the daemon
 * sends this once it has actually started the runtime session for the task.
 */
export const TaskStartedPayloadSchema = z.object({});
export type TaskStartedPayload = z.infer<typeof TaskStartedPayloadSchema>;

/**
 * daemon -> server: decline an offer *before* claiming it (M1 gap #5) — e.g.
 * no compatible/available runtime, or the offered policy exceeds this
 * device's ceiling. Fail-closed rejections must use this instead of silently
 * dropping the offer.
 *
 * Decision (see docs/protocol.md "Declined vs. Failed" for the full
 * writeup): declining does *not* introduce a new `Declined` terminal state.
 * It maps onto the existing `Failed` state via a new `Offered -> Failed`
 * transition. `reason`/`retryable` intentionally mirror `TaskFailPayload`
 * exactly, because a pre-claim decline and a post-claim failure are the same
 * outcome from the dispatcher's point of view (this attempt produced no
 * result; here's whether retrying — e.g. offering to a different device —
 * makes sense), and keeping the state machine minimal avoids forking every
 * terminal-state consumer into "Failed or Declined, handle both".
 */
export const TaskDeclinePayloadSchema = z.object({
  reason: z.string(),
  retryable: z.boolean().optional(),
});
export type TaskDeclinePayload = z.infer<typeof TaskDeclinePayloadSchema>;

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

/**
 * daemon -> server: task ended in the `Cancelled` state (M1 gap #6) — either
 * in response to a server-sent `task.cancel`, or a cancellation the daemon
 * observed/decided locally (e.g. a local stop action) that the server didn't
 * initiate. This is the canonical way to report a `Cancelled` outcome; it
 * supersedes the M0 convention of `task.fail({ reason: 'cancelled' })`.
 *
 * This is deliberately its own message rather than folded into `task.fail`
 * (decision: prefer the explicit message — see docs/protocol.md) because
 * `Cancelled` is semantically distinct from `Failed`: one is an intentional
 * stop, the other an error. Overloading `task.fail` with a magic
 * `reason: 'cancelled'` string convention hid that distinction on the wire.
 *
 * Dual-purpose on receipt: if the server already moved its own record to
 * `Cancelled` (it initiated the cancel — M1 gap #3's "server state is
 * authoritative" rule), this is an idempotent no-op ack. If the server
 * hasn't yet (a locally-observed cancellation), this is the authoritative
 * trigger that moves `Claimed`/`Running`/`AwaitApproval -> Cancelled`.
 */
export const TaskCancelledPayloadSchema = z.object({
  reason: z.string().optional(),
});
export type TaskCancelledPayload = z.infer<typeof TaskCancelledPayloadSchema>;

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
  'task.started': TaskStartedPayloadSchema,
  'task.decline': TaskDeclinePayloadSchema,
  'task.progress': TaskProgressPayloadSchema,
  'task.artifact': TaskArtifactPayloadSchema,
  'task.await_approval': TaskAwaitApprovalPayloadSchema,
  'task.complete': TaskCompletePayloadSchema,
  'task.fail': TaskFailPayloadSchema,
  'task.cancelled': TaskCancelledPayloadSchema,
} as const;

export type MessageType = keyof typeof MESSAGE_PAYLOAD_SCHEMAS;

export const MESSAGE_TYPES = Object.keys(MESSAGE_PAYLOAD_SCHEMAS) as MessageType[];

/**
 * Message types the server sends to the daemon. Used by {@link EnvelopeSchema}
 * (`envelope.ts`) to decide which branches require envelope `seq` (M1
 * redelivery cursor).
 */
export const SERVER_TO_DAEMON_TYPES = [
  'conn.ack',
  'task.offer',
  'task.approve',
  'task.reject',
  'task.cancel',
  'task.steer',
] as const satisfies readonly MessageType[];
