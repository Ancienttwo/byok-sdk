// ==== @byok-sdk/server dist/auth.d.ts ====
/**
 * Auth v2 (docs/protocol.md §6): device identity (Ed25519 keypair, public
 * half registered at pairing time), single-use nonce challenge/response for
 * token renewal, and JWT access tokens. Kept separate from `pairing.ts`
 * (which now only owns the one-time pairing-code lifecycle) because these
 * concerns span every authed surface (WSS upgrade, blob routes, events
 * long-poll), not just `POST /byok/pair`.
 */
/** Access tokens are JWTs with a ~1h lifetime (docs/protocol.md §6.1/§6.2). */
export declare const ACCESS_TOKEN_TTL_SECONDS: number;
/**
 * S1 (GAP-004): the domain-separation prefix a device signs along with a
 * challenge nonce. The device key is a long-lived identity key that later
 * planes (S6 device proof) will also sign structured messages with; without a
 * domain tag, a signature produced for one purpose is a valid signature for
 * another, and an attacker who can get a device to sign anything shaped like
 * a nonce holds a token-renewal credential.
 *
 * The literal lives in `@byok-sdk/core` (`src/pairing.ts`) and the client signs
 * the same binding (`packages/client/src/daemon/device-keys.ts`) — it used to
 * be three copies, each commented as byte-identical to the other two, which is
 * an agreement that holds only until someone edits one. Re-exported here so
 * this module's public surface is unchanged.
 *
 * There is deliberately no dual mode: a raw, unprefixed nonce signature is
 * simply invalid here, with no flag, fallback, or grace window that would
 * make the old encoding acceptable again. Because the four packages have no
 * published compatibility contract yet, the recovery path for a device on
 * the old encoding is a re-pair, not a server-side shim.
 */
export { NONCE_SIGNING_DOMAIN } from '@byok-sdk/core';
/**
 * S1: server-local tenant identifier. A plain string alias for now — S2 moves
 * the branded/shared form into `@byok-sdk/core`, which does not exist yet, and
 * depending on an unbuilt package would be worse than naming the concept
 * here. What matters at this stage is that every identity-carrying shape in
 * this package names the tenant explicitly and required, never optional.
 */
export type TenantId = string;
/**
 * S1: an access token binds a device to the tenant AND product its row was
 * paired into. All three are required — there is no tenant-less token shape.
 * These are LOOKUP KEYS, not authority: `authenticateBearer` resolves them
 * against the device registry and answers with the ROW's identity (see
 * {@link AuthenticatedDevice}).
 */
export interface AccessTokenClaims {
    deviceId: string;
    tenantId: TenantId;
    productId: string;
}
export interface TokenSigner {
    sign(claims: AccessTokenClaims, expiresInSeconds: number): Promise<string>;
    /** Returns the claims for a valid, unexpired token, or `undefined` if invalid/expired/malformed. */
    verify(token: string): Promise<AccessTokenClaims | undefined>;
}
/** Default {@link TokenSigner}: HS256 over a random 32-byte secret held in memory for this process's lifetime. */
export declare function createHmacTokenSigner(secret?: Uint8Array): TokenSigner;
/** Mint a fresh access token + its ISO-8601 expiry, per {@link ACCESS_TOKEN_TTL_SECONDS}. */
export declare function mintAccessToken(signer: TokenSigner, claims: AccessTokenClaims): Promise<{
    accessToken: string;
    expiresAt: string;
}>;
export interface DeviceRecord {
    /** S1: the tenant this device was paired into. Comes from the pairing-code claims and is never client-supplied. */
    tenantId: TenantId;
    /** S1: the product this device was paired into — checked against `conn.hello.productId` and against every token's claims. */
    productId: string;
    deviceId: string;
    deviceName: string;
    /** Ed25519 public key, base64url-encoded (JWK `x` form — see {@link verifyEd25519Signature}). */
    devicePublicKey: string;
}
/**
 * Everything `POST /byok/pair` knows at registration time — which is the whole
 * row. Revocation DELETES the registration (§6.3), so there is no lifecycle
 * flag for the registry to own on top of what pairing supplies.
 */
export type DeviceRegistration = DeviceRecord;
export declare class DeviceRegistry {
    /** Keyed by {@link DeviceRegistry.key} — `(tenantId, deviceId)`. */
    private readonly devices;
    /**
     * Secondary index over the SAME record objects, for the two pre-tenant
     * endpoints only (see {@link resolveByDeviceId}). It holds the same record
     * objects rather than copies, and {@link revoke} removes the entry here in
     * the same call that removes the composite-key one — a stale entry left
     * behind would be a deleted device that can still get a token.
     */
    private readonly byDeviceId;
    private static key;
    /**
     * Write a device row. Every identity field is required by
     * {@link DeviceRegistration}, so a row with no tenant cannot be constructed
     * — which is the whole point of S1.
     */
    register(device: DeviceRegistration): void;
    /** The row `tenantId` owns under `deviceId`, or `undefined` — including when the device exists under a DIFFERENT tenant. */
    get(tenantId: TenantId, deviceId: string): DeviceRecord | undefined;
    /**
     * Revoke a device (public API via `createByokServer(...).devices.revoke`).
     * Revocation DELETES the registration (docs/protocol.md §6.3): afterwards
     * the device id is byte-for-byte one that was never registered — absent
     * from {@link list}, resolving to nothing on the pre-tenant
     * `/byok/challenge` and `/byok/token` paths, and a 401 on every authed
     * surface. The daemon's only recourse is to re-run `/byok/pair`.
     *
     * There is deliberately no retained `revoked` row: a flag every read path
     * has to remember to exclude is a second way to represent "not a
     * principal", and the first read path that forgets it is a live credential.
     *
     * A tenant can only revoke its own devices: a (tenantId, deviceId) pair it
     * does not own resolves to nothing, deletes nothing, and is silently
     * indistinguishable from revoking one that never existed.
     *
     * Returns whether a row was actually removed — the composition in
     * `index.ts` uses it to delete the device-scoped state that only existed to
     * serve that row (nonces, presence, dedup), so a no-op revoke touches
     * nothing at all.
     */
    revoke(tenantId: TenantId, deviceId: string): boolean;
    /** Every known device row, across tenants — the in-process read model behind `ByokServer.machines.list()`. */
    list(): DeviceRecord[];
    /**
     * Resolve a device by its globally-unique id alone, WITHOUT a tenant in
     * scope. Exists for exactly two callers — `POST /byok/challenge` and
     * `POST /byok/token` — because those two carry no tenant at all: their
     * request DTOs are the pinned wire contract (docs/protocol.md §6.2), the
     * device authenticates by key possession, and the row itself is what tells
     * the server which tenant to mint the next token for. Everything with a
     * token (and therefore a tenant) in scope goes through {@link get}.
     *
     * Deliberately NOT re-exported from this package's entry point (`index.ts`
     * exports no naked-lookup surface at all), so no embedder can turn it into
     * a cross-tenant device oracle: the only reachable public device surface is
     * tenant-first.
     */
    resolveByDeviceId(deviceId: string): DeviceRecord | undefined;
}
export declare class NonceStore {
    private readonly nonces;
    /** Number of nonce records currently held (post-sweep). Exposed for tests only. */
    get size(): number;
    /**
     * Drop every used or expired record. A long-lived server never calls this
     * on a timer, so `issue()` sweeps inline — a full-Map scan is fine at
     * reference-impl scale (single-digit nonces per device, ~5min TTL).
     */
    private sweep;
    issue(deviceId: string): string;
    /** `true` iff `nonce` exists, belongs to `deviceId`, is unexpired, and hasn't been consumed yet. Does not mutate. */
    validate(deviceId: string, nonce: string): boolean;
    /**
     * Drop every nonce outstanding for `deviceId` — called when the device's
     * registration is deleted (§6.3 revocation). An unspent challenge is state
     * that only existed to serve a row the directory can no longer name, so it
     * goes with the row rather than sitting until its TTL sweeps it.
     */
    deleteForDevice(deviceId: string): void;
    /** Mark `nonce` consumed so a replay of the same (deviceId, nonce, signature) is rejected. */
    markUsed(nonce: string): void;
}
/**
 * The ONLY nonce-signature check on this server (§6.2): the signed message is
 * core's `nonceSigningBytes` — the domain followed by the nonce. Applying the
 * domain here rather than at the call site is the point — there is one place
 * that decides what a device signature over a nonce means, so no route can be
 * written that accepts the undomained form.
 */
export declare function verifyNonceSignature(devicePublicKey: string, nonce: string, signature: string): boolean;
export declare function extractBearerToken(header: string | undefined): string | undefined;
export interface AuthDeps {
    tokenSigner: TokenSigner;
    devices: DeviceRegistry;
    /**
     * The product THIS server instance serves (`createByokServer`'s
     * `productId`). Part of authentication, not of routing: a device row paired
     * into another product is not a principal here at all — see
     * {@link authenticateBearer}.
     */
    productId: string;
}
/**
 * S1: the authenticated principal every authed surface works with. Built from
 * the DEVICE ROW, never from the token payload — the token's claims are only
 * the keys used to find that row (see {@link authenticateBearer}). A caller
 * holding one of these is holding identity the registry vouched for.
 */
export interface AuthenticatedDevice {
    deviceId: string;
    tenantId: TenantId;
    productId: string;
}
/**
 * Resolve an `Authorization: Bearer <jwt>` header to an {@link AuthenticatedDevice},
 * or `undefined` — the single check every authed HTTP route and the WSS
 * upgrade share.
 *
 * S1 shape: the token's `(tenantId, deviceId)` are LOOKUP KEYS into the
 * registry, and the row that comes back is the authority. A token for a
 * device that no longer exists, one whose tenant does not own that device,
 * one whose product disagrees with the row, and one whose row belongs to a
 * different product than this instance serves all fail identically here and
 * are indistinguishable to the caller — a revoked device is exactly the first
 * of those, since revocation deleted its row (§6.3) — there
 * is deliberately no "which of those was it" signal to hand back, so no route
 * can turn a 401 into a cross-tenant (or cross-product) existence oracle.
 *
 * The last two checks are different facts and both are needed. Row vs claims
 * says "the token belongs to this row"; row vs instance says "this row
 * belongs to the product this server serves" — a single server can mint
 * pairing codes for any product (`createPairingCode` takes the claims per
 * code), so a row from another product is a real row holding a real token
 * and is still not a principal here. `conn.hello`'s own product checks
 * (`ws-server.ts`) validate the client's ANNOUNCEMENT, which is a third fact
 * and stays where it is.
 */
export declare function authenticateBearer(header: string | undefined, deps: AuthDeps): Promise<AuthenticatedDevice | undefined>;
// ==== @byok-sdk/server dist/blob-store.d.ts ====
import type { TenantId } from './auth';
/**
 * Blob flows (docs/protocol.md §7): `POST /byok/blobs` declares a blob and
 * gets back a presigned upload URL; the caller `PUT`s the bytes there
 * directly (no bearer auth on that URL — the HMAC signature + expiry *is*
 * the auth); `GET /byok/blobs/:id/url` mints a presigned download URL the
 * same way. `BlobRef` itself (`@byok-sdk/protocol`'s `blob.ts`) is unchanged;
 * this module is what produces the URLs a `BlobRef` points at.
 *
 * `BlobStore` is interface-shaped so a SaaS can swap in a real object-store
 * (S3/GCS/R2 presigned URLs) later; {@link LocalDiskBlobStore} is the M1
 * reference implementation (single-process, persisted metadata + files on
 * disk) — good enough for local dev and the SDK's own tests, including a
 * restart of the same directory; it is not multi-process storage.
 */
export interface CreateUploadInput {
    size: number;
    contentType: string;
    /** Content-addressed hash the server verifies the uploaded bytes against (§7). Reference impl assumes hex-encoded SHA-256. */
    contentHash: string;
}
export type WriteContentResult = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
export interface ReadContentResult {
    data: Buffer;
    contentType: string;
}
/** The upload reservation HTTP must resolve before it starts retaining bytes. */
export interface BlobUploadReservation {
    size: number;
}
export declare class BlobDeclarationConflictError extends Error {
    constructor(blobId: string);
}
export interface BlobStore {
    /** Declare a blob before upload; an explicit id makes the declaration idempotent across host restart. */
    createUpload(tenantId: TenantId, input: CreateUploadInput, blobId?: string): Promise<{
        blobId: string;
        uploadUrl: string;
    }>;
    /** A presigned GET URL for a blob that has finished uploading, or `undefined` if unknown/not yet uploaded. */
    getDownloadUrl(tenantId: TenantId, blobId: string): Promise<string | undefined>;
    /** Whether `blobId` is known *and* has finished uploading. */
    exists(tenantId: TenantId, blobId: string): Promise<boolean>;
    /** Resolve a capability URL's immutable declared size before consuming its body. */
    getUploadReservation(blobId: string): Promise<BlobUploadReservation | undefined>;
    /** Verify a presigned content URL's `sig`/`exp` query params for `action`. */
    verifySignedUrl(blobId: string, action: 'put' | 'get', sig: string, exp: number): boolean;
    /** Accept uploaded bytes; rejects (without storing) on size/hash mismatch against the `createUpload` declaration. */
    writeContent(blobId: string, data: Buffer): Promise<WriteContentResult>;
    /** Read back previously-uploaded bytes, or `undefined` if unknown/not yet uploaded. */
    readContent(blobId: string): Promise<ReadContentResult | undefined>;
}
export interface LocalDiskBlobStoreOptions {
    /** Directory blob content is written under. Defaults to a fresh OS temp dir. */
    directory?: string;
    /** How long a presigned upload/download URL stays valid, ms. Default 15 minutes. */
    urlTtlMs?: number;
}
/** Local-disk reference {@link BlobStore}: persisted metadata/content and HMAC-signed expiring URLs. */
export declare class LocalDiskBlobStore implements BlobStore {
    private secret;
    private readonly directory;
    private readonly metadataPath;
    private readonly urlTtlMs;
    private readonly blobs;
    private readonly ready;
    private metadataWriteTail;
    constructor(opts?: LocalDiskBlobStoreOptions);
    createUpload(tenantId: TenantId, input: CreateUploadInput, requestedBlobId?: string): Promise<{
        blobId: string;
        uploadUrl: string;
    }>;
    getDownloadUrl(tenantId: TenantId, blobId: string): Promise<string | undefined>;
    exists(tenantId: TenantId, blobId: string): Promise<boolean>;
    getUploadReservation(blobId: string): Promise<BlobUploadReservation | undefined>;
    verifySignedUrl(blobId: string, action: 'put' | 'get', sig: string, exp: number): boolean;
    writeContent(blobId: string, data: Buffer): Promise<WriteContentResult>;
    readContent(blobId: string): Promise<ReadContentResult | undefined>;
    private pathFor;
    private loadMetadata;
    private persistMetadata;
    private computeSig;
    private signUrl;
}
// ==== @byok-sdk/server dist/hub.d.ts ====
import type { WebSocket } from 'ws';
import { type Envelope, type AgentMessagePublishPayload, type AgentMessageServerContext, type AgentHomeProjectionCompletionRequest, type AgentHomeProjectionReadback, type RuntimeId, type RuntimeInfo, type TaskState, type ToolsetId } from '@byok-sdk/protocol';
import type { DeviceRegistry } from './auth';
import { RateLimiter } from './rate-limiter';
import type { TaskStore } from './task-store';
import type { ByokServerEvent, AgentContentReadRequest, AgentHomeProjectionRequest, AgentEgressReceipt, DispatchInput, FreshAgentEgressDispatchInput, HubStats, MachineInfo, TaskHandle, TaskSnapshot } from './types';
/**
 * The connection hub: tracks each device's live transport (WS or long-poll —
 * never both at once, see {@link takeOverAsLongPoll}), routes `dispatch()`'d
 * tasks to a device, and processes inbound task.* envelopes from daemons.
 *
 * Routing (M1): every `task.*` envelope carries a *required* envelope
 * `task_id` — the sole routing key, both directions. No payload duplicates
 * it, and none of the handlers below need to guard against a missing one
 * (the wire schema already rejects such an envelope before it reaches here).
 *
 * Inbound gate ({@link handleInbound}): the single choke point both
 * transports (`ws-server.ts`'s WS message handler, `http.ts`'s
 * `POST /byok/messages`) call instead of reaching into per-type handlers
 * directly. Runs, in order: (1) type-allow — only `DAEMON_TO_SERVER_TYPES`
 * plus the authenticated long-poll `conn.hello` snapshot may pass, a server
 * -> daemon type arriving inbound is rejected (P2); (2)
 * ownership (N2) — an envelope for a task already owned by a *different*
 * device is dropped and logged, never force-failed (force-failing on an
 * authz mismatch would let an attacker who merely guesses a `taskId` kill
 * the real owner's task); (3) dedup (N3) — an envelope `id` already seen
 * from this device is a no-op, making the at-least-once wire (§9)
 * effectively at-most-once server-side; (4) dispatch to the per-type
 * handler. Because ownership is enforced once, centrally, here, the
 * handlers below no longer carry their own device-mismatch checks.
 *
 * Outbound delivery (M1, §1.2/§9): every server -> daemon envelope
 * (`conn.ack`, either task offer, `task.approve/reject/cancel/steer`) gets a fresh
 * per-device monotonic `seq` and is retained in a capped ring buffer
 * ({@link OUTBOX_RING_CAPACITY} entries) so it can be redelivered — in `seq`
 * order, skipping anything whose task has since reached a terminal state —
 * on reconnect (`redeliverAfterReconnect`) or long-poll
 * (`pollEvents`/`collectRelevant`). `conn.ack` has no task association, so
 * it's retained (for seq-counting purposes only) but never redelivered.
 * Exception (N1/F4): `task.cancel`/`task.reject` are exempt from the
 * terminal-task skip (`OutboxEntry.redeliverThroughTerminal`) because both
 * move their own task to a terminal state before being queued — without the
 * exemption they could never qualify for redelivery even when the original
 * send never reached the daemon.
 *
 * State-machine (M1): `task.claim` only claims (`Offered -> Claimed`); it no
 * longer implies `Running`. The daemon reports `Claimed -> Running`
 * explicitly via `task.started` once its runtime session actually starts
 * (§3.1). `task.decline` reports a pre-claim fail-closed rejection
 * (`Offered -> Failed`, §3.2). `task.cancelled` is dual-purpose: an
 * idempotent ack when the server already cancelled the task itself, or the
 * authoritative trigger when the daemon observed the cancellation first
 * (§3.3). Per §9, `task.complete`/`task.fail`/`task.cancelled` arriving for
 * an already-terminal task are silently dropped as stale/duplicate — not a
 * warning; this is what naturally resolves the M0 gatekeeper's cancel-race
 * `console.warn` finding (a late `task.fail`/`task.cancelled` racing a
 * server-initiated cancel is exactly this case).
 *
 * Task lease (M2): a periodic sweep (started in the constructor) reaps a
 * `Claimed`/`Running`/`AwaitApproval` task to
 * `Failed(retryable: true, reason: 'lease-expired')` once its owning device
 * has been dark (disconnected, or long-poll-silent) AND the task itself has
 * had no inbound activity for `taskLeaseMs` — see the "task-lease reaper"
 * section further down for the full design, including why this does not
 * reintroduce the disconnect-alone-fails-the-task bug M1 removed above.
 */
/**
 * M4 Phase 3: thrown by {@link ConnectionHub.approveTask}/{@link
 * ConnectionHub.rejectTask} for a `taskId` this hub has no record of at all
 * — mirrors `task-store.ts`'s `IllegalTaskTransitionError` (typed error
 * class + `instanceof` dispatch is this codebase's own established idiom for
 * mapping a domain error to the right status code). Distinguished from
 * {@link TaskNotAwaitingApprovalError} so a caller CAN tell the two failure
 * modes apart (e.g. 404 vs. 409) instead of only ever seeing a single
 * generic `Error`. There is no bearer-authed HTTP route for this on
 * `http.ts`'s own app (see that file's own closing comment for why) — the
 * supported entry point is calling `approveTask`/`rejectTask` directly, or
 * via `TaskHandle.approve()`/`reject()` (thin wrappers over the same two
 * methods); an embedder builds its own operator-facing surface on top of
 * that, exactly like `examples/basic/server.ts`'s own
 * `/api/tasks/:taskId/approve`/`reject` routes do.
 */
export declare class UnknownTaskError extends Error {
    readonly taskId: string;
    constructor(taskId: string);
}
/**
 * Thrown by {@link ConnectionHub.approveTask}/{@link ConnectionHub.rejectTask}
 * when the task exists but isn't currently `AwaitApproval` — see {@link
 * UnknownTaskError}'s own doc comment for why this is a distinct class.
 * `verb` keeps the exact pre-existing message wording per call site
 * ("cannot approve ..." vs. "cannot reject ...") byte-for-byte unchanged —
 * this message is user-visible today (e.g. `examples/basic`'s own
 * `/api/tasks/:taskId/approve` surfaces `err.message` straight to the
 * caller), so only the error's TYPE changes here, not its text.
 */
export declare class TaskNotAwaitingApprovalError extends Error {
    readonly taskId: string;
    readonly state: TaskState;
    constructor(taskId: string, state: TaskState, verb: 'approve' | 'reject');
}
/**
 * M5 (approval targeting): thrown by {@link ConnectionHub.approveTask}/
 * {@link ConnectionHub.rejectTask} when an operator-supplied
 * `opts.approvalId` is provided but does NOT match this hub's own
 * last-recorded {@link TaskSnapshot.pendingApprovalId} for `taskId` — i.e.
 * the caller is targeting a SPECIFIC approval that this server's record
 * shows has already been superseded by a newer one (see `onAwaitApproval`'s
 * own doc comment for how that happens). Distinct from
 * {@link TaskNotAwaitingApprovalError} (the task isn't `AwaitApproval` at
 * all right now — checked FIRST, so it still wins when both would apply):
 * this error means the task genuinely IS awaiting approval, just not the one
 * the caller thinks it is. Thrown before any state change and before any
 * wire message is sent — a stale-id call has zero side effects, same as any
 * other validation failure in this file.
 */
export declare class StaleApprovalError extends Error {
    readonly taskId: string;
    readonly requestedApprovalId: string;
    readonly currentApprovalId: string | undefined;
    constructor(taskId: string, requestedApprovalId: string, currentApprovalId: string | undefined);
}
/**
 * S0 (GAP-002): why {@link ConnectionHub.steerTask} refused. Stable strings —
 * a caller (an embedder's operator UI, an HTTP surface mapping this to a
 * status code) switches on these rather than matching error text.
 *
 * - `task_terminal` — the task already reached `Complete`/`Failed`/
 *   `Cancelled`. Checked FIRST, so a terminal task that is also (obviously)
 *   not `Running` reports the more specific truth, and a steer racing a
 *   terminal transition always resolves terminal-first.
 * - `task_not_running` — the task exists and is live, but is `Offered`/
 *   `Claimed`/`AwaitApproval`; there is no running turn to steer yet.
 * - `steer_unsupported_runtime` — the runtime that CLAIMED this task cannot
 *   be steered, per the claim-time capability snapshot
 *   (`TaskSnapshot.claimedRuntimeCapabilities`, sourced from the claiming
 *   adapter's own `task.claim.capabilities`). Fail-closed: a MISSING snapshot
 *   rejects under this same code, because "unknown" is not "supported" (see
 *   {@link SteerRejectedError}'s own doc comment).
 */
export type SteerRejectionCode = 'steer_unsupported_runtime' | 'task_not_running' | 'task_terminal';
/**
 * S0 (GAP-002): thrown by {@link ConnectionHub.steerTask} instead of the
 * pre-S0 generic `Error`, so a caller can tell WHY a steer was refused
 * without matching on message text — same typed-error idiom as
 * {@link UnknownTaskError}/{@link TaskNotAwaitingApprovalError}/
 * {@link StaleApprovalError} above.
 *
 * The gap this closes: pre-S0 `steerTask` sent `task.steer` to ANY `Running`
 * task, but only pi's adapter implements steering — Claude's and Codex's
 * throw on receipt (`claude-adapter.ts`, `codex-adapter.ts`), which stalls
 * the client's redelivery cursor at that seq and loops forever. So the
 * decision has to be made server-side, from per-runtime truth, BEFORE an
 * envelope exists.
 *
 * Fail-closed on unknown, deliberately: `steer_unsupported_runtime` covers
 * both "the claiming adapter reported `steer: false`" and "this server has no
 * capability snapshot for this task at all" (a pre-D-4 daemon whose claim
 * carried no `capabilities`, a task record predating S0). Refusing an unknown
 * is a recoverable operator-visible error; guessing "supported" reintroduces
 * the exact permanent cursor stall this gate exists to prevent.
 *
 * Thrown before any state change and before any wire message is built — a
 * rejected steer has zero side effects, same as every other validation
 * failure in this file.
 *
 * SINGLE SOURCE, deliberately: the gate reads the claim payload and NOTHING
 * from the connection layer — not {@link getDeviceCapabilities} (the
 * CONNECTION-level `conn.hello` flag list) and not `ConnectionState.runtimes`.
 * Two reasons, either sufficient. First, scope: connection-level data is
 * discovery describing a daemon BUILD, not the per-runtime, per-task,
 * claim-time truth this gate needs — conflating the two is the original bug.
 * Second, lifecycle: the authenticated `conn.hello` snapshot on either
 * transport describes the device build, while the claim establishes the
 * exact task↔runtime binding. Only the latter shares a lifecycle with the
 * thing this gate judges. Adding a connection-level fallback here would
 * restore the scope defect and is what this design exists to forbid.
 */
export declare class SteerRejectedError extends Error {
    readonly taskId: string;
    readonly code: SteerRejectionCode;
    /** The task's state at the moment the steer was refused. */
    readonly state: TaskState;
    /** `TaskSnapshot.claimedRuntime` — `undefined` when nothing was ever recorded (which is itself a reason `steer_unsupported_runtime` can fire). */
    readonly runtime: RuntimeId | undefined;
    constructor(taskId: string, code: SteerRejectionCode, 
    /** The task's state at the moment the steer was refused. */
    state: TaskState, 
    /** `TaskSnapshot.claimedRuntime` — `undefined` when nothing was ever recorded (which is itself a reason `steer_unsupported_runtime` can fire). */
    runtime: RuntimeId | undefined);
}
export type AgentHomeProjectionCompletionErrorCode = 'not_found' | 'conflict' | 'invalid';
export declare class AgentHomeProjectionCompletionError extends Error {
    readonly code: AgentHomeProjectionCompletionErrorCode;
    constructor(code: AgentHomeProjectionCompletionErrorCode, message: string);
}
/** A requested delivery cursor predates controls this bounded hub can recover. */
export declare class ReplayGapError extends Error {
    readonly cursor: number;
    readonly recoverableFrom: number;
    constructor(cursor: number, recoverableFrom: number);
}
export declare class ConnectionHub {
    private readonly taskStore;
    private readonly devices;
    /** See {@link CreateByokServerOptions.taskLeaseMs} — already defaulted by `createByokServer` before reaching here. */
    private readonly taskLeaseMs;
    /**
     * M4 Phase 4 (part A): per-device inbound-envelope token bucket — see
     * {@link CreateByokServerOptions.rateLimit} (already defaulted by
     * `createByokServer` before reaching here) and {@link handleInbound}'s
     * own doc comment for where it's enforced. Defaults to a fresh
     * default-configured `RateLimiter` so every existing direct-construction
     * call site (this hub is constructed directly by several tests) keeps
     * working unchanged.
     */
    private readonly rateLimiter;
    private readonly agentMessage?;
    private readonly connections;
    private readonly connectionEpochs;
    private readonly outboxes;
    /** Idempotency window per device (N3) — recent inbound envelope ids, capped at {@link DEDUP_RING_CAPACITY}. */
    private readonly dedupRings;
    private readonly longPollWaiters;
    private readonly runtimes;
    private readonly serverEvents;
    /** First-write-wins reliable facts; the reference composition's bounded in-memory readback. */
    private readonly agentEgressReceipts;
    private readonly agentMessageRequirements;
    private readonly agentMessageReceipts;
    private readonly agentMessageTaskPayloads;
    /** Accepted requests are the authority that later receipts/transfers must echo exactly. */
    private readonly agentContentReadRequests;
    /** Content-free explicit-read audit facts keyed by exact authenticated device/request identity. */
    private readonly agentContentReceipts;
    /** Immutable requested projection facts, keyed by authenticated device/request. */
    private readonly agentHomeProjectionRequests;
    /** First terminal completion for each exact projection request. */
    private readonly agentHomeProjectionCompletions;
    /**
     * Per-task last-inbound-activity timestamp (epoch ms) — the task-lease
     * reaper's condition (c), see the "task-lease reaper" section below. Reset
     * on every accepted inbound `task.*` envelope ({@link recordTaskActivity},
     * called from {@link dispatchToHandler}); cleared once the task reaches a
     * terminal state ({@link onStateChange}), so this map only ever holds
     * entries for currently non-terminal claimed tasks.
     */
    private readonly taskActivity;
    /** The task-lease reaper's own periodic sweep timer — see the constructor and `sweepLeases` below. */
    private readonly leaseReaperTimer;
    /** {@link ConnectionHub.stats}'s `uptimeMs` origin — this hub's own construction instant. */
    private readonly startedAtMs;
    /** {@link ConnectionHub.stats}'s `envelopesIn` — every {@link handleInbound} call, every outcome. */
    private envelopesInCount;
    /** {@link ConnectionHub.stats}'s `envelopesOut` — every envelope built via the single outbound choke point, {@link sendToDevice}. */
    private envelopesOutCount;
    /** {@link ConnectionHub.stats}'s `dedupDrops` (N3). */
    private dedupDropCount;
    /** {@link ConnectionHub.stats}'s `rateLimitEvents` — see {@link handleRateLimited}. */
    private rateLimitEventCount;
    /**
     * M4 Phase 4 (gatekeeper LOW advisory): devices that have already had a
     * `device.rate_limited` embedder event emitted for their CURRENT
     * over-budget episode — see {@link handleRateLimited}'s own doc comment.
     * Coalescing state only; {@link rateLimitEventCount} still counts every
     * single hit regardless of what this suppresses.
     */
    private readonly rateLimitEventEmittedFor;
    constructor(taskStore: TaskStore, devices: DeviceRegistry, 
    /** See {@link CreateByokServerOptions.taskLeaseMs} — already defaulted by `createByokServer` before reaching here. */
    taskLeaseMs: number, 
    /**
     * M4 Phase 4 (part A): per-device inbound-envelope token bucket — see
     * {@link CreateByokServerOptions.rateLimit} (already defaulted by
     * `createByokServer` before reaching here) and {@link handleInbound}'s
     * own doc comment for where it's enforced. Defaults to a fresh
     * default-configured `RateLimiter` so every existing direct-construction
     * call site (this hub is constructed directly by several tests) keeps
     * working unchanged.
     */
    rateLimiter?: RateLimiter, agentMessage?: {
        consume(input: {
            readonly deviceId: string;
            readonly taskId: string;
            readonly context: AgentMessageServerContext;
            readonly payload: AgentMessagePublishPayload;
        }): {
            readonly outcome: 'accepted' | 'held' | 'refused';
            readonly reasonCode?: string;
        };
    } | undefined);
    /**
     * Stop the task-lease reaper's sweep timer — called by `ByokServer.stop()`
     * (`index.ts`) on shutdown. Idempotent: clearing an already-cleared
     * interval is a safe no-op.
     */
    stopLeaseReaper(): void;
    /** The top-level `events` feed returned by `createByokServer` — see {@link ByokServerEvent}. */
    subscribeServerEvents(): AsyncIterable<ByokServerEvent>;
    /**
     * A daemon completed the WS handshake (`conn.hello`). Does not itself send
     * `conn.ack` or redeliver — see {@link sendConnAck}/{@link redeliverAfterReconnect}.
     *
     * `capabilities` (M5, hello-capability plumbing): the daemon's own
     * `conn.hello.capabilities` — previously silently ignored end to end (a
     * verified gap: `ws-server.ts` forwarded only `runtimes`). Optional so
     * every pre-M5 direct-construction call site (several tests construct a
     * `ConnectionHub` and call this directly) keeps working unchanged; a
     * connection this hub never learns capabilities for simply reads back
     * `undefined` from {@link getDeviceCapabilities}.
     */
    registerConnection(deviceId: string, ws: WebSocket, runtimes: RuntimeInfo[] | undefined, capabilities?: readonly string[], configuredToolsets?: readonly ToolsetId[], clientVersion?: string): number;
    /** True only while this exact WS registration remains the device authority. */
    isCurrentConnection(deviceId: string, ws: WebSocket, epoch: number): boolean;
    sendConnAck(deviceId: string, capabilities: string[]): void;
    /**
     * Reconnection procedure step 3 (§9): redeliver, in `seq` order, every
     * retained envelope with `seq > cursor` that still belongs to a
     * non-terminal task. Called after `conn.ack` (step 2), per the spec.
     */
    redeliverAfterReconnect(deviceId: string, cursor: number): void;
    /**
     * A device's WS socket closed. `ws` identifies *which* socket closed: if
     * it's no longer the one this device's connection state points at (a
     * newer WS reconnected, or long-poll took over — "last transport wins"),
     * this close is for a stale/superseded socket and the device isn't
     * actually gone, so the bookkeeping below is skipped entirely.
     *
     * M1 note: the M0 server force-failed/cancelled every in-flight task for a
     * device the instant it disconnected, on the stated premise that "a task
     * still in flight for a device that just disconnected can't be resumed, so
     * it's terminated" — true only in the absence of a redelivery cursor. M1
     * adds exactly that (§9): a task's in-flight state is retained
     * independently of any one connection, specifically so it can survive a
     * disconnect and resume via redelivery once the device reconnects. Failing
     * tasks here would make that feature unreachable in practice (nothing
     * would ever still be non-terminal by the time a reconnect happened), so
     * this now only updates connection bookkeeping and leaves task state
     * alone. A task left in-flight by a device that never reconnects stays
     * that way until the SaaS embedder explicitly cancels it — no
     * disconnect-timeout is specified by the protocol, so none is invented
     * here (see the M1-2 report's contract-gap notes).
     */
    handleDisconnect(deviceId: string, ws: WebSocket): void;
    /**
     * Drop every piece of hub state keyed by `deviceId` — called when the
     * device's registration is DELETED (§6.3 revocation, composed in
     * `index.ts`). Presence, its undelivered outbox, its inbound-dedup ring,
     * any held long-poll, and its rate-limit episode suppression only ever
     * existed to serve a row the directory can no longer name; leaving them
     * would keep a deleted device visible as live state and would let a
     * re-paired device inherit the dead one's dedup window and seq cursor.
     *
     * What the device DID is not revocation's business and is untouched here:
     * task records (`taskStore`), egress and content receipts, and projection
     * facts are history, not credentials.
     *
     * A live socket is closed rather than left attached — a still-open WS whose
     * next envelope would re-create the presence entry we just deleted is a
     * half-applied revocation. The close is detached first so `handleDisconnect`
     * sees no connection state and skips its disconnect bookkeeping: the device
     * is not going dark, it is gone.
     */
    forgetDevice(deviceId: string): void;
    /**
     * Resolve immediately if there are already-relevant events past `cursor`;
     * otherwise hold for up to `holdMs` and resolve with an empty result if
     * nothing arrives. A device may be connected via WS or long-poll, not
     * both simultaneously — a poll here supersedes (closes) any live WS for
     * this device ("last one wins", documented at the type level on
     * {@link ConnectionState}).
     */
    pollEvents(deviceId: string, cursor: number, holdMs: number): Promise<{
        events: Envelope[];
        cursor: number;
    }>;
    /** Make long-poll this device's active transport, closing any live WS ("last one wins", §8). */
    private takeOverAsLongPoll;
    /** Resolve (settle) any long-poll request currently held open for `deviceId`, if one exists. */
    private settleLongPollWaiter;
    /**
     * Single inbound choke point for every daemon -> server envelope (N2/N3/
     * P2) — called by both the WS path (`ws-server.ts`) and the long-poll send
     * path (`POST /byok/messages`, `http.ts`) in place of reaching into
     * per-type handlers directly. Runs a fixed gate, in order:
     *
     * 0. **rate limit (M4 Phase 4, part A)** — one token debited from this
     *    device's bucket ({@link rateLimiter}) for EVERY inbound envelope,
     *    before anything else runs (including the type-allow check below) —
     *    a flood of garbage-typed envelopes must cost the same budget as a
     *    flood of well-formed ones. Checked first specifically so an
     *    over-budget device is turned away as cheaply as possible, before any
     *    taskStore lookup or dedup bookkeeping. See {@link handleRateLimited}
     *    for what happens on exceed (never a silent drop).
     * 1. **type-allow (P2)** — only {@link DAEMON_TO_SERVER_TYPES} may pass; a
     *    server -> daemon type arriving inbound is rejected before it's
     *    dispatched or counted accepted. `conn.hello` is the one non-task
     *    exception, and is accepted only from the bearer-authenticated
     *    long-poll route with an exact device/product/protocol match.
     * 2. **ownership (N2)** — an envelope for a task already owned by a
     *    *different* device is dropped (logged), never force-failed:
     *    force-failing on an authz mismatch would let an attacker who merely
     *    guesses a `taskId` kill the real owner's task (a DoS). A task with no
     *    owner yet, or that doesn't exist at all, is not rejected here — the
     *    per-type handler's own no-op-on-missing-record behavior covers the
     *    latter.
     * 3. **dedup (N3)** — an envelope `id` already seen from this device is a
     *    no-op: the wire is at-least-once (§9), this makes server-side
     *    processing at-most-once. Check-and-record is synchronous (Node is
     *    single-threaded), so it's atomic with respect to any other envelope
     *    for this device.
     * 4. **dispatch** — handed to the existing per-type `on*` handler.
     *
     * Returns which outcome applied. A duplicate still counts as `accepted` on
     * the `POST /byok/messages` wire (§8.2) — an idempotent replay is a
     * wire-level success even though no handler ran a second time; only
     * `rejected`/`rate_limited` (gate steps 0-2) are excluded from that count.
     */
    handleInbound(deviceId: string, envelope: Envelope, authenticatedProductId?: string): 'accepted' | 'duplicate' | 'rejected' | 'rate_limited';
    /**
     * Store before acking. Replays must agree on every identity/cursor/hash
     * field and receive the original receipt id; a same event id with changed
     * facts is rejected rather than treated as an update.
     */
    private handleAgentEgressReliable;
    private handleAgentMessagePublish;
    private sendAgentMessageDisposition;
    private handleAgentContentReceipt;
    private sendAgentEgressAck;
    private sendAgentContentReceiptAck;
    private agentEgressReceiptKey;
    /** Record the authenticated long-poll equivalent of the WS opening frame. */
    private registerLongPollHello;
    /**
     * M4 Phase 4 (part A): `deviceId` just exceeded its inbound-envelope rate
     * limit. Never a silent drop: counts the occurrence
     * ({@link rateLimitEventCount}, surfaced via {@link stats} — every single
     * hit, unconditionally) and, the FIRST time in this over-budget episode
     * only, emits an embedder-facing `device.rate_limited`
     * {@link ByokServerEvent} — see that variant's own doc comment (`types.ts`)
     * for the full per-transport enforcement shape.
     *
     * Gatekeeper LOW advisory (event amplification): a single flood can make
     * `handleInbound` call this many times in a row — e.g. several WS frames
     * already in flight before the close below actually lands, or a
     * long-poll device retrying its `POST /byok/messages` before its bucket
     * has refilled. Without coalescing, an embedder subscribed to
     * `events.subscribe()` would see one `device.rate_limited` per hit, which
     * is noisy for what is really ONE ongoing episode of one device
     * flooding. `rateLimitEventEmittedFor` suppresses the repeats: this
     * method only pushes the event the first time it sees a given `deviceId`
     * since `handleInbound`'s own success path last cleared it (i.e. since
     * this device was last confirmed back under budget) — the COUNTER above
     * is entirely unaffected by this and still increments on every call,
     * unconditionally.
     *
     * This method only handles the WS half of the enforcement shape (closing
     * the live connection, if any, so the client's existing backoff+reconnect
     * takes over — mirrors `takeOverAsLongPoll`'s own `ws.close`, the only
     * other place this hub closes a device's socket directly); a long-poll
     * device has no live `ws` to close here at all (`conn.ws` is `undefined`
     * while long-polling — see {@link ConnectionState}), so `http.ts`'s
     * `/byok/messages` handler maps this same `'rate_limited'` `handleInbound`
     * outcome to an HTTP 429 for that transport instead.
     */
    private handleRateLimited;
    /**
     * Idempotency check-and-record (N3): `true` (duplicate) if `id` was
     * already seen for `deviceId`; otherwise records it and returns `false`.
     * Bounded to {@link DEDUP_RING_CAPACITY} ids per device — a ring, not an
     * unbounded set — evicting the oldest once full.
     */
    private checkAndRecordDuplicate;
    /**
     * Route one already-gated envelope (see {@link handleInbound}) to its
     * per-type handler. Type-allow/ownership/dedup have already run by the
     * time this executes, so the handlers below no longer need their own
     * device-mismatch checks — that authz decision now lives solely in
     * `handleInbound` (N2).
     *
     * Also the task-lease reaper's activity checkpoint
     * ({@link recordTaskActivity}): every envelope for a task that currently
     * *exists and is non-terminal* counts as proof of life for `taskId`'s
     * lease, regardless of what its per-type handler below ends up doing with
     * it (including a no-op/stale drop) — see the "task-lease reaper" section
     * further down for why. Deliberately gated on the record's existence and
     * non-terminal state *here*, before dispatch: `taskActivity` must never
     * gain an entry for a taskId that doesn't exist (a nonexistent/garbage id
     * an authenticated-but-malicious daemon could send indefinitely — an
     * unbounded-growth vector, since `taskId`s aren't deduped the way envelope
     * `id`s are) or for one that's already terminal (a stale/late message for
     * a finished task — `onStateChange` deletes the entry on the *real*
     * terminal transition, but a stale message arriving *after* that would
     * otherwise silently recreate it, since every per-type handler's own
     * terminal/unknown-task guard runs — and early-returns — only *after*
     * this would already have recorded activity).
     */
    private dispatchToHandler;
    /** Reset the task-lease reaper's per-task clock (condition (c) in the "task-lease reaper" section below). */
    private recordTaskActivity;
    /**
     * Ownership (record.deviceId matching the connection's authenticated
     * deviceId) is enforced centrally by {@link handleInbound} (N2) before this
     * runs; only the idempotent-claim CAS and the first-claim device patch
     * happen here.
     *
     * M5 (claimed runtime, docs/protocol.md §3.1): `payload.runtime` — the
     * ACTUAL adapter the daemon selected (`TaskRunner.pickAdapter`,
     * `packages/client`'s `task-runner.ts`) — is recorded into
     * `TaskSnapshot.claimedRuntime` alongside the device patch, distinct from
     * the pre-existing `TaskSnapshot.runtime` (the merely REQUESTED runtime,
     * untouched here and set only once, at `dispatch()` time). Only ever
     * written on the FIRST real claim: the idempotent-CAS early return above
     * fires before this for a retried claim from a device that already owns
     * the task, so a redelivered/retried `task.claim` can never overwrite an
     * already-recorded `claimedRuntime` — including with a stale or absent
     * value from an out-of-order retry.
     *
     * S0/D-4 (claim-time capability snapshot): `payload.capabilities` — the
     * claiming adapter's OWN self-report, carried on this same `task.claim`
     * (docs/protocol.md §2.4) — supplies
     * `TaskSnapshot.claimedRuntimeCapabilities`, written in the same patch and
     * therefore under the same write-exactly-once property as `claimedRuntime`.
     *
     * Taken from the payload and from nowhere else. This hub deliberately does
     * NOT consult connection state (`conn.hello.runtimes[]`) for it — see
     * {@link SteerRejectedError} for why that source is structurally wrong for a
     * control decision, and that field's own doc comment (`types.ts`) for why
     * this is snapshotted rather than read live at steer time. A claim that
     * carries no `capabilities` (a pre-D-4 daemon) records `undefined`, which
     * the gate reads as "unknown" and refuses.
     */
    private onClaim;
    /**
     * `Claimed -> Running` (§3.1) — a daemon actually starting the runtime
     * session, distinct from merely claiming. Ownership is already enforced
     * by {@link handleInbound} (N2) before this runs.
     */
    private onStarted;
    /**
     * `Offered -> Failed` (§3.2) — a fail-closed pre-claim rejection. Only
     * ever legal from `Offered`; anything else is stale. Ownership is already
     * enforced by {@link handleInbound} (N2) before this runs.
     */
    private onDecline;
    private onProgress;
    private onArtifact;
    private onAwaitApproval;
    private onComplete;
    private onFail;
    /**
     * Dual-purpose on receipt (§3.3): if the server already moved this task to
     * `Cancelled` on its own action (the common case — `cancelTask()` is
     * authoritative immediately, §4), this is a late idempotent ack — silent,
     * not a warning (this is the other half of the M0 gatekeeper finding this
     * change resolves). Otherwise it's the authoritative trigger for a
     * cancellation the daemon observed that the server didn't initiate.
     * Ownership is already enforced by {@link handleInbound} (N2) before this
     * runs.
     */
    private onCancelled;
    /**
     * M4 (additive-minor, `task.approval_resolved`): the EXPLICIT counterpart
     * to {@link resumeIfImplicitlyApproved} — a daemon that resolved a pending
     * approval entirely LOCALLY now reports it immediately, instead of the
     * server only finding out after the fact once evidence (a later
     * `task.progress`/`task.artifact`/`task.complete`) proves it.
     *
     * Relationship to the implicit path (both stay, permanently — this is not
     * a replacement): {@link resumeIfImplicitlyApproved} remains completely
     * untouched as the fallback for (a) an old daemon that predates this
     * message, and (b) a daemon connected to an old server that never
     * advertised the `approval_resolved` capability flag (`version.ts`) at
     * handshake time — in either case the daemon never sends this message at
     * all (see `packages/client`'s `task-runner.ts`), and the server keeps
     * inferring the resolution from evidence exactly as it did before this
     * message existed. When THIS message does arrive first, it already moves
     * the record out of `AwaitApproval` (see below) — so by the time any
     * following `task.progress`/etc. reaches `onProgress`/`onArtifact`/
     * `onComplete`, `resumeIfImplicitlyApproved`'s own `record.state !==
     * 'AwaitApproval'` guard is already true and it no-ops, never firing its
     * own `task.approval_resolved_implicit` event a second time for the same
     * resolution. The two mechanisms race harmlessly: whichever one the
     * server processes first is the one that actually performs the
     * transition; the other is naturally inert once it runs.
     *
     * Three outcomes, mirroring this file's existing per-type idempotency
     * conventions:
     *   - `AwaitApproval` (the expected case): legal transition to `Running`
     *     (an existing `TASK_TRANSITIONS` edge, the same one `approveTask`
     *     itself uses) plus a `task.approval_resolved` {@link ByokServerEvent}
     *     carrying `approvalId`/`decision`/`resolvedBy` for an embedder to
     *     observe.
     *   - Already `Running` (evidence — or the implicit path — already beat
     *     this message to it): idempotent no-op, silent, mirroring
     *     `onStarted`'s own already-running guard.
     *   - Terminal, or a state that was never `AwaitApproval` in the first
     *     place (`Offered`/`Claimed` — a genuinely out-of-sequence report):
     *     stale no-op with a `console.warn`, matching this file's existing
     *     stale-message convention (`forceFailOrDrop`, `handleInbound`'s
     *     ownership-mismatch drop) — never force-failed, since a late/
     *     redelivered report about a task that has already moved on is not
     *     evidence of anything currently wrong with it.
     *
     * This is also the residual-race resolution the accompanying protocol/docs
     * update documents: a SaaS decision (`approveTask`/`rejectTask`) already in
     * flight when the local resolution happens can still land on the server
     * FIRST and move the record to a terminal state before this message
     * arrives — in that case this message hits the terminal branch above and
     * is a stale no-op, exactly like any other late message for an
     * already-terminal task. The window for that crossing is now
     * network-latency-sized (how long this message takes to arrive), not
     * "until the next progress message" the way the pre-existing implicit-only
     * inference left it.
     */
    private onApprovalResolved;
    /**
     * M5 (approval targeting): single low-level wrapper around
     * `TaskStore.transition` that every ACTUAL state-changing write in this
     * file goes through — {@link applyOrFail}'s legal-transition branch,
     * {@link forceFailOrDrop}, and {@link resumeIfImplicitlyApproved} (the one
     * caller that transitions WITHOUT going through `applyOrFail` at all).
     * Two responsibilities, folded in here once rather than duplicated at
     * each call site:
     *
     *   1. Clears `pendingApprovalId` whenever `record` is LEAVING
     *      `AwaitApproval` (`record.state === 'AwaitApproval' && to !==
     *      'AwaitApproval'`) — the id this hub last recorded for a task's
     *      pending approval ({@link onAwaitApproval}) is meaningless the
     *      instant that task is no longer awaiting it. Clearing it here,
     *      centrally, is what guarantees a FUTURE `AwaitApproval` cycle for
     *      the SAME task always starts from a clean slate instead of silently
     *      inheriting a stale id from a previous cycle (which would make a
     *      stale-approval check against the NEW cycle's real pending id
     *      spuriously pass just because a leftover value happened to still be
     *      sitting in the record).
     *   2. Calls {@link onStateChange} — every call site already did this
     *      immediately after its own `transition` call; folding it in here
     *      removes the duplication and the chance of a future call site
     *      forgetting it.
     */
    private transitionTask;
    /**
     * Apply `taskId`'s state -> `target`. If that's illegal per
     * `TASK_TRANSITIONS`, fall back to `Failed` (if reachable from the current
     * state); this is the "illegal transition = error + task.fail path" rule.
     */
    private applyOrFail;
    /**
     * M4 Phase 3 hardening (orchestrator-directed fix for the server-state-
     * machine trace finding): a task can be resolved entirely OUT-OF-BAND, on
     * the daemon side only (M4 Phase 3's local `approvals.resolve`
     * control-socket path, `packages/client`) — the server never sees a wire
     * `task.approve`/`task.reject` for it, so its own record sits in
     * `AwaitApproval` even though the daemon already resumed and moved on.
     *
     * The daemon is the execution authority in this security model (the SaaS
     * only ever *proposes* — see docs/spec.md); the daemon sending ANY further
     * task.* traffic for a task the server still thinks is `AwaitApproval` is
     * itself sufficient proof the approval was resolved locally, one way or
     * another. Rather than force-failing/dropping that traffic (the pre-fix
     * behavior — `onProgress`/`onArtifact`'s own `!== 'Running'` guard,
     * `onComplete`'s illegal-transition fallback), this applies the exact same
     * `AwaitApproval -> Running` edge `approveTask` already uses (a
     * pre-existing legal `TASK_TRANSITIONS` edge, not a new one) through the
     * normal transition path — `taskStore.transition` + `onStateChange`, same
     * as `applyOrFail`'s own legal-transition branch — so every existing
     * consumer of task state (§, `TaskHandle.events()`, the lease reaper's
     * `taskActivity`) observes it exactly as it would a real wire
     * `task.approve`. Then emits `task.approval_resolved_implicit` (a
     * `ByokServerEvent`, NOT a wire message — see that type's own doc comment)
     * so an embedder can distinguish this from an operator-driven approval.
     *
     * M4 (additive-minor, superseding this method's own former "deferred"
     * framing): a first-class `task.approval_resolved` WIRE notification now
     * exists (`onApprovalResolved`, below) — a daemon that supports it, talking
     * to a server that advertised the `approval_resolved` capability flag
     * (`version.ts`), reports a local resolution explicitly and immediately
     * instead of leaving the server to infer it here. This method is
     * UNTOUCHED and remains the permanent fallback for the N/N-1 cases where
     * that explicit report never arrives (an old daemon, or an old server this
     * daemon is talking to) — see `onApprovalResolved`'s own doc comment for
     * the full relationship between the two paths, including why they can
     * never both fire for the same resolution.
     *
     * No-op (returns `record` unchanged) for any state other than
     * `AwaitApproval` — every other guard (terminal, pre-claim, already-
     * Running) keeps exactly its current behavior. `onFail`/`onCancelled`
     * never call this: `Failed`/`Cancelled` are already direct, legal edges
     * from `AwaitApproval`, so they never hit the illegal-transition path this
     * exists to avoid in the first place.
     */
    private resumeIfImplicitlyApproved;
    /**
     * A daemon message didn't fit the task's current state (e.g. progress
     * while AwaitApproval). Force the task to `Failed` if that's reachable;
     * otherwise it's already terminal (or `Offered`, which has no Failed edge)
     * and there's nothing safe to do but log + drop.
     */
    private forceFailOrDrop;
    private onStateChange;
    /**
     * Task lease: a backstop for a device that goes dark mid-task and never
     * comes back — distinct from, and layered on top of, M1's redelivery
     * (docs/protocol.md §9), which already handles "device reconnects within
     * the window, nothing lost." Decision (user+design): reuse the existing
     * `Failed` terminal state and its `retryable` flag —
     * `Failed(retryable: true, reason: 'lease-expired')` — exactly like any
     * other `task.fail`. The embedder is expected to treat this exactly like
     * any other retryable failure: re-dispatch as a brand-new task.
     *
     * Implemented as a periodic sweep (see the constructor), not a per-task
     * timer, so a device that goes dark *after* being idle-but-connected for a
     * while is still caught on a later tick without needing extra bookkeeping
     * at disconnect time. `sweepLeases` reaps a task only when ALL of the
     * following hold, checked fresh on every tick (never cached):
     *
     *   (a) the task is in a non-terminal *claimed* state — `Claimed`,
     *       `Running`, or `AwaitApproval` ({@link isClaimedState}). `Offered`
     *       is excluded: it has no owning device yet, so there's nothing to
     *       be "dark".
     *   (b) the owning device is dark right now ({@link deviceDarkSince}
     *       returns a timestamp rather than `undefined`) — disconnected
     *       outright, or (long-poll only) hasn't been seen since before the
     *       lease window. A live WS connection is never dark from the
     *       reaper's point of view: `heartbeat.ts` already independently
     *       proves liveness at the transport level and flips
     *       `connected: false` via `handleDisconnect` once it stops getting
     *       pongs — the reaper just reads that flag rather than re-deriving
     *       it. `deviceDarkSince` also returns *when* darkness started
     *       ({@link ConnectionState.darkSince}, set the instant
     *       `handleDisconnect` flips the connection dark) — that instant
     *       feeds condition (c), below.
     *   (c) a full `taskLeaseMs` has elapsed since the *later* of: the task's
     *       own last inbound-activity timestamp ({@link taskActivity}, reset
     *       in {@link dispatchToHandler} on every accepted envelope for a
     *       known, non-terminal task — claim, started, progress, artifact,
     *       await_approval, anything), and (b)'s dark-since instant. Taking
     *       the *later* of the two — not the activity timestamp alone — is
     *       what makes a device going dark start a fresh, full countdown
     *       instead of reusing whatever (possibly already-stale) activity
     *       timestamp the task happened to have: a task can be legitimately
     *       idle *while connected* for longer than `taskLeaseMs` (a long turn
     *       with no progress events, or just a quiet stretch) without being
     *       touched — see (b) — but the instant such a task's device
     *       disconnects, that stale activity timestamp must NOT immediately
     *       satisfy (c) on its own, or the task would get reaped within one
     *       sweep tick of disconnect instead of waiting the full window. That
     *       was a real bug (a disconnect-after-long-idle reap effectively
     *       indistinguishable from the M0 disconnect-alone-fails-the-task
     *       behavior M1 removed, below); anchoring (c) to
     *       `max(lastActivity, darkSince)` fixes it — idle time that elapsed
     *       *before* the device went dark no longer counts toward the lease,
     *       only silence *after* dark-start does.
     *
     * (b) and (c) are deliberately independent clocks, not one merged check.
     * The property this most exists to protect: a *connected*, momentarily
     * idle device mid-turn must never be reaped, no matter how long
     * `taskLeaseMs` is — condition (b) alone blocks that regardless of (c).
     * This is also what keeps this from reintroducing the M0 bug M1
     * deliberately removed (see `handleDisconnect`'s own doc comment above) —
     * M0 force-failed a task the instant its device disconnected; M1
     * correctly stopped doing that so a task could survive a disconnect and
     * resume via redelivery. This reaper does not revert that: disconnect
     * ALONE still does nothing here either — (c) still has to independently
     * hold, and per the `max(...)` above it only will once a full
     * `taskLeaseMs` has genuinely elapsed *since the device went dark*, no
     * matter how stale the task's own activity timestamp already was at that
     * moment.
     *
     * Interaction with redelivery (§9): redelivery is what handles "the
     * device came back within the window" — nothing to reap, normal traffic
     * resumes. This reaper is what handles "it never came back." Idempotent
     * claim (`onClaim`'s CAS) still protects server-side bookkeeping if a
     * device wakes up *after* its task was already reaped and retries a stale
     * claim/progress/etc. for it: every per-type handler's existing
     * stale/terminal-task guard (§9) drops it as a no-op, same as any other
     * late message for an already-terminal task — no new guard was needed for
     * that here.
     *
     * Accepted residual (by design, not a bug): idempotent claim protects
     * *server-side* state, not the device's own local side effects. A dark
     * device that wakes up after its task has already been reaped may still
     * be mid-way through running real local work (file writes, shell
     * commands, whatever the runtime adapter was doing) for a task the server
     * has since moved on from — and that the embedder may have already
     * re-dispatched elsewhere. There is no way to remotely guarantee a
     * truly-dark device stops running; the mitigation is entirely
     * `taskLeaseMs` being set far larger than any realistic task duration, so
     * this can only happen to a device that was genuinely gone for a very
     * long time, not a normal slow turn.
     */
    private sweepLeases;
    /**
     * Condition (b) above: `undefined` while `deviceId`'s connection counts as
     * alive (never reapable, no matter how stale (c) is); otherwise the
     * epoch-ms instant it began counting as "dark" for lease purposes.
     * `sweepLeases` combines this with (c)'s own last-activity instant via
     * `max(...)` so the full `taskLeaseMs` silence window is always measured
     * from whichever of the two happened later.
     */
    private deviceDarkSince;
    /** Reap one lease-expired task through the exact same TaskStore/canTransition path — and terminal-event emission — as any other `task.fail` (see {@link applyOrFail}). */
    private reapTask;
    dispatch(input: DispatchInput): Promise<TaskHandle>;
    dispatchFreshAgentEgress(input: FreshAgentEgressDispatchInput): Promise<TaskHandle>;
    private dispatchInternal;
    /** Capability-gated control-plane read request; no request enters the outbox on omission. */
    requestAgentContentRead(input: AgentContentReadRequest): Promise<void>;
    /** Task-free exact-device projection; no task record, runtime or session is created. */
    enqueueAgentHomeProjection(input: AgentHomeProjectionRequest): Promise<AgentHomeProjectionReadback>;
    readAgentHomeProjection(deviceId: string, requestId: string): AgentHomeProjectionReadback | undefined;
    completeAgentHomeProjection(deviceId: string, input: AgentHomeProjectionCompletionRequest): AgentHomeProjectionReadback;
    private buildTaskHandle;
    /** Idempotent: cancelling an already-terminal task is a no-op, not an error. */
    private cancelTask;
    /**
     * M4 Phase 3: made public (was private through M3) so an embedder can call
     * it directly from its own operator-facing surface — there is no
     * bearer-authed HTTP route for this on `http.ts`'s own app (see
     * `UnknownTaskError`'s own doc comment for why, and
     * `examples/basic/server.ts`'s `/api/tasks/:taskId/approve` for the
     * intended shape of that embedder-built surface). See this file's own
     * `UnknownTaskError`/`TaskNotAwaitingApprovalError` doc comments for why
     * the two failure modes are now distinct typed errors rather than a
     * single generic `Error`. Every thrown message's TEXT is byte-for-byte
     * unchanged from M2/M3 — only the error's type changed (this is still also
     * reachable via `TaskHandle.approve()`, unaffected).
     */
    /**
     * M5 (approval targeting, docs/protocol.md §5.3): `opts.approvalId`
     * targets a SPECIFIC pending approval rather than "whichever one is
     * currently pending" (the pre-M5 default, unchanged when `opts` is
     * omitted). Validated FIRST, before any state change or wire send: if
     * `opts.approvalId` is supplied and this hub has a recorded
     * `pendingApprovalId` for `taskId` that DIFFERS, throws
     * {@link StaleApprovalError} — no transition, no `task.approve` sent. If
     * this hub never recorded a `pendingApprovalId` (a legacy daemon that
     * never reported one), the call proceeds untargeted exactly as before.
     * The outgoing `task.approve` carries `approvalId`: the caller-supplied
     * one if given, else this hub's own recorded one, else omitted entirely
     * (legacy wire shape) — so the daemon can apply its own exact-match check
     * whenever this server has an id to offer at all.
     */
    approveTask(taskId: string, opts?: {
        approvalId?: string;
    }): Promise<void>;
    /**
     * M4 Phase 3: made public — see {@link ConnectionHub.approveTask}'s own
     * doc comment for the full rationale (identical reasoning applies here).
     * M5: same `opts.approvalId` targeting semantics as `approveTask` above —
     * see that method's own doc comment.
     */
    rejectTask(taskId: string, reason?: string, opts?: {
        approvalId?: string;
    }): Promise<void>;
    /**
     * S0 (GAP-002): a task-level gate, evaluated in full before any envelope is
     * built — see {@link SteerRejectedError} for the gap this closes and why an
     * unknown capability must refuse rather than proceed. Order matters:
     *
     *   1. unknown task — unchanged pre-S0 `Error` (this is not a steer-policy
     *      decision, and `TaskHandle.steer` can only be reached with a taskId
     *      this hub minted, so it's a programming error, not an operator one);
     *   2. terminal (`Complete`/`Failed`/`Cancelled`) -> `task_terminal`,
     *      checked BEFORE the `Running` check so a steer racing a terminal
     *      transition always resolves terminal-first;
     *   3. not `Running` (`Offered`/`Claimed`/`AwaitApproval`) ->
     *      `task_not_running`;
     *   4. the claim-time snapshot does not positively say `steer: true` ->
     *      `steer_unsupported_runtime`, including when there is no snapshot at
     *      all (fail-closed);
     *   5. only then, the pre-existing device-liveness check and the send.
     *
     * Step 4 reads `TaskSnapshot.claimedRuntimeCapabilities` — the per-runtime,
     * per-task value frozen at claim time from the claiming adapter's own
     * `task.claim.capabilities` — and reads NO connection state whatsoever:
     * not {@link getDeviceCapabilities}, not `ConnectionState.runtimes`, and
     * with no fallback to either when the snapshot is absent. See
     * {@link SteerRejectedError} for why a connection-sourced input is wrong
     * in scope (it describes a daemon build, not this task's runtime).
     */
    private steerTask;
    private pickFirstConnectedDevice;
    /**
     * Build a server -> daemon envelope with a fresh per-device `seq`, retain
     * it in that device's outbox ring buffer, and deliver it now if a live
     * transport is available (WS send, or wake a pending long-poll).
     *
     * `opts`'s type mirrors `createEnvelope`'s own per-type conditional
     * requiredness (finding F1) minus `seq` (computed fresh right here on
     * every call, never caller-supplied) — so every one of this method's 6
     * callers below must supply `taskId` for the 5 types that need it
     * (everything except `conn.ack`), same as calling `createEnvelope`
     * directly would require.
     */
    private sendToDevice;
    private deliverToDevice;
    /**
     * Retained envelopes for `deviceId` with `seq > cursor` that still belong
     * to a non-terminal task — OR are explicitly exempted from that filter
     * (`redeliverThroughTerminal`, N1/F4: `task.cancel`/`task.reject`) — in
     * `seq` order. The `seq > cursor` bound is what naturally stops an
     * exempted entry from redelivering forever: once the daemon acks it (its
     * reported cursor advances past that `seq`), it no longer qualifies here
     * on any future reconnect/poll.
     */
    private collectRelevant;
    /**
     * A caller at `recoverableFrom - 1` can still receive the first retained
     * control. Anything earlier would be a partial tail and must fail closed.
     */
    assertReplayAvailable(deviceId: string, cursor: number, pendingOutbound?: number): void;
    private isRecoverableEntry;
    private isTaskTerminal;
    /** The highest `seq` assigned to `deviceId` so far — the redelivery cursor to hand back on a poll/reconnect. */
    private currentCursor;
    private getOrCreateOutbox;
    private nextConnectionEpoch;
    listMachines(): MachineInfo[];
    /**
     * M5 (approval targeting, hello-capability plumbing): the capability flags
     * `deviceId`'s CURRENT connection advertised in its `conn.hello` —
     * `undefined` if this hub has no connection state for the device at all,
     * or one that never had capabilities recorded (a pre-M5 daemon, or a
     * device this hub only ever saw over long-poll with no prior WS hello —
     * see `ConnectionState.capabilities`'s own doc comment). Read fresh from
     * live connection state, mirroring `listMachines()`'s own convention; an
     * embedder can use this to distinguish a targeting-capable device from a
     * legacy one for its own observability/UI purposes (see `version.ts`'s
     * `approval-targeting` flag doc comment for why this is informational
     * only, never a correctness gate).
     */
    getDeviceCapabilities(deviceId: string): readonly string[] | undefined;
    private hasDeviceCapabilities;
    getAgentEgressReceipt(deviceId: string, eventId: string): AgentEgressReceipt | undefined;
    getTask(taskId: string): TaskSnapshot | undefined;
    listTasks(): TaskSnapshot[];
    /**
     * A plain, serializable snapshot of this hub's current state, derived from
     * existing structures (`connections`, `taskStore`) plus the small counters
     * this file already maintains for exactly this purpose — no new
     * bookkeeping structures beyond those counters. See {@link HubStats}
     * (`types.ts`) for the full field-by-field contract.
     */
    stats(): HubStats;
}
// ==== @byok-sdk/server dist/index.d.ts ====
import type { Server as HttpServer } from 'node:http';
import type { Hono } from 'hono';
import { type TenantId } from './auth';
import { type PairingCodeClaims, type PairingCodeInfo } from './pairing';
import type { ByokServerEvent, AgentContentReadRequest, AgentHomeProjectionRequest, AgentHomeProjectionStatusReadback, AgentEgressReceipt, CreateByokServerOptions, DispatchInput, FreshAgentEgressDispatchInput, HubStats, MachineInfo, TaskHandle, TaskSnapshot } from './types';
export type { ByokServerEvent, AgentContentReadRequest, AgentHomeProjectionRequest, AgentHomeProjectionStatusReadback, AgentEgressReceipt, CreateByokServerOptions, DispatchInput, FreshAgentEgressDispatchInput, HubStats, MachineInfo, ServerTaskEvent, TaskHandle, TaskResult, TaskSnapshot, } from './types';
export type { CreateTaskInput, TaskRecord, TaskStore } from './task-store';
export { IllegalTaskTransitionError, InMemoryTaskStore } from './task-store';
/**
 * M5 (approval targeting, docs/protocol.md §5.3): previously unreachable via
 * this package's public entry point (only importable from the internal
 * `./hub` path) — `TaskHandle.approve`/`reject`'s `opts.approvalId` targeting
 * (`types.ts`) throws this, so a caller needs it exported here to
 * `instanceof`-check/inspect it. See `hub.ts`'s own doc comment for the full
 * staleness semantics.
 */
export { StaleApprovalError } from './hub';
/**
 * S0 (GAP-002): `TaskHandle.steer` (`types.ts`) throws this when the runtime
 * that claimed the task cannot be steered, when the task isn't running, or
 * when it's already terminal — a caller needs the class to `instanceof`-check
 * it and the code union to switch on. See `hub.ts`'s own doc comments for the
 * full gate order and the fail-closed-on-unknown rationale.
 */
export { SteerRejectedError } from './hub';
export type { SteerRejectionCode } from './hub';
export { AgentHomeProjectionCompletionError } from './hub';
export type { AgentHomeProjectionCompletionErrorCode } from './hub';
export { PairingAttemptConflictError, PairingCodeInvalidError } from './pairing';
export type { PairingAttemptBinding, PairingCodeClaims, PairingCodeInfo, PairingCompletion } from './pairing';
export type { AccessTokenClaims, AuthenticatedDevice, DeviceRecord, TenantId, TokenSigner, } from './auth';
/**
 * S1: `DeviceRegistry` itself is deliberately NOT exported. Its
 * tenant-scoped surface is reachable through `ByokServer.devices` (below),
 * and the one method that resolves a device without a tenant in scope
 * (`resolveByDeviceId`, for the two pre-tenant wire endpoints) exists only
 * inside this package — exporting the class would hand every embedder a
 * cross-tenant device oracle for free.
 */
export { createHmacTokenSigner } from './auth';
export type { BlobStore, BlobUploadReservation, CreateUploadInput, ReadContentResult, WriteContentResult, } from './blob-store';
export { LocalDiskBlobStore } from './blob-store';
export type { SqliteTaskStoreOptions } from './sqlite-task-store';
export { SqliteTaskStore } from './sqlite-task-store';
export type { SqliteBlobStoreOptions } from './sqlite-blob-store';
export { SqliteBlobStore } from './sqlite-blob-store';
export { SqliteUnavailableError } from './sqlite-support';
export type { RateLimiterOptions } from './rate-limiter';
/** The object `createByokServer` returns — the SaaS-embedder-facing surface. */
export interface ByokServer {
    /** Hono app exposing the pair/challenge/token/blob/events HTTP routes. Mount it, or use its `.fetch` with `@hono/node-server`. */
    hono: Hono;
    /** Wire up the `GET /byok/ws` upgrade on the raw Node HTTP server serving `hono`. */
    attachWebSocket(server: HttpServer): void;
    pairing: {
        /**
         * S1: minting a code REQUIRES the tenant and product the redeeming
         * device will be paired into (docs/protocol.md §6.1) — the SaaS's own
         * auth/device-flow UI is the only party that knows them, and the device
         * never gets to name its own. There is no claimless overload.
         */
        createPairingCode(claims: PairingCodeClaims): PairingCodeInfo;
    };
    dispatch(input: DispatchInput): Promise<TaskHandle>;
    /** Dispatch a fresh Agent execution whose runtime will mint its session after start. */
    dispatchFreshAgentEgress(input: FreshAgentEgressDispatchInput): Promise<TaskHandle>;
    /** Enqueue one capability-gated, exact-identity content-read request. */
    requestAgentContentRead(input: AgentContentReadRequest): Promise<void>;
    /** Enqueue one task-free, exact-device Agent-home projection. */
    enqueueAgentHomeProjection(input: AgentHomeProjectionRequest): Promise<AgentHomeProjectionStatusReadback>;
    /** Reference-only in-process status readback; production durability belongs to @byok-sdk/cloud stores. */
    readAgentHomeProjection(deviceId: string, requestId: string): AgentHomeProjectionStatusReadback | undefined;
    tasks: {
        get(taskId: string): TaskSnapshot | undefined;
        list(): TaskSnapshot[];
    };
    /** Reference-server reliable egress receipt readback. */
    egress: {
        get(deviceId: string, eventId: string): AgentEgressReceipt | undefined;
    };
    machines: {
        list(): MachineInfo[];
    };
    events: {
        subscribe(): AsyncIterable<ByokServerEvent>;
    };
    /**
     * Device revocation (§6.3) — server-side only, no wire message. Revoking a
     * device DELETES its registration, so its next `/byok/challenge`,
     * `/byok/token`, WSS connect, or authed HTTP call gets a 401 — the same
     * answer as for a device id that was never registered — and its only
     * recourse is to re-run `/byok/pair`. The device-scoped state the row
     * owned (outstanding challenge nonces, presence, inbound dedup) is deleted
     * with it; what the device DID (tasks, receipts) is history and survives.
     *
     * S1: tenant-first, and a tenant can only revoke a device it owns — a
     * `(tenantId, deviceId)` pair belonging to someone else resolves to
     * nothing and this is a silent no-op rather than a cross-tenant write.
     */
    devices: {
        revoke(tenantId: TenantId, deviceId: string): void;
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
export declare function createByokServer(opts: CreateByokServerOptions): ByokServer;
// ==== @byok-sdk/server dist/pairing.d.ts ====
import type { TenantId } from './auth';
/**
 * S1: the tenant identity a pairing code carries. Minted out-of-band by the
 * SaaS's own auth/device-flow UI — the only party that knows which tenant a
 * human is acting for — and returned by {@link PairingManager.redeemPairingCode}
 * so `POST /byok/pair` can write it onto the device row in the same
 * synchronous step that consumes the code.
 *
 * Deliberately NOT a wire field: `PairRequest` has no tenant of its own
 * (docs/protocol.md §6.1), so a device can never name the tenant it lands in.
 * These claims are the single source of truth for the row, and the row — not
 * a later token, and never client input — is what every authed surface
 * checks against.
 */
export interface PairingCodeClaims {
    tenantId: TenantId;
    productId: string;
}
export interface PairingCodeInfo {
    code: string;
    expiresAt: string;
}
/** Immutable facts supplied by one first-pair HTTP request. */
export interface PairingAttemptBinding {
    deviceName: string;
    devicePublicKey: string;
}
/** The recoverable enrollment fact created exactly once for one pairing code. */
export interface PairingCompletion {
    deviceId: string;
    tenantId: TenantId;
    productId: string;
    deviceName: string;
    devicePublicKey: string;
}
/** Thrown when a pairing code is missing, expired, or already used. */
export declare class PairingCodeInvalidError extends Error {
    constructor(reason: string);
}
/** A spent code may be replayed only with the immutable request that spent it. */
export declare class PairingAttemptConflictError extends Error {
    constructor();
}
/**
 * In-memory pairing-code lifecycle: single-use, ~10min TTL codes minted
 * out-of-band (by the SaaS's own auth/device-flow UI) and redeemed exactly
 * once by `POST /byok/pair`.
 *
 * Device identity (deviceId/deviceName/devicePublicKey/revocation) and
 * token issuance moved to `auth.ts`'s `DeviceRegistry`/`TokenSigner` as of
 * Auth v2 (docs/protocol.md §6) — this class knows about devices only to the
 * extent of carrying the {@link PairingCodeClaims} that decide which tenant
 * and product the device being paired will belong to (S1).
 */
export declare class PairingManager {
    private readonly codes;
    /**
     * Mint a single-use code bound to `claims`. Claims are REQUIRED — a
     * claimless mint is a compile error, and (for a JS caller, or a claims
     * object assembled from untyped config) a runtime {@link TypeError}. There
     * is no default tenant and no default product: a device with no tenant
     * must be inexpressible, so the failure happens here, at the mint, rather
     * than being filled in downstream.
     */
    createPairingCode(claims: PairingCodeClaims): PairingCodeInfo;
    /**
     * Validate and consume a pairing code, returning the {@link PairingCodeClaims}
     * it was minted with. Throws {@link PairingCodeInvalidError} if the code is
     * unknown, expired, or already used — callers (the HTTP handler) map that to
     * a 401. Single-use is what makes the caller's "redeem, then register the
     * device row with these claims" sequence safe: a second redeem of the same
     * code can never reach the registration step at all.
     */
    redeemPairingCode(code: string): PairingCodeClaims;
    /**
     * Bind a code to one exact pairing request, returning any completion that a
     * prior response/token failure left recoverable. This mutation is entirely
     * synchronous: the HTTP route cannot yield between binding, registration,
     * and completion recording, so concurrent requests have one winner.
     */
    beginPairingAttempt(code: string, binding: PairingAttemptBinding): {
        claims: PairingCodeClaims;
        completion?: PairingCompletion;
    };
    /** Record the one device identity a bound pairing attempt completed as. */
    completePairingAttempt(code: string, binding: PairingAttemptBinding, completion: PairingCompletion): PairingCompletion;
}
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
// ==== @byok-sdk/server dist/sqlite-blob-store.d.ts ====
import type { DatabaseSync } from 'node:sqlite';
import { type BlobStore, type CreateUploadInput, type ReadContentResult, type WriteContentResult } from './blob-store';
import type { TenantId } from './auth';
export interface SqliteBlobStoreOptions {
    /**
     * Database file path. Use `:memory:` to exercise the SQLite code path
     * without persistence — defeats this store's whole purpose (same caveat
     * as `SqliteTaskStore`'s `:memory:` option); real restart-safety requires
     * a real file path.
     */
    path: string;
    /** How long a presigned upload/download URL stays valid, ms. Default 15 minutes — same default as `LocalDiskBlobStore`. */
    urlTtlMs?: number;
    /**
     * HMAC signing key for presigned URLs. Defaults to a key generated once
     * and persisted in this same database (a `meta` table) — so, unlike
     * `LocalDiskBlobStore`'s fresh-per-instance `randomBytes(32)` (fine there
     * only because its metadata doesn't survive a restart either), the
     * default here is *already* stable across restarts: a URL signed by one
     * process instance still verifies against a later instance pointed at
     * the same database file. Pass this explicitly only if the key needs to
     * live outside the database (e.g. shared across multiple database files,
     * or rotated independently of the data).
     */
    signingKey?: Buffer;
}
/** Exported (only) so `sqlite-blob-store.test.ts` can apply the same schema to a raw `DatabaseSync` connection when testing {@link loadOrCreateSigningSecret}'s concurrency behavior directly. */
export declare const SCHEMA = "\nCREATE TABLE IF NOT EXISTS meta (\n  key   TEXT PRIMARY KEY,\n  value TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS blobs (\n  blob_id      TEXT PRIMARY KEY,\n  tenant_id    TEXT NOT NULL,\n  size         INTEGER NOT NULL,\n  content_type TEXT NOT NULL,\n  content_hash TEXT NOT NULL,\n  uploaded     INTEGER NOT NULL DEFAULT 0,\n  data         BLOB\n);\n";
/**
 * Atomically load the persisted HMAC signing secret from `db`'s `meta`
 * table, generating and persisting one if none exists yet.
 *
 * Safe under two `DatabaseSync` connections racing on the same file — e.g.
 * two fresh `SqliteBlobStore` instances constructed against a brand-new
 * database at nearly the same moment. Both may see no existing row (via the
 * initial `SELECT`) and both generate a candidate secret, but `INSERT OR
 * IGNORE` guarantees at most one candidate is ever persisted, and —
 * critically — EVERY caller unconditionally re-reads the row afterward and
 * returns THAT value, never its own locally-generated candidate. Without
 * that re-read (the bug this fixes: the previous implementation used
 * `INSERT OR REPLACE` and returned its own candidate unconditionally), a
 * caller whose candidate lost the race would keep using its own discarded
 * value in memory — so a presigned URL it signs would fail to verify
 * against any other instance, which persisted (and uses) the winning value.
 *
 * `generateCandidate` defaults to `randomBytes(32)`; overridable so
 * `sqlite-blob-store.test.ts` can deterministically force the race window —
 * real callers never need to pass it.
 */
export declare function loadOrCreateSigningSecret(db: DatabaseSync, generateCandidate?: () => Buffer): Buffer;
/**
 * Persistent {@link BlobStore} backed by `node:sqlite` — no native
 * dependency, same rationale as `SqliteTaskStore` (`sqlite-support.ts`).
 * Metadata AND content bytes both live in the same database file (a `data
 * BLOB` column), so a fresh instance pointed at the same file recovers
 * everything: declared blobs, upload state, and the bytes themselves,
 * byte-for-byte.
 *
 * Presigned URLs use the same HMAC-signed-query-param scheme as
 * `LocalDiskBlobStore` (`/byok/blobs/:id/content?sig=...&exp=...`, verified
 * generically by `http.ts` via {@link verifySignedUrl} regardless of which
 * `BlobStore` is plugged in) — the only difference is where the signing
 * secret comes from; see {@link SqliteBlobStoreOptions.signingKey}.
 *
 * Requires Node.js 22.5+ (`node:sqlite`'s minimum); constructing this on an
 * unsupported runtime throws `SqliteUnavailableError` (`sqlite-support.ts`).
 */
export declare class SqliteBlobStore implements BlobStore {
    private readonly db;
    private readonly urlTtlMs;
    private readonly secret;
    private readonly insertBlobStmt;
    private readonly selectBlobStmt;
    private readonly selectUploadedStmt;
    private readonly writeContentStmt;
    private closed;
    constructor(opts: SqliteBlobStoreOptions);
    createUpload(tenantId: TenantId, input: CreateUploadInput, requestedBlobId?: string): Promise<{
        blobId: string;
        uploadUrl: string;
    }>;
    getDownloadUrl(tenantId: TenantId, blobId: string): Promise<string | undefined>;
    exists(tenantId: TenantId, blobId: string): Promise<boolean>;
    getUploadReservation(blobId: string): Promise<{
        size: number;
    } | undefined>;
    verifySignedUrl(blobId: string, action: 'put' | 'get', sig: string, exp: number): boolean;
    writeContent(blobId: string, data: Buffer): Promise<WriteContentResult>;
    readContent(blobId: string): Promise<ReadContentResult | undefined>;
    /** Close the underlying database connection — see `SqliteTaskStore.close`'s doc comment; same rationale. */
    close(): void;
    private computeSig;
    private signUrl;
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
// ==== @byok-sdk/server dist/sqlite-task-store.d.ts ====
import { type TaskState } from '@byok-sdk/protocol';
import type { DatabaseSync } from 'node:sqlite';
import { type CreateTaskInput, type TaskRecord, type TaskStore } from './task-store';
export interface SqliteTaskStoreOptions {
    /**
     * Database file path. Use `:memory:` to exercise the SQLite code path
     * without a temp file (e.g. schema/query correctness tests) — but note
     * that defeats the entire point of this store (restart-safety), since an
     * in-memory SQLite database vanishes with the process exactly like
     * `InMemoryTaskStore` does. Real persistence requires a real file path.
     */
    path: string;
}
/**
 * S5 hardening: two processes (or two `SqliteTaskStore` instances in this
 * one) can both construct against the same pre-existing file at close to the
 * same instant, both see a given column missing via the `PRAGMA table_info`
 * read below, and both attempt the same `ALTER TABLE ... ADD COLUMN` —
 * SQLite allows only one to actually add it; the loser's `db.exec` throws
 * `duplicate column name`. That failure means the OTHER writer already won —
 * the column now genuinely exists, which is exactly the end state this
 * function is trying to reach — so it's caught here, the column list is
 * re-inspected fresh, and this function proceeds normally (no throw) once
 * confirmed. Anything else (a real schema problem, a disk error, a
 * `duplicate column name` for a DIFFERENT column than expected) is rethrown
 * unchanged — this only swallows the exact race this is written for.
 *
 * Exported only for this package's own tests to exercise the race
 * deterministically (mirrors `sqlite-support.ts`'s
 * `isSqliteCapableNodeVersion` convention) — not re-exported from
 * `index.ts`, so not part of the public package API.
 */
export declare function ensureAdditiveColumns(db: DatabaseSync): void;
/**
 * Persistent {@link TaskStore} backed by the Node.js built-in `node:sqlite`
 * module — no native dependency (`sqlite-support.ts`'s doc comment explains
 * why that's a hard requirement here). A fresh instance pointed at the same
 * database file recovers every task's full RECORD (instruction, policy,
 * device/session refs, result) exactly as `InMemoryTaskStore` would have
 * held it in memory — this is the M3 "task records survive a process
 * restart" story.
 *
 * Scope of that claim, precisely: this is RECORD persistence, not live
 * active-task recovery. A fresh `ConnectionHub` (`hub.ts`) wired to a
 * reopened store starts with empty runtimes/result-promises/event-queues/
 * device-registry/outboxes — so a task that was `Running` at restart comes
 * back as a `Running` *record* you can read and further `transition()`, not
 * as a task with its device/runtime connection reattached that will go on
 * to actually produce more events. Recovering/resuming an in-flight task's
 * live connection is a larger feature and out of scope here.
 *
 * Every write goes through a compare-and-set `UPDATE ... WHERE task_id = ?
 * AND state = ?` (the state {@link transition} just validated against), not
 * an unconditional update: two connections racing on the same task (both
 * reading e.g. `Running`, both independently validating a different target
 * state) can't both commit, which would otherwise let the later write
 * silently perform an illegal transition — including terminal -> terminal —
 * that neither validation call would have allowed had it seen the other's
 * write first. A lost compare-and-set re-reads the row and either
 * re-validates the requested move against the state that actually won, or
 * throws {@link IllegalTaskTransitionError} against it.
 *
 * Requires Node.js 22.5+ (`node:sqlite`'s minimum); constructing this on an
 * older/unsupported runtime throws `SqliteUnavailableError`
 * (`sqlite-support.ts`) with a clear message rather than a cryptic "Cannot
 * find module" trace.
 *
 * Enforces the exact same `TASK_TRANSITIONS`/`canTransition` state machine
 * as `InMemoryTaskStore`, via the same {@link IllegalTaskTransitionError}.
 */
export declare class SqliteTaskStore implements TaskStore {
    private readonly db;
    private readonly insertStmt;
    private readonly updateStmt;
    private readonly selectStmt;
    private readonly selectAllStmt;
    private readonly updatePendingApprovalIdStmt;
    private closed;
    constructor(opts: SqliteTaskStoreOptions);
    create(input: CreateTaskInput): TaskRecord;
    get(taskId: string): TaskRecord | undefined;
    list(): TaskRecord[];
    /**
     * Apply `taskId`'s state -> `to`, merging `patch` into the record. Throws
     * {@link IllegalTaskTransitionError} if the move isn't legal per
     * `TASK_TRANSITIONS`, and if the task doesn't exist at all — identical
     * contract and error shapes to `InMemoryTaskStore.transition`.
     *
     * Implemented as a compare-and-set retry loop rather than a single
     * read-validate-write, because two separate connections (two processes,
     * or two `SqliteTaskStore` instances in this one) can both read the same
     * current state and both validate a move against it before either writes.
     * An unconditional `UPDATE` would let whichever commits last silently win
     * — including an illegal terminal -> terminal transition neither
     * validation call would have allowed with up-to-date information. Each
     * iteration here reads the CURRENT state fresh, validates `to` against
     * it, then writes with `WHERE state = <the state just validated>`
     * (`updateStmt`). If zero rows changed, some other writer committed
     * between this read and this write, so the loop re-reads and either
     * re-validates `to` against whatever the state actually is now, or throws
     * {@link IllegalTaskTransitionError} against it — the same outcome a
     * caller would get if it happened to run a moment later.
     */
    transition(taskId: string, to: TaskState, patch?: Partial<Omit<TaskRecord, 'taskId' | 'state'>>): TaskRecord;
    /**
     * See {@link TaskStore.setPendingApprovalId}'s own doc comment for the
     * full rationale, and `updatePendingApprovalIdStmt`'s own doc comment
     * (constructor, above) for the S3 CAS-guard rationale. The guarded
     * statement affecting 0 rows means `taskId` is no longer `AwaitApproval`
     * (or vanished) as of the write — a legitimate no-op, not an error: this
     * method never throws for a state mismatch (best-effort bookkeeping, same
     * as its unconditional pre-S3 form). Returns a FRESH read in that case
     * rather than the caller's now-stale pre-write snapshot, so a caller sees
     * what's actually stored.
     */
    setPendingApprovalId(taskId: string, pendingApprovalId: string | undefined): TaskRecord | undefined;
    /**
     * Close the underlying database connection. Not part of the `TaskStore`
     * interface (an in-memory store has nothing to close) — call this
     * explicitly when a store instance is done, e.g. before opening a second
     * instance against the same file, or on process shutdown.
     */
    close(): void;
}
// ==== @byok-sdk/server dist/task-store.d.ts ====
import { type AgentRef, type PermissionPolicy, type RuntimeId, type TaskState, type ToolsetId } from '@byok-sdk/protocol';
import type { TaskSnapshot } from './types';
/** Thrown by a {@link TaskStore}'s `transition` when `from -> to` is not in TASK_TRANSITIONS. Every implementation (in-memory, SQLite, or otherwise) must throw this rather than silently applying an invalid move. */
export declare class IllegalTaskTransitionError extends Error {
    readonly taskId: string;
    readonly from: TaskState;
    readonly to: TaskState;
    constructor(taskId: string, from: TaskState, to: TaskState);
}
export interface CreateTaskInput {
    taskId: string;
    instruction: string;
    runtime?: RuntimeId;
    policy: PermissionPolicy;
    requiredToolsets?: ToolsetId[];
    deviceId?: string;
    sessionRef?: string;
    agentRef?: AgentRef;
}
/** A task's full persisted state, as tracked by any {@link TaskStore} implementation. Same shape as {@link TaskSnapshot} — kept as its own (structurally identical) type so this storage-layer contract can evolve independently of the SDK-facing `TaskSnapshot` if a future need arises. */
export interface TaskRecord extends TaskSnapshot {
}
/**
 * Storage contract for task records — the M3 injection point, mirroring how
 * {@link BlobStore} (`blob-store.ts`) is injectable: `createByokServer`
 * (`index.ts`) accepts `opts.taskStore`, defaulting to {@link InMemoryTaskStore}
 * so nothing breaks for an embedder that doesn't override it. `ConnectionHub`
 * (`hub.ts`) is written against this interface only — it never references
 * {@link InMemoryTaskStore} (or any other concrete implementation) directly —
 * so a persistent implementation such as `sqlite-task-store.ts`'s
 * `SqliteTaskStore` (M3) drops in with zero changes anywhere else.
 *
 * Every implementation MUST enforce the protocol's `TASK_TRANSITIONS` state
 * machine (via `canTransition`) inside `transition`, throwing
 * {@link IllegalTaskTransitionError} rather than silently applying an
 * invalid move — this is part of the interface's contract, not just an
 * `InMemoryTaskStore` implementation detail. `ConnectionHub`'s `applyOrFail`
 * (`hub.ts`) relies on that exception type to decide "illegal transition ->
 * force `Failed` if possible, else drop".
 */
export interface TaskStore {
    /** Create a new task record in the `Offered` state. */
    create(input: CreateTaskInput): TaskRecord;
    /** Look up a task by id, or `undefined` if unknown. */
    get(taskId: string): TaskRecord | undefined;
    /** All known tasks. */
    list(): TaskRecord[];
    /**
     * Apply `taskId`'s state -> `to`, merging `patch` into the record. Must
     * throw {@link IllegalTaskTransitionError} if the move isn't legal per
     * `TASK_TRANSITIONS`, and a plain `Error` (message: `` `unknown taskId:
     * ${taskId}` ``) if the task doesn't exist at all —
     * {@link InMemoryTaskStore.transition}'s existing message format, which
     * some tests match on.
     */
    transition(taskId: string, to: TaskState, patch?: Partial<Omit<TaskRecord, 'taskId' | 'state'>>): TaskRecord;
    /**
     * M5 (approval targeting): update `taskId`'s `pendingApprovalId` WITHOUT a
     * state transition. Needed because `AwaitApproval -> AwaitApproval` is
     * deliberately not a legal `TASK_TRANSITIONS` edge (`@byok-sdk/protocol`'s
     * `task-state.ts`) — self-transitions aren't part of the frozen wire state
     * machine, so `transition` above cannot be used to update this field while
     * the record STAYS in `AwaitApproval` — yet a re-sent/updated
     * `task.await_approval` carrying a NEWER id while the record is ALREADY
     * `AwaitApproval` must still be reflected (see `ConnectionHub.
     * onAwaitApproval`, `hub.ts`). Every state-CHANGING write still goes
     * through `transition`; this is the one narrow exception for a same-state
     * field update. Returns `undefined` for an unknown `taskId` rather than
     * throwing — this is a best-effort bookkeeping update, not a
     * state-machine-enforced operation like `transition`.
     *
     * OPTIONAL: a `TaskStore` implementation predating M5 (a custom embedder
     * store written against the pre-M5 interface) doesn't have this method at
     * all — every call site in `hub.ts` guards its absence with `?.()`. A
     * store that omits it simply never records a superseding
     * `pendingApprovalId` on the same-state redelivery path (the first entry
     * into `AwaitApproval` still records one via `transition`'s own patch,
     * same as ever); an operator-supplied `opts.approvalId` on
     * `approveTask`/`rejectTask` then has nothing recorded to compare against
     * and proceeds untargeted, exactly like a legacy daemon that never
     * reported an id at all — a graceful degrade, not a broken embedder.
     * Every CURRENT implementation in this package ({@link InMemoryTaskStore},
     * `sqlite-task-store.ts`'s `SqliteTaskStore`) still implements it as a
     * required, always-present method — optionality is a concession to
     * EXISTING third-party implementations of this interface, not a hint that
     * a new one should skip it.
     */
    setPendingApprovalId?(taskId: string, pendingApprovalId: string | undefined): TaskRecord | undefined;
}
/**
 * Plain, framework-agnostic in-memory {@link TaskStore}. Enforces the
 * protocol's `TASK_TRANSITIONS` state machine via `canTransition` — every
 * state change must go through {@link transition}, which throws
 * {@link IllegalTaskTransitionError} rather than silently applying an invalid
 * move. Callers (the connection hub) decide what to do with that error; see
 * `hub.ts`'s `applyOrFail` for the "illegal transition -> force Failed if
 * possible, else drop" policy.
 *
 * M0/M1/M2 reference default — loses all state on process restart. See
 * `sqlite-task-store.ts`'s `SqliteTaskStore` (M3) for a persistent
 * alternative implementing the same {@link TaskStore} contract.
 */
export declare class InMemoryTaskStore implements TaskStore {
    private readonly tasks;
    create(input: CreateTaskInput): TaskRecord;
    get(taskId: string): TaskRecord | undefined;
    list(): TaskRecord[];
    /**
     * Apply `taskId`'s state -> `to`, merging `patch` into the record. Throws
     * {@link IllegalTaskTransitionError} if the move isn't legal per
     * `TASK_TRANSITIONS`, and if the task doesn't exist at all.
     */
    transition(taskId: string, to: TaskState, patch?: Partial<Omit<TaskRecord, 'taskId' | 'state'>>): TaskRecord;
    /**
     * See {@link TaskStore.setPendingApprovalId}'s own doc comment for the
     * full rationale. State-guarded (S3 hardening): a write only applies while
     * `taskId` is still `AwaitApproval` — mirrors `SqliteTaskStore`'s own `AND
     * state = 'AwaitApproval'` CAS predicate (`sqlite-task-store.ts`) for
     * symmetry between the two reference implementations, guarding against a
     * laggard caller resurrecting a pending id after the task already left
     * `AwaitApproval` (e.g. a queued/delayed `task.await_approval` processed
     * after a real `approveTask`/`rejectTask` already transitioned it
     * elsewhere). A non-matching call is a no-op: returns the record exactly
     * as it currently stands, not the caller's requested (rejected) value.
     */
    setPendingApprovalId(taskId: string, pendingApprovalId: string | undefined): TaskRecord | undefined;
}
// ==== @byok-sdk/server dist/types.d.ts ====
import type { AgentContentReadPayload, AgentHomeProjectionPayload, AgentHomeProjectionReadback, AgentEventOrUnknown, AgentEgressPolicy, AgentEgressReliablePayload, AgentMessageEgressRequirement, AgentMessageServerContext, AgentMessagePublishPayload, AgentRef, BlobRef, DispatchSelection, PermissionPolicy, RuntimeCapabilities, RuntimeId, RuntimeInfo, TaskApprovalResolvedPayload, TaskArtifactPayload, TaskState, ToolsetId, TerminalProjectionSelection } from '@byok-sdk/protocol';
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
    /** Deadline for one authenticated socket to present a valid `conn.hello`. Default 5s. */
    webSocketHelloTimeoutMs?: number;
    /** Global cap for authenticated sockets that have not completed `conn.hello`. Default 32. */
    maxPendingWebSockets?: number;
    /** Maximum inbound WS message bytes before envelope decoding. Default accommodates the largest protocol document envelope. */
    maxWebSocketPayloadBytes?: number;
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
    /** Product-owned, authenticated task destination consumer. */
    agentMessage?: {
        consume(input: {
            readonly deviceId: string;
            readonly taskId: string;
            readonly context: AgentMessageServerContext;
            readonly payload: AgentMessagePublishPayload;
        }): {
            readonly outcome: 'accepted' | 'held' | 'refused';
            readonly reasonCode?: string;
        };
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
     * Persisted WITH `summary`/`artifactRefs` rather than beside them: the
     * whole `TaskResult` is stored as a single `result_json` document
     * (`sqlite-task-store.ts`), so this field reaches durable storage with
     * exact parity and introduces no second authority for it.
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
     * pre-M5). Thin wrapper over `ConnectionHub.approveTask` (`hub.ts`) — see
     * that method's own doc comment for the full targeting/staleness
     * semantics, including when this throws `StaleApprovalError` (exported
     * from the package index for a caller to catch/inspect).
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
/** Snapshot of a task as tracked by the in-memory {@link TaskStore}. */
export interface TaskSnapshot {
    taskId: string;
    state: TaskState;
    instruction: string;
    /**
     * The REQUESTED runtime — `DispatchInput.runtime`, forwarded verbatim into
     * `task.offer.runtime`. Set once at `dispatch()` time and never touched
     * again afterward, regardless of what the daemon actually ends up running.
     * `undefined` means "no preference was expressed" (the daemon auto-selects,
     * pi-first) — NOT "the daemon ran no runtime". Contrast with
     * {@link claimedRuntime}, the ACTUAL runtime the daemon reports having
     * picked; see that field's own doc comment for the full requested-vs-
     * claimed distinction (docs/protocol.md §3.1).
     */
    runtime?: RuntimeId;
    policy: PermissionPolicy;
    requiredToolsets?: ToolsetId[];
    deviceId?: string;
    sessionRef?: string;
    /** Exact Agent identity for an Agent-bound task; absent for legacy tasks. */
    agentRef?: AgentRef;
    createdAt: string;
    updatedAt: string;
    result?: TaskResult;
    /**
     * M5 (approval targeting, docs/protocol.md §5.3): the daemon-reported
     * `approvalId` for the CURRENT `AwaitApproval` cycle, if this server has
     * learned one (`ConnectionHub.onAwaitApproval`, `hub.ts`) — `undefined`
     * whenever the task isn't currently awaiting approval, OR it is but no id
     * was ever reported for it (a legacy daemon). Cleared centrally the
     * instant the task LEAVES `AwaitApproval` (`ConnectionHub`'s
     * `transitionTask`), so a later `AwaitApproval` cycle for the same task
     * never inherits a stale id from a previous one. `approveTask`/
     * `rejectTask` compare an operator-supplied target id against this field
     * to decide whether a decision is stale (`StaleApprovalError`) — see
     * `hub.ts` for the full mechanism.
     */
    pendingApprovalId?: string;
    /**
     * M5 (claimed runtime, docs/protocol.md §3.1): the ACTUAL adapter the
     * daemon reports having selected for this task (`task.claim.runtime`,
     * `ConnectionHub.onClaim` — `hub.ts`) — covers both the explicit-runtime
     * path (echoes {@link runtime}) and the auto-select/pi-first path (a value
     * where {@link runtime} is `undefined`, since no preference was ever
     * requested). `undefined` until the first `task.claim` for this task
     * arrives, and forever after for a legacy daemon that predates this field
     * (an old daemon's `task.claim` simply omits it). Set exactly once, at the
     * `Offered -> Claimed` transition, and never modified again afterward — a
     * retried/idempotent claim from the same device is a no-op that never
     * reaches `onClaim`'s patch at all (see `onClaim`'s own doc comment), so
     * this can never be silently overwritten by a redelivered claim.
     */
    claimedRuntime?: RuntimeId;
    /**
     * S0/D-4 (runtime-honest control surface): the capability block the
     * CLAIMING adapter reported for itself on its own `task.claim`
     * (`TaskClaimPayload.capabilities`, `@byok-sdk/protocol`), snapshotted at the
     * exact moment of the `Offered -> Claimed` transition
     * (`ConnectionHub.onClaim`, `hub.ts`).
     *
     * Sourced from the claim and from nothing else. The connection-level
     * `conn.hello.runtimes[].capabilities` is discovery data — it describes a
     * device rather than the adapter that claimed this task — so it is never
     * read here or by the gate; see
     * `SteerRejectedError` (`hub.ts`) for the full argument.
     *
     * A SNAPSHOT, deliberately — not a live read of anything: the same device
     * can reconnect later with a different adapter set (a runtime upgraded,
     * removed, or newly installed mid-task), and a task that is already running
     * must keep being judged against what was true when it was claimed.
     * `ConnectionHub.steerTask` is the consumer: it fails closed with a
     * `SteerRejectedError` (`hub.ts`) unless this snapshot says `steer === true`,
     * BEFORE any `task.steer` envelope exists.
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
 * Cross-cutting server event feed (device connects/disconnects, task
 * creation/state changes) — the "event hub" from the plan's 服务端参考实现
 * section, as opposed to `TaskHandle.events()` which is scoped to one task.
 * Not part of the pinned wire contract; a server-embedder-facing convenience.
 */
export type ByokServerEvent = {
    kind: 'device.connected';
    deviceId: string;
    at: string;
} | {
    kind: 'device.disconnected';
    deviceId: string;
    at: string;
} | {
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
 | {
    kind: 'task.approval_resolved_implicit';
    taskId: string;
    at: string;
}
/**
 * M4 (additive-minor): the EXPLICIT counterpart to
 * `task.approval_resolved_implicit` above — fires when the daemon reports
 * a locally-resolved approval via the wire `task.approval_resolved`
 * message (`ConnectionHub.onApprovalResolved`, `hub.ts`) rather than the
 * server having to infer it from later task traffic. Carries the same
 * `approvalId`/`decision`/`resolvedBy` the daemon reported, so an embedder
 * can render/audit exactly what was resolved and by which path, not just
 * that a resolution happened. `resolvedBy` is currently always `'local'`
 * (`@byok-sdk/protocol`'s `TaskApprovalResolvedPayloadSchema` — a single-value
 * enum today, future-proofed for an additional value later without a
 * version bump). Mutually exclusive with `task.approval_resolved_implicit`
 * for the same resolution: whichever mechanism the server processes first
 * performs the actual `AwaitApproval -> Running` transition, and the other
 * is already a no-op by the time it would otherwise run — see
 * `onApprovalResolved`'s own doc comment (`hub.ts`) for the full
 * relationship.
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
     * always decided by field presence on the specific message). `false`
     * for a legacy daemon, or one whose connection capabilities this hub
     * never recorded (see `ConnectionHub.getDeviceCapabilities`).
     */
    targeted: boolean;
} & Pick<TaskApprovalResolvedPayload, 'approvalId' | 'decision' | 'resolvedBy'>)
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
 | {
    kind: 'device.rate_limited';
    deviceId: string;
    at: string;
};
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
