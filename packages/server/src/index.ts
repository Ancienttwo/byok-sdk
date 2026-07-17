import type { Server as HttpServer } from 'node:http';
import type { Hono } from 'hono';
import { createHmacTokenSigner, DeviceRegistry, NonceStore } from './auth';
import { LocalDiskBlobStore } from './blob-store';
import { buildHonoApp } from './http';
import { ConnectionHub } from './hub';
import { PairingManager, type PairingCodeInfo } from './pairing';
import { TaskStore } from './task-store';
import { attachWebSocket as attachWsUpgrade } from './ws-server';
import type {
  ByokServerEvent,
  CreateByokServerOptions,
  DispatchInput,
  MachineInfo,
  TaskHandle,
  TaskSnapshot,
} from './types';

export type {
  ByokServerEvent,
  CreateByokServerOptions,
  DispatchInput,
  MachineInfo,
  ServerTaskEvent,
  TaskHandle,
  TaskResult,
  TaskSnapshot,
} from './types';
export { IllegalTaskTransitionError } from './task-store';
export { PairingCodeInvalidError } from './pairing';
export type {
  AccessTokenClaims,
  DeviceRecord,
  TokenSigner,
} from './auth';
export { createHmacTokenSigner, DeviceRegistry } from './auth';
export type {
  BlobStore,
  CreateUploadInput,
  ReadContentResult,
  WriteContentResult,
} from './blob-store';
export { LocalDiskBlobStore } from './blob-store';

/** Per-product blob size ceiling (§7): 100MB unless overridden. */
const DEFAULT_MAX_BLOB_SIZE_BYTES = 100 * 1024 * 1024;
/** `GET /byok/events` hold duration (§8): ~50s unless overridden (e.g. for tests). */
const DEFAULT_LONG_POLL_HOLD_MS = 50_000;

/** The object `createByokServer` returns — the SaaS-embedder-facing surface. */
export interface ByokServer {
  /** Hono app exposing the pair/challenge/token/blob/events HTTP routes. Mount it, or use its `.fetch` with `@hono/node-server`. */
  hono: Hono;
  /** Wire up the `GET /byok/ws` upgrade on the raw Node HTTP server serving `hono`. */
  attachWebSocket(server: HttpServer): void;
  pairing: {
    createPairingCode(): PairingCodeInfo;
  };
  dispatch(input: DispatchInput): Promise<TaskHandle>;
  tasks: {
    get(taskId: string): TaskSnapshot | undefined;
    list(): TaskSnapshot[];
  };
  machines: {
    list(): MachineInfo[];
  };
  events: {
    subscribe(): AsyncIterable<ByokServerEvent>;
  };
  /**
   * Device revocation (§6.3) — server-side only, no wire message. Revoking a
   * device makes its next `/byok/challenge`, `/byok/token`, WSS connect, or
   * authed HTTP call get a 401; its only recourse is to re-run `/byok/pair`.
   */
  devices: {
    revoke(deviceId: string): void;
  };
}

/**
 * In-memory reference implementation of the SaaS-side coordinator: Auth v2
 * device pairing/renewal/revocation, a WS + long-poll connection hub with
 * at-least-once redelivery, a local-disk blob store, and task dispatch/
 * lifecycle tracking. See the per-module doc comments (`auth.ts`,
 * `blob-store.ts`, `hub.ts`, `pairing.ts`, `ws-server.ts`) for what's a
 * pinned wire/HTTP contract (docs/protocol.md) versus a reference-impl
 * choice a SaaS embedder might swap out (`tokenSigner`, `blobStore`).
 */
export function createByokServer(opts: CreateByokServerOptions): ByokServer {
  const pairing = new PairingManager();
  const devices = new DeviceRegistry();
  const nonces = new NonceStore();
  const tokenSigner = opts.tokenSigner ?? createHmacTokenSigner();
  const blobStore = opts.blobStore ?? new LocalDiskBlobStore();
  const maxBlobSizeBytes = opts.maxBlobSizeBytes ?? DEFAULT_MAX_BLOB_SIZE_BYTES;
  const longPollHoldMs = opts.longPollHoldMs ?? DEFAULT_LONG_POLL_HOLD_MS;

  const taskStore = new TaskStore();
  const hub = new ConnectionHub(taskStore, devices);
  const hono = buildHonoApp({ pairing, devices, nonces, tokenSigner, blobStore, maxBlobSizeBytes, longPollHoldMs, hub });

  return {
    hono,
    attachWebSocket(server: HttpServer): void {
      attachWsUpgrade(server, {
        devices,
        tokenSigner,
        hub,
        productId: opts.productId,
        heartbeatIntervalMs: opts.heartbeatIntervalMs,
      });
    },
    pairing: {
      createPairingCode: () => pairing.createPairingCode(),
    },
    dispatch: (input: DispatchInput) => hub.dispatch(input),
    tasks: {
      get: (taskId: string) => hub.getTask(taskId),
      list: () => hub.listTasks(),
    },
    machines: {
      list: () => hub.listMachines(),
    },
    events: {
      subscribe: () => hub.subscribeServerEvents(),
    },
    devices: {
      revoke: (deviceId: string) => devices.revoke(deviceId),
    },
  };
}
