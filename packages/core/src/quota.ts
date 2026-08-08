/**
 * Tenant storage entitlement, usage, reservation and retention (§12.7.6-12.7.7).
 *
 * The SDK does not know what a plan is. It never sees `free`, `pro`, a price, a
 * currency, or a purchase flow — those belong to the host SaaS. What crosses
 * this boundary is a *numeric, versioned* entitlement the host issues, and the
 * constraint test asserts this file contains no plan-name or price vocabulary.
 * The moment the SDK hardcodes a tier, every host is stuck with the SDK's
 * commercial model.
 *
 * Byte counts are `bigint`. Serialization is a composition concern: JSON has no
 * bigint, so a cloud handler renders them as decimal strings on the wire. Using
 * `number` here would put a silent 2^53 ceiling into a storage quota contract.
 *
 * Reservation exists because Postgres and R2 have no shared transaction
 * (§12.7.7). Every durable write reserves first, uploads second, finalizes
 * third; the invariant `committed + reserved + expected <= hardLimit` is
 * checked under the reservation lock, which is what makes concurrent uploads
 * unable to oversell the tenant.
 */
import type { ContentHash } from './blob';
import type { CoreErrorCode } from './errors';
import type { TenantId } from './tenant';

/**
 * The host-issued numeric entitlement (§12.7.6, verbatim).
 *
 * `version` is monotonic and CAS-checked on write: a delayed control-plane
 * update must not resurrect an older plan over a newer one.
 */
export interface TenantStorageEntitlement {
  tenantId: TenantId;
  version: bigint;
  hardLimitBytes: bigint;
  maxObjectBytes: bigint;
  maxInlineBytes: bigint;
  mailboxLimitBytes: bigint;
  retentionPolicyId: string;
  /** Canonical ISO-8601 UTC instant — see {@link TenantStorageEntitlementInput}. */
  downgradeGraceUntil?: string;
}

/**
 * Measured tenant usage (§12.7.6, verbatim).
 *
 * Carries no `tenantId` because it is always read through a tenant-scoped port
 * call — the tenant is the query, not a field of the answer.
 */
export interface TenantStorageUsage {
  committedObjectBytes: bigint;
  committedInlineBytes: bigint;
  reservedBytes: bigint;
  mailboxBytes: bigint;
  objectCount: bigint;
  updatedAt: string;
}

/** Entitlement write payload. `tenantId` comes from the port's first parameter. */
export interface TenantStorageEntitlementInput {
  readonly version: bigint;
  readonly hardLimitBytes: bigint;
  readonly maxObjectBytes: bigint;
  readonly maxInlineBytes: bigint;
  readonly mailboxLimitBytes: bigint;
  readonly retentionPolicyId: string;
  /**
   * Deadline after which an over-limit tenant is suspended rather than blocked.
   *
   * Must be a **canonical ISO-8601 UTC instant** (`YYYY-MM-DDTHH:mm:ss.sssZ`);
   * anything else is rejected with `timestamp_not_canonical`. The in-memory
   * composition compares this deadline as a string and a SQL composition
   * compares it as a `timestamptz`, and those two agree only on the canonical
   * form — see `time.ts`.
   */
  readonly downgradeGraceUntil?: string;
}

/** Durable write classes a reservation can cover. */
export const STORAGE_WRITE_KINDS = ['object', 'inline'] as const;
export type StorageWriteKind = (typeof STORAGE_WRITE_KINDS)[number];

export const STORAGE_RESERVATION_STATES = [
  'reserved',
  'committed',
  'aborted',
  'expired',
] as const;
export type StorageReservationState = (typeof STORAGE_RESERVATION_STATES)[number];

export interface StorageReservation {
  readonly tenantId: TenantId;
  readonly reservationId: string;
  readonly state: StorageReservationState;
  readonly kind: StorageWriteKind;
  readonly expectedBytes: bigint;
  readonly contentHash: ContentHash;
  readonly contentType: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly settledAt?: string;
}

export interface StorageReservationInput {
  readonly reservationId: string;
  readonly kind: StorageWriteKind;
  readonly expectedBytes: bigint;
  readonly contentHash: ContentHash;
  readonly contentType: string;
  readonly ttlMs: number;
}

/**
 * Finalize payload. Size/type are what the composition observed on the object
 * store, not what the client promised — disagreement is
 * `storage_integrity_mismatch`.
 *
 * Hash identity stays on the reservation as the authenticated daemon's
 * declaration (ADR-024). Object-store HEAD does not independently observe a
 * SHA-256 digest, so accepting one here would turn a copied declaration into a
 * false verification claim.
 */
export interface StorageFinalizeInput {
  readonly reservationId: string;
  readonly observedByteSize: bigint;
  readonly observedContentType: string;
}

export interface StorageFinalizeResult {
  readonly reservation: StorageReservation;
  readonly usage: TenantStorageUsage;
  /**
   * True when this tenant already had the same content hash committed. The
   * reserved bytes are released and nothing is added: same tenant, same hash,
   * counted once (§12.7.6). Cross-tenant sharing never happens — usage is
   * per-tenant even when the bytes are identical.
   */
  readonly deduplicated: boolean;
}

/** Effective write posture derived from entitlement + usage + clock (§12.7.8). */
export const STORAGE_WRITE_POSTURES = ['normal', 'warning', 'blocked', 'suspended'] as const;
export type StorageWritePosture = (typeof STORAGE_WRITE_POSTURES)[number];

export interface StorageStatus {
  readonly entitlement: TenantStorageEntitlement;
  readonly usage: TenantStorageUsage;
  readonly posture: StorageWritePosture;
  /** `committed + reserved` against `hardLimitBytes`, for host UI. */
  readonly availableBytes: bigint;
  readonly graceActive: boolean;
}

/**
 * The five wire-stable storage error codes (§12.7.7). Renaming one is a
 * breaking change for every host that branches on them.
 */
export const STORAGE_ERROR_CODES = [
  'storage_object_too_large',
  'storage_quota_exceeded',
  'storage_reservation_expired',
  'storage_integrity_mismatch',
  'storage_write_suspended',
] as const satisfies readonly CoreErrorCode[];

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

/** HTTP status mapping from §12.7.7. Compositions render these verbatim. */
export const STORAGE_ERROR_HTTP_STATUS = {
  storage_object_too_large: 413,
  storage_quota_exceeded: 507,
  storage_reservation_expired: 409,
  storage_integrity_mismatch: 422,
  storage_write_suspended: 423,
} as const satisfies Record<StorageErrorCode, number>;

export interface MailboxUsageDeltaInput {
  /** Signed. Negative deltas release bytes after retention deletes rows. */
  readonly deltaBytes: bigint;
}

/**
 * Quota port. Tenant-first, async.
 *
 * Raises: `storage_entitlement_missing`,
 * `storage_entitlement_version_conflict` (carries the current entitlement),
 * `storage_reservation_not_found`, and the five wire-stable codes above.
 */
export interface QuotaStore {
  readEntitlement(tenant: TenantId): Promise<TenantStorageEntitlement | undefined>;
  /**
   * Version CAS: a write at or below the stored version is rejected with the
   * current row. Raises `timestamp_not_canonical` when `downgradeGraceUntil` is
   * not a canonical ISO-8601 UTC instant.
   */
  writeEntitlement(
    tenant: TenantId,
    input: TenantStorageEntitlementInput,
  ): Promise<TenantStorageEntitlement>;
  readUsage(tenant: TenantId): Promise<TenantStorageUsage>;
  readStatus(tenant: TenantId): Promise<StorageStatus>;
  /**
   * Atomically checks `committed + reserved + expected <= hardLimitBytes` and,
   * on success, adds `expectedBytes` to `reservedBytes`.
   */
  reserve(tenant: TenantId, input: StorageReservationInput): Promise<StorageReservation>;
  /** Moves reserved bytes to committed after verifying the observed object. */
  finalizeReservation(
    tenant: TenantId,
    input: StorageFinalizeInput,
  ): Promise<StorageFinalizeResult>;
  /** Idempotent release. Already-settled reservations return their settled row. */
  abortReservation(tenant: TenantId, reservationId: string): Promise<StorageReservation>;
  /** Cleanup hook: expires reservations past their TTL and releases their bytes. */
  expireReservations(tenant: TenantId): Promise<readonly StorageReservation[]>;
  /** Mailbox bytes are platform-protection accounting, bounded by `mailboxLimitBytes`. */
  applyMailboxDelta(
    tenant: TenantId,
    input: MailboxUsageDeltaInput,
  ): Promise<TenantStorageUsage>;
}
