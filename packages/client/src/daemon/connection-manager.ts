import type { CapabilityFlag, Envelope, RuntimeInfo } from '@byok/protocol';
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
  private draining = false;
  private stopped = false;
  private revoked = false;
  private settledWaiters: Array<(err?: unknown) => void> = [];
  private pendingCursorSave: Promise<void> = Promise.resolve();

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
      onAcked: () => this.onAcked(),
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
   * Long-poll: POSTs the entire current queue as one batch
   * (`LongPollClient.postBatch`, protocol §8.2). On failure the batch is
   * unshifted back (order-preserving, same Envelope objects/ids — never
   * rebuilt, so a retry is exactly the resend Wave 1's server-side dedup
   * expects) and retried after a short backoff, re-reading `this.mode` each
   * time so a WS recovery that happens mid-retry is honored on the very
   * next loop iteration instead of only after this attempt's backoff
   * chain gives up.
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
        if (this.stopped) return;

        if (this.mode === 'ws') {
          if (!this.ws.isOpen) return; // onAcked() re-invokes drainOutbox() once it is
          const envelope = this.outbox[0]!;
          if (!this.ws.sendNow(envelope)) return; // defensive; isOpen already checked above
          this.outbox.shift();
          continue;
        }

        const batch = this.outbox.splice(0);
        const ok = await this.longPoll.postBatch(batch);
        if (ok) continue; // loop back around in case more was pushed while this POST was in flight

        this.outbox.unshift(...batch); // retry, preserving order — same objects, same ids (finding F1)
        if (this.stopped) return;
        await sleep(this.opts.longPollRetryDelayMs ?? 2000);
      }
    } finally {
      this.draining = false;
    }
  }

  isTransportDegraded(): boolean {
    return this.mode === 'long-poll';
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
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.wsRetryTimer) clearInterval(this.wsRetryTimer);
    this.longPoll.stop();
    this.ws.close();
    await this.processingChain;
    await this.pendingCursorSave;
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
    if (tracked) this.noteDelivered(envelope.seq!);

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
    try {
      await this.opts.onEnvelope(envelope);
      if (!tracked) return;
      // Still behind an earlier, not-yet-resolved failure: this envelope
      // (even though it just succeeded) is not the one unblocking the
      // cursor. Advancing here would create a gap a future redelivery could
      // never fill (the skipped-over failed seq would look already-seen).
      if (this.stalledAtSeq !== undefined && envelope.seq !== this.stalledAtSeq) return;
      this.stalledAtSeq = undefined;
      this.advanceCursor(envelope.seq!);
    } catch (err) {
      if (tracked && this.stalledAtSeq === undefined) this.stalledAtSeq = envelope.seq;
      console.error(
        `[byok/client] envelope handler failed for ${envelope.type}${
          typeof envelope.seq === 'number' ? ` (seq=${envelope.seq})` : ''
        }; cursor left unadvanced so a reconnect redelivers it:`,
        err,
      );
    }
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
  private onAcked(): void {
    this.consecutiveFailures = 0;
    this.notifySettled();
    if (this.mode === 'long-poll') this.exitLongPoll();
    void this.drainOutbox(); // Design B: pick up anything queued while WS was (re)connecting
  }

  private onWsOutcome(acked: boolean, err?: unknown): void {
    if (this.stopped || this.revoked) return;

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
    this.opts.onStateChange?.('revoked');
    // Unblock a cold start()'s pending waitForAck() immediately with the
    // typed error instead of leaving it to time out (see waitForAck doc). A
    // no-op if the connection already settled earlier (settledWaiters empty)
    // — e.g. revocation discovered while already connected/running.
    this.notifySettled(new DeviceRevokedError());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
