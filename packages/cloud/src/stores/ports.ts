/**
 * The cloud-local store ports.
 *
 * `@byok-sdk/core` owns the platform ports every composition shares (mailbox,
 * board, truth, objects, quota). These are the ones only a HOSTED device
 * surface needs — the auth plane and the task-attempt bookkeeping the device
 * routes read. S2 deliberately kept them out of core: they are hosted-surface
 * concerns, and S4A's schema work is the right moment to decide their durable
 * home. Cloud owning them keeps this slice additive and revertible.
 *
 * Two rules, same as core's (`stores.ts`):
 *
 * 1. **Async.** Every method returns a `Promise`, so a SQL or KV composition
 *    can implement the same contract the in-memory reference does.
 * 2. **Tenant-first.** Every method's first parameter is a required
 *    `TenantId` — with exactly two documented exceptions below, each of
 *    which is pre-tenant *by construction* because the credential it is
 *    handed is itself what resolves the tenant.
 *
 * The two exceptions:
 *
 * - {@link DeviceDirectory.resolveByDeviceId} — `POST /byok/challenge` and
 *   `POST /byok/token` carry only a deviceId (the pinned wire contract), and
 *   the row is what tells the deployment which tenant to mint for.
 * - {@link PairingCodeStore.redeem} — the code IS the tenant lookup; it was
 *   minted against a tenant that only the host's control plane knew.
 *
 * Neither is reachable through {@link TenantStores} (see `tenant-stores.ts`),
 * so a device-facing handler cannot call them.
 *
 * The byte-proxy trio that used to be a third pre-tenant exception is no
 * longer part of this bundle at all: it moved to {@link BlobContentProxy},
 * an OPTIONAL composition input rather than a {@link CloudStores} member,
 * because a composition backed by object storage physically cannot proxy
 * bytes (see the blobs section below).
 */
import type { StorageReservation, TenantId } from '@byok-sdk/core';

// ---------------------------------------------------------------------------
// Device directory (S1's `DeviceRegistry`, tenant-first)
// ---------------------------------------------------------------------------

export interface DeviceRecord {
  readonly tenantId: TenantId;
  readonly productId: string;
  readonly deviceId: string;
  readonly deviceName: string;
  /** Ed25519 public key, base64url-encoded (JWK `x` form). */
  readonly devicePublicKey: string;
  /** Proof key identity stored on the row; verifier claims never supply a default. */
  readonly proofKeyId: string;
  /** Current proof signing-key rotation generation. */
  readonly proofKeyEpoch: number;
  readonly revoked: boolean;
}

/** Everything `POST /byok/pair` knows at registration time. `tenantId` is the store's first parameter; `revoked` is the store's own to set. */
export interface DeviceRegistration {
  readonly productId: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly devicePublicKey: string;
  readonly proofKeyId: string;
  readonly proofKeyEpoch: number;
}

export interface DeviceDirectory {
  register(tenant: TenantId, input: DeviceRegistration): Promise<DeviceRecord>;
  /** The row `tenant` owns under `deviceId` — `undefined` including when the device exists under a DIFFERENT tenant. */
  get(tenant: TenantId, deviceId: string): Promise<DeviceRecord | undefined>;
  revoke(tenant: TenantId, deviceId: string): Promise<void>;
  list(tenant: TenantId): Promise<readonly DeviceRecord[]>;
  /** Pre-tenant. Two callers only: `POST /byok/challenge` and `POST /byok/token`. Never exposed through the tenant facade. */
  resolveByDeviceId(deviceId: string): Promise<DeviceRecord | undefined>;
}

// ---------------------------------------------------------------------------
// Pairing codes (S1's `PairingManager`, tenant-first mint)
// ---------------------------------------------------------------------------

/**
 * The identity a pairing code carries. Minted out-of-band by the host's own
 * auth/device-flow UI — the only party that knows which tenant a human is
 * acting for. Deliberately NOT a wire field: `PairRequest` has no tenant of
 * its own, so a device can never name the tenant it lands in.
 */
export interface PairingCodeClaims {
  readonly tenantId: TenantId;
  readonly productId: string;
}

export interface PairingCodeInfo {
  readonly code: string;
  /** Canonical ISO-8601 UTC instant. */
  readonly expiresAt: string;
}

export interface PairingCodeIssueInput {
  readonly code: string;
  readonly productId: string;
  readonly expiresAt: string;
}

export interface PairingCodeStore {
  issue(tenant: TenantId, input: PairingCodeIssueInput): Promise<PairingCodeInfo>;
  /**
   * Validate and CONSUME a code, returning the claims it was minted with, or
   * `undefined` when it is unknown, expired, or already used — one answer for
   * all three, so a redeem attempt is never an existence oracle. Single-use is
   * what makes the caller's "redeem, then register the device row" sequence
   * exclusive: a second redeem can never reach the registration step.
   */
  redeem(code: string): Promise<PairingCodeClaims | undefined>;
}

// ---------------------------------------------------------------------------
// Challenge nonces
// ---------------------------------------------------------------------------

export interface NonceStore {
  issue(tenant: TenantId, deviceId: string): Promise<string>;
  /** `true` iff the nonce exists for this (tenant, device), is unexpired, and has not been consumed. Never mutates. */
  validate(tenant: TenantId, deviceId: string, nonce: string): Promise<boolean>;
  /** Consume the nonce. Called only after every other check on the request has passed. */
  markUsed(tenant: TenantId, nonce: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Inbound envelope dedup (N3)
// ---------------------------------------------------------------------------

export interface InboundDedupStore {
  /**
   * `true` when `envelopeId` was already seen for this (tenant, device);
   * otherwise records it and returns `false`. Bounded per device — the wire is
   * at-least-once (§9); this makes processing at-most-once without an
   * unbounded set.
   */
  checkAndRecord(tenant: TenantId, deviceId: string, envelopeId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Task attempts — the ownership authority the inbound gate reads (N2)
// ---------------------------------------------------------------------------

export const TASK_ATTEMPT_STATUSES = [
  'offered',
  'claimed',
  'running',
  'complete',
  'failed',
  'cancelled',
] as const;
export type TaskAttemptStatus = (typeof TASK_ATTEMPT_STATUSES)[number];

export interface TaskAttempt {
  readonly tenantId: TenantId;
  readonly taskId: string;
  /** The device the offer was addressed to. */
  readonly deviceId: string;
  /** Set by `task.claim`, and only by the first one. Until then the task has no owner and the gate lets any of this tenant's devices through, matching the reference server. */
  readonly ownerDeviceId?: string;
  readonly status: TaskAttemptStatus;
  readonly updatedAt: string;
}

export interface TaskAttemptStore {
  /** Called when an offer is enqueued: records the pending attempt with no owner yet. */
  open(tenant: TenantId, input: { readonly taskId: string; readonly deviceId: string }): Promise<TaskAttempt>;
  get(tenant: TenantId, taskId: string): Promise<TaskAttempt | undefined>;
  /** First claim wins the ownership; a later claim by the same device is idempotent. No-op (returns `undefined`) for a task this tenant never offered. */
  claim(tenant: TenantId, input: { readonly taskId: string; readonly deviceId: string }): Promise<TaskAttempt | undefined>;
  /** Record a lifecycle transition. No-op (returns `undefined`) for an unknown task — same shape as the reference server's per-type handlers. */
  recordStatus(
    tenant: TenantId,
    input: { readonly taskId: string; readonly status: TaskAttemptStatus },
  ): Promise<TaskAttempt | undefined>;
}

// ---------------------------------------------------------------------------
// Request receipts — the terminal idempotency seam
// ---------------------------------------------------------------------------

export interface RequestReceipt {
  readonly tenantId: TenantId;
  readonly key: string;
  /** Opaque payload the caller recorded — for terminals, the encoded envelope. */
  readonly body: string;
  readonly recordedAt: string;
}

export interface RequestReceiptStore {
  /**
   * Record a receipt under `key`, or return the existing one untouched.
   * `created` is `false` for a replay — the FIRST terminal is the fact
   * (§12.6.4: 不覆写第一份事实), and a retry of the same terminal must not
   * overwrite it.
   */
  record(
    tenant: TenantId,
    input: { readonly key: string; readonly body: string },
  ): Promise<{ readonly receipt: RequestReceipt; readonly created: boolean }>;
  get(tenant: TenantId, key: string): Promise<RequestReceipt | undefined>;
}

// ---------------------------------------------------------------------------
// Device-proof request receipts — request-bound replay authority (S6)
// ---------------------------------------------------------------------------

export interface ProofRequestReceipt {
  readonly tenantId: TenantId;
  readonly deviceId: string;
  readonly requestId: string;
  readonly operation: string;
  readonly resource: string;
  readonly bodySha256: string;
  readonly bodySize: bigint;
  readonly responseStatus: number;
  readonly responseBody: string;
  readonly recordedAt: string;
}

export type ProofRequestReceiptInput = Omit<
  ProofRequestReceipt,
  'tenantId' | 'recordedAt'
>;

/**
 * First-result-wins replay store. The application layer compares every stored
 * binding before returning an exact replay; a reused request id with any
 * different binding is a conflict, never a second write.
 */
export interface ProofRequestReceiptStore {
  record(
    tenant: TenantId,
    input: ProofRequestReceiptInput,
  ): Promise<{ readonly receipt: ProofRequestReceipt; readonly created: boolean }>;
  get(
    tenant: TenantId,
    deviceId: string,
    requestId: string,
  ): Promise<ProofRequestReceipt | undefined>;
}

// ---------------------------------------------------------------------------
// Per-device delivery sequence
// ---------------------------------------------------------------------------

/**
 * The daemon's redelivery cursor is the envelope-level `seq`, which has to be
 * baked into the envelope BEFORE it can be handed to `MailboxStore.append` —
 * the mailbox transports opaque bytes and cannot number an envelope it is
 * being given. So the delivery number is allocated here first, and the
 * enqueue path then asserts the mailbox agreed (`mailbox_seq_mismatch`)
 * rather than letting two counters drift apart silently.
 *
 * A port rather than a counter held by the composition, so no handler-adjacent
 * module carries mutable state (S3.5 boxes 14-15).
 */
export interface DeviceSequenceStore {
  next(tenant: TenantId, deviceId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Blobs (§7)
// ---------------------------------------------------------------------------

export interface BlobDeclaration {
  readonly size: number;
  readonly contentType: string;
  /** Canonical `sha256:<64 lowercase hex>` — the schema rejected anything else before this store sees it. */
  readonly contentHash: string;
}

/** What object-store metadata can actually observe at finalize (ADR-024). */
export interface BlobObservation {
  readonly observedByteSize: bigint;
  readonly observedContentType: string;
}

export type BlobWriteResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface BlobContent {
  readonly data: Uint8Array;
  readonly contentType: string;
}

/**
 * The capability-minting half of blobs: what EVERY composition can honestly
 * provide, whoever holds the bytes.
 *
 * Both methods are tenant-first, and both are reachable through {@link
 * TenantStores}. There is no pre-tenant method left on this port — see
 * {@link BlobContentProxy} for where the other three went and why.
 */
export interface CloudBlobStore {
  /** Mint only from an already-admitted object reservation. */
  createUpload(tenant: TenantId, reservation: StorageReservation): Promise<{ readonly blobId: string; readonly uploadUrl: string }>;
  /** Observe existence/size/type while proving this blob belongs to this reservation. */
  observeUpload(tenant: TenantId, blobId: string, reservation: StorageReservation): Promise<BlobObservation | undefined>;
  /** A presigned GET URL for a blob THIS tenant owns that has finished uploading; `undefined` otherwise — including for another tenant's blob. */
  getDownloadUrl(tenant: TenantId, blobId: string): Promise<string | undefined>;
}

/**
 * The byte-proxying half: an OPTIONAL composition input, not a port.
 *
 * These three serve the two `/byok/blobs/:id/content` routes, which exist
 * because the in-memory and self-hosted compositions have nowhere else to put
 * bytes — cloud has to carry them. A composition whose bytes live in object
 * storage (S3/R2) hands the device a presigned URL to the object store itself
 * and never sees a byte, so it cannot implement these at all.
 *
 * That is why this is a separate interface supplied at composition time rather
 * than a member of {@link CloudStores}: "this deployment cannot proxy bytes"
 * becomes a type-level fact (the proxy is simply absent) instead of three
 * methods that throw. The alternatives were both anti-patterns — a conformance
 * suite that skips three methods for one composition is a subset waiver, and
 * one that asserts a typed rejection proves nothing
 * (docs/researches/s4a-dataplane-design.md §6).
 *
 * All three are pre-tenant by construction: the `/content` routes are
 * presigned, not bearer-authed, so there is no principal in scope at all and
 * the HMAC signature over the blob id is the whole credential. They stay off
 * {@link TenantStores} for the same reason the two exceptions above do.
 *
 * A deployment supplying a proxy must also declare `blobs.contentproxy`
 * (ADR-010): the routes mount on proxy-presence AND declaration, never on
 * either alone.
 */
export interface BlobContentProxy {
  verifySignedUrl(blobId: string, action: 'put' | 'get', sig: string, exp: number): Promise<boolean>;
  writeContent(blobId: string, data: Uint8Array): Promise<BlobWriteResult>;
  readContent(blobId: string): Promise<BlobContent | undefined>;
}

// ---------------------------------------------------------------------------
// Inbound rate limiting (M4 Phase 4 part A's seam)
// ---------------------------------------------------------------------------

/**
 * Step 0 of the inbound gate. S3a ships an allow-all reference (a hosted
 * deployment's real limiter is edge/infra work, not handler work) — what
 * matters now is that the SEAM sits at gate position 0, before the type-allow
 * check, so a flood of garbage-typed envelopes costs the same budget as a
 * flood of well-formed ones once a real limiter is plugged in.
 */
export interface InboundRateLimiter {
  consume(tenant: TenantId, deviceId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// The bundle a composition supplies
// ---------------------------------------------------------------------------

/**
 * All-or-nothing: a composition supplies every port here or it is not a
 * composition. {@link BlobContentProxy} is deliberately absent — it is an
 * optional input to `createByokCloud`, not a port, precisely so that the
 * bundle can stay all-or-nothing while byte proxying stays optional.
 */
export interface CloudStores {
  readonly devices: DeviceDirectory;
  readonly pairingCodes: PairingCodeStore;
  readonly nonces: NonceStore;
  readonly dedup: InboundDedupStore;
  readonly tasks: TaskAttemptStore;
  readonly receipts: RequestReceiptStore;
  readonly proofReceipts: ProofRequestReceiptStore;
  readonly sequence: DeviceSequenceStore;
  readonly blobs: CloudBlobStore;
  readonly rateLimiter: InboundRateLimiter;
}

/** Names of the ports in {@link CloudStores}, in contract order. */
export const CLOUD_STORE_NAMES = [
  'devices',
  'pairingCodes',
  'nonces',
  'dedup',
  'tasks',
  'receipts',
  'proofReceipts',
  'sequence',
  'blobs',
  'rateLimiter',
] as const;

export type CloudStoreName = (typeof CLOUD_STORE_NAMES)[number];
