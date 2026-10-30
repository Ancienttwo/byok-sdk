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
  activity_history_gap: 'activity_history_gap',
  activity_cursor_invalid: 'activity_cursor_invalid',
  activity_task_settled: 'activity_task_settled',
  activity_store_unavailable: 'activity_store_unavailable',
  maintenance_invalid_input: 'maintenance_invalid_input',
  maintenance_result_invalid: 'maintenance_result_invalid',
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
  /**
   * The composition was given a port whose capability the declaration does not
   * name (#1096). Construction-time and fatal: the port would never be mounted,
   * so passing it is a wiring mistake, not a rollout switch. Declare the
   * capability or stop passing the port.
   */
  capability_port_undeclared: 'capability_port_undeclared',
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
  /** A Host read named a task whose content `redactTasks` replaced with a tombstone. */
  task_content_redacted: 'task_content_redacted',
  /** `redactTasks` was called on a deployment that has no `taskRedactionStore`. */
  task_redaction_unavailable: 'task_redaction_unavailable',
  /** An E2EE member call on a deployment that has no `e2eeMemberStore`. */
  e2ee_member_store_unavailable: 'e2ee_member_store_unavailable',
  /** A different member chain entry is stored at that seq, or the first new entry does not follow the head. Read the chain again. */
  e2ee_member_chain_conflict: 'e2ee_member_chain_conflict',
  /** The first package of that scope epoch fixed another `keyId`. */
  e2ee_scope_key_conflict: 'e2ee_scope_key_conflict',
  /** The member chain shredded that scope (design §11.2), so the Host stores no more key packages for it. */
  e2ee_scope_shredded: 'e2ee_scope_shredded',
  /** A package is wrapped to an older KEM epoch than its recipient's latest `rotate` on the member chain. Read the chain again and seal again. */
  e2ee_scope_key_package_stale: 'e2ee_scope_key_package_stale',
  /** The device already used this device-proof `requestId` with another request. A proof is single-use. */
  proof_request_conflict: 'proof_request_conflict',
  /** The device has not registered a member key bundle. */
  e2ee_member_not_registered: 'e2ee_member_not_registered',
  /** The device registered another member key bundle, or another device registered this member id. */
  e2ee_member_key_conflict: 'e2ee_member_key_conflict',
  /** A stored E2EE member row is not the value its schema requires. Whatever wrote it broke the store contract. */
  e2ee_member_state_unreadable: 'e2ee_member_state_unreadable',
  /** Explicit legacy dispatch target is unknown or revoked in this tenant. */
  device_not_found: 'device_not_found',
  /**
   * A host `approveTask`/`rejectTask` names a task with no approval to
   * resolve: the durable timeline holds no unresolved `approval_requested`
   * (including a tail that has expired or was never written), the attempt has
   * already reached a terminal status, or no device ever claimed it so there
   * is nothing to notify. Fail-closed by construction — cloud never invents a
   * pending approval to make the call succeed.
   */
  task_not_awaiting_approval: 'task_not_awaiting_approval',
  /** Durable target-device capability is absent, revoked, or unavailable. */
  agent_capability_missing: 'agent_capability_missing',
  /** Inbound Agent identity did not exactly match the offered identity. */
  agent_ref_mismatch: 'agent_ref_mismatch',
  /** A strict Agent task id already names a durable attempt and cannot be re-enqueued. */
  agent_task_already_exists: 'agent_task_already_exists',
  /**
   * A task attempt was opened but the mailbox refused its offer append, so the
   * device never saw it. Raised as {@link TaskOfferAppendRefusedError}, which
   * names the task so the Host can retry with that `taskId` (the retry
   * converges on the one offer) or cancel it; `cause` is the store's refusal,
   * e.g. a core `storage_quota_exceeded`.
   */
  task_offer_append_refused: 'task_offer_append_refused',
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
  /** A remote input-preparation request id already names a different immutable desired request. */
  input_preparation_request_conflict: 'input_preparation_request_conflict',
  /** A device completion did not identify a stored desired request for this exact device. */
  input_preparation_request_not_found: 'input_preparation_request_not_found',
  /** A device completion changed the first durable terminal outcome. */
  input_preparation_completion_conflict: 'input_preparation_completion_conflict',
  /** A completion did not exactly echo its immutable desired request/Agent/policy binding. */
  input_preparation_receipt_mismatch: 'input_preparation_receipt_mismatch',
  /** A receipt-store row at the preparation namespace violated the frozen schema. */
  input_preparation_receipt_invalid: 'input_preparation_receipt_invalid',
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

/**
 * The one cloud error that carries a task identity: a refused offer append
 * after the attempt opened. Without `taskId` a Host that let cloud allocate the
 * id could neither retry nor cancel the attempt it now owns.
 */
export class TaskOfferAppendRefusedError extends ByokCloudError {
  public readonly taskId: string;

  constructor(taskId: string, cause: unknown) {
    super(
      'task_offer_append_refused',
      `Task ${taskId} is open but its offer append was refused (${cause instanceof Error ? cause.message : String(cause)}); retry with this taskId or cancel it.`,
      { cause },
    );
    this.name = 'TaskOfferAppendRefusedError';
    this.taskId = taskId;
  }
}

export function isCloudError(value: unknown, code?: CloudErrorCode): value is ByokCloudError {
  if (!(value instanceof ByokCloudError)) return false;
  return code === undefined || value.code === code;
}
