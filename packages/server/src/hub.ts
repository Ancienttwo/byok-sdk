import type { WebSocket } from 'ws';
import {
  canTransition,
  createEnvelope,
  DAEMON_TO_SERVER_TYPES,
  encodeEnvelope,
  PROTOCOL_VERSION,
  TASK_STATES,
  type CreateEnvelopeOptions,
  type Envelope,
  type MessageType,
  type PermissionPolicy,
  type RuntimeInfo,
  type TaskApprovalResolvedPayload,
  type TaskArtifactPayload,
  type TaskAwaitApprovalPayload,
  type TaskCancelledPayload,
  type TaskClaimPayload,
  type TaskCompletePayload,
  type TaskDeclinePayload,
  type TaskFailPayload,
  type TaskProgressPayload,
  type TaskStartedPayload,
  type TaskState,
} from '@byok/protocol';
import type { DeviceRegistry } from './auth';
import { AsyncEventQueue } from './event-queue';
import { generateTaskId } from './ids';
import { RateLimiter } from './rate-limiter';
import type { TaskStore } from './task-store';
import type {
  ByokServerEvent,
  DispatchInput,
  HubStats,
  MachineInfo,
  ServerTaskEvent,
  TaskHandle,
  TaskResult,
  TaskSnapshot,
} from './types';

/**
 * M0 default policy when `dispatch()` is called without one. `TaskOfferPayload.policy`
 * is required on the wire even though our `dispatch()` input makes it optional, so we
 * need a safe default. Per the plan's fail-closed principle ("越权需要本地确认"),
 * default to `confirm` rather than the more permissive `auto`.
 */
const DEFAULT_POLICY: PermissionPolicy = { mode: 'confirm' };

/** Per-device redelivery ring buffer size (§9: "keep the last K envelopes per device"). */
const OUTBOX_RING_CAPACITY = 500;

/** Per-device idempotency window (N3): how many recent inbound envelope ids {@link ConnectionHub.handleInbound} remembers for dedup, oldest evicted first once full. */
const DEDUP_RING_CAPACITY = 1024;

/**
 * Upper bound on the task-lease reaper's sweep-tick period (see
 * `ConnectionHub`'s constructor and its `sweepLeases` method, in the
 * "task-lease reaper" section below). A short (e.g. test-injected)
 * `taskLeaseMs` sweeps at its own granularity so it's still checked
 * promptly; a realistic multi-minute lease sweeps at this fixed, cheap
 * resolution instead of scaling the interval down with it.
 */
const MAX_LEASE_REAPER_SWEEP_INTERVAL_MS = 30_000;

function isTerminal(state: TaskState): state is Extract<TaskState, 'Complete' | 'Failed' | 'Cancelled'> {
  return state === 'Complete' || state === 'Failed' || state === 'Cancelled';
}

/** Claimed/Running/AwaitApproval — the task-lease reaper's reapable set. `Offered` is excluded: it has no owning device yet, so there's nothing to be "dark". */
function isClaimedState(state: TaskState): state is Extract<TaskState, 'Claimed' | 'Running' | 'AwaitApproval'> {
  return state === 'Claimed' || state === 'Running' || state === 'AwaitApproval';
}

/** A device's live transport (WS or long-poll — never both, §8) plus last-known metadata. */
interface ConnectionState {
  ws?: WebSocket;
  connected: boolean;
  lastSeen: string;
  runtimes?: RuntimeInfo[];
  /**
   * Epoch-ms instant this device most recently transitioned from alive to
   * dark (set by {@link ConnectionHub.handleDisconnect}), or `undefined`
   * while alive. This is the task-lease reaper's condition (b) clock start —
   * kept independent of any task's own last-activity timestamp so that a
   * task idle-past-TTL while still connected still gets a fresh, full
   * `taskLeaseMs` countdown from the moment its device actually went dark,
   * not from however stale that activity already was (see `sweepLeases`'s
   * doc comment for the bug this fixes).
   */
  darkSince?: number;
}

/** One envelope this server has sent (or would have sent) to a device, retained for redelivery. */
interface OutboxEntry {
  seq: number;
  /** Absent for `conn.ack` (not task-scoped) — such entries are never redelivered/polled. */
  taskId?: string;
  envelope: Envelope;
  /**
   * N1/F4: `task.cancel`/`task.reject` move their task to a terminal state
   * *before* being queued here (`cancelTask`/`rejectTask`'s own
   * mark-terminal-then-send order) — without this flag, `collectRelevant`'s
   * terminal-task filter would always exclude them, so a daemon that missed
   * the live send (e.g. dropped mid-cancel) could never have it
   * redelivered. Only those two types set this (see `sendToDevice`);
   * `task.approve`/`task.steer` never fire on an already-terminal task in
   * the first place (`approveTask`/`steerTask` both require a specific
   * non-terminal state), so the exemption would be moot for them.
   */
  redeliverThroughTerminal?: boolean;
}

/** Per-device outbound sequence counter + bounded history (§1.2, §9). */
interface DeviceOutbox {
  nextSeq: number;
  ring: OutboxEntry[];
}

interface LongPollWaiter {
  cursor: number;
  resolve: (result: { events: Envelope[]; cursor: number }) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface TaskRuntime {
  queue: AsyncEventQueue<ServerTaskEvent>;
  resolveResult: (result: TaskResult) => void;
  result: Promise<TaskResult>;
}

/** Fields hub.ts ever patches alongside a state transition. */
type TaskPatch = Partial<Pick<TaskSnapshot, 'deviceId' | 'sessionRef' | 'result'>>;

/**
 * The connection hub: tracks each device's live transport (WS or long-poll —
 * never both at once, see {@link takeOverAsLongPoll}), routes `dispatch()`'d
 * tasks to a device, and processes inbound task.* envelopes from daemons.
 *
 * Routing (M1): every `task.*` envelope carries a *required* envelope
 * `task_id` — the sole routing key, both directions. No payload duplicates
 * it, and none of the handlers below need to guard against a missing one
 * (the wire schema already rejects such an envelope before it reaches here).
 *
 * Inbound gate ({@link handleInbound}): the single choke point both
 * transports (`ws-server.ts`'s WS message handler, `http.ts`'s
 * `POST /byok/messages`) call instead of reaching into per-type handlers
 * directly. Runs, in order: (1) type-allow — only `DAEMON_TO_SERVER_TYPES`
 * may pass, a server -> daemon type arriving inbound is rejected (P2); (2)
 * ownership (N2) — an envelope for a task already owned by a *different*
 * device is dropped and logged, never force-failed (force-failing on an
 * authz mismatch would let an attacker who merely guesses a `taskId` kill
 * the real owner's task); (3) dedup (N3) — an envelope `id` already seen
 * from this device is a no-op, making the at-least-once wire (§9)
 * effectively at-most-once server-side; (4) dispatch to the per-type
 * handler. Because ownership is enforced once, centrally, here, the
 * handlers below no longer carry their own device-mismatch checks.
 *
 * Outbound delivery (M1, §1.2/§9): every server -> daemon envelope
 * (`conn.ack`, `task.offer/approve/reject/cancel/steer`) gets a fresh
 * per-device monotonic `seq` and is retained in a capped ring buffer
 * ({@link OUTBOX_RING_CAPACITY} entries) so it can be redelivered — in `seq`
 * order, skipping anything whose task has since reached a terminal state —
 * on reconnect (`redeliverAfterReconnect`) or long-poll
 * (`pollEvents`/`collectRelevant`). `conn.ack` has no task association, so
 * it's retained (for seq-counting purposes only) but never redelivered.
 * Exception (N1/F4): `task.cancel`/`task.reject` are exempt from the
 * terminal-task skip (`OutboxEntry.redeliverThroughTerminal`) because both
 * move their own task to a terminal state before being queued — without the
 * exemption they could never qualify for redelivery even when the original
 * send never reached the daemon.
 *
 * State-machine (M1): `task.claim` only claims (`Offered -> Claimed`); it no
 * longer implies `Running`. The daemon reports `Claimed -> Running`
 * explicitly via `task.started` once its runtime session actually starts
 * (§3.1). `task.decline` reports a pre-claim fail-closed rejection
 * (`Offered -> Failed`, §3.2). `task.cancelled` is dual-purpose: an
 * idempotent ack when the server already cancelled the task itself, or the
 * authoritative trigger when the daemon observed the cancellation first
 * (§3.3). Per §9, `task.complete`/`task.fail`/`task.cancelled` arriving for
 * an already-terminal task are silently dropped as stale/duplicate — not a
 * warning; this is what naturally resolves the M0 gatekeeper's cancel-race
 * `console.warn` finding (a late `task.fail`/`task.cancelled` racing a
 * server-initiated cancel is exactly this case).
 *
 * Task lease (M2): a periodic sweep (started in the constructor) reaps a
 * `Claimed`/`Running`/`AwaitApproval` task to
 * `Failed(retryable: true, reason: 'lease-expired')` once its owning device
 * has been dark (disconnected, or long-poll-silent) AND the task itself has
 * had no inbound activity for `taskLeaseMs` — see the "task-lease reaper"
 * section further down for the full design, including why this does not
 * reintroduce the disconnect-alone-fails-the-task bug M1 removed above.
 */
/**
 * M4 Phase 3: thrown by {@link ConnectionHub.approveTask}/{@link
 * ConnectionHub.rejectTask} for a `taskId` this hub has no record of at all
 * — mirrors `task-store.ts`'s `IllegalTaskTransitionError` (typed error
 * class + `instanceof` dispatch is this codebase's own established idiom for
 * mapping a domain error to the right status code). Distinguished from
 * {@link TaskNotAwaitingApprovalError} so a caller CAN tell the two failure
 * modes apart (e.g. 404 vs. 409) instead of only ever seeing a single
 * generic `Error`. There is no bearer-authed HTTP route for this on
 * `http.ts`'s own app (see that file's own closing comment for why) — the
 * supported entry point is calling `approveTask`/`rejectTask` directly, or
 * via `TaskHandle.approve()`/`reject()` (thin wrappers over the same two
 * methods); an embedder builds its own operator-facing surface on top of
 * that, exactly like `examples/basic/server.ts`'s own
 * `/api/tasks/:taskId/approve`/`reject` routes do.
 */
export class UnknownTaskError extends Error {
  constructor(public readonly taskId: string) {
    super(`unknown taskId: ${taskId}`);
    this.name = 'UnknownTaskError';
  }
}

/**
 * Thrown by {@link ConnectionHub.approveTask}/{@link ConnectionHub.rejectTask}
 * when the task exists but isn't currently `AwaitApproval` — see {@link
 * UnknownTaskError}'s own doc comment for why this is a distinct class.
 * `verb` keeps the exact pre-existing message wording per call site
 * ("cannot approve ..." vs. "cannot reject ...") byte-for-byte unchanged —
 * this message is user-visible today (e.g. `examples/basic`'s own
 * `/api/tasks/:taskId/approve` surfaces `err.message` straight to the
 * caller), so only the error's TYPE changes here, not its text.
 */
export class TaskNotAwaitingApprovalError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly state: TaskState,
    verb: 'approve' | 'reject',
  ) {
    super(`cannot ${verb} task ${taskId}: not awaiting approval (state ${state})`);
    this.name = 'TaskNotAwaitingApprovalError';
  }
}

export class ConnectionHub {
  private readonly connections = new Map<string, ConnectionState>();
  private readonly outboxes = new Map<string, DeviceOutbox>();
  /** Idempotency window per device (N3) — recent inbound envelope ids, capped at {@link DEDUP_RING_CAPACITY}. */
  private readonly dedupRings = new Map<string, Set<string>>();
  private readonly longPollWaiters = new Map<string, LongPollWaiter>();
  private readonly runtimes = new Map<string, TaskRuntime>();
  private readonly serverEvents = new AsyncEventQueue<ByokServerEvent>();
  /**
   * Per-task last-inbound-activity timestamp (epoch ms) — the task-lease
   * reaper's condition (c), see the "task-lease reaper" section below. Reset
   * on every accepted inbound `task.*` envelope ({@link recordTaskActivity},
   * called from {@link dispatchToHandler}); cleared once the task reaches a
   * terminal state ({@link onStateChange}), so this map only ever holds
   * entries for currently non-terminal claimed tasks.
   */
  private readonly taskActivity = new Map<string, number>();
  /** The task-lease reaper's own periodic sweep timer — see the constructor and `sweepLeases` below. */
  private readonly leaseReaperTimer: ReturnType<typeof setInterval>;
  /** {@link ConnectionHub.stats}'s `uptimeMs` origin — this hub's own construction instant. */
  private readonly startedAtMs = Date.now();
  /** {@link ConnectionHub.stats}'s `envelopesIn` — every {@link handleInbound} call, every outcome. */
  private envelopesInCount = 0;
  /** {@link ConnectionHub.stats}'s `envelopesOut` — every envelope built via the single outbound choke point, {@link sendToDevice}. */
  private envelopesOutCount = 0;
  /** {@link ConnectionHub.stats}'s `dedupDrops` (N3). */
  private dedupDropCount = 0;
  /** {@link ConnectionHub.stats}'s `rateLimitEvents` — see {@link handleRateLimited}. */
  private rateLimitEventCount = 0;
  /**
   * M4 Phase 4 (gatekeeper LOW advisory): devices that have already had a
   * `device.rate_limited` embedder event emitted for their CURRENT
   * over-budget episode — see {@link handleRateLimited}'s own doc comment.
   * Coalescing state only; {@link rateLimitEventCount} still counts every
   * single hit regardless of what this suppresses.
   */
  private readonly rateLimitEventEmittedFor = new Set<string>();

  constructor(
    private readonly taskStore: TaskStore,
    private readonly devices: DeviceRegistry,
    /** See {@link CreateByokServerOptions.taskLeaseMs} — already defaulted by `createByokServer` before reaching here. */
    private readonly taskLeaseMs: number,
    /**
     * M4 Phase 4 (part A): per-device inbound-envelope token bucket — see
     * {@link CreateByokServerOptions.rateLimit} (already defaulted by
     * `createByokServer` before reaching here) and {@link handleInbound}'s
     * own doc comment for where it's enforced. Defaults to a fresh
     * default-configured `RateLimiter` so every existing direct-construction
     * call site (this hub is constructed directly by several tests) keeps
     * working unchanged.
     */
    private readonly rateLimiter: RateLimiter = new RateLimiter(),
  ) {
    // A short (e.g. test-injected) taskLeaseMs sweeps at its own
    // granularity so a short lease is still caught promptly; a realistic
    // multi-minute lease sweeps at a fixed, cheap resolution instead of
    // scaling the interval down with it. Unref'd so this timer never keeps
    // the process alive on its own (mirrors heartbeat.ts's own timer).
    const sweepIntervalMs = Math.min(Math.max(taskLeaseMs, 10), MAX_LEASE_REAPER_SWEEP_INTERVAL_MS);
    this.leaseReaperTimer = setInterval(() => this.sweepLeases(), sweepIntervalMs);
    this.leaseReaperTimer.unref?.();
  }

  /**
   * Stop the task-lease reaper's sweep timer — called by `ByokServer.stop()`
   * (`index.ts`) on shutdown. Idempotent: clearing an already-cleared
   * interval is a safe no-op.
   */
  stopLeaseReaper(): void {
    clearInterval(this.leaseReaperTimer);
  }

  /** The top-level `events` feed returned by `createByokServer` — see {@link ByokServerEvent}. */
  subscribeServerEvents(): AsyncIterable<ByokServerEvent> {
    return this.serverEvents.subscribe();
  }

  // ---------------------------------------------------------------------
  // connection lifecycle — called from ws-server.ts / http.ts
  // ---------------------------------------------------------------------

  /** A daemon completed the WS handshake (`conn.hello`). Does not itself send `conn.ack` or redeliver — see {@link sendConnAck}/{@link redeliverAfterReconnect}. */
  registerConnection(deviceId: string, ws: WebSocket, runtimes: RuntimeInfo[] | undefined): void {
    const at = new Date().toISOString();
    this.connections.set(deviceId, { ws, connected: true, lastSeen: at, runtimes });
    this.serverEvents.push({ kind: 'device.connected', deviceId, at });
    // Last-transport-wins (§8): a WS connection supersedes any long-poll
    // request currently held open for this device — let it complete now
    // instead of leaving it hanging until its own timeout.
    this.settleLongPollWaiter(deviceId);
  }

  sendConnAck(deviceId: string, capabilities: string[]): void {
    this.sendToDevice(
      deviceId,
      'conn.ack',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities,
        serverTime: new Date().toISOString(),
      },
      {}, // conn.ack needs neither taskId nor sessionRef
    );
  }

  /**
   * Reconnection procedure step 3 (§9): redeliver, in `seq` order, every
   * retained envelope with `seq > cursor` that still belongs to a
   * non-terminal task. Called after `conn.ack` (step 2), per the spec.
   */
  redeliverAfterReconnect(deviceId: string, cursor: number): void {
    const conn = this.connections.get(deviceId);
    if (!conn?.ws || !conn.connected) return;
    for (const envelope of this.collectRelevant(deviceId, cursor)) {
      conn.ws.send(encodeEnvelope(envelope));
    }
  }

  /**
   * A device's WS socket closed. `ws` identifies *which* socket closed: if
   * it's no longer the one this device's connection state points at (a
   * newer WS reconnected, or long-poll took over — "last transport wins"),
   * this close is for a stale/superseded socket and the device isn't
   * actually gone, so the bookkeeping below is skipped entirely.
   *
   * M1 note: the M0 server force-failed/cancelled every in-flight task for a
   * device the instant it disconnected, on the stated premise that "a task
   * still in flight for a device that just disconnected can't be resumed, so
   * it's terminated" — true only in the absence of a redelivery cursor. M1
   * adds exactly that (§9): a task's in-flight state is retained
   * independently of any one connection, specifically so it can survive a
   * disconnect and resume via redelivery once the device reconnects. Failing
   * tasks here would make that feature unreachable in practice (nothing
   * would ever still be non-terminal by the time a reconnect happened), so
   * this now only updates connection bookkeeping and leaves task state
   * alone. A task left in-flight by a device that never reconnects stays
   * that way until the SaaS embedder explicitly cancels it — no
   * disconnect-timeout is specified by the protocol, so none is invented
   * here (see the M1-2 report's contract-gap notes).
   */
  handleDisconnect(deviceId: string, ws: WebSocket): void {
    const conn = this.connections.get(deviceId);
    if (!conn || conn.ws !== ws) return;

    conn.connected = false;
    conn.ws = undefined;
    conn.lastSeen = new Date().toISOString();
    // The task-lease reaper's condition (b) clock starts here, now — not at
    // whatever a claimed task's own last-activity timestamp happened to be
    // (see `sweepLeases`'s doc comment).
    conn.darkSince = Date.now();
    this.serverEvents.push({ kind: 'device.disconnected', deviceId, at: conn.lastSeen });
    this.settleLongPollWaiter(deviceId);
  }

  // ---------------------------------------------------------------------
  // long-poll fallback (§8) — GET /byok/events, called from http.ts
  // ---------------------------------------------------------------------

  /**
   * Resolve immediately if there are already-relevant events past `cursor`;
   * otherwise hold for up to `holdMs` and resolve with an empty result if
   * nothing arrives. A device may be connected via WS or long-poll, not
   * both simultaneously — a poll here supersedes (closes) any live WS for
   * this device ("last one wins", documented at the type level on
   * {@link ConnectionState}).
   */
  async pollEvents(deviceId: string, cursor: number, holdMs: number): Promise<{ events: Envelope[]; cursor: number }> {
    this.takeOverAsLongPoll(deviceId);
    this.settleLongPollWaiter(deviceId); // in case a previous poll for this device is still outstanding

    const immediate = this.collectRelevant(deviceId, cursor);
    if (immediate.length > 0) {
      return { events: immediate, cursor: this.currentCursor(deviceId) };
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.longPollWaiters.delete(deviceId);
        resolve({ events: [], cursor: this.currentCursor(deviceId) });
      }, holdMs);
      timer.unref?.();
      this.longPollWaiters.set(deviceId, { cursor, resolve, timer });
    });
  }

  /** Make long-poll this device's active transport, closing any live WS ("last one wins", §8). */
  private takeOverAsLongPoll(deviceId: string): void {
    const conn = this.connections.get(deviceId);
    const at = new Date().toISOString();
    const wasFreshlyConnected = !conn || conn.ws !== undefined || !conn.connected;

    if (conn?.ws) {
      const ws = conn.ws;
      // Detach first so the 'close' event this triggers sees a connection
      // state that's already moved on and skips handleDisconnect's
      // task-failure logic — the device isn't gone, it's switching transport.
      this.connections.set(deviceId, { connected: true, lastSeen: at, runtimes: conn.runtimes });
      ws.close(1000, 'superseded by long-poll connection');
    } else if (!conn) {
      this.connections.set(deviceId, { connected: true, lastSeen: at });
    } else {
      conn.connected = true;
      conn.lastSeen = at;
      conn.darkSince = undefined; // alive again — clear any dark-clock start from a previous disconnect
    }

    if (wasFreshlyConnected) {
      this.serverEvents.push({ kind: 'device.connected', deviceId, at });
    }
  }

  /** Resolve (settle) any long-poll request currently held open for `deviceId`, if one exists. */
  private settleLongPollWaiter(deviceId: string): void {
    const waiter = this.longPollWaiters.get(deviceId);
    if (!waiter) return;
    this.longPollWaiters.delete(deviceId);
    clearTimeout(waiter.timer);
    waiter.resolve({ events: this.collectRelevant(deviceId, waiter.cursor), cursor: this.currentCursor(deviceId) });
  }

  // ---------------------------------------------------------------------
  // inbound envelopes from a connected daemon
  // ---------------------------------------------------------------------

  /**
   * Single inbound choke point for every daemon -> server envelope (N2/N3/
   * P2) — called by both the WS path (`ws-server.ts`) and the long-poll send
   * path (`POST /byok/messages`, `http.ts`) in place of reaching into
   * per-type handlers directly. Runs a fixed gate, in order:
   *
   * 0. **rate limit (M4 Phase 4, part A)** — one token debited from this
   *    device's bucket ({@link rateLimiter}) for EVERY inbound envelope,
   *    before anything else runs (including the type-allow check below) —
   *    a flood of garbage-typed envelopes must cost the same budget as a
   *    flood of well-formed ones. Checked first specifically so an
   *    over-budget device is turned away as cheaply as possible, before any
   *    taskStore lookup or dedup bookkeeping. See {@link handleRateLimited}
   *    for what happens on exceed (never a silent drop).
   * 1. **type-allow (P2)** — only {@link DAEMON_TO_SERVER_TYPES} may pass; a
   *    server -> daemon type (or anything unrecognized, e.g. a stale/future
   *    `conn.hello` outside the handshake) arriving inbound is rejected
   *    before it's dispatched or counted accepted.
   * 2. **ownership (N2)** — an envelope for a task already owned by a
   *    *different* device is dropped (logged), never force-failed:
   *    force-failing on an authz mismatch would let an attacker who merely
   *    guesses a `taskId` kill the real owner's task (a DoS). A task with no
   *    owner yet, or that doesn't exist at all, is not rejected here — the
   *    per-type handler's own no-op-on-missing-record behavior covers the
   *    latter.
   * 3. **dedup (N3)** — an envelope `id` already seen from this device is a
   *    no-op: the wire is at-least-once (§9), this makes server-side
   *    processing at-most-once. Check-and-record is synchronous (Node is
   *    single-threaded), so it's atomic with respect to any other envelope
   *    for this device.
   * 4. **dispatch** — handed to the existing per-type `on*` handler.
   *
   * Returns which outcome applied. A duplicate still counts as `accepted` on
   * the `POST /byok/messages` wire (§8.2) — an idempotent replay is a
   * wire-level success even though no handler ran a second time; only
   * `rejected`/`rate_limited` (gate steps 0-2) are excluded from that count.
   */
  handleInbound(deviceId: string, envelope: Envelope): 'accepted' | 'duplicate' | 'rejected' | 'rate_limited' {
    this.envelopesInCount++;

    if (!this.rateLimiter.consume(deviceId)) {
      this.handleRateLimited(deviceId);
      return 'rate_limited';
    }
    // Back under budget — clear any earlier suppression (see
    // `rateLimitEventEmittedFor`'s own doc comment) so the NEXT time this
    // device floods, it's treated as a fresh episode and gets its own
    // embedder event rather than being silently coalesced into a flood it
    // already recovered from.
    this.rateLimitEventEmittedFor.delete(deviceId);

    if (!(DAEMON_TO_SERVER_TYPES as readonly MessageType[]).includes(envelope.type)) {
      return 'rejected';
    }

    const taskId = envelope.task_id;
    if (taskId === undefined) return 'rejected'; // schema guarantees every DAEMON_TO_SERVER_TYPES member carries task_id; defensive only.

    const record = this.taskStore.get(taskId);
    if (record && record.deviceId !== undefined && record.deviceId !== deviceId) {
      console.warn(`[byok/server] dropping ${envelope.type} for ${taskId}: owned by a different device`);
      return 'rejected';
    }

    if (this.checkAndRecordDuplicate(deviceId, envelope.id)) {
      this.dedupDropCount++;
      return 'duplicate';
    }

    this.dispatchToHandler(deviceId, taskId, envelope);
    return 'accepted';
  }

  /**
   * M4 Phase 4 (part A): `deviceId` just exceeded its inbound-envelope rate
   * limit. Never a silent drop: counts the occurrence
   * ({@link rateLimitEventCount}, surfaced via {@link stats} — every single
   * hit, unconditionally) and, the FIRST time in this over-budget episode
   * only, emits an embedder-facing `device.rate_limited`
   * {@link ByokServerEvent} — see that variant's own doc comment (`types.ts`)
   * for the full per-transport enforcement shape.
   *
   * Gatekeeper LOW advisory (event amplification): a single flood can make
   * `handleInbound` call this many times in a row — e.g. several WS frames
   * already in flight before the close below actually lands, or a
   * long-poll device retrying its `POST /byok/messages` before its bucket
   * has refilled. Without coalescing, an embedder subscribed to
   * `events.subscribe()` would see one `device.rate_limited` per hit, which
   * is noisy for what is really ONE ongoing episode of one device
   * flooding. `rateLimitEventEmittedFor` suppresses the repeats: this
   * method only pushes the event the first time it sees a given `deviceId`
   * since `handleInbound`'s own success path last cleared it (i.e. since
   * this device was last confirmed back under budget) — the COUNTER above
   * is entirely unaffected by this and still increments on every call,
   * unconditionally.
   *
   * This method only handles the WS half of the enforcement shape (closing
   * the live connection, if any, so the client's existing backoff+reconnect
   * takes over — mirrors `takeOverAsLongPoll`'s own `ws.close`, the only
   * other place this hub closes a device's socket directly); a long-poll
   * device has no live `ws` to close here at all (`conn.ws` is `undefined`
   * while long-polling — see {@link ConnectionState}), so `http.ts`'s
   * `/byok/messages` handler maps this same `'rate_limited'` `handleInbound`
   * outcome to an HTTP 429 for that transport instead.
   */
  private handleRateLimited(deviceId: string): void {
    this.rateLimitEventCount++;
    if (!this.rateLimitEventEmittedFor.has(deviceId)) {
      this.rateLimitEventEmittedFor.add(deviceId);
      const at = new Date().toISOString();
      this.serverEvents.push({ kind: 'device.rate_limited', deviceId, at });
    }
    const conn = this.connections.get(deviceId);
    if (conn?.ws) {
      // 1008 = Policy Violation (RFC 6455) — distinct from the 1002
      // protocol-error closes ws-server.ts uses for a malformed handshake;
      // this connection was well-formed, it just sent too much of it.
      conn.ws.close(1008, 'rate limit exceeded');
    }
  }

  /**
   * Idempotency check-and-record (N3): `true` (duplicate) if `id` was
   * already seen for `deviceId`; otherwise records it and returns `false`.
   * Bounded to {@link DEDUP_RING_CAPACITY} ids per device — a ring, not an
   * unbounded set — evicting the oldest once full.
   */
  private checkAndRecordDuplicate(deviceId: string, id: string): boolean {
    let seen = this.dedupRings.get(deviceId);
    if (!seen) {
      seen = new Set<string>();
      this.dedupRings.set(deviceId, seen);
    }
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > DEDUP_RING_CAPACITY) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return false;
  }

  /**
   * Route one already-gated envelope (see {@link handleInbound}) to its
   * per-type handler. Type-allow/ownership/dedup have already run by the
   * time this executes, so the handlers below no longer need their own
   * device-mismatch checks — that authz decision now lives solely in
   * `handleInbound` (N2).
   *
   * Also the task-lease reaper's activity checkpoint
   * ({@link recordTaskActivity}): every envelope for a task that currently
   * *exists and is non-terminal* counts as proof of life for `taskId`'s
   * lease, regardless of what its per-type handler below ends up doing with
   * it (including a no-op/stale drop) — see the "task-lease reaper" section
   * further down for why. Deliberately gated on the record's existence and
   * non-terminal state *here*, before dispatch: `taskActivity` must never
   * gain an entry for a taskId that doesn't exist (a nonexistent/garbage id
   * an authenticated-but-malicious daemon could send indefinitely — an
   * unbounded-growth vector, since `taskId`s aren't deduped the way envelope
   * `id`s are) or for one that's already terminal (a stale/late message for
   * a finished task — `onStateChange` deletes the entry on the *real*
   * terminal transition, but a stale message arriving *after* that would
   * otherwise silently recreate it, since every per-type handler's own
   * terminal/unknown-task guard runs — and early-returns — only *after*
   * this would already have recorded activity).
   */
  private dispatchToHandler(deviceId: string, taskId: string, envelope: Envelope): void {
    const record = this.taskStore.get(taskId);
    if (record && !isTerminal(record.state)) {
      this.recordTaskActivity(taskId);
    }
    switch (envelope.type) {
      case 'task.claim':
        this.onClaim(deviceId, envelope.task_id, envelope.payload);
        return;
      case 'task.started':
        this.onStarted(envelope.task_id, envelope.payload);
        return;
      case 'task.decline':
        this.onDecline(envelope.task_id, envelope.payload);
        return;
      case 'task.progress':
        this.onProgress(envelope.task_id, envelope.payload);
        return;
      case 'task.artifact':
        this.onArtifact(envelope.task_id, envelope.payload);
        return;
      case 'task.await_approval':
        this.onAwaitApproval(envelope.task_id, envelope.payload);
        return;
      case 'task.complete':
        this.onComplete(envelope.task_id, envelope.payload);
        return;
      case 'task.fail':
        this.onFail(envelope.task_id, envelope.payload);
        return;
      case 'task.cancelled':
        this.onCancelled(envelope.task_id, envelope.payload);
        return;
      case 'task.approval_resolved':
        this.onApprovalResolved(envelope.task_id, envelope.payload);
        return;
      default:
        // conn.hello is handled during the handshake (ws-server.ts); the
        // remaining types (conn.ack/task.offer/approve/reject/cancel/steer)
        // are server->daemon only, and handleInbound's type-allow gate
        // already rejects those before this is ever reached. Kept as a safe
        // no-op default (rather than throwing) purely so this switch stays
        // exhaustive over the full MessageType union — not a live path.
        return;
    }
  }

  /** Reset the task-lease reaper's per-task clock (condition (c) in the "task-lease reaper" section below). */
  private recordTaskActivity(taskId: string): void {
    this.taskActivity.set(taskId, Date.now());
  }

  /** Ownership (record.deviceId matching the connection's authenticated deviceId) is enforced centrally by {@link handleInbound} (N2) before this runs; only the idempotent-claim CAS and the first-claim device patch happen here. */
  private onClaim(deviceId: string, taskId: string, _payload: TaskClaimPayload): void {
    const record = this.taskStore.get(taskId);
    if (!record) return;
    // Claim is an idempotent CAS: a retried claim from the device that
    // already owns this task (e.g. the daemon didn't see the first claim's
    // effect land before retrying) is a no-op, not an illegal-transition
    // failure.
    if (record.state === 'Claimed' || record.state === 'Running') return;
    this.applyOrFail(taskId, 'Claimed', { deviceId });
    // NOTE (M1 gap #2): claiming no longer implies Running — the daemon
    // reports that explicitly via task.started (see onStarted) once its
    // runtime session actually starts.
  }

  /**
   * `Claimed -> Running` (§3.1) — a daemon actually starting the runtime
   * session, distinct from merely claiming. Ownership is already enforced
   * by {@link handleInbound} (N2) before this runs.
   */
  private onStarted(taskId: string, _payload: TaskStartedPayload): void {
    const record = this.taskStore.get(taskId);
    if (!record) return;
    if (record.state === 'Running') return; // idempotent (§3.1): already running, no-op.
    if (isTerminal(record.state)) return; // stale/duplicate — task already moved on.
    this.applyOrFail(taskId, 'Running', {});
  }

  /**
   * `Offered -> Failed` (§3.2) — a fail-closed pre-claim rejection. Only
   * ever legal from `Offered`; anything else is stale. Ownership is already
   * enforced by {@link handleInbound} (N2) before this runs.
   */
  private onDecline(taskId: string, payload: TaskDeclinePayload): void {
    const record = this.taskStore.get(taskId);
    if (!record) return;
    if (record.state !== 'Offered') return;
    this.applyOrFail(taskId, 'Failed', {
      result: { state: 'Failed', reason: payload.reason, retryable: payload.retryable },
    });
  }

  private onProgress(taskId: string, payload: TaskProgressPayload): void {
    const record = this.taskStore.get(taskId);
    if (!record) return;
    const resumed = this.resumeIfImplicitlyApproved(record);
    if (resumed.state !== 'Running') {
      this.forceFailOrDrop(taskId, 'task.progress received while not Running');
      return;
    }
    const runtime = this.runtimes.get(taskId);
    if (!runtime) return;
    for (const event of payload.events) {
      runtime.queue.push({ kind: 'agent', event });
    }
  }

  private onArtifact(taskId: string, payload: TaskArtifactPayload): void {
    const record = this.taskStore.get(taskId);
    if (!record) return;
    const resumed = this.resumeIfImplicitlyApproved(record);
    if (resumed.state !== 'Running') {
      this.forceFailOrDrop(taskId, 'task.artifact received while not Running');
      return;
    }
    const runtime = this.runtimes.get(taskId);
    if (!runtime) return;
    runtime.queue.push({ kind: 'artifact', artifact: payload });
  }

  private onAwaitApproval(taskId: string, payload: TaskAwaitApprovalPayload): void {
    const record = this.taskStore.get(taskId);
    if (!record) return;
    // Idempotent no-op (N3), mirroring onStarted's already-Running guard: a
    // repeat task.await_approval while already AwaitApproval must not be
    // treated as an illegal self-transition and force-failed.
    // AwaitApproval -> AwaitApproval is deliberately NOT in TASK_TRANSITIONS
    // (task-state.ts) — this early return is where the idempotency lives
    // instead.
    if (record.state === 'AwaitApproval') return;
    this.applyOrFail(taskId, 'AwaitApproval', {});
    const after = this.taskStore.get(taskId);
    if (after?.state !== 'AwaitApproval') return; // fell back to Failed, or task was unknown
    this.runtimes.get(taskId)?.queue.push({ kind: 'await_approval', summary: payload.summary });
  }

  private onComplete(taskId: string, payload: TaskCompletePayload): void {
    const record = this.taskStore.get(taskId);
    if (!record) return;
    // Terminal messages arriving for an already-terminal task are stale/
    // duplicate (§9) — drop silently, not a warning.
    if (isTerminal(record.state)) return;
    // Implicit-resume first (no-op unless still AwaitApproval) so a task
    // completing right after a LOCAL-only approval lands on the normal
    // Running -> Complete edge below, not the illegal AwaitApproval ->
    // Complete edge — see resumeIfImplicitlyApproved's own doc comment.
    this.resumeIfImplicitlyApproved(record);
    const result: TaskResult = {
      state: 'Complete',
      summary: payload.summary,
      sessionRef: payload.sessionRef,
      artifactRefs: payload.artifactRefs,
    };
    this.applyOrFail(taskId, 'Complete', { result, sessionRef: payload.sessionRef });
  }

  private onFail(taskId: string, payload: TaskFailPayload): void {
    const record = this.taskStore.get(taskId);
    if (!record) return;
    // Same stale-terminal-message rule as onComplete (§9) — this is what
    // resolves the M0 gatekeeper's cancel-race finding: a task.fail racing a
    // server-initiated cancel that already landed is now a silent drop.
    if (isTerminal(record.state)) return;
    const result: TaskResult = { state: 'Failed', reason: payload.reason, retryable: payload.retryable };
    this.applyOrFail(taskId, 'Failed', { result });
  }

  /**
   * Dual-purpose on receipt (§3.3): if the server already moved this task to
   * `Cancelled` on its own action (the common case — `cancelTask()` is
   * authoritative immediately, §4), this is a late idempotent ack — silent,
   * not a warning (this is the other half of the M0 gatekeeper finding this
   * change resolves). Otherwise it's the authoritative trigger for a
   * cancellation the daemon observed that the server didn't initiate.
   * Ownership is already enforced by {@link handleInbound} (N2) before this
   * runs.
   */
  private onCancelled(taskId: string, payload: TaskCancelledPayload): void {
    const record = this.taskStore.get(taskId);
    if (!record) return;
    if (record.state === 'Cancelled') return;
    if (isTerminal(record.state)) return; // Complete/Failed already reached — stale (§9), drop silently.
    this.applyOrFail(taskId, 'Cancelled', { result: { state: 'Cancelled', reason: payload.reason } });
  }

  /**
   * M4 (additive-minor, `task.approval_resolved`): the EXPLICIT counterpart
   * to {@link resumeIfImplicitlyApproved} — a daemon that resolved a pending
   * approval entirely LOCALLY now reports it immediately, instead of the
   * server only finding out after the fact once evidence (a later
   * `task.progress`/`task.artifact`/`task.complete`) proves it.
   *
   * Relationship to the implicit path (both stay, permanently — this is not
   * a replacement): {@link resumeIfImplicitlyApproved} remains completely
   * untouched as the fallback for (a) an old daemon that predates this
   * message, and (b) a daemon connected to an old server that never
   * advertised the `approval_resolved` capability flag (`version.ts`) at
   * handshake time — in either case the daemon never sends this message at
   * all (see `packages/client`'s `task-runner.ts`), and the server keeps
   * inferring the resolution from evidence exactly as it did before this
   * message existed. When THIS message does arrive first, it already moves
   * the record out of `AwaitApproval` (see below) — so by the time any
   * following `task.progress`/etc. reaches `onProgress`/`onArtifact`/
   * `onComplete`, `resumeIfImplicitlyApproved`'s own `record.state !==
   * 'AwaitApproval'` guard is already true and it no-ops, never firing its
   * own `task.approval_resolved_implicit` event a second time for the same
   * resolution. The two mechanisms race harmlessly: whichever one the
   * server processes first is the one that actually performs the
   * transition; the other is naturally inert once it runs.
   *
   * Three outcomes, mirroring this file's existing per-type idempotency
   * conventions:
   *   - `AwaitApproval` (the expected case): legal transition to `Running`
   *     (an existing `TASK_TRANSITIONS` edge, the same one `approveTask`
   *     itself uses) plus a `task.approval_resolved` {@link ByokServerEvent}
   *     carrying `approvalId`/`decision`/`resolvedBy` for an embedder to
   *     observe.
   *   - Already `Running` (evidence — or the implicit path — already beat
   *     this message to it): idempotent no-op, silent, mirroring
   *     `onStarted`'s own already-running guard.
   *   - Terminal, or a state that was never `AwaitApproval` in the first
   *     place (`Offered`/`Claimed` — a genuinely out-of-sequence report):
   *     stale no-op with a `console.warn`, matching this file's existing
   *     stale-message convention (`forceFailOrDrop`, `handleInbound`'s
   *     ownership-mismatch drop) — never force-failed, since a late/
   *     redelivered report about a task that has already moved on is not
   *     evidence of anything currently wrong with it.
   *
   * This is also the residual-race resolution the accompanying protocol/docs
   * update documents: a SaaS decision (`approveTask`/`rejectTask`) already in
   * flight when the local resolution happens can still land on the server
   * FIRST and move the record to a terminal state before this message
   * arrives — in that case this message hits the terminal branch above and
   * is a stale no-op, exactly like any other late message for an
   * already-terminal task. The window for that crossing is now
   * network-latency-sized (how long this message takes to arrive), not
   * "until the next progress message" the way the pre-existing implicit-only
   * inference left it.
   */
  private onApprovalResolved(taskId: string, payload: TaskApprovalResolvedPayload): void {
    const record = this.taskStore.get(taskId);
    if (!record) return;
    if (record.state === 'Running') return; // evidence (or the implicit path) already beat this message to it — idempotent no-op, mirrors onStarted's own guard.
    if (record.state !== 'AwaitApproval') {
      // Terminal (a SaaS decision — or a redelivered terminal message —
      // already crossed this one and won), or a state that never reached
      // AwaitApproval at all (Offered/Claimed) — genuinely stale/
      // out-of-sequence either way. Never force-failed: a late report about
      // a task that has already moved on is not itself evidence of anything
      // wrong with that task.
      console.warn(
        `[byok/server] dropping task.approval_resolved for ${taskId}: not awaiting approval (state ${record.state})`,
      );
      return;
    }
    this.applyOrFail(taskId, 'Running', {});
    const after = this.taskStore.get(taskId);
    if (after?.state !== 'Running') return; // defensive: AwaitApproval -> Running is always a legal TASK_TRANSITIONS edge, so applyOrFail should never actually fall back to Failed here.
    this.serverEvents.push({
      kind: 'task.approval_resolved',
      taskId,
      approvalId: payload.approvalId,
      decision: payload.decision,
      resolvedBy: payload.resolvedBy,
      at: after.updatedAt,
    });
  }

  // ---------------------------------------------------------------------
  // transition helpers — the single place "illegal transition" is handled
  // ---------------------------------------------------------------------

  /**
   * Apply `taskId`'s state -> `target`. If that's illegal per
   * `TASK_TRANSITIONS`, fall back to `Failed` (if reachable from the current
   * state); this is the "illegal transition = error + task.fail path" rule.
   */
  private applyOrFail(taskId: string, target: TaskState, patch: TaskPatch): void {
    const record = this.taskStore.get(taskId);
    if (!record) return;
    if (canTransition(record.state, target)) {
      const updated = this.taskStore.transition(taskId, target, patch);
      this.onStateChange(updated);
      return;
    }
    this.forceFailOrDrop(taskId, `illegal transition ${record.state} -> ${target}`);
  }

  /**
   * M4 Phase 3 hardening (orchestrator-directed fix for the server-state-
   * machine trace finding): a task can be resolved entirely OUT-OF-BAND, on
   * the daemon side only (M4 Phase 3's local `approvals.resolve`
   * control-socket path, `packages/client`) — the server never sees a wire
   * `task.approve`/`task.reject` for it, so its own record sits in
   * `AwaitApproval` even though the daemon already resumed and moved on.
   *
   * The daemon is the execution authority in this security model (the SaaS
   * only ever *proposes* — see docs/spec.md); the daemon sending ANY further
   * task.* traffic for a task the server still thinks is `AwaitApproval` is
   * itself sufficient proof the approval was resolved locally, one way or
   * another. Rather than force-failing/dropping that traffic (the pre-fix
   * behavior — `onProgress`/`onArtifact`'s own `!== 'Running'` guard,
   * `onComplete`'s illegal-transition fallback), this applies the exact same
   * `AwaitApproval -> Running` edge `approveTask` already uses (a
   * pre-existing legal `TASK_TRANSITIONS` edge, not a new one) through the
   * normal transition path — `taskStore.transition` + `onStateChange`, same
   * as `applyOrFail`'s own legal-transition branch — so every existing
   * consumer of task state (§, `TaskHandle.events()`, the lease reaper's
   * `taskActivity`) observes it exactly as it would a real wire
   * `task.approve`. Then emits `task.approval_resolved_implicit` (a
   * `ByokServerEvent`, NOT a wire message — see that type's own doc comment)
   * so an embedder can distinguish this from an operator-driven approval.
   *
   * M4 (additive-minor, superseding this method's own former "deferred"
   * framing): a first-class `task.approval_resolved` WIRE notification now
   * exists (`onApprovalResolved`, below) — a daemon that supports it, talking
   * to a server that advertised the `approval_resolved` capability flag
   * (`version.ts`), reports a local resolution explicitly and immediately
   * instead of leaving the server to infer it here. This method is
   * UNTOUCHED and remains the permanent fallback for the N/N-1 cases where
   * that explicit report never arrives (an old daemon, or an old server this
   * daemon is talking to) — see `onApprovalResolved`'s own doc comment for
   * the full relationship between the two paths, including why they can
   * never both fire for the same resolution.
   *
   * No-op (returns `record` unchanged) for any state other than
   * `AwaitApproval` — every other guard (terminal, pre-claim, already-
   * Running) keeps exactly its current behavior. `onFail`/`onCancelled`
   * never call this: `Failed`/`Cancelled` are already direct, legal edges
   * from `AwaitApproval`, so they never hit the illegal-transition path this
   * exists to avoid in the first place.
   */
  private resumeIfImplicitlyApproved(record: TaskSnapshot): TaskSnapshot {
    if (record.state !== 'AwaitApproval') return record;
    const updated = this.taskStore.transition(record.taskId, 'Running', {});
    this.onStateChange(updated);
    this.serverEvents.push({ kind: 'task.approval_resolved_implicit', taskId: record.taskId, at: updated.updatedAt });
    return updated;
  }

  /**
   * A daemon message didn't fit the task's current state (e.g. progress
   * while AwaitApproval). Force the task to `Failed` if that's reachable;
   * otherwise it's already terminal (or `Offered`, which has no Failed edge)
   * and there's nothing safe to do but log + drop.
   */
  private forceFailOrDrop(taskId: string, reason: string): void {
    const record = this.taskStore.get(taskId);
    if (!record) return;
    if (canTransition(record.state, 'Failed')) {
      const updated = this.taskStore.transition(taskId, 'Failed', {
        result: { state: 'Failed', reason, retryable: false },
      });
      this.onStateChange(updated);
      return;
    }
    console.warn(`[byok/server] dropping message for ${taskId} (state ${record.state}): ${reason}`);
  }

  private onStateChange(record: TaskSnapshot): void {
    this.serverEvents.push({ kind: 'task.state', taskId: record.taskId, state: record.state, at: record.updatedAt });
    if (isTerminal(record.state)) {
      // Lease-reaper bookkeeping ends here for every terminal path, not just
      // the reaper's own reapTask() — see the "task-lease reaper" section
      // below. Placed ahead of the runtime-lookup early-return so this
      // always runs regardless of whether a TaskHandle is still around.
      this.taskActivity.delete(record.taskId);
    }
    const runtime = this.runtimes.get(record.taskId);
    if (!runtime) return;
    runtime.queue.push({ kind: 'state', state: record.state, at: record.updatedAt });
    if (isTerminal(record.state)) {
      runtime.resolveResult(record.result ?? { state: record.state });
      runtime.queue.close();
    }
  }

  // ---------------------------------------------------------------------
  // task-lease reaper (Decision: Failed(retryable:true) on dark-device
  // timeout — no new task state, no new wire message)
  // ---------------------------------------------------------------------

  /**
   * Task lease: a backstop for a device that goes dark mid-task and never
   * comes back — distinct from, and layered on top of, M1's redelivery
   * (docs/protocol.md §9), which already handles "device reconnects within
   * the window, nothing lost." Decision (user+design): reuse the existing
   * `Failed` terminal state and its `retryable` flag —
   * `Failed(retryable: true, reason: 'lease-expired')` — exactly like any
   * other `task.fail`. The embedder is expected to treat this exactly like
   * any other retryable failure: re-dispatch as a brand-new task.
   *
   * Implemented as a periodic sweep (see the constructor), not a per-task
   * timer, so a device that goes dark *after* being idle-but-connected for a
   * while is still caught on a later tick without needing extra bookkeeping
   * at disconnect time. `sweepLeases` reaps a task only when ALL of the
   * following hold, checked fresh on every tick (never cached):
   *
   *   (a) the task is in a non-terminal *claimed* state — `Claimed`,
   *       `Running`, or `AwaitApproval` ({@link isClaimedState}). `Offered`
   *       is excluded: it has no owning device yet, so there's nothing to
   *       be "dark".
   *   (b) the owning device is dark right now ({@link deviceDarkSince}
   *       returns a timestamp rather than `undefined`) — disconnected
   *       outright, or (long-poll only) hasn't been seen since before the
   *       lease window. A live WS connection is never dark from the
   *       reaper's point of view: `heartbeat.ts` already independently
   *       proves liveness at the transport level and flips
   *       `connected: false` via `handleDisconnect` once it stops getting
   *       pongs — the reaper just reads that flag rather than re-deriving
   *       it. `deviceDarkSince` also returns *when* darkness started
   *       ({@link ConnectionState.darkSince}, set the instant
   *       `handleDisconnect` flips the connection dark) — that instant
   *       feeds condition (c), below.
   *   (c) a full `taskLeaseMs` has elapsed since the *later* of: the task's
   *       own last inbound-activity timestamp ({@link taskActivity}, reset
   *       in {@link dispatchToHandler} on every accepted envelope for a
   *       known, non-terminal task — claim, started, progress, artifact,
   *       await_approval, anything), and (b)'s dark-since instant. Taking
   *       the *later* of the two — not the activity timestamp alone — is
   *       what makes a device going dark start a fresh, full countdown
   *       instead of reusing whatever (possibly already-stale) activity
   *       timestamp the task happened to have: a task can be legitimately
   *       idle *while connected* for longer than `taskLeaseMs` (a long turn
   *       with no progress events, or just a quiet stretch) without being
   *       touched — see (b) — but the instant such a task's device
   *       disconnects, that stale activity timestamp must NOT immediately
   *       satisfy (c) on its own, or the task would get reaped within one
   *       sweep tick of disconnect instead of waiting the full window. That
   *       was a real bug (a disconnect-after-long-idle reap effectively
   *       indistinguishable from the M0 disconnect-alone-fails-the-task
   *       behavior M1 removed, below); anchoring (c) to
   *       `max(lastActivity, darkSince)` fixes it — idle time that elapsed
   *       *before* the device went dark no longer counts toward the lease,
   *       only silence *after* dark-start does.
   *
   * (b) and (c) are deliberately independent clocks, not one merged check.
   * The property this most exists to protect: a *connected*, momentarily
   * idle device mid-turn must never be reaped, no matter how long
   * `taskLeaseMs` is — condition (b) alone blocks that regardless of (c).
   * This is also what keeps this from reintroducing the M0 bug M1
   * deliberately removed (see `handleDisconnect`'s own doc comment above) —
   * M0 force-failed a task the instant its device disconnected; M1
   * correctly stopped doing that so a task could survive a disconnect and
   * resume via redelivery. This reaper does not revert that: disconnect
   * ALONE still does nothing here either — (c) still has to independently
   * hold, and per the `max(...)` above it only will once a full
   * `taskLeaseMs` has genuinely elapsed *since the device went dark*, no
   * matter how stale the task's own activity timestamp already was at that
   * moment.
   *
   * Interaction with redelivery (§9): redelivery is what handles "the
   * device came back within the window" — nothing to reap, normal traffic
   * resumes. This reaper is what handles "it never came back." Idempotent
   * claim (`onClaim`'s CAS) still protects server-side bookkeeping if a
   * device wakes up *after* its task was already reaped and retries a stale
   * claim/progress/etc. for it: every per-type handler's existing
   * stale/terminal-task guard (§9) drops it as a no-op, same as any other
   * late message for an already-terminal task — no new guard was needed for
   * that here.
   *
   * Accepted residual (by design, not a bug): idempotent claim protects
   * *server-side* state, not the device's own local side effects. A dark
   * device that wakes up after its task has already been reaped may still
   * be mid-way through running real local work (file writes, shell
   * commands, whatever the runtime adapter was doing) for a task the server
   * has since moved on from — and that the embedder may have already
   * re-dispatched elsewhere. There is no way to remotely guarantee a
   * truly-dark device stops running; the mitigation is entirely
   * `taskLeaseMs` being set far larger than any realistic task duration, so
   * this can only happen to a device that was genuinely gone for a very
   * long time, not a normal slow turn.
   */
  private sweepLeases(): void {
    const now = Date.now();
    for (const record of this.taskStore.list()) {
      if (!isClaimedState(record.state) || !record.deviceId) continue;
      const darkSince = this.deviceDarkSince(record.deviceId, now);
      if (darkSince === undefined) continue;
      const lastActivity = this.taskActivity.get(record.taskId) ?? Date.parse(record.updatedAt);
      // The later of the two — see condition (c) above: a device going dark
      // must always start a fresh, full `taskLeaseMs` countdown, even when
      // the task's own activity was already stale at that moment.
      const silentSince = Math.max(lastActivity, darkSince);
      if (now - silentSince < this.taskLeaseMs) continue;
      this.reapTask(record.taskId);
    }
  }

  /**
   * Condition (b) above: `undefined` while `deviceId`'s connection counts as
   * alive (never reapable, no matter how stale (c) is); otherwise the
   * epoch-ms instant it began counting as "dark" for lease purposes.
   * `sweepLeases` combines this with (c)'s own last-activity instant via
   * `max(...)` so the full `taskLeaseMs` silence window is always measured
   * from whichever of the two happened later.
   */
  private deviceDarkSince(deviceId: string, nowMs: number): number | undefined {
    const conn = this.connections.get(deviceId);
    if (!conn || !conn.connected) {
      // Disconnected. `darkSince` is set the instant `handleDisconnect`
      // flips `connected` false — using that (not "now", and not the
      // task's own possibly-much-older activity timestamp) is what anchors
      // the silence window to when the device actually went dark. The `?? 0`
      // fallback is defensive only, for a deviceId with no connection state
      // at all (in practice `record.deviceId` implies one was registered).
      return conn?.darkSince ?? 0;
    }
    if (conn.ws) return undefined; // live WS — heartbeat.ts is the liveness proof for this transport; never dark
    // Long-poll: dark once its own liveness signal (refreshed on every poll
    // call, §8) has gone stale for a full lease window — the instant it's
    // considered to have gone dark is the last time it was confirmed alive.
    const lastSeenMs = Date.parse(conn.lastSeen);
    return nowMs - lastSeenMs >= this.taskLeaseMs ? lastSeenMs : undefined;
  }

  /** Reap one lease-expired task through the exact same TaskStore/canTransition path — and terminal-event emission — as any other `task.fail` (see {@link applyOrFail}). */
  private reapTask(taskId: string): void {
    const record = this.taskStore.get(taskId);
    if (!record || isTerminal(record.state)) return; // resolved by something else between this tick's scan and now
    this.applyOrFail(taskId, 'Failed', {
      result: { state: 'Failed', reason: 'lease-expired', retryable: true },
    });
  }

  // ---------------------------------------------------------------------
  // dispatch() and the TaskHandle it returns
  // ---------------------------------------------------------------------

  async dispatch(input: DispatchInput): Promise<TaskHandle> {
    const deviceId = input.deviceId ?? this.pickFirstConnectedDevice();
    // M0 routing has no queue-until-connect: reject clearly instead of
    // silently queuing a task nothing will ever claim.
    if (!deviceId || !this.connections.get(deviceId)?.connected) {
      throw new Error(
        deviceId
          ? `device ${deviceId} is not connected`
          : 'no connected device to dispatch to (M0 does not queue tasks until a device connects)',
      );
    }

    const taskId = generateTaskId();
    const policy = input.policy ?? DEFAULT_POLICY;
    const record = this.taskStore.create({
      taskId,
      instruction: input.instruction,
      runtime: input.runtime,
      policy,
      deviceId,
      sessionRef: input.sessionRef,
    });

    const queue = new AsyncEventQueue<ServerTaskEvent>();
    let resolveResult!: (result: TaskResult) => void;
    const result = new Promise<TaskResult>((resolve) => {
      resolveResult = resolve;
    });
    this.runtimes.set(taskId, { queue, resolveResult, result });
    queue.push({ kind: 'state', state: record.state, at: record.createdAt });
    this.serverEvents.push({ kind: 'task.created', taskId, at: record.createdAt });

    this.sendToDevice(
      deviceId,
      'task.offer',
      {
        instruction: input.instruction,
        policy,
        runtime: input.runtime,
        sessionRef: input.sessionRef,
      },
      { taskId, sessionRef: input.sessionRef },
    );

    return this.buildTaskHandle(taskId);
  }

  private buildTaskHandle(taskId: string): TaskHandle {
    const hub = this;
    return {
      taskId,
      events(): AsyncIterable<ServerTaskEvent> {
        const runtime = hub.runtimes.get(taskId);
        if (!runtime) throw new Error(`unknown taskId: ${taskId}`);
        return runtime.queue.subscribe();
      },
      cancel(reason?: string): Promise<void> {
        return hub.cancelTask(taskId, reason);
      },
      approve(): Promise<void> {
        return hub.approveTask(taskId);
      },
      reject(reason?: string): Promise<void> {
        return hub.rejectTask(taskId, reason);
      },
      steer(text: string): Promise<void> {
        return hub.steerTask(taskId, text);
      },
      result(): Promise<TaskResult> {
        const runtime = hub.runtimes.get(taskId);
        if (!runtime) throw new Error(`unknown taskId: ${taskId}`);
        return runtime.result;
      },
    };
  }

  /** Idempotent: cancelling an already-terminal task is a no-op, not an error. */
  private async cancelTask(taskId: string, reason?: string): Promise<void> {
    const record = this.taskStore.get(taskId);
    if (!record) throw new Error(`unknown taskId: ${taskId}`);
    if (isTerminal(record.state)) return;
    // The protocol defines no daemon ack for task.cancel, so the server-side
    // Cancelled state is authoritative immediately; task.cancel is forwarded
    // as a best-effort notification for the daemon to stop local work.
    this.applyOrFail(taskId, 'Cancelled', { result: { state: 'Cancelled', reason } });
    if (record.deviceId) {
      this.sendToDevice(record.deviceId, 'task.cancel', { reason }, { taskId });
    }
  }

  /**
   * M4 Phase 3: made public (was private through M3) so an embedder can call
   * it directly from its own operator-facing surface — there is no
   * bearer-authed HTTP route for this on `http.ts`'s own app (see
   * `UnknownTaskError`'s own doc comment for why, and
   * `examples/basic/server.ts`'s `/api/tasks/:taskId/approve` for the
   * intended shape of that embedder-built surface). See this file's own
   * `UnknownTaskError`/`TaskNotAwaitingApprovalError` doc comments for why
   * the two failure modes are now distinct typed errors rather than a
   * single generic `Error`. Every thrown message's TEXT is byte-for-byte
   * unchanged from M2/M3 — only the error's type changed (this is still also
   * reachable via `TaskHandle.approve()`, unaffected).
   */
  async approveTask(taskId: string): Promise<void> {
    const record = this.taskStore.get(taskId);
    if (!record) throw new UnknownTaskError(taskId);
    if (record.state !== 'AwaitApproval') {
      throw new TaskNotAwaitingApprovalError(taskId, record.state, 'approve');
    }
    this.applyOrFail(taskId, 'Running', {});
    if (record.deviceId) {
      this.sendToDevice(record.deviceId, 'task.approve', {}, { taskId });
    }
  }

  /** M4 Phase 3: made public — see {@link ConnectionHub.approveTask}'s own doc comment for the full rationale (identical reasoning applies here). */
  async rejectTask(taskId: string, reason?: string): Promise<void> {
    const record = this.taskStore.get(taskId);
    if (!record) throw new UnknownTaskError(taskId);
    if (record.state !== 'AwaitApproval') {
      throw new TaskNotAwaitingApprovalError(taskId, record.state, 'reject');
    }
    this.applyOrFail(taskId, 'Failed', {
      result: { state: 'Failed', reason: reason ?? 'approval rejected', retryable: false },
    });
    if (record.deviceId) {
      this.sendToDevice(record.deviceId, 'task.reject', { reason }, { taskId });
    }
  }

  private async steerTask(taskId: string, text: string): Promise<void> {
    const record = this.taskStore.get(taskId);
    if (!record) throw new Error(`unknown taskId: ${taskId}`);
    if (record.state !== 'Running') {
      throw new Error(`cannot steer task ${taskId}: not running (state ${record.state})`);
    }
    if (!record.deviceId || !this.connections.get(record.deviceId)?.connected) {
      throw new Error(`device for task ${taskId} is not connected`);
    }
    this.sendToDevice(record.deviceId, 'task.steer', { text }, { taskId });
  }

  private pickFirstConnectedDevice(): string | undefined {
    for (const [deviceId, conn] of this.connections) {
      if (conn.connected) return deviceId;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------
  // outbound envelope delivery + per-device seq/redelivery bookkeeping (§1.2, §9)
  // ---------------------------------------------------------------------

  /**
   * Build a server -> daemon envelope with a fresh per-device `seq`, retain
   * it in that device's outbox ring buffer, and deliver it now if a live
   * transport is available (WS send, or wake a pending long-poll).
   *
   * `opts`'s type mirrors `createEnvelope`'s own per-type conditional
   * requiredness (finding F1) minus `seq` (computed fresh right here on
   * every call, never caller-supplied) — so every one of this method's 6
   * callers below must supply `taskId` for the 5 types that need it
   * (everything except `conn.ack`), same as calling `createEnvelope`
   * directly would require.
   */
  private sendToDevice<T extends 'conn.ack' | 'task.offer' | 'task.approve' | 'task.reject' | 'task.cancel' | 'task.steer'>(
    deviceId: string,
    type: T,
    payload: Parameters<typeof createEnvelope<T>>[1],
    opts: Omit<CreateEnvelopeOptions<T>, 'seq' | 'v' | 'id' | 'ts'>,
  ): Extract<Envelope, { type: T }> {
    this.envelopesOutCount++;
    const outbox = this.getOrCreateOutbox(deviceId);
    const seq = outbox.nextSeq++;
    // `createEnvelope`'s own public signature conditionally requires `opts`
    // per-T via a rest-parameter tuple (see codec.ts) — that detail doesn't
    // survive being re-forwarded through another generic function boundary
    // here, so this cast just restates what `opts`'s type above already
    // guarantees the caller supplied (taskId when T needs it).
    const combinedOpts = { ...opts, seq } as CreateEnvelopeOptions<T>;
    const envelope = createEnvelope(type, payload, combinedOpts);
    const taskId = (opts as { taskId?: string }).taskId;
    // N1/F4: task.cancel/task.reject move their task to Cancelled/Failed
    // (terminal) before this call — see cancelTask/rejectTask's own
    // mark-terminal-then-send order — so without this exemption
    // collectRelevant's terminal-task filter would always exclude them.
    // task.approve/task.steer never fire on an already-terminal task in the
    // first place (approveTask/steerTask both require a specific
    // non-terminal state), so the exemption is moot — and correctly
    // omitted — for them.
    const redeliverThroughTerminal = type === 'task.cancel' || type === 'task.reject';
    outbox.ring.push({ seq, taskId, envelope, redeliverThroughTerminal });
    if (outbox.ring.length > OUTBOX_RING_CAPACITY) outbox.ring.shift();
    this.deliverToDevice(deviceId, envelope);
    return envelope;
  }

  private deliverToDevice(deviceId: string, envelope: Envelope): void {
    const conn = this.connections.get(deviceId);
    if (conn?.connected && conn.ws) {
      conn.ws.send(encodeEnvelope(envelope));
    }
    // A device might be long-polling instead of WS-connected — wake it so
    // the new envelope is delivered immediately rather than at the next
    // poll's timeout.
    this.settleLongPollWaiter(deviceId);
  }

  /**
   * Retained envelopes for `deviceId` with `seq > cursor` that still belong
   * to a non-terminal task — OR are explicitly exempted from that filter
   * (`redeliverThroughTerminal`, N1/F4: `task.cancel`/`task.reject`) — in
   * `seq` order. The `seq > cursor` bound is what naturally stops an
   * exempted entry from redelivering forever: once the daemon acks it (its
   * reported cursor advances past that `seq`), it no longer qualifies here
   * on any future reconnect/poll.
   */
  private collectRelevant(deviceId: string, cursor: number): Envelope[] {
    const outbox = this.outboxes.get(deviceId);
    if (!outbox) return [];
    return outbox.ring
      .filter(
        (entry) =>
          entry.seq > cursor &&
          entry.taskId !== undefined &&
          (!this.isTaskTerminal(entry.taskId) || entry.redeliverThroughTerminal),
      )
      .map((entry) => entry.envelope);
  }

  private isTaskTerminal(taskId: string): boolean {
    const record = this.taskStore.get(taskId);
    return !record || isTerminal(record.state);
  }

  /** The highest `seq` assigned to `deviceId` so far — the redelivery cursor to hand back on a poll/reconnect. */
  private currentCursor(deviceId: string): number {
    const outbox = this.outboxes.get(deviceId);
    return outbox ? outbox.nextSeq - 1 : 0;
  }

  private getOrCreateOutbox(deviceId: string): DeviceOutbox {
    let outbox = this.outboxes.get(deviceId);
    if (!outbox) {
      outbox = { nextSeq: 1, ring: [] };
      this.outboxes.set(deviceId, outbox);
    }
    return outbox;
  }

  // ---------------------------------------------------------------------
  // read-only accessors backing the public `machines` / `tasks` API
  // ---------------------------------------------------------------------

  listMachines(): MachineInfo[] {
    return this.devices.listIds().map((deviceId) => {
      const conn = this.connections.get(deviceId);
      return {
        deviceId,
        deviceName: this.devices.getName(deviceId) ?? '(unknown)',
        connected: conn?.connected ?? false,
        lastSeen: conn?.lastSeen,
        runtimes: conn?.runtimes,
      };
    });
  }

  getTask(taskId: string): TaskSnapshot | undefined {
    return this.taskStore.get(taskId);
  }

  listTasks(): TaskSnapshot[] {
    return this.taskStore.list();
  }

  // ---------------------------------------------------------------------
  // observability (M4 Phase 4, part B.1) — in-process only; see
  // `types.ts`'s `HubStats`/`CreateByokServerOptions.healthzRoute` doc
  // comments for why this is never exposed over HTTP by this SDK itself.
  // ---------------------------------------------------------------------

  /**
   * A plain, serializable snapshot of this hub's current state, derived from
   * existing structures (`connections`, `taskStore`) plus the small counters
   * this file already maintains for exactly this purpose — no new
   * bookkeeping structures beyond those counters. See {@link HubStats}
   * (`types.ts`) for the full field-by-field contract.
   */
  stats(): HubStats {
    const taskCountsByState = Object.fromEntries(TASK_STATES.map((state) => [state, 0])) as Record<TaskState, number>;
    for (const record of this.taskStore.list()) {
      taskCountsByState[record.state]++;
    }

    let connectedDeviceCount = 0;
    for (const conn of this.connections.values()) {
      if (conn.connected) connectedDeviceCount++;
    }

    return {
      connectedDeviceCount,
      taskCountsByState,
      envelopesIn: this.envelopesInCount,
      envelopesOut: this.envelopesOutCount,
      dedupDrops: this.dedupDropCount,
      rateLimitEvents: this.rateLimitEventCount,
      uptimeMs: Date.now() - this.startedAtMs,
    };
  }
}
