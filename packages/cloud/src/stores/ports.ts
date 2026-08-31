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
import type {
  MailboxBody,
  MailboxMessage,
  PresenceStore,
  StorageReservation,
  TenantId,
  TenantReadiness,
} from '@byok-sdk/core';
import type { AgentEgressReliablePayload, AgentRef } from '@byok-sdk/protocol';
export type { AgentEgressReliablePayload, AgentRef } from '@byok-sdk/protocol';
import type { ActivityStore } from '../activity';
import type { ApprovalTimelineStore } from '../approval-timeline';

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
  /**
   * Always `false`. Revocation and machine supersession DELETE the record, so
   * no implementation ever produces a `true` here; the field stays because
   * every auth path reads it and a missing row must fail exactly as a revoked
   * one used to.
   */
  readonly revoked: boolean;
  /**
   * Client-hashed physical machine identity (lowercase hex SHA-256), when the
   * pairing carried one. Absent for every device paired without it — an
   * absent value supersedes nothing, so it is never a filter that silently
   * groups unidentified machines together.
   */
  readonly machineId?: string;
  /**
   * The latest capability snapshot written by an authenticated device
   * handshake. This is deliberately separate from core presence: presence is
   * lossy/TTL-bounded and cannot authorize Agent dispatch.
   */
  readonly capabilities?: readonly string[];
}

/** Everything `POST /byok/pair` knows at registration time. `tenantId` is the store's first parameter; `revoked` is the store's own to set (always `false`). */
export interface DeviceRegistration {
  readonly productId: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly devicePublicKey: string;
  readonly proofKeyId: string;
  readonly proofKeyEpoch: number;
  /**
   * Optional client-hashed physical machine identity from `PairRequest`. When
   * present, `register` DELETES this tenant/product's prior rows carrying the
   * same value — and the device-scoped state those rows were the only reason
   * to keep — before inserting, so one physical machine holds one device row
   * per product. It names no tenant and no product of
   * its own — both still come from the redeemed pairing code's claims — so it
   * can only ever supersede rows the caller already addressed.
   */
  readonly machineId?: string;
}

export interface DeviceDirectory {
  /** Registers the device. With `input.machineId` set this ALSO deletes this tenant/product's prior rows carrying that same machine identity — one physical machine, one row. */
  register(tenant: TenantId, input: DeviceRegistration): Promise<DeviceRecord>;
  /** The row `tenant` owns under `deviceId` — `undefined` including when the device exists under a DIFFERENT tenant. */
  get(tenant: TenantId, deviceId: string): Promise<DeviceRecord | undefined>;
  /**
   * Deletes the registration and the device-scoped state it owned (presence,
   * challenge nonces, assertion-replay entries, inbound dedup) — never the
   * history keyed by the device_id string. A no-op for a device this tenant
   * cannot address. Afterwards every read answers exactly as it does for a
   * device that was never registered.
   *
   * How far the deletion physically reaches is driver-scoped. The durable
   * (Postgres) driver deletes the registration and every dependent
   * device-scoped row in the same transaction, so the state is gone the moment
   * `revoke` resolves. The in-memory reference directory deletes only the
   * registration: its sibling stores are separate maps it does not own, so a
   * presence hint expires on its own `expiresAt` TTL and, until then, is
   * excluded from every projection by the readiness active-device filter
   * (`activeDeviceIds`, built from the surviving rows). The observable contract
   * above holds either way — no read path can see a revoked device.
   */
  revoke(tenant: TenantId, deviceId: string): Promise<void>;
  list(tenant: TenantId): Promise<readonly DeviceRecord[]>;
  /** Set-wise tenant observation. `revokedDeviceCount` is structurally 0 — a revoked device has no row to count. */
  readiness(tenant: TenantId, presence: PresenceStore): Promise<TenantReadiness>;
  /**
   * Persist a capability snapshot obtained from an authenticated device
   * message. Implementations may return `undefined` for an unknown (including
   * revoked, which is the same absence) device; callers must fail closed in
   * that case.
   */
  recordCapabilities(
    tenant: TenantId,
    input: { readonly deviceId: string; readonly capabilities: readonly string[] },
  ): Promise<DeviceRecord | undefined>;
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
  /**
   * Atomically consume a nonce only when it belongs to this exact (tenant,
   * device), is unexpired, and has not already been consumed. Returns `true`
   * for the sole winner; every other case returns `false`.
   */
  consumeIfValid(tenant: TenantId, deviceId: string, nonce: string): Promise<boolean>;
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
  'cancel_requested',
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
  /** Exact Agent identity sealed when the strict Agent offer was opened. */
  readonly agentRef?: AgentRef;
  /** Set by `task.claim`, and only by the first one. Legacy attempts remain claimable by any tenant device until then; strict Agent attempts are target-device bound before this field is consulted. */
  readonly ownerDeviceId?: string;
  readonly status: TaskAttemptStatus;
  /** Runtime-reported terminal cause from the first winning terminal. */
  readonly terminalCause?: string;
  /** Durable host cancellation authority. Its presence outranks later device terminal receipts. */
  readonly cancellation?: {
    readonly requestedAt: string;
    readonly reason?: string;
  };
  readonly updatedAt: string;
}

export interface TaskAttemptStore {
  /** Called when an offer is enqueued: records the pending attempt with no owner yet. */
  open(
    tenant: TenantId,
    input: {
      readonly taskId: string;
      readonly deviceId: string;
      readonly agentRef?: AgentRef;
    },
  ): Promise<TaskAttempt>;
  /**
   * Atomically reserve one strict Agent offer. `created: false` means the task
   * id already had durable authority and no caller may append another offer.
   */
  reserveAgentOffer(
    tenant: TenantId,
    input: {
      readonly taskId: string;
      readonly deviceId: string;
      readonly agentRef: AgentRef;
    },
  ): Promise<{ readonly attempt: TaskAttempt; readonly created: boolean }>;
  get(tenant: TenantId, taskId: string): Promise<TaskAttempt | undefined>;
  /** Batch lookup used by mailbox projection; implementations must not turn one poll into N queries. */
  getMany(tenant: TenantId, taskIds: readonly string[]): Promise<readonly TaskAttempt[]>;
  /** First claim wins the ownership; a later claim by the same device is idempotent. No-op (returns `undefined`) for a task this tenant never offered. */
  claim(tenant: TenantId, input: { readonly taskId: string; readonly deviceId: string }): Promise<TaskAttempt | undefined>;
  /** Record a lifecycle transition. No-op (returns `undefined`) for an unknown task — same shape as the reference server's per-type handlers. */
  recordStatus(
    tenant: TenantId,
    input: {
      readonly taskId: string;
      readonly status: TaskAttemptStatus;
      readonly agentRef?: AgentRef;
      readonly terminalCause?: string;
    },
  ): Promise<TaskAttempt | undefined>;
}

export interface TaskCancellationRequest {
  readonly taskId: string;
  readonly proposedMessageId: string;
  readonly reason?: string;
  readonly materialize: (seq: number, messageId: string) => MailboxBody | Promise<MailboxBody>;
}

export interface TaskCancellationMutation {
  readonly attempt: TaskAttempt;
  /** Absent only when the task was already complete or failed before cancellation. */
  readonly message?: MailboxMessage;
}

/**
 * One atomic authority for the cancellation tombstone plus its durable device
 * delivery. Implementations must commit both or neither.
 */
export interface TaskCancellationStore {
  request(tenant: TenantId, input: TaskCancellationRequest): Promise<TaskCancellationMutation | undefined>;
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
// Reliable Agent egress — durable event and acknowledgement receipt fact
// ---------------------------------------------------------------------------

export interface AgentEgressRecord {
  readonly tenantId: TenantId;
  readonly deviceId: string;
  readonly payload: AgentEgressReliablePayload;
  /** Stable cloud-generated receipt identity echoed on every exact replay. */
  readonly receiptId: string;
  readonly recordedAt: string;
}

export interface AgentEgressStore {
  /** First event-id write wins; callers reject mismatches rather than updating. */
  record(
    tenant: TenantId,
    input: Omit<AgentEgressRecord, 'tenantId' | 'recordedAt'>,
  ): Promise<{ readonly record: AgentEgressRecord; readonly created: boolean }>;
  get(tenant: TenantId, deviceId: string, eventId: string): Promise<AgentEgressRecord | undefined>;
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
 * How a byte-proxying read can fail while the blob itself is known to exist.
 *
 * The split is about WHERE the failure landed relative to the upstream
 * response, because that is the only part a proxy can observe and the only
 * part an operator can act on: `blob_upstream_unavailable` means nothing came
 * back at all (the upstream was unreachable/refused before its response
 * started), so a retry may succeed unchanged; `blob_upstream_stream_interrupted`
 * means the response HAD started and died mid-transfer, so whatever the caller
 * already has is a truncated prefix, not a short blob.
 *
 * Both are 502 on the wire (see `BLOB_READ_ERROR_HTTP_STATUS` in
 * `handlers/blobs.ts`) — the CODE carries the distinction, not the status.
 */
export const BLOB_READ_ERROR_CODES = ['blob_upstream_unavailable', 'blob_upstream_stream_interrupted'] as const;

export type BlobReadErrorCode = (typeof BLOB_READ_ERROR_CODES)[number];

/**
 * The result of {@link BlobContentProxy.readContent}, in the same union idiom
 * as {@link BlobWriteResult}. Note what is NOT in here: not-found stays
 * `undefined` at the method's return type, so "no such blob" keeps its
 * existing 404 meaning and never has to be spelled as a failure code.
 */
export type BlobReadResult =
  | { readonly ok: true; readonly content: BlobContent }
  | { readonly ok: false; readonly code: BlobReadErrorCode };

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
  /** `undefined` = no such blob (404); a `{ok:false}` result = the blob exists but its bytes could not be proxied (502, distinguished by {@link BlobReadErrorCode}). */
  readContent(blobId: string): Promise<BlobReadResult | undefined>;
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
  readonly activity: ActivityStore;
  readonly approvals: ApprovalTimelineStore;
  readonly devices: DeviceDirectory;
  readonly pairingCodes: PairingCodeStore;
  readonly nonces: NonceStore;
  readonly dedup: InboundDedupStore;
  readonly tasks: TaskAttemptStore;
  readonly cancellations: TaskCancellationStore;
  readonly receipts: RequestReceiptStore;
  readonly egress: AgentEgressStore;
  readonly proofReceipts: ProofRequestReceiptStore;
  readonly blobs: CloudBlobStore;
  readonly rateLimiter: InboundRateLimiter;
}

/** Names of every port in {@link CloudStores}, in contract order. */
export const CLOUD_STORE_NAMES = [
  'activity',
  'approvals',
  'devices',
  'pairingCodes',
  'nonces',
  'dedup',
  'tasks',
  'cancellations',
  'receipts',
  'egress',
  'proofReceipts',
  'blobs',
  'rateLimiter',
] as const;

export type CloudStoreName = (typeof CLOUD_STORE_NAMES)[number];
