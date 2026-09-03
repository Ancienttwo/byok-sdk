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
 *   so an idle daemon is not a busy-loop. The hold is a bounded re-read, not a
 *   registered waiter: a waiter map is exactly the cross-request state a
 *   stateless handler may not keep (S3.5 boxes 14-15), and a second cloud
 *   instance would not see it anyway.
 * - **A lost cursor fails closed.** A cursor below the mailbox's retained
 *   window is answered `409 { error: 'cursor_too_old', recoverableFrom }`, the
 *   same body the reference server returns (`packages/server/src/http.ts:386`)
 *   and the only one the daemon's transport can turn into a resync. Serving
 *   such a caller a 200 would hand it a partial tail it has no way to tell
 *   apart from a complete one.
 */
import type { Context } from 'hono';
import { isCoreConflictError } from '@byok-sdk/core';
import { decodeEnvelope, type Envelope, type EventsPollResponse } from '@byok-sdk/protocol';
import { authenticateDevice, type DeviceRouteDeps } from './shared';

/** Protocol features this cloud build accepts from a long-poll daemon. */
const CLOUD_PROTOCOL_CAPABILITIES = [
  'result-document',
  'agent-home-contract',
  'agent-home-projection',
  'agent-egress-policy',
  'agent-egress-reliable-ack',
  'agent-egress-fresh-session',
  'agent-content-workspace-read',
  'agent-content-transcript-read',
  'agent-content-artifact-read',
];

export interface EventsRouteDeps extends DeviceRouteDeps {
  /** How long an empty poll is held open, ms. */
  readonly longPollHoldMs: number;
  /** How often the mailbox is re-read while holding, ms. */
  readonly longPollIntervalMs: number;
  /** Max rows per response. */
  readonly pageLimit: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    const acked = await stores.mailbox.readCursor(device.deviceId);
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

    const attempts = Math.max(1, Math.ceil(deps.longPollHoldMs / deps.longPollIntervalMs));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let scanCursor = cursor;
      while (true) {
        const page = await stores.mailbox.readAfter({
          deviceId: device.deviceId,
          afterSeq: scanCursor,
          limit: deps.pageLimit,
        });
        // The replay floor, against the cursor the CALLER brought — never
        // `scanCursor`, which this request moves on its own. Same rule as the
        // reference server's `assertReplayAvailable`
        // (`packages/server/src/hub.ts:2519`): a caller at `recoverableFrom - 1`
        // can still be handed the first retained row, anything lower has lost
        // rows and must resync rather than silently resume from a partial tail.
        // Evaluated on every read, so a sweep that lands mid-hold ends the hold
        // with the 409 the caller now deserves instead of an empty 200.
        if (cursor < page.recoverableFrom - 1) {
          return c.json({ error: 'cursor_too_old', recoverableFrom: page.recoverableFrom }, 409);
        }
        if (page.messages.length === 0) break;
        const decoded: Envelope[] = page.messages.map((message) => decodeEnvelope(message.body));
        const offeredTaskIds = decoded.flatMap((event) =>
          (event.type === 'task.offer' ||
            event.type === 'task.offer_with_toolsets' ||
            event.type === 'task.offer_for_agent' ||
            event.type === 'task.offer_for_agent_with_egress' ||
            event.type === 'task.offer_for_agent_with_egress_fresh') &&
          event.task_id !== undefined
            ? [event.task_id]
            : [],
        );
        const attemptsByTaskId = Object.fromEntries(
          (await stores.tasks.getMany(offeredTaskIds)).map((attempt) => [attempt.taskId, attempt]),
        );
        const events = decoded.filter((event) => {
          if (
            event.type !== 'task.offer' &&
            event.type !== 'task.offer_with_toolsets' &&
            event.type !== 'task.offer_for_agent' &&
            event.type !== 'task.offer_for_agent_with_egress' &&
            event.type !== 'task.offer_for_agent_with_egress_fresh'
          ) {
            return true;
          }
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
        };
        await stores.mailbox.recordDelivery({
          deviceId: device.deviceId,
          deliveredSeq: response.cursor,
        });
        return c.json(response, 200);
      }
      if (attempt < attempts - 1) await sleep(deps.longPollIntervalMs);
    }

    const response: EventsPollResponse = {
      events: [],
      cursor,
      capabilities: CLOUD_PROTOCOL_CAPABILITIES,
    };
    return c.json(response, 200);
  };
}
