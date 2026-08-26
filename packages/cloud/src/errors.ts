/**
 * The one error taxonomy for `@byok-sdk/cloud`.
 *
 * Same idiom as `@byok-sdk/core`'s `errors.ts`: one class, code-based branching,
 * so a composition maps failures onto HTTP with a code table instead of an
 * `instanceof` chain. Cloud does not re-export core's codes — a cloud error is
 * about the hosted surface (a store contract the composition broke, a
 * declaration the host mis-configured), and core errors travel up unchanged.
 */

export const CLOUD_ERROR_CODES = {
  /** A pairing code that is unknown, expired, or already redeemed (§6.1). */
  pairing_code_invalid: 'pairing_code_invalid',
  /** The composition handed a device row whose tenant is not a mintable `TenantId`. */
  device_tenant_invalid: 'device_tenant_invalid',
  /**
   * The mailbox committed a row `seq` that disagrees with the delivery `seq`
   * its body factory baked into the envelope. Loud rather than silent: those
   * two numbers ARE the daemon's redelivery cursor.
   */
  mailbox_seq_mismatch: 'mailbox_seq_mismatch',
  /** A capability declaration the host supplied that core refused. */
  capability_declaration_invalid: 'capability_declaration_invalid',
  /**
   * The declaration names a capability this composition cannot serve, so the
   * deployment would publish a surface it does not have (ADR-010).
   *
   * Construction-time and fatal. A client learns what a deployment supports by
   * READING the declaration and is entitled to act on it without probing, so a
   * declaration that over-states is not a degraded deployment — it is a
   * deployment whose one honest interface lies.
   */
  capability_over_declared: 'capability_over_declared',
  /** Host-supplied board labels or coordination input exceeded the explicit contract. */
  coordination_input_invalid: 'coordination_input_invalid',
  /**
   * A terminal receipt whose stored body is not a terminal envelope — either
   * undecodable or a non-terminal type. Whatever wrote that row broke the
   * receipt-store contract, so the typed read model fails closed instead of
   * projecting a best-effort shape.
   */
  terminal_receipt_unreadable: 'terminal_receipt_unreadable',
  /** A progress/activity batch exceeded the configured event or byte ceiling. */
  activity_batch_too_large: 'activity_batch_too_large',
  /** Host control-plane task lookup is tenant-closed and found no task. */
  task_not_found: 'task_not_found',
  /** Durable target-device capability is absent, revoked, or unavailable. */
  agent_capability_missing: 'agent_capability_missing',
  /** Inbound Agent identity did not exactly match the offered identity. */
  agent_ref_mismatch: 'agent_ref_mismatch',
  /** A strict Agent task id already names a durable attempt and cannot be re-enqueued. */
  agent_task_already_exists: 'agent_task_already_exists',
  /** A first-write-wins Agent control record was replayed with a different body. */
  agent_content_request_mismatch: 'agent_content_request_mismatch',
  /** A durable mailbox receipt id resolved to an envelope other than its exact acknowledgement. */
  mailbox_receipt_mismatch: 'mailbox_receipt_mismatch',
  /** A task-free Agent-home request id already names a different immutable desired projection. */
  agent_home_projection_request_conflict: 'agent_home_projection_request_conflict',
  /** A direct Agent-home completion did not identify a stored desired request for this exact device. */
  agent_home_projection_request_not_found: 'agent_home_projection_request_not_found',
  /** A direct Agent-home completion changed the first durable terminal outcome. */
  agent_home_projection_completion_conflict: 'agent_home_projection_completion_conflict',
  /** A task-free completion did not exactly echo its immutable desired projection binding. */
  agent_home_projection_receipt_mismatch: 'agent_home_projection_receipt_mismatch',
  /** A receipt-store row at the projection namespace violated the frozen projection schema. */
  agent_home_projection_receipt_invalid: 'agent_home_projection_receipt_invalid',
  /** A hosted Agent-memory mutation did not match the durable task/device/AgentRef binding. */
  agent_memory_projection_task_mismatch: 'agent_memory_projection_task_mismatch',
  /** The embedder-owned grant/consent authority denied a hosted memory mutation. */
  agent_memory_projection_authorization_denied: 'agent_memory_projection_authorization_denied',
  /** A redacted snapshot's decoded bytes did not match its declared hash or byte count. */
  agent_memory_projection_hash_mismatch: 'agent_memory_projection_hash_mismatch',
  /** A writer epoch/source sequence already names a different immutable projection mutation. */
  agent_memory_projection_replay_mismatch: 'agent_memory_projection_replay_mismatch',
  /** A hosted memory mutation came from an older writer epoch. */
  agent_memory_projection_stale_epoch: 'agent_memory_projection_stale_epoch',
  /** A server-side erase fence prevents a deleted writer epoch from re-entering. */
  agent_memory_projection_erased_epoch: 'agent_memory_projection_erased_epoch',
  /** A prior erase reached the protocol writer-epoch ceiling and cannot mint a later writer. */
  agent_memory_projection_epoch_exhausted: 'agent_memory_projection_epoch_exhausted',
  /** A hosted memory mutation skipped or reset a required source sequence. */
  agent_memory_projection_sequence_gap: 'agent_memory_projection_sequence_gap',
} as const;

export type CloudErrorCode = (typeof CLOUD_ERROR_CODES)[keyof typeof CLOUD_ERROR_CODES];

export class ByokCloudError extends Error {
  public readonly code: CloudErrorCode;

  constructor(code: CloudErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ByokCloudError';
    this.code = code;
  }
}

export function isCloudError(value: unknown, code?: CloudErrorCode): value is ByokCloudError {
  if (!(value instanceof ByokCloudError)) return false;
  return code === undefined || value.code === code;
}
