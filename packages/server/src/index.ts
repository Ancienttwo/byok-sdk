import { ProjectionWaiters } from './projection-waiters';
export { listenLoopback } from './loopback';
export type { LoopbackPortStore, LoopbackHandler, LoopbackListenerOptions, LoopbackListener } from './loopback';
import type { AgentMessageDraftEvent } from './types';
export type { AgentMessageDraftEvent } from './types';
import { WakeScheduler } from './wakes/scheduler';
import type { WakeRecord, WakeScheduleInput, WakeScheduleResult } from './wakes/types';
export { WakeHookMissingError, WakeConflictError, WakeInputError, WakeClosedError, WAKE_MAX_FUTURE_MS } from './wakes/types';
export type { DueWake, WakeRecord, WakeScheduleInput, WakeScheduleResult, WakeConsumer, WakeInputErrorCode } from './wakes/types';
import { MaintenanceScheduler, assertMaintenanceInterval, DEFAULT_MAINTENANCE_INTERVAL_MS } from './maintenance-scheduler';
import { resolveRetentionPolicy, DEFAULT_MAINTENANCE_LIMIT, ByokCloudError, type MaintenanceReport } from '@byok-sdk/cloud';
export type { AgentExecutionInput } from '@byok-sdk/cloud';
import { Hono } from 'hono';
import {
  AgentExecutionInputSchema,
  agentHomeProjectionRequestKey,
  createByokCloud,
  createHmacTokenSigner,
  fullCapabilityDeclaration,
  INBOUND_REFUSAL_REASONS,
  TASK_ATTEMPT_ACTIVE_STATUSES,
  TASK_ATTEMPT_STATUSES,
  pendingApproval,
  type ByokCloud,
  type AgentExecutionInput,
  type AgentMemoryIntentNoticeInput,
  type EnqueuedAgentControl,
  type EnqueuedOffer,
  type InboundRefusalReason,
  type PairingCodeInfo,
  type PendingApproval,
  type TaskAttempt,
  type TenantId,
  type TerminalResult,
} from '@byok-sdk/cloud';
import {
  AgentContentReadPayloadSchema,
  AgentEgressPolicySchema,
  AgentHomeProjectionPayloadSchema,
  AgentMessageEgressRequirementSchema,
  AgentMessageServerContextSchema,
  AgentRefSchema,
  DispatchSelectionSchema,
  RequiredToolsetsSchema,
  TASK_STATES,
  TerminalProjectionSelectionSchema,
  AgentHomeAccessSchema,
  AgentMemorySelectionSchema,
  type AgentHomeProjectionPayload,
  type AgentHomeAccess,
  type AgentMemorySelection,
  type AgentRef,
  type AgentMessagePublishPayload,
  type AgentMessageDispositionPayload,
  type TaskState,
} from '@byok-sdk/protocol';
import { TaskEventRelay } from './relay';
import { toMachineInfo, toTaskResult, toTaskSnapshot, taskStateOf } from './snapshot';
import { composeFacadeStores, serverTenantId, DEFAULT_MAX_BLOB_SIZE_BYTES } from './stores';
import { approvePendingApproval, createTaskHandle, readTaskEvents, rejectPendingApproval } from './task-handle';
import type {
  ByokServerEvent,
  AgentContentReadRequest,
  AgentHomeProjectionRequest,
  AgentHomeProjectionStatusReadback,
  AgentEgressReceipt,
  ByokServerStorage,
  AgentResumeDispatchInput,
  CreateByokServerOptions,
  DispatchInput,
  HubStats,
  MachineInfo,
  ServerTaskEvent,
  TaskEventEntry,
  TaskHandle,
  TaskResult,
  TaskSnapshot,
} from './types';

export type {
  ByokServerEvent,
  AgentContentReadRequest,
  AgentHomeProjectionRequest,
  AgentHomeProjectionStatusReadback,
  AgentEgressReceipt,
  ByokServerStorage,
  AgentResumeDispatchInput,
  CreateByokServerOptions,
  DispatchInput,
  HubStats,
  MachineInfo,
  ServerTaskEvent,
  TaskEventEntry,
  TaskHandle,
  TaskResult,
  TaskSnapshot,
} from './types';
export { TaskEventsUnavailableError } from './types';
export type { InboundRefusalReason, TaskOfferReadback } from '@byok-sdk/cloud';
/**
 * M5 (approval targeting, docs/protocol.md §5.3): `TaskHandle.approve`/`reject`'s
 * `opts.approvalId` targeting throws this when the id names an approval the
 * task has already superseded, so a caller needs it to `instanceof`-check and
 * inspect the two ids. Re-exported from `@byok-sdk/cloud`, which owns the gate
 * both the embedded and the hosted surface are decided by — one class, one
 * `instanceof` that works across both.
 */
export { StaleApprovalError } from '@byok-sdk/cloud';
/**
 * S0 (GAP-002): `TaskHandle.steer` throws this when the runtime that claimed
 * the task cannot be steered, when the task isn't running, or when it's already
 * terminal. The GATE is the kernel's — it reads the claim-time capability
 * snapshot and nothing else — and so is the `code`. The CLASS is this
 * package's, because it carries `state: TaskState`, the wire vocabulary this
 * surface speaks and the kernel deliberately has no field for. See
 * `task-handle.ts` for the full reasoning and for why `SteerRejectionCode` and
 * {@link StaleApprovalError} stay kernel re-exports.
 */
export { SteerRejectedError } from './task-handle';
export type { SteerRejectionCode } from '@byok-sdk/cloud';
/**
 * Auth v2 types an embedder needs to talk about devices and tokens. All owned
 * by `@byok-sdk/cloud` now — this package no longer has an auth plane of its
 * own to keep in agreement with one.
 */
export type { AccessTokenClaims, DeviceRecord, PairingCodeInfo, TenantId, TokenSigner } from '@byok-sdk/cloud';
export { createHmacTokenSigner } from '@byok-sdk/cloud';
export { SqliteOwnershipError, SqliteSchemaError, SqliteUnavailableError } from './sqlite-support';
export type { SqliteSchemaErrorCode } from './sqlite-support';
// One-shot wire v3 -> v4 receipt migration (#925), operator-invoked. Shipped in
// 0.31.x only; the next minor removes it.
export { migrateSqliteToWireV4, preflightSqliteWireV4Migration } from './stores/sqlite/wire-v4-receipt-migration';
export type { RateLimiterOptions } from './rate-limiter';
export { DEFAULT_TASK_EVENT_BUFFER_LIMIT, DEFAULT_TASK_EVENT_RETENTION_MS } from './relay';

/** `GET /byok/events` hold duration (§8): ~50s unless overridden (e.g. for tests). */
const DEFAULT_LONG_POLL_HOLD_MS = 50_000;
/**
 * Default presence lease beyond one long-poll hold: a poll renews presence once,
 * when it starts, so a device must re-poll within this slack after a full hold
 * (reconnect, retry jitter) to stay connected.
 */
const DEFAULT_PRESENCE_GRACE_MS = 15_000;
/** Bytes of HMAC secret minted when an embedder supplies no {@link TokenSigner}. */
const TOKEN_SECRET_BYTES = 32;
/** Page size `tasks.list()` uses when the caller names none. */
export const DEFAULT_TASK_PAGE_LIMIT = 100;

/** Input to {@link ByokServer.pairing.createPairingCode}. */
export interface CreatePairingCodeInput {
  /**
   * The product the redeeming device pairs into. Must be this instance's own
   * `productId`: an embedded server serves exactly one product, and a code for
   * some other product would mint a device every bearer-authed route then
   * refuses (`instanceProductId`, `@byok-sdk/cloud`). Fail closed rather than
   * silently issuing an unusable code.
   *
   * The TENANT is not a parameter: it is derived from `productId` once, at
   * construction (`serverTenantId`, `stores.ts`), because this surface has no
   * second tenant to name.
   */
  readonly productId: string;
  /** Overrides the default single-use code lifetime. */
  readonly ttlMs?: number;
}

/** One bounded page of this server's tasks. */
export interface TaskPage {
  readonly tasks: readonly TaskSnapshot[];
  /**
   * Pass as the next call's `cursor`. ABSENT means the walk is over — a caller
   * stops on absence, not on an empty page, so a page that exactly fills
   * `limit` with nothing after it still terminates.
   */
  readonly nextCursor?: string;
}

/** Query for {@link ByokServer.tasks.list}. */
export interface TaskListQuery {
  /** Maximum snapshots in the page. Defaults to {@link DEFAULT_TASK_PAGE_LIMIT}. */
  readonly limit?: number;
  /** The `nextCursor` from the previous page; absent starts at the beginning. */
  readonly cursor?: string;
}

/** The object `createByokServer` returns — the SaaS-embedder-facing surface. */
export interface ByokServer {
  readonly wakes: {
    schedule(input: WakeScheduleInput): Promise<WakeScheduleResult>;
    /** Deletes only queued wakes. False for an in-flight wake means it was not cancelled; a rejection/deadline still retries it. */
    cancel(dedupKey: string): Promise<boolean>;
    /** Unfinished wakes, ordered by availableAt then wakeId. */
    pending(): Promise<readonly WakeRecord[]>;
  };
  /** Hono app exposing every device route, plus the opt-in `/healthz`. Mount it, or use its `.fetch` with `@hono/node-server`. */
  hono: Hono;
  pairing: {
    /** Mint a single-use pairing code for this server's product and tenant (docs/protocol.md §6.1). */
    createPairingCode(input: CreatePairingCodeInput): Promise<PairingCodeInfo>;
  };
  /** Submit one fresh Agent execution: persist the input first; a delivered taskId conflicts (`agent_task_already_exists`), recover via `tasks.offer`. */
  readonly executions: {
    /** Persist input before submitting; use tasks.offer for exact recovery after a conflict. */
    submit(input: AgentExecutionInput): Promise<EnqueuedOffer>;
  };
  dispatch(input: DispatchInput): Promise<TaskHandle>;
  /** Enqueue one capability-gated, exact-identity content-read request. */
  requestAgentContentRead(input: AgentContentReadRequest): Promise<void>;
  /** Enqueue one task-free, exact-device Agent-home projection. */
  enqueueAgentHomeProjection(input: AgentHomeProjectionRequest): Promise<AgentHomeProjectionStatusReadback>;
  /** Enqueue a content-free, capability-gated memory intent notice for this server's tenant. Approval and completion remain Host-owned. */
  enqueueAgentMemoryIntentNotice(deviceId: string, input: AgentMemoryIntentNoticeInput): Promise<EnqueuedAgentControl>;
  /** Durable desired-state and terminal-outcome readback for one exact device-and-Agent request. */
  readAgentHomeProjection(
    deviceId: string,
    agentRef: AgentRef,
    requestId: string,
  ): Promise<AgentHomeProjectionStatusReadback | undefined>;
  /** Wait without polling for durable terminal readback. Unknown requests return undefined; abort or server close rejects. */
  awaitAgentHomeProjection(
    deviceId: string, agentRef: AgentRef, requestId: string, options?: { signal?: AbortSignal },
  ): Promise<AgentHomeProjectionStatusReadback | undefined>;
  tasks: {
    /** Canonical durable attempt, including cancellation intent; not a resource-release observation. */
    attempt(taskId: string): Promise<TaskAttempt | undefined>;
    get(taskId: string): Promise<TaskSnapshot | undefined>;
    /** Actual device terminal, independently of Host cancellation or home release. */
    deviceTerminal(taskId: string): Promise<import('@byok-sdk/cloud').DeviceTerminal | undefined>;
    /** Immutable kernel offer readback for verifying a persisted host binding. No transport seq is inferred. */
    offer(taskId: string): Promise<import('@byok-sdk/cloud').TaskOfferReadback | undefined>;
    /** Stream display-only suffixes through the frozen Agent binding. */
    messageDraft(taskId: string, deviceId: string, agentRef: AgentRef, options?: { after?: import('@byok-sdk/cloud').AgentMessageDraftCursor; signal?: AbortSignal }): AsyncIterable<AgentMessageDraftEvent>;
    /** Discover the unique message and its pending/final disposition through the frozen Agent binding. */
    agentMessage(taskId: string, deviceId: string, agentRef: AgentRef): Promise<import('@byok-sdk/cloud').TaskAgentMessage | undefined>;
    /** Exact SDK message decision; pending is undefined and corrupt persisted evidence throws. */
    messageDisposition(taskId: string, deviceId: string, payload: AgentMessagePublishPayload): Promise<AgentMessageDispositionPayload | undefined>;
    /** Request cancellation through the kernel without a process-owned TaskHandle. */
    cancel(taskId: string, reason?: string): Promise<void>;
    /**
     * Approve the task's pending approval without a process-owned TaskHandle,
     * such as a task `executions.submit` created. The same decision and
     * refusals as {@link TaskHandle.approve}.
     */
    approve(taskId: string, opts?: { approvalId?: string }): Promise<void>;
    /** Reject the task's pending approval; the same decision and refusals as {@link TaskHandle.reject}. */
    reject(taskId: string, reason?: string, opts?: { approvalId?: string }): Promise<void>;
    /**
     * Follow one task's notifications (state, Agent progress, artifacts,
     * approval requests) in this instance's arrival order. It starts after the
     * entry `after` names; with `from: 'state'`, at the entries where the
     * task's current state began (its latest `state` entry, preceded by the
     * pending `await_approval` request while it awaits approval), which are
     * kept even after the buffer dropped them; otherwise at the start of what
     * is retained. An `events_truncated` entry stands for entries dropped
     * before the reader reached them. Ends after the terminal state, when
     * `signal` aborts, or when the server closes. A notification stream, not a
     * record: read task facts with {@link tasks.get}.
     *
     * A live task this instance did not dispatch (after a restart) gets a feed
     * whose first entry is its current state read back from the stores, and
     * no earlier events. That state can appear twice when the read saw a
     * commit the feed had not received yet.
     *
     * The first `next()` throws, before any entry: a `TypeError` when both
     * `after` and `from` are given, `ByokCloudError` `task_not_found` for an
     * unknown task, or {@link TaskEventsUnavailableError} when `after` is
     * unknown to this instance's feed or the terminal task's feed is no longer
     * retained.
     */
    events(taskId: string, options?: { after?: string; from?: 'state'; signal?: AbortSignal }): AsyncIterable<TaskEventEntry>;
    /**
     * One bounded page, keyset-paged by task id. Paged rather than "all of
     * them" because the underlying store is: an unbounded `list()` would have
     * to walk every page internally and hand back a snapshot that was never
     * consistent at any single instant.
     */
    list(query?: TaskListQuery): Promise<TaskPage>;
  };
  /** Trusted embedder access to committed blob download grants. */
  blobs: {
    getDownloadUrl(blobId: string): Promise<string | undefined>;
  };
  /** Reliable Agent egress receipt readback. */
  egress: {
    get(deviceId: string, agentRef: AgentRef, eventId: string): Promise<AgentEgressReceipt | undefined>;
  };
  machines: {
    list(): Promise<MachineInfo[]>;
  };
  events: {
    subscribe(): AsyncIterable<ByokServerEvent>;
  };
  /**
   * Device revocation (§6.3) — server-side only, no wire message. Revoking a
   * device DELETES its registration, so its next `/byok/challenge`,
   * `/byok/token`, or authed HTTP call gets a 401 — the same answer as for a
   * device id that was never registered — and its only recourse is to re-run
   * `/byok/pair`. The device-scoped state the row owned (outstanding challenge
   * nonces, presence, inbound dedup) is deleted with it; what the device DID
   * (tasks, receipts) is history and survives.
   *
   * DEVICE-ID ONLY. The hosted control plane's own revocation is tenant-first
   * (a tenant may only revoke a device it owns), but an embedded server owns
   * exactly ONE tenant and binds it here itself: `TenantId` is a branded type an
   * embedder cannot mint, and nothing on this surface — `ByokServer`,
   * `MachineInfo`, `PairingCodeInfo` — hands one back, so a tenant-first
   * parameter would make this method uncallable from outside the package rather
   * than safer. The scoping it provided is unchanged, just not the caller's to
   * state: a device id this server does not know resolves to nothing and is a
   * silent no-op.
   */
  devices: {
    revoke(deviceId: string): Promise<void>;
  };
  maintenance: { runNow(): Promise<MaintenanceReport> };
  /**
   * Release what this instance holds: the relay's per-task feeds and their
   * reclamation timers, and the connection observations. Call it on shutdown so
   * nothing keeps the process alive or leaks a handle in tests; safe to call
   * more than once. Drain pending store calls before releasing the selected
   * storage authority; await this before opening the SQLite file again.
   */
  close(): Promise<void>;
  /**
   * A plain, serializable snapshot of this server's current state. See
   * {@link HubStats} for the field-by-field contract.
   *
   * One store aggregate, an active-attempt page walk, then one approval read
   * per active attempt. No process-local task counts or startup history scan.
   * This is a multi-read observation, not a transaction snapshot; see HubStats.
   *
   * Deliberately in-process only: never exposed over HTTP by this SDK itself (see
   * `CreateByokServerOptions.healthzRoute`); an embedder that wants any of it
   * surfaced remotely builds its own authenticated route around this method.
   */
  stats(): Promise<HubStats>;
}

// A memory-reader Attempt reads memory only, so it cannot select a writing mode.
function refuseReaderMemoryWrite(agentMemory: AgentMemorySelection | undefined, homeAccess: AgentHomeAccess | undefined): void {
  if ((agentMemory === 'read-write' || agentMemory === 'read-write-if-admitted') && homeAccess === 'memory-reader') {
    throw new Error(`agentMemory ${agentMemory} requires a writer; a memory-reader Attempt reads memory only`);
  }
}

/**
 * Embedded reference coordinator: a thin façade over `@byok-sdk/cloud`'s
 * kernel, composed against the explicitly selected embedded stores.
 *
 * What that means concretely — and it is the whole point of WP3B — is that this
 * package owns NO coordination semantics any more. Pairing, tokens, the inbound
 * gate, task ownership, first-terminal-wins, approvals, steering, cancellation,
 * long-poll redelivery and the `cursor_too_old` floor are all the kernel's, and
 * a device cannot tell this from a hosted deployment. What is left here is the
 * embedded shape: one product, one tenant, a `TaskHandle` for hosts that want
 * one, an in-process notification relay, and the observability an embedder used
 * to get from the hub.
 *
 * State is in-memory by default. Explicit SQLite mode persists request receipts, the device directory and six
 * coordination interfaces whose contracts cross a process restart; all other
 * ports remain process-local.
 */
export function createByokServer(opts: CreateByokServerOptions): ByokServer {
  const policy = resolveRetentionPolicy(opts.maintenance?.policy);
  const maintenanceIntervalMs = opts.maintenance?.intervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
  assertMaintenanceInterval(maintenanceIntervalMs);
  const maintenanceLimit = opts.maintenance?.limit ?? DEFAULT_MAINTENANCE_LIMIT;
  if (!Number.isSafeInteger(maintenanceLimit) || maintenanceLimit < 1 || maintenanceLimit > 5000) throw new ByokCloudError('maintenance_invalid_input', 'Maintenance limit must be from 1 to 5000.');
  const startedAtMs = Date.now();
  const tenant = serverTenantId(opts.productId);
  const maxBlobSizeBytes = opts.maxBlobSizeBytes ?? DEFAULT_MAX_BLOB_SIZE_BYTES;
  const longPollHoldMs = opts.longPollHoldMs ?? DEFAULT_LONG_POLL_HOLD_MS;
  const presenceTtlMs = opts.presenceTtlMs ?? longPollHoldMs + DEFAULT_PRESENCE_GRACE_MS;
  // A lease no longer than one hold would expire a healthy device mid-poll.
  if (!Number.isSafeInteger(presenceTtlMs) || presenceTtlMs <= longPollHoldMs) {
    throw new Error(
      `presenceTtlMs must be an integer greater than longPollHoldMs (${longPollHoldMs}); got ${presenceTtlMs}`,
    );
  }

  const inboundRefusals = Object.fromEntries(INBOUND_REFUSAL_REASONS.map((reason) => [reason, 0])) as Record<InboundRefusalReason, number>;
  const relay = new TaskEventRelay({
    ...(opts.taskEventBufferLimit === undefined ? {} : { taskEventBufferLimit: opts.taskEventBufferLimit }),
    ...(opts.taskEventRetentionMs === undefined ? {} : { taskEventRetentionMs: opts.taskEventRetentionMs }),
  });

  const composition = composeFacadeStores({
    tenant,
    maxBlobSizeBytes,
    ...(opts.storage === undefined ? {} : { storage: opts.storage }),
    ...(opts.rateLimit === undefined ? {} : { rateLimit: opts.rateLimit }),
    presenceTtlMs,
    ...(opts.wake === undefined ? {} : { wake: opts.wake }),
    onRateLimited: (deviceId, at) => relay.emitServerEvent({ kind: 'device.rate_limited', deviceId, at }),
  });

  const wakes = new WakeScheduler(composition.wakes, opts.wake);

  const tokenSigner =
    opts.tokenSigner ??
    createHmacTokenSigner(
      globalThis.crypto.getRandomValues(new Uint8Array(TOKEN_SECRET_BYTES)),
      composition.clock,
    );

  const projectionWaiters = new ProjectionWaiters();
  const cloud: ByokCloud = createByokCloud({
    core: composition.core,
    cloud: composition.cloud,
    blobContentProxy: composition.blobContentProxy,
    e2eeMemberStore: composition.e2eeMember,
    ...(composition.proofReceiptAuthority === undefined ? {} : { proofReceiptRetention: { authority: composition.proofReceiptAuthority } }),
    crypto: composition.crypto,
    tokenSigner,
    clock: composition.clock,
    capabilities: fullCapabilityDeclaration(),
    // S1: the product this instance serves is part of every bearer-authed
    // route's decision, not just of the pairing claims.
    instanceProductId: opts.productId,
    observer: {
      onAgentHomeProjectionCompleted: (readback) => {
        if (readback.tenantId === tenant) projectionWaiters.notify(
          agentHomeProjectionRequestKey(readback.deviceId, readback.agentRef, readback.requestId));
      },
      onInboundCommitted: (input) => relay.onInboundCommitted(input),
      onInboundRefused: ({ reason }) => { inboundRefusals[reason] += 1; },
    },
    ...(opts.agentMessage === undefined ? {} : { agentMessage: opts.agentMessage }),
    maxBlobSizeBytes,
    longPollHoldMs,
    presenceTtlMs,
    // Transport observations and heartbeat publications renew the same lease.
    presenceMinimumIntervalMs: 0,
    mailboxWake: composition.mailboxWake,
  });

  const hono = new Hono();
  if (opts.healthzRoute === true) {
    // Deliberately UNAUTHENTICATED and minimal: a liveness probe must not need
    // a device credential, and the body carries no device ids and no counts.
    // `stats()` is the richer surface and is never routed anywhere by this SDK.
    hono.get('/healthz', (c) => c.json({ ok: true, uptimeMs: Date.now() - startedAtMs }, 200));
  }
  // Everything else IS the kernel. Mounted as a fallthrough rather than
  // re-declared route by route so this package can never publish a route the
  // kernel does not serve, or shadow one it does.
  hono.all('*', (c) => cloud.fetch(c.req.raw));

  async function readPending(taskId: string): Promise<PendingApproval | undefined> {
    return pendingApproval(await cloud.readApprovalTimeline(tenant, taskId));
  }

  async function readTerminal(taskId: string): Promise<TerminalResult | undefined> {
    return cloud.readTaskResult(tenant, taskId);
  }

  async function projectTask(attempt: TaskAttempt): Promise<TaskSnapshot> {
    const [pending, terminal, offer] = await Promise.all([
      readPending(attempt.taskId),
      readTerminal(attempt.taskId),
      cloud.readTaskOffer(tenant, attempt.taskId),
    ]);
    return toTaskSnapshot(attempt, pending, terminal, offer);
  }

  /**
   * The state `byok.tasks.get(taskId)` would report right now.
   *
   * Deliberately routed through `projectTask` rather than re-deriving it: a
   * refused steer reports the same `TaskState` the snapshot does, because it is
   * literally the snapshot's, read at the moment of the refusal.
   */
  async function readTaskState(taskId: string): Promise<{ state: TaskState; at: string } | undefined> {
    const attempt = await cloud.readTaskAttempt(tenant, taskId);
    if (attempt === undefined) return undefined;
    const { state, updatedAt } = await projectTask(attempt);
    return { state, at: updatedAt };
  }

  async function readApprovalRequest(taskId: string): Promise<ServerTaskEvent | undefined> {
    const timeline = await cloud.readApprovalTimeline(tenant, taskId);
    const pending = pendingApproval(timeline);
    const event = timeline?.entries.find((entry) => entry.revision === pending?.revision)?.event;
    return event?.type === 'approval_requested' && 'summary' in event && event.approvalId !== undefined
      ? { kind: 'await_approval', summary: event.summary, approvalId: event.approvalId }
      : undefined;
  }

  async function deviceCapabilities(deviceId: string): Promise<readonly string[] | undefined> {
    return (await composition.cloud.devices.get(tenant, deviceId))?.capabilities;
  }

  // An in-flight exclusion only; persisted task and receipt stores own identity.
  const dispatching = new Set<string>();
  /**
   * #654: this server builds plaintext offers from named fields only, so a
   * `sealing` or `sealed` key passed through a type cast would be dropped and
   * the task would run in plaintext. Refuse it, as the cloud plaintext lanes do.
   */
  function refuseSealedFields(input: unknown): void {
    if (input !== null && typeof input === 'object' && ('sealing' in input || 'sealed' in input)) {
      throw new ByokCloudError('coordination_input_invalid', 'this server has no sealed dispatch; sealing and sealed are refused');
    }
  }
  async function dispatchWithIdentity(input: DispatchInput): Promise<TaskHandle> {
    // Before the snapshot: a spread drops an inherited or non-enumerable key.
    refuseSealedFields(input);
    const submission = { ...input };
    const taskId = submission.taskId;
    if (taskId === undefined) return dispatchInternal(submission);
    if (typeof taskId !== 'string' || taskId.length === 0) throw new Error('taskId must be a non-empty string');
    if (dispatching.has(taskId)) throw new Error('dispatch for this taskId is already in progress; retain the original binding');
    dispatching.add(taskId);
    try { return await dispatchInternal(submission); }
    finally { dispatching.delete(taskId); }
  }

  async function dispatchInternal(
    input: DispatchInput,
  ): Promise<TaskHandle> {
    const sessionRef = input.sessionRef;
    // v4 has no runtime-only offer: every dispatch names its Agent.
    const agentRef = AgentRefSchema.parse(input.agentRef);
    const egressPolicy =
      input.egressPolicy === undefined ? undefined : AgentEgressPolicySchema.parse(input.egressPolicy);
    const messageEgress =
      input.messageEgress === undefined ? undefined : AgentMessageEgressRequirementSchema.parse(input.messageEgress);
    const terminalProjection =
      input.terminalProjection === undefined
        ? undefined
        : TerminalProjectionSelectionSchema.parse(input.terminalProjection);
    if (messageEgress === undefined && input.agentMessageContext !== undefined) {
      throw new Error('agentMessageContext requires messageEgress');
    }
    const homeAccess = input.homeAccess === undefined ? undefined : AgentHomeAccessSchema.parse(input.homeAccess);
    const agentMemory = input.agentMemory === undefined ? undefined : AgentMemorySelectionSchema.parse(input.agentMemory);
    refuseReaderMemoryWrite(agentMemory, homeAccess);
    const agentMessageContext =
      messageEgress === undefined ? undefined : AgentMessageServerContextSchema.parse(input.agentMessageContext);
    const dispatchSelection =
      input.dispatchSelection === undefined ? undefined : DispatchSelectionSchema.parse(input.dispatchSelection);
    const requiredToolsets =
      input.requiredToolsets === undefined ? undefined : RequiredToolsetsSchema.parse(input.requiredToolsets);

    if (messageEgress !== undefined && egressPolicy === undefined) {
      throw new Error('Agent message egress requires the typed Agent egress offer path');
    }

    const deviceId = input.deviceId;
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      throw new Error('dispatch requires an explicit deviceId (non-empty string)');
    }

    // Agent dispatch is resume-only (#484): a fresh Agent execution has the
    // single authority executions.submit. Refused before any capability read,
    // so the caller gets this error whatever the target device advertises.
    if (egressPolicy === undefined && (sessionRef === undefined || sessionRef.length === 0)) {
      throw new Error(
        'Agent resume dispatch requires an exact sessionRef; use executions.submit for fresh execution',
      );
    }

    // The gates the kernel does not run, in the pre-fold order. Everything
    // below the kernel DOES run (agent-home-contract, the
    // egress/message/terminal-projection capabilities) is left to it rather
    // than duplicated here, so there is one place each admission is decided.
    const capabilities = await deviceCapabilities(deviceId);
    if (dispatchSelection !== undefined && !(capabilities?.includes('dispatch-selection') ?? false)) {
      throw new Error(
        `device ${deviceId} did not advertise dispatch-selection capability; refusing authoritative provider/model dispatch`,
      );
    }
    if (requiredToolsets !== undefined) {
      if (!(capabilities?.includes('toolset-selection') ?? false)) {
        throw new Error(
          `device ${deviceId} did not advertise toolset-selection capability; refusing a task whose semantics require local MCP tools`,
        );
      }
    }
    if (
      dispatchSelection !== undefined &&
      input.runtime !== undefined &&
      input.runtime !== dispatchSelection.runtimeId
    ) {
      throw new Error(
        `dispatch runtime ${input.runtime} does not match dispatchSelection.runtimeId ${dispatchSelection.runtimeId}`,
      );
    }
    const runtime = dispatchSelection?.runtimeId ?? input.runtime;
    const common = {
      ...(input.harnessId === undefined ? {} : { harnessId: input.harnessId }),
      instruction: input.instruction,
      ...(runtime === undefined ? {} : { runtime }),
      ...(dispatchSelection === undefined ? {} : { dispatchSelection }),
    };

    // A known id lets the relay exist before enqueue can make the offer
    // observable. Inbound claim/terminal traffic racing append is buffered by
    // the dispatching relay feed and delivered once the offer succeeds.
    const taskId = input.taskId ?? globalThis.crypto.randomUUID();
    relay.provision(taskId);
    let enqueued: EnqueuedOffer;
    try {
      enqueued = await (async () => {
        if (sessionRef === undefined) {
          throw new Error(
            'Agent egress resume dispatch requires an exact sessionRef; use executions.submit for fresh execution',
          );
        }
        if (egressPolicy !== undefined) {
          return cloud.enqueueAgentEgressOffer(tenant, deviceId, {
            taskId,
            payload: {
              ...common,
              sessionRef,
              agentRef,
              egressPolicy,
              ...(terminalProjection === undefined ? {} : { terminalProjection }),
              ...(homeAccess === undefined ? {} : { homeAccess }),
              ...(agentMemory === undefined ? {} : { agentMemory }),
              ...(messageEgress === undefined ? {} : { messageEgress }),
              ...(requiredToolsets === undefined ? {} : { requiredToolsets }),
            },
            ...(agentMessageContext === undefined ? {} : { agentMessageContext }),
          });
        }
        return cloud.enqueueAgentOffer(tenant, deviceId, {
          taskId,
          payload: {
            ...common,
            agentRef,
            sessionRef,
            ...(terminalProjection === undefined ? {} : { terminalProjection }),
            ...(homeAccess === undefined ? {} : { homeAccess }),
            ...(agentMemory === undefined ? {} : { agentMemory }),
            ...(requiredToolsets === undefined ? {} : { requiredToolsets }),
          },
        });
      })();
    } catch (error) {
      relay.abort(taskId);
      throw error;
    }

    // The feed reports the original delivery timestamp. Snapshots use the
    // immutable offer receipt's creation instant, even after a restart.
    const createdAt = enqueued.envelope.ts;
    relay.noteDispatched(enqueued.taskId, createdAt);
    return handleFor(enqueued.taskId);
  }

  function handleFor(taskId: string): TaskHandle {
    return createTaskHandle(taskId, {
      tenant,
      cloud,
      relay,
      readState: readTaskState,
      readApprovalRequest,
      readResult: async (id) => toTaskResult(await readTerminal(id)),
    });
  }

  const scheduler = new MaintenanceScheduler(async () => {
    const report = await cloud.runMaintenance({ tenant, now: composition.clock.now().toISOString(), policy, limit: maintenanceLimit });
    relay.emitServerEvent(report.steps.some(step => step.status === 'failed') ? { kind: 'maintenance.failed', report } : { kind: 'maintenance.completed', report });
    return report;
  }, maintenanceIntervalMs, (error) => relay.emitServerEvent({ kind: 'maintenance.failed', errorCode: error instanceof ByokCloudError ? error.code : 'maintenance_step_failed' }));
  async function readAgentHomeProjection(deviceId: string, agentRef: AgentRef, requestId: string): Promise<AgentHomeProjectionStatusReadback | undefined> {
    // The durable request lookup is exact to the device and AgentRef. The
    // stored request remains the authority for the projection hash.
    const stored = await composition.cloud.receipts.get(
      tenant,
      agentHomeProjectionRequestKey(deviceId, agentRef, requestId),
    );
    if (stored === undefined) return undefined;
    let desired: AgentHomeProjectionPayload;
    try {
      desired = AgentHomeProjectionPayloadSchema.parse(JSON.parse(stored.body));
    } catch {
      return undefined;
    }
    return cloud.getAgentHomeProjectionStatus(tenant, deviceId, {
      requestId: desired.requestId,
      agentRef: desired.agentRef,
      projectionHash: desired.projectionHash,
    });
  }

  const draftShutdown = new AbortController();
  const draftReads = new Set<Promise<unknown>>();
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    draftShutdown.abort();
    projectionWaiters.stop();
    return closePromise ??= Promise.all([scheduler.close(), wakes.close()])
      .finally(async () => {
        await Promise.allSettled(draftReads);
        await projectionWaiters.drain();
        relay.stop();
        await composition.close();
      })
      .then(() => undefined);
  }

  return {
    wakes: {
      schedule: input => wakes.schedule(input),
      cancel: key => wakes.cancel(key),
      pending: () => wakes.pending(),
    },
    hono,

    pairing: {
      // `async`, not a plain function that throws: the declared contract is a
      // promise, and a guard that threw synchronously would refuse a
      // cross-product mint through a channel no `await`/`.catch()` caller of a
      // promise-returning method handles. Fail closed, on the same channel as
      // every other failure of this method.
      async createPairingCode(input: CreatePairingCodeInput): Promise<PairingCodeInfo> {
        if (input.productId !== opts.productId) {
          throw new Error(
            `pairing code product ${input.productId} does not match this server's product ${opts.productId}`,
          );
        }
        return cloud.createPairingCode(tenant, {
          productId: input.productId,
          ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
        });
      },
    },

    dispatch(input: DispatchInput): Promise<TaskHandle> {
      return dispatchWithIdentity(input);
    },

    async requestAgentContentRead(input: AgentContentReadRequest): Promise<void> {
      const payload = AgentContentReadPayloadSchema.parse(input.payload);
      await cloud.enqueueAgentContentRead(tenant, input.deviceId, { payload });
    },

    async enqueueAgentHomeProjection(
      input: AgentHomeProjectionRequest,
    ): Promise<AgentHomeProjectionStatusReadback> {
      const payload = AgentHomeProjectionPayloadSchema.parse(input.payload);
      return (await cloud.enqueueAgentHomeProjection(tenant, input.deviceId, payload)).status;
    },

    enqueueAgentMemoryIntentNotice(deviceId, input) {
      return cloud.enqueueAgentMemoryIntentNotice(tenant, deviceId, input);
    },

    readAgentHomeProjection,
    async awaitAgentHomeProjection(deviceId, agentRef, requestId, options = {}) {
      const exactAgent = AgentRefSchema.parse(agentRef);
      const key = agentHomeProjectionRequestKey(deviceId, exactAgent, requestId);
      return projectionWaiters.wait(key, () => readAgentHomeProjection(deviceId, exactAgent, requestId), options.signal);
    },

    executions: {
      async submit(input) {
        refuseSealedFields((input as { payload?: unknown } | undefined)?.payload);
        const submission = AgentExecutionInputSchema.parse(input);
        refuseReaderMemoryWrite(submission.payload.agentMemory, submission.payload.homeAccess);
        const { taskId } = submission;
        if (dispatching.has(taskId)) throw new Error('submission for this taskId is already in progress; retain the original binding');
        dispatching.add(taskId);
        try {
          relay.provision(taskId);
          const enqueued = await cloud.submitAgentExecution(tenant, submission);
          relay.noteDispatched(taskId, enqueued.envelope.ts);
          return enqueued;
        } catch (error) {
          relay.abort(taskId);
          throw error;
        } finally {
          dispatching.delete(taskId);
        }
      },
    },

    tasks: {
      attempt(taskId) { return cloud.readTaskAttempt(tenant, taskId); },
      deviceTerminal(taskId) { return cloud.readDeviceTerminal(tenant, taskId); },
      offer(taskId) { return cloud.readTaskOffer(tenant, taskId); },
      async *messageDraft(taskId, deviceId, agentRef, options = {}) {
        const signal = options.signal === undefined ? draftShutdown.signal : AbortSignal.any([options.signal, draftShutdown.signal]);
        let cursor = options.after;
        const observed: { gap?: number; overflow?: number } = {};
        while (!signal.aborted) {
          let wake!: () => void;
          const changed = new Promise<void>(resolve => { wake = resolve; });
          // Subscribe before the read to close the read-to-wait race.
          const unsubscribe = relay.watchAgentMessageDraft(taskId, wake);
          signal.addEventListener('abort', wake, { once: true });
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const reading = cloud.readTaskAgentMessageDraft(tenant, deviceId, taskId, agentRef, cursor);
            draftReads.add(reading);
            const draft = await reading.finally(() => { draftReads.delete(reading); });
            if (draft === undefined || signal.aborted) return;
            if (draft.text !== '') yield { kind: 'append', revision: draft.revision, offset: draft.offset, text: draft.text };
            if (signal.aborted) return;
            cursor = { revision: draft.revision, offset: draft.byteCount };
            if (draft.state === 'ended' || draft.state === 'discarded') {
              yield { kind: draft.state };
              return;
            }
            if ((draft.state === 'overflow' || draft.state === 'gap') && observed[draft.state] !== draft.revision) {
              observed[draft.state] = draft.revision;
              if (draft.state === 'overflow') yield { kind: 'overflow', revision: draft.revision, byteCount: draft.byteCount };
              else yield { kind: 'gap', revision: draft.revision };
            }
            if (signal.aborted) return;
            await Promise.race([changed, new Promise<void>(resolve => { timer = setTimeout(resolve, 250); })]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
            signal.removeEventListener('abort', wake);
            unsubscribe();
          }
        }
      },
      agentMessage(taskId, deviceId, agentRef) { return cloud.readTaskAgentMessage(tenant, deviceId, taskId, agentRef); },
      messageDisposition(taskId, deviceId, payload) {
        return cloud.readAgentMessageDisposition(tenant, deviceId, taskId, payload);
      },
      async cancel(taskId, reason) {
        const attempt = await cloud.cancelTask(tenant, taskId, reason);
        if (attempt.cancellation !== undefined) {
          relay.noteHostTransition(taskId, 'Cancelled', attempt.cancellation.requestedAt);
        }
      },
      approve(taskId, opts) { return approvePendingApproval({ tenant, cloud, relay }, taskId, opts); },
      reject(taskId, reason, opts) { return rejectPendingApproval({ tenant, cloud, relay }, taskId, reason, opts); },
      events(taskId, options) { return readTaskEvents({ relay, readState: readTaskState, readApprovalRequest }, taskId, options); },
      async get(taskId: string): Promise<TaskSnapshot | undefined> {
        const attempt = await cloud.readTaskAttempt(tenant, taskId);
        return attempt === undefined ? undefined : projectTask(attempt);
      },
      async list(query: TaskListQuery = {}): Promise<TaskPage> {
        const page = await cloud.listTaskAttempts(tenant, {
          limit: query.limit ?? DEFAULT_TASK_PAGE_LIMIT,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        });
        return {
          tasks: await Promise.all(page.attempts.map((attempt) => projectTask(attempt))),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        };
      },
    },

    blobs: {
      getDownloadUrl(blobId: string): Promise<string | undefined> {
        return composition.cloud.blobs.getDownloadUrl(tenant, blobId);
      },
    },

    egress: {
      async get(deviceId: string, agentRef: AgentRef, eventId: string): Promise<AgentEgressReceipt | undefined> {
        const record = await cloud.readAgentEgress(tenant, deviceId, agentRef, eventId);
        return record === undefined
          ? undefined
          : {
              deviceId: record.deviceId,
              payload: record.payload,
              receiptId: record.receiptId,
              recordedAt: record.recordedAt,
            };
      },
    },

    machines: {
      async list(): Promise<MachineInfo[]> {
        const [devices, readiness] = await Promise.all([cloud.listDevices(tenant), cloud.readTenantReadiness(tenant)]);
        const harnesses = new Map(devices.map((device) => [device.deviceId, device.harnesses]));
        return readiness.devices.map((device) => toMachineInfo({
          deviceId: device.deviceId, deviceName: device.deviceName, harnesses: harnesses.get(device.deviceId),
        }, device.presence));
      },
    },

    events: {
      subscribe: () => relay.serverEvents(),
    },

    devices: {
      async revoke(deviceId: string): Promise<void> {
        // §6.3: a tenant can only revoke a device it owns. This server owns one
        // tenant and supplies it here, so a device id belonging to nobody
        // addresses nothing and touches nothing.
        await cloud.revokeDevice(tenant, deviceId);
      },
    },

    maintenance: { runNow: () => scheduler.runNow() },
    close,

    async stats(): Promise<HubStats> {
      // Aggregate settled rows FIRST. A kernel-settled row cannot subsequently
      // appear in the active walk; reversing these reads can count it twice.
      const aggregate = await cloud.countTaskAttempts(tenant);
      const active: TaskAttempt[] = [];
      let cursor: string | undefined;
      do {
        const page = await cloud.listTaskAttempts(tenant, {
          limit: 100,
          active: true,
          ...(cursor === undefined ? {} : { cursor }),
        });
        active.push(...page.attempts);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      const pending = await Promise.all(active.map((attempt) => readPending(attempt.taskId)));
      const taskCountsByState = Object.fromEntries(TASK_STATES.map((state) => [state, 0])) as Record<TaskState, number>;
      for (const status of TASK_ATTEMPT_STATUSES) {
        if (!TASK_ATTEMPT_ACTIVE_STATUSES.some((activeStatus) => activeStatus === status)) {
          taskCountsByState[taskStateOf(status, false, false)] += aggregate.byStatus[status];
        }
      }
      taskCountsByState[taskStateOf('cancel_requested', true, false)] += aggregate.cancellationRequested;
      active.forEach((attempt, index) => {
        taskCountsByState[taskStateOf(attempt.status, attempt.cancellation !== undefined, pending[index] !== undefined)] += 1;
      });

      return {
        connectedDeviceCount: (await cloud.readTenantReadiness(tenant)).observedPresenceCount,
        taskCountsByState,
        envelopesIn: composition.counters.envelopesIn,
        dedupDrops: composition.counters.dedupDrops,
        rateLimitEvents: composition.counters.rateLimitEvents,
        inboundRefusals: { ...inboundRefusals },
        uptimeMs: Date.now() - startedAtMs,
      };
    },
  };
}
