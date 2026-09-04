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
 * Rate limiting is per REQUEST, not per envelope: the moment any envelope
 * comes back `rate_limited`, the rest of the batch is abandoned (its bucket is
 * empty, so every remaining envelope would limit too) and the WHOLE request
 * answers 429. Envelopes processed earlier in the same batch already took
 * effect — there are no rollback semantics here — which is safe because every
 * `task.*` type is idempotent (§9): a client that retries the same batch gets
 * `duplicate` for whatever already landed.
 */
import type { Context } from 'hono';
import {
  MessagesSendRequestSchema,
  type AgentContentReceiptPayload,
  type AgentMessageDispositionPayload,
  type AgentMessagePublishPayload,
  type MessagesSendResponse,
} from '@byok-sdk/protocol';
import { handleInboundEnvelope, readAgentMessageDisposition, type ByokCloudObserver } from '../inbound';
import type { ActivityBounds } from '../coordination';
import type { AgentEgressRecord } from '../stores/ports';
import type { TenantStores } from '../tenant-stores';
import { authenticateDevice, readBoundedJsonBody, type DeviceRouteDeps } from './shared';

const MESSAGES_JSON_BODY_MAX_BYTES = 2 * 1024 * 1024;

export interface MessagesRouteDeps extends DeviceRouteDeps {
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
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);
    const { device, stores } = authenticated;

    const body = await readBoundedJsonBody(c, MESSAGES_JSON_BODY_MAX_BYTES);
    if (body.tooLarge) return c.json({ error: 'request body too large' }, 413);
    const parsed = MessagesSendRequestSchema.safeParse(body.body);
    if (!parsed.success) return c.json({ error: 'messages must be an array of envelopes' }, 400);

    let accepted = 0;
    let rejected = 0;
    for (const envelope of parsed.data.messages) {
      const outcome = await handleInboundEnvelope(
        stores,
        device.deviceId,
        envelope,
        deps.activityBounds,
        envelope.type === 'agent.message.publish' ? deps.agentMessage?.consume : undefined,
        deps.observer,
      );
      if (outcome === 'rate_limited') return c.json({ error: 'rate limit exceeded' }, 429);
      if (envelope.type === 'agent.message.publish') {
        const disposition = await readAgentMessageDisposition(stores, device.deviceId, envelope.task_id, envelope.payload);
        if (disposition !== undefined) {
          await deps.appendAgentMessageDisposition(stores, device.deviceId, envelope.task_id, disposition);
        }
      }
      if (envelope.type === 'agent.egress.reliable' && (outcome === 'accepted' || outcome === 'duplicate')) {
        const record = await stores.egress.get(device.deviceId, envelope.payload.eventId);
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
    }

    const response: MessagesSendResponse = rejected > 0 ? { accepted, rejected } : { accepted };
    return c.json(response, 200);
  };
}
