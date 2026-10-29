import type { HarnessInfo } from '@byok-sdk/protocol';
import {
  type OutboundRefusalReason,
  type ActivityIngress,
  MAX_MESSAGES_PER_BATCH,
  MESSAGES_SEND_MAX_BODY_BYTES,
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
import { LongPollClient, type CorrelatedOutcome, type MessageBatchPostResult } from './long-poll-transport';

export { ReplayCursorTooOldError } from './replay-cursor';

/**
 * #1121: the most bytes of droppable envelopes the outbox holds while the
 * Host is unreachable. Past it the oldest of them are dropped unsent.
 */
export const MAX_OUTBOX_EPHEMERAL_BYTES = 8 * 1024 * 1024;
/** Envelopes the outbox may drop under {@link MAX_OUTBOX_EPHEMERAL_BYTES}: live views whose loss leaves a gap, not a wrong state. */
const OUTBOX_DROPPABLE_TYPES: ReadonlySet<Envelope['type']> = new Set(['task.progress', 'agent.message.draft']);

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
 * `conn.*` frames never move this cursor.
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
  onOutboundSettled?: (settlements: readonly OutboundSettlement[]) => Promise<void>;
  onOutboundQueued?: (envelope: Envelope) => void;
  /** An ephemeral envelope left the outbox unsent because the outbox passed {@link MAX_OUTBOX_EPHEMERAL_BYTES}. */
  onOutboundDropped?: (envelope: Envelope) => void;
  beforeOutboundPost?: (envelopes: readonly Envelope[]) => void;
  /**
   * Base of the capped exponential backoff (`backoffCeilingMs`) before each
   * reconnect handshake, and for stalled-cycle and local-disposition retries.
   * A route's `Retry-After` lengthens the reconnect wait. Default 2s.
   */
  longPollRetryDelayMs?: number;
  /** Minimum delay before the next long-poll request after an empty (no-events) response. Default 250ms. */
  longPollIdleDelayMs?: number;
  fleetJitter?: FleetJitter;
  onOperationalOutcome?: (outcome: 'success' | 'failure', source: 'reconnect' | 'upload') => void;
  /** The session ended for good; nothing reconnects after this. Called once. */
  onHalted?: (reason: ConnectionHaltReason) => void;
  /**
   * An observer callback ({@link onStateChange}, {@link onCapabilitiesAdvertised})
   * or the reconnect loop itself threw. The session ends for good, as for a
   * halt: nothing reconnects. Called once, never for a halt or a stop.
   */
  onCrashed?: (error: unknown) => void;
}

/** One outbound envelope's settlement; only a rejection has a reason, and it always has one. */
export type OutboundSettlement =
  | { readonly envelope: Envelope; readonly outcome: 'accepted' | 'duplicate' }
  | { readonly envelope: Envelope; readonly outcome: 'rejected'; readonly reason: OutboundRefusalReason };

function settlementFor(envelope: Envelope, outcome: CorrelatedOutcome): OutboundSettlement {
  return outcome.outcome === 'rejected'
    ? { envelope, outcome: 'rejected', reason: outcome.reason }
    : { envelope, outcome: outcome.outcome };
}

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
 * after the capped exponential `fleetJitter('reconnect')`, or the server's
 * `Retry-After` when that is longer. A rejected hello, a revoked device or a
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
  /**
   * The latest server-advertised activity ingress. Every accepted handshake
   * answer and every events page carries one, so it is set before any session
   * opens; there is no client-side default.
   */
  private ingressBudget: ActivityIngress | undefined;
  /**
   * Finding F5(b): the envelopes `drainOutbox` has
   * currently spliced OUT of `this.outbox` for an in-flight (not yet
   * confirmed delivered) `postBatch` call — empty the rest of the time. See
   * `outboxLength`'s own doc comment for why this needs to be tracked
   * separately from `this.outbox` at all.
   */
  private inFlightBatch: readonly Envelope[] = [];
  /**
   * Every id in `outbox` or `inFlightBatch`, mapped to its encoded size when
   * the envelope is droppable and 0 otherwise. `send()` dedups against it in
   * O(1), and `ephemeralBytes` is the sum of its values.
   */
  private readonly queuedIds = new Map<string, number>();
  private ephemeralBytes = 0;
  private draining = false;
  private stopped = false;
  private haltReason: ConnectionHaltReason | undefined;
  private crashed = false;
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
  /** The longest `Retry-After` a route answered since the last reconnect wait; see `nextReconnectDelayMs`. */
  private retryAfterMs = 0;
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
      onIngress: (ingress) => { this.ingressBudget = ingress; },
      onServerCapabilities: (capabilities) => this.applyServerCapabilities(capabilities),
      onLoopFailure: () => this.breakSession(),
      onRetryAfter: (delayMs) => { this.retryAfterMs = Math.max(this.retryAfterMs, delayMs); },
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
        this.notify(() => opts.onOperationalOutcome?.(outcome, 'reconnect'));
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
    void this.run().catch((error: unknown) => this.crash(error));
  }

  /**
   * The one reconnect loop. Each pass handshakes with a lone `conn.hello`,
   * then serves an open session until it ends, then backs off with
   * `fleetJitter('reconnect')` before the next handshake.
   */
  private async run(): Promise<void> {
    const signal = this.lifetime.signal;
    let hello: Envelope | undefined;
    while (!this.isEnded()) {
      this.setState('connecting');
      if (this.isEnded()) return;
      hello ??= createConnectionHelloEnvelope(this.opts, () => this.cursor);
      const answer = await this.longPoll.postBatch([hello], signal);
      if (this.isEnded()) return;
      if (answer !== undefined) {
        try {
          await this.opts.onOutboundSettled?.([settlementFor(hello, answer.outcomes[0]!)]);
        } catch {
          this.notify(() => this.opts.onOperationalOutcome?.('failure', 'reconnect'));
          await sleep(this.nextReconnectDelayMs(), signal);
          continue;
        }
      }
      if (answer !== undefined && (answer.rejected ?? 0) > 0) {
        console.error('[byok/client] the server rejected this device\'s conn.hello; the daemon halts (re-pair, or check product and protocol version)');
        this.halt('handshake_rejected');
        return;
      }
      if (answer === undefined) {
        this.notify(() => this.opts.onOperationalOutcome?.('failure', 'reconnect'));
      } else {
        await this.serveSession(answer);
        hello = undefined;
        if (this.isEnded()) return;
      }
      await sleep(this.nextReconnectDelayMs(), signal);
    }
  }

  /**
   * The wait before the next handshake: the capped exponential
   * `fleetJitter('reconnect')` for this attempt, or the server's last
   * `Retry-After` when that is longer. A `Retry-After` is consumed by the one
   * wait it lengthens.
   */
  private nextReconnectDelayMs(): number {
    const backoff = this.fleetJitter.delay('reconnect', this.reconnectAttempt++, this.opts.longPollRetryDelayMs ?? 2000);
    const delay = Math.max(backoff, this.retryAfterMs);
    this.retryAfterMs = 0;
    return delay;
  }

  /** One open session: from an accepted handshake until a route failure, stop, or halt ends it. */
  private async serveSession(handshake: MessageBatchPostResult): Promise<void> {
    const ended = new Promise<void>((resolve) => {
      this.endSession = resolve;
    });
    this.sessionGeneration += 1;
    // Capabilities first: work an `open` observer queues sees them already.
    // `postBatch` refuses an accepted handshake answer without `ingress`.
    this.ingressBudget = handshake.ingress;
    if (handshake.capabilities !== undefined) this.applyServerCapabilities(handshake.capabilities);
    this.setState('open');
    // An `open` observer that threw has already ended the session.
    if (!this.isEnded()) {
      this.longPoll.start();
      void this.drainOutbox();
    }
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
    if (added.length > 0) this.notify(() => this.opts.onCapabilitiesAdvertised?.(added));
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.notify(() => this.opts.onStateChange?.(state));
  }

  /**
   * Observer callbacks run inside the reconnect loop, the poll loop and the
   * drain. A throw there is a crash of this connection, never a route
   * failure to retry or an unhandled rejection.
   */
  private notify(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.crash(error);
    }
  }

  private isEnded(): boolean {
    return this.stopped || this.haltReason !== undefined || this.crashed;
  }

  /**
   * Design B (finding N4): push onto the single shared outbox and try to
   * drain it now. Never routes directly to either transport itself — see
   * `drainOutbox`.
   * An id still queued or in flight is not queued again, so a timer retry
   * during an outage keeps one copy in its original place (#693).
   * An ended session (halted, crashed or stopped) queues nothing, so its
   * outbox cannot grow; a terminal is journaled before it is sent (#1119).
   */
  send(envelope: Envelope): void {
    if (this.isEnded()) return;
    if (!this.queuedIds.has(envelope.id)) {
      const bytes = OUTBOX_DROPPABLE_TYPES.has(envelope.type) ? Buffer.byteLength(JSON.stringify(envelope)) : 0;
      this.queuedIds.set(envelope.id, bytes);
      this.ephemeralBytes += bytes;
      this.outbox.push(envelope);
      this.opts.onOutboundQueued?.(envelope);
      if (this.ephemeralBytes > MAX_OUTBOX_EPHEMERAL_BYTES) this.dropOldestEphemeral();
    }
    void this.drainOutbox();
  }

  /** The envelope left the outbox for good: settled, filtered out, or dropped. */
  private forget(envelope: Envelope): void {
    this.ephemeralBytes -= this.queuedIds.get(envelope.id) ?? 0;
    this.queuedIds.delete(envelope.id);
  }

  /**
   * #1121: an outage must not grow the outbox without bound. Over the cap, the
   * oldest queued `task.progress` and `agent.message.draft` envelopes are
   * dropped until it fits again. Nothing else is ever dropped: terminals are
   * journaled and resent from the journal, and claim, started and approval
   * envelopes carry task state. The Host tolerates a gap in progress seqs.
   * An envelope already in flight is not dropped.
   */
  private dropOldestEphemeral(): void {
    let dropped = 0;
    for (let index = 0; index < this.outbox.length && this.ephemeralBytes > MAX_OUTBOX_EPHEMERAL_BYTES;) {
      const envelope = this.outbox[index]!;
      if (!OUTBOX_DROPPABLE_TYPES.has(envelope.type)) { index++; continue; }
      this.outbox.splice(index, 1);
      this.forget(envelope);
      dropped++;
      this.opts.onOutboundDropped?.(envelope);
    }
    if (dropped > 0) {
      console.warn(`[byok/client] outbox passed ${MAX_OUTBOX_EPHEMERAL_BYTES} bytes of progress; dropped ${dropped} oldest ephemeral envelope(s) unsent`);
    }
  }

  /** Publish a fresh local configuration snapshot while this daemon is running. */
  refreshHello(): void {
    if (!this.started || this.isEnded()) return;
    this.send(createConnectionHelloEnvelope(this.opts, () => this.cursor));
  }

  /**
   * POSTs the outbox through long-poll in chunks of at most
   * `MAX_MESSAGES_PER_BATCH` envelopes and `MESSAGES_SEND_MAX_BODY_BYTES` of
   * encoded body (one envelope always goes; the cloud answers 413 above the
   * byte cap, and sealed envelopes reach about 350 KB each). Finding P1:
   * the server hard-caps a single
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
    // One POST per chunk. The answer correlates every envelope (protocol v3),
    // so each settles with its own outcome; a missing or unusable answer
    // retains the exact chunk for the ordinary retry paths below.
    type Retained = { readonly envelopes: Envelope[]; readonly cause: 'route' | 'local' };
    const postAndSettle = async (batch: Envelope[]): Promise<Retained | undefined> => {
      if (this.isEnded()) return { envelopes: batch, cause: 'route' };
      try {
        this.opts.beforeOutboundPost?.(batch);
        const result = await this.longPoll.postBatch(batch);
        if (result === undefined) return { envelopes: batch, cause: 'route' };
        if (result.ingress !== undefined) this.ingressBudget = result.ingress;
        if (result.capabilities !== undefined) this.applyServerCapabilities(result.capabilities);
        const byId = new Map(result.outcomes.map((outcome) => [outcome.id, outcome]));
        await this.opts.onOutboundSettled?.(batch.map((envelope) => settlementFor(envelope, byId.get(envelope.id)!)));
        // A refreshed snapshot is a handshake like any other.
        if (batch.some((envelope) => envelope.type === 'conn.hello' && byId.get(envelope.id)!.outcome === 'rejected')) {
          this.halt('handshake_rejected');
        }
        return undefined;
      } catch (error) {
        // A committed cloud receipt with a lost local confirmation is still
        // pending locally. Retry the SAME bytes; never drop them in finally.
        console.error('[byok/client] outbound durable disposition failed; retaining exact batch', error);
        return { envelopes: batch, cause: 'local' };
      }
    };
    try {
      while (this.outbox.length > 0) {
        if (this.state !== 'open' || this.isEnded()) return;

        const generation = this.sessionGeneration;
        // Cut at the count cap or before the encoded body would pass the byte cap
        // (`{"messages":[` + `]}` is 15 bytes, one comma between envelopes); one envelope always goes.
        let count = 0;
        for (let bytes = 14; count < Math.min(this.outbox.length, MAX_MESSAGES_PER_BATCH); count++) {
          bytes += Buffer.byteLength(JSON.stringify(this.outbox[count])) + 1;
          if (count > 0 && bytes > MESSAGES_SEND_MAX_BODY_BYTES) break;
        }
        let batch = this.outbox.splice(0, count);
        // serveSession applies handshake capabilities before opening this drain.
        // Re-gate queued drafts after reconnect; dropped drafts have no receipt.
        if (!this.serverCapabilities.includes('agent-message-draft')) {
          for (const envelope of batch) if (envelope.type === 'agent.message.draft') this.forget(envelope);
          batch = batch.filter(envelope => envelope.type !== 'agent.message.draft');
        }
        if (batch.length === 0) continue;
        // Finding F5(b): tracked for the DURATION of the `postBatch` await —
        // `batch` has already left `this.outbox` (spliced out above) but
        // isn't confirmed delivered yet, so a plain `this.outbox.length`
        // read right now would UNDERCOUNT it entirely (this is exactly what
        // a stalled/hung `postBatch` call means: neither queued nor
        // delivered, just stuck). See `outboxLength`'s own doc comment.
        this.inFlightBatch = batch;
        let retained: Retained | undefined;
        try {
          retained = await postAndSettle(batch);
        } finally {
          this.inFlightBatch = [];
        }
        if (retained === undefined) {
          for (const envelope of batch) this.forget(envelope);
          if (this.isEnded()) return;
          this.uploadRetryAttempt = 0;
          this.notify(() => this.opts.onOperationalOutcome?.('success', 'upload'));
          continue;
        }

        this.notify(() => this.opts.onOperationalOutcome?.('failure', 'upload'));

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
   * Deliberately `this.outbox.length + this.inFlightBatch.length`, NOT just
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
    return this.outbox.length + this.inFlightBatch.length;
  }

  /** Throws before the first advertisement: no work runs before an accepted handshake. */
  getIngressBudget(): Readonly<ActivityIngress> {
    if (this.ingressBudget === undefined) {
      throw new Error('no activity ingress has been advertised; the server has not accepted a handshake yet');
    }
    return { ...this.ingressBudget };
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
   * - F2 (redelivery dead on reconnect): cursor accounting covers only
   *   work envelopes. `conn.*` envelopes never advance the cursor, so a
   *   handshake frame can never make a backlog envelope's lower seq look
   *   already delivered.
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
    const controlKey = envelope.task_id !== undefined && envelope.type !== 'task.offer'
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

  /**
   * Ends the session for good: stops the loop, the poll and the drain, then
   * reports the reason once. The outbox keeps whatever it held and takes
   * nothing more, so `outboxLength()` stays an honest count of what never left.
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

  /** The defined end for an unexpected error: stop like a halt, then report it once. */
  private crash(error: unknown): void {
    if (this.isEnded()) return;
    this.crashed = true;
    this.serverCapabilities = [];
    this.lifetime.abort();
    this.longPoll.stop();
    this.cancelPendingDrainRetry?.();
    this.endSession?.();
    console.error('[byok/client] the connection crashed on an unexpected error and stops', error);
    try {
      this.opts.onCrashed?.(error);
    } catch (reportError) {
      console.error('[byok/client] reporting the connection crash failed', reportError);
    }
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
