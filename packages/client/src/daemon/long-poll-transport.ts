import {
  BYOK_EVENTS_PATH,
  BYOK_MESSAGES_PATH,
  MESSAGE_TYPES,
  MessagesSendResponseSchema,
  parseMessage,
  type Envelope,
  type MessagesSendResponse,
} from '@byok-sdk/protocol';
import { AuthManager, DeviceRevokedError } from './auth-manager';
import { authedFetch } from './http-client';
import { ReplayCursorTooOldError } from './replay-cursor';
import { describeEndpoint, toHttpBase, type TransportEndpoint } from './url';

/**
 * A long-poll request failed in a way that today told the caller only
 * `false`/"retry in 2s" — this names WHICH of the transport's two routes it
 * was and what the server said, so a stuck fallback loop is diagnosable
 * without a packet capture.
 *
 * Scope (review finding — honest attribution): this type represents ONLY an
 * actual route request/response cycle failing. Anything that happens BEFORE
 * the request exists — in practice credential acquisition
 * (`AuthManager.getValidAccessToken`) — is not a route failure and is never
 * reported as one; neither is {@link DeviceRevokedError}, which is a device
 * lifecycle fact rather than something the route did. See
 * `LongPollClient.loop`/`postBatch` for where that boundary is drawn.
 *
 * `status` is the HTTP status of the response the route produced, INCLUDING
 * the case where the response arrived intact and its body then failed to read
 * or parse (a 200 whose payload is malformed is still a 200 — the parse error
 * rides in `cause`). `undefined` means no response was ever produced: the
 * `fetch` itself rejected (DNS/TLS/connection failure, abort). The underlying
 * error is kept in `cause` rather than flattened into the message, so nothing
 * about the original failure is lost.
 */
export class LongPollRouteError extends Error {
  constructor(
    public readonly endpoint: TransportEndpoint,
    public readonly status: number | undefined,
    cause: unknown,
  ) {
    super(
      status === undefined
        ? `long-poll ${endpoint.host}${endpoint.path} failed`
        : `long-poll ${endpoint.host}${endpoint.path} failed with HTTP ${status}`,
      { cause },
    );
    this.name = 'LongPollRouteError';
  }
}

export interface LongPollClientOptions {
  serverUrl: string;
  auth: AuthManager;
  getCursor: () => number | undefined;
  /** Returns false when the envelope was a local duplicate and no handler was queued. */
  onEnvelope: (envelope: Envelope) => boolean | void;
  /**
   * Capabilities advertised by the server that produced the current poll
   * response. Called before any envelopes from that response are delivered.
   * An older responder omitting the additive field is reported as `[]`.
   */
  onServerCapabilities?: (capabilities: string[]) => void;
  /** Called when a failed poll invalidates the preceding response's capability snapshot. */
  onServerCapabilitiesInvalidated?: () => void;
  /** Called after a poll fails and before the retry delay begins. */
  onPollFailure?: () => void;
  /** Called once the device is found to be revoked (401 surfaced through {@link AuthManager}) — the loop stops itself rather than retrying. */
  onRevoked?: () => void;
  /** Called when the server cannot replay the durable cursor supplied to this poll. */
  onReplayCursorTooOld?: (error: ReplayCursorTooOldError) => void;
  /** Unknown or malformed executable messages have no durable disposition.
   * Freeze their sequence; a later valid message must not acknowledge them.
   */
  onValidationFailedSeq?: (seq: number) => void;
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
  /** Backoff between failed poll attempts (network/HTTP errors), stalled cycles, and duplicate-only cycles that made no cursor progress. The reference server holds a genuinely idle request open ~50s itself (protocol §8). Default 2s. */
  retryDelayMs?: number;
  /** Deterministic delay authority for automatic failed/stalled cycles. */
  retryDelayForAttempt?: (attempt: number, baseDelayMs: number) => number;
  onOperationalOutcome?: (outcome: 'success' | 'failure') => void;
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
  capabilities: string[];
}

/** A fully-read frozen-v1 count acknowledgement for the batch that was posted. */
export interface MessageBatchPostResult {
  readonly accepted: number;
  readonly rejected?: number;
}

/** Finding R1: soft cap on `LongPollClient`'s own `warnedValidationFailureSeqs` bookkeeping — see that field's own doc comment for why this is a simple "clear outright" reset rather than an eviction policy: a rare/pathological path, not a hot one. */
const MAX_TRACKED_VALIDATION_FAILURE_WARNINGS = 1000;

/** Same soft-cap discipline as {@link MAX_TRACKED_VALIDATION_FAILURE_WARNINGS}, for `warnedRouteFailures` — see that field's own doc comment. */
const MAX_TRACKED_ROUTE_FAILURE_WARNINGS = 1000;

/**
 * M4 Phase 4 (version-negotiation drill fix): validates ONLY the OUTER shape
 * of a `/byok/events` response — `events` is an array of not-yet-validated
 * entries, `cursor` is an integer. Deliberately does NOT validate each
 * entry against the frozen `EnvelopeSchema` here the way the protocol
 * package's own `EventsPollResponseSchema` (`z.array(EnvelopeSchema)`)
 * used to be applied in one shot: that meant a SINGLE unrecognized-type
 * entry anywhere in the batch failed the ENTIRE `.parse()` call, silently
 * discarding every other, otherwise-valid entry right alongside it. Each
 * entry is now validated individually, right where it's consumed
 * (`LongPollClient.loop`, below), via `parseMessage`.
 */
function parseLooseEventsPollResponse(raw: unknown, requestedCursor: number): LooseEventsPollResponse {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('events poll response is not an object');
  }
  const { events, cursor, capabilities } = raw as {
    events?: unknown;
    cursor?: unknown;
    capabilities?: unknown;
  };
  if (!Array.isArray(events)) {
    throw new Error('events poll response.events is not an array');
  }
  if (!isSafeNonnegativeInteger(cursor)) {
    throw new Error('events poll response.cursor is not a safe nonnegative integer');
  }
  if (cursor < requestedCursor) {
    throw new Error('events poll response.cursor regressed below the requested cursor');
  }
  if (
    capabilities !== undefined &&
    (!Array.isArray(capabilities) || capabilities.some((flag) => typeof flag !== 'string'))
  ) {
    throw new Error('events poll response.capabilities is not an array of strings');
  }
  return { events, cursor, capabilities: capabilities ?? [] };
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateTrustedEventsPage(events: readonly unknown[], requestedCursor: number, pageCursor: number): void {
  let previousTaskSeq: number | undefined;
  for (const raw of events) {
    if (typeof raw !== 'object' || raw === null) throw new Error('events page contains an unidentifiable message');
    const { type, seq } = raw as { type?: unknown; seq?: unknown };
    if (typeof type !== 'string') throw new Error('events page message has no authoritative type');
    if (type.startsWith('conn.')) continue;
    if (!isSafeNonnegativeInteger(seq)) {
      throw new Error('events poll task seq is not a safe nonnegative integer');
    }
    if (seq <= requestedCursor || seq > pageCursor) {
      throw new Error('events poll task seq lies outside the trusted page cursor range');
    }
    if (previousTaskSeq !== undefined && seq <= previousTaskSeq) {
      throw new Error('events poll task seq is not strictly page ordered');
    }
    const knownTaskType = (MESSAGE_TYPES as readonly string[]).includes(type);
    const predecessor = previousTaskSeq ?? requestedCursor;
    if (!knownTaskType && seq !== predecessor + 1) {
      throw new Error('events poll unknown task seq would cross an untrusted gap');
    }
    previousTaskSeq = seq;
  }
}

/** Only validated non-connection sequences can hold the durable cursor. */
function extractExecutableSeq(raw: unknown): number | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { type, seq } = raw as { type?: unknown; seq?: unknown };
  if (typeof type !== 'string' || type.startsWith('conn.')) return undefined;
  return isSafeNonnegativeInteger(seq) ? seq : undefined;
}

/**
 * Protocol §8 long-poll transport: `GET /byok/events?cursor=N` in a loop,
 * plus `POST /byok/messages` for the daemon's own outbound envelopes
 * (finding F6 — long-poll is a full transport, not receive-only: see
 * docs/protocol.md §8).
 *
 * Design B (finding N4): this is a stateless drainer; it holds no outbound
 * queue of its own. `ConnectionManager` owns the single shared outbox;
 * `postBatch` is a single POST attempt, reporting only frozen-v1 accepted and
 * rejected counts after its response body has been read and validated. All
 * retry/backoff and rejection isolation policy lives in the caller
 * (`ConnectionManager.drainOutbox`).
 */
export class LongPollClient {
  private running = false;
  /** Owns exactly one active loop generation, including its held GET and retry delays. */
  private loopAbortController: AbortController | undefined;
  /**
   * Finding R1: seqs this loop has already `console.warn`'d about for a
   * validation-failed (recognized-type, invalid-payload) entry — a poison
   * entry is redelivered on every poll cycle for as long as it stalls the
   * cursor (protocol §9), so without this the SAME warning would repeat
   * every ~poll-interval, forever, for one persistently-malformed message.
   * Never cleared: once a seq is fixed (a corrected redelivery is
   * processed), the server never redelivers that seq again, so there is
   * nothing left to re-warn about for it either. Soft-capped — this is a
   * pathological/rare path (unlike a per-task hot structure), so on the
   * rare chance a connection somehow accumulates an unreasonable number of
   * distinct poisoned seqs, this is simply cleared outright (accepting a
   * handful of possible re-warnings) rather than carrying any per-entry
   * eviction bookkeeping for a case this unlikely.
   */
  private readonly warnedValidationFailureSeqs = new Set<number>();
  /**
   * `path:status` keys this loop has already warned about — same one-warn-per-key
   * discipline (and same rare-path soft-cap reset) as
   * {@link warnedValidationFailureSeqs}, and for the same reason: an
   * unreachable or misconfigured route fails again every `retryDelayMs` (2s
   * by default) for as long as the fallback is engaged, so an unguarded warn
   * would bury every other line in the log within a minute. Keyed by route
   * AND status so a route that starts failing differently (503 -> 401) still
   * warns once for the new condition.
   */
  private readonly warnedRouteFailures = new Set<string>();
  /**
   * Both routes this transport can fail against, built once (see
   * {@link describeEndpoint} for why constructing them in one place is what
   * keeps credentials out of every diagnostic derived from them).
   */
  private readonly eventsEndpoint: TransportEndpoint;
  private readonly messagesEndpoint: TransportEndpoint;

  constructor(private readonly opts: LongPollClientOptions) {
    const base = toHttpBase(opts.serverUrl);
    this.eventsEndpoint = describeEndpoint('long-poll', new URL(BYOK_EVENTS_PATH, base));
    this.messagesEndpoint = describeEndpoint('long-poll', new URL(BYOK_MESSAGES_PATH, base));
  }

  /**
   * One warn per `path:status`, carrying the typed {@link LongPollRouteError}
   * as the second argument so a caller inspecting the log (or a test) reads
   * the route off the error rather than re-parsing the message.
   */
  private warnRouteFailure(endpoint: TransportEndpoint, status: number | undefined, cause: unknown): void {
    const key = `${endpoint.path}:${status ?? 'no-response'}`;
    if (this.warnedRouteFailures.has(key)) return;
    if (this.warnedRouteFailures.size > MAX_TRACKED_ROUTE_FAILURE_WARNINGS) {
      this.warnedRouteFailures.clear(); // see this Set's own doc comment — a rare-path reset, not a hot one
    }
    this.warnedRouteFailures.add(key);
    const error = new LongPollRouteError(endpoint, status, cause);
    console.warn(`[byok/client] ${error.message}`, error);
  }

  /**
   * {@link DeviceRevokedError} is a device lifecycle fact, not a route
   * failure: it stops this loop outright (retrying cannot help) and is
   * deliberately reported through `onRevoked` ONLY — never additionally as a
   * {@link LongPollRouteError}. Returns whether the error was that case, so
   * each call site can skip its route-failure warn for it.
   */
  private noteRevoked(err: unknown): boolean {
    if (!(err instanceof DeviceRevokedError)) return false;
    this.running = false;
    this.loopAbortController?.abort();
    this.opts.onRevoked?.();
    return true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const controller = new AbortController();
    this.loopAbortController = controller;
    void this.loop(controller.signal).finally(() => {
      if (this.loopAbortController === controller) this.loopAbortController = undefined;
    });
  }

  stop(): void {
    this.running = false;
    this.loopAbortController?.abort();
  }

  /**
   * POST one batch of envelopes to `/byok/messages` (finding F6/protocol
   * §8.2) — a single attempt, no internal retry loop. Every envelope in
   * `envelopes` is routed through the server's single inbound gate
   * (`ConnectionHub.handleInbound`), so a resend of the SAME batch (same
   * envelope `id`s — the caller must never rebuild them) is deduped
   * server-side into a safe no-op rather than reprocessed (§9). Returns
   * validated frozen-v1 counts only after a readable response body.
   */
  async postBatch(envelopes: Envelope[]): Promise<MessageBatchPostResult | undefined> {
    // Phase 1 — credentials. This happens BEFORE the route request exists, so
    // its failure can never be attributed to `/byok/messages`. Pre-flighting
    // the token here (rather than letting `authedFetch`'s own identical call
    // be the first one) costs no extra round-trip: `getValidAccessToken` is
    // idempotent and shares one in-flight renewal promise, so the call inside
    // `authedFetch` below resolves from the same result.
    try {
      await this.opts.auth.getValidAccessToken();
    } catch (err) {
      this.noteRevoked(err);
      return undefined;
    }

    // Phase 2 — the route request/response cycle. Only failures from here on
    // are {@link LongPollRouteError}s.
    let res: Response;
    try {
      const base = toHttpBase(this.opts.serverUrl);
      res = await authedFetch(
        new URL(BYOK_MESSAGES_PATH, base),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: envelopes }),
        },
        this.opts.auth,
      );
    } catch (err) {
      // No response was ever produced (the `fetch` itself rejected) — the one
      // case where `status: undefined` is structurally true.
      if (!this.noteRevoked(err)) this.warnRouteFailure(this.messagesEndpoint, undefined, err);
      return undefined;
    }
    if (!res.ok) {
      this.warnRouteFailure(this.messagesEndpoint, res.status, undefined);
      return undefined;
    }
    try {
      const response = MessagesSendResponseSchema.parse(await res.json());
      if (response.accepted + (response.rejected ?? 0) !== envelopes.length) {
        throw new Error('messages response counts do not match the posted batch length');
      }
      return response;
    } catch (err) {
      // The response DID exist and the server DID accept the request line —
      // it is its body that is unusable, so this carries that response's own
      // status with the read/parse error in `cause`.
      this.warnRouteFailure(this.messagesEndpoint, res.status, err);
      return undefined;
    }
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let retryAttempt = 0;
    while (this.running && !signal.aborted) {
      try {
        // Phase 1 — credentials. A failure here happens BEFORE any request to
        // `/byok/events` is made, so it is NOT a route failure and must not be
        // reported as one (it falls through to the outer catch, which only
        // backs off). Pre-flighting the token here rather than letting
        // `authedFetch` be the first caller costs no extra round-trip:
        // `getValidAccessToken` is idempotent and shares one in-flight renewal
        // promise, so `authedFetch`'s own call below resolves from the same
        // result. It exists purely to mark where the route request begins.
        await this.opts.auth.getValidAccessToken();

        const base = toHttpBase(this.opts.serverUrl);
        const url = new URL(BYOK_EVENTS_PATH, base);
        const cursor = this.opts.getCursor();
        if (cursor !== undefined) url.searchParams.set('cursor', String(cursor));

        // Phase 2 — the route request/response cycle. Only failures from here
        // on are {@link LongPollRouteError}s.
        let res: Response;
        try {
          res = await authedFetch(url, { method: 'GET', signal }, this.opts.auth);
        } catch (err) {
          // `stop()` owns this abort. It is lifecycle completion, not a route
          // outage, so it must not warn or publish an operational failure.
          if (signal.aborted) return;
          // No response was ever produced (the `fetch` itself rejected) — the
          // one case where `status: undefined` is structurally true.
          if (!(err instanceof DeviceRevokedError)) {
            this.warnRouteFailure(this.eventsEndpoint, undefined, err);
          }
          throw err;
        }
        if (!res.ok) {
          const replayCursorTooOld = await parseReplayCursorTooOld(res);
          if (replayCursorTooOld) {
            this.running = false;
            this.opts.onReplayCursorTooOld?.(replayCursorTooOld);
            return;
          }
          this.warnRouteFailure(this.eventsEndpoint, res.status, undefined);
          // Long-poll has no persistent peer identity: a failed request no
          // longer proves that the responder behind the NEXT request supports
          // what the last successful one advertised. Match WS disconnect
          // discipline and withdraw the advertisement immediately.
          this.opts.onServerCapabilitiesInvalidated?.();
          this.opts.onPollFailure?.();
          this.opts.onOperationalOutcome?.('failure');
          const baseMs = this.opts.retryDelayMs ?? 2000;
          await sleep(this.opts.retryDelayForAttempt?.(retryAttempt++, baseMs) ?? baseMs, signal);
          continue;
        }

        // Validate each executable envelope independently. Both unknown types
        // and invalid payloads freeze their sequence; neither has a durable
        // disposition that would authorize acknowledging it.
        let parsed: LooseEventsPollResponse;
        try {
          parsed = parseLooseEventsPollResponse(await res.json(), cursor ?? 0);
          validateTrustedEventsPage(parsed.events, cursor ?? 0, parsed.cursor);
        } catch (err) {
          // The response DID exist (and was a success status) — it is its body
          // that is unusable. Carrying `res.status` here rather than
          // `undefined` is what keeps this from reading as "the request never
          // got a response"; the parse error itself rides in `cause`.
          this.warnRouteFailure(this.eventsEndpoint, res.status, err);
          throw err;
        }
        this.opts.onServerCapabilities?.(parsed.capabilities);
        // Finding R1 (Codex's new P2): true the moment THIS batch contains
        // at least one validation-failed entry — used below to apply the
        // stalled backoff on the VERY SAME cycle the failure is first
        // discovered. `onValidationFailedSeq` chains its own `stalledAtSeq`
        // mutation onto `ConnectionManager`'s FIFO `processingChain` (it
        // must — see that method's own doc comment for why a synchronous
        // mutation here would race an earlier still-in-flight envelope in
        // the same batch), so `this.opts.isStalled?.()` read synchronously,
        // right here, would NOT yet reflect a failure `onValidationFailedSeq`
        // was JUST called for a moment earlier in this same for-loop — a
        // real hot-loop risk (this cycle's own failure would only show up
        // in `isStalled()` starting from the NEXT cycle) without this local
        // flag closing that one-cycle gap.
        let hadValidationFailureThisBatch = false;
        let acceptedAnyEntry = false;
        for (const raw of parsed.events) {
          let envelope: Envelope;
          try {
            envelope = parseMessage(raw);
          } catch (err) {
            const failedSeq = extractExecutableSeq(raw);
            if (failedSeq !== undefined) {
              hadValidationFailureThisBatch = true;
              this.opts.onValidationFailedSeq?.(failedSeq);
              if (!this.warnedValidationFailureSeqs.has(failedSeq)) {
                if (this.warnedValidationFailureSeqs.size > MAX_TRACKED_VALIDATION_FAILURE_WARNINGS) this.warnedValidationFailureSeqs.clear();
                this.warnedValidationFailureSeqs.add(failedSeq);
                console.warn(`[byok/client] long-poll: unknown or invalid executable message at seq=${failedSeq}; cursor frozen without durable disposition`, err);
              }
            }
            continue;
          }
          if (this.opts.onEnvelope(envelope) !== false) acceptedAnyEntry = true;
        }

        if (parsed.events.length === 0) {
          retryAttempt = 0;
          this.opts.onOperationalOutcome?.('success');
          await sleep(this.opts.idleDelayMs ?? 250, signal);
        } else if (
          this.opts.isStalled?.() ||
          hadValidationFailureThisBatch ||
          (!acceptedAnyEntry && this.opts.getCursor() === cursor)
        ) {
          // Finding P2 (Fix 2a) / R1: a non-empty batch while stalled (or
          // one that just NOW triggered the stall — see
          // `hadValidationFailureThisBatch`'s own doc comment for why that
          // local flag is needed on top of `isStalled()`) means this cycle
          // made no real cursor progress — apply the same backoff a failed
          // HTTP attempt gets, instead of looping back immediately at RTT.
          this.opts.onOperationalOutcome?.('failure');
          const baseMs = this.opts.retryDelayMs ?? 2000;
          await sleep(this.opts.retryDelayForAttempt?.(retryAttempt++, baseMs) ?? baseMs, signal);
        } else {
          retryAttempt = 0;
          this.opts.onOperationalOutcome?.('success');
        }
      } catch (err) {
        // Whichever phase failed has already warned (or deliberately not
        // warned) with its own accurate attribution — this block is only the
        // shared "withdraw capabilities, then stop or back off" tail. It never
        // warns itself: it cannot tell a route failure apart from a credential
        // failure or a throwing `onEnvelope` handler, and guessing is exactly
        // the mis-attribution this split removed.
        this.opts.onServerCapabilitiesInvalidated?.();
        if (this.noteRevoked(err)) return;
        if (!this.running || signal.aborted) return;
        this.opts.onPollFailure?.();
        this.opts.onOperationalOutcome?.('failure');
        const baseMs = this.opts.retryDelayMs ?? 2000;
        await sleep(this.opts.retryDelayForAttempt?.(retryAttempt++, baseMs) ?? baseMs, signal);
      }
    }
  }
}

async function parseReplayCursorTooOld(res: Response): Promise<ReplayCursorTooOldError | undefined> {
  if (res.status !== 409) return undefined;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const { error, recoverableFrom } = body as { error?: unknown; recoverableFrom?: unknown };
  if (
    error !== 'cursor_too_old' ||
    typeof recoverableFrom !== 'number' ||
    !Number.isSafeInteger(recoverableFrom) ||
    recoverableFrom < 0
  ) {
    return undefined;
  }
  return new ReplayCursorTooOldError(recoverableFrom);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}
