/**
 * The ONE version of the input-preparation contract, shared by this relay wire
 * (the `agent.input.preparation` payload and the completion receipt summary)
 * and by the device-local request, receipt and artifact
 * (`@byok-sdk/client`'s `INPUT_PREPARATION_VERSION`, which is this value).
 *
 * The relay wire carries no version field of its own, so a version change is
 * made visible where admission actually happens: in the capability token
 * below. See `INPUT_PREPARATION_VERSION` in the client for what each version
 * changed.
 */
export const INPUT_PREPARATION_WIRE_VERSION = 9 as const;


/** Additive daemon capability names. Server/cloud admission consumes these exactly. */
export const AGENT_EGRESS_POLICY_CAPABILITY = 'agent-egress-policy' as const;

export const AGENT_EGRESS_RELIABLE_ACK_CAPABILITY = 'agent-egress-reliable-ack' as const;

/** Admits the distinct offer whose runtime mints its session only after start. */
export const AGENT_EGRESS_FRESH_SESSION_CAPABILITY = 'agent-egress-fresh-session' as const;

/** Admits the distinct Agent-authored message lane; activity policy remains independent. */
export const AGENT_MESSAGE_EGRESS_CAPABILITY = 'agent-message-egress' as const;

export const AGENT_CONTENT_WORKSPACE_READ_CAPABILITY = 'agent-content-workspace-read' as const;

export const AGENT_CONTENT_TRANSCRIPT_READ_CAPABILITY = 'agent-content-transcript-read' as const;

export const AGENT_CONTENT_ARTIFACT_READ_CAPABILITY = 'agent-content-artifact-read' as const;

/** Capability required before a task-free Agent-home projection is admitted. */
export const AGENT_HOME_PROJECTION_CAPABILITY = 'agent-home-projection' as const;

/** Device capability required before an Agent-home projection may carry `hostRevision`. */
export const AGENT_HOME_PROJECTION_HOST_REVISION_CAPABILITY = 'agent-home-projection-host-revision' as const;

/** Contract §8.1's capability gate for `byok-task-assertion-v1` tool authority. */
export const HOST_MCP_TASK_CONTEXT_CAPABILITY = 'host-mcp-task-context' as const;

/** Daemon capability required before an exact local provider profile may be offered. */
export const PROVIDER_PROFILE_BINDING_CAPABILITY = 'provider-profile-binding' as const;

/** Device capability required before a Host may enqueue `provider.provisioning.available`. */
export const PROVIDER_PROVISIONING_CAPABILITY = 'provider-provisioning.v1' as const;

/** Device capability required before a Host may enqueue `agent.memory.intent.available`. */
export const AGENT_MEMORY_INTENT_CAPABILITY = 'agent-memory-intent.v1' as const;

/** Capability required before the optional hosted Agent-memory projection can be used. */
export const AGENT_MEMORY_PROJECTION_CAPABILITY = 'agent.memory.projection' as const;

/** Device capability required before an ordinary Agent offer may carry `agentMemory`. */
export const AGENT_MEMORY_SELECTION_CAPABILITY = 'agent-memory-selection' as const;

/** Device capability required before an ordinary Agent offer may carry `agentMemory: 'read-if-admitted'`. */
export const AGENT_MEMORY_READ_IF_ADMITTED_CAPABILITY = 'agent-memory-read-if-admitted' as const;

/** Device capability required before an ordinary Agent offer may carry `agentMemory: 'read-write-if-admitted'`. */
export const AGENT_MEMORY_READ_WRITE_IF_ADMITTED_CAPABILITY = 'agent-memory-read-write-if-admitted' as const;

/**
 * Device capability required before an Agent offer may carry `agentMemoryCommit`.
 * A device declares it only with a proven strict memory backend (#1440).
 */
export const AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY = 'agent-memory-commit-on-success' as const;

/** Exact capability of the single input-preparation wire authority. */
export const AGENT_INPUT_PREPARATION_CAPABILITY =
  `agent-input-preparation-v${INPUT_PREPARATION_WIRE_VERSION}` as const;

/**
 * Sealed payload v1 (#654). A device advertises it before a Host may send it
 * a sealed offer or steer (`WIRE_ADDITIONS`). The server accepts sealed task
 * output and the sealed decline codes by the task's frozen `sealing`.
 */
export const SEALED_PAYLOAD_CAPABILITY = 'sealed-payload-v1' as const;

/**
 * Sealed payload v2 (#1045): the `agent-message` and `memory-projection`
 * categories. A device advertises it before a Host may send it an offer whose
 * `sealing` names either category, or a sealed message disposition.
 */
export const SEALED_PAYLOAD_V2_CAPABILITY = 'sealed-payload-v2' as const;

/**
 * The closed classes of `task.fail.failure.class`: the vendored OAR
 * `FailureClass` values. `unknown` means the runtime gave no structured
 * evidence. Single value authority shared by schema validation and
 * schema-free consumers.
 */
export const RUNTIME_FAILURE_CLASSES = [
  'auth', 'quota', 'rate_limited', 'billing', 'model_unavailable', 'input_too_large', 'invalid_request',
  'overloaded', 'provider', 'runtime_exited', 'limit_reached', 'output_schema', 'unknown',
] as const;

/**
 * The `task.fail.failure.class` values a device sends when an Agent home's
 * memory refuses a claimed task before its runtime starts (#1843). They name a
 * state of the home that holds until a write task or the owner changes it:
 * the resident `MEMORY.md` (over its byte limit, more than one hard link, not
 * a regular file, not UTF-8) or the start copy of a commit-on-success task
 * (over the snapshot file or byte limit, or any other non-retryable refusal).
 * A missing file, a changed home identity and an I/O failure stay `unknown`.
 * Adapters never emit them, so they are not {@link RUNTIME_FAILURE_CLASSES}.
 */
export const AGENT_MEMORY_START_REFUSALS = [
  'agent_memory_resident_over_limit', 'agent_memory_resident_multiple_links',
  'agent_memory_resident_not_regular_file', 'agent_memory_resident_not_utf8',
  'agent_memory_snapshot_over_file_limit', 'agent_memory_snapshot_over_byte_limit',
  'agent_memory_snapshot_refused',
] as const;
export type AgentMemoryStartRefusal = (typeof AGENT_MEMORY_START_REFUSALS)[number];

/** The values of a `quota` failure's `scope` (#1271), shared by schema and schema-free consumers. */
export const RUNTIME_QUOTA_SCOPES = ['account', 'model'] as const;

/** Single value authority shared by schema validation and schema-free consumers. */
export const PREPARED_AGENT_MEMORY_MODES = ['none', 'read', 'read-write'] as const;

export function isPreparedAgentMemoryMode(value: unknown): value is (typeof PREPARED_AGENT_MEMORY_MODES)[number] {
  return typeof value === 'string' && PREPARED_AGENT_MEMORY_MODES.some(mode => mode === value);
}

/**
 * A device can run the native-session lane: a Host sends an offer with
 * `nativeSessions` only to a device that advertises it.
 */
export const NATIVE_SESSIONS_CAPABILITY = 'native-sessions' as const;
