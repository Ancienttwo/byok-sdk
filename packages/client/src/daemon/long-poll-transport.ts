import { MessagesSendResponseSchema, parseMessage, type Envelope } from '@byok/protocol';
import { AuthManager, DeviceRevokedError } from './auth-manager';
import { authedFetch } from './http-client';
import { toHttpBase } from './url';

export interface LongPollClientOptions {
  serverUrl: string;
  auth: AuthManager;
  getCursor: () => number | undefined;
  onEnvelope: (envelope: Envelope) => void;
  /** Called once the device is found to be revoked (401 surfaced through {@link AuthManager}) — the loop stops itself rather than retrying. */
  onRevoked?: () => void;
  /**
   * M4 Phase 4 (version-negotiation drill fix): called for a batch entry
   * that could not be parsed into a known `Envelope` at all (an
   * unrecognized message type — mirrors `ws-transport.ts`'s identical
   * per-frame tolerance) but still carries a numeric envelope-level `seq`
   * AND a recognizably task-class `type` (a `task.` prefix — see
   * `extractSkippableSeq`'s own doc comment for why a `conn.*`-shaped or
   * type-less entry is deliberately excluded, mirroring F2's "conn.* is
   * never cursor-tracked" rule), so the caller can advance its
   * cursor/watermark past it even though there is no real `Envelope` to
   * hand to `onEnvelope`. Without this, a persistently-redelivered
   * unrecognized-type entry (the real server retains and redelivers an
   * un-acked envelope, protocol §9) would keep reappearing at the same
   * cursor position forever. Optional only for constructor/test
   * convenience — `ConnectionManager` always supplies it.
   */
  onSkippedSeq?: (seq: number) => void;
  /**
   * Finding P2 (Fix 2a): true while a `task.*` envelope's handler has failed
   * and hasn't yet been successfully reprocessed
   * (`ConnectionManager.stalledAtSeq`). While true, `getCursor()` stays
   * frozen below the actual delivery watermark (see
   * `ConnectionManager.dedupWatermark`'s own doc comment) — so a non-empty
   * response here doesn't mean "new events arrived", it can just as well
   * mean "the whole post-cursor backlog got re-pulled again with no
   * progress". Without a backoff for that case (distinct from "zero
   * events"), a persistently-failing handler made this loop spin at RTT
   * against the server. Optional only for constructor/test convenience —
   * `ConnectionManager` always supplies it.
   */
  isStalled?: () => boolean;
  /** Backoff between failed poll attempts (network/HTTP errors), AND between cycles that made no cursor progress while stalled (finding P2/Fix 2a — see {@link isStalled}). The reference server holds each successful, non-stalled request open ~50s itself (protocol §8), so this only matters when a request errors outright or is stalled. Default 2s. */
  retryDelayMs?: number;
  /**
   * Minimum delay before the next request when a poll comes back with zero
   * events. The reference server holds each request open ~50s waiting for
   * something to happen, which throttles the loop for free; a server that
   * (like this SDK's own test stub) responds immediately instead would
   * otherwise make this a tight busy-loop. Default 250ms.
   */
  idleDelayMs?: number;
}

interface LooseEventsPollResponse {
  /** Raw, not-yet-validated entries — see `parseLooseEventsPollResponse`'s own doc comment for why each is validated individually, not as one array. */
  events: unknown[];
  cursor: number;
}

/**
 * M4 Phase 4 (version-negotiation drill fix): validates ONLY the OUTER shape
 * of a `/byok/events` response — `events` is an array of not-yet-validated
 * entries, `cursor` is an integer. Deliberately does NOT validate each
 * entry against the frozen `EnvelopeSchema` here the way the protocol
 * package's own `EventsPollResponseSchema` (`z.array(EnvelopeSchema)`)
 * used to be applied in one shot: that meant a SINGLE unrecognized-type
 * entry anywhere in the batch failed the ENTIRE `.parse()` call, silently
 * discarding every other, otherwise-valid entry right alongside it — a real
 * forward-compat gap the WS transport never had (`ws-transport.ts` decodes
 * and dispatches one frame at a time). Each entry is now validated
 * individually, right where it's consumed (`LongPollClient.loop`, below),
 * via `parseMessage` — the SAME per-message validator `decodeEnvelope`
 * (ws-transport.ts's own per-frame decode) calls internally — so the two
 * transports draw from one shared notion of "valid" and cannot drift apart
 * on it again.
 */
function parseLooseEventsPollResponse(raw: unknown): LooseEventsPollResponse {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('events poll response is not an object');
  }
  const { events, cursor } = raw as { events?: unknown; cursor?: unknown };
  if (!Array.isArray(events)) {
    throw new Error('events poll response.events is not an array');
  }
  if (typeof cursor !== 'number' || !Number.isInteger(cursor)) {
    throw new Error('events poll response.cursor is not an integer');
  }
  return { events, cursor };
}

/**
 * M4 Phase 4 (gatekeeper MEDIUM advisory): a numeric envelope-level `seq`
 * opportunistically read off a batch entry that failed `parseMessage` — but
 * ONLY when the entry's own `type` string also looks task-shaped (a
 * `task.` prefix), mirroring `ConnectionManager`'s own (unexported)
 * `isTaskEnvelopeType` distinction. Finding F2 documents that `conn.*` types
 * are NEVER cursor-tracked, even when perfectly well-formed — there is no
 * way to tell a hypothetical future `conn.something` type apart from that
 * rule from raw shape alone, so a skipped entry that isn't recognizably
 * task-class (wrong prefix, or no `type`/`seq` at all) must not be allowed
 * to touch the cursor either. `undefined` whenever the entry doesn't
 * qualify — used only to feed `onSkippedSeq`, never to treat the entry as
 * processable.
 */
function extractSkippableSeq(raw: unknown): number | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { type, seq } = raw as { type?: unknown; seq?: unknown };
  if (typeof type !== 'string' || !type.startsWith('task.')) return undefined;
  return typeof seq === 'number' && Number.isInteger(seq) ? seq : undefined;
}

/**
 * Protocol §8 long-poll fallback: `GET /byok/events?cursor=N` in a loop,
 * used while WS connectivity is unavailable (see `ConnectionManager`), plus
 * `POST /byok/messages` for the daemon's own outbound envelopes while in
 * this mode (finding F6 — long-poll is a full transport, not receive-only:
 * see docs/protocol.md §8).
 *
 * Design B (finding N4): this is a stateless drainer, symmetric with
 * `WsTransport.sendNow` — it holds no outbound queue of its own.
 * `ConnectionManager` owns the single shared outbox both transports drain
 * from (so a transport switch never strands a queued envelope);
 * `postBatch` is a single POST attempt, reporting back whether the server
 * accepted it. All retry/backoff policy (and re-checking which transport is
 * currently active) lives in the caller (`ConnectionManager.drainOutbox`).
 */
export class LongPollClient {
  private running = false;

  constructor(private readonly opts: LongPollClientOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  /**
   * POST one batch of envelopes to `/byok/messages` (finding F6/protocol
   * §8.2) — a single attempt, no internal retry loop. Every envelope in
   * `envelopes` is routed through the server's single inbound gate
   * (`ConnectionHub.handleInbound`), so a resend of the SAME batch (same
   * envelope `id`s — the caller must never rebuild them) is deduped
   * server-side into a safe no-op rather than reprocessed (§9). Returns
   * `true` once the server has accepted the batch.
   */
  async postBatch(envelopes: Envelope[]): Promise<boolean> {
    try {
      const base = toHttpBase(this.opts.serverUrl);
      const res = await authedFetch(
        new URL('/byok/messages', base),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: envelopes }),
        },
        this.opts.auth,
      );
      if (!res.ok) return false;
      MessagesSendResponseSchema.parse(await res.json());
      return true;
    } catch (err) {
      if (err instanceof DeviceRevokedError) {
        this.running = false;
        this.opts.onRevoked?.();
      }
      return false;
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const base = toHttpBase(this.opts.serverUrl);
        const url = new URL('/byok/events', base);
        const cursor = this.opts.getCursor();
        if (cursor !== undefined) url.searchParams.set('cursor', String(cursor));

        const res = await authedFetch(url, { method: 'GET' }, this.opts.auth);
        if (!res.ok) {
          await sleep(this.opts.retryDelayMs ?? 2000);
          continue;
        }

        // Finding F3-on-long-poll: each polled envelope flows through
        // `ConnectionManager.deliver()`/`process()` exactly like a WS-pushed
        // one — no eager batch-level cursor advance here. The durable
        // cursor now only ever advances AFTER a `task.*` handler's side
        // effects resolve successfully (see `ConnectionManager.process`),
        // identically on both transports; `parsed.cursor` (the server's own
        // batch high-water) is intentionally not consulted for that — the
        // client tracks its own delivery/dedup watermark instead (Design A).
        //
        // M4 Phase 4 (version-negotiation drill fix): the outer shape
        // (`events` array + `cursor`) is validated loosely; each entry is
        // then validated INDIVIDUALLY via `parseMessage` — mirrors
        // `ws-transport.ts`'s identical per-frame tolerance (see
        // `parseLooseEventsPollResponse`'s own doc comment for the full
        // rationale). An entry that fails for ANY reason — an unrecognized
        // message type (`UnknownMessageTypeError`) or a recognized type
        // with a malformed/invalid payload (`EnvelopeValidationError`) — is
        // silently skipped, exactly as `ws-transport.ts`'s own blanket
        // `catch {}` treats both identically; it never fails the rest of
        // the batch. A skipped entry that's recognizably task-class (see
        // `extractSkippableSeq`'s own doc comment for why `conn.*`-shaped
        // or type-less entries are excluded) and still carries a numeric
        // `seq` still advances the cursor/watermark past it
        // (`onSkippedSeq`), so a persistently-redelivered unparseable entry
        // can never stall this device's progress.
        const parsed = parseLooseEventsPollResponse(await res.json());
        for (const raw of parsed.events) {
          let envelope: Envelope;
          try {
            envelope = parseMessage(raw);
          } catch {
            const skippableSeq = extractSkippableSeq(raw);
            if (skippableSeq !== undefined) this.opts.onSkippedSeq?.(skippableSeq);
            continue;
          }
          this.opts.onEnvelope(envelope);
        }

        if (parsed.events.length === 0) {
          await sleep(this.opts.idleDelayMs ?? 250);
        } else if (this.opts.isStalled?.()) {
          // Finding P2 (Fix 2a): a non-empty batch while stalled means this
          // cycle just re-pulled the whole post-cursor backlog again
          // without making any cursor progress — apply the same backoff a
          // failed HTTP attempt gets, instead of looping back immediately
          // at RTT (see `isStalled`'s own doc comment).
          await sleep(this.opts.retryDelayMs ?? 2000);
        }
      } catch (err) {
        if (err instanceof DeviceRevokedError) {
          this.running = false;
          this.opts.onRevoked?.();
          return;
        }
        if (!this.running) return;
        await sleep(this.opts.retryDelayMs ?? 2000);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
