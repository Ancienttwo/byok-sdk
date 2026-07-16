import os from 'node:os';
import { CAPABILITY_FLAGS, type PermissionPolicy } from '@byok/protocol';
import type { RuntimeAdapter } from '../types';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { DeviceStore, type DeviceRecord } from './store';
import { TaskRunner, type TaskRunnerDeps } from './task-runner';
import { WsTransport, type BackoffOptions } from './ws-transport';
import { toHttpBase } from './url';
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
  deviceId?: string;
  activeTaskCount: number;
}

export interface Daemon {
  pair(pairingCode: string): Promise<DeviceRecord>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): DaemonStatus;
}

/** Internal seam so tests can substitute stub adapters / faster backoff+batch timing. Also the real entry point for products wiring up more than the pi default (e.g. M2's claude/codex adapters). */
export interface DaemonOverrides {
  backoff?: BackoffOptions;
  batch?: ProgressBatcherOptions;
}

async function safeErrorText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export function createDaemonWithAdapters(
  config: DaemonConfig,
  adapters: RuntimeAdapter[],
  overrides: DaemonOverrides = {},
): Daemon {
  const store = new DeviceStore(config.storeDir ?? DeviceStore.defaultDir(config.productId));

  let deviceRecord: DeviceRecord | undefined;
  let transport: WsTransport | undefined;
  let runner: TaskRunner | undefined;
  let connected = false;

  async function pair(pairingCode: string): Promise<DeviceRecord> {
    const url = new URL('/byok/pair', toHttpBase(config.serverUrl));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode, deviceName: config.deviceName ?? os.hostname() }),
    });
    if (!res.ok) {
      throw new Error(`pairing failed: HTTP ${res.status} ${await safeErrorText(res)}`.trimEnd());
    }
    const body = (await res.json()) as DeviceRecord;
    await store.save(body);
    deviceRecord = body;
    return body;
  }

  async function start(): Promise<void> {
    deviceRecord ??= await store.load();
    if (!deviceRecord) {
      throw new Error('device is not paired yet; call pair(pairingCode) first');
    }
    const record = deviceRecord;

    const deps: TaskRunnerDeps = {
      adapters,
      runtimeAllowlist: config.runtimeAllowlist,
      permissionDefaults: config.permissionDefaults,
      workspaceRoot: config.workspaceRoot,
      deviceId: record.deviceId,
      send: (envelope) => transport?.send(envelope),
      batcherOptions: overrides.batch,
    };
    runner = new TaskRunner(deps);

    transport = new WsTransport({
      serverUrl: config.serverUrl,
      deviceToken: record.deviceToken,
      deviceId: record.deviceId,
      productId: config.productId,
      capabilities: [...CAPABILITY_FLAGS],
      onEnvelope: (envelope) => {
        void runner?.handleEnvelope(envelope);
      },
      onStateChange: (state) => {
        connected = state === 'open';
      },
      backoff: overrides.backoff,
    });
    transport.connect();
    await transport.waitForAck();
  }

  async function stop(): Promise<void> {
    transport?.close();
    connected = false;
  }

  function status(): DaemonStatus {
    return {
      paired: deviceRecord !== undefined,
      connected,
      deviceId: deviceRecord?.deviceId,
      activeTaskCount: runner?.activeTaskCount ?? 0,
    };
  }

  return { pair, start, stop, status };
}

/**
 * Public M0 entry point: pi-only daemon, matching the documented config
 * shape exactly. Products needing more than the built-in pi adapter (e.g.
 * M2's claude/codex adapters) use `createDaemonWithAdapters` directly.
 */
export function createDaemon(config: DaemonConfig): Daemon {
  return createDaemonWithAdapters(config, [new PiAdapter()]);
}
