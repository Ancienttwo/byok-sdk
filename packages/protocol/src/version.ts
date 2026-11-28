/** Bounded volatile navigation; only cursor is a durable acknowledgement. */
export const MAILBOX_READ_AHEAD_MAX_SEQS = 4096;

/**
 * Current wire major. Envelopes of every other major are refused; there is
 * no older-major reader. The HTTP batch frame may carry a positive foreign
 * major only to return `protocol_version_unsupported` for that entry.
 *
 * Every wire change is a major bump, a receiver-gated addition or a strip-safe
 * addition, under docs/protocol.md "Freeze rule". `wire-additions.ts` owns
 * receiver gates; the compatibility suite owns published-decoder evidence.
 */
export const PROTOCOL_VERSION = 8;

/**
 * The device runs `homeAccess: 'memory-reader'` Agent offers: each reader
 * Attempt gets its own run directory under the Agent home, and readers are
 * counted apart from the one writer. The Agent offers are strict, so a host
 * must refuse a reader offer to a device without this flag before it creates
 * the task.
 */
export const AGENT_HOME_READERS_CAPABILITY = 'agent-home-readers' as const;

/**
 * Device capability flags. The daemon sends its flags in `conn.hello`; the
 * server advertises none (wire v7). A server gates a server-to-daemon surface
 * on them (`wire-additions.ts`). Additional flags may be introduced without a
 * protocol version bump; unrecognized flags must be ignored.
 *
 * `toolset-selection` (additive-minor) means the daemon understands an
 * offer's `requiredToolsets` and can resolve its logical ids against local
 * MCP configuration. `skill-selection` (additive-minor) means the daemon
 * understands an offer's `requiredSkills` and can resolve and project its
 * logical ids from the local skill registry.
 */
export const CAPABILITY_FLAGS = [
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
  AGENT_HOME_PROJECTION_HOST_REVISION_CAPABILITY,
  AGENT_INPUT_PREPARATION_CAPABILITY,
  HOST_MCP_TASK_CONTEXT_CAPABILITY,
  PROVIDER_PROVISIONING_CAPABILITY,
  AGENT_MEMORY_INTENT_CAPABILITY,
  AGENT_MEMORY_SELECTION_CAPABILITY,
  AGENT_MEMORY_READ_IF_ADMITTED_CAPABILITY,
  AGENT_MEMORY_READ_WRITE_IF_ADMITTED_CAPABILITY,
  AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY,
  NATIVE_SESSIONS_CAPABILITY,
  SEALED_PAYLOAD_CAPABILITY,
  SEALED_PAYLOAD_V2_CAPABILITY,
  INPUT_IMAGES_CAPABILITY,
  HARNESS_SERVICE_TIER_CAPABILITY,
  SKILL_SELECTION_CAPABILITY,
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
  AGENT_HOME_PROJECTION_HOST_REVISION_CAPABILITY,
  HOST_MCP_TASK_CONTEXT_CAPABILITY,
  PROVIDER_PROVISIONING_CAPABILITY,
  AGENT_MEMORY_INTENT_CAPABILITY,
  AGENT_MEMORY_SELECTION_CAPABILITY,
  AGENT_MEMORY_READ_IF_ADMITTED_CAPABILITY,
  AGENT_MEMORY_READ_WRITE_IF_ADMITTED_CAPABILITY,
  AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY,
  NATIVE_SESSIONS_CAPABILITY,
  HARNESS_SERVICE_TIER_CAPABILITY,
  AGENT_INPUT_PREPARATION_CAPABILITY,
  INPUT_IMAGES_CAPABILITY,
  SKILL_SELECTION_CAPABILITY,
  SEALED_PAYLOAD_CAPABILITY,
  SEALED_PAYLOAD_V2_CAPABILITY,
} from './capability-constants.js';
