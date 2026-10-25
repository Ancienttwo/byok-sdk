import {
  type ActivityIngress,
  BYOK_EVENTS_PATH,
  EventsPollResponseSchema,
  MAILBOX_READ_AHEAD_CAPABILITY,
  MAILBOX_READ_AHEAD_MAX_SEQS,
  BYOK_MESSAGES_PATH,
  MESSAGE_TYPES,
  MessagesSendResponseSchema,
  parseMessage,
  type Envelope,
  type EventsPollResponse,
  type OutboundRefusalReason,
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
  /** The activity ingress every events page advertises, applied before its envelopes are delivered. */
  onIngress?: (ingress: ActivityIngress) => void;
  /**
   * Capabilities advertised by the server that produced the current poll
   * response. Called before any envelopes from that response are delivered.
   */
  onServerCapabilities?: (capabilities: string[]) => void;
  /**
   * The poll failed — an HTTP status, a network failure, an unusable body or
   * a credential failure. This loop generation has ended and does not retry:
   * the caller's reconnect loop owns that (it handshakes again first).
   */
  onLoopFailure?: () => void;
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
  /** Backoff for stalled cycles and duplicate-only cycles that made no cursor progress, and for a full read-ahead window. The reference server holds a genuinely idle request open ~50s itself (protocol §8). Default 2s. */
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

/** One posted envelope's validated v3 outcome: a rejection always carries its reason. */
export type CorrelatedOutcome =
  | { readonly id: string; readonly outcome: 'accepted' | 'duplicate' }
  | { readonly id: string; readonly outcome: 'rejected'; readonly reason: OutboundRefusalReason };

/**
 * A validated v3 acknowledgement for the posted batch: one outcome per posted
 * envelope, a reason on every rejected one, and `ingress` whenever a posted
 * `conn.hello` was accepted or deduplicated.
 */
export interface MessageBatchPostResult {
  readonly ingress?: ActivityIngress;
  readonly outcomes: readonly CorrelatedOutcome[];
  readonly accepted: number;
  readonly rejected?: number;
  /** The server's advertisement, when it sent one (a handshake answer); absence means "no update". */
  readonly capabilities?: readonly string[];
}

/** Finding R1: soft cap on `LongPollClient`'s own `warnedValidationFailureSeqs` bookkeeping — see that field's own doc comment for why this is a simple "clear outright" reset rather than an eviction policy: a rare/pathological path, not a hot one. */
const MAX_TRACKED_VALIDATION_FAILURE_WARNINGS = 1000;

/** Same soft-cap discipline as {@link MAX_TRACKED_VALIDATION_FAILURE_WARNINGS}, for `warnedRouteFailures` — see that field's own doc comment. */
const MAX_TRACKED_ROUTE_FAILURE_WARNINGS = 1000;

/**
 * Decodes the outer `/byok/events` page with the protocol's
 * `EventsPollResponseSchema` (#386), whose `events` entries are not yet
 * decoded: each entry is decoded individually where it is consumed
 * (`LongPollClient.loop`), via `parseMessage`, so one unknown or invalid entry
 * stalls only its own sequence. The page cursor is navigation the client
 * trusts only as a safe nonnegative integer that never moves below the
 * requested cursor; those two checks are client-local.
 */
function decodeEventsPage(raw: unknown, requestedCursor: number): EventsPollResponse {
  const page = EventsPollResponseSchema.parse(raw);
  if (!isSafeNonnegativeInteger(page.cursor)) {
    throw new Error('events poll response.cursor is not a safe nonnegative integer');
  }
  if (page.cursor < requestedCursor) {
    throw new Error('events poll response.cursor regressed below the requested cursor');
  }
  return page;
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
 * rejected counts (plus an advertisement, when the server sent one) after its
 * response body has been read and validated. All retry/backoff and rejection
 * isolation policy lives in the caller (`ConnectionManager`).
 *
 * The receive loop likewise never retries a failed poll: one loop generation
 * runs from {@link start} until a failure ({@link LongPollClientOptions.onLoopFailure}),
 * {@link stop}, revocation, or a lost replay cursor.
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
   * `envelopes` is routed through the server's single inbound gate (the
   * cloud kernel's `handleInboundEnvelope`), so a resend of the SAME batch
   * (same envelope `id`s — the caller must never rebuild them) is deduped
   * server-side into a safe no-op rather than reprocessed (§9). Returns the
   * validated per-envelope outcomes only after a readable response body.
   * `signal` aborting is the caller's own lifecycle ending, not a route
   * failure: it resolves `undefined` without a warning.
   */
  async postBatch(envelopes: Envelope[], signal?: AbortSignal): Promise<MessageBatchPostResult | undefined> {
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
          ...(signal === undefined ? {} : { signal }),
        },
        this.opts.auth,
      );
    } catch (err) {
      if (signal?.aborted) return undefined;
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
      const expected = new Map(envelopes.map((envelope) => [envelope.id, envelope]));
      let accepted = 0;
      let rejected = 0;
      let handshakeAccepted = false;
      const outcomes: CorrelatedOutcome[] = [];
      for (const settlement of response.outcomes) {
        const envelope = expected.get(settlement.id);
        if (envelope === undefined) throw new Error('messages response has an unknown or repeated outcome id');
        expected.delete(settlement.id);
        if (settlement.outcome === 'rejected') {
          if (settlement.reason === undefined) throw new Error('messages response rejected outcome lacks its reason');
          rejected += 1;
          outcomes.push({ id: settlement.id, outcome: 'rejected', reason: settlement.reason });
        } else {
          if (settlement.reason !== undefined) throw new Error('messages response reason belongs only to rejected outcomes');
          accepted += 1;
          if (envelope.type === 'conn.hello') handshakeAccepted = true;
          outcomes.push({ id: settlement.id, outcome: settlement.outcome });
        }
      }
      if (expected.size !== 0 || accepted !== response.accepted || rejected !== (response.rejected ?? 0)) {
        throw new Error('messages response outcomes do not match the posted ids and counts');
      }
      if (handshakeAccepted && response.ingress === undefined) {
        throw new Error('messages response accepted conn.hello without the activity ingress advertisement');
      }
      return { ...response, outcomes };
    } catch (err) {
      if (signal?.aborted) return undefined;
      // The response DID exist and the server DID accept the request line —
      // it is its body that is unusable, so this carries that response's own
      // status with the read/parse error in `cause`.
      this.warnRouteFailure(this.messagesEndpoint, res.status, err);
      return undefined;
    }
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let retryAttempt = 0;
    let readCursor: number | undefined;
    let readAheadSupported = false;
    let warnedWindowAt: number | undefined;
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
        const ack = cursor ?? 0;
        // One bounded forward sweep, then replay the durable gap. Retained
        // processing state is bounded by this seq window plus one server page.
        if (readCursor !== undefined && readCursor - ack >= MAILBOX_READ_AHEAD_MAX_SEQS) {
          if (warnedWindowAt !== ack) {
            warnedWindowAt = ack;
            console.warn('[byok/client] mailbox read-ahead window full; acknowledgement is stalled');
          }
          readCursor = ack;
          await sleep(this.opts.retryDelayMs ?? 2000, signal);
          continue;
        }
        const afterSeq = Math.max(ack, readCursor ?? ack);
        if (cursor !== undefined) url.searchParams.set('cursor', String(cursor));
        if (afterSeq > ack) {
          if (!readAheadSupported) {
            const error = new Error('server does not advertise mailbox-read-ahead; cannot read past unacknowledged work');
            this.warnRouteFailure(this.eventsEndpoint, undefined, error);
            throw error;
          }
          url.searchParams.set('afterSeq', String(afterSeq));
        }

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
          this.failLoop(signal);
          return;
        }

        // Validate each executable envelope independently. Both unknown types
        // and invalid payloads freeze their sequence; neither has a durable
        // disposition that would authorize acknowledging it.
        let parsed: EventsPollResponse;
        try {
          parsed = decodeEventsPage(await res.json(), afterSeq);
          validateTrustedEventsPage(parsed.events, afterSeq, parsed.cursor);
          if (afterSeq > ack && !parsed.capabilities.includes(MAILBOX_READ_AHEAD_CAPABILITY)) throw new Error('mailbox read-ahead capability was withdrawn');
        } catch (err) {
          // The response DID exist (and was a success status) — it is its body
          // that is unusable. Carrying `res.status` here rather than
          // `undefined` is what keeps this from reading as "the request never
          // got a response"; the parse error itself rides in `cause`.
          this.warnRouteFailure(this.eventsEndpoint, res.status, err);
          throw err;
        }
        readAheadSupported = parsed.capabilities.includes(MAILBOX_READ_AHEAD_CAPABILITY);
        const madeReadProgress = parsed.cursor > afterSeq;
        readCursor = parsed.cursor;
        this.opts.onIngress?.(parsed.ingress);
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
          // At the retained head, retry from the ACK so failed handlers can
          // recover. Reconnect likewise discards navigation, never the ACK.
          readCursor = this.opts.getCursor() ?? 0;
          retryAttempt = 0;
          this.opts.onOperationalOutcome?.('success');
          await sleep(this.opts.idleDelayMs ?? 250, signal);
        } else if (!madeReadProgress && (
          this.opts.isStalled?.() ||
          hadValidationFailureThisBatch ||
          (!acceptedAnyEntry && this.opts.getCursor() === cursor)
        )) {
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
        // shared "stop, or end this generation" tail. It never warns itself:
        // it cannot tell a route failure apart from a credential failure or a
        // throwing `onEnvelope` handler, and guessing is exactly the
        // mis-attribution this split removed.
        if (this.noteRevoked(err)) return;
        this.failLoop(signal);
        return;
      }
    }
  }

  /** Ends this loop generation on a failure; a stopped generation ends silently. */
  private failLoop(signal: AbortSignal): void {
    if (!this.running || signal.aborted) return;
    this.opts.onOperationalOutcome?.('failure');
    this.opts.onLoopFailure?.();
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
