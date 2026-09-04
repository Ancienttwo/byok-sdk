import type {
  AgentContentReadPayload,
  AgentHomeProjectionPayload,
  AgentHomeProjectionReadback,
  AgentEventOrUnknown,
  AgentEgressPolicy,
  AgentEgressReliablePayload,
  AgentMessageEgressRequirement,
  AgentMessageServerContext,
  AgentMessagePublishPayload,
  AgentRef,
  BlobRef,
  DispatchSelection,
  PermissionPolicy,
  RuntimeCapabilities,
  RuntimeId,
  RuntimeInfo,
  TaskApprovalResolvedPayload,
  TaskArtifactPayload,
  TaskState,
  ToolsetId,
  TerminalProjectionSelection,
} from '@byok-sdk/protocol';
import type { TenantId, TokenSigner } from '@byok-sdk/cloud';
import type { RateLimiterOptions } from './rate-limiter';

/** Mutually-exclusive storage authority for the embedded reference server. */
export type ByokServerStorage =
  | { readonly kind: 'memory' }
  | {
      readonly kind: 'sqlite';
      /** File-backed SQLite database. `:memory:` is accepted for tests only. */
      readonly path: string;
      /** Lifetime of signed blob upload/download URLs. Default 15 minutes. */
      readonly urlTtlMs?: number;
    };

/** Options for {@link createByokServer}. */
export interface CreateByokServerOptions {
  /**
   * Identifies which product this server instance serves. Checked against the
   * `productId` a daemon announces in `conn.hello` — one daemon process is
   * always scoped to one product (see plan: "一产品一 daemon 进程"), so a
   * mismatched daemon is rejected at handshake time.
   */
  productId: string;
  /**
   * Embedded storage authority. Defaults to process-local memory. SQLite is
   * selected explicitly and fails closed if it cannot be opened; it never
   * falls back to memory.
   */
  storage?: ByokServerStorage;
  /** How long `GET /byok/events` holds an empty poll open before returning, ms (§8). Default ~50s; override for tests. */
  longPollHoldMs?: number;
  /** Per-product blob size ceiling in bytes (§7). Default 100MB. */
  maxBlobSizeBytes?: number;
  /** Override the reference {@link TokenSigner} (e.g. an org-wide/KMS-backed signer). */
  tokenSigner?: TokenSigner;
  /**
   * How many {@link ServerTaskEvent}s one task's `TaskHandle.events()` buffer
   * retains before the OLDEST are dropped and a single
   * `{ kind: 'error', reason: 'events_truncated' }` marker is appended. The
   * feed is a notification relay, not a second record of what happened — the
   * durable facts stay in the cloud stores (`tasks.get`, `result()`) — so a
   * consumer that stops reading costs bounded memory rather than unbounded
   * growth. Default 1000.
   */
  taskEventBufferLimit?: number;
  /**
   * How long after a task reaches a terminal its relay buffer and terminal
   * promise are RETAINED before being reclaimed, ms. A late `events()` reader
   * within this window still replays the whole feed; past it, the durable read
   * model (`tasks.get`) is the only answer. Default 5 minutes.
   *
   * Retention never decides when a feed ENDS: {@link TaskHandle.events}
   * completes at the terminal event itself, whenever that happens, so a
   * `for await` over it is never left waiting on this timer.
   */
  taskEventRetentionMs?: number;
  /**
   * M4 Phase 4 (part A): per-device inbound-envelope token bucket, enforced at
   * step 0 of the cloud kernel's inbound gate (`@byok-sdk/cloud`'s
   * `inbound.ts`) — the single choke point every daemon -> server envelope
   * passes through, debited BEFORE the type-allow check so a flood of
   * garbage-typed envelopes costs the same budget as a flood of well-formed
   * ones. Defaults: 50 msg/s sustained, burst 100 (see `rate-limiter.ts`).
   *
   * Exceeding it never drops silently: the occurrence counts in
   * {@link HubStats.rateLimitEvents} (per REFUSED envelope), and the first
   * refusal of an episode emits a `device.rate_limited`
   * {@link ByokServerEvent} — coalesced per episode, re-armed only by a later
   * successful consume by the same device. Enforcement on the wire is a
   * whole-request `429` from `POST /byok/messages`; `GET /byok/events` is not
   * on this bucket, and neither are the blob upload/download routes.
   */
  rateLimit?: RateLimiterOptions;
  /**
   * M4 Phase 4 (part B.2): opt-in `GET /healthz` liveness route layered on the
   * Hono app in front of the kernel — deliberately unauthenticated (no bearer
   * check) and carrying no sensitive data (no device ids, no counts), just
   * `{ok:true, uptimeMs}`, because a container orchestrator's liveness probe
   * must not need a device credential. Server-local rather than a kernel route
   * because it reports deployment liveness, not coordination. Default `false`
   * (no route mounted at all). `ByokServer.stats()` (richer detail) is never
   * exposed over HTTP by this SDK regardless of this flag — an embedder that
   * wants that surfaced remotely builds its own authenticated route around
   * it.
   */
  healthzRoute?: boolean;
  /**
   * Product-owned, authenticated task destination consumer.
   *
   * The cloud kernel's admission shape verbatim (`ByokCloudOptions.agentMessage`,
   * `@byok-sdk/cloud`): async, and carrying the tenant the message was
   * authenticated under. This façade forwards the hook to the kernel unchanged
   * rather than wrapping a second shape around it — one contract, documented in
   * one place. A one-shot break for embedders (WP3B §6); there is no adapter.
   */
  agentMessage?: {
    consume(input: {
      readonly tenant: TenantId;
      readonly deviceId: string;
      readonly taskId: string;
      readonly context: AgentMessageServerContext;
      readonly payload: AgentMessagePublishPayload;
    }): Promise<{
      readonly outcome: 'accepted' | 'held' | 'refused';
      readonly reasonCode?: string;
    }>;
  };
}

/** Input to {@link ByokServer.dispatch}. */
export interface DispatchInput {
  instruction: string;
  /**
   * Authoritative web-selected target. When present, `runtime` is derived
   * from `runtimeId`; supplying a different legacy `runtime` is rejected.
   */
  dispatchSelection?: DispatchSelection;
  runtime?: RuntimeId;
  policy?: PermissionPolicy;
  deviceId?: string;
  sessionRef?: string;
  /** Logical device-local MCP toolsets required for this task; never executable definitions. */
  requiredToolsets?: ToolsetId[];
  /** Explicit durable Agent identity; dispatches through task.offer_for_agent. */
  agentRef?: AgentRef;
  /**
   * An explicit, consumed Agent egress policy. This may only travel with an
   * Agent-bound offer on the distinct egress-aware wire message.
   */
  egressPolicy?: AgentEgressPolicy;
  /** Distinct user-visible message lane; independent of activity egress. */
  messageEgress?: AgentMessageEgressRequirement;
  /** Exact offer-scoped terminal projection authority. */
  terminalProjection?: TerminalProjectionSelection;
  /** Host-only product destination/freshness authority; never serialized to the daemon. */
  agentMessageContext?: AgentMessageServerContext;
}

/** Input to the distinct fresh-session Agent egress dispatch surface. */
export interface FreshAgentEgressDispatchInput
  extends Omit<DispatchInput, 'deviceId' | 'sessionRef' | 'agentRef' | 'egressPolicy'> {
  /** Exact target; fresh Agent dispatch never selects an ambient device. */
  deviceId: string;
  /** Exact durable Agent identity for the canonical-home execution. */
  agentRef: AgentRef;
  /** Exact policy revision consumed by the fresh execution. */
  egressPolicy: AgentEgressPolicy;
  messageEgress?: AgentMessageEgressRequirement;
  terminalProjection?: TerminalProjectionSelection;
  agentMessageContext?: AgentMessageServerContext;
}

/** Host control-plane input for one exact content-read request. */
export interface AgentContentReadRequest {
  readonly deviceId: string;
  readonly payload: AgentContentReadPayload;
}

/** Host control-plane input for one exact task-free Agent-home projection. */
export interface AgentHomeProjectionRequest {
  readonly deviceId: string;
  readonly payload: AgentHomeProjectionPayload;
}

/** Reference-server readback. The default implementation is process-local only. */
export type AgentHomeProjectionStatusReadback = AgentHomeProjectionReadback;

/** First-write-wins reference-server readback for a reliable Agent egress item. */
export interface AgentEgressReceipt {
  readonly deviceId: string;
  readonly payload: AgentEgressReliablePayload;
  readonly receiptId: string;
  readonly recordedAt: string;
}

/** Outcome of a task that reached a terminal state. */
export interface TaskResult {
  state: Extract<TaskState, 'Complete' | 'Failed' | 'Cancelled'>;
  summary?: string;
  sessionRef?: string;
  artifactRefs?: BlobRef[];
  reason?: string;
  retryable?: boolean;
  /**
   * The task's structured terminal result, projected verbatim from
   * `task.complete.document` (`@byok-sdk/protocol`'s `messages.ts`) — the
   * product's own JSON output, as opposed to `summary` (prose for a human)
   * or `artifactRefs` (files). `unknown` deliberately: this SDK never
   * understands or transforms the embedder's document schema. The wire
   * schema already enforced the only two rules there are (JSON-serializable,
   * within `RESULT_DOCUMENT_MAX_BYTES`) before this value ever reached the
   * hub, so the projection neither re-validates nor re-measures it.
   *
   * Absent whenever the daemon sent none — which covers both a daemon with
   * no `resultDocument` extractor configured and a pre-`result-document`
   * daemon build that has no notion of the field at all.
   *
   * Not stored by this package at all: the durable fact is the first terminal
   * receipt the kernel recorded (`readTerminalReceipt`/`readTaskResult`,
   * `@byok-sdk/cloud`), and every field here is projected off it on demand, so
   * there is no second authority for it to drift from.
   */
  document?: unknown;
}

/**
 * Normalized event stream for a dispatched task: incoming `task.progress`
 * AgentEvents, state transitions, and artifacts, folded into one feed so a
 * consumer only has to read one `events()` iterable per task.
 *
 * `event` is {@link AgentEventOrUnknown}, not the narrower `AgentEvent`
 * (pre-freeze tolerance, `@byok-sdk/protocol`'s `agent-event.ts`): an
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
  /**
   * M5 (approval targeting, docs/protocol.md §5.3): `opts.approvalId`
   * targets a SPECIFIC pending approval rather than "whichever one is
   * currently pending" (the default when `opts` is omitted, unchanged from
   * pre-M5). Thin wrapper over `ByokCloud.approveTask` (`@byok-sdk/cloud`) —
   * see that method's own doc comment for the full targeting/staleness
   * semantics, including when this throws `StaleApprovalError` (re-exported
   * from this package's index for a caller to catch/inspect). The host's
   * decision is authoritative immediately: it is recorded on the task's
   * durable approval timeline, so the task reads `Running` again without
   * waiting for the runtime to report back.
   */
  approve(opts?: { approvalId?: string }): Promise<void>;
  /** M5: same `opts.approvalId` targeting semantics as {@link approve} above. */
  reject(reason?: string, opts?: { approvalId?: string }): Promise<void>;
  steer(text: string): Promise<void>;
  result(): Promise<TaskResult>;
}

/** A device known to this server, joined from pairing identity + live connection state. */
export interface MachineInfo {
  deviceId: string;
  deviceName: string;
  connected: boolean;
  lastSeen?: string;
  /** Process-immutable Local Agent release from the current/last WS hello; omission means legacy/unknown. */
  clientVersion?: string;
  /** Runtimes detected on this device, as reported in its last `conn.hello` (M1: typed, replaces the old untyped `agents`). */
  runtimes?: RuntimeInfo[];
  /** Logical toolset IDs reported by the current daemon; omission means legacy/unknown. */
  configuredToolsets?: ToolsetId[];
}

/**
 * Projection of one task, read back from the cloud kernel's durable authority
 * (`TaskAttempt` plus its terminal receipt and approval timeline,
 * `@byok-sdk/cloud`) on every call — never a mirrored record this package
 * maintains alongside it.
 *
 * Deliberately smaller than it used to be: `instruction`, `runtime`, `policy`
 * and `requiredToolsets` were DISPATCH INPUT the host already holds and the
 * kernel does not persist (ADR-028 — an attempt records ownership and
 * disposition, not the request that produced it). A host that wants them back
 * keeps its own map keyed by `taskId`; this snapshot never re-derives them.
 */
export interface TaskSnapshot {
  taskId: string;
  /**
   * The wire {@link TaskState} this attempt projects to. Derived, in this
   * order: an accepted host cancellation is `Cancelled` whatever the runtime
   * later says; a terminal attempt is its own terminal; otherwise an
   * unresolved approval on the task's timeline is `AwaitApproval`; otherwise
   * the attempt's own coarse status.
   */
  state: TaskState;
  deviceId?: string;
  sessionRef?: string;
  /** Exact Agent identity for an Agent-bound task; absent for legacy tasks. */
  agentRef?: AgentRef;
  createdAt: string;
  updatedAt: string;
  result?: TaskResult;
  /**
   * M5 (approval targeting, docs/protocol.md §5.3): the daemon-reported
   * `approvalId` for the CURRENT `AwaitApproval` cycle, if one is pending —
   * `undefined` whenever the task isn't currently awaiting approval, OR it is
   * but no id was ever reported for it (a legacy daemon).
   *
   * DERIVED, not stored: it is `pendingApproval()`'s fold over the task's
   * durable approval timeline (`@byok-sdk/cloud`), the same single authority
   * the kernel's `approveTask`/`rejectTask` staleness gate reads. A resolution
   * — reported by the daemon, or recorded by this façade when the host
   * resolves one — clears the slot there, so a later `AwaitApproval` cycle can
   * never inherit a stale id and this projection can never disagree with the
   * gate.
   */
  pendingApprovalId?: string;
  /**
   * M5 (claimed runtime, docs/protocol.md §3.1): the ACTUAL adapter the
   * daemon reports having selected for this task (`task.claim.runtime`,
   * snapshotted by the kernel's inbound gate at the `offered -> claimed`
   * ownership CAS) — covers both the explicit-runtime
   * path (echoes {@link runtime}) and the auto-select/pi-first path (a value
   * where {@link runtime} is `undefined`, since no preference was ever
   * requested). `undefined` until the first `task.claim` for this task
   * arrives, and forever after for a legacy daemon that predates this field
   * (an old daemon's `task.claim` simply omits it). Set exactly once, at the
   * `Offered -> Claimed` transition, and never modified again afterward — a
   * retried/idempotent claim from the same device is a no-op that never
   * reaches `onClaim`'s patch at all (see `onClaim`'s own doc comment), so
   * this can never be silently overwritten by a redelivered claim. Read
   * straight off `TaskAttempt.claimedRuntime` (`@byok-sdk/cloud`).
   */
  claimedRuntime?: RuntimeId;
  /**
   * S0/D-4 (runtime-honest control surface): the capability block the
   * CLAIMING adapter reported for itself on its own `task.claim`
   * (`TaskClaimPayload.capabilities`, `@byok-sdk/protocol`), snapshotted at the
   * exact moment of the `Offered -> Claimed` transition and read straight off
   * `TaskAttempt.claimedRuntimeCapabilities` (`@byok-sdk/cloud`).
   *
   * Sourced from the claim and from nothing else. The connection-level
   * `conn.hello.runtimes[].capabilities` is discovery data — it describes a
   * device rather than the adapter that claimed this task — so it is never
   * read here or by the gate; see `SteerRejectedError`
   * (`@byok-sdk/cloud`'s `steer-control.ts`) for the full argument.
   *
   * A SNAPSHOT, deliberately — not a live read of anything: the same device
   * can reconnect later with a different adapter set (a runtime upgraded,
   * removed, or newly installed mid-task), and a task that is already running
   * must keep being judged against what was true when it was claimed.
   * `ByokCloud.steerTask` is the consumer: it fails closed with a
   * `SteerRejectedError` unless this snapshot says `steer === true`, BEFORE
   * any `task.steer` envelope exists.
   *
   * `undefined` means "this server does not know" — never "supported" and
   * never "unsupported as a fact". It stays `undefined` when the claim carried
   * no `capabilities` (a pre-D-4 daemon; the wire field is optional) and for
   * every task record written before S0 existed. Both are treated as a refusal
   * by the steer gate rather than filled in with a guessed default.
   *
   * Written exactly once, alongside {@link claimedRuntime}, on the first
   * real claim — a retried/idempotent claim returns from `onClaim` before
   * the patch, so this can never be silently rewritten later.
   */
  claimedRuntimeCapabilities?: RuntimeCapabilities;
}

/**
 * Cross-cutting server event feed (task creation/state changes, approval
 * resolutions, rate-limit episodes) — the "event hub" from the plan's
 * 服务端参考实现 section, as opposed to `TaskHandle.events()` which is scoped
 * to one task. Not part of the pinned wire contract; a server-embedder-facing
 * convenience.
 *
 * `device.connected` / `device.disconnected` are deliberately GONE (WP3B §1.2
 * option A). Both were edges of a live WebSocket registration; over the
 * long-poll transport the only honest connection signals are a device's own
 * `conn.hello` and its polling, and synthesising edges out of a TTL would
 * publish transitions no device ever made. `machines.list()` reports the
 * observation itself instead.
 */
export type ByokServerEvent =
  | { kind: 'task.created'; taskId: string; at: string }
  | {
      kind: 'task.state';
      taskId: string;
      state: TaskState;
      at: string;
      /**
       * M5 (claimed runtime): mirrors {@link TaskSnapshot.claimedRuntime} at
       * the moment of this transition — `undefined` until (and unless) the
       * daemon's `task.claim` reported one, so it first appears on the
       * `Offered -> Claimed` event and stays whatever value it had from then
       * on for every later transition of the same task. See that field's own
       * doc comment for the requested-vs-claimed distinction
       * (docs/protocol.md §3.1).
       */
      claimedRuntime?: RuntimeId;
    }
  /**
   * M4 Phase 3 hardening (orchestrator-directed): the daemon resolved a
   * pending approval entirely locally (M4 Phase 3's local `approvals.resolve`
   * control-socket path) — no wire `task.approve`/`task.reject` ever reached
   * the server for it. This fires when daemon-originated task traffic
   * (`task.progress`/`task.artifact`) for a task whose approval timeline still
   * shows an unresolved request proves, after the fact, that the approval was
   * resolved on the device. The façade records that resolution on the same
   * timeline, so the read model resumes from the one authority.
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
   * message rather than the server having to infer it from later task
   * traffic. Carries the same
   * `approvalId`/`decision`/`resolvedBy` the daemon reported, so an embedder
   * can render/audit exactly what was resolved and by which path, not just
   * that a resolution happened. `resolvedBy` is currently always `'local'`
   * (`@byok-sdk/protocol`'s `TaskApprovalResolvedPayloadSchema` — a single-value
   * enum today, future-proofed for an additional value later without a
   * version bump). Mutually exclusive with `task.approval_resolved_implicit`
   * for the same resolution: whichever mechanism the server processes first
   * clears the pending slot on the approval timeline, and the other finds
   * nothing left to clear by the time it would otherwise run.
   */
  | ({
      kind: 'task.approval_resolved';
      taskId: string;
      at: string;
      /**
       * M5 (hello-capability plumbing, docs/protocol.md §5.3): whether the
       * REPORTING device advertised the `approval-targeting` capability flag
       * (`version.ts`) in its `conn.hello` — an observability-only signal
       * (see that flag's own doc comment: it never gates matching, which is
       * always decided by field presence on the specific message). Always
       * `false` now: that flag was a property of the device's LIVE WebSocket
       * registration, which no longer exists, and the durable capability list
       * is a device-BUILD fact rather than a per-report one.
       */
      targeted: boolean;
    } & Pick<TaskApprovalResolvedPayload, 'approvalId' | 'decision' | 'resolvedBy'>)
  /**
   * M4 Phase 4 (part A): `deviceId` exceeded its inbound-envelope rate limit
   * (`CreateByokServerOptions.rateLimit`, enforced at step 0 of the cloud
   * kernel's inbound gate) — fired ONCE PER EPISODE, not once per refused
   * envelope: the first refusal emits it, and only a later successful consume
   * by the same device re-arms it, so a flood is one event and a device that
   * recovers and floods again is a second, distinct one. Never a silent drop
   * either way: every refused envelope counts in
   * {@link HubStats.rateLimitEvents}, and the request that carried it is
   * answered `429` by `POST /byok/messages`.
   */
  | { kind: 'device.rate_limited'; deviceId: string; at: string };

/**
 * Plain, serializable snapshot returned by `ByokServer.stats()` — M4 Phase 4
 * (part B.1).
 *
 * `envelopesOut` went with the in-process outbox that produced it: server ->
 * daemon envelopes are durable mailbox rows owned by the cloud kernel now, and
 * a counter here would be a second, weaker authority over a fact the mailbox
 * already holds exactly.
 *
 * Deliberately
 * NOT exposed over HTTP by this SDK (see `CreateByokServerOptions.healthzRoute`'s
 * doc comment): an embedder that wants any of this surfaced remotely builds
 * its own authenticated route around `ByokServer.stats()`.
 */
export interface HubStats {
  /** Devices this server has observed alive and not since forgotten — see {@link MachineInfo.connected}. */
  connectedDeviceCount: number;
  /** Every {@link TaskState} mapped to how many known tasks currently sit in it. */
  taskCountsByState: Record<TaskState, number>;
  /** Total inbound daemon->server envelopes the cloud kernel's inbound gate has been handed (every outcome, including rejected/rate-limited), counted at the gate's own step 0. */
  envelopesIn: number;
  /** Inbound envelopes recognized as an already-seen `(deviceId, id)` pair (N3) — a no-op wire-level success, counted here for observability. */
  dedupDrops: number;
  /** Inbound envelopes rejected for exceeding a device's rate limit — see `device.rate_limited` on {@link ByokServerEvent}. */
  rateLimitEvents: number;
  /** Milliseconds since `createByokServer` returned this instance. */
  uptimeMs: number;
}
