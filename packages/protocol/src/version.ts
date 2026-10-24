/** Bounded volatile navigation; only cursor is a durable acknowledgement. */
export const MAILBOX_READ_AHEAD_MAX_SEQS = 4096;
export const MAILBOX_READ_AHEAD_CAPABILITY = 'mailbox-read-ahead';

/**
 * Wire protocol version. Every v3 change is a version bump, a gated addition
 * or a strip-safe addition: see docs/protocol.md "Freeze rule", which is the
 * one statement of the rule, and `src/wire-additions.ts`, which declares the
 * receiver-capability gates and additions. No v3 release has been published
 * yet, so `src/__tests__/compat.test.ts` has no published v3 decoder to prove
 * additions against; cross-release gates stay unproven until one exists.
 *
 * v3 makes `schema` required on the `terminalProjection.mode:
 * 'result-document'` arm (`terminal-projection.ts`, `result-schema.ts`): the
 * offer freezes the outcome schema, and the outcome reaches the Host only as
 * `task.complete.document`. That narrows a strict shape, so it is a wire
 * major. A v2 envelope is rejected; there is no v2 reader and no capability
 * negotiation between the two result-document shapes. Drain, then upgrade
 * server and client together. Every addition v2 declared is part of the v3
 * baseline, and the v2 `result-document` capability flag is gone: every v3
 * server keeps `task.complete.document`.
 *
 * v2 removed the task offer's `policy` (`PermissionPolicy`), the runtime
 * capability `permissionModes` and the input-preparation `permissionMode`.
 * Sessions run without an SDK permission gate; each local agent keeps its
 * own guardrails. A v1 envelope is rejected; there is no v1 reader.
 * v2 also removed the egress policy's `metadata-status` activity mode, its
 * `activity.mode` field and the `sanitizer_rejected` drop reason. Agent
 * egress goes to the Host as the runtime produced it.
 * v2 also removed the input-preparation artifact's `toolImplementationKinds`
 * and the readiness reason `executor_identity_unproven`. The SDK does not
 * attest tool executables. The artifact names its counted tools in
 * `toolNames`.
 */
export const PROTOCOL_VERSION = 3;

/** Host declares that this device accepts only Agent-bound offer variants. */
export const STRICT_AGENT_ONLY_CAPABILITY = 'strict-agent-only' as const;

/**
 * The device runs `homeAccess: 'memory-reader'` Agent offers: each reader
 * Attempt gets its own run directory under the Agent home, and readers are
 * counted apart from the one writer. The Agent offers are strict, so a host
 * must refuse a reader offer to a device without this flag before it creates
 * the task.
 */
export const AGENT_HOME_READERS_CAPABILITY = 'agent-home-readers' as const;

/**
 * Capability flags exchanged during the connection handshake (`conn.hello` /
 * `conn.ack`). Additional flags may be introduced without a protocol version
 * bump; unrecognized flags must be ignored by both sides.
 *
 * `interactive-approval` is RESERVED as of this addition: it gates the
 * (currently unexercised) approval seam — a server must not route an
 * approval-requiring policy to a daemon that hasn't advertised this flag. No
 * bundled runtime adapter emits it yet; that's expected until interactive
 * approval is actually wired up in a later wave.
 *
 * `approval_resolved` (additive-minor): a SERVER-advertised flag meaning
 * "I understand the `task.approval_resolved` message" (`messages.ts`). This
 * is the N/N-1 answer for that new daemon -> server message: an old server's
 * `CAPABILITY_FLAGS`/`conn.ack.capabilities` never includes it, so a new
 * daemon talking to an old server never sends `task.approval_resolved` at
 * all (see `packages/client`'s `task-runner.ts`) and falls back to the
 * pre-existing implicit-resume inference
 * (`ConnectionHub.resumeIfImplicitlyApproved`, `packages/server/src/hub.ts`)
 * unconditionally, exactly as before this flag existed. Unlike
 * `interactive-approval`, this one IS exercised the moment both sides
 * support it — there is no reserved/dormant period for it.
 */
/**
 * `approval-targeting` (M5, additive-minor): unlike `approval_resolved`
 * above, this flag is purely INFORMATIONAL/semantic, not a functional gate.
 * `task.await_approval`/`task.approve`/`task.reject` all carry their new
 * `approvalId` field UNCONDITIONALLY on both sides once each peer is
 * upgraded -- the wire is tolerant (a plain, non-`.strict()` `z.object()`
 * field, `messages.ts`), so no version/capability negotiation is needed just
 * to send it safely; an older peer that doesn't recognize the field simply
 * never reads it. Receivers decide whether to apply exact-match targeting
 * by FIELD PRESENCE on the specific message at hand (does this particular
 * `task.approve`/`task.reject`/`onApprovalResolved` payload carry an
 * `approvalId`, and does a stored one exist to compare it against?), never
 * by checking this flag -- see `ConnectionHub.approveTask`/`rejectTask`/
 * `onApprovalResolved` and `TaskRunner.handleApprove`/`handleReject`
 * (`packages/client`'s `task-runner.ts`). This flag exists only so each side
 * can advertise, and an embedder/operator can observe (`ConnectionHub.
 * getDeviceCapabilities`), whether the OTHER side is new enough to
 * participate in targeting at all -- the same N/N-1-safe shape as every
 * other flag here, just consumed for observability instead of gating.
 */
/**
 * `dispatch-selection` (additive-minor) is a correctness gate for the
 * optional `task.offer.dispatchSelection` control field. An older v1 daemon
 * legally strips unknown optional fields, so a server must never send an
 * authoritative provider/model selection unless the target connection
 * advertises this flag. Absence means reject before task creation, not send
 * a legacy runtime-only offer that could reach a different provider.
 *
 * `toolset-selection` (additive-minor) means the daemon understands
 * `task.offer_with_toolsets` and can resolve its logical ids against local
 * MCP configuration. The distinct message type is also the N/N-1 safety
 * boundary for long-poll: an older daemon skips it as unknown and therefore
 * cannot accidentally execute the instruction without the required tools.
 */
export const CUSTOM_HARNESS_CAPABILITY = 'custom-harness' as const;

export const CAPABILITY_FLAGS = [
  'steer',
  'blob-upload',
  'interactive-approval',
  'approval_resolved',
  'approval-targeting',
  'dispatch-selection',
  PROVIDER_PROFILE_BINDING_CAPABILITY,
  'toolset-selection',
  'agent-home-contract',
  AGENT_HOME_READERS_CAPABILITY,
  STRICT_AGENT_ONLY_CAPABILITY,
  AGENT_EGRESS_POLICY_CAPABILITY,
  AGENT_EGRESS_RELIABLE_ACK_CAPABILITY,
  AGENT_MESSAGE_EGRESS_CAPABILITY,
  AGENT_EGRESS_FRESH_SESSION_CAPABILITY,
  AGENT_CONTENT_WORKSPACE_READ_CAPABILITY,
  AGENT_CONTENT_TRANSCRIPT_READ_CAPABILITY,
  AGENT_CONTENT_ARTIFACT_READ_CAPABILITY,
  AGENT_HOME_PROJECTION_CAPABILITY,
  AGENT_INPUT_PREPARATION_CAPABILITY,
  TERMINAL_PROJECTION_SELECTION_CAPABILITY,
  HOST_MCP_TASK_CONTEXT_CAPABILITY,
  CUSTOM_HARNESS_CAPABILITY,
  MAILBOX_READ_AHEAD_CAPABILITY,
  PROVIDER_PROVISIONING_CAPABILITY,
  AGENT_MEMORY_INTENT_CAPABILITY,
  AGENT_MEMORY_SELECTION_CAPABILITY,
  AGENT_MEMORY_READ_IF_ADMITTED_CAPABILITY,
  AGENT_MEMORY_READ_WRITE_IF_ADMITTED_CAPABILITY,
  'agent-message-draft',
  SEALED_PAYLOAD_CAPABILITY,
  SEALED_OUTPUT_CIPHERTEXT_REF_CAPABILITY,
  RUNTIME_FAILURE_CLASS_CAPABILITY,
] as const;

export type CapabilityFlag = (typeof CAPABILITY_FLAGS)[number];
import {
  AGENT_EGRESS_POLICY_CAPABILITY,
  AGENT_EGRESS_RELIABLE_ACK_CAPABILITY,
  AGENT_EGRESS_FRESH_SESSION_CAPABILITY,
  AGENT_MESSAGE_EGRESS_CAPABILITY,
  AGENT_CONTENT_WORKSPACE_READ_CAPABILITY,
  AGENT_CONTENT_TRANSCRIPT_READ_CAPABILITY,
  AGENT_CONTENT_ARTIFACT_READ_CAPABILITY,
  AGENT_HOME_PROJECTION_CAPABILITY,
  TERMINAL_PROJECTION_SELECTION_CAPABILITY,
  HOST_MCP_TASK_CONTEXT_CAPABILITY,
  PROVIDER_PROFILE_BINDING_CAPABILITY,
  PROVIDER_PROVISIONING_CAPABILITY,
  AGENT_MEMORY_INTENT_CAPABILITY,
  AGENT_MEMORY_SELECTION_CAPABILITY,
  AGENT_MEMORY_READ_IF_ADMITTED_CAPABILITY,
  AGENT_MEMORY_READ_WRITE_IF_ADMITTED_CAPABILITY,
  AGENT_INPUT_PREPARATION_CAPABILITY,
  SEALED_PAYLOAD_CAPABILITY,
  SEALED_OUTPUT_CIPHERTEXT_REF_CAPABILITY,
  RUNTIME_FAILURE_CLASS_CAPABILITY,
} from './capability-constants';
