import type {
  AgentEventOrUnknown,
  BlobRef,
  PermissionPolicy,
  RuntimeId,
  RuntimeInfo,
  TaskApprovalResolvedPayload,
  TaskArtifactPayload,
  TaskState,
} from '@byok/protocol';
import type { BlobStore } from './blob-store';
import type { RateLimiterOptions } from './rate-limiter';
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
  /**
   * M4 Phase 4 (part A): per-device inbound-envelope token bucket, enforced
   * by `ConnectionHub.handleInbound` (`hub.ts`) — the single choke point
   * both WS (`ws-server.ts`) and long-poll (`POST /byok/messages`, `http.ts`)
   * inbound traffic passes through. Defaults: 50 msg/s sustained, burst 100
   * (see `rate-limiter.ts`'s own defaults). Exceeding it never drops
   * silently: it counts in `ConnectionHub.stats()`'s `rateLimitEvents`, and
   * emits a `device.rate_limited` {@link ByokServerEvent} — see that
   * variant's own doc comment for the per-transport enforcement shape (WS
   * close vs. long-poll 429). Blob upload/download routes (`http.ts`) are
   * deliberately NOT covered by this same bucket — see that file's own
   * comment on why a shared limiter didn't drop in cleanly there.
   *
   * Honest caveat (no code change changes this — it's an inherent property
   * of an abrupt WS close, not something rate limiting adds): a
   * flood-triggered 1008 close is not special. Envelopes the daemon's own
   * WS transport already handed off to its socket write between the moment
   * the device exceeded budget and the close actually landing share the
   * ordinary at-most-once exposure of ANY abrupt WS disconnect (network
   * blip, server restart, etc.) — the wire's at-least-once guarantee
   * (docs/protocol.md §9) is specified for the server->daemon direction
   * only; daemon->server has no redelivery cursor to begin with, so this
   * was already true before rate limiting existed. A flood just makes that
   * pre-existing window more likely to have something in flight at the
   * exact moment of a close.
   */
  rateLimit?: RateLimiterOptions;
  /**
   * M4 Phase 4 (part B.2): opt-in `GET /healthz` liveness route on the Hono
   * app (`http.ts`) — deliberately unauthenticated (no bearer check) and
   * carrying no sensitive data (no device ids, no counts), just
   * `{ok:true, uptimeMs}`; see `http.ts`'s own comment on that route for the
   * full auth-posture rationale. Default `false` (no route mounted at all).
   * `ConnectionHub.stats()` (richer, in-process-only detail) is never
   * exposed over HTTP by this SDK regardless of this flag — an embedder that
   * wants that surfaced remotely builds its own authenticated route around
   * `stats()`.
   */
  healthzRoute?: boolean;
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
  | { kind: 'task.state'; taskId: string; state: TaskState; at: string }
  /**
   * M4 Phase 3 hardening (orchestrator-directed): the daemon resolved a
   * pending approval entirely locally (M4 Phase 3's local `approvals.resolve`
   * control-socket path) — no wire `task.approve`/`task.reject` ever reached
   * the server for it. This fires when daemon-originated task traffic
   * (`task.progress`/`task.artifact`/`task.complete`) for a task the server's
   * own record still has as `AwaitApproval` proves, after the fact, that the
   * approval was resolved on the device — see `ConnectionHub`'s
   * `resumeIfImplicitlyApproved` (hub.ts) for the state-machine side of this.
   * Deliberately NOT a wire message (no `packages/protocol` change) — a
   * first-class `task.approval_resolved` wire notification is a deferred
   * v1.1 candidate; this is purely an embedder-facing observability signal
   * so a SaaS UI can distinguish "approved server-side" from "the device
   * says it was approved locally" if it cares to.
   */
  | { kind: 'task.approval_resolved_implicit'; taskId: string; at: string }
  /**
   * M4 (additive-minor): the EXPLICIT counterpart to
   * `task.approval_resolved_implicit` above — fires when the daemon reports
   * a locally-resolved approval via the wire `task.approval_resolved`
   * message (`ConnectionHub.onApprovalResolved`, `hub.ts`) rather than the
   * server having to infer it from later task traffic. Carries the same
   * `approvalId`/`decision`/`resolvedBy` the daemon reported, so an embedder
   * can render/audit exactly what was resolved and by which path, not just
   * that a resolution happened. `resolvedBy` is currently always `'local'`
   * (`@byok/protocol`'s `TaskApprovalResolvedPayloadSchema` — a single-value
   * enum today, future-proofed for an additional value later without a
   * version bump). Mutually exclusive with `task.approval_resolved_implicit`
   * for the same resolution: whichever mechanism the server processes first
   * performs the actual `AwaitApproval -> Running` transition, and the other
   * is already a no-op by the time it would otherwise run — see
   * `onApprovalResolved`'s own doc comment (`hub.ts`) for the full
   * relationship.
   */
  | ({ kind: 'task.approval_resolved'; taskId: string; at: string } & Pick<
      TaskApprovalResolvedPayload,
      'approvalId' | 'decision' | 'resolvedBy'
    >)
  /**
   * M4 Phase 4 (part A): `deviceId` exceeded its inbound-envelope rate limit
   * (`CreateByokServerOptions.rateLimit`, enforced in
   * `ConnectionHub.handleInbound`, `hub.ts`) — fired for every envelope that
   * arrives once the bucket is empty, not just the first. Never a silent
   * drop: this event fires AND the occurrence is counted in
   * `ConnectionHub.stats()`'s `rateLimitEvents`. Per-transport enforcement
   * differs (both still emit this same event): a WS connection is closed
   * (policy-violation close code) right after, so the client's existing
   * backoff+reconnect (protocol §9's redelivery covers the rest); a
   * long-poll device has no live connection to close, so `POST
   * /byok/messages` (`http.ts`) instead answers that request with HTTP 429.
   */
  | { kind: 'device.rate_limited'; deviceId: string; at: string };

/**
 * Plain, serializable in-process snapshot returned by
 * `ConnectionHub.stats()` (`hub.ts`) — M4 Phase 4 (part B.1). Deliberately
 * NOT exposed over HTTP by this SDK (see `CreateByokServerOptions.healthzRoute`'s
 * doc comment): an embedder that wants any of this surfaced remotely builds
 * its own authenticated route around `ByokServer.stats()`.
 */
export interface HubStats {
  /** Devices with a currently-live WS or long-poll connection. */
  connectedDeviceCount: number;
  /** Every {@link TaskState} mapped to how many known tasks currently sit in it. */
  taskCountsByState: Record<TaskState, number>;
  /** Total inbound daemon->server envelopes {@link ConnectionHub.handleInbound} has ever been called with (every outcome, including rejected/rate-limited). */
  envelopesIn: number;
  /** Total server->daemon envelopes ever constructed via {@link ConnectionHub}'s single outbound choke point (`sendToDevice`), regardless of whether a live transport was available to flush them immediately. */
  envelopesOut: number;
  /** Inbound envelopes recognized as an already-seen `(deviceId, id)` pair (N3) — a no-op wire-level success, counted here for observability. */
  dedupDrops: number;
  /** Inbound envelopes rejected for exceeding a device's rate limit — see `device.rate_limited` on {@link ByokServerEvent}. */
  rateLimitEvents: number;
  /** Milliseconds since this `ConnectionHub` was constructed. */
  uptimeMs: number;
}
