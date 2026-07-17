import { z } from 'zod';
import { BlobRefSchema } from './blob';
import { PermissionPolicySchema } from './permission';
import { AgentEventOrUnknownSchema } from './agent-event';

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
 * Per-runtime feature flags reported in `conn.hello.runtimes[].capabilities`
 * (pre-freeze addition). Distinct from the connection-level `CAPABILITY_FLAGS`
 * (`version.ts`) / `conn.hello.capabilities` array: those are protocol-level
 * flags negotiated for the whole connection, while this is what one specific
 * detected runtime (pi/claude/codex) supports. The whole field is optional
 * end-to-end — older daemons omit `capabilities` entirely — and every field
 * inside it is itself optional, since detection can be partial.
 *
 * Per-tool allow/deny lists are deliberately NOT included here (noise).
 * `permissionModes` mirrors `PERMISSION_MODES` (`permission.ts`) but is kept
 * as a bare `string[]` rather than `z.enum(PERMISSION_MODES)`: this is a
 * runtime's self-reported observability data, not a control/security field,
 * so — per the freeze rule (tolerate unknown for observability, fail closed
 * for control/security; see `agent-event.ts`'s unknown-variant tolerance for
 * the same asymmetry applied to `task.progress` events) — it stays tolerant
 * of a mode string a newer runtime might report that this schema doesn't
 * enumerate yet, rather than rejecting the whole `conn.hello`.
 *
 * Unrecognized keys inside `capabilities` itself, by contrast, are silently
 * stripped (zod's default object behavior — same as every other payload
 * schema in this file) rather than passed through: this is a closed, typed
 * shape consumers can rely on, and a genuinely new capability flag gets added
 * here explicitly rather than round-tripped opaquely.
 */
export const RuntimeCapabilitiesSchema = z.object({
  steer: z.boolean().optional(),
  resume: z.boolean().optional(),
  approvalInteractive: z.boolean().optional(),
  permissionModes: z.array(z.string()).optional(),
});
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;

/**
 * Runtime detection info reported in `conn.hello`. Supersedes the M0
 * `agents: unknown` field (M1 gap #4): typed, so the server no longer has to
 * best-effort-normalize an untyped blob.
 */
export const RuntimeInfoSchema = z.object({
  id: RuntimeIdSchema,
  version: z.string().optional(),
  authPresent: z.boolean().optional(),
  /** Optional: older daemons omit this entirely (pre-freeze addition). */
  capabilities: RuntimeCapabilitiesSchema.optional(),
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
 * The out-of-band-reference form of `TaskOfferPayload.instruction` (the
 * alternative to an inlined string). `.strict()`: like `PermissionPolicySchema`
 * (`permission.ts`), this is control data — it's the task instruction itself,
 * the thing that authorizes what work gets done — so per the freeze rule's
 * observability-vs-control asymmetry (docs/protocol.md "Freeze rule") an
 * unrecognized field here must be REJECTED, not silently stripped the way an
 * ordinary payload's unknown field is. Without `.strict()`, a hypothetical
 * future field riding along next to `blobRef` (e.g. a routing/priority
 * override) would be silently discarded instead of failing the parse —
 * exactly the kind of silent reinterpretation the freeze rule forbids for
 * control/security payloads. Consequence: adding a field to this shape
 * post-freeze is a BREAKING change (version bump required), not the usual
 * non-breaking additive-optional-field case — same as `PermissionPolicySchema`.
 */
const InstructionBlobRefSchema = z.object({ blobRef: BlobRefSchema }).strict();

/**
 * server -> daemon: offer a task for a device to claim.
 *
 * `taskId` used to be duplicated here; it is now carried only by the
 * envelope's `task_id` (M1 gap #7 — single source of truth for routing).
 */
export const TaskOfferPayloadSchema = z.object({
  instruction: z.union([z.string(), InstructionBlobRefSchema]),
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

/**
 * daemon -> server: batch of normalized agent events.
 *
 * `events` elements are known-or-unknown (`AgentEventOrUnknownSchema` —
 * `agent-event.ts`), not bare `AgentEventSchema`: pre-freeze, an unrecognized
 * event `type` must not fail the whole batch, since a peer running a newer
 * minor version may have emitted an additive event variant this schema
 * doesn't know about yet. See `agent-event.ts` for the full rationale and
 * `partitionAgentEvents`/`isKnownAgentEvent` for how consumers should skip
 * unknowns instead of choking on them.
 */
export const TaskProgressPayloadSchema = z.object({
  seq: z.number().int(),
  events: z.array(AgentEventOrUnknownSchema),
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

/**
 * Message types the daemon sends to the server — the flip side of
 * {@link SERVER_TO_DAEMON_TYPES}. `conn.hello` is deliberately excluded: it's
 * only ever valid as the first frame of a WS handshake (`ws-server.ts`), not
 * as ongoing inbound traffic through `ConnectionHub.handleInbound`.
 *
 * Used by `handleInbound` (`@byok/server`'s `hub.ts`) as the type-allow gate
 * for every inbound envelope, WS and `POST /byok/messages` alike (finding
 * P2): a `type` outside this set — a server -> daemon type arriving inbound,
 * or anything unrecognized — is rejected before it's dispatched to any
 * handler or counted `accepted` on the `/byok/messages` wire.
 */
export const DAEMON_TO_SERVER_TYPES = [
  'task.claim',
  'task.started',
  'task.decline',
  'task.progress',
  'task.artifact',
  'task.await_approval',
  'task.complete',
  'task.fail',
  'task.cancelled',
] as const satisfies readonly MessageType[];
