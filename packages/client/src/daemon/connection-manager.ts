import type { HarnessInfo } from '@byok-sdk/protocol';
import {
  MAX_MESSAGES_PER_BATCH,
  createEnvelope,
  isServerToDaemonType,
  PROTOCOL_VERSION,
  type CapabilityFlag,
  type Envelope,
  type RuntimeInfo,
  type ToolsetId,
} from '@byok-sdk/protocol';
import { AuthManager } from './auth-manager';
import type { CursorStore } from './cursor-store';
import type { DaemonHaltReason } from './daemon-lifecycle';
import { createFleetJitter, type FleetJitter } from './deterministic-jitter';
import { LongPollClient, type MessageBatchPostResult } from './long-poll-transport';

export { ReplayCursorTooOldError } from './replay-cursor';

/**
 * The daemon's one long-poll session: `open` from the moment the server
 * accepts this session's `conn.hello` until any route fails, `connecting`
 * otherwise.
 */
export type ConnectionState = 'connecting' | 'open';

/** The remote conditions that end a session for good. */
export type ConnectionHaltReason = Extract<DaemonHaltReason, 'device_revoked' | 'handshake_rejected' | 'replay_cursor_too_old'>;

/**
 * Server work requiring durable handler completion before acknowledgement.
 * `conn.*` frames (including `conn.ack`) carry a sequence only for schema
 * uniformity and never move this cursor.
 */
function isCursorEnvelopeType(type: Envelope['type']): boolean {
  return isServerToDaemonType(type) && !type.startsWith('conn.');
}

function createConnectionHelloEnvelope(
  opts: Pick<
    ConnectionManagerOptions,
    'deviceId' | 'productId' | 'capabilities' | 'clientVersion' | 'runtimes' | 'harnesses' | 'getConfiguredToolsets'
  >,
  getCursor: () => number | undefined,
): Envelope {
  const configuredToolsets = opts.getConfiguredToolsets?.();
  return createEnvelope('conn.hello', {
    protocolVersions: [PROTOCOL_VERSION],
    capabilities: opts.capabilities,
    deviceId: opts.deviceId,
    productId: opts.productId,
    clientVersion: opts.clientVersion,
    runtimes: opts.runtimes,
    harnesses: opts.harnesses,
    configuredToolsets: configuredToolsets === undefined ? undefined : [...configuredToolsets],
    cursor: getCursor(),
  });
}

export interface ConnectionManagerOptions {
  serverUrl: string;
  deviceId: string;
  productId: string;
  capabilities: CapabilityFlag[];
  /** U4a Local Agent release version, sent unchanged in `conn.hello`. */
  clientVersion?: string;
  runtimes: RuntimeInfo[];
  harnesses?: HarnessInfo[];
  /** Reads current sorted logical IDs from the validated local registry for every `conn.hello`. */
  getConfiguredToolsets?: () => readonly ToolsetId[];
  auth: AuthManager;
  cursorStore: CursorStore;
  /**
   * May return a promise; `ConnectionManager` awaits it before considering
   * this envelope "processed" (findings F2/F3 — see `deliver`/`process`
   * below). A handler that throws/rejects is caught here, not propagated.
   */
  onEnvelope: (envelope: Envelope) => void | Promise<void>;
  /** Every transition between `connecting` and `open`, starting with `connecting` from {@link ConnectionManager.start}. */
  onStateChange?: (state: ConnectionState) => void;
  /**
   * Called each time the server's advertisement newly carries a capability
   * the previous one did not — after every reconnect, the first advertisement
   * is new in full. Hooks that retry capability-gated sends wait here.
   */
  onCapabilitiesAdvertised?: (added: readonly string[]) => void;
  /** Await durable disposition before retiring the exact accepted/rejected bytes. */
  onOutboundAccepted?: (envelopes: readonly Envelope[]) => Promise<void>;
  onOutboundRejected?: (envelope: Envelope) => Promise<void>;
  onOutboundQueued?: (envelope: Envelope) => void;
  beforeOutboundPost?: (envelopes: readonly Envelope[]) => void;
  /** Base delay before each reconnect handshake, and for stalled-cycle and local-disposition backoff. Default 2s. */
  longPollRetryDelayMs?: number;
  /** Minimum delay before the next long-poll request after an empty (no-events) response. Default 250ms. */
  longPollIdleDelayMs?: number;
  fleetJitter?: FleetJitter;
  onOperationalOutcome?: (outcome: 'success' | 'failure', source: 'reconnect' | 'upload') => void;
  /** The session ended for good; nothing reconnects after this. Called once. */
  onHalted?: (reason: ConnectionHaltReason) => void;
}

export interface RejectedOutboundEnvelope {
  readonly envelope: Envelope;
  readonly reason: 'inbound_rejected';
}

const MAX_REJECTED_OUTBOX_ENTRIES = 1_000;

/**
 * Owns the daemon's one authenticated long-poll session with the server.
 * Every received envelope passes through the same cursor-dedupe/persistence
 * logic (protocol §9), so redelivery remains safe after a reconnect or a
 * daemon restart.
 *
 * One reconnect loop (`run`) owns the session. Each pass POSTs a lone
 * `conn.hello`; the server accepting it is what `open` means — it proves the
 * credentials, the device's enrollment, and the product and protocol match in
 * one round trip, without waiting for work or a held poll. Only an open
 * session polls and drains the outbox, so `conn.hello` is the first message
 * of every session, including after a reconnect (protocol §8). Any route
 * failure returns the session to `connecting` and the loop handshakes again
 * after `fleetJitter('reconnect')`. A rejected hello, a revoked device or a
 * lost replay cursor halts it instead.
 *
 * `send()` (Design B, finding N4) pushes onto a single shared outbox this
 * class owns and drains through `POST /byok/messages`; long-poll is a full
 * bidirectional transport, not a receive-only path. See `drainOutbox`.
 */
export class ConnectionManager {
  private readonly fleetJitter: FleetJitter;
  private readonly longPoll: LongPollClient;
  private uploadRetryAttempt = 0;
  private reconnectAttempt = 0;
  private started = false;
  private state: ConnectionState | undefined;
  /** Aborts the reconnect loop's in-flight handshake and backoff on stop or halt. */
  private readonly lifetime = new AbortController();
  /** Ends the current open session; set only while one is open. */
  private endSession: (() => void) | undefined;
  /** Counts open sessions, so a request from an ended session cannot end the next one. */
  private sessionGeneration = 0;
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
  /** Drain barrier for independently running handlers; not an admission lock. */
  private processingChain: Promise<void> = Promise.resolve();
  private cursorInitialization: Promise<void> | undefined;
  private completionTail: Promise<void> = Promise.resolve();
  private readonly controlTails = new Map<string, Promise<void>>();
  /**
   * Design B (finding N4): the ONE outbound queue holds `Envelope` OBJECTS,
   * never re-encoded/rebuilt strings, so a
   * resend after a failed send attempt is byte-identical to the original
   * (same `id`), which is what lets the server's per-(deviceId,id) dedup
   * (Wave 1) recognize it as a safe no-op retry rather than a second
   * application (protocol §9).
   */
  private readonly outbox: Envelope[] = [];
  /** Terminally rejected outbound envelopes, retained as a bounded observable quarantine. */
  private readonly rejectedOutboundEnvelopes: RejectedOutboundEnvelope[] = [];
  /**
   * Finding F5(b): how many envelopes `drainOutbox` has
   * currently spliced OUT of `this.outbox` for an in-flight (not yet
   * confirmed delivered) `postBatch` call — 0 the rest of the time. See
   * `outboxLength`'s own doc comment for why this needs to be tracked
   * separately from `this.outbox.length` at all.
   */
  private inFlightBatchSize = 0;
  private draining = false;
  private stopped = false;
  private haltReason: ConnectionHaltReason | undefined;
  private pendingCursorSave: Promise<void> = Promise.resolve();
  /** Admission dedup while an individual handler is running. */
  private readonly inFlightSeqs = new Set<number>();
  /** Successful side effects retained until their durable acknowledgement. */
  private readonly processedSeqs = new Set<number>();
  private readonly failedEnvelopes = new Map<number, Envelope>();
  /** Received work lacking a successful handler receipt, including malformed frames. */
  private readonly unresolvedSeqs = new Set<number>();
  /**
   * Finding P3: the pending local-disposition retry backoff in `drainOutbox`,
   * if any — cancellable so a halt or stop can unblock it immediately. See
   * `drainRetryDelay`.
   */
  private cancelPendingDrainRetry: (() => void) | undefined;
  /**
   * The capabilities the current server response advertised — untyped
   * `string[]` for forward compatibility. An advertisement is scoped to the
   * current session and is cleared when it ends (a route failure, stop, or
   * halt). This keeps capability-gated outbound messages fail-closed until
   * the current server has explicitly advertised support.
   */
  private serverCapabilities: string[] = [];

  constructor(private readonly opts: ConnectionManagerOptions) {
    this.fleetJitter = opts.fleetJitter ?? createFleetJitter(opts.productId, opts.deviceId);
    this.longPoll = new LongPollClient({
      serverUrl: opts.serverUrl,
      auth: opts.auth,
      // The long-poll query cursor is also the kernel's irreversible ack.
      // Only report the successfully persisted cursor; using received work
      // on the wire would ack an
      // in-flight envelope before its handler settles and make a later
      // failure impossible to redeliver.
      getCursor: () => this.cursor,
      onEnvelope: (envelope) => this.deliver(envelope),
      onServerCapabilities: (capabilities) => this.applyServerCapabilities(capabilities),
      onLoopFailure: () => this.breakSession(),
      onRevoked: () => this.halt('device_revoked'),
      onReplayCursorTooOld: (error) => {
        console.error(`[byok/client] ${error.message}`);
        this.halt('replay_cursor_too_old');
      },
      // Unknown and malformed executable work use the same ordered stall.
      onValidationFailedSeq: (seq) => this.noteValidationFailure(seq),
      // Finding P2 (Fix 2a): lets the long-poll loop distinguish "this
      // non-empty batch was a stalled backlog re-pull, no cursor progress
      // was made" from ordinary forward progress, so it can back off
      // instead of spinning at RTT — see `LongPollClient`'s own doc comment
      // on `isStalled`.
      isStalled: () => this.stalledAtSeq !== undefined,
      retryDelayMs: opts.longPollRetryDelayMs,
      retryDelayForAttempt: (attempt, baseMs) => this.fleetJitter.delay('reconnect', attempt, baseMs),
      onOperationalOutcome: (outcome) => {
        if (outcome === 'success') this.reconnectAttempt = 0;
        opts.onOperationalOutcome?.(outcome, 'reconnect');
      },
      idleDelayMs: opts.longPollIdleDelayMs,
    });
  }

  /**
   * Loads the durable cursor and starts the reconnect loop. Resolves without
   * waiting for the server: {@link ConnectionManagerOptions.onStateChange}
   * reports `open`, and {@link ConnectionManagerOptions.onHalted} a halt.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.cursor = await this.opts.cursorStore.load(this.opts.serverUrl, this.opts.deviceId);
    this.started = true;
    void this.run();
  }

  /**
   * The one reconnect loop. Each pass handshakes with a lone `conn.hello`,
   * then serves an open session until it ends, then backs off with
   * `fleetJitter('reconnect')` before the next handshake.
   */
  private async run(): Promise<void> {
    const signal = this.lifetime.signal;
    while (!this.isEnded()) {
      this.setState('connecting');
      const hello = createConnectionHelloEnvelope(this.opts, () => this.cursor);
      const answer = await this.longPoll.postBatch([hello], signal);
      if (this.isEnded()) return;
      if (answer !== undefined && (answer.rejected ?? 0) > 0) {
        console.error('[byok/client] the server rejected this device\'s conn.hello; the daemon halts (re-pair, or check product and protocol version)');
        this.halt('handshake_rejected');
        return;
      }
      if (answer === undefined) {
        this.opts.onOperationalOutcome?.('failure', 'reconnect');
      } else {
        await this.serveSession(answer);
        if (this.isEnded()) return;
      }
      const baseMs = this.opts.longPollRetryDelayMs ?? 2000;
      await sleep(this.fleetJitter.delay('reconnect', this.reconnectAttempt++, baseMs), signal);
    }
  }

  /** One open session: from an accepted handshake until a route failure, stop, or halt ends it. */
  private async serveSession(handshake: MessageBatchPostResult): Promise<void> {
    const ended = new Promise<void>((resolve) => {
      this.endSession = resolve;
    });
    this.sessionGeneration += 1;
    // Capabilities first: work an `open` observer queues sees them already.
    if (handshake.capabilities !== undefined) this.applyServerCapabilities(handshake.capabilities);
    this.setState('open');
    this.longPoll.start();
    void this.drainOutbox();
    await ended;
    this.endSession = undefined;
    this.longPoll.stop();
    // Long-poll has no persistent peer identity: once a route failed, the
    // responder behind the next request need not support what this one
    // advertised. Withdraw the advertisement with the session.
    this.serverCapabilities = [];
  }

  /**
   * A route failed: back to `connecting` synchronously, so nothing queued in
   * the meantime is sent ahead of the next session's handshake.
   */
  private breakSession(): void {
    const end = this.endSession;
    if (end === undefined || this.isEnded()) return;
    this.endSession = undefined;
    this.setState('connecting');
    this.serverCapabilities = [];
    this.longPoll.stop();
    end();
  }

  private applyServerCapabilities(capabilities: readonly string[]): void {
    const added = capabilities.filter((flag) => !this.serverCapabilities.includes(flag));
    this.serverCapabilities = [...capabilities];
    if (added.length > 0) this.opts.onCapabilitiesAdvertised?.(added);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onStateChange?.(state);
  }

  private isEnded(): boolean {
    return this.stopped || this.haltReason !== undefined;
  }

  /**
   * Design B (finding N4): push onto the single shared outbox and try to
   * drain it now. Never routes directly to either transport itself — see
   * `drainOutbox`.
   */
  send(envelope: Envelope): void {
    this.outbox.push(envelope);
    this.opts.onOutboundQueued?.(envelope);
    void this.drainOutbox();
  }

  /** Publish a fresh local configuration snapshot while this daemon is running. */
  refreshHello(): void {
    if (!this.started || this.isEnded()) return;
    this.send(createConnectionHelloEnvelope(this.opts, () => this.cursor));
  }

  /**
   * POSTs the outbox through long-poll in chunks of at most
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
   * Wave 1's server-side dedup expects). A route failure ends the session —
   * the reconnect loop handshakes again and the next open session resumes
   * the drain; a local durable-disposition failure is retried within the
   * session after a short backoff.
   * Runs only while the session is open, so it never sends ahead of the
   * session's `conn.hello`. Re-entrancy is guarded by `draining`: a call
   * arriving while a drain is already in progress just returns — the
   * in-progress loop's own `while (this.outbox.length > 0)` check picks up
   * anything newly pushed.
   */
  private async drainOutbox(): Promise<void> {
    if (this.state !== 'open' || this.isEnded() || this.draining) return;
    this.draining = true;
    // Frozen v1 has no rejected ids. A finite FIFO therefore replays an
    // immutable rejected segment by halves; accepted replays are server-dedup
    // success and a rejected singleton reaches bounded quarantine. A missing
    // response returns the same current segment plus untouched siblings for
    // the ordinary backoff path below. At most 2n - 1 POSTs occur per batch.
    type Retained = { readonly envelopes: Envelope[]; readonly cause: 'route' | 'local' };
    const isolateRejectedBatch = async (batch: readonly Envelope[]): Promise<Retained | undefined> => {
      const pending: Envelope[][] = [[...batch]];
      while (pending.length > 0) {
        if (this.isEnded()) return { envelopes: pending.flat(), cause: 'route' };

        const segment = pending.shift()!;
        try {
          this.opts.beforeOutboundPost?.(segment);
          const result = await this.longPoll.postBatch(segment);
          if (result === undefined) return { envelopes: [...segment, ...pending.flat()], cause: 'route' };
          if (result.capabilities !== undefined) this.applyServerCapabilities(result.capabilities);
          if ((result.rejected ?? 0) === 0) {
            await this.opts.onOutboundAccepted?.(segment);
            continue;
          }
          if (segment.length === 1) {
            if (segment[0]!.type === 'conn.hello') {
              // A refreshed snapshot is a handshake like any other.
              this.halt('handshake_rejected');
              return undefined;
            }
            await this.opts.onOutboundRejected?.(segment[0]!);
            this.quarantineRejectedOutbound(segment[0]!, 'inbound_rejected');
            continue;
          }
        } catch (error) {
          // A committed cloud receipt with a lost local confirmation is still
          // pending locally. Retry the SAME bytes; never drop them in finally.
          console.error('[byok/client] outbound durable disposition failed; retaining exact batch', error);
          return { envelopes: [...segment, ...pending.flat()], cause: 'local' };
        }

        const midpoint = Math.floor(segment.length / 2);
        pending.unshift(segment.slice(0, midpoint), segment.slice(midpoint));
      }
      return undefined;
    };
    try {
      while (this.outbox.length > 0) {
        if (this.state !== 'open' || this.isEnded()) return;

        const generation = this.sessionGeneration;
        const batch = this.outbox.splice(0, MAX_MESSAGES_PER_BATCH);
        // Finding F5(b): tracked for the DURATION of the `postBatch` await —
        // `batch` has already left `this.outbox` (spliced out above) but
        // isn't confirmed delivered yet, so a plain `this.outbox.length`
        // read right now would UNDERCOUNT it entirely (this is exactly what
        // a stalled/hung `postBatch` call means: neither queued nor
        // delivered, just stuck). See `outboxLength`'s own doc comment.
        this.inFlightBatchSize = batch.length;
        let retained: Retained | undefined;
        try {
          retained = await isolateRejectedBatch(batch);
        } finally {
          this.inFlightBatchSize = 0;
        }
        if (retained === undefined) {
          if (this.isEnded()) return;
          this.uploadRetryAttempt = 0;
          this.opts.onOperationalOutcome?.('success', 'upload');
          continue;
        }

        this.opts.onOperationalOutcome?.('failure', 'upload');

        this.outbox.unshift(...retained.envelopes); // retry, preserving order — same objects, same ids (finding F1)
        // Finding P3: a halted session (a revoked device, say) can never
        // recover without operator action — retrying would spin forever and
        // keep the process alive for no reason. `postBatch`'s own
        // DeviceRevokedError handling has already halted the session
        // (synchronously, before `postBatch` resolves), so this check catches
        // it before any backoff is scheduled.
        if (this.isEnded()) return;
        if (retained.cause === 'route') {
          // A request of an earlier session failed after a newer one opened:
          // that session's handshake has already gone first, so retry now.
          if (generation !== this.sessionGeneration) continue;
          // The next session's handshake goes first, then the drain resumes.
          this.breakSession();
          return;
        }
        const baseMs = this.opts.longPollRetryDelayMs ?? 2000;
        await this.drainRetryDelay(this.fleetJitter.delay('upload', this.uploadRetryAttempt++, baseMs));
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Finding P3: backoff delay for `drainOutbox`'s local-disposition retry.
   * Unlike a plain `setTimeout`-based wait, this is (a) cancellable —
   * `halt()` and `stop()` call `cancelPendingDrainRetry()` to unblock an
   * in-flight wait immediately instead of leaving `drainOutbox` parked here
   * for up to the rest of the delay before it next checks the session —
   * and (b) unref'd, so the timer never keeps the Node process alive by
   * itself while nothing else (such as the live long-poll GET) legitimately is.
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

  /**
   * The capabilities the current session's server advertised — on the
   * handshake answer or a poll response. Empty before either and after the
   * session ends.
   */
  getServerCapabilities(): readonly string[] {
    return this.serverCapabilities;
  }

  /** True while the server has accepted this session's `conn.hello` and no route has failed since. */
  isOpen(): boolean {
    return this.state === 'open' && !this.isEnded();
  }

  /** Why the session ended for good, if it did. */
  getHaltReason(): ConnectionHaltReason | undefined {
    return this.haltReason;
  }

  /** The device was found revoked outside this session's own requests (proactive token renewal). */
  noteDeviceRevoked(): void {
    this.halt('device_revoked');
  }

  /**
   * Stops the long-poll transport and waits for every in-flight envelope handler
   * (the F3 FIFO chain) and the most recent cursor write to actually land on
   * disk — otherwise a `stop()` racing a just-processed envelope's
   * persistence could lose that cursor advance, or leave a handler running
   * unobserved after the daemon reports itself stopped.
   *
   * Finding F5(b) (cross-model adversarial review): `drainTimeoutMs`, when
   * passed, bounds how long this waits for the shared outbox (`this.outbox`
   * — Design B) to actually finish draining BEFORE flipping `this.stopped`
   * and stopping the transport. Before this fix, `stop()` set `stopped`
   * synchronously and never waited for `drainOutbox` at all: an envelope
   * `send()` had just pushed moments earlier (e.g. `TaskRunner.shutdownTask`'s
   * own `task.fail`, sent right before `create-daemon.ts`'s
   * `performControlShutdown` calls this) could still be sitting UNSENT in
   * `this.outbox` — mid long-poll retry backoff, or simply not yet picked up
   * by the fire-and-forget `drainOutbox()` `send()` kicked off — and this
   * method would happily proceed to `stopped = true` regardless,
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
    this.lifetime.abort();
    this.longPoll.stop();
    this.cancelPendingDrainRetry?.();
    this.endSession?.();
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

  /** A bounded terminal quarantine for operator inspection; these entries are never retried. */
  rejectedOutbox(): readonly RejectedOutboundEnvelope[] {
    return this.rejectedOutboundEnvelopes;
  }

  /**
   * Finding F5(b): polls {@link outboxLength} (not `this.outbox.length`
   * alone — see that method's own doc comment for why a spliced-out,
   * in-flight batch would otherwise be invisible here) rather than hooking
   * a single `drainOutbox()` promise directly — a drain in progress can
   * itself loop through multiple retry/backoff cycles (`drainRetryDelay`)
   * while the server is unreachable, and a fresh, INDEPENDENT
   * `drainOutbox()` call can also be triggered concurrently (`send()`) —
   * polling the one thing
   * that actually matters (is anything still undelivered) can never go
   * stale the way capturing one specific in-flight promise reference
   * could. Kicks off one more `drainOutbox()` attempt itself first
   * (harmless no-op if one is already running — see its own re-entrancy
   * guard) in case nothing is currently actively retrying, so this bounded
   * wait isn't just passively hoping something else happens to be making
   * progress.
   */
  private waitForOutboxDrained(timeoutMs: number): Promise<void> {
    if (this.outboxLength() === 0) return Promise.resolve();
    void this.drainOutbox();
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const poll = (): void => {
        if (this.outboxLength() === 0 || this.isEnded() || Date.now() >= deadline) {
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
   *   handlers may run independently; their receipt commits are serialized.
   *   The cursor only advances
   *   AFTER the handler resolves successfully; a rejection leaves the
   *   cursor where it was (see `stalledAtSeq`), so a future reconnect's
   *   redelivery re-attempts it — safe because every server->daemon type is
   *   documented idempotent (protocol §9).
   */
  private deliver(envelope: Envelope): boolean {
    if (!isServerToDaemonType(envelope.type)) {
      if (typeof envelope.seq === 'number') this.noteValidationFailure(envelope.seq);
      return false;
    }
    const tracked = isCursorEnvelopeType(envelope.type) && typeof envelope.seq === 'number';
    const watermark = this.dedupWatermark();
    if (tracked && watermark !== undefined && envelope.seq! <= watermark) return false; // redelivered — idempotent skip (protocol §9)

    if (tracked) {
      const seq = envelope.seq!;
      if (this.inFlightSeqs.has(seq)) return false;
      if (!this.processedSeqs.has(seq)) this.unresolvedSeqs.add(seq);
      this.inFlightSeqs.add(seq);
    }

    // Startup owns its own lifetime. Controls for that task can reach it;
    // controls among themselves retain arrival order.
    const controlKey = envelope.task_id !== undefined && !envelope.type.startsWith('task.offer')
      ? envelope.task_id : undefined;
    const prior = controlKey === undefined ? Promise.resolve() : (this.controlTails.get(controlKey) ?? Promise.resolve());
    const operation = prior.then(() => this.process(envelope, tracked));
    if (controlKey !== undefined) {
      this.controlTails.set(controlKey, operation);
      void operation.finally(() => {
        if (this.controlTails.get(controlKey) === operation) this.controlTails.delete(controlKey);
      });
    }
    this.processingChain = Promise.all([this.processingChain, operation]).then(() => undefined);
    return true;
  }

  /** A committed terminal can settle a failed offer receipt even if cloud
   * cancellation has since filtered that offer from mailbox replay. */
  retryTaskReceipts(taskId: string): void {
    for (const envelope of this.failedEnvelopes.values()) {
      if (envelope.task_id === taskId) this.deliver(envelope);
    }
  }

  /** Only a durable acknowledgement can deduplicate a whole prefix. */
  private dedupWatermark(): number | undefined {
    return this.cursor;
  }

  private async process(envelope: Envelope, tracked: boolean): Promise<void> {
    const seq = tracked ? envelope.seq! : undefined;
    try {
      if (tracked && seq! <= (this.cursor ?? 0)) return;
      // An absent cursor means "this device has never accepted tracked
      // delivery", so reconnect handshakes omit it and a server correctly
      // sends no backlog. Persist zero before the very first handler side
      // effect so a crash/failure during that handler is distinguishable
      // from a genuinely first-ever connection and can request seq > 0.
      if (tracked && this.cursor === undefined) {
        this.cursorInitialization ??= this.opts.cursorStore.save(this.opts.serverUrl, this.opts.deviceId, 0)
          .then(() => { this.cursor = 0; })
          .catch(error => { this.cursorInitialization = undefined; throw error; });
        await this.cursorInitialization;
      }
      if (!tracked || !this.processedSeqs.has(seq!)) await this.opts.onEnvelope(envelope);
      if (!tracked) return;
      this.failedEnvelopes.delete(seq!);
      this.processedSeqs.add(seq!);
      this.unresolvedSeqs.delete(seq!);
      const completion = this.completionTail.catch(() => undefined).then(async () => {
        let firstUnresolved = Infinity;
        for (const value of this.unresolvedSeqs) firstUnresolved = Math.min(firstUnresolved, value);
        let prefix = this.cursor ?? 0;
        for (const value of this.processedSeqs) if (value < firstUnresolved) prefix = Math.max(prefix, value);
        if (prefix > (this.cursor ?? 0)) await this.advanceCursor(prefix);
        for (const value of this.processedSeqs) {
          if (value <= (this.cursor ?? 0)) {
            this.processedSeqs.delete(value);
            this.failedEnvelopes.delete(value);
          }
        }
        this.stalledAtSeq = this.unresolvedSeqs.size > 0 ? firstUnresolved : undefined;
      });
      this.completionTail = completion;
      await completion;
    } catch (err) {
      if (tracked) {
        this.failedEnvelopes.set(seq!, envelope);
        this.stalledAtSeq = Math.min(envelope.seq!, this.stalledAtSeq ?? Infinity);
      }
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

  /** Recorded synchronously at receive, before a later successful receipt can commit. */
  private noteValidationFailure(seq: number): void {
    this.unresolvedSeqs.add(seq);
    this.stalledAtSeq = Math.min(seq, this.stalledAtSeq ?? seq);
  }

  private async advanceCursor(seq: number): Promise<void> {
    if (this.cursor !== undefined && seq <= this.cursor) return;
    // A later redelivery may retry a failed save, but the failed save remains
    // observable to its current caller and this cursor is never exposed until
    // its own write resolves successfully.
    const save = this.pendingCursorSave
      .catch(() => undefined)
      .then(() => this.opts.cursorStore.save(this.opts.serverUrl, this.opts.deviceId, seq));
    this.pendingCursorSave = save;
    await save;
    this.cursor = seq;
  }

  private quarantineRejectedOutbound(envelope: Envelope, reason: 'inbound_rejected'): void {
    if (this.rejectedOutboundEnvelopes.length === MAX_REJECTED_OUTBOX_ENTRIES) this.rejectedOutboundEnvelopes.shift();
    this.rejectedOutboundEnvelopes.push({ envelope, reason });
    console.error(
      `[byok/client] outbound envelope ${envelope.id} was permanently rejected (${reason}) and moved to the terminal quarantine.`,
    );
  }

  /**
   * Ends the session for good: stops the loop, the poll and the drain, then
   * reports the reason once. The outbox keeps whatever it held, so
   * `outboxLength()` stays an honest count of what never left.
   */
  private halt(reason: ConnectionHaltReason): void {
    if (this.isEnded()) return;
    this.haltReason = reason;
    this.serverCapabilities = [];
    this.lifetime.abort();
    this.longPoll.stop();
    this.cancelPendingDrainRetry?.();
    this.endSession?.();
    this.opts.onHalted?.(reason);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}
