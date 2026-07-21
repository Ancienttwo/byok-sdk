import { MAX_MESSAGES_PER_BATCH, type CapabilityFlag, type Envelope, type RuntimeInfo } from '@byok/protocol';
import { AuthManager, DeviceRevokedError } from './auth-manager';
import type { CursorStore } from './cursor-store';
import { LongPollClient } from './long-poll-transport';
import {
  WsTransport,
  WsUnexpectedStatusError,
  type BackoffOptions,
  type ConnectionState,
  type LivenessOptions,
} from './ws-transport';

export type { ConnectionState } from './ws-transport';

/** `true` for every `task.*` envelope type — the ONLY types the redelivery cursor accounts for (protocol §1.2/§9; finding F2). `conn.*` types (e.g. `conn.ack`) carry a `seq` for schema uniformity but are never cursor-tracked. */
function isTaskEnvelopeType(type: Envelope['type']): boolean {
  return type.startsWith('task.');
}

export interface ConnectionManagerOptions {
  serverUrl: string;
  deviceId: string;
  productId: string;
  capabilities: CapabilityFlag[];
  runtimes: RuntimeInfo[];
  auth: AuthManager;
  cursorStore: CursorStore;
  /**
   * May return a promise; `ConnectionManager` awaits it before considering
   * this envelope "processed" (findings F2/F3 — see `deliver`/`process`
   * below). A handler that throws/rejects is caught here, not propagated.
   */
  onEnvelope: (envelope: Envelope) => void | Promise<void>;
  onStateChange?: (state: ConnectionState) => void;
  backoff?: BackoffOptions;
  liveness?: LivenessOptions;
  /** Consecutive never-acked WS connect failures before falling back to long-poll (protocol §8). Default 3. */
  wsFailureThreshold?: number;
  /** While long-polling, how often to retry establishing WS (protocol §8, "e.g. every 5 min"). Default 5 minutes. */
  wsRetryIntervalMs?: number;
  /** Backoff between failed long-poll HTTP attempts. Default 2s. */
  longPollRetryDelayMs?: number;
  /** Minimum delay before the next long-poll request after an empty (no-events) response. Default 250ms. */
  longPollIdleDelayMs?: number;
}

/**
 * Owns the daemon's one logical connection to the server, which may be
 * backed by either transport the wire protocol defines: WS (the normal
 * path) or long-poll (protocol §8's fallback for environments where an
 * outbound WSS connection isn't viable). Both funnel every received
 * envelope through the same cursor-dedupe/persistence logic (protocol §9),
 * so redelivery is safe regardless of which transport happens to deliver a
 * given envelope — including during the brief overlap window when handing
 * off between them.
 *
 * `send()` (Design B, finding N4) pushes onto a single shared outbox this
 * class owns and drains through whichever transport is currently active —
 * WS raw-sends while acked, `POST /byok/messages` while long-polling
 * (finding F6, long-poll is a full transport, not receive-only; see
 * docs/protocol.md §8) — so a transport switch mid-flight never strands a
 * queued envelope. See `drainOutbox`.
 */
export class ConnectionManager {
  private readonly ws: WsTransport;
  private readonly longPoll: LongPollClient;
  private mode: 'ws' | 'long-poll' = 'ws';
  private consecutiveFailures = 0;
  private wsRetryTimer: ReturnType<typeof setInterval> | undefined;
  private cursor: number | undefined;
  /**
   * Finding F3 (at-most-once redelivery): the lowest `task.*` envelope `seq`
   * whose handler failed and hasn't yet been successfully reprocessed. While
   * set, the cursor is frozen at its pre-failure value even if later
   * envelopes succeed — advancing past a still-unresolved failure would
   * mean a future reconnect's redelivery skips it forever (it's <= the
   * persisted cursor), which is exactly the bug this fixes. Cleared once an
   * envelope carrying this exact seq is reprocessed (via redelivery after a
   * reconnect) and succeeds; everything from there back up to the new
   * cursor gets safely re-attempted too, relying on the idempotency
   * guarantees in docs/protocol.md §9.
   */
  private stalledAtSeq: number | undefined;
  /**
   * Design A (Wave 2, F3-on-long-poll): the second, in-memory watermark
   * alongside the durable `cursor`. `cursor` only ever advances AFTER a
   * `task.*` handler's side effects resolve successfully, and is persisted
   * (see `advanceCursor`) — that semantics is unchanged. `deliveredSeq`
   * advances eagerly, the instant a `task.*` envelope is admitted past
   * dedup (see `deliver`/`noteDelivered`), independent of whether its
   * handler has even started, let alone succeeded. It exists so a
   * long-poll re-query (`LongPollClient`'s `getCursor`) doesn't re-pull an
   * envelope that's already been delivered once and is still in flight —
   * `handleOffer` is NOT idempotent and must never be re-pulled while a
   * first attempt is still running. On WS this same field is written the
   * same way, but since a live WS connection only ever pushes a given `seq`
   * once, it never has an observable effect there beyond mirroring
   * `cursor` (see `dedupWatermark`'s doc comment for why redelivery
   * correctness doesn't depend on resetting it anywhere).
   */
  private deliveredSeq: number | undefined;
  /** Finding F3: serializes `onEnvelope` calls into a per-connection FIFO — one envelope's handler always fully settles before the next one starts. */
  private processingChain: Promise<void> = Promise.resolve();
  /**
   * Design B (finding N4): the ONE outbound queue both transports drain
   * from — holds `Envelope` OBJECTS, never re-encoded/rebuilt strings, so a
   * resend after a failed send attempt is byte-identical to the original
   * (same `id`), which is what lets the server's per-(deviceId,id) dedup
   * (Wave 1) recognize it as a safe no-op retry rather than a second
   * application (protocol §9). A transport switch (long-poll <-> WS) never
   * touches this queue — see `drainOutbox` — so nothing queued while one
   * transport was active is ever stranded when the other takes over.
   */
  private readonly outbox: Envelope[] = [];
  /**
   * Finding F5(b): how many envelopes `drainOutbox`'s long-poll branch has
   * currently spliced OUT of `this.outbox` for an in-flight (not yet
   * confirmed delivered) `postBatch` call — 0 the rest of the time. See
   * `outboxLength`'s own doc comment for why this needs to be tracked
   * separately from `this.outbox.length` at all.
   */
  private inFlightBatchSize = 0;
  private draining = false;
  private stopped = false;
  private revoked = false;
  private settledWaiters: Array<(err?: unknown) => void> = [];
  private pendingCursorSave: Promise<void> = Promise.resolve();
  /**
   * Finding P2 (Fix 2b): seqs currently admitted into `processingChain` but
   * not yet settled — added in `deliver()` the moment a `task.*` envelope is
   * accepted past the ordinary watermark check, removed in `process()`'s
   * `finally` once that specific attempt resolves (success OR failure).
   * While stalled, `dedupWatermark()` deliberately stays frozen below
   * already-delivered seqs (see its own doc comment) so the failed seq's own
   * redelivery can get through — but that same frozen watermark also means
   * every OTHER seq above it rides along on every re-poll too. Without this,
   * a seq already mid-flight (e.g. a `task.offer` whose `adapter.start()`
   * hasn't resolved yet) would be re-enqueued into `processingChain` on
   * every such re-poll, piling up duplicate copies that — once the first
   * finally resolves and the chain unwinds through them — run its handler
   * again; for `task.offer` specifically, a second adapter session
   * orphaning the first (`TaskRunner`'s own `this.tasks.has` guard, finding
   * P2c, is the second, independent layer against exactly that).
   */
  private readonly inFlightSeqs = new Set<number>();
  /**
   * Finding P2 (Fix 2b): seqs whose handler has already resolved
   * successfully at least once this session, tracked only while a stall is
   * in effect — cleared the moment `stalledAtSeq` itself clears (see
   * `process()`), since once unstalled the ordinary watermark check via
   * `deliveredSeq` already covers everything delivered so far, making this
   * redundant. Needed because the stall-gap-prevention rule in `process()`
   * deliberately does NOT advance `cursor` past a seq above the
   * still-unresolved `stalledAtSeq`, even once that seq's own handler
   * succeeds — so `dedupWatermark()` alone can't distinguish "already
   * succeeded, don't re-run" from "never yet attempted" for anything in
   * that gap.
   */
  private readonly processedSeqs = new Set<number>();
  /**
   * Finding P3: the pending `drainOutbox` long-poll retry backoff, if any —
   * cancellable so `enterRevoked()` can unblock it immediately instead of
   * waiting out the rest of the delay before the loop notices `revoked` and
   * exits. See `drainRetryDelay`.
   */
  private cancelPendingDrainRetry: (() => void) | undefined;
  /**
   * The capabilities the CURRENTLY connected server advertised in its
   * `conn.ack` — untyped `string[]` (forward-compat: a server may advertise
   * a flag this build doesn't recognize yet), populated by {@link onAcked}
   * and read by {@link getServerCapabilities}. Empty until the very first
   * successful handshake.
   *
   * Finding R2 (cross-model re-review — was P1): strictly PER-CONNECTION,
   * not per-daemon-lifetime. Cleared to `[]` the instant the acked WS
   * connection ends for ANY reason — an ordinary disconnect (`onWsOutcome`'s
   * `acked` branch), `stop()`, or a transport switch to long-poll
   * (`enterLongPoll`) — and only ever repopulated by a FRESH `conn.ack`.
   * The previous version of this doc comment claimed long-poll mode simply
   * "stays at whatever the last real WS `conn.ack` said" — that was the bug:
   * a daemon that once learned e.g. `approval_resolved` from an earlier WS
   * session kept believing it applied to whatever it's connected to NOW,
   * even after a disconnect/degrade where nothing has actually confirmed
   * that's still true (a reconnect could land on a DIFFERENT server behind a
   * load balancer; long-poll fallback itself never performs an equivalent
   * handshake at all). Concretely, `TaskRunner.sendApprovalResolved` gates
   * `task.approval_resolved` on this list — sending it to a server that
   * doesn't actually understand it over the long-poll path would get a
   * batch-level 400 from `MessagesSendRequestSchema` (protocol §8.2), which
   * `drainOutbox`'s retry-the-same-batch-forever loop then head-of-line
   * blocks EVERY envelope queued behind it on, permanently. Clearing this
   * eagerly means that gate reliably fails closed (falls back to the
   * pre-existing implicit-resume inference, unconditionally — see
   * `sendApprovalResolved`'s own doc comment) the moment the connection that
   * advertised the capability is no longer the one actually in use.
   */
  private serverCapabilities: string[] = [];

  constructor(private readonly opts: ConnectionManagerOptions) {
    this.ws = new WsTransport({
      serverUrl: opts.serverUrl,
      getToken: () => opts.auth.getValidAccessToken(),
      deviceId: opts.deviceId,
      productId: opts.productId,
      capabilities: opts.capabilities,
      runtimes: opts.runtimes,
      getCursor: () => this.cursor,
      onEnvelope: (envelope) => this.deliver(envelope),
      onStateChange: (state) => {
        if (!this.stopped && !this.revoked) this.opts.onStateChange?.(state);
      },
      onAcked: (capabilities) => this.onAcked(capabilities),
      onConnectOutcome: (acked, err) => this.onWsOutcome(acked, err),
      backoff: opts.backoff,
      liveness: opts.liveness,
    });

    this.longPoll = new LongPollClient({
      serverUrl: opts.serverUrl,
      auth: opts.auth,
      // Design A: the query cursor for the NEXT `GET /byok/events` is the
      // same watermark `deliver()` dedupes against (see `dedupWatermark`) —
      // normally the eager `deliveredSeq` (so an in-flight envelope isn't
      // re-pulled), but the durable `cursor` while `stalledAtSeq` is set, so
      // the failed envelope (and everything after it) IS re-pulled and
      // re-attempted.
      getCursor: () => this.dedupWatermark(),
      onEnvelope: (envelope) => this.deliver(envelope),
      onRevoked: () => this.enterRevoked(),
      // M4 Phase 4 (version-negotiation drill fix): a batch entry
      // LongPollClient couldn't parse into a known Envelope at all (an
      // unrecognized message type) still needs its cursor/watermark
      // advanced past it, exactly like a successfully-processed envelope
      // would — see `noteSkippedSeq`'s own doc comment.
      onSkippedSeq: (seq) => this.noteSkippedSeq(seq),
      // Finding R1: a batch entry LongPollClient recognized the TYPE of but
      // whose payload failed validation — a genuine delivery failure at
      // that seq, engaged the same way a thrown handler failure is (see
      // `noteValidationFailure`'s own doc comment).
      onValidationFailedSeq: (seq) => this.noteValidationFailure(seq),
      // Finding P2 (Fix 2a): lets the long-poll loop distinguish "this
      // non-empty batch was a stalled backlog re-pull, no cursor progress
      // was made" from ordinary forward progress, so it can back off
      // instead of spinning at RTT — see `LongPollClient`'s own doc comment
      // on `isStalled`.
      isStalled: () => this.stalledAtSeq !== undefined,
      retryDelayMs: opts.longPollRetryDelayMs,
      idleDelayMs: opts.longPollIdleDelayMs,
    });
  }

  async start(): Promise<void> {
    this.cursor = await this.opts.cursorStore.load(this.opts.serverUrl, this.opts.deviceId);
    this.ws.connect({ auto: true });
  }

  /**
   * Design B (finding N4): push onto the single shared outbox and try to
   * drain it now. Never routes directly to either transport itself — see
   * `drainOutbox`.
   */
  send(envelope: Envelope): void {
    this.outbox.push(envelope);
    void this.drainOutbox();
  }

  /**
   * Design B (finding N4): drain the shared outbox through whichever
   * transport is currently active, re-checking `this.mode` fresh on every
   * iteration so a transport switch mid-drain is picked up immediately
   * rather than fighting a stale decision made before the switch.
   *
   * WS: a synchronous, one-at-a-time `sendNow` per envelope while open+
   * acked; stops (without dropping anything — the remainder stays queued)
   * the moment it isn't, and is re-invoked once `onAcked` fires.
   *
   * Long-poll: POSTs the outbox in chunks of at most
   * `MAX_MESSAGES_PER_BATCH` (finding P1) — the server hard-caps a single
   * `/byok/messages` batch there (`MessagesSendRequestSchema`, protocol
   * §8.2) and 400s the WHOLE request if it's exceeded, which — before this
   * fix — meant more than that queued during an outage produced an oversize
   * batch that the server would reject forever, since the client re-queued
   * and retried the identical (still oversize) batch unchanged. Each chunk
   * is one `LongPollClient.postBatch` call; on success the loop continues
   * (more may still be queued, or the next chunk still needs sending), on
   * failure that SAME chunk is unshifted back (order-preserving, same
   * Envelope objects/ids — never rebuilt, so a retry is exactly the resend
   * Wave 1's server-side dedup expects) and retried after a short backoff,
   * re-reading `this.mode` each time so a WS recovery that happens
   * mid-retry is honored on the very next loop iteration instead of only
   * after this attempt's backoff chain gives up.
   *
   * Re-entrancy is guarded by `draining`: a call arriving while a drain is
   * already in progress just returns — the in-progress loop's own
   * `while (this.outbox.length > 0)` check will pick up anything newly
   * pushed (or left over after a mode switch) on its very next iteration.
   */
  private async drainOutbox(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.outbox.length > 0) {
        if (this.stopped || this.revoked) return;

        if (this.mode === 'ws') {
          if (!this.ws.isOpen) return; // onAcked() re-invokes drainOutbox() once it is
          const envelope = this.outbox[0]!;
          if (!this.ws.sendNow(envelope)) return; // defensive; isOpen already checked above
          this.outbox.shift();
          continue;
        }

        const batch = this.outbox.splice(0, MAX_MESSAGES_PER_BATCH);
        // Finding F5(b): tracked for the DURATION of the `postBatch` await —
        // `batch` has already left `this.outbox` (spliced out above) but
        // isn't confirmed delivered yet, so a plain `this.outbox.length`
        // read right now would UNDERCOUNT it entirely (this is exactly what
        // a stalled/hung `postBatch` call means: neither queued nor
        // delivered, just stuck). See `outboxLength`'s own doc comment.
        this.inFlightBatchSize = batch.length;
        let ok: boolean;
        try {
          ok = await this.longPoll.postBatch(batch);
        } finally {
          this.inFlightBatchSize = 0;
        }
        if (ok) continue; // loop back around — more may be queued, or the next chunk still needs sending

        this.outbox.unshift(...batch); // retry, preserving order — same objects, same ids (finding F1)
        // Finding P3: a revoked device can never recover without a fresh
        // pair() — retrying (and thus scheduling another backoff timer)
        // would spin forever and keep the process alive for no reason.
        // `postBatch`'s own DeviceRevokedError handling has already called
        // `enterRevoked()` (synchronously, before `postBatch` resolves) by
        // the time `ok` is `false` for that reason, so this check catches
        // it on the very next iteration rather than sleeping first.
        if (this.stopped || this.revoked) return;
        await this.drainRetryDelay(this.opts.longPollRetryDelayMs ?? 2000);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Finding P3: backoff delay for `drainOutbox`'s long-poll retry loop.
   * Unlike a plain `setTimeout`-based wait, this is (a) cancellable —
   * `enterRevoked()` calls `cancelPendingDrainRetry()` to unblock an
   * in-flight wait immediately instead of leaving `drainOutbox` parked here
   * for up to the rest of the delay before it next checks `this.revoked` —
   * and (b) unref'd, so the timer never keeps the Node process alive by
   * itself while nothing else (a live long-poll GET, an open WS connection)
   * legitimately is.
   */
  private drainRetryDelay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.cancelPendingDrainRetry = undefined;
        resolve();
      }, ms);
      timer.unref?.();
      this.cancelPendingDrainRetry = () => {
        clearTimeout(timer);
        this.cancelPendingDrainRetry = undefined;
        resolve();
      };
    });
  }

  isTransportDegraded(): boolean {
    return this.mode === 'long-poll';
  }

  /**
   * The capabilities the CURRENTLY connected server advertised in its
   * `conn.ack` — e.g. lets a caller gate a daemon->server message on whether
   * THIS server understands it before sending (see `task-runner.ts`'s
   * `sendApprovalResolved`, gated on `approval_resolved`). Empty before the
   * first handshake completes, AND (finding R2) once again empty after any
   * disconnect/degrade — see `serverCapabilities`'s own doc comment for why
   * this is strictly per-connection rather than "sticky" across one.
   */
  getServerCapabilities(): readonly string[] {
    return this.serverCapabilities;
  }

  isConnected(): boolean {
    return this.mode === 'ws' && this.ws.isOpen;
  }

  isRevoked(): boolean {
    return this.revoked;
  }

  /**
   * Resolves once the connection has settled — either a working, acked WS
   * connection, or the long-poll fallback taking over (protocol §8). This
   * lets `daemon.start()` return promptly even when WS is unavailable from
   * the very first attempt, rather than hanging until a WS `conn.ack` that
   * may never come.
   *
   * Rejects with {@link DeviceRevokedError} — instead of hanging until
   * `timeoutMs` — if the device turns out to be revoked while settling (or
   * already was): a cold `daemon.start()` against an already-revoked device
   * must fail fast, not surface a generic timeout (protocol §6.3).
   */
  waitForAck(timeoutMs = 10_000): Promise<void> {
    if (this.ws.isOpen || this.mode === 'long-poll') return Promise.resolve();
    if (this.revoked) return Promise.reject(new DeviceRevokedError());
    return new Promise((resolve, reject) => {
      let settle: (err?: unknown) => void = () => {};
      const timer = setTimeout(() => {
        this.settledWaiters = this.settledWaiters.filter((w) => w !== settle);
        reject(new Error('Timed out waiting for the connection to settle (WS ack or long-poll fallback)'));
      }, timeoutMs);
      settle = (err?: unknown) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      this.settledWaiters.push(settle);
    });
  }

  /**
   * Stops both transports and waits for every in-flight envelope handler
   * (the F3 FIFO chain) and the most recent cursor write to actually land on
   * disk — otherwise a `stop()` racing a just-processed envelope's
   * persistence could lose that cursor advance, or leave a handler running
   * unobserved after the daemon reports itself stopped.
   *
   * Finding F5(b) (cross-model adversarial review): `drainTimeoutMs`, when
   * passed, bounds how long this waits for the shared outbox (`this.outbox`
   * — Design B) to actually finish draining BEFORE flipping `this.stopped`
   * and closing the transports. Before this fix, `stop()` set `stopped`
   * synchronously and never waited for `drainOutbox` at all: an envelope
   * `send()` had just pushed moments earlier (e.g. `TaskRunner.shutdownTask`'s
   * own `task.fail`, sent right before `create-daemon.ts`'s
   * `performControlShutdown` calls this) could still be sitting UNSENT in
   * `this.outbox` — mid long-poll retry backoff, or simply not yet picked up
   * by the fire-and-forget `drainOutbox()` `send()` kicked off — and this
   * method would happily proceed to `stopped = true` / `ws.close()` regardless,
   * after which NOTHING ever drains it again: silently lost, even though
   * `TaskRunner` believed it had been sent. `drainTimeoutMs` omitted (the
   * default) preserves the EXACT prior behavior for every other existing
   * caller (an ordinary `daemon.stop()`/`unpair()`) — only the control-socket
   * shutdown path opts into the bounded wait (see `create-daemon.ts`'s
   * `performControlShutdown`). This can never claim delivery that didn't
   * happen: on a timeout, whatever's still queued stays exactly where it is
   * (readable via {@link outboxLength} immediately after this resolves) —
   * it does NOT force-flush or pretend success.
   */
  async stop(drainTimeoutMs?: number): Promise<void> {
    if (drainTimeoutMs !== undefined) {
      await this.waitForOutboxDrained(drainTimeoutMs);
    }
    this.stopped = true;
    // Finding R2: this daemon's own connection is ending — whatever the
    // server last advertised no longer applies to anything (there's nothing
    // left to send to). See `serverCapabilities`'s own doc comment.
    this.serverCapabilities = [];
    if (this.wsRetryTimer) clearInterval(this.wsRetryTimer);
    this.longPoll.stop();
    this.ws.close();
    await this.processingChain;
    await this.pendingCursorSave;
  }

  /**
   * Finding F5(b): how many envelopes are neither confirmed delivered NOR
   * safely re-queued — meant to be read right after a bounded {@link stop}
   * call returns, to know honestly whether the drain actually finished (0)
   * or timed out with something still stuck (>0). See `create-daemon.ts`'s
   * `performControlShutdown`, which surfaces this on the `shutdown-complete`
   * audit event rather than silently claiming everything was delivered.
   *
   * Deliberately `this.outbox.length + this.inFlightBatchSize`, NOT just
   * `this.outbox.length` alone: `drainOutbox`'s long-poll branch SPLICES a
   * batch out of `this.outbox` before awaiting `postBatch` (so a concurrent
   * `send()` sees an accurate, non-double-counted queue) — while that POST
   * is in flight (or, this finding's whole point, genuinely STALLED and
   * never resolving), those envelopes have already left `this.outbox` but
   * are not delivered either. Reading `this.outbox.length` alone at exactly
   * that moment would undercount to 0 — silently implying full delivery
   * for the one case (a hung POST) this finding exists to catch honestly.
   */
  outboxLength(): number {
    return this.outbox.length + this.inFlightBatchSize;
  }

  /**
   * Finding F5(b): polls {@link outboxLength} (not `this.outbox.length`
   * alone — see that method's own doc comment for why a spliced-out,
   * in-flight batch would otherwise be invisible here) rather than hooking
   * a single `drainOutbox()` promise directly — a drain in progress can
   * itself loop through multiple retry/backoff cycles (`drainRetryDelay`)
   * while the server is unreachable, and a fresh, INDEPENDENT
   * `drainOutbox()` call can also be triggered concurrently (`send()`, a
   * mode switch's own `void this.drainOutbox()`) — polling the one thing
   * that actually matters (is anything still undelivered) can never go
   * stale the way capturing one specific in-flight promise reference
   * could. Kicks off one more `drainOutbox()` attempt itself first
   * (harmless no-op if one is already running — see its own re-entrancy
   * guard) in case nothing is currently actively retrying (e.g. WS just
   * dropped and long-poll hasn't taken over yet), so this bounded wait
   * isn't just passively hoping something else happens to be making
   * progress.
   */
  private waitForOutboxDrained(timeoutMs: number): Promise<void> {
    if (this.outboxLength() === 0) return Promise.resolve();
    void this.drainOutbox();
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const poll = (): void => {
        if (this.outboxLength() === 0 || this.stopped || this.revoked || Date.now() >= deadline) {
          resolve();
          return;
        }
        const timer = setTimeout(poll, 20);
        timer.unref?.();
      };
      poll();
    });
  }

  /**
   * Findings F2 + F3. Two rules, both pinned in docs/protocol.md §1.2/§9:
   *
   * - F2 (redelivery dead on reconnect): cursor accounting covers ONLY
   *   `task.*` envelopes. `conn.ack` carries a `seq` too (required by the
   *   schema for schema uniformity across every server->daemon type), but a
   *   reconnecting server sends it BEFORE replaying the backlog and always
   *   assigns it the next (i.e. highest-so-far) per-device seq — advancing
   *   the cursor for it would make every backlog envelope's (necessarily
   *   lower) seq look already-delivered and drop it. `conn.*` envelopes
   *   never advance the cursor.
   * - F3 (at-most-once): the old code persisted the cursor advance BEFORE
   *   `onEnvelope` even ran (fire-and-forget) — a handler that then failed
   *   left a redelivery-proof envelope permanently marked processed. Inbound
   *   envelopes are now serialized through `processingChain` (one handler
   *   fully settles before the next starts) and the cursor only advances
   *   AFTER the handler resolves successfully; a rejection leaves the
   *   cursor where it was (see `stalledAtSeq`), so a future reconnect's
   *   redelivery re-attempts it — safe because every server->daemon type is
   *   documented idempotent (protocol §9).
   */
  private deliver(envelope: Envelope): void {
    const tracked = isTaskEnvelopeType(envelope.type) && typeof envelope.seq === 'number';
    const watermark = this.dedupWatermark();
    if (tracked && watermark !== undefined && envelope.seq! <= watermark) return; // redelivered — idempotent skip (protocol §9)

    if (tracked) {
      const seq = envelope.seq!;
      // Finding P2 (Fix 2b): a redelivery of a seq already in flight (its
      // prior attempt hasn't settled yet) or already succeeded this session
      // — both possible even though `seq > watermark` while stalled (see
      // `dedupWatermark`'s doc comment) — must not be re-appended to
      // `processingChain`. The stalled seq itself is deliberately NOT
      // excluded by this check once its prior attempt has settled (removed
      // from `inFlightSeqs` in `process()`'s `finally`, never added to
      // `processedSeqs` since it failed) — that's exactly the redelivery
      // this whole mechanism exists to let through for a fresh retry.
      if (this.inFlightSeqs.has(seq) || this.processedSeqs.has(seq)) return;
      this.inFlightSeqs.add(seq);
      this.noteDelivered(seq);
    }

    this.processingChain = this.processingChain.then(() => this.process(envelope, tracked));
  }

  /**
   * Design A: the watermark `deliver()` dedupes inbound `task.*` envelopes
   * against, and the same value `LongPollClient` queries the next
   * `GET /byok/events` cursor with (see the constructor). Normally this is
   * `deliveredSeq` — which is always >= `cursor` (every envelope that
   * reaches `advanceCursor` already passed through `noteDelivered` first,
   * see `deliver`) — so this is the literal `max(cursor, deliveredSeq)` the
   * design calls for, just expressed via that invariant rather than an
   * explicit `Math.max`.
   *
   * While `stalledAtSeq` is set, this collapses to the durable `cursor`
   * alone, deliberately ignoring however far `deliveredSeq` had already run
   * ahead before the failure was known: that's what lets the stalled
   * envelope's own redelivery (and everything after it, right up to a
   * fresh success) get past this same dedup check instead of being
   * self-deduped by the client's own earlier eager tracking of envelopes
   * whose outcome wasn't known yet. No separate "reset deliveredSeq on
   * reconnect" step is needed for this to be correct — collapsing to
   * `cursor` exactly while stalled already produces the right answer on
   * every redelivery path (long-poll re-query AND a WS reconnect's
   * backlog replay alike), and NOT resetting it unconditionally on every
   * reconnect is what lets `deliveredSeq` keep doing its job of not
   * re-pulling/re-dispatching something already in flight across a
   * reconnect that happens to land while a handler is still running.
   */
  private dedupWatermark(): number | undefined {
    return this.stalledAtSeq !== undefined ? this.cursor : (this.deliveredSeq ?? this.cursor);
  }

  /** Design A: eagerly advance the in-memory delivery watermark — called for every `task.*` envelope `deliver()` admits past dedup, regardless of transport or of whether its handler has even started yet. */
  private noteDelivered(seq: number): void {
    if (this.deliveredSeq === undefined || seq > this.deliveredSeq) this.deliveredSeq = seq;
  }

  private async process(envelope: Envelope, tracked: boolean): Promise<void> {
    const seq = tracked ? envelope.seq! : undefined;
    try {
      await this.opts.onEnvelope(envelope);
      if (!tracked) return;
      this.processedSeqs.add(seq!); // finding P2 (Fix 2b) — see its own doc comment
      // Still behind an earlier, not-yet-resolved failure: this envelope
      // (even though it just succeeded) is not the one unblocking the
      // cursor. Advancing here would create a gap a future redelivery could
      // never fill (the skipped-over failed seq would look already-seen).
      if (this.stalledAtSeq !== undefined && envelope.seq !== this.stalledAtSeq) return;
      this.stalledAtSeq = undefined;
      this.processedSeqs.clear(); // no longer needed once unstalled — deliveredSeq/watermark already covers everything delivered so far
      this.advanceCursor(envelope.seq!);
    } catch (err) {
      if (tracked && this.stalledAtSeq === undefined) this.stalledAtSeq = envelope.seq;
      console.error(
        `[byok/client] envelope handler failed for ${envelope.type}${
          typeof envelope.seq === 'number' ? ` (seq=${envelope.seq})` : ''
        }; cursor left unadvanced so a reconnect redelivers it:`,
        err,
      );
    } finally {
      if (tracked) this.inFlightSeqs.delete(seq!);
    }
  }

  /**
   * M4 Phase 4 (version-negotiation drill fix): `LongPollClient` calls this
   * for a batch entry it could not parse into a known `Envelope` at all (an
   * unrecognized message type — mirrors `ws-transport.ts`'s identical
   * per-frame tolerance, see `long-poll-transport.ts`'s own doc comment on
   * `parseLooseEventsPollResponse`) but which still carried a numeric,
   * task-class envelope-level `seq` (the caller only invokes this for a
   * `task.`-prefixed type — see `long-poll-transport.ts`'s own
   * `extractSkippableSeq`; `conn.*`-shaped or type-less entries never reach
   * here at all, mirroring F2's "conn.* is never cursor-tracked" rule).
   * There is no real `Envelope` to hand to a handler — a genuinely
   * unrecognized type has nothing this build could ever act on.
   *
   * GATEKEEPER-CAUGHT REGRESSION (fixed here): this used to call
   * `advanceCursor(seq)` DIRECTLY, synchronously, the instant a skip was
   * detected in `LongPollClient.loop()`'s per-entry for-loop. That is NOT
   * "instantaneous and race-free" the way the previous version of this
   * comment claimed — the hazard was never the skip racing against itself,
   * it was the skip racing AHEAD of an EARLIER real envelope in the SAME
   * batch that is still in flight on `processingChain` (`deliver()`, above,
   * only ever CHAINS `process()` onto that promise chain — it never awaits
   * it before returning). Concretely, batch `[real seq1, unknown seq2]`:
   * `deliver(seq1)` chains `process(seq1)` but returns immediately without
   * running it; the for-loop then reaches `seq2` and (pre-fix) called
   * `advanceCursor(2)` synchronously, BEFORE `process(seq1)` had even
   * started, let alone failed. If `seq1`'s handler then failed,
   * `stalledAtSeq` became 1 — but the durable cursor was already 2, so
   * `dedupWatermark()` returned 2, and every future redelivery of seq1 was
   * dedup-dropped as "already past the cursor" forever: permanent envelope
   * loss, exactly the F3 bug class the whole `stalledAtSeq`/frozen-watermark
   * mechanism exists to prevent.
   *
   * Fix: the cursor-advancing half is now CHAINED onto `processingChain`
   * too, exactly like `process()`'s own post-handler bookkeeping — so it
   * only ever runs once every earlier envelope already queued ahead of it
   * has fully settled (success or failure), and can observe `stalledAtSeq`'s
   * REAL, up-to-date value rather than whatever it happened to be at the
   * instant the skip was first noticed. The guard mirrors `process()`'s own
   * success-path guard exactly: never advance past a still-unresolved
   * earlier failure, unless (degenerate, cannot really happen for a skip)
   * this exact seq IS the stalled one.
   *
   * `noteDelivered` (the eager, in-memory watermark) stays UNCHAINED —
   * called immediately, unconditionally, regardless of `stalledAtSeq` —
   * matching `deliver()`'s own eager, unconditional call for a real
   * envelope: its only job is "don't re-pull something already handed off,"
   * independent of outcome, and that property does not depend on FIFO
   * ordering the way the DURABLE cursor does.
   *
   * Deliberately NO top-level `dedupWatermark() <= seq` early-return before
   * queuing the chained callback (an earlier draft of this fix had one, and
   * it was itself subtly wrong): `deliveredSeq` can already reflect a seq
   * from the FIRST time it was ever seen, while the DURABLE cursor is still
   * behind it because a stall intervened before that seq's chained
   * advancement ran — a pre-check keyed on `deliveredSeq` would then
   * wrongly treat a LATER redelivery of the same seq (arriving once the
   * stall has since cleared) as "already accounted for" and never queue
   * another attempt, permanently stranding the cursor one seq short. Always
   * queuing is safe and cheap: `advanceCursor`'s own `seq <= this.cursor`
   * guard already makes a genuinely-redundant call a no-op, so there is no
   * correctness reason to short-circuit earlier, only a (here, unnecessary)
   * micro-optimization one.
   */
  private noteSkippedSeq(seq: number): void {
    this.noteDelivered(seq);
    this.processingChain = this.processingChain.then(() => {
      if (this.stalledAtSeq === undefined || seq === this.stalledAtSeq) {
        this.advanceCursor(seq);
      }
    });
  }

  /**
   * Finding R1 (cross-model re-review — was NOT-CLOSED against F1):
   * `LongPollClient` calls this for a batch entry whose `type` it
   * recognized but whose payload failed schema validation
   * ({@link EnvelopeValidationError}) — a genuine delivery failure at that
   * seq, unlike `noteSkippedSeq`'s forward-compat case. Deliberately mirrors
   * `process()`'s own catch block (`if (tracked && this.stalledAtSeq ===
   * undefined) this.stalledAtSeq = envelope.seq;`) as closely as possible:
   * the SAME "only the lowest unresolved failure holds the stall" rule, the
   * SAME resulting freeze of `dedupWatermark()` at the durable cursor
   * (protocol §9 keeps this seq alive), and — because it's the SAME
   * `stalledAtSeq` field `process()`'s own post-success guard already
   * checks — anything ELSE delivered after this seq (same batch or a later
   * one) is automatically held back from advancing the cursor too, with
   * zero changes needed to `process()` itself.
   *
   * Chained onto `processingChain` for exactly the reason `noteSkippedSeq`
   * documents for its own identical chaining (see that method's sibling
   * doc comment on `LongPollClient`, "GATEKEEPER-CAUGHT REGRESSION"): an
   * EARLIER real envelope in the SAME batch may still be in flight on that
   * FIFO chain when this is called (`deliver()` only ever chains
   * `process()` onto it, never awaits before returning) — mutating
   * `stalledAtSeq` synchronously here could race ahead of that still-
   * unresolved earlier envelope. Chaining instead guarantees this only
   * takes effect once every earlier-queued envelope has already settled,
   * and reads `stalledAtSeq`'s real, up-to-date value rather than whatever
   * it happened to be the instant the failure was first noticed.
   *
   * No `noteDelivered` call here (contrast `noteSkippedSeq`, which does
   * call it): a validation-failed entry never becomes a real `Envelope` and
   * never reaches `deliver()`, so it was never "delivered" in the eager
   * in-memory-watermark sense that field tracks — there is nothing for it
   * to eagerly mark. Once a corrected redelivery of this exact seq DOES
   * arrive as a real envelope, it flows through the ordinary `deliver()`
   * path (which calls `noteDelivered` itself) and, on success, clears the
   * stall via `process()`'s own existing logic — no special-casing needed.
   */
  private noteValidationFailure(seq: number): void {
    this.processingChain = this.processingChain.then(() => {
      if (this.stalledAtSeq === undefined) this.stalledAtSeq = seq;
    });
  }

  private advanceCursor(seq: number): void {
    if (this.cursor !== undefined && seq <= this.cursor) return;
    this.cursor = seq;
    // Chain onto the previous save rather than firing independently: two
    // overlapping writes to the same file have no guaranteed completion
    // order, so an earlier (lower-seq) save finishing *after* a later one
    // could silently clobber it back to a stale value. Chaining forces
    // strict write order, matching call order (which matches seq order,
    // since advanceCursor is only ever called with an increasing value).
    this.pendingCursorSave = this.pendingCursorSave
      .catch(() => {
        // don't let an earlier failure abort the chain for later saves
      })
      .then(() => this.opts.cursorStore.save(this.opts.serverUrl, this.opts.deviceId, seq))
      .catch(() => {
        // Best-effort persistence: a failed write just means a future
        // reconnect might redeliver slightly more than strictly necessary,
        // which is safe under at-least-once delivery (protocol §9).
      });
  }

  /**
   * Fires the moment a connection attempt reaches `conn.ack` — independent
   * of whether/when it later closes. This is the ONLY place that can
   * reliably detect "WS is back up" while long-polling: a healthy
   * connection stays open indefinitely, so it never reaches `onWsOutcome`
   * (which is close-only) at all.
   */
  private onAcked(capabilities: string[]): void {
    this.serverCapabilities = capabilities;
    this.consecutiveFailures = 0;
    this.notifySettled();
    if (this.mode === 'long-poll') this.exitLongPoll();
    void this.drainOutbox(); // Design B: pick up anything queued while WS was (re)connecting
  }

  private onWsOutcome(acked: boolean, err?: unknown): void {
    if (this.stopped || this.revoked) return;

    // Finding R2: this specific attempt WAS acked at some point but has now
    // closed — the connection that advertised `serverCapabilities` is gone.
    // Cleared BEFORE the `if (acked) return;` early-out below, so this runs
    // on every acked-then-closed outcome regardless of what happens next
    // (a fast auto-reconnect, a slower one, or none at all pending
    // `enterLongPoll`) — only a FRESH `conn.ack` (`onAcked`) repopulates it.
    if (acked) this.serverCapabilities = [];

    if (err instanceof WsUnexpectedStatusError && err.status === 401) {
      // Reactive renewal (protocol §6.2): the cached token was rejected on
      // the wire even though our own expiry bookkeeping thought it was
      // still good. Force a renewal now so the next attempt (this one just
      // failed) uses a fresh token; a genuinely revoked device surfaces via
      // handleUnauthorized() throwing DeviceRevokedError below.
      this.opts.auth.handleUnauthorized().catch((renewErr: unknown) => {
        if (renewErr instanceof DeviceRevokedError) this.enterRevoked();
      });
    }

    // acked===true here just means "this now-closed attempt was healthy at
    // some point" — `onAcked()` already handled resetting failures/exiting
    // long-poll the moment that happened, so there's nothing left to do.
    if (acked) return;

    this.consecutiveFailures += 1;
    if (this.mode === 'ws' && this.consecutiveFailures >= (this.opts.wsFailureThreshold ?? 3)) {
      this.enterLongPoll();
    }
  }

  private notifySettled(err?: unknown): void {
    for (const waiter of this.settledWaiters.splice(0)) waiter(err);
  }

  private enterLongPoll(): void {
    this.mode = 'long-poll';
    // Finding R2: defensive/belt-and-suspenders — in practice the acked
    // disconnect that precedes this already cleared it via `onWsOutcome`
    // above, but long-poll performs no equivalent handshake of its own
    // (docs/protocol.md §8.1), so this transport must never be able to
    // observe a stale, non-empty `serverCapabilities` from here on either.
    this.serverCapabilities = [];
    this.ws.stopAutoReconnect();
    this.opts.onStateChange?.('degraded');
    this.longPoll.start();
    this.notifySettled();
    void this.drainOutbox(); // Design B: anything already queued now drains over the freshly-started long-poll POST path

    const intervalMs = this.opts.wsRetryIntervalMs ?? 5 * 60 * 1000;
    const timer = setInterval(() => {
      if (!this.stopped) this.ws.connect({ auto: false });
    }, intervalMs);
    timer.unref?.();
    this.wsRetryTimer = timer;
  }

  private exitLongPoll(): void {
    if (this.wsRetryTimer) {
      clearInterval(this.wsRetryTimer);
      this.wsRetryTimer = undefined;
    }
    this.longPoll.stop();
    this.mode = 'ws';
    this.consecutiveFailures = 0;
    this.ws.resumeAutoReconnect();
    void this.drainOutbox(); // Design B: anything still queued from long-poll now drains over WS
  }

  private enterRevoked(): void {
    if (this.revoked) return;
    this.revoked = true;
    if (this.wsRetryTimer) clearInterval(this.wsRetryTimer);
    this.longPoll.stop();
    this.ws.close(); // stop all reconnection attempts entirely — never a retry loop (protocol §6.3)
    // Finding P3: the outbox drain must stop too, not just the receive
    // side — otherwise a queued send keeps retrying (and re-arming a
    // backoff timer) forever, since a revoked device can never recover
    // without a fresh pair(). `drainOutbox`'s own `this.revoked` check
    // (now true) stops it from scheduling another retry, but if it's
    // ALREADY parked inside `drainRetryDelay` from a previous cycle,
    // cancel that wait immediately rather than leaving it queued for up to
    // the rest of the delay.
    this.cancelPendingDrainRetry?.();
    this.opts.onStateChange?.('revoked');
    // Unblock a cold start()'s pending waitForAck() immediately with the
    // typed error instead of leaving it to time out (see waitForAck doc). A
    // no-op if the connection already settled earlier (settledWaiters empty)
    // — e.g. revocation discovered while already connected/running.
    this.notifySettled(new DeviceRevokedError());
  }
}
