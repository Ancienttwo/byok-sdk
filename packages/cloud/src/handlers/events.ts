import {
  MAILBOX_READ_AHEAD_CAPABILITY,
  MAILBOX_READ_AHEAD_MAX_SEQS,
  RUNTIME_FAILURE_CLASS_CAPABILITY,
  SEALED_OUTPUT_CIPHERTEXT_REF_CAPABILITY,
  SEALED_PAYLOAD_CAPABILITY,
} from '@byok-sdk/protocol';
/**
 * `GET /byok/events?cursor=N` — the long-poll receive half (§8).
 *
 * Four properties the daemon's transport depends on, reproduced against the
 * core mailbox rather than an in-process outbox:
 *
 * - **Reading is not acknowledging.** `readAfter` never moves the cursor. The
 *   ONLY ack is the cursor the daemon brings back on its NEXT poll, after it
 *   has durably processed what it was handed — which is why the ack below
 *   happens before the read, against the incoming `cursor`, and why a poll
 *   that hands back the same cursor replays the same page forever.
 * - **The ack is monotonic.** A cursor at or below what the device already
 *   acked carries no new information and is not an ack attempt; only a
 *   strictly higher one advances. The store stays the authority on both
 *   bounds: it rejects regression and refuses any cursor beyond the highest
 *   one this route recorded immediately before returning it.
 * - **The hold.** An empty poll is held open instead of answered immediately,
 *   so an idle daemon is not a busy-loop. An injected wake port hints when to
 *   re-read; it owns subscriptions, and losing its hints only delays delivery
 *   to its fallback interval. The mailbox stays the authority across instances.
 * - **A lost cursor fails closed.** A cursor below the mailbox's retained
 *   window is answered `409 { error: 'cursor_too_old', recoverableFrom }`, the
 *   same body the old reference server returned and the only one the
 *   daemon's transport can turn into a resync. Serving
 *   such a caller a 200 would hand it a partial tail it has no way to tell
 *   apart from a complete one.
 */
import type { Context } from 'hono';
import { isCoreConflictError } from '@byok-sdk/core';
import { decodeEnvelope, type Envelope, type EventsPollResponse } from '@byok-sdk/protocol';
import { authenticateDevice, type DeviceRouteDeps } from './shared';

/**
 * Protocol features this cloud build accepts from a long-poll daemon.
 *
 * This response is the ONLY advertisement a long-poll daemon ever sees, and
 * the daemon hard-gates outgoing messages on it
 * (`AgentEgressController.retryableReliableRecords` in
 * `packages/client/src/daemon/agent-egress-controller.ts`). An entry
 * missing here is therefore not cosmetic: it silently disables an inbound wire
 * path the kernel already implements.
 *
 * The list is deliberately the kernel's INBOUND acceptance set, not the union
 * of `@byok-sdk/protocol`'s `CAPABILITY_FLAGS` (which the deleted reference
 * server advertised wholesale). Excluded on purpose, each for a reason:
 *
 * - server-to-daemon message types the daemon never gates on — `steer`,
 *   `toolset-selection`;
 * - device-side flags the kernel reads off `conn.hello` instead —
 *   `terminal-projection-selection` (a device-advertised `WIRE_ADDITIONS`
 *   gate, read through `requiredReceiverCapabilities` in `cloud.ts`),
 *   `agent-home-readers` (the Agent offer enqueue gates in `cloud.ts`);
 * - deployment-conditional routes a static const cannot honestly promise —
 *   `blob-upload`, whose handlers mount only when the declaration carries
 *   `blobs.presigned` (the `CLOUD_CAPABILITIES.blobsPresigned` route
 *   mount in `cloud.ts`);
 * - flags with no kernel implementation at all — `dispatch-selection`,
 *   `provider-profile-binding`.
 *
 * `task.complete.document` needs no entry: wire v3 folded the former
 * `result-document` flag into the baseline, so every peer may send it.
 * `task.approval_resolved` needs none either: wire v4 folded the former
 * `approval_resolved` flag into the baseline.
 *
 * Exact-list drift guard: `packages/cloud/src/__tests__/protocol-capabilities.test.ts`.
 */
export const CLOUD_PROTOCOL_CAPABILITIES = [
  'custom-harness',
  MAILBOX_READ_AHEAD_CAPABILITY,
  'agent-message-draft',
  'agent-home-contract',
  'agent-home-projection',
  'agent-egress-policy',
  'agent-egress-reliable-ack',
  'agent-egress-fresh-session',
  // `handleAgentMessagePublish` accepts `agent.message_egress` gated on exactly
  // this capability (`packages/cloud/src/inbound.ts`) — the same inbound
  // family as the three egress flags above, omitted by the same drift.
  'agent-message-egress',
  'agent-content-workspace-read',
  'agent-content-transcript-read',
  'agent-content-artifact-read',
  // The inbound gate accepts every sealed daemon-to-server type, and the four
  // sealed decline codes on the plaintext decline (#654 E3b-2).
  SEALED_PAYLOAD_CAPABILITY,
  // A sealed terminal or artifact may name its ciphertext blob, which the
  // task holds while it lives (#654 §58a).
  SEALED_OUTPUT_CIPHERTEXT_REF_CAPABILITY,
  // The inbound gate parses `task.fail.failure` on both branches,
  // and `projectTerminalResult` copies it (#869).
  RUNTIME_FAILURE_CLASS_CAPABILITY,
];

export interface EventsRouteDeps extends DeviceRouteDeps {
  readonly activityBounds: import('../coordination').ActivityBounds;
  /** How long an empty poll is held open, ms. */
  readonly longPollHoldMs: number;
  /** Max rows per response. */
  readonly pageLimit: number;
}

export function eventsHandler(deps: EventsRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const authenticated = await authenticateDevice(c, deps);
    if (authenticated === undefined) return c.json({ error: 'unauthorized' }, 401);
    const { device, stores } = authenticated;

    const cursorRaw = c.req.query('cursor');
    let cursor = 0;
    if (cursorRaw !== undefined) {
      const parsedCursor = Number(cursorRaw);
      if (!Number.isSafeInteger(parsedCursor) || parsedCursor < 0) {
        return c.json({ error: 'invalid cursor' }, 400);
      }
      cursor = parsedCursor;
    }

    const afterRaw = c.req.query('afterSeq');
    const afterSeq = afterRaw === undefined ? cursor : Number(afterRaw);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < cursor || afterSeq - cursor > MAILBOX_READ_AHEAD_MAX_SEQS) {
      return c.json({ error: 'invalid read-ahead offset' }, 400);
    }
    const acked = await stores.mailbox.readCursor(device.deviceId);
    if (afterRaw !== undefined && afterSeq > acked.deliveredSeq) return c.json({ error: 'read offset exceeds delivered watermark' }, 409);
    if (cursor > acked.ackedSeq) {
      try {
        await stores.mailbox.advanceCursor({ deviceId: device.deviceId, ackedSeq: cursor });
      } catch (caught) {
        if (isCoreConflictError(caught, 'mailbox_cursor_ahead_of_delivery')) {
          return c.json({ error: 'cursor exceeds delivered watermark' }, 409);
        }
        throw caught;
      }
    }

    const deadline = performance.now() + deps.longPollHoldMs;
    const requestSignal = c.req.raw.signal;
    const subscription = stores.mailbox.watch(device.deviceId, requestSignal);
    try {
      while (!requestSignal.aborted) {
        let scanCursor = afterSeq;
        while (!requestSignal.aborted) {
          const page = await stores.mailbox.readAfter({
            deviceId: device.deviceId,
            afterSeq: scanCursor,
            limit: deps.pageLimit,
          });
          // The replay floor, against the cursor the CALLER brought — never
          // `scanCursor`, which this request moves on its own. Same rule as the
          // old reference server's `assertReplayAvailable`: a caller at
          // `recoverableFrom - 1` can still be handed the first retained row,
          // anything lower has lost rows and must resync rather than silently
          // resume from a partial tail.
          // Evaluated on every read, so a sweep that lands mid-hold ends the hold
          // with the 409 the caller now deserves instead of an empty 200.
          if (cursor < page.recoverableFrom - 1) {
            return c.json({ error: 'cursor_too_old', recoverableFrom: page.recoverableFrom }, 409);
          }
          if (page.messages.length === 0) break;
          const decoded: Envelope[] = page.messages.map((message) => decodeEnvelope(message.body));
          // The protocol's own classifier, not a list restated here: a
          // hand-maintained copy silently stops filtering the day a new
          // task-opening type is registered, and the symptom is a CANCELLED offer
          // still being delivered.
          const offeredTaskIds = decoded.flatMap((event) =>
            event.type === 'task.offer' && event.task_id !== undefined ? [event.task_id] : [],
          );
          const attemptsByTaskId = Object.fromEntries(
            (await stores.tasks.getMany(offeredTaskIds)).map((attempt) => [attempt.taskId, attempt]),
          );
          const events = decoded.filter((event) => {
            if (event.type !== 'task.offer') return true;
            return event.task_id === undefined || attemptsByTaskId[event.task_id]?.cancellation === undefined;
          });
          if (events.length === 0 && page.hasMore) {
            // A cancelled offer can occupy an entire small mailbox page. The
            // daemon advances from delivered envelope seqs, not response.cursor,
            // so returning that empty filtered page would replay it forever and
            // strand the following durable task.cancel. Scan to the next page in
            // this same request without acknowledging anything server-side.
            scanCursor = page.nextSeq;
            continue;
          }
          if (events.length === 0) break;
          const response: EventsPollResponse = {
            events,
            cursor: page.nextSeq,
            capabilities: CLOUD_PROTOCOL_CAPABILITIES,
            ingress: { activityMaxEvents: deps.activityBounds.maxEvents, activityMaxBytes: deps.activityBounds.maxBytes },
          };
          await stores.mailbox.recordDelivery({
            deviceId: device.deviceId,
            deliveredSeq: response.cursor,
          });
          return c.json(response, 200);
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0 || requestSignal.aborted) break;
        await subscription.next(remaining);
      }
    } finally {
      subscription.close();
    }

    const response: EventsPollResponse = {
      events: [],
      cursor: afterSeq,
      capabilities: CLOUD_PROTOCOL_CAPABILITIES,
      ingress: { activityMaxEvents: deps.activityBounds.maxEvents, activityMaxBytes: deps.activityBounds.maxBytes },
    };
    return c.json(response, 200);
  };
}
