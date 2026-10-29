/**
 * `POST /byok/messages` — the long-poll send half (§8.2).
 *
 * A device long-polling for cloud -> daemon traffic has no live socket to
 * carry its own outbound envelopes; this batches them over authed HTTP. Every
 * envelope goes through the same gate (`../inbound.ts`) in the same order, so
 * claim/progress/complete behave identically no matter which transport carried
 * them.
 *
 * The batch stays tolerant at the schema level — one malformed envelope must
 * not 400 the whole request — so only a structurally invalid `Envelope` or an
 * oversized batch (`MAX_MESSAGES_PER_BATCH`) fails the request outright.
 *
 * Rate admission covers the whole batch: it is charged one token per envelope
 * before the first envelope applies, and a refusal answers 429 having applied
 * nothing. Charging envelope by envelope while applying them let a batch
 * larger than the remaining budget apply a prefix, answer 429 without that
 * prefix's outcomes, and on every resend spend the refilled budget on the
 * prefix's duplicates, so its suffix never landed (#1118).
 *
 * Server replies (acks, dispositions) are appended to the device's mailbox.
 * A full mailbox refuses them with `storage_quota_exceeded`, which answers the
 * wire-stable 507 (§8.2) instead of a 500: resending the same batch is safe,
 * because its duplicates re-append the same idempotent replies once the
 * mailbox has room.
 */
import type { Context } from 'hono';
import { STORAGE_ERROR_HTTP_STATUS, isCoreError } from '@byok-sdk/core';
import {
  MESSAGES_SEND_MAX_BODY_BYTES,
  MessagesSendRequestSchema,
  type AgentContentReceiptPayload,
  type AgentMessageDispositionPayload,
  type AgentMessagePublishPayload,
  type MessagesSendResponse,
} from '@byok-sdk/protocol';
import { handleInboundEnvelope, readAgentMessageDisposition, type ByokCloudObserver, type InboundRefusalReason } from '../inbound';
import type { ActivityBounds } from '../coordination';
import type { AgentEgressRecord } from '../stores/ports';
import type { TenantStores } from '../tenant-stores';
import { CLOUD_PROTOCOL_CAPABILITIES } from './events';
import { authenticateDevice, rateLimited, readBoundedJsonBody, type DeviceRouteDeps } from './shared';


/** Coarse wire vocabulary deliberately hides task existence and identity bindings. */
const WIRE_REFUSAL_REASONS = {
  task_id_missing: 'payload_invalid',
  hello_harnesses_without_capability: 'payload_invalid',
  content_receipt_event_request_mismatch: 'payload_invalid',
  claim_harness_and_runtime_conflict: 'payload_invalid',
  recovery_report_invalid: 'payload_invalid',
  activity_batch_invalid: 'payload_invalid',
  sealed_ciphertext_invalid: 'payload_invalid',
  approval_event_invalid: 'payload_invalid',
  device_not_eligible: 'not_permitted',
  hello_device_mismatch: 'not_permitted',
  hello_product_mismatch: 'not_permitted',
  hello_capabilities_not_recorded: 'not_permitted',
  agent_message_draft_invalid: 'not_permitted',
  agent_message_attempt_mismatch: 'not_permitted',
  agent_message_offer_binding_missing: 'not_permitted',
  agent_message_binding_corrupt: 'not_permitted',
  agent_message_binding_mismatch: 'not_permitted',
  content_receipt_request_unknown: 'not_permitted',
  content_receipt_request_mismatch: 'not_permitted',
  task_not_found_for_device: 'not_permitted',
  task_owned_by_other_device: 'not_permitted',
  agent_identity_mismatch: 'not_permitted',
  terminal_harness_mismatch: 'not_permitted',
  claim_device_mismatch: 'not_permitted',
  claim_harness_mismatch: 'not_permitted',
  claim_harness_unavailable: 'not_permitted',
  claim_offer_mismatch: 'not_permitted',
  recovery_offer_mismatch: 'not_permitted',
  agent_message_too_large: 'limit_exceeded',
  activity_batch_too_large: 'limit_exceeded',
  agent_message_already_deduplicated: 'state_conflict',
  agent_message_reservation_conflict: 'state_conflict',
  agent_message_admission_unconfirmed: 'state_conflict',
  egress_conflict: 'state_conflict',
  content_receipt_conflict: 'state_conflict',
  claim_not_won: 'state_conflict',
  task_settled_by_cloud: 'state_conflict',
  protocol_version_unsupported: 'unsupported',
  type_not_allowed: 'unsupported',
  sealed_payload_unsupported: 'unsupported',
  sealed_output_required: 'not_permitted',
  hello_protocol_version_unsupported: 'unsupported',
} satisfies Record<InboundRefusalReason, import('@byok-sdk/protocol').OutboundRefusalReason>;

export interface MessagesRouteDeps extends DeviceRouteDeps {
  readonly clock: import('@byok-sdk/core').Clock;
  readonly activityBounds: ActivityBounds;
  /**
   * The egress fact is committed by the inbound gate first. This callback then
   * puts the exact receipt acknowledgement in the durable core mailbox, so a
   * transport retry cannot turn a committed reliable event into an unacked one.
   */
  readonly appendReliableEgressAck: (stores: TenantStores, record: AgentEgressRecord) => Promise<void>;
  /** Content receipt rows share the reliable spool/ack protocol but preserve their own exact payload authority. */
  readonly appendContentReceiptAck: (
    stores: TenantStores,
    deviceId: string,
    payload: AgentContentReceiptPayload,
  ) => Promise<void>;
  readonly agentMessage?: {
    consume(input: {
      readonly tenant: TenantStores['tenant'];
      readonly deviceId: string;
      readonly taskId: string;
      readonly context: import('@byok-sdk/protocol').AgentMessageServerContext;
      readonly payload: AgentMessagePublishPayload;
    }): Promise<{ readonly outcome: 'accepted' | 'held' | 'refused'; readonly reasonCode?: string }>;
  };
  readonly appendAgentMessageDisposition: (
    stores: TenantStores,
    deviceId: string,
    taskId: string,
    payload: AgentMessageDispositionPayload,
  ) => Promise<void>;
  /**
   * Post-commit relay. Batch order IS notification order: the loop below
   * awaits one envelope's gate before starting the next, so an observer sees
   * committed envelopes in the order the device sent them.
   */
  readonly observer?: ByokCloudObserver;
}

export function messagesHandler(deps: MessagesRouteDeps) {
  const send = batchHandler(deps);
  return async (c: Context): Promise<Response> => {
    try {
      return await send(c);
    } catch (cause) {
      if (isCoreError(cause, 'storage_quota_exceeded')) {
        return c.json({ error: cause.code }, STORAGE_ERROR_HTTP_STATUS.storage_quota_exceeded);
      }
      // A tenant the Host never issued an entitlement to: the client keeps
      // the batch and retries with backoff until the Host issues one. The
      // typed 409 the blob routes use makes the cause visible, instead of
      // an opaque 500, so operators can tell it from a full mailbox (507).
      if (isCoreError(cause, 'storage_entitlement_missing')) {
        return c.json({ error: cause.code }, 409);
      }
      throw cause;
    }
  };
}

function batchHandler(deps: MessagesRouteDeps) {
  return async (c: Context): Promise<Response> => {
    // No request debit: the batch spends its envelopes below instead (see
    // `admitDeviceRequest`).
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);
    const { device, stores } = authenticated;

    const body = await readBoundedJsonBody(c, MESSAGES_SEND_MAX_BODY_BYTES);
    if (body.tooLarge) return c.json({ error: 'request body too large' }, 413);
    const parsed = MessagesSendRequestSchema.safeParse(body.body);
    if (!parsed.success) return c.json({ error: 'messages must be an array of envelopes' }, 400);
    const admission = await stores.rateLimiter.consume(device.deviceId, 'envelope', parsed.data.messages.length);
    if (!admission.allowed) return rateLimited(c, admission.retryAfterMs);

    let accepted = 0;
    let rejected = 0;
    let handshake = false;
    const outcomes: NonNullable<MessagesSendResponse['outcomes']> = [];
    for (const envelope of parsed.data.messages) {
      const result = await handleInboundEnvelope(
        stores,
        device.deviceId,
        envelope,
        deps.activityBounds,
        envelope.type === 'agent.message.publish' ? deps.agentMessage?.consume : undefined,
        deps.observer,
        deps.clock.now().toISOString(),
      );
      const { outcome } = result;
      outcomes.push({ id: envelope.id, outcome, ...(result.outcome === 'rejected' ? { reason: WIRE_REFUSAL_REASONS[result.reason] } : {}) });
      if (envelope.type === 'agent.message.publish') {
        const disposition = await readAgentMessageDisposition(stores, device.deviceId, envelope.task_id, envelope.payload);
        if (disposition !== undefined) {
          await deps.appendAgentMessageDisposition(stores, device.deviceId, envelope.task_id, disposition);
        }
      }
      if (envelope.type === 'agent.egress.reliable' && (outcome === 'accepted' || outcome === 'duplicate')) {
        const record = await stores.egress.get(device.deviceId, envelope.payload.agentRef, envelope.payload.eventId);
        if (record === undefined) {
          throw new Error(`Accepted reliable egress ${envelope.payload.eventId} has no durable receipt record.`);
        }
        await deps.appendReliableEgressAck(stores, record);
      }
      if (envelope.type === 'agent.content.receipt' && (outcome === 'accepted' || outcome === 'duplicate')) {
        await deps.appendContentReceiptAck(stores, device.deviceId, envelope.payload);
      }
      // A duplicate is a wire-level success (§8.2/§9's idempotency window),
      // even though its business mutation did not execute a second time.
      if (outcome === 'rejected') rejected += 1;
      else accepted += 1;
      if (envelope.type === 'conn.hello' && outcome !== 'rejected') handshake = true;
    }

    // A batch whose `conn.hello` was accepted is the daemon's handshake: its
    // answer carries the same advertisement `GET /byok/events` does, so the
    // device learns the server's capabilities in that one round trip instead
    // of waiting out a held poll (§8.2). Every other answer, a rejected
    // hello's included, omits it ("no update").
    const response: MessagesSendResponse = {
      accepted,
      outcomes,
      ...(rejected > 0 ? { rejected } : {}),
      ...(handshake ? { capabilities: [...CLOUD_PROTOCOL_CAPABILITIES], ingress: { activityMaxEvents: deps.activityBounds.maxEvents, activityMaxBytes: deps.activityBounds.maxBytes } } : {}),
    };
    return c.json(response, 200);
  };
}
