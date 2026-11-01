import { readTaskAgentMessageBinding } from './task-agent-message';
import {
  agentMessageWithinLimit, parseAgentMessageDisposition, sameAgentRef,
  type AgentMessageConsumers, type AgentMessageDecision,
} from './agent-message-disposition';
import { taskOfferMessageId, hashOfferBytes } from './offer-identity';
/**
 * The single inbound choke point for every daemon -> cloud envelope.
 *
 * The reference server runs this gate inside a live `ConnectionHub`; here it
 * is a pure function over a tenant-closed facade, so the same order holds with
 * no connection, no session, and no cross-request state:
 *
 * Rate admission is not a gate step. `POST /byok/messages` charges its whole
 * batch, one token per envelope, before the first envelope reaches this gate
 * (`handlers/messages.ts`), so a refused batch applies nothing and a flood of
 * garbage-typed envelopes costs the same budget as well-formed ones.
 *
 * 1. **type-allow** — only `DAEMON_TO_SERVER_TYPES` may pass, plus the
 *    authenticated long-poll `conn.hello` capability snapshot handled below.
 *    A server -> daemon type arriving inbound, or anything unrecognized, is
 *    rejected before it is dispatched or counted accepted.
 * 2. **ownership** — an envelope must name an existing task targeted at this
 *    exact device, and a task already owned by a DIFFERENT device is dropped,
 *    never force-failed: force-failing on an authz mismatch
 *    would let an attacker who merely guesses a `taskId` kill the real owner's
 *    task. Unknown task ids are rejected before any task-scoped projection or
 *    dedup fact can be written.
 * 3. **apply/recover** — every lifecycle side effect is idempotent under the
 *    envelope's own durable identity. A retry after a partial failure resumes
 *    this step rather than being hidden by transport admission.
 * 4. **dedup** — only after every authoritative side effect converged do we
 *    mark the envelope complete. The next retry is then a no-op.
 *
 * A duplicate is still a wire-level success (§8.2): it just did not re-run
 * anything. Only `rejected` is excluded from `accepted`.
 *
 * 5. **observe** — an optional {@link ByokCloudObserver} is told, once, about
 *    each envelope whose write committed (`onInboundCommitted`) and about each
 *    envelope the gate refused, with a closed {@link InboundRefusalReason}
 *    (`onInboundRefused`). It runs after the outcome is fixed, it cannot
 *    change it, and it is not the admission hook.
 */
import {
  AGENT_CONTENT_ARTIFACT_READ_CAPABILITY,
  AGENT_CONTENT_TRANSCRIPT_READ_CAPABILITY,
  AGENT_CONTENT_WORKSPACE_READ_CAPABILITY,
  AGENT_EGRESS_POLICY_CAPABILITY,
  AGENT_EGRESS_RELIABLE_ACK_CAPABILITY,
  AGENT_MESSAGE_EGRESS_CAPABILITY,
  AgentContentReadPayloadSchema,
  AgentMessageDraftPayloadSchema,
  DAEMON_TO_SERVER_TYPES,
  decodeEnvelope,
  encodeEnvelope,
  PROTOCOL_VERSION,
  SEALED_SPLIT_TABLE,
  isSealableMessageType,
  isSealedPayload,
  isSealedTaskPlainOutput,
  type AgentRef,
  type AgentContentReceiptPayload,
  type AgentContentReadPayload,
  type AgentEgressReliablePayload,
  type AgentMessageDispositionPayload,
  type AgentMessagePublishPayload,
  type AgentMessageServerContext,
  type Envelope,
  type MessageType,
  type SealedSplitEntry,
  type TaskSealing,
} from '@byok-sdk/protocol';
import type { TenantId } from '@byok-sdk/core';
import {
  validateActivityBatch,
  appendActivityEvents,
  DEFAULT_ACTIVITY_BOUNDS,
  type ActivityBounds,
} from './coordination';
import {
  validateApprovalTimelineAppend,
  type ApprovalTimelineAppendInput,
} from './approval-timeline';
import { isCloudError } from './errors';
import { projectTerminalToReview } from './board-projection';
import { agentReliabilityKey } from './agent-reliability';
import type { TenantStores } from './tenant-stores';
import type { TaskAttempt } from './stores/ports';
import { isTaskRedactionTombstone, sameTaskBody, taskRedactionReceiptKey } from './task-redaction';
import {
  releaseSealedCiphertext,
  retainSealedCiphertext,
  sealedCiphertextCommitted,
  sealedCiphertextHeld,
  sealedCiphertextRef,
} from './sealed-ciphertext';

export type InboundOutcome = 'accepted' | 'duplicate' | 'rejected';

/**
 * Why the gate answered `rejected`. Closed on purpose: every rejection path in
 * this file goes through {@link refuse}, whose parameter is this union, and the
 * gate's internal result type has no `rejected` member without a reason — so a
 * new rejection path that does not name one fails typecheck rather than
 * disappearing into an uncounted `rejected`.
 *
 * Internal observation vocabulary. `POST /byok/messages` maps these names
 * exhaustively to coarse wire codes; the internal names never reach the wire
 * and may be refined without a protocol revision.
 */
export const INBOUND_REFUSAL_REASONS = [
  // envelope-level
  'protocol_version_unsupported',
  'type_not_allowed',
  'sealed_payload_unsupported',
  'sealed_output_required',
  'sealed_ciphertext_invalid',
  'task_id_missing',
  'device_not_eligible',
  // conn.hello capability snapshot
  'hello_device_mismatch',
  'hello_harnesses_without_capability',
  'hello_protocol_version_unsupported',
  'hello_product_mismatch',
  'hello_capabilities_not_recorded',
  // agent.message.draft
  'agent_message_draft_invalid',
  // agent.message.publish
  'agent_message_attempt_mismatch',
  'agent_message_offer_binding_missing',
  'agent_message_binding_corrupt',
  'agent_message_binding_mismatch',
  'agent_message_too_large',
  'agent_message_already_deduplicated',
  'agent_message_reservation_conflict',
  'agent_message_admission_unconfirmed',
  // agent.egress.reliable / agent.content.receipt
  'egress_conflict',
  'content_receipt_event_request_mismatch',
  'content_receipt_request_unknown',
  'content_receipt_request_mismatch',
  'content_receipt_conflict',
  // task ownership
  'task_not_found_for_device',
  'task_owned_by_other_device',
  'agent_identity_mismatch',
  'terminal_harness_mismatch',
  // task.claim
  'claim_device_mismatch',
  'claim_harness_and_runtime_conflict',
  'claim_harness_mismatch',
  'claim_harness_unavailable',
  'claim_offer_mismatch',
  'claim_not_won',
  'task_settled_by_cloud',
  // task.fail recovery
  'recovery_report_invalid',
  'recovery_offer_mismatch',
  // bounded payloads
  'activity_batch_too_large',
  'activity_batch_invalid',
  'approval_event_invalid',
  // terminal receipt
  'terminal_receipt_not_canonical',
] as const;
export type InboundRefusalReason = (typeof INBOUND_REFUSAL_REASONS)[number];

/** The only way to build a rejection: the reason is required and closed. */
interface Refused {
  readonly outcome: 'rejected';
  readonly reason: InboundRefusalReason;
}

function refuse(reason: InboundRefusalReason): Refused {
  return { outcome: 'rejected', reason };
}

/** The gate's internal result. `rejected` cannot be expressed without a reason. */
export type InboundResult = Refused | { readonly outcome: 'accepted' | 'duplicate' };

/**
 * One envelope whose write COMMITTED, handed to {@link ByokCloudObserver}.
 *
 * `outcome` is constant by construction — `accepted` is the only outcome that
 * committed anything — and is carried anyway because it names the fact in the
 * gate's own vocabulary rather than leaving the reader to infer it from the
 * hook's name. A `duplicate` re-ran nothing and a `rejected` wrote nothing;
 * neither appears here.
 */
export interface InboundCommitted {
  readonly tenantId: TenantId;
  readonly deviceId: string;
  readonly envelope: Envelope;
  readonly outcome: Extract<InboundOutcome, 'accepted'>;
}

/**
 * Post-commit relay for the host (the `TaskHandle` fan-out `@byok-sdk/server`
 * drives off its live hub).
 *
 * Deliberately NOT the admission hook. `ByokCloudOptions.agentMessage.consume`
 * runs BEFORE a write and decides whether it happens; this runs AFTER one and
 * cannot decide anything: it returns `void`, it is called inside a `try`, and
 * a throw from it is swallowed with the outcome already fixed. An observer
 * that wants to refuse work has the admission hook; an observer here is
 * watching, not gating.
 *
 * Synchronous and cheap by contract — it runs inline on the request path.
 */
export interface ByokCloudObserver {
  /** Post-commit wake hint, including exact replays; durable receipts remain authoritative. */
  onAgentHomeProjectionCompleted?(readback: import('@byok-sdk/protocol').AgentHomeProjectionReadback): void;
  onMaintenance?(report: import('./maintenance').MaintenanceReport): void;
  onInboundCommitted(input: InboundCommitted): void;
  /**
   * One envelope the gate refused, with the reason. Same rules as
   * {@link onInboundCommitted}: synchronous, called inside a `try`, a throw is
   * swallowed, and it can never change the response (`rejected` is already
   * counted on the wire). `envelopeId` and `type` come from the device's own
   * envelope, so they are claims, not authority.
   */
  onInboundRefused?(input: InboundRefused): void;
}

/** One refused envelope, handed to {@link ByokCloudObserver.onInboundRefused}. */
export interface InboundRefused {
  readonly tenantId: TenantId;
  readonly deviceId: string;
  readonly envelopeId: string;
  readonly type: MessageType;
  readonly reason: InboundRefusalReason;
}

export async function handleAgentMessagePublish(
  stores: TenantStores,
  deviceId: string,
  taskId: string,
  payload: AgentMessagePublishPayload,
  consumers: AgentMessageConsumers | undefined,
  alreadyDeduplicated: boolean,
): Promise<Refused | { readonly outcome: Exclude<InboundOutcome, 'rejected'>; readonly disposition?: AgentMessageDispositionPayload }> {
  const device = await stores.devices.get(deviceId);
  const attempt = await stores.tasks.get(taskId);
  const binding = await stores.receipts.get(`agent-message-offer:${deviceId}:${taskId}`);
  // #1045: the task's frozen sealing allows one form of its message. A sealed
  // message is refused first, as every sealed report of a task that does not
  // seal its category is.
  const sealing = attempt?.deviceId === deviceId && attempt.agentRef !== undefined
    ? await frozenOfferSealing(stores, deviceId, taskId, attempt.agentRef)
    : undefined;
  const sealsMessages = sealing !== 'redacted' && sealing?.categories.includes('agent-message') === true;
  if (payload.sealed !== undefined && !sealsMessages) return refuse('sealed_payload_unsupported');
  if (
    device === undefined || device.revoked ||
    !hasCapabilities(device.capabilities, [AGENT_MESSAGE_EGRESS_CAPABILITY])
  ) return refuse('device_not_eligible');
  if (attempt === undefined || attempt.deviceId !== deviceId) return refuse('task_not_found_for_device');
  if (binding === undefined) return refuse('agent_message_offer_binding_missing');
  if (isTaskRedactionTombstone(binding.body)) return refuse('agent_message_binding_mismatch');
  if (attempt.agentRef === undefined || !sameAgentRef(attempt.agentRef, payload.agentRef)) {
    return refuse('agent_message_attempt_mismatch');
  }

  let frozen: { agentRef?: AgentRef; sessionRef?: string; requirement?: { contract?: string; contentType?: string; maxBytes?: number }; context?: AgentMessageServerContext };
  try { frozen = JSON.parse(binding.body) as typeof frozen; } catch { return refuse('agent_message_binding_corrupt'); }
  if (
    !sameAgentRef(frozen.agentRef!, payload.agentRef) ||
    frozen.context === undefined ||
    frozen.requirement?.contract !== payload.contract ||
    (frozen.sessionRef !== undefined && frozen.sessionRef !== payload.sessionRef) ||
    frozen.requirement.contentType !== payload.contentType ||
    typeof frozen.requirement.maxBytes !== 'number'
  ) return refuse('agent_message_binding_mismatch');
  if (payload.sealed === undefined && sealsMessages) return refuse('sealed_output_required');
  if (!agentMessageWithinLimit(payload, frozen.requirement.maxBytes)) return refuse('agent_message_too_large');
  // A sealed message above the inline limit names its ciphertext blob; every step so far only read.
  const ciphertextRef = sealedCiphertextRef(payload);
  if (ciphertextRef !== undefined && !(await sealedCiphertextCommitted(stores.objects, ciphertextRef))) {
    return refuse('sealed_ciphertext_invalid');
  }

  // Terminal receipt replay is intentionally before the live-state reservation:
  // an already-consumed side effect remains a replay even when the task has
  // subsequently become complete or cancellation-requested.
  const priorDisposition = await readAgentMessageDisposition(stores, deviceId, taskId, payload);
  if (priorDisposition !== undefined) {
    if (priorDisposition.outcome === 'refused') await stores.agentMessageDraft.delete(taskId);
    return { outcome: 'duplicate', disposition: priorDisposition };
  }

  if (alreadyDeduplicated) return refuse('agent_message_already_deduplicated');

  const payloadBody = JSON.stringify(payload);
  const reservation = await stores.tasks.reserveAgentMessage({
    taskId,
    deviceId,
    messageId: payload.messageId,
    payloadBody,
  });
  // Both a new reservation and an exact pending reservation may call the
  // product consumer. The consumer owns durable product idempotency under the
  // exact authenticated message identity; retrying it is what closes the
  // crash window where that product commit succeeded but our terminal CAS did
  // not. A conflicting or newly lifecycle-ineligible reservation still fails
  // closed in the store.
  if (reservation !== 'reserved' && reservation !== 'pending') return refuse('agent_message_reservation_conflict');
  // The task holds the blob of its admitted message while it lives.
  if (ciphertextRef !== undefined) await retainSealedCiphertext(stores.objects, taskId, ciphertextRef);

  const consume = messageConsumer(consumers, { tenant: stores.tenant, deviceId, taskId, context: frozen.context }, payload);
  let decision: AgentMessageDecision;
  if (consume === undefined) {
    if (reservation === 'pending') {
      throw new Error('Agent message consumer is unavailable while reconciling an exact pending admission.');
    }
    decision = { outcome: 'held', reasonCode: 'consumer_unavailable' };
  } else {
    // A throw cannot author a disposition: the product may have committed
    // immediately before the transport failed. Leave the exact reservation
    // pending so the same idempotent consume contract can reconcile it.
    decision = await consume();
  }
  const disposition = agentMessageDisposition(payload, decision);
  const admission = await stores.tasks.finalizeAgentMessage({
    taskId,
    deviceId,
    messageId: payload.messageId,
    payloadBody,
    terminalBody: JSON.stringify({ payload, disposition }),
  });
  const terminal = admission?.terminalBody === undefined
    ? undefined
    : parseAgentMessageDisposition(payload, admission.terminalBody);
  if (terminal?.outcome === 'refused') await stores.agentMessageDraft.delete(taskId);
  return terminal === undefined ? refuse('agent_message_admission_unconfirmed') : { outcome: 'accepted', disposition: terminal };
}

/** The consumer of the message's form: `consume` for plaintext, `consumeSealed` for a sealed message. */
function messageConsumer(
  consumers: AgentMessageConsumers | undefined,
  input: { readonly tenant: TenantStores['tenant']; readonly deviceId: string; readonly taskId: string; readonly context: AgentMessageServerContext },
  payload: AgentMessagePublishPayload,
): (() => Promise<AgentMessageDecision>) | undefined {
  if (payload.sealed === undefined) {
    const consume = consumers?.consume;
    return consume === undefined ? undefined : () => consume({ ...input, payload });
  }
  const consumeSealed = consumers?.consumeSealed;
  return consumeSealed === undefined ? undefined : () => consumeSealed({ ...input, payload });
}

function agentMessageDisposition(
  payload: AgentMessagePublishPayload,
  decision: AgentMessageDecision,
): AgentMessageDispositionPayload {
  return {
    agentRef: payload.agentRef,
    sessionRef: payload.sessionRef,
    contract: payload.contract,
    messageId: payload.messageId,
    cursor: payload.cursor,
    ...(payload.sealed === undefined ? { contentHash: payload.contentHash } : { contentMac: payload.sealed.contentMac }),
    outcome: decision.outcome,
    receiptId: crypto.randomUUID(),
    ...(decision.reasonCode === undefined ? {} : { reasonCode: decision.reasonCode }),
  };
}

/** Reads only a terminal immutable admission; pending rows have no disposition to acknowledge. */
export async function readAgentMessageDisposition(
  stores: TenantStores,
  deviceId: string,
  taskId: string,
  payload: AgentMessagePublishPayload,
): Promise<AgentMessageDispositionPayload | undefined> {
  const admission = await stores.tasks.readAgentMessage({
    taskId,
    deviceId,
    messageId: payload.messageId,
    payloadBody: JSON.stringify(payload),
  });
  return admission?.terminalBody === undefined ? undefined : parseAgentMessageDisposition(payload, admission.terminalBody);
}

/** Receipt key a task's terminal is recorded under — the idempotency seam S3b's journal will share. */
export function terminalReceiptKey(taskId: string): string {
  return `task:${taskId}:terminal`;
}

function sameReliableEgress(
  expected: AgentEgressReliablePayload,
  actual: AgentEgressReliablePayload,
): boolean {
  return (
    sameAgentRef(expected.agentRef, actual.agentRef) &&
    expected.sessionRef === actual.sessionRef &&
    expected.policyRevision === actual.policyRevision &&
    expected.eventId === actual.eventId &&
    expected.cursor === actual.cursor &&
    expected.contentHash === actual.contentHash &&
    expected.byteCount === actual.byteCount &&
    JSON.stringify(expected.payload) === JSON.stringify(actual.payload)
  );
}

function contentReadCapability(surface: AgentContentReceiptPayload['surface']): string {
  switch (surface) {
    case 'workspace':
      return AGENT_CONTENT_WORKSPACE_READ_CAPABILITY;
    case 'transcript':
      return AGENT_CONTENT_TRANSCRIPT_READ_CAPABILITY;
    case 'artifact':
      return AGENT_CONTENT_ARTIFACT_READ_CAPABILITY;
  }
}

function hasCapabilities(capabilities: readonly string[] | undefined, required: readonly string[]): boolean {
  return capabilities !== undefined && required.every((capability) => capabilities.includes(capability));
}

function contentRequestReceiptKey(deviceId: string, agentRef: AgentRef, requestId: string): string {
  return agentReliabilityKey('agent-content-request', deviceId, agentRef, requestId);
}

function contentReceiptKey(deviceId: string, agentRef: AgentRef, requestId: string): string {
  return agentReliabilityKey('agent-content-receipt', deviceId, agentRef, requestId);
}

function matchesContentReadReceipt(request: AgentContentReadPayload, receipt: AgentContentReceiptPayload): boolean {
  return (
    request.requestId === receipt.requestId &&
    request.surface === receipt.surface &&
    request.actor.kind === receipt.actor.kind &&
    request.actor.id === receipt.actor.id &&
    sameAgentRef(request.agentRef, receipt.agentRef) &&
    request.sessionRef === receipt.sessionRef &&
    request.runtime === receipt.runtime &&
    request.cwd === receipt.cwd &&
    request.policyRevision === receipt.policyRevision &&
    request.target === receipt.target &&
    request.mimeType === receipt.mimeType &&
    request.decodeAs === receipt.decodeAs
  );
}

async function readContentRequest(
  stores: TenantStores,
  deviceId: string,
  agentRef: AgentRef,
  requestId: string,
): Promise<AgentContentReadPayload | undefined> {
  const stored = await stores.receipts.get(contentRequestReceiptKey(deviceId, agentRef, requestId));
  if (stored === undefined) return undefined;
  try {
    return AgentContentReadPayloadSchema.parse(JSON.parse(stored.body));
  } catch {
    return undefined;
  }
}

function inboundAgentRef(envelope: Envelope): AgentRef | undefined {
  switch (envelope.type) {
    case 'task.claim':
    case 'task.decline':
    case 'task.complete':
    case 'task.fail':
    case 'task.cancelled':
      return envelope.payload.agentRef;
    default:
      return undefined;
  }
}

function agentRefEchoRequired(envelope: Envelope): boolean {
  return envelope.type === 'task.claim' || TERMINAL_TYPES.includes(envelope.type);
}

const TERMINAL_TYPES: readonly MessageType[] = ['task.decline', 'task.complete', 'task.fail', 'task.cancelled'];
/** The types with a `task-output` sealed branch. */
const SEALED_OUTPUT_TYPES: readonly MessageType[] = (Object.keys(SEALED_SPLIT_TABLE) as (keyof typeof SEALED_SPLIT_TABLE)[])
  .filter((type) => SEALED_SPLIT_TABLE[type].category === 'task-output');

/**
 * The frozen `sealing` of a task, from its offer receipt, or `redacted` when
 * task redaction replaced that receipt. A task without a receipt has no
 * sealing.
 */
async function frozenOfferSealing(
  stores: TenantStores,
  deviceId: string,
  taskId: string,
  agentRef: AgentRef | undefined,
): Promise<Pick<TaskSealing, 'categories'> | 'redacted' | undefined> {
  const messageId = await taskOfferMessageId(stores.tenant, taskId, deviceId, agentRef, hashOfferBytes);
  const offer = await stores.receipts.get(`task-offer:${messageId}`);
  if (offer === undefined) return undefined;
  if (isTaskRedactionTombstone(offer.body)) return 'redacted';
  return (JSON.parse(offer.body) as { payload: { sealing?: TaskSealing } }).payload.sealing;
}

/**
 * The output rule of a task's frozen `sealing` (#654 12d). When the offer
 * sealed `task-output`, the device reports output sealed, or plaintext with
 * only the closed codes. Otherwise it reports no sealed output. A redacted
 * offer keeps no sealing, but a redacted task is terminal and stores nothing
 * new, so the rule has nothing to protect there.
 */
async function sealedOutputRefusal(
  stores: TenantStores,
  deviceId: string,
  taskId: string,
  agentRef: AgentRef | undefined,
  envelope: Envelope,
): Promise<Refused | undefined> {
  if (!SEALED_OUTPUT_TYPES.includes(envelope.type)) return undefined;
  const sealedType = isSealedPayload(envelope.type, envelope.payload);
  const sealing = await frozenOfferSealing(stores, deviceId, taskId, agentRef);
  if (sealing === 'redacted') return undefined;
  if (sealing === undefined || !sealing.categories.includes('task-output')) return sealedType ? refuse('sealed_payload_unsupported') : undefined;
  if (sealedType) return undefined;
  return isSealedTaskPlainOutput(envelope.type, envelope.payload, sealing.categories) ? undefined : refuse('sealed_output_required');
}

export async function handleInboundEnvelope(
  stores: TenantStores,
  deviceId: string,
  envelope: Envelope,
  activityBounds: ActivityBounds = DEFAULT_ACTIVITY_BOUNDS,
  agentMessageConsume?: Parameters<typeof handleAgentMessagePublish>[4],
  observer?: ByokCloudObserver,
  now: string = new Date().toISOString(),
): Promise<InboundResult> {
  // Everything that decides the outcome lives in a helper typed Promise<InboundResult>,
  // so a 'rejected' cannot reach the exit below without a reason for the observer.
  const result = await resolveInboundResult(stores, deviceId, envelope, activityBounds, agentMessageConsume, now);
  const { outcome } = result;
  // One notification per envelope, at the ONE exit the gate has. Firing from
  // the gate's own return points instead would have to be repeated at each of
  // them and would be one edit away from firing twice or not at all.
  if (observer !== undefined) {
    if (outcome === 'accepted') {
      try {
        observer.onInboundCommitted({ tenantId: stores.tenant, deviceId, envelope, outcome });
      } catch {
        // The write already committed. A relay that throws is the host's problem
        // to see in its own instrumentation; it cannot retract a durable fact, so
        // it does not get to change what this route answers either.
      }
    } else if (result.outcome === 'rejected') {
      try {
        observer.onInboundRefused?.({
          tenantId: stores.tenant,
          deviceId,
          envelopeId: envelope.id,
          type: envelope.type,
          reason: result.reason,
        });
      } catch {
        // Same contract: the answer is already fixed and counted on the wire.
      }
    }
  }
  return result;
}

async function resolveInboundResult(
  stores: TenantStores,
  deviceId: string,
  envelope: Envelope,
  activityBounds: ActivityBounds,
  agentMessageConsume: Parameters<typeof handleAgentMessagePublish>[4] | undefined,
  now: string,
): Promise<InboundResult> {
  // This exported entrypoint can be called without the HTTP schema boundary.
  // Refuse before reserving an envelope identity or mutating task lifecycle.
  if (envelope.v !== PROTOCOL_VERSION) return refuse('protocol_version_unsupported');
  return applyInboundGate(stores, deviceId, envelope, activityBounds, agentMessageConsume, now);
}

async function applyInboundGate(
  stores: TenantStores,
  deviceId: string,
  envelope: Envelope,
  activityBounds: ActivityBounds,
  agentMessageConsume: Parameters<typeof handleAgentMessagePublish>[4] | undefined,
  now: string,
): Promise<InboundResult> {
  // Long-poll has no live WS handshake. A bearer-authenticated conn.hello is
  // therefore accepted only as a capability snapshot for the same device
  // principal, and is persisted in the durable device row. This is the sole
  // cloud path that admits the target capability; presence is not consulted.
  if (envelope.type === 'conn.hello') {
    if (envelope.payload.deviceId !== deviceId) return refuse('hello_device_mismatch');
    if (envelope.payload.harnesses !== undefined && !envelope.payload.capabilities.includes('custom-harness')) {
      return refuse('hello_harnesses_without_capability');
    }
    if (!envelope.payload.protocolVersions.includes(PROTOCOL_VERSION)) return refuse('hello_protocol_version_unsupported');
    const device = await stores.devices.get(deviceId);
    if (device === undefined || device.revoked) return refuse('device_not_eligible');
    if (device.productId !== envelope.payload.productId) return refuse('hello_product_mismatch');
    if ((await stores.devices.recordCapabilities({ capabilities: envelope.payload.capabilities, ...(envelope.payload.harnesses === undefined ? {} : { harnesses: envelope.payload.harnesses }) })) === undefined) {
      return refuse('hello_capabilities_not_recorded');
    }
    return completeInboundEnvelope(stores, deviceId, envelope.id, undefined);
  }

  if (!(DAEMON_TO_SERVER_TYPES as readonly MessageType[]).includes(envelope.type)) return refuse('type_not_allowed');
  // Progress and approval rows expire and release nothing, so their sealed
  // forms are inline only (12e, the split table's `inlineOnly`).
  const ciphertextRef = sealedCiphertextRef(envelope.payload);
  if (ciphertextRef !== undefined && isSealableMessageType(envelope.type)
    && (SEALED_SPLIT_TABLE[envelope.type] as SealedSplitEntry).inlineOnly === true) return refuse('sealed_payload_unsupported');

  if (envelope.type === 'agent.message.draft') {
    const parsed = AgentMessageDraftPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) return refuse('agent_message_draft_invalid');
    let binding;
    try { binding = await readTaskAgentMessageBinding(stores, deviceId, envelope.task_id, parsed.data.agentRef); }
    catch { return refuse('agent_message_draft_invalid'); }
    // A draft is plaintext, so a task with any sealing streams none (#654 §6.1).
    if (binding === undefined
      || await stores.tasks.readTaskAgentMessage({ taskId: envelope.task_id, deviceId }) !== undefined
      || await stores.receipts.get(terminalReceiptKey(envelope.task_id)) !== undefined
      || await frozenOfferSealing(stores, deviceId, envelope.task_id, binding.attempt.agentRef) !== undefined) {
      return refuse('agent_message_draft_invalid');
    }
    const applied = await stores.agentMessageDraft.apply({ ...parsed.data, taskId: envelope.task_id, deviceId,
      maxBytes: binding.frozen.requirement.maxBytes, now });
    // A terminal or publish may commit while this ephemeral write is in flight.
    // Recheck after apply so that lifecycle deletion cannot leave a late row.
    if (await stores.receipts.get(terminalReceiptKey(envelope.task_id)) !== undefined
      || await stores.tasks.readTaskAgentMessage({ taskId: envelope.task_id, deviceId }) !== undefined) {
      await stores.agentMessageDraft.delete(envelope.task_id);
    } else if (applied === 'applied' && parsed.data.text.length > 0 && binding.attempt.ownerDeviceId !== undefined) {
      // Ownership read before the apply: a claim that commits after this draft
      // landed must not make the draft count as post-claim output.
      await stores.tasks.recordFirstOutput({ taskId: envelope.task_id, deviceId });
    }
    return completeInboundEnvelope(stores, deviceId, envelope.id, parsed.data.agentRef);
  }

  if (envelope.type === 'agent.message.publish') {
    const message = await handleAgentMessagePublish(
      stores,
      deviceId,
      envelope.task_id,
      envelope.payload,
      agentMessageConsume,
      false,
    );
    return message.outcome === 'rejected'
      ? message
      : completeInboundEnvelope(stores, deviceId, envelope.id, envelope.payload.agentRef);
  }

  if (envelope.type === 'agent.egress.reliable') {
    const device = await stores.devices.get(deviceId);
    if (
      device === undefined ||
      device.revoked ||
      !hasCapabilities(device.capabilities, [AGENT_EGRESS_POLICY_CAPABILITY, AGENT_EGRESS_RELIABLE_ACK_CAPABILITY])
    ) {
      return refuse('device_not_eligible');
    }
    const recorded = await stores.egress.record({
      deviceId,
      payload: envelope.payload,
      receiptId: crypto.randomUUID(),
    });
    if (!recorded.created && !sameReliableEgress(recorded.record.payload, envelope.payload)) return refuse('egress_conflict');
    return completeInboundEnvelope(stores, deviceId, envelope.id, envelope.payload.agentRef);
  }

  if (envelope.type === 'agent.content.receipt') {
    const device = await stores.devices.get(deviceId);
    if (device === undefined || device.revoked) return refuse('device_not_eligible');
    if (envelope.payload.eventId !== envelope.payload.requestId) return refuse('content_receipt_event_request_mismatch');
    if (!hasCapabilities(device.capabilities, [contentReadCapability(envelope.payload.surface), AGENT_EGRESS_RELIABLE_ACK_CAPABILITY])) {
      return refuse('device_not_eligible');
    }
    const request = await readContentRequest(stores, deviceId, envelope.payload.agentRef, envelope.payload.requestId);
    if (request === undefined) return refuse('content_receipt_request_unknown');
    if (!matchesContentReadReceipt(request, envelope.payload)) return refuse('content_receipt_request_mismatch');
    const key = contentReceiptKey(deviceId, envelope.payload.agentRef, envelope.payload.requestId);
    // The durable fact is the protocol-validated payload, not a transport
    // envelope whose id/timestamp changes when the Agent replays its spool.
    // Zod has already projected this to its canonical field order, so equal
    // protocol facts have one byte representation while a changed cursor or
    // BlobRef metadata is rejected as a conflicting second receipt.
    const body = JSON.stringify(envelope.payload);
    const receipt = await stores.receipts.record({ key, body });
    if (!receipt.created && receipt.receipt.body !== body) return refuse('content_receipt_conflict');
    return completeInboundEnvelope(stores, deviceId, envelope.id, envelope.payload.agentRef);
  }

  const taskId = envelope.task_id;
  // Every `DAEMON_TO_SERVER_TYPES` member requires `task_id` at the schema
  // level; this is the defensive restatement, not a second contract.
  if (taskId === undefined) return refuse('task_id_missing');

  const attempt = await stores.tasks.get(taskId);
  // The offered target is immutable for every execution kind. This check is
  // repeated inside the claim store's ownership CAS so a stale pre-read cannot
  // authorize a claim, while all other lifecycle writes remain fenced by this
  // immutable attempt binding.
  if (attempt === undefined || attempt.deviceId !== deviceId) return refuse('task_not_found_for_device');
  if (attempt?.ownerDeviceId !== undefined && attempt.ownerDeviceId !== deviceId) return refuse('task_owned_by_other_device');
  // #1119: the cloud settled this attempt without its device (`abandonTask`
  // while the device stays registered): terminal, yet with neither a device
  // terminal receipt nor a Host cancellation. That device still reads the
  // task's rows, so any later report about it is refused, never recorded: the
  // attempt row is the result. A refusal settles the envelope and ends nothing.
  if (
    TERMINAL_TASK_STATUSES.includes(attempt.status) && attempt.cancellation === undefined
    && await stores.receipts.get(terminalReceiptKey(taskId)) === undefined
  ) return refuse('task_settled_by_cloud');
  if (envelope.type === 'task.claim' && envelope.payload.deviceId !== deviceId) return refuse('claim_device_mismatch');
  if (envelope.type === 'task.claim') {
    const harnessId = envelope.payload.harnessId;
    if (harnessId !== undefined && envelope.payload.runtime !== undefined) return refuse('claim_harness_and_runtime_conflict');
    if (attempt.ownerDeviceId !== undefined && (harnessId !== undefined || attempt.claimedHarnessId !== undefined)
      && harnessId !== attempt.claimedHarnessId) return refuse('claim_harness_mismatch');
    const device = await stores.devices.get(deviceId);
    if (harnessId !== undefined && (!device?.capabilities?.includes('custom-harness')
      || !device.harnesses?.some(harness => harness.id === harnessId))) return refuse('claim_harness_unavailable');
    const messageId = await taskOfferMessageId(stores.tenant, taskId, deviceId, attempt.agentRef, hashOfferBytes);
    const offer = await stores.receipts.get(`task-offer:${messageId}`);
    // Redaction and the archive (#1120) leave the offer a tombstone. Only an
    // archived task without a redaction receipt is answered past it: a claimed
    // one keeps its immutable claim snapshot, which the winning claim was
    // checked against the offer to get, and the harness check above and the
    // claim CAS compare a replay with that snapshot, so the replay answers as
    // it did before the archive. Every other tombstoned offer refuses.
    if (offer !== undefined && isTaskRedactionTombstone(offer.body)) {
      if (!(await archivedWithoutRedaction(stores, attempt)) || attempt.ownerDeviceId === undefined) return refuse('claim_offer_mismatch');
    } else if (offer !== undefined) {
      const sealed = JSON.parse(offer.body) as { payload: { harnessId?: string; runtime?: string; dispatchSelection?: unknown } };
      if (harnessId !== undefined && (sealed.payload.runtime !== undefined || sealed.payload.dispatchSelection !== undefined)) return refuse('claim_offer_mismatch');
      if (sealed.payload.harnessId !== undefined && sealed.payload.harnessId !== harnessId) return refuse('claim_offer_mismatch');
    } else if (harnessId !== undefined) return refuse('claim_offer_mismatch');
  }
  let unclaimedInterruption = false;
  if (envelope.type === 'task.fail' && envelope.payload.recovery !== undefined) {
    // Recovery reports a local decision interrupted across the claim boundary.
    // It cannot manufacture cloud execution ownership, nor loosen claimed identity.
    // An interruption is reported in plaintext with a closed code (#654 12d).
    if (envelope.payload.sealed !== undefined || envelope.payload.reason !== 'daemon_interrupted' || envelope.payload.retryable !== false) {
      return refuse('recovery_report_invalid');
    }
    const messageId = await taskOfferMessageId(stores.tenant, taskId, deviceId, attempt.agentRef, hashOfferBytes);
    if (envelope.payload.recovery.offerId !== messageId) return refuse('recovery_offer_mismatch');
    const offer = await stores.receipts.get(`task-offer:${messageId}`);
    if (offer === undefined) return refuse('recovery_offer_mismatch');
    if (isTaskRedactionTombstone(offer.body)) {
      // The offer content is gone (see the claim above), and only an archived
      // task without a redaction receipt goes on. A claimed one's harness
      // binding is its claim snapshot, checked below; an unclaimed one keeps
      // only its terminal receipt, which only an exact replay of the recorded
      // recovery matches.
      if (!(await archivedWithoutRedaction(stores, attempt))) return refuse('recovery_offer_mismatch');
      if (attempt.ownerDeviceId === undefined) {
        const terminal = await stores.receipts.get(terminalReceiptKey(taskId));
        if (terminal === undefined || !(await sameTaskBody(terminal.body, encodeEnvelope(envelope), { sha256: hashOfferBytes }))) {
          return refuse('recovery_offer_mismatch');
        }
      }
    } else {
      const sealed = JSON.parse(offer.body) as { payload: { harnessId?: string; runtime?: string; dispatchSelection?: unknown } };
      const harnessId = envelope.payload.harnessId;
      if (sealed.payload.harnessId !== undefined && sealed.payload.harnessId !== harnessId) return refuse('recovery_offer_mismatch');
      if (harnessId !== undefined && (sealed.payload.runtime !== undefined || sealed.payload.dispatchSelection !== undefined)) return refuse('recovery_offer_mismatch');
    }
    // For automatic selection the target device reports its sealed local
    // admission. Inventory is mutable and is not historical claim authority.
    unclaimedInterruption = attempt.ownerDeviceId === undefined && attempt.claimedHarnessId === undefined;
  }
  if (['task.complete', 'task.fail', 'task.cancelled'].includes(envelope.type) && !unclaimedInterruption
    && (envelope.payload as { harnessId?: string }).harnessId !== attempt.claimedHarnessId) return refuse('terminal_harness_mismatch');

  // Agent identity is an exact-match boundary. A missing echo is a mismatch
  // just like a different id or profile revision; accepting it would let an
  // unrelated session write a terminal for the durable Agent attempt.
  if (
    attempt?.agentRef !== undefined &&
    agentRefEchoRequired(envelope) &&
    !sameAgentRef(attempt.agentRef, inboundAgentRef(envelope))
  ) {
    return refuse('agent_identity_mismatch');
  }
  // A redacted or archived task keeps no new content. A terminal that names
  // its ciphertext blob is complete as received: its references are gone, and
  // the terminal receipt is already a tombstone. Late progress, artifacts and
  // approval reports are refused below as on any task whose output closed
  // (#1113 A3), so removing the content does not change their answer.
  if (ciphertextRef !== undefined
    && TERMINAL_TASK_STATUSES.includes(attempt.status)
    && await taskContentRemoved(stores, attempt)) {
    return completeInboundEnvelope(stores, deviceId, envelope.id, attempt.agentRef);
  }
  const sealingRefusal = await sealedOutputRefusal(stores, deviceId, taskId, attempt.agentRef, envelope);
  if (sealingRefusal !== undefined) return sealingRefusal;
  // A sealed terminal or artifact above the inline limit names its ciphertext
  // blob, which the task then holds while it lives. Every step so far only
  // read, so a refusal here leaves no state.
  if (ciphertextRef !== undefined && !(await sealedCiphertextCommitted(stores.objects, ciphertextRef))) {
    return refuse('sealed_ciphertext_invalid');
  }
  const activityBatch = activityBatchOf(taskId, envelope);
  if (activityBatch !== undefined) {
    try {
      validateActivityBatch(activityBatch, activityBounds);
    } catch (caught) {
      if (isCloudError(caught, 'activity_batch_too_large')) return refuse('activity_batch_too_large');
      if (isCloudError(caught, 'coordination_input_invalid')) return refuse('activity_batch_invalid');
      throw caught;
    }
  }

  const approvalInput = approvalTimelineAppendInput(taskId, envelope);
  if (approvalInput !== undefined) {
    try {
      validateApprovalTimelineAppend(approvalInput);
    } catch (caught) {
      if (isCloudError(caught, 'coordination_input_invalid')) return refuse('approval_event_invalid');
      throw caught;
    }
  }

  let lifecycleRefusal: Refused | undefined;
  try {
    lifecycleRefusal = await applyLifecycle(stores, deviceId, taskId, envelope, activityBounds, attempt?.agentRef);
  } catch (caught) {
    if (isCloudError(caught, 'activity_batch_too_large')) return refuse('activity_batch_too_large');
    if (isCloudError(caught, 'activity_task_settled') || isCloudError(caught, 'approval_timeline_settled')) return refuse('task_settled_by_cloud');
    if (isCloudError(caught, 'activity_history_gap')) return refuse('task_settled_by_cloud');
    throw caught;
  }
  if (lifecycleRefusal !== undefined) return lifecycleRefusal;
  return completeInboundEnvelope(stores, deviceId, envelope.id, attempt?.agentRef);
}

const TERMINAL_TASK_STATUSES: readonly string[] = ['complete', 'failed', 'cancelled'];

/** Marks an envelope complete only after all of its authoritative facts converged. */
async function completeInboundEnvelope(
  stores: TenantStores,
  deviceId: string,
  envelopeId: string,
  agentRef: AgentRef | undefined,
): Promise<InboundResult> {
  const duplicate = agentRef === undefined
    ? await stores.dedup.checkAndRecord(deviceId, envelopeId)
    : await stores.dedup.checkAndRecordAgent(deviceId, agentRef, envelopeId);
  return { outcome: duplicate ? 'duplicate' : 'accepted' };
}

/**
 * The lifecycle half. Deliberately thin: S3a records ownership, the coarse
 * attempt status, the terminal receipt, and bounded activity/approval
 * observations. Plaintext artifacts share the activity log; task results and
 * truth/board facts retain their existing authorities.
 */
async function applyLifecycle(
  stores: TenantStores,
  deviceId: string,
  taskId: string,
  envelope: Envelope,
  activityBounds: ActivityBounds,
  persistedAgentRef: AgentRef | undefined,
): Promise<Refused | undefined> {
  switch (envelope.type) {
    case 'task.claim': {
      // The claiming adapter's own self-report, carried straight through as
      // the write-once claim snapshot. Nothing is read from the durable
      // connection-level capability list here (`DeviceRecord.capabilities`,
      // written by `conn.hello` above): that describes a device build, not the
      // adapter that took THIS task, and letting it reach the snapshot is the
      // exact scope defect the steer gate exists to forbid.
      const claimed = await stores.tasks.claim({
        taskId,
        deviceId,
        ...(envelope.payload.runtime === undefined ? {} : { runtime: envelope.payload.runtime }),
        ...(envelope.payload.harnessId === undefined ? {} : { harnessId: envelope.payload.harnessId }),
        ...(envelope.payload.capabilities === undefined
          ? {}
          : { capabilities: envelope.payload.capabilities }),
      });
      // The pre-read may be stale. Only the store's atomic result proves
      // this execution won ownership (or is an exact-identity replay).
      if (claimed === undefined || claimed.ownerDeviceId !== deviceId
        || claimed.claimedRuntime !== envelope.payload.runtime
        || claimed.claimedHarnessId !== envelope.payload.harnessId) return refuse('claim_not_won');
      return undefined;
    }
    case 'task.started':
      await stores.tasks.recordStatus({
        taskId,
        status: 'running',
        ...(persistedAgentRef === undefined ? {} : { agentRef: persistedAgentRef }),
      });
      return;
    case 'task.decline':
      // A decline is a terminal (§3.2, `Offered -> Failed`), so it takes the
      // same path as complete/fail/cancelled: one terminal receipt under the
      // same key, first-terminal-wins, and therefore a readable result.
      // Recording only the coarse `failed` status here left an attempt that a
      // reader could see reach a terminal and then find no result to read.
      return recordTerminal(stores, taskId, envelope);
    case 'task.progress': {
      const batch = activityBatchOf(taskId, envelope);
      if (batch !== undefined) await appendActivityEvents(stores.activity, batch, activityBounds);
      return;
    }
    case 'task.await_approval':
      await stores.approvals.append(approvalTimelineAppendInput(taskId, envelope)!);
      return;
    case 'task.approval_resolved':
      await stores.approvals.append(approvalTimelineAppendInput(taskId, envelope)!);
      return;
    case 'task.complete':
      return recordTerminal(stores, taskId, envelope);
    case 'task.fail':
      return recordTerminal(stores, taskId, envelope);
    case 'task.cancelled':
      return recordTerminal(stores, taskId, envelope);
    case 'task.artifact': {
      const activity = activityBatchOf(taskId, envelope);
      if (activity !== undefined) await appendActivityEvents(stores.activity, activity, activityBounds);
      // Sealed artifacts remain outside the log until #1045 item 6; their existing blob hold is unchanged.
      const ref = envelope.payload.sealed === undefined ? undefined : sealedCiphertextRef(envelope.payload);
      if (ref === undefined) return;
      // One reference per (blob, task): a replay cannot tell its reference
      // from the one an earlier delivery added. So an artifact on a terminal
      // task changes no reference. A new one holds no blob, and a replay keeps
      // the earlier hold until redaction releases it.
      const before = await stores.tasks.get(taskId);
      if (before === undefined || TERMINAL_TASK_STATUSES.includes(before.status)) return;
      await retainSealedCiphertext(stores.objects, taskId, ref);
      // Redaction releases the task's references again after it commits, so
      // only a redaction that has already finished can miss this one.
      if (await stores.receipts.get(taskRedactionReceiptKey(taskId)) !== undefined) {
        await releaseSealedCiphertext(stores.objects, taskId, ref);
      }
      return;
    }
    default:
      return;
  }
}

/** Every admitted progress envelope has an activity row, including empty batches. */
function activityBatchOf(taskId: string, envelope: Envelope): Parameters<typeof appendActivityEvents>[1] | undefined {
  const source = { taskId, sourceEnvelopeId: envelope.id, dropped: 0 };
  if (envelope.type === 'task.artifact' && envelope.payload.sealed === undefined) {
    return { taskId, sourceEnvelopeId: envelope.id, artifact: envelope.payload };
  }
  if (envelope.type !== 'task.progress') return undefined;
  if (envelope.payload.sealed !== undefined) return { ...source, batchSeq: envelope.payload.seq, sealed: envelope.payload.sealed };
  return { ...source, batchSeq: envelope.payload.seq, events: envelope.payload.events };
}

function approvalTimelineAppendInput(
  taskId: string,
  envelope: Envelope,
): ApprovalTimelineAppendInput | undefined {
  switch (envelope.type) {
    case 'task.await_approval':
      return {
        taskId,
        sourceEnvelopeId: envelope.id,
        event: envelope.payload.sealed === undefined
          ? { type: 'approval_requested', summary: envelope.payload.summary, approvalId: envelope.payload.approvalId }
          : { type: 'approval_requested', approvalId: envelope.payload.approvalId, sealed: envelope.payload.sealed },
      };
    case 'task.approval_resolved':
      return {
        taskId,
        sourceEnvelopeId: envelope.id,
        event: {
          type: 'approval_resolved',
          approvalId: envelope.payload.approvalId,
          decision: envelope.payload.decision,
          resolvedBy: envelope.payload.resolvedBy,
          at: envelope.payload.at,
        },
      };
    default:
      return undefined;
  }
}

/**
 * First terminal wins (§12.6.4: 不覆写第一份事实). A retried terminal — same
 * task, new envelope id, so dedup does not catch it — records nothing new and
 * leaves the attempt status where the first one put it.
 *
 * What gets stored is `encodeEnvelope(envelope)`: the canonical v1 encoding of
 * the envelope this gate already zod-parsed, NOT the device's original byte
 * sequence. The two are semantically identical by the frozen codec's own
 * round-trip guarantee, but they are not necessarily byte-identical (key
 * order, whitespace, and any field the schema drops are the parser's call, not
 * the device's) — so this receipt is evidence of the first terminal FACT, not
 * a byte-faithful capture of the first terminal REQUEST. S3b's local journal
 * is where the device's own bytes are kept.
 */
async function recordTerminal(
  stores: TenantStores,
  taskId: string,
  envelope: Envelope,
): Promise<Refused | undefined> {
  const body = encodeEnvelope(envelope);
  // The task holds a sealed terminal's blob before any receipt names it.
  const ciphertextRef = sealedCiphertextRef(envelope.payload);
  const heldBefore = ciphertextRef !== undefined && await sealedCiphertextHeld(stores.objects, ciphertextRef);
  if (ciphertextRef !== undefined) await retainSealedCiphertext(stores.objects, taskId, ciphertextRef);
  const receipt = await stores.receipts.record({ key: terminalReceiptKey(taskId), body });
  // A terminal that lost, or one that arrived after redaction, keeps nothing.
  // A redacted task holds nothing, so after redaction it always releases. A
  // terminal that lost releases only a blob that nothing held before: one
  // reference per (blob, task) cannot tell whose hold it is, and one that
  // names the task's offer or steer blob leaves that hold in place.
  if (ciphertextRef !== undefined && receipt.receipt.body !== body
    && storedCiphertextHash(receipt.receipt.body) !== ciphertextRef.contentHash
    && (isTaskRedactionTombstone(receipt.receipt.body) || !heldBefore)) {
    await releaseSealedCiphertext(stores.objects, taskId, ciphertextRef);
  }
  // Redaction runs only on a terminal task, so its status and projections are
  // already settled. A later terminal is a replay with nothing to record.
  if (isTaskRedactionTombstone(receipt.receipt.body)) return;
  // Receipt insertion and the status/board projections are separate durable
  // writes. A retry resumes from the winning receipt instead of returning just
  // because the receipt was already present.
  const winner = terminalReceiptBinding(taskId, receipt.receipt.body);
  // A stored receipt nothing can read back is this task's fault, not the
  // batch's: refuse this terminal and let the rest of the batch apply (#1121).
  if (winner === undefined) return refuse('terminal_receipt_not_canonical');
  await stores.agentMessageDraft.delete(taskId);
  const attempt = await stores.tasks.get(taskId);
  if (attempt?.cancellation !== undefined) {
    // A cancellation tombstone is the effective product authority even when
    // the immutable terminal receipt contains the original completion/failure.
    // Persist the cancelled status through the store CAS: if cancellation lands
    // after this read, the same CAS observes it and converges; the original
    // receipt bytes remain untouched and no review projection is emitted.
    await stores.tasks.recordStatus({
      taskId,
      status: 'cancelled',
      ...(attempt.agentRef === undefined ? {} : { agentRef: attempt.agentRef }),
    });
    return;
  }
  const recordedAttempt = await stores.tasks.recordStatus({
    taskId,
    status: winner.status,
    ...(attempt?.agentRef === undefined ? {} : { agentRef: attempt.agentRef }),
    ...(winner.cause === undefined ? {} : { terminalCause: winner.cause }),
  });
  // The attempt mutation is the ordering CAS. Cancellation may have landed
  // after the read above but before this write; in that race the store returns
  // the cancellation-bearing attempt and no business projection is allowed.
  if (recordedAttempt?.cancellation !== undefined || recordedAttempt?.status !== winner.status) {
    if (recordedAttempt?.cancellation !== undefined) {
      await stores.tasks.recordStatus({
        taskId,
        status: 'cancelled',
        ...(recordedAttempt.agentRef === undefined ? {} : { agentRef: recordedAttempt.agentRef }),
      });
    }
    return;
  }
  await projectTerminalToReview(stores.board, taskId);
}

/** The ciphertext blob hash a stored terminal names; none for a plaintext terminal or a tombstone. */
/** Redaction writes an audit receipt; the archive step (#1120) sets `archivedAt`. Either removed the task's content. */
async function taskContentRemoved(stores: TenantStores, attempt: TaskAttempt): Promise<boolean> {
  return attempt.archivedAt !== undefined || await taskRedacted(stores, attempt.taskId);
}

/** An explicit redaction's audit receipt; the archive writes none. */
async function taskRedacted(stores: TenantStores, taskId: string): Promise<boolean> {
  return await stores.receipts.get(taskRedactionReceiptKey(taskId)) !== undefined;
}

/** The archive (#1120) removed the content, and no explicit redaction did: redaction's refusals take precedence. */
async function archivedWithoutRedaction(stores: TenantStores, attempt: TaskAttempt): Promise<boolean> {
  return attempt.archivedAt !== undefined && !(await taskRedacted(stores, attempt.taskId));
}

function storedCiphertextHash(body: string): string | undefined {
  try {
    return sealedCiphertextRef(decodeEnvelope(body).payload)?.contentHash;
  } catch {
    return undefined;
  }
}

function terminalStatus(envelope: Envelope): 'complete' | 'failed' | 'cancelled' | undefined {
  switch (envelope.type) {
    case 'task.complete':
      return 'complete';
    case 'task.fail':
    case 'task.decline':
      return 'failed';
    case 'task.cancelled':
      return 'cancelled';
    default:
      return undefined;
  }
}

function terminalReceiptBinding(
  taskId: string,
  body: string,
): { readonly status: 'complete' | 'failed' | 'cancelled'; readonly cause?: string } | undefined {
  let envelope: Envelope;
  try {
    envelope = decodeEnvelope(body);
  } catch {
    return undefined;
  }
  const status = terminalStatus(envelope);
  if (status === undefined || envelope.task_id !== taskId || encodeEnvelope(envelope) !== body) return undefined;
  // A sealed terminal keeps its reason in the ciphertext. Only a closed code
  // stays plaintext (§9.3).
  const cause =
    envelope.type !== 'task.fail' && envelope.type !== 'task.cancelled' && envelope.type !== 'task.decline'
      ? undefined
      : envelope.payload.sealed === undefined
        ? envelope.payload.reason
        : envelope.type === 'task.decline'
          ? envelope.payload.code
          : undefined;
  return { status, ...(cause === undefined ? {} : { cause }) };
}
