// ==== @byok-sdk/server dist/connections.d.ts ====
import type { RuntimeInfo, ToolsetId } from '@byok-sdk/protocol';
/**
 * What this process has OBSERVED about a device's live connection.
 *
 * This is not a second authority over anything durable. The device row
 * (`DeviceRecord`, `@byok-sdk/cloud`) owns identity and the capability list
 * every admission gate reads; the mailbox owns delivery. What lives here is the
 * part of `conn.hello` the kernel deliberately does not persist — the runtime
 * DISCOVERY block and the client's self-reported version/toolset inventory —
 * plus "when did we last hear from this device at all".
 *
 * Why the kernel does not persist it: `conn.hello.runtimes` describes what a
 * device build could run, changes on every daemon restart, and authorizes
 * nothing (the steer gate reads the CLAIM snapshot, never this). Storing it
 * durably would create a stale second description of a device that outlives the
 * process that saw it. Keeping it as an in-process observation is honest about
 * its lifetime: restart the server and it is gone, exactly like the connection
 * it describes.
 *
 * `connected` is therefore "observed alive and not since forgotten", not "a
 * socket is open" — there are no sockets any more. Two observations set it: the
 * device's own `conn.hello` over `POST /byok/messages`, and a `GET /byok/events`
 * poll (a device that is polling is present even if it never announced). One
 * clears it: revocation, which deletes the device row and everything scoped to
 * it.
 */
export interface DeviceConnection {
    connected: boolean;
    /** ISO-8601 instant of the most recent observation. */
    lastSeen: string;
    clientVersion?: string;
    runtimes?: RuntimeInfo[];
    configuredToolsets?: ToolsetId[];
}
/** `conn.hello`'s discovery half, as observed on one accepted announcement. */
export interface DeviceAnnouncement {
    readonly clientVersion?: string;
    readonly runtimes?: readonly RuntimeInfo[];
    readonly configuredToolsets?: readonly ToolsetId[];
}
/**
 * In-process device observations, in first-observation order.
 *
 * Insertion order is load-bearing for ambient dispatch selection
 * (`device-selection.ts`): "the first connected device" must be stable and
 * explainable, and a `Map` gives that for free without a second index.
 */
export declare class DeviceConnections {
    #private;
    /**
     * Record an accepted `conn.hello`. Discovery fields are REPLACED wholesale,
     * never merged: a daemon that restarted with a runtime removed must not keep
     * advertising it because an older hello mentioned it.
     */
    announce(deviceId: string, announcement: DeviceAnnouncement, at: string): void;
    /**
     * Record any other sign of life (an inbound envelope, a long-poll read).
     * Deliberately additive: it refreshes `lastSeen` and marks the device present
     * without touching the discovery block, because none of those signals carry
     * one and clearing it would lose what the last hello said.
     */
    touch(deviceId: string, at: string): void;
    get(deviceId: string): DeviceConnection | undefined;
    isConnected(deviceId: string): boolean;
    connectedCount(): number;
    /** Device ids in first-observation order — the order ambient selection walks. */
    ids(): readonly string[];
    /** Drop everything scoped to a device. Called when its registration is deleted (§6.3). */
    forget(deviceId: string): void;
    clear(): void;
}
// ==== @byok-sdk/server dist/index.d.ts ====
import { Hono } from 'hono';
import { type PairingCodeInfo } from '@byok-sdk/cloud';
import type { MailboxRetentionInput, MailboxRetentionResult } from '@byok-sdk/core';
import type { ByokServerEvent, AgentContentReadRequest, AgentHomeProjectionRequest, AgentHomeProjectionStatusReadback, AgentEgressReceipt, CreateByokServerOptions, DispatchInput, FreshAgentEgressDispatchInput, HubStats, MachineInfo, TaskHandle, TaskSnapshot } from './types';
export type { ByokServerEvent, AgentContentReadRequest, AgentHomeProjectionRequest, AgentHomeProjectionStatusReadback, AgentEgressReceipt, CreateByokServerOptions, DispatchInput, FreshAgentEgressDispatchInput, HubStats, MachineInfo, ServerTaskEvent, TaskHandle, TaskResult, TaskSnapshot, } from './types';
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
/** Cutoffs and result of {@link ByokServer.mailbox.collectRetired}, owned by `@byok-sdk/core`. */
export type { MailboxRetentionInput, MailboxRetentionResult } from '@byok-sdk/core';
export { SqliteUnavailableError } from './sqlite-support';
export type { RateLimiterOptions } from './rate-limiter';
export { DEFAULT_TASK_EVENT_BUFFER_LIMIT, DEFAULT_TASK_EVENT_RETENTION_MS } from './relay';
/** Page size `tasks.list()` uses when the caller names none. */
export declare const DEFAULT_TASK_PAGE_LIMIT = 100;
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
    /** Hono app exposing every device route, plus the opt-in `/healthz`. Mount it, or use its `.fetch` with `@hono/node-server`. */
    hono: Hono;
    pairing: {
        /** Mint a single-use pairing code for this server's product and tenant (docs/protocol.md §6.1). */
        createPairingCode(input: CreatePairingCodeInput): Promise<PairingCodeInfo>;
    };
    dispatch(input: DispatchInput): Promise<TaskHandle>;
    /** Dispatch a fresh Agent execution whose runtime will mint its session after start. */
    dispatchFreshAgentEgress(input: FreshAgentEgressDispatchInput): Promise<TaskHandle>;
    /** Enqueue one capability-gated, exact-identity content-read request. */
    requestAgentContentRead(input: AgentContentReadRequest): Promise<void>;
    /** Enqueue one task-free, exact-device Agent-home projection. */
    enqueueAgentHomeProjection(input: AgentHomeProjectionRequest): Promise<AgentHomeProjectionStatusReadback>;
    /** Durable desired-state and terminal-outcome readback for one projection request. */
    readAgentHomeProjection(deviceId: string, requestId: string): Promise<AgentHomeProjectionStatusReadback | undefined>;
    tasks: {
        get(taskId: string): Promise<TaskSnapshot | undefined>;
        /**
         * One bounded page, keyset-paged by task id. Paged rather than "all of
         * them" because the underlying store is: an unbounded `list()` would have
         * to walk every page internally and hand back a snapshot that was never
         * consistent at any single instant.
         */
        list(query?: TaskListQuery): Promise<TaskPage>;
    };
    /** Reliable Agent egress receipt readback. */
    egress: {
        get(deviceId: string, eventId: string): Promise<AgentEgressReceipt | undefined>;
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
    /**
     * Mailbox retention for this server's tenant — the host control-plane
     * operation core defines (`MailboxStore.collectRetired`), forwarded verbatim.
     *
     * A pass-through, deliberately, and NOT a retention policy: the caller names
     * both cutoffs, so this package invents no TTL, runs no timer, and holds no
     * second opinion about when a device's undelivered work is declared lost.
     * Nothing in `@byok-sdk/core`, `@byok-sdk/cloud` or this façade drives the
     * sweep on its own, which is exactly why an embedder needs a way to reach it:
     * without one, an embedded server retires nothing, ever, and the
     * `cursor_too_old` floor can never move.
     *
     * Acked rows appended before `ackedBefore` are DELETED; unacked rows appended
     * before `expireUnackedBefore` are dead-lettered as `expired` and stay
     * visible, which is what moves `recoverableFrom` and turns a device polling
     * from a lost cursor into a `409 cursor_too_old` resync instead of a silently
     * short page. Both cutoffs must be canonical ISO-8601 UTC.
     */
    mailbox: {
        collectRetired(input: MailboxRetentionInput): Promise<MailboxRetentionResult>;
    };
    /**
     * Release what this instance holds: the relay's per-task feeds and their
     * reclamation timers, and the connection observations. Call it on shutdown so
     * nothing keeps the process alive or leaks a handle in tests; safe to call
     * more than once.
     */
    stop(): void;
    /**
     * A plain, serializable snapshot of this server's current state. See
     * {@link HubStats} for the field-by-field contract.
     *
     * Async because `taskCountsByState` is COMPUTED from the durable task store
     * on every call rather than mirrored into a counter this package would then
     * have to keep in agreement with it — that mirror was the second task
     * authority the fold exists to remove. Deliberately in-process only: never
     * exposed over HTTP by this SDK itself (see
     * `CreateByokServerOptions.healthzRoute`); an embedder that wants any of it
     * surfaced remotely builds its own authenticated route around this method.
     */
    stats(): Promise<HubStats>;
}
/**
 * Embedded reference coordinator: a thin façade over `@byok-sdk/cloud`'s
 * kernel, composed against in-memory stores.
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
 * State is in-memory and dies with the process. A deployment that needs it to
 * survive a restart composes `createByokCloud` with durable stores directly.
 */
export declare function createByokServer(opts: CreateByokServerOptions): ByokServer;
// ==== @byok-sdk/server dist/rate-limiter.d.ts ====
/**
 * M4 Phase 4 (part A): per-key token bucket, used by `ConnectionHub`
 * (`hub.ts`) to rate-limit inbound daemon->server envelopes per device.
 * Framework-agnostic on purpose (no hub/transport types here) so it stays
 * unit-testable in isolation, mirroring `event-queue.ts`'s own
 * transport-agnostic split.
 *
 * Token bucket, not a fixed window: `burst` tokens are available immediately
 * (accommodating a legitimate short spike — e.g. a reconnect's redelivery
 * catch-up), refilling continuously at `messagesPerSecond` tokens/sec up to
 * that same `burst` ceiling. A bucket is created lazily per key on first use
 * and persists for as long as it stays active — deliberately NOT reset when
 * a device disconnects/reconnects (see `ConnectionHub`'s own use of this
 * class): resetting on reconnect would let a device that just got
 * disconnected for exceeding its budget immediately burst again on
 * reconnect, defeating the limit entirely. It IS dropped once idle long
 * enough that keeping it around would be pointless — see
 * `evictIdleBucketsIfDue`.
 *
 * Construction validates `messagesPerSecond`/`burst` fail-fast (throws
 * `TypeError` on anything non-finite or <= 0) rather than silently building
 * a limiter that either divides into `NaN` token math or (an `Infinity`
 * burst/rate) never actually limits anything.
 *
 * Finding R5 (cross-model re-review — F10 residual): `burst` specifically
 * must be `>= 1`, not merely `> 0`. A `0 < burst < 1` value used to pass
 * the old `<= 0` check cleanly, but `consume()`'s own debit logic
 * (`if (bucket.tokens < 1) return false;`) can NEVER succeed once the
 * bucket's own CEILING (`burst`) is itself below 1 — `Math.min(this.burst,
 * ...)` caps refill there, so `tokens` can never reach 1 no matter how
 * long the bucket sits idle. The old validation let this construct
 * silently — a limiter that rejects every single message, forever, for
 * every key, is not a rate LIMIT, it's a permanent, total block; that
 * should be a construction-time error, not a runtime surprise discovered
 * once real traffic starts getting rejected.
 */
export interface RateLimiterOptions {
    /** Sustained refill rate, tokens (i.e. messages) per second. Must be a finite number > 0. Default 50. */
    messagesPerSecond?: number;
    /** Bucket capacity — how many messages may arrive back-to-back before the limit engages. Must be a finite number >= 1 (finding R5 — see the module doc comment for why `< 1` can never let a single message through, ever). Default 100. */
    burst?: number;
    /** Hard cap on how many distinct keys (finding R5) this limiter tracks at once — see {@link DEFAULT_MAX_TRACKED_DEVICES}'s own doc comment. Must be a finite number >= 1. Default 10,000. */
    maxTrackedDevices?: number;
}
export declare class RateLimiter {
    private readonly messagesPerSecond;
    private readonly burst;
    private readonly buckets;
    /**
     * Wall-clock idle duration (ms) after which a bucket is GUARANTEED to
     * already be refilled to `burst`, regardless of its actual token count at
     * last touch — i.e. the time to go from 0 tokens to `burst` at this
     * instance's configured rate. `evictIdleBucketsIfDue` uses this as the
     * eviction threshold: dropping an entry idle at least this long and
     * recreating it fresh (tokens = burst) on the next `consume()` is
     * therefore behaviorally IDENTICAL to refilling it in place would have
     * been — both cap at `burst` — so eviction is semantically invisible to
     * the caller.
     */
    private readonly idleEvictionThresholdMs;
    /** Finding R5: hard cap on `buckets.size` — see {@link DEFAULT_MAX_TRACKED_DEVICES}'s own doc comment. */
    private readonly maxTrackedDevices;
    /** Calls to `consume()` since the last sweep — see `EVICTION_SWEEP_EVERY_N_CALLS`. */
    private callsSinceSweep;
    constructor(opts?: RateLimiterOptions);
    /**
     * Debit one token from `key`'s bucket, refilling first for however much
     * wall-clock time has elapsed since its last refill. Returns `false`
     * (and debits nothing) when the bucket is currently empty — the caller is
     * over budget right now.
     */
    consume(key: string): boolean;
    /**
     * Every `EVICTION_SWEEP_EVERY_N_CALLS` calls to `consume()`, drops every
     * bucket idle for at least `idleEvictionThresholdMs` (see that field's doc
     * comment for why this is safe). Without this, `buckets` would hold one
     * permanent entry per historical key forever — every device that ever
     * connected, even long after it disconnected for good — growing without
     * bound over a long-lived server's lifetime.
     */
    private evictIdleBucketsIfDue;
    /**
     * Finding R5 (cross-model re-review — F10 residual): called right before
     * inserting a bucket for a genuinely NEW key, evicting the single
     * LEAST-RECENTLY-refilled entry if `buckets` is already at
     * `maxTrackedDevices` — an O(n) scan, but one that only ever runs once
     * the map is already at its hard ceiling (a rare/bounded event under
     * ordinary operation, not a per-call cost), mirroring this codebase's own
     * established "acceptable O(n) for a rare/bounded case" precedent (e.g.
     * `audit-log.ts`'s `compactPreservingLiveTasks` during rotation).
     *
     * Equivalence split (stated explicitly, not left implied):
     * - For any evicted bucket that was ALREADY idle for at least
     *   `idleEvictionThresholdMs` (i.e. `evictIdleBucketsIfDue` would have
     *   reclaimed it anyway, just not yet — sweeps only run every
     *   `EVICTION_SWEEP_EVERY_N_CALLS` calls, not continuously), eviction is
     *   PROVABLY equivalent to an in-place refill: both cap at `burst`, so a
     *   caller can never observe the difference (see `idleEvictionThresholdMs`'s
     *   own doc comment for the identical reasoning `evictIdleBucketsIfDue`
     *   already relies on).
     * - For a bucket evicted EARLY — still within its idle threshold, forced
     *   out only because `buckets` is at capacity (many thousands of
     *   genuinely-distinct, actively-used keys, not a quiet one) — this is
     *   BEST-EFFORT, not equivalence-preserving: whatever partial token debt
     *   that key had is discarded, and its very next `consume()` call starts
     *   completely fresh (`tokens: this.burst`), a strictly MORE permissive
     *   outcome than if it had kept its place. This is an accepted,
     *   deliberately bounded trade-off — it only ever engages under
     *   cardinality far beyond any plausible real deployment — favoring
     *   bounded memory over perfect per-key continuity in that one extreme
     *   case.
     */
    private evictOldestIfAtCapacity;
}
/**
 * The counting `InboundRateLimiter` (`@byok-sdk/cloud`'s store port) this
 * package composes the kernel with.
 *
 * Position matters and is not this adapter's choice: the kernel debits one
 * token at step 0 of its inbound gate, BEFORE the type-allow check, for every
 * envelope that reaches it. That is exactly the choke point the old
 * `ConnectionHub.handleInbound` occupied, which is why both `envelopesIn` (one
 * per envelope, every outcome) and `rateLimitEvents` (one per REJECTED
 * envelope, never coalesced) are counted here and nowhere else.
 *
 * The `device.rate_limited` embedder event is the one thing that IS coalesced,
 * matching the pre-fold rule: an episode fires exactly one event, and only a
 * subsequent SUCCESSFUL consume by that device re-arms it. So a flood produces
 * one event and N counter increments, and a device that recovers and floods
 * again produces a second, distinct event.
 */
export interface InboundRateLimiterCounters {
    /** Every envelope handed to the kernel's inbound gate, whatever the gate then decides. */
    envelopesIn: number;
    /** Envelopes the bucket refused. Per envelope — see the episode rule above. */
    rateLimitEvents: number;
}
export interface CountingInboundRateLimiter {
    /** The port `CloudStores.rateLimiter` is composed with. */
    readonly limiter: {
        consume(tenant: string, deviceId: string): Promise<boolean>;
    };
    readonly counters: InboundRateLimiterCounters;
}
/**
 * Adapt a {@link RateLimiter} to the kernel's `(tenant, deviceId)` port.
 *
 * The bucket key is `${tenant}:${deviceId}` rather than the bare device id: a
 * device id is only unique within its tenant, and a shared key space would let
 * one tenant's flood spend another's budget for a colliding id.
 */
export declare function createCountingInboundRateLimiter(limiter: RateLimiter, onRateLimited: (deviceId: string, at: string) => void): CountingInboundRateLimiter;
// ==== @byok-sdk/server dist/relay.d.ts ====
import type { InboundCommitted, ByokCloudObserver } from '@byok-sdk/cloud';
import type { TaskState } from '@byok-sdk/protocol';
import type { DeviceConnections } from './connections';
import type { ByokServerEvent, ServerTaskEvent } from './types';
/** Per-task {@link ServerTaskEvent} retention before drop-oldest engages. */
export declare const DEFAULT_TASK_EVENT_BUFFER_LIMIT = 1000;
/** How long a terminal task's relay state is retained before reclamation, ms. */
export declare const DEFAULT_TASK_EVENT_RETENTION_MS: number;
export interface TaskEventRelayOptions {
    readonly connections: DeviceConnections;
    readonly taskEventBufferLimit?: number;
    readonly taskEventRetentionMs?: number;
}
/**
 * Post-commit fan-out: cloud kernel envelopes -> `ServerTaskEvent` /
 * `ByokServerEvent`.
 *
 * The invariant this file exists to keep (WP3B §3): **the relay holds
 * notifications, never state**. It never answers "what is this task", "what did
 * it produce" or "who owns it" — every one of those is read back from the
 * kernel's durable stores on demand. What it owns is per-task delivery
 * plumbing: a bounded replayable queue, and one promise that settles when the
 * task reaches a terminal so `TaskHandle.result()` has something to await
 * before it reads the answer back.
 *
 * The two small facts it does carry are delivery bookkeeping, not a read model:
 * `terminalSettled` (so the FIRST terminal is the one that settles the promise,
 * matching the store's own first-terminal-wins rule, and a later stale terminal
 * is not announced as a second one) and `claimedRuntime` (echoed onto the
 * `task.state` event stream because the pre-fold feed carried it there; the
 * authoritative copy is `TaskAttempt.claimedRuntime`).
 *
 * It is told about a task only by {@link noteDispatched}. An envelope naming a
 * task this server never dispatched is folded for nobody and allocates nothing —
 * otherwise a device could grow this map without bound by guessing task ids,
 * and the kernel's gate deliberately treats such an envelope as a harmless
 * store no-op rather than a rejection.
 *
 * `onInboundCommitted` runs inline on the kernel's request path and must stay
 * synchronous and cheap; anything needing a store read goes through
 * {@link onTaskActivity}, which the composition sets and which owns its own
 * failure handling.
 */
export declare class TaskEventRelay implements ByokCloudObserver {
    #private;
    /**
     * Called once per committed task-progress observation for a dispatched task.
     * The composition uses it to run the implicit-approval-resume check, which
     * needs a store read and therefore cannot happen inline here.
     */
    onTaskActivity: ((taskId: string) => void) | undefined;
    constructor(options: TaskEventRelayOptions);
    /** The cross-task embedder feed backing `ByokServer.events.subscribe()`. */
    serverEvents(): AsyncIterable<ByokServerEvent>;
    /** Publish one cross-task event (rate-limit episodes, host-side transitions). */
    emitServerEvent(event: ByokServerEvent): void;
    /**
     * Open the relay for a task this server just dispatched, and publish its
     * `Offered` origin on both feeds. `at` is the offer envelope's own timestamp,
     * so the feed and the snapshot agree on when the task began.
     */
    noteDispatched(taskId: string, at: string): void;
    /** The per-task feed backing `TaskHandle.events()`, replayed from the start of what is retained. */
    events(taskId: string): AsyncIterable<ServerTaskEvent>;
    /** Settles when this task first reaches a terminal — the barrier `TaskHandle.result()` awaits. */
    terminal(taskId: string): Promise<void>;
    /**
     * Host-side transitions the wire never carries: an accepted cancellation, and
     * an approval the operator resolved through `TaskHandle.approve`/`reject`.
     * Published here so the two feeds report the same task history whichever side
     * moved it, and (for a terminal) so `result()` is not left waiting on a device
     * message that a cancelled task will never send.
     */
    noteHostTransition(taskId: string, state: TaskState, at: string): void;
    onInboundCommitted(input: InboundCommitted): void;
    /** Publish an implicit resolution the composition inferred from later task traffic. */
    emitImplicitApprovalResolved(taskId: string, at: string): void;
    /** Close every feed and drop every timer. Safe to call more than once. */
    stop(): void;
}
// ==== @byok-sdk/server dist/sqlite-support.d.ts ====
import type { DatabaseSync, DatabaseSyncOptions } from 'node:sqlite';
export type SqliteOpenStep = 'after-open' | 'after-wal';
/** Test-only seam for proving that post-open initialization failures release the native handle. */
export interface SqliteOpenFaultSeam {
    onStep?(step: SqliteOpenStep): void;
    close?(db: DatabaseSync): void;
}
/**
 * Preserve the initialization error after deterministically releasing an
 * already-open SQLite handle. If cleanup itself fails, surface both failures
 * instead of losing the reason construction failed or pretending ownership
 * was returned.
 */
export declare function closeSqliteDatabaseAfterInitializationFailure(db: DatabaseSync, initializationError: unknown, message: string, close?: (db: DatabaseSync) => void): never;
/**
 * Thrown when `node:sqlite` isn't available in the running Node.js binary.
 * `node:sqlite` shipped in Node.js 22.5.0 (https://nodejs.org/api/sqlite.html)
 * and remains marked experimental there (an `ExperimentalWarning` on stderr
 * is expected and harmless — not an error). The SQLite-backed reference
 * stores in this package (`SqliteTaskStore`, `SqliteBlobStore`) deliberately
 * depend on nothing else — no `better-sqlite3` or other native module —
 * because staying at zero native dependencies is required to keep
 * `@byok-sdk/server` trivially packageable across platforms. The tradeoff is
 * that these stores simply don't work below Node 22.5; this error says so
 * clearly and up front, instead of letting a cryptic `Cannot find module
 * 'node:sqlite'` surface from deep inside a query.
 */
export declare class SqliteUnavailableError extends Error {
    constructor(cause: unknown);
}
/**
 * Whether `nodeVersion` (a `major.minor.patch` string shaped like
 * `process.versions.node`) is new enough to have `node:sqlite` at all.
 * Exported only for this package's own tests to exercise the guard
 * deterministically (this dev/CI machine is already on a qualifying Node,
 * so the real "unavailable" path can't be triggered end-to-end here) — not
 * re-exported from `index.ts`, so not part of the public package API.
 * Unparsable input returns `true` (don't false-negative on a version string
 * shape this hasn't seen before): `loadSqliteModule`'s own `require` call is
 * the real, authoritative gate; this check only exists to turn the common
 * case (a too-old Node) into a clear message instead of a cryptic one.
 *
 * Not a sufficient capability check on its own: `node:sqlite` shipped in
 * Node 22.5.0 behind the `--experimental-sqlite` flag and only became usable
 * unflagged in a later 22.x release (https://nodejs.org/api/sqlite.html), so
 * a runtime that satisfies this version check can still fail to actually
 * load the module. Use {@link isSqliteAvailable} when the question is "can I
 * use `node:sqlite` right now", not "is the Node version new enough for it
 * to exist at all".
 */
export declare function isSqliteCapableNodeVersion(nodeVersion: string): boolean;
/**
 * Whether `node:sqlite` can ACTUALLY be loaded right now — the authoritative
 * capability check, in contrast to {@link isSqliteCapableNodeVersion}'s
 * version-string heuristic. This is what this package's own test suite uses
 * to decide whether to skip the SQLite-backed reference-store tests (rather
 * than fail them), and what anything else should call before assuming a
 * `SqliteTaskStore`/`SqliteBlobStore` can be constructed: it attempts the
 * real `require('node:sqlite')` (via {@link loadSqliteModule}, memoized) and
 * reports whether that succeeded, so it agrees with reality regardless of
 * whether the current runtime is old, too-new-but-flagged, or fully capable.
 */
export declare function isSqliteAvailable(): boolean;
/**
 * Open (or create) a `node:sqlite` `DatabaseSync` at `path`, applying the
 * pragmas both reference SQLite stores share: WAL journaling for a
 * file-backed database (allows a reader and a writer to proceed without
 * blocking each other, and is what makes "close instance A, open instance B
 * on the same file" — the restart-safety story — reliable) and a busy
 * timeout (see {@link DEFAULT_BUSY_TIMEOUT_MS}). WAL is skipped for
 * `:memory:`, where it's meaningless. For a file-backed path whose parent
 * directory doesn't exist yet, creates it (recursively) at
 * {@link SECURE_DIR_MODE} — mirroring the client-side device store's
 * convention of never leaving a credential directory at a permissive
 * default mode. Throws {@link SqliteUnavailableError} if `node:sqlite`
 * itself can't be loaded (Node <22.5, or a flagged intermediate 22.x — see
 * {@link isSqliteAvailable}) — callers don't need their own guard for that;
 * this is the single choke point.
 */
export declare function openSqliteDatabase(path: string, options?: DatabaseSyncOptions, faults?: SqliteOpenFaultSeam): DatabaseSync;
/**
 * Restrict `dbPath` and its WAL/SHM sibling files (`<path>-wal`,
 * `<path>-shm` — created by SQLite itself once WAL mode is active and a
 * write has happened) to owner-only read/write ({@link SECURE_FILE_MODE}).
 * Both SQLite reference stores hold sensitive bytes on disk with no other
 * access-control layer of their own — `SqliteBlobStore` an HMAC signing
 * secret plus arbitrary uploaded blob content, `SqliteTaskStore` task
 * instructions and device/session refs — so a real (non-`:memory:`)
 * database file must not be left at whatever permissive mode the process'
 * umask would otherwise give it.
 *
 * Call this AFTER the schema has been created against `dbPath` (so the
 * WAL/SHM files, which SQLite creates lazily on first write, already exist)
 * — a sibling file that doesn't exist yet is silently skipped rather than
 * treated as an error. No-op for `:memory:`.
 */
export declare function secureSqliteFilePermissions(dbPath: string): void;
// ==== @byok-sdk/server dist/task-handle.d.ts ====
import { type ByokCloud, type SteerRejectionCode, type TenantId } from '@byok-sdk/cloud';
import type { RuntimeId, TaskState } from '@byok-sdk/protocol';
import type { TaskEventRelay } from './relay';
import type { TaskHandle, TaskResult } from './types';
/**
 * Thrown by {@link TaskHandle.steer} when the kernel refuses the steer.
 *
 * This package keeps its OWN class rather than re-exporting the kernel's, and
 * that is deliberate rather than a leftover. The two carry the same `taskId`,
 * `code` and `runtime`, and differ in exactly one field: the kernel reports
 * `status: TaskAttemptStatus` — its coarse, execution-free attempt disposition
 * (`running`, `offered`, …) — while this surface reports `state: TaskState`,
 * the WIRE vocabulary every other member of this package speaks
 * (`TaskSnapshot.state`, `ServerTaskEvent`, `HubStats.taskCountsByState`).
 * `AwaitApproval` is the reason they cannot be the same field: it is derived
 * from the durable approval timeline and has no attempt status at all
 * (ADR-028), so a `TaskAttemptStatus -> TaskState` mapping inside the kernel
 * would have to report `Running` for a task this façade calls `AwaitApproval`.
 *
 * So the state here is not translated from the kernel's field — it is READ,
 * through the very projection `byok.tasks.get(taskId)` answers with, at the
 * moment of the refusal. One authority, two readers, no second mapping.
 *
 * Deviation from design packet §1.2, which had this class move to
 * `@byok-sdk/cloud` with the server re-exporting it: the wire `TaskState`
 * vocabulary is host-facing and lives here, so the class that carries it does
 * too. `SteerRejectionCode` and `StaleApprovalError` are unaffected and stay
 * kernel re-exports.
 */
export declare class SteerRejectedError extends Error {
    readonly taskId: string;
    readonly code: SteerRejectionCode;
    /** The task's state at the moment the steer was refused. */
    readonly state: TaskState;
    /** `TaskSnapshot.claimedRuntime` — `undefined` when nothing was ever recorded, which is itself a reason `steer_unsupported_runtime` can fire. */
    readonly runtime: RuntimeId | undefined;
    constructor(taskId: string, code: SteerRejectionCode, state: TaskState, runtime: RuntimeId | undefined);
}
export interface TaskHandleDeps {
    readonly tenant: TenantId;
    readonly cloud: ByokCloud;
    readonly relay: TaskEventRelay;
    /**
     * The task's current `TaskSnapshot.state`, or `undefined` when the attempt is
     * gone. The snapshot projection itself — never a second derivation.
     */
    readonly readState: (taskId: string) => Promise<TaskState | undefined>;
    /**
     * Record a host-side approval decision on the task's durable approval
     * timeline — the same authority the kernel's own staleness gate reads. See
     * `index.ts` for why the façade writes it rather than keeping a private
     * "already resolved" set beside it.
     */
    readonly recordHostApproval: (taskId: string, decision: 'approve' | 'reject', approvalId: string | undefined, sourceEnvelopeId: string) => Promise<void>;
    /** The read-back this handle's `result()` answers with. */
    readonly readResult: (taskId: string) => Promise<TaskResult | undefined>;
}
/**
 * One in-flight task's control surface.
 *
 * The §3 invariant it exists to keep: **the handle is not a second authority.**
 * Every mutation is a kernel call, and `result()` is a READ-BACK — it waits for
 * the relay's terminal barrier and then asks the store what the terminal was,
 * so `handle.result()` and `byok.tasks.get(taskId).result` are physically the
 * same fact rather than two copies that can disagree. Nothing about the task is
 * cached here.
 */
export declare function createTaskHandle(taskId: string, deps: TaskHandleDeps): TaskHandle;
// ==== @byok-sdk/server dist/types.d.ts ====
import type { AgentContentReadPayload, AgentHomeProjectionPayload, AgentHomeProjectionReadback, AgentEventOrUnknown, AgentEgressPolicy, AgentEgressReliablePayload, AgentMessageEgressRequirement, AgentMessageServerContext, AgentMessagePublishPayload, AgentRef, BlobRef, DispatchSelection, PermissionPolicy, RuntimeCapabilities, RuntimeId, RuntimeInfo, TaskApprovalResolvedPayload, TaskArtifactPayload, TaskState, ToolsetId, TerminalProjectionSelection } from '@byok-sdk/protocol';
import type { TenantId, TokenSigner } from '@byok-sdk/cloud';
import type { RateLimiterOptions } from './rate-limiter';
/** Options for {@link createByokServer}. */
export interface CreateByokServerOptions {
    /**
     * Identifies which product this server instance serves. Checked against the
     * `productId` a daemon announces in `conn.hello` — one daemon process is
     * always scoped to one product (see plan: "一产品一 daemon 进程"), so a
     * mismatched daemon is rejected at handshake time.
     */
    productId: string;
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
export interface FreshAgentEgressDispatchInput extends Omit<DispatchInput, 'deviceId' | 'sessionRef' | 'agentRef' | 'egressPolicy'> {
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
export type ServerTaskEvent = {
    kind: 'state';
    state: TaskState;
    at: string;
} | {
    kind: 'agent';
    event: AgentEventOrUnknown;
} | {
    kind: 'artifact';
    artifact: TaskArtifactPayload;
} | {
    kind: 'await_approval';
    summary: string;
} | {
    kind: 'error';
    reason: string;
    retryable?: boolean;
};
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
    approve(opts?: {
        approvalId?: string;
    }): Promise<void>;
    /** M5: same `opts.approvalId` targeting semantics as {@link approve} above. */
    reject(reason?: string, opts?: {
        approvalId?: string;
    }): Promise<void>;
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
export type ByokServerEvent = {
    kind: 'task.created';
    taskId: string;
    at: string;
} | {
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
 | {
    kind: 'task.approval_resolved_implicit';
    taskId: string;
    at: string;
}
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
 | {
    kind: 'device.rate_limited';
    deviceId: string;
    at: string;
};
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
