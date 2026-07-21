import { createEnvelope, TASK_TRANSITIONS } from '@byok/protocol';
import type { CapabilityFlag, RuntimeCapabilities as ProtocolRuntimeCapabilities, RuntimeId, RuntimeInfo } from '@byok/protocol';
import type { PermissionPolicy } from '@byok/protocol';
import type { RuntimeAdapter, RuntimeCapabilities } from '../types';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { ApprovalNotFoundError, ApprovalRegistry } from './approvals';
import { AuthManager } from './auth-manager';
import { BlobClient } from './blob-client';
import type { BackoffOptions, ConnectionState, LivenessOptions } from './ws-transport';
import { AnotherControlServerRunningError, startControlServer } from './control-server';
import type { ControlMethods, ControlServerHandle } from './control-server';
import {
  ControlError,
  parseApprovalsRequestParams,
  parseApprovalsResolveParams,
  parseShutdownParams,
  type ControlActiveTask,
  type ControlStatusResult,
  type ShutdownReason,
} from './control-protocol';
import { ConnectionManager } from './connection-manager';
import { CursorStore } from './cursor-store';
import { DaemonObserver, type DaemonEventListener, type DaemonTaskInfo, type Unsubscribe } from './observer';
import { SessionWorkspaceStore } from './session-workspace-store';
import { DeviceStore, type DeviceRecord } from './store';
import { TaskRunner, type TaskRunnerDeps } from './task-runner';
import type { ProgressBatcherOptions } from './progress-batcher';

/** M4 Phase 2: bound on how long the control socket's `shutdown` RPC waits for `TaskRunner.shutdownActiveTasks` before proceeding to the rest of teardown regardless — an active task's `session.interrupt()` hanging (a misbehaving runtime adapter) must never block the daemon from actually stopping. */
const SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS = 10_000;

/** Finding F5(b): default bound on how long `performControlShutdown` waits for the outbox to actually drain before closing the connection — see `ConnectionManager.stop`'s own doc comment. Overridable via `DaemonOverrides.shutdown.outboxDrainTimeoutMs`. */
const DEFAULT_SHUTDOWN_OUTBOX_DRAIN_TIMEOUT_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Optional white-label product display info — purely opaque passthrough
 * (never interpreted, validated, or rendered by the daemon itself). Carried
 * through to `DaemonStatus.branding` (see `status()` below) so a downstream
 * CLI or audit log can render/stamp product identity without the daemon
 * needing to know anything about presentation. Deliberately a small,
 * open-ish shape rather than an exhaustive theming schema — add fields here
 * only as concrete consumers (CLI UX, audit log) need them.
 */
export interface DaemonBranding {
  /** Product/company name for banners, prompts, audit log entries, etc. */
  displayName?: string;
  /** Support/help URL surfaced alongside branding. */
  supportUrl?: string;
  /** Brand accent color (any CSS-color-like string — hex, name, etc.); not parsed or validated here. */
  accent?: string;
}

export interface DaemonConfig {
  productName: string;
  productId: string;
  serverUrl: string;
  deviceName?: string;
  workspaceRoot: string;
  /**
   * Restricts which runtimes this daemon will ever use — enforced in two
   * places that must stay consistent: `createDaemon` (this file) builds its
   * bundled adapter set FROM this list (unset = all three bundled adapters
   * — pi, claude, codex; set = exactly the listed runtime ids, unknown ids
   * ignored — see `buildDefaultAdapters`), and `TaskRunner.pickAdapter`
   * (`task-runner.ts`) separately fail-closed-rejects any `task.offer`
   * naming a runtime outside this list regardless of which adapters were
   * constructed. `createDaemonWithAdapters` callers supply their own
   * `adapters` array directly, so for them this field is enforcement-only,
   * unchanged from M1/M2.
   */
  runtimeAllowlist?: string[];
  permissionDefaults?: PermissionPolicy;
  storeDir?: string;
  /** Optional white-label branding — see `DaemonBranding`. Carried through verbatim to `status().branding`. */
  branding?: DaemonBranding;
}

export interface DaemonStatus {
  paired: boolean;
  connected: boolean;
  /** True once the connection has fallen back to long-poll (protocol §8) — transport info only (finding F6): long-poll is a full transport, so work still proceeds normally while this holds; outbound envelopes POST to /byok/messages instead of going out over WS. */
  degraded: boolean;
  /** True once the server has revoked this device (401 on challenge/token, protocol §6.3). The only recourse is calling `pair()` again — the daemon does not keep retrying on its own. */
  revoked: boolean;
  deviceId?: string;
  activeTaskCount: number;
  /** Passthrough of `DaemonConfig.branding` — `undefined` when the product configured none. See `DaemonBranding`. */
  branding?: DaemonBranding;
}

export interface Daemon {
  pair(pairingCode: string): Promise<DeviceRecord>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): DaemonStatus;
  /**
   * M3-2a: local observability — subscribe to live `DaemonEvent`s (task
   * feed, connection/pairing state changes, runtime-detection results) as
   * they happen on THIS daemon, no SaaS-side polling required. Returns an
   * unsubscribe function; a listener that throws is caught and logged, never
   * propagated (see `observer.ts`). Purely additive: emitting these never
   * changes `status()` or any existing wire/task behavior.
   */
  subscribe(listener: DaemonEventListener): Unsubscribe;
  /** M3-2a: current locally-known tasks and their derived state/summary (for a `tasks` CLI subcommand) — reflects only what this daemon has observed since it started; see `observer.ts`'s `DaemonObserver.tasks`. */
  tasks(): DaemonTaskInfo[];
  /**
   * M3-2a: clears this device's persisted identity/credentials and
   * disconnects — the next `start()` throws until `pair()` is called again.
   * Safe to call at any point in the daemon's lifecycle (never paired,
   * paired-but-not-started, or running).
   */
  unpair(): Promise<void>;
  /**
   * M3-2a: locally resolve a task currently paused on `needs_approval` —
   * drives the exact same code path a server-sent `task.approve` does
   * (`TaskRunner.handleApprove`), invoked directly instead of over the wire.
   * Honest-but-currently-unexercised: none of the three bundled adapters
   * (pi/claude/codex) ever actually pauses for approval — each one's
   * `resolveApproval` throws unconditionally (see `toRuntimeInfoCapabilities`'s
   * doc comment below) — so calling this against a task on this daemon today
   * always fails that task with a clear reason instead of resuming it,
   * exactly as an honest, doing-nothing-magic implementation should. Ready
   * for the day a runtime adapter implements real interactive approval, with
   * no further changes needed here. A no-op (resolves immediately) for a
   * `taskId` this daemon doesn't currently have active.
   */
  approve(taskId: string): Promise<void>;
  /** M3-2a: same as {@link approve} but rejects — see that method's doc comment. */
  reject(taskId: string, reason?: string): Promise<void>;
}

/** Internal seam so tests can substitute stub adapters / faster backoff+batch+liveness+long-poll timing. `createDaemonWithAdapters` (which takes this) is also the real entry point for products supplying a hand-built adapter set `createDaemon` can't construct on its own — e.g. custom adapter options or a runtime beyond the three bundled ones. */
export interface DaemonOverrides {
  backoff?: BackoffOptions;
  batch?: ProgressBatcherOptions;
  liveness?: LivenessOptions;
  /** M4 Phase 3: overrides `TaskRunner`'s default out-of-band approval wait (`DEFAULT_APPROVAL_TIMEOUT_MS`, 10 minutes) before an unanswered `requestApproval` force-resolves as a fail-closed rejection. */
  approvalTimeoutMs?: number;
  /** Finding F5: overrides for the control-socket shutdown path's own bounded waits — see `TaskRunner.shutdownTask`'s and `ConnectionManager.stop`'s own doc comments. Both default to 5s; neither affects an ordinary (non-shutdown-RPC) `daemon.stop()` call. */
  shutdown?: {
    /** Bound on how long `shutdownTask` waits for a single task's own `session.interrupt()` before giving up on it specifically and reporting `task.fail` anyway. Default `DEFAULT_SHUTDOWN_INTERRUPT_TIMEOUT_MS`. */
    taskInterruptTimeoutMs?: number;
    /** Bound on how long the control-socket shutdown path waits for the outbox to actually drain before closing the connection. Default `DEFAULT_SHUTDOWN_OUTBOX_DRAIN_TIMEOUT_MS`. */
    outboxDrainTimeoutMs?: number;
  };
  longPoll?: {
    /** Consecutive never-acked WS connect failures before falling back to long-poll. Default 3. */
    wsFailureThreshold?: number;
    /** While long-polling, how often to retry establishing WS. Default 5 minutes. */
    wsRetryIntervalMs?: number;
    /** Backoff between failed long-poll HTTP attempts. Default 2s. */
    retryDelayMs?: number;
    /** Minimum delay before the next long-poll request after an empty (no-events) response — avoids busy-looping against a server that responds instantly. Default 250ms. */
    idleDelayMs?: number;
  };
}

function isRuntimeId(id: string): id is RuntimeId {
  return id === 'pi' || id === 'claude' || id === 'codex';
}

/**
 * Maps a `RuntimeAdapter`'s own internal `capabilities()` result
 * (`../types.ts`'s `RuntimeCapabilities` — `{steer, resume,
 * permissionModes}`, always-required fields) onto the wire's
 * `RuntimeInfo.capabilities` shape (`@byok/protocol`'s `RuntimeCapabilities`
 * — the same field names, but all-optional, plus `approvalInteractive`).
 *
 * `approvalInteractive` is hardcoded `false` rather than derived: none of
 * the three bundled adapters (pi/claude/codex) has interactive approval —
 * verified per-adapter, not assumed. Each one's own `resolveApproval()`
 * either throws outright (codex: "codex exec never emits a
 * needs_approval-equivalent event"; claude: "every permission decision ...
 * resolved synchronously ... before this adapter ever sees the
 * corresponding frame") or has no notion of pausing for approval at all
 * (pi's `PiSession.resolveApproval` has the identical throwing contract —
 * see `../types.ts`'s `Session.resolveApproval` doc comment for why an
 * adapter with no `needs_approval` notion must throw here rather than
 * silently no-op). There is no existing signal on `RuntimeAdapter` this
 * could be read from instead — `interactive-approval` (`CAPABILITY_FLAGS`,
 * `@byok/protocol`) is explicitly documented as RESERVED/unexercised until
 * a later wave wires up the seam these adapters don't implement yet.
 */
function toRuntimeInfoCapabilities(caps: RuntimeCapabilities): ProtocolRuntimeCapabilities {
  return {
    steer: caps.steer,
    resume: caps.resume,
    approvalInteractive: false,
    permissionModes: caps.permissionModes,
  };
}

/** Runtimes actually detected as present on this device, typed per protocol §10 gap #4 (`ConnHelloPayload.runtimes`). Computed once at `start()` — re-probing on every reconnect would mean re-spawning each runtime's `--version` check for no real benefit within one daemon lifetime. */
async function detectRuntimes(adapters: RuntimeAdapter[]): Promise<RuntimeInfo[]> {
  const detections = await Promise.all(adapters.map(async (adapter) => ({ adapter, detected: await adapter.detect() })));
  const runtimes: RuntimeInfo[] = [];
  for (const { adapter, detected } of detections) {
    if (!detected.present || !isRuntimeId(adapter.id)) continue;
    const info: RuntimeInfo = { id: adapter.id };
    if (detected.version !== undefined) info.version = detected.version;
    if (detected.authPresent !== undefined) info.authPresent = detected.authPresent;
    // Pre-freeze addition (`RuntimeInfo.capabilities`, `messages.ts`):
    // surfaces this SAME adapter's own `capabilities()` (already used above
    // by `computeCapabilities` for the connection-level `steer` flag) into
    // the per-runtime wire field — see `toRuntimeInfoCapabilities`'s doc
    // comment.
    info.capabilities = toRuntimeInfoCapabilities(adapter.capabilities());
    runtimes.push(info);
  }
  return runtimes;
}

/**
 * M0 gatekeeper finding ②: advertise only what this device can actually do,
 * not a static spread of every known flag. `steer` reflects whether any
 * configured adapter can express it; `blob-upload` is unconditional now
 * that the blob client (protocol §7) genuinely implements it.
 */
function computeCapabilities(adapters: RuntimeAdapter[]): CapabilityFlag[] {
  const flags: CapabilityFlag[] = [];
  if (adapters.some((adapter) => adapter.capabilities().steer)) flags.push('steer');
  flags.push('blob-upload');
  return flags;
}

/**
 * Canonical construction order for `createDaemon`'s bundled adapter set —
 * also the priority order `TaskRunner.pickAdapter` falls back to when a
 * `task.offer` names no explicit runtime (`task-runner.ts`: first adapter
 * whose `detect()` finds it present on the device wins). Pi first preserves
 * the exact M0/M1 default behavior (pi was the only adapter that ever
 * existed then).
 */
const ALL_RUNTIME_IDS: readonly RuntimeId[] = ['pi', 'claude', 'codex'];

function buildAdapter(id: RuntimeId): RuntimeAdapter {
  switch (id) {
    case 'pi':
      return new PiAdapter();
    case 'claude':
      return new ClaudeAdapter();
    case 'codex':
      return new CodexAdapter();
  }
}

/**
 * Builds `createDaemon`'s bundled adapter set from `DaemonConfig.runtimeAllowlist`
 * — see that field's own doc comment for the unset-vs-set contract. Filters
 * `ALL_RUNTIME_IDS` (rather than mapping the allowlist directly) so an
 * allowlist entry that isn't a real runtime id is silently ignored — the same
 * "unknown id never gets an adapter" fail-closed shape `TaskRunner.pickAdapter`
 * already applies to an unknown *requested* runtime — and it de-duplicates
 * repeated entries for free.
 */
function buildDefaultAdapters(runtimeAllowlist: string[] | undefined): RuntimeAdapter[] {
  const ids = runtimeAllowlist
    ? ALL_RUNTIME_IDS.filter((id) => runtimeAllowlist.includes(id))
    : ALL_RUNTIME_IDS;
  return ids.map(buildAdapter);
}

export function createDaemonWithAdapters(
  config: DaemonConfig,
  adapters: RuntimeAdapter[],
  overrides: DaemonOverrides = {},
): Daemon {
  const storeDir = config.storeDir ?? DeviceStore.defaultDir(config.productId);
  const store = new DeviceStore(storeDir);
  const cursorStore = new CursorStore(storeDir);
  const sessionWorkspaces = new SessionWorkspaceStore(storeDir);
  // M3-2a: local observability — constructed once per daemon instance (not
  // per `start()`) so `subscribe()`/`tasks()` work immediately after
  // `createDaemonWithAdapters()` returns and keep accumulating across an
  // internal stop()/start() cycle within the same instance. See `observer.ts`.
  const observer = new DaemonObserver();
  // M4 Phase 2: registry backing the control socket's `approvals.list`/
  // `approvals.resolve` methods — see `approvals.ts`'s module doc comment.
  // Nothing populates it yet in Phase 2; it's constructed now so Phase 3
  // only needs to add producers.
  const approvalRegistry = new ApprovalRegistry();

  let connection: ConnectionManager | undefined;
  let connectionState: ConnectionState = 'closed';
  let runner: TaskRunner | undefined;
  // M4 Phase 2: local control socket (see `control-server.ts`) — started in
  // `start()`, closed in `stop()`. `undefined` whenever the daemon isn't
  // running, or when binding it failed non-fatally (see `start()`'s own
  // try/catch below).
  let controlServerHandle: ControlServerHandle | undefined;
  /** M4 Phase 2: when this `start()` began — backs the control socket's `status.uptimeMs`. */
  let startedAt: number | undefined;

  // M3-2a: `let`, not `const` — `unpair()` below rebuilds this from scratch
  // (fresh, no cached in-memory `record`) rather than mutating the existing
  // instance. `AuthManager` has no reset/forget method of its own (out of
  // scope: owned by a concurrent worker's untouched file) and caches its
  // `record` in memory once loaded, so merely clearing `store` on disk isn't
  // enough on its own — a same-process `loadExisting()` call would keep
  // returning the cached record. Reconstructing `auth` is the seam this file
  // already owns end-to-end; `pair`/`start`/`status`/`stop` all read the
  // CURRENT closure variable at call time, so a fresh instance is picked up
  // by every one of them with no further wiring.
  function buildAuthManager(): AuthManager {
    return new AuthManager({
      serverUrl: config.serverUrl,
      store,
      deviceName: config.deviceName,
      onRevoked: () => {
        connectionState = 'revoked';
      },
    });
  }
  let auth = buildAuthManager();

  async function pair(pairingCode: string): Promise<DeviceRecord> {
    // Finding F5: capture whatever device is currently on disk for this
    // serverUrl (if any) BEFORE pairing — `auth.pair()` mints/persists a
    // brand new deviceId (the server always does, even on a same-keypair
    // re-pair; see docs/protocol.md §6.3) and there would be no way to
    // recover the outgoing deviceId afterward to know whose cursor to clear.
    // Reading straight from `store` (not `auth.deviceId`) works whether or
    // not `start()`/`loadExisting()` ran in this process before `pair()`.
    const previous = await store.load();
    const record = await auth.pair(pairingCode);
    if (previous && previous.deviceId !== record.deviceId) {
      await cursorStore.clear(config.serverUrl, previous.deviceId);
    }
    observer.notePaired(record.deviceId);
    return record;
  }

  async function start(): Promise<void> {
    const record = await auth.loadExisting();
    if (!record) {
      throw new Error('device is not paired yet; call pair(pairingCode) first');
    }

    startedAt = Date.now();
    // M4 Phase 2: a second start() on THIS SAME Daemon instance (e.g. the
    // revoke -> re-pair -> start() again recovery flow) restarts its own
    // control socket rather than colliding with itself — `stop()` was not
    // necessarily called in between (mirrors `connection`/`runner` above,
    // which are also silently replaced on a second start()). Only a
    // DIFFERENT process/instance still holding this storeDir's control
    // socket open is the "another daemon is running" fatal case below.
    if (controlServerHandle) {
      await controlServerHandle.close();
      controlServerHandle = undefined;
    }
    // The control socket must never brick the rest of the daemon: "another
    // daemon's control server is already running against this exact
    // storeDir" is the one bind failure that stays fatal (a second daemon
    // writing to the same store concurrently is a real hazard); any other
    // bind failure (e.g. an unsupported filesystem) is logged and the
    // daemon proceeds without a control socket at all.
    try {
      controlServerHandle = await startControlServer({ storeDir, productId: config.productId, methods: controlMethods });
    } catch (err) {
      if (err instanceof AnotherControlServerRunningError) throw err;
      console.warn(
        `[byok/client] control socket failed to start (continuing without it): ${err instanceof Error ? err.message : String(err)}`,
      );
      controlServerHandle = undefined;
    }

    const [runtimes, blobClient] = await Promise.all([
      detectRuntimes(adapters),
      Promise.resolve(new BlobClient(config.serverUrl, auth)),
    ]);
    // M3-2a: local runtime-detection result — computed once per `start()`,
    // same as the `conn.hello.runtimes` it also feeds (see `detectRuntimes`'s
    // own doc comment on why this isn't re-probed on every reconnect).
    observer.noteRuntimesDetected(runtimes);
    const capabilities = computeCapabilities(adapters);

    const deps: TaskRunnerDeps = {
      adapters,
      runtimeAllowlist: config.runtimeAllowlist,
      permissionDefaults: config.permissionDefaults,
      workspaceRoot: config.workspaceRoot,
      deviceId: record.deviceId,
      // M3-2a: `send` is already this file's OWN closure (not something
      // `TaskRunner` builds) — every `task.claim`/`task.started`/
      // `task.progress`/`task.artifact`/`task.await_approval`/
      // `task.complete`/`task.fail`/`task.decline`/`task.cancelled`
      // `TaskRunner` ever emits passes through here. Feeding the observer
      // first (never throws — see `observer.ts`) and then sending exactly as
      // before is the entire integration; `task-runner.ts` itself is
      // untouched. See `observer.ts`'s module doc comment.
      send: (envelope) => {
        observer.handleOutboundEnvelope(envelope);
        connection?.send(envelope);
      },
      blobClient,
      batcherOptions: overrides.batch,
      sessionWorkspaces,
      // M4 Phase 3: the SAME `ApprovalRegistry` instance the control
      // socket's own `approvals.list`/`approvals.resolve` methods already
      // share (see that field's own construction above) — `TaskRunner
      // .requestApproval` registers into it directly, so a decision arriving
      // via either the server wire or the local CLI resolves the identical
      // entry. `storeDir`/`productId` let `TaskContext.approvalChannel`
      // (populated per-task by `TaskRunner`) tell an out-of-process helper
      // (`bin/byok-approval-mcp.ts`) exactly which control socket to dial.
      approvalRegistry,
      storeDir,
      productId: config.productId,
      approvalTimeoutMs: overrides.approvalTimeoutMs,
      // Finding F5(a): see TaskRunnerDeps.shutdownInterruptTimeoutMs's own doc comment.
      shutdownInterruptTimeoutMs: overrides.shutdown?.taskInterruptTimeoutMs,
      // M4 Phase 3 hardening: bridges TaskRunner's stale-approval-race
      // finding out to the SAME local observability seam every other
      // daemon-local event already uses (see observer.ts's own module doc
      // comment) — TaskRunner itself still has no notion `DaemonObserver`
      // exists, exactly like every other `deps.send`-shaped seam here.
      onStaleApprovalDecision: (taskId, decision, reason) => {
        observer.noteStaleApprovalDecision(taskId, decision, reason);
      },
      // Finding F4: see `TaskRunnerDeps.onApprovalDispatched`'s own doc
      // comment — lets `observer`'s `awaiting-approval` DaemonEvent (and
      // thus `tasks --follow`) surface the approvalId an operator actually
      // needs to call `approve`/`reject`/`approvals` against.
      onApprovalDispatched: (taskId, approvalId) => {
        observer.noteApprovalDispatched(taskId, approvalId);
      },
      // M4 (additive-minor, `task.approval_resolved`): read fresh at call
      // time via `connection` (assigned just below — safe by the time this
      // is actually invoked, same closure pattern `send` above already
      // relies on) rather than captured once here, since the negotiated
      // capability is only known once the handshake completes, strictly
      // after this `deps` object is constructed.
      getServerCapabilities: () => connection?.getServerCapabilities() ?? [],
    };
    runner = new TaskRunner(deps);

    connection = new ConnectionManager({
      serverUrl: config.serverUrl,
      deviceId: record.deviceId,
      productId: config.productId,
      capabilities,
      runtimes,
      auth,
      cursorStore,
      // Finding F3: return (not void-and-forget) so ConnectionManager can
      // await this handler and only advance/persist its redelivery cursor
      // once it actually resolves — see connection-manager.ts's `process`.
      // M3-2a: also this file's own closure, unrelated to F3's redelivery
      // semantics above — `handleInboundEnvelope` only ever looks at
      // `task.offer` (the one event with no corresponding outbound envelope
      // of its own) and never throws, so it can't affect cursor advancement.
      onEnvelope: (envelope) => {
        observer.handleInboundEnvelope(envelope);
        return runner?.handleEnvelope(envelope) ?? Promise.resolve();
      },
      onStateChange: (state) => {
        connectionState = state;
        observer.noteConnectionState(state);
      },
      backoff: overrides.backoff,
      liveness: overrides.liveness,
      wsFailureThreshold: overrides.longPoll?.wsFailureThreshold,
      wsRetryIntervalMs: overrides.longPoll?.wsRetryIntervalMs,
      longPollRetryDelayMs: overrides.longPoll?.retryDelayMs,
      longPollIdleDelayMs: overrides.longPoll?.idleDelayMs,
    });
    await connection.start();
    await connection.waitForAck();
  }

  /**
   * `opts.drainTimeoutMs` (finding F5(b)): threaded through to
   * `ConnectionManager.stop` — omitted here (the default, e.g. from the
   * public `Daemon.stop()`/`unpair()` paths) preserves the exact prior
   * behavior (no bounded wait); only `performControlShutdown` below passes
   * one, since that's the path a just-sent `task.fail` (from
   * `TaskRunner.shutdownTask`) actually needs a chance to drain before the
   * connection closes out from under it.
   */
  async function stop(opts: { drainTimeoutMs?: number } = {}): Promise<void> {
    await connection?.stop(opts.drainTimeoutMs);
    auth.stop();
    connectionState = 'closed';
    // M4 Phase 2: stop the control socket in every shutdown path — this is
    // the single lifecycle choke point every caller (a foreground abort via
    // `bin/commands/start.ts`, `unpair()` below, and the control socket's
    // OWN `shutdown` RPC — see `performControlShutdown`) already funnels
    // through, so nothing else needs its own control-socket teardown logic.
    await controlServerHandle?.close();
    controlServerHandle = undefined;
  }

  /**
   * M3-2a: clears this device's persisted identity and disconnects. Safe at
   * any point in the lifecycle:
   *  - `stop()` is a no-op beyond clearing state if `start()` was never
   *    called (`connection` stays `undefined`; `auth.stop()` on a
   *    never-renewed `AuthManager` just no-ops its unset timer).
   *  - `store.clear()` (`fs.rm(..., { force: true })`) is a no-op if this
   *    device was never paired.
   * Reads the on-disk record BEFORE clearing (mirrors `pair()`'s own F5
   * pattern above) so the cursor hygiene cleanup below knows which device's
   * entry to remove; rebuilding `auth` (see `buildAuthManager`) is what
   * actually makes the NEXT `start()` require a fresh `pair()` — clearing
   * `store` alone would leave a same-process `AuthManager`'s cached
   * in-memory record still usable.
   */
  async function unpair(): Promise<void> {
    const current = await store.load();
    await stop();
    await store.clear();
    if (current) {
      await cursorStore.clear(config.serverUrl, current.deviceId);
    }
    auth = buildAuthManager();
    observer.noteUnpaired();
  }

  /**
   * M3-2a: local approve/reject — see the `Daemon` interface's own doc
   * comments on {@link Daemon.approve}/{@link Daemon.reject} for the full
   * rationale (honest-but-currently-unexercised; every bundled adapter's
   * `resolveApproval` throws unconditionally today). Constructs the exact
   * envelope shape a server-sent `task.approve`/`task.reject` would be and
   * feeds it straight to `runner.handleEnvelope` — `TaskRunner`'s only public
   * entry point — rather than reaching into its private `handleApprove`/
   * `handleReject`. `seq: 0` is an inert local sentinel: this call never
   * passes through `ConnectionManager`, so nothing ever reads it as a real
   * redelivery cursor value, and `TaskRunner` itself only ever reads
   * `task_id`/`payload` off an approve/reject envelope, never `seq`.
   */
  async function approve(taskId: string): Promise<void> {
    if (!runner) throw new Error('daemon is not started; call start() first');
    await runner.handleEnvelope(createEnvelope('task.approve', {}, { taskId, seq: 0 }));
  }

  async function reject(taskId: string, reason?: string): Promise<void> {
    if (!runner) throw new Error('daemon is not started; call start() first');
    await runner.handleEnvelope(createEnvelope('task.reject', { reason }, { taskId, seq: 0 }));
  }

  // -------------------------------------------------------------------------
  // M4 Phase 2: control socket method registry (`control-server.ts` is
  // daemon-agnostic; this is the glue that closes over THIS daemon
  // instance's own state). Built once; every handler below reads `runner`/
  // `connection`/`connectionState`/`auth` fresh at CALL time via normal JS
  // closure semantics, so it stays correct across this daemon's own
  // start()/stop() cycles.
  // -------------------------------------------------------------------------

  function buildControlStatus(): ControlStatusResult {
    const activeTasks: ControlActiveTask[] = observer
      .tasks()
      .filter((task) => TASK_TRANSITIONS[task.state].length > 0) // non-terminal only — see the `status` method's own doc comment (control-protocol.ts)
      .map((task) => ({ taskId: task.taskId, state: task.state }));
    // Finding F4: computed once and reused for both `approvals` (the actual
    // entries, so `status`'s live section can render approvalIds without a
    // second control-socket round trip) and `approvalsPending` (the same
    // list's count) — same source `approvals.list` itself calls.
    const pendingApprovals = approvalRegistry.list();
    return {
      pid: process.pid,
      uptimeMs: startedAt !== undefined ? Date.now() - startedAt : 0,
      paired: auth.deviceId !== undefined,
      deviceId: auth.deviceId,
      transport: connectionState,
      activeTasks,
      runtimeIds: adapters.map((adapter) => adapter.id),
      // M4 Phase 4 (part B.3): queue watermarks come from TaskRunner's own
      // active-task map (distinct from `observer.tasks()` above, which is
      // derived from the envelope feed) — see `TaskRunner.getQueueWatermarks`'s
      // own doc comment for why this is a progress-batcher-backlog +
      // in-flight-approval-count proxy rather than the adapter's own event
      // queue depth.
      queueWatermarks: runner?.getQueueWatermarks() ?? [],
      approvals: pendingApprovals,
      approvalsPending: pendingApprovals.length,
    };
  }

  /**
   * The control socket's `shutdown` RPC — see this method's own protocol
   * doc comment (`control-protocol.ts`'s `ShutdownParams`) for the wire
   * contract. Order matters: offers must stop being claimed BEFORE active
   * tasks are torn down (so nothing new sneaks in claimed while that
   * happens), and active tasks must be reported failed BEFORE the
   * connection itself is closed (so that `task.fail` actually reaches the
   * server) — see `TaskRunner.shutdownActiveTasks`'s own doc comment.
   * Invoked from the RPC handler via `setImmediate` (see `controlMethods`
   * below) so the `{acknowledged:true}` response has already been written
   * to the wire before any of this runs.
   *
   * Gatekeeper-confirmed regression (fixed here): `noteShutdownRequested`
   * fires SYNCHRONOUSLY, before `shutdownActiveTasks` even calls
   * `session.interrupt()` — `observer.emit()` calls its listeners
   * synchronously, so `bin/commands/start.ts`'s subscriber used to be woken
   * IMMEDIATELY, race ahead, and call `daemon.stop()` (which sets
   * `ConnectionManager.stopped = true` synchronously) before the active
   * task's `task.fail` was ever sent — silently stranding it in a
   * post-`stopped` outbox that `drainOutbox` refuses to flush. Fixed by
   * emitting a SEPARATE, later `shutdown-complete` event only once THIS
   * function's own `stop()` call below has fully resolved — `start.ts` now
   * waits for that one instead, so it can never race ahead of this
   * function's own internal ordering. `shutdown-requested` is kept as an
   * earlier, informational-only audit marker; nothing may gate teardown
   * decisions on it.
   */
  async function performControlShutdown(reason: ShutdownReason | undefined): Promise<void> {
    const effectiveReason = reason ?? 'operator';
    observer.noteShutdownRequested(effectiveReason);
    // Hardening finding (P2 re-gate): `noteShutdownComplete` now fires in a
    // `finally` — `start.ts`'s own wait for THIS event (see the doc comment
    // above) is what makes `runStartCommand` return at all. Before this fix,
    // a throw anywhere in the body below (stopAcceptingOffers/
    // shutdownActiveTasks/stop() are all best-effort in their OWN
    // implementations today, but nothing here guaranteed one of them could
    // never throw in the future) would propagate out of this function
    // without ever emitting `shutdown-complete`, leaving `start.ts` waiting
    // forever — exactly the class of hang this event was introduced to
    // prevent in the first place. `finally` runs on both the success path
    // and any throw, and does not swallow the throw itself (it still
    // propagates to this function's own caller — the `shutdown` control
    // method's `.catch()` in `controlMethods` below — afterward).
    try {
      runner?.stopAcceptingOffers();
      const activeTeardown = runner?.shutdownActiveTasks(`control socket shutdown (${effectiveReason})`) ?? Promise.resolve();
      await Promise.race([activeTeardown, delay(SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS)]);
      // Finding F5(b): bounded wait for the outbox (e.g. the task.fail(s)
      // shutdownActiveTasks just enqueued) to actually drain — see
      // ConnectionManager.stop's own doc comment for why an unbounded wait
      // wasn't safe to make the universal default, and ConnectionManager
      // .outboxLength's doc comment for the honest-audit read right below.
      await stop({ drainTimeoutMs: overrides.shutdown?.outboxDrainTimeoutMs ?? DEFAULT_SHUTDOWN_OUTBOX_DRAIN_TIMEOUT_MS });
    } finally {
      // Finding F5(b): read AFTER stop() returns — 0 means the drain
      // genuinely finished in time; a positive count is an honest record
      // that this many envelopes (almost certainly including a task.fail
      // shutdownActiveTasks just sent) never actually left the outbox,
      // rather than the audit log silently implying full delivery.
      observer.noteShutdownComplete(effectiveReason, connection?.outboxLength() ?? 0);
    }
  }

  const controlMethods: ControlMethods = {
    unary: {
      status: () => buildControlStatus(),
      'approvals.list': () => ({ approvals: approvalRegistry.list() }),
      'approvals.resolve': (params) => {
        const parsed = parseApprovalsResolveParams(params);
        if (!parsed) throw new ControlError('bad_request', 'approvals.resolve requires {approvalId, decision}');
        try {
          approvalRegistry.resolve(parsed.approvalId, parsed.decision, parsed.reason);
        } catch (err) {
          if (err instanceof ApprovalNotFoundError) throw new ControlError('not_found', err.message);
          throw err;
        }
        return { resolved: true };
      },
      // M4 Phase 3: called by `bin/byok-approval-mcp.ts` — a claude-spawned
      // MCP-server child process, not this daemon's own adapter/session
      // in-process (see `types.ts`'s `ApprovalChannel` doc comment). Awaits
      // `TaskRunner.requestApproval`'s own returned promise directly, which
      // is exactly what lets this control call stay pending for as long as
      // `approvalTimeoutMs` allows (`control-server.ts`'s unary dispatch has
      // no timeout of its own — see its `dispatch()`) — the caller's own
      // `requestTimeoutMs` (`bin/control-client.ts`) must be configured
      // longer than that for the same reason.
      'approvals.request': (params) => {
        const parsed = parseApprovalsRequestParams(params);
        if (!parsed) throw new ControlError('bad_request', 'approvals.request requires {taskId, summary}');
        if (!runner) throw new ControlError('not_found', 'daemon is not started');
        return runner.requestApproval(parsed.taskId, parsed.summary);
      },
      shutdown: (params) => {
        const { reason } = parseShutdownParams(params);
        // Fire-and-forget, deliberately AFTER this handler's own return
        // value has been serialized and written to the socket (see
        // `control-server.ts`'s dispatch: it awaits this handler, THEN
        // writes the response) — `setImmediate` schedules the teardown for
        // the next macrotask tick, strictly after that write.
        setImmediate(() => {
          void performControlShutdown(reason).catch((err: unknown) => {
            console.error('[byok/client] error during control-socket shutdown teardown:', err);
          });
        });
        return { acknowledged: true };
      },
    },
    stream: {
      'tasks.subscribe': (_params, ctx) =>
        new Promise<void>((resolve) => {
          const unsubscribeObserver = observer.subscribe((event) => ctx.emit(event));
          ctx.signal.addEventListener(
            'abort',
            () => {
              unsubscribeObserver();
              resolve();
            },
            { once: true },
          );
        }),
    },
  };

  function subscribe(listener: DaemonEventListener): Unsubscribe {
    return observer.subscribe(listener);
  }

  function tasks(): DaemonTaskInfo[] {
    return observer.tasks();
  }

  function status(): DaemonStatus {
    return {
      paired: auth.deviceId !== undefined,
      connected: connectionState === 'open',
      degraded: connection?.isTransportDegraded() ?? false,
      revoked: connection?.isRevoked() ?? auth.isRevoked(),
      deviceId: auth.deviceId,
      activeTaskCount: runner?.activeTaskCount ?? 0,
      branding: config.branding,
    };
  }

  return { pair, start, stop, status, subscribe, tasks, unpair, approve, reject };
}

/**
 * Public white-label entry point (M0-M3): the "5-line launcher" — a product
 * only needs a `DaemonConfig`, no hand-built adapter list. The bundled
 * adapter set is built from `config.runtimeAllowlist` (see
 * `buildDefaultAdapters` and that field's own doc comment for the exact
 * unset-vs-set contract); with no `runtimeAllowlist` configured, the default
 * is ALL THREE bundled adapters (pi, claude, codex), not pi alone: M0/M1
 * hard-wired pi-only unconditionally, which meant any product wanting
 * claude/codex had to drop to `createDaemonWithAdapters` and hand-build
 * adapters just to get a runtime that was already built into this SDK.
 * `detectRuntimes` only ever advertises what's actually present on the
 * device (protocol §10 gap #4), so constructing an adapter for a runtime the
 * device doesn't have costs one quick failed `--version` probe at `start()`
 * and is otherwise invisible — there's no reason to withhold it by default.
 * Products that DO want to restrict to a subset set `runtimeAllowlist`
 * (also independently enforced at task-pick time — see
 * `TaskRunnerDeps.runtimeAllowlist` / `TaskRunner.pickAdapter`); products
 * needing something this can't build (custom adapter options, a fourth
 * in-house runtime, test stubs) use `createDaemonWithAdapters` directly.
 */
export function createDaemon(config: DaemonConfig): Daemon {
  return createDaemonWithAdapters(config, buildDefaultAdapters(config.runtimeAllowlist));
}
