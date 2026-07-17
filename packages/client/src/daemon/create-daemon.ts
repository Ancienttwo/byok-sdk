import { createEnvelope } from '@byok/protocol';
import type { CapabilityFlag, RuntimeCapabilities as ProtocolRuntimeCapabilities, RuntimeId, RuntimeInfo } from '@byok/protocol';
import type { PermissionPolicy } from '@byok/protocol';
import type { RuntimeAdapter, RuntimeCapabilities } from '../types';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { AuthManager } from './auth-manager';
import { BlobClient } from './blob-client';
import type { BackoffOptions, ConnectionState, LivenessOptions } from './ws-transport';
import { ConnectionManager } from './connection-manager';
import { CursorStore } from './cursor-store';
import { DaemonObserver, type DaemonEventListener, type DaemonTaskInfo, type Unsubscribe } from './observer';
import { SessionWorkspaceStore } from './session-workspace-store';
import { DeviceStore, type DeviceRecord } from './store';
import { TaskRunner, type TaskRunnerDeps } from './task-runner';
import type { ProgressBatcherOptions } from './progress-batcher';

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

  let connection: ConnectionManager | undefined;
  let connectionState: ConnectionState = 'closed';
  let runner: TaskRunner | undefined;

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

  async function stop(): Promise<void> {
    await connection?.stop();
    auth.stop();
    connectionState = 'closed';
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
