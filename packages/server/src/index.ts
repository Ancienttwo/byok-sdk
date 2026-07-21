import type { Server as HttpServer } from 'node:http';
import type { Hono } from 'hono';
import { createHmacTokenSigner, DeviceRegistry, NonceStore } from './auth';
import { LocalDiskBlobStore } from './blob-store';
import { buildHonoApp } from './http';
import { ConnectionHub } from './hub';
import { PairingManager, type PairingCodeInfo } from './pairing';
import { RateLimiter } from './rate-limiter';
import { InMemoryTaskStore } from './task-store';
import { attachWebSocket as attachWsUpgrade } from './ws-server';
import type {
  ByokServerEvent,
  CreateByokServerOptions,
  DispatchInput,
  HubStats,
  MachineInfo,
  TaskHandle,
  TaskSnapshot,
} from './types';

export type {
  ByokServerEvent,
  CreateByokServerOptions,
  DispatchInput,
  HubStats,
  MachineInfo,
  ServerTaskEvent,
  TaskHandle,
  TaskResult,
  TaskSnapshot,
} from './types';
export type { CreateTaskInput, TaskRecord, TaskStore } from './task-store';
export { IllegalTaskTransitionError, InMemoryTaskStore } from './task-store';
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
export type { SqliteTaskStoreOptions } from './sqlite-task-store';
export { SqliteTaskStore } from './sqlite-task-store';
export type { SqliteBlobStoreOptions } from './sqlite-blob-store';
export { SqliteBlobStore } from './sqlite-blob-store';
export { SqliteUnavailableError } from './sqlite-support';
export type { RateLimiterOptions } from './rate-limiter';

/** Per-product blob size ceiling (§7): 100MB unless overridden. */
const DEFAULT_MAX_BLOB_SIZE_BYTES = 100 * 1024 * 1024;
/** `GET /byok/events` hold duration (§8): ~50s unless overridden (e.g. for tests). */
const DEFAULT_LONG_POLL_HOLD_MS = 50_000;
/**
 * Task lease ceiling (M2, Decision: `Failed(retryable:true)` on dark-device
 * timeout — no new task state, no new wire message; see `ConnectionHub`'s
 * lease-reaper doc comment in `hub.ts` for the full design). Deliberately
 * generous — 30 minutes, i.e. far larger than any realistic single task
 * turn — since it exists purely as a backstop for a device that never
 * reconnects at all, not a normal-latency timeout.
 */
const DEFAULT_TASK_LEASE_MS = 30 * 60_000;

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
  /**
   * Stop background timers owned by this server instance — currently just
   * the task-lease reaper (`ConnectionHub.stopLeaseReaper`, `hub.ts`). Call
   * this on shutdown so nothing keeps the process alive or leaks a handle in
   * tests; safe to call more than once.
   */
  stop(): void;
  /**
   * M4 Phase 4 (part B.1): a plain, serializable in-process snapshot of this
   * hub's current state — connected device count, task counts by state,
   * envelope in/out totals, dedup drops, rate-limit events, and uptime. See
   * {@link HubStats} for the full contract. Deliberately in-process only —
   * never exposed over HTTP by this SDK itself (see
   * `CreateByokServerOptions.healthzRoute`'s doc comment); an embedder that
   * wants any of this surfaced remotely builds its own authenticated route
   * around this method.
   */
  stats(): HubStats;
}

/**
 * In-memory reference implementation of the SaaS-side coordinator: Auth v2
 * device pairing/renewal/revocation, a WS + long-poll connection hub with
 * at-least-once redelivery, a local-disk blob store, and task dispatch/
 * lifecycle tracking. See the per-module doc comments (`auth.ts`,
 * `blob-store.ts`, `hub.ts`, `pairing.ts`, `ws-server.ts`) for what's a
 * pinned wire/HTTP contract (docs/protocol.md) versus a reference-impl
 * choice a SaaS embedder might swap out (`tokenSigner`, `blobStore`,
 * `taskStore` — the latter two default to in-memory/local-disk and lose all
 * state on restart; see `sqlite-task-store.ts`/`sqlite-blob-store.ts` for
 * persistent M3 alternatives implementing the same interfaces).
 */
export function createByokServer(opts: CreateByokServerOptions): ByokServer {
  const pairing = new PairingManager();
  const devices = new DeviceRegistry();
  const nonces = new NonceStore();
  const tokenSigner = opts.tokenSigner ?? createHmacTokenSigner();
  const blobStore = opts.blobStore ?? new LocalDiskBlobStore();
  const maxBlobSizeBytes = opts.maxBlobSizeBytes ?? DEFAULT_MAX_BLOB_SIZE_BYTES;
  const longPollHoldMs = opts.longPollHoldMs ?? DEFAULT_LONG_POLL_HOLD_MS;
  const taskLeaseMs = opts.taskLeaseMs ?? DEFAULT_TASK_LEASE_MS;

  const rateLimiter = new RateLimiter(opts.rateLimit);

  const taskStore = opts.taskStore ?? new InMemoryTaskStore();
  const hub = new ConnectionHub(taskStore, devices, taskLeaseMs, rateLimiter);
  const hono = buildHonoApp({
    pairing,
    devices,
    nonces,
    tokenSigner,
    blobStore,
    maxBlobSizeBytes,
    longPollHoldMs,
    hub,
    healthzRoute: opts.healthzRoute ?? false,
  });

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
    stop(): void {
      hub.stopLeaseReaper();
    },
    stats: () => hub.stats(),
  };
}
