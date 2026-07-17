import type {
  AgentEventOrUnknown,
  BlobRef,
  PermissionPolicy,
  RuntimeId,
  RuntimeInfo,
  TaskArtifactPayload,
  TaskState,
} from '@byok/protocol';
import type { BlobStore } from './blob-store';
import type { TaskStore } from './task-store';
import type { TokenSigner } from './auth';

/** Options for {@link createByokServer}. */
export interface CreateByokServerOptions {
  /**
   * Identifies which product this server instance serves. Checked against the
   * `productId` a daemon announces in `conn.hello` — one daemon process is
   * always scoped to one product (see plan: "一产品一 daemon 进程"), so a
   * mismatched daemon is rejected at handshake time.
   */
  productId: string;
  /** WS-native ping interval, ms (§ heartbeat). Default 30s. */
  heartbeatIntervalMs?: number;
  /** How long `GET /byok/events` holds an empty poll open before returning, ms (§8). Default ~50s; override for tests. */
  longPollHoldMs?: number;
  /** Per-product blob size ceiling in bytes (§7). Default 100MB. */
  maxBlobSizeBytes?: number;
  /** Override the reference {@link BlobStore} (e.g. a real object-store-backed implementation, or `sqlite-blob-store.ts`'s `SqliteBlobStore` for a persistent single-node deployment). */
  blobStore?: BlobStore;
  /** Override the reference {@link TaskStore} (e.g. `sqlite-task-store.ts`'s `SqliteTaskStore` for a persistent single-node deployment). Defaults to an in-memory store that loses all task state on restart. */
  taskStore?: TaskStore;
  /** Override the reference {@link TokenSigner} (e.g. an org-wide/KMS-backed signer). */
  tokenSigner?: TokenSigner;
  /**
   * How long a `Claimed`/`Running`/`AwaitApproval` task may sit with no
   * inbound `task.*` activity from its owning device while that device is
   * dark (disconnected, or long-poll-silent) before the server reaps it to
   * `Failed(retryable: true, reason: 'lease-expired')` — no new task state,
   * no new wire message; the embedder is expected to re-dispatch as a
   * brand-new task, same as any other retryable failure. Deliberately
   * generous — it exists purely as a backstop for a device that never
   * reconnects at all (M1's redelivery, docs/protocol.md §9, already covers
   * "came back within the window"), so it must stay far larger than any
   * realistic task duration or it will race and fail perfectly healthy
   * long-running tasks. A task on a *connected*, actively-progressing
   * device is never touched regardless of this value — see
   * `ConnectionHub`'s lease-reaper doc comment (`hub.ts`) for the full
   * design and its accepted residual risk. Default 30 minutes.
   */
  taskLeaseMs?: number;
}

/** Input to {@link ByokServer.dispatch}. */
export interface DispatchInput {
  instruction: string;
  runtime?: RuntimeId;
  policy?: PermissionPolicy;
  deviceId?: string;
  sessionRef?: string;
}

/** Outcome of a task that reached a terminal state. */
export interface TaskResult {
  state: Extract<TaskState, 'Complete' | 'Failed' | 'Cancelled'>;
  summary?: string;
  sessionRef?: string;
  artifactRefs?: BlobRef[];
  reason?: string;
  retryable?: boolean;
}

/**
 * Normalized event stream for a dispatched task: incoming `task.progress`
 * AgentEvents, state transitions, and artifacts, folded into one feed so a
 * consumer only has to read one `events()` iterable per task.
 *
 * `event` is {@link AgentEventOrUnknown}, not the narrower `AgentEvent`
 * (pre-freeze tolerance, `@byok/protocol`'s `agent-event.ts`): an
 * unknown-type event — one a newer daemon/runtime-adapter minor version
 * produced that this build doesn't recognize — is forwarded here as-is
 * rather than dropped. It's still observability data a newer embedder UI
 * may understand even if this server doesn't; the reference server's job is
 * to tolerate and forward, not to decide what's renderable. Use the
 * exported `isKnownAgentEvent`/`partitionAgentEvents` helpers if a consumer
 * needs to distinguish the two.
 */
export type ServerTaskEvent =
  | { kind: 'state'; state: TaskState; at: string }
  | { kind: 'agent'; event: AgentEventOrUnknown }
  | { kind: 'artifact'; artifact: TaskArtifactPayload }
  | { kind: 'await_approval'; summary: string }
  | { kind: 'error'; reason: string; retryable?: boolean };

/** Handle returned by {@link ByokServer.dispatch} for one in-flight task. */
export interface TaskHandle {
  readonly taskId: string;
  events(): AsyncIterable<ServerTaskEvent>;
  cancel(reason?: string): Promise<void>;
  approve(): Promise<void>;
  reject(reason?: string): Promise<void>;
  steer(text: string): Promise<void>;
  result(): Promise<TaskResult>;
}

/** A device known to this server, joined from pairing identity + live connection state. */
export interface MachineInfo {
  deviceId: string;
  deviceName: string;
  connected: boolean;
  lastSeen?: string;
  /** Runtimes detected on this device, as reported in its last `conn.hello` (M1: typed, replaces the old untyped `agents`). */
  runtimes?: RuntimeInfo[];
}

/** Snapshot of a task as tracked by the in-memory {@link TaskStore}. */
export interface TaskSnapshot {
  taskId: string;
  state: TaskState;
  instruction: string;
  runtime?: RuntimeId;
  policy: PermissionPolicy;
  deviceId?: string;
  sessionRef?: string;
  createdAt: string;
  updatedAt: string;
  result?: TaskResult;
}

/**
 * Cross-cutting server event feed (device connects/disconnects, task
 * creation/state changes) — the "event hub" from the plan's 服务端参考实现
 * section, as opposed to `TaskHandle.events()` which is scoped to one task.
 * Not part of the pinned wire contract; a server-embedder-facing convenience.
 */
export type ByokServerEvent =
  | { kind: 'device.connected'; deviceId: string; at: string }
  | { kind: 'device.disconnected'; deviceId: string; at: string }
  | { kind: 'task.created'; taskId: string; at: string }
  | { kind: 'task.state'; taskId: string; state: TaskState; at: string };
