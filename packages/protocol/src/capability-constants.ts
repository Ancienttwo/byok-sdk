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

/** Capability required before an offer may select terminal projection behavior. */
export const TERMINAL_PROJECTION_SELECTION_CAPABILITY = 'terminal-projection-selection' as const;

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

/** Exact capability of the single input-preparation wire authority. */
export const AGENT_INPUT_PREPARATION_CAPABILITY =
  `agent-input-preparation-v${INPUT_PREPARATION_WIRE_VERSION}` as const;

/**
 * Sealed payload v1 (#654). A device advertises it before a Host may send it
 * a sealed offer or steer; a server advertises it before a device may send it
 * sealed task output or a sealed decline code. Both gates read
 * `WIRE_ADDITIONS`.
 */
export const SEALED_PAYLOAD_CAPABILITY = 'sealed-payload-v1' as const;

/**
 * A server advertises it before a device may send a sealed task output that
 * names its ciphertext blob (`sealed.ciphertextRef`) instead of carrying it
 * inline. The server then holds the blob for the life of the task.
 */
export const SEALED_OUTPUT_CIPHERTEXT_REF_CAPABILITY = 'sealed-output-ciphertext-ref' as const;

/**
 * A server advertises it before a device may send `task.fail.failure`, the
 * machine-readable runtime failure class (#869).
 */
export const RUNTIME_FAILURE_CLASS_CAPABILITY = 'runtime-failure-class' as const;

/**
 * The connection understands the typed pre-claim runtime-unavailable cause
 * (#1103 D8): `task.decline.runtimeUnavailable`, `conn.hello.runtimeUnavailable`
 * and the presence projection. A daemon declares it when it emits the cause.
 * Older peers ignore the unknown flag; absence means the peer may not read
 * the cause, so a Host falls back to `retryable` and treats the cause as
 * unknown. It never infers availability or allow from absence.
 */
export const RUNTIME_UNAVAILABLE_CAUSE_CAPABILITY = 'runtime-unavailable-cause' as const;
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

/** Single value authority shared by schema validation and schema-free consumers. */
export const PREPARED_AGENT_MEMORY_MODES = ['none', 'read', 'read-write'] as const;

export function isPreparedAgentMemoryMode(value: unknown): value is (typeof PREPARED_AGENT_MEMORY_MODES)[number] {
  return typeof value === 'string' && PREPARED_AGENT_MEMORY_MODES.some(mode => mode === value);
}
