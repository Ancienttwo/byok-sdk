import type { CapabilityFlag, RuntimeId, RuntimeInfo } from '@byok/protocol';
import type { PermissionPolicy } from '@byok/protocol';
import type { RuntimeAdapter } from '../types';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { AuthManager } from './auth-manager';
import { BlobClient } from './blob-client';
import type { BackoffOptions, ConnectionState, LivenessOptions } from './ws-transport';
import { ConnectionManager } from './connection-manager';
import { CursorStore } from './cursor-store';
import { SessionWorkspaceStore } from './session-workspace-store';
import { DeviceStore, type DeviceRecord } from './store';
import { TaskRunner, type TaskRunnerDeps } from './task-runner';
import type { ProgressBatcherOptions } from './progress-batcher';

export interface DaemonConfig {
  productName: string;
  productId: string;
  serverUrl: string;
  deviceName?: string;
  workspaceRoot: string;
  runtimeAllowlist?: string[];
  permissionDefaults?: PermissionPolicy;
  storeDir?: string;
}

export interface DaemonStatus {
  paired: boolean;
  connected: boolean;
  /** True once the connection has fallen back to long-poll (protocol §8) — new task offers are declined `retryable:true` while this holds (no daemon->server HTTP path exists in that mode). */
  degraded: boolean;
  /** True once the server has revoked this device (401 on challenge/token, protocol §6.3). The only recourse is calling `pair()` again — the daemon does not keep retrying on its own. */
  revoked: boolean;
  deviceId?: string;
  activeTaskCount: number;
}

export interface Daemon {
  pair(pairingCode: string): Promise<DeviceRecord>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): DaemonStatus;
}

/** Internal seam so tests can substitute stub adapters / faster backoff+batch+liveness+long-poll timing. Also the real entry point for products wiring up more than the pi default (e.g. M2's claude/codex adapters). */
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

/** Runtimes actually detected as present on this device, typed per protocol §10 gap #4 (`ConnHelloPayload.runtimes`). Computed once at `start()` — re-probing on every reconnect would mean re-spawning each runtime's `--version` check for no real benefit within one daemon lifetime. */
async function detectRuntimes(adapters: RuntimeAdapter[]): Promise<RuntimeInfo[]> {
  const detections = await Promise.all(adapters.map(async (adapter) => ({ adapter, detected: await adapter.detect() })));
  const runtimes: RuntimeInfo[] = [];
  for (const { adapter, detected } of detections) {
    if (!detected.present || !isRuntimeId(adapter.id)) continue;
    const info: RuntimeInfo = { id: adapter.id };
    if (detected.version !== undefined) info.version = detected.version;
    if (detected.authPresent !== undefined) info.authPresent = detected.authPresent;
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

export function createDaemonWithAdapters(
  config: DaemonConfig,
  adapters: RuntimeAdapter[],
  overrides: DaemonOverrides = {},
): Daemon {
  const storeDir = config.storeDir ?? DeviceStore.defaultDir(config.productId);
  const store = new DeviceStore(storeDir);
  const cursorStore = new CursorStore(storeDir);
  const sessionWorkspaces = new SessionWorkspaceStore(storeDir);

  let connection: ConnectionManager | undefined;
  let connectionState: ConnectionState = 'closed';
  let runner: TaskRunner | undefined;

  const auth = new AuthManager({
    serverUrl: config.serverUrl,
    store,
    deviceName: config.deviceName,
    onRevoked: () => {
      connectionState = 'revoked';
    },
  });

  async function pair(pairingCode: string): Promise<DeviceRecord> {
    return auth.pair(pairingCode);
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
    const capabilities = computeCapabilities(adapters);

    const deps: TaskRunnerDeps = {
      adapters,
      runtimeAllowlist: config.runtimeAllowlist,
      permissionDefaults: config.permissionDefaults,
      workspaceRoot: config.workspaceRoot,
      deviceId: record.deviceId,
      send: (envelope) => connection?.send(envelope),
      blobClient,
      isTransportDegraded: () => connection?.isTransportDegraded() ?? false,
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
      onEnvelope: (envelope) => {
        void runner?.handleEnvelope(envelope);
      },
      onStateChange: (state) => {
        connectionState = state;
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

  function status(): DaemonStatus {
    return {
      paired: auth.deviceId !== undefined,
      connected: connectionState === 'open',
      degraded: connection?.isTransportDegraded() ?? false,
      revoked: connection?.isRevoked() ?? auth.isRevoked(),
      deviceId: auth.deviceId,
      activeTaskCount: runner?.activeTaskCount ?? 0,
    };
  }

  return { pair, start, stop, status };
}

/**
 * Public M0/M1 entry point: pi-only daemon, matching the documented config
 * shape exactly. Products needing more than the built-in pi adapter (e.g.
 * M2's claude/codex adapters) use `createDaemonWithAdapters` directly.
 */
export function createDaemon(config: DaemonConfig): Daemon {
  return createDaemonWithAdapters(config, [new PiAdapter()]);
}
