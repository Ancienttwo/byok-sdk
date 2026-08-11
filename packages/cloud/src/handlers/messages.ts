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
import { MessagesSendRequestSchema, type MessagesSendResponse } from '@byok-sdk/protocol';
import { handleInboundEnvelope } from '../inbound';
import type { ActivityBounds } from '../coordination';
import { authenticateDevice, readJsonBody, type DeviceRouteDeps } from './shared';

export interface MessagesRouteDeps extends DeviceRouteDeps {
  readonly activityBounds: ActivityBounds;
}

export function messagesHandler(deps: MessagesRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);
    const { device, stores } = authenticated;

    const parsed = MessagesSendRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'messages must be an array of envelopes' }, 400);

    let accepted = 0;
    let rejected = 0;
    for (const envelope of parsed.data.messages) {
      const outcome = await handleInboundEnvelope(
        stores,
        device.deviceId,
        envelope,
        deps.activityBounds,
      );
      if (outcome === 'rate_limited') return c.json({ error: 'rate limit exceeded' }, 429);
      // A duplicate is still a wire-level success (§8.2/§9's idempotency
      // window) — it just did not re-run a handler. Only a gate rejection
      // (wrong-direction type, or an ownership mismatch) is excluded.
      if (outcome === 'rejected') rejected += 1;
      else accepted += 1;
    }

    // `rejected` is additive and omitted entirely when zero, so a batch with
    // nothing rejected keeps the `{ accepted }` shape callers depend on.
    const response: MessagesSendResponse = rejected > 0 ? { accepted, rejected } : { accepted };
    return c.json(response, 200);
  };
}
