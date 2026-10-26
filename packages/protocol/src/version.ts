/** Bounded volatile navigation; only cursor is a durable acknowledgement. */
export const MAILBOX_READ_AHEAD_MAX_SEQS = 4096;
export const MAILBOX_READ_AHEAD_CAPABILITY = 'mailbox-read-ahead';

/**
 * Wire protocol version. Every v4 change is a version bump, a gated addition
 * or a strip-safe addition: see docs/protocol.md "Freeze rule", which is the
 * one statement of the rule, and `src/wire-additions.ts`, which declares the
 * receiver-capability gates and additions. No v4 release has been published
 * yet, so `src/__tests__/compat.test.ts` has no published v4 decoder to prove
 * additions against; cross-release gates stay unproven until one exists.
 *
 * v4 completes the ADR-034 cutover and retires the approval paths kept for
 * pre-M5 peers. It removes the v3 handshake answer, the runtime-only offers
 * (with and without toolsets) with their sealed twins, and the
 * `strict-agent-only` flag: every offer is Agent-bound. `approvalId` is
 * required on `task.await_approval`, `task.approve` and `task.reject`, so a
 * decision resolves only the approval it names. `task.approval_resolved` is
 * baseline: the daemon reports every locally resolved approval, and the
 * server no longer infers one from later task activity. The three approval
 * capability flags of v3 are gone. A v3 envelope is rejected; there is no v3 reader. Drain, then
 * upgrade server and client together.
 *
 * v3 made `schema` required on the `terminalProjection.mode:
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
export const PROTOCOL_VERSION = 4;

/**
 * The device runs `homeAccess: 'memory-reader'` Agent offers: each reader
 * Attempt gets its own run directory under the Agent home, and readers are
 * counted apart from the one writer. The Agent offers are strict, so a host
 * must refuse a reader offer to a device without this flag before it creates
 * the task.
 */
export const AGENT_HOME_READERS_CAPABILITY = 'agent-home-readers' as const;

/**
 * Capability flags. The daemon sends its flags in `conn.hello`; the server
 * sends its own on every long-poll response (`EventsPollResponse`). Additional
 * flags may be introduced without a protocol version bump; unrecognized flags
 * must be ignored by both sides.
 *
 * `dispatch-selection` (additive-minor) is a correctness gate for the
 * optional offer `dispatchSelection` control field. An older v1 daemon
 * legally strips unknown optional fields, so a server must never send an
 * authoritative provider/model selection unless the target connection
 * advertises this flag. Absence means reject before task creation, not send
 * an offer that could reach a different provider.
 *
 * `toolset-selection` (additive-minor) means the daemon understands an
 * offer's `requiredToolsets` and can resolve its logical ids against local
 * MCP configuration.
 */
export const CUSTOM_HARNESS_CAPABILITY = 'custom-harness' as const;

export const CAPABILITY_FLAGS = [
  'steer',
  'blob-upload',
  'dispatch-selection',
  PROVIDER_PROFILE_BINDING_CAPABILITY,
  'toolset-selection',
  'agent-home-contract',
  AGENT_HOME_READERS_CAPABILITY,
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
