/**
 * Content addressing and the object manifest (§12.7.4, §12.7.8).
 *
 * This module is **metadata only**. No byte transport, no presigning, no
 * hashing: R2/S3 URL signing and digest computation are composition concerns
 * that need platform crypto, and core stays Node-free. What core owns is the
 * shape everyone must agree on — the hash format, the manifest state machine,
 * and reference counting — so that Postgres, D1, and the in-memory reference
 * cannot disagree about when an object is safe to delete.
 *
 * Object keys are tenant-scoped by construction ({@link tenantObjectKey}).
 * A global `sha256/<hex>` key space would turn object existence into a
 * cross-tenant oracle, which is why §12.7.4 forbids it even though it would
 * deduplicate better.
 */
import { ByokCoreError } from './errors';
import type { TenantId } from './tenant';

/** `sha256:<64 lowercase hex>`. The only content-address form core accepts. */
export const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** A validated content address. Branded so an unvalidated digest cannot stand in for one. */
export type ContentHash = string & { readonly __byokContentHash: unique symbol };

/**
 * The single mint point for {@link ContentHash}.
 *
 * Fail-closed on uppercase hex: accepting both cases would make the same bytes
 * addressable under two keys, which breaks per-tenant deduplication and the
 * "count each hash once" billing rule (§12.7.6).
 *
 * @throws {ByokCoreError} code `content_hash_invalid`.
 */
export function contentHash(value: string): ContentHash {
  if (!CONTENT_HASH_PATTERN.test(value)) {
    throw new ByokCoreError(
      'content_hash_invalid',
      `Content hash must match ${CONTENT_HASH_PATTERN.source}, received ${JSON.stringify(value)}.`,
    );
  }
  return value as ContentHash;
}

/** Non-throwing form of {@link contentHash}. */
export function isContentHash(value: unknown): value is ContentHash {
  return typeof value === 'string' && CONTENT_HASH_PATTERN.test(value);
}

/**
 * Tenant-scoped object key, e.g.
 * `tenants/<tenantId>/objects/sha256/<hex>` (§12.7.4).
 */
export function tenantObjectKey(tenant: TenantId, hash: ContentHash): string {
  const hex = hash.slice('sha256:'.length);
  return `tenants/${tenant as string}/objects/sha256/${hex}`;
}

/**
 * Object manifest lifecycle (§12.7.8).
 *
 * `pending` exists because Postgres and R2 have no shared transaction: the row
 * is written before the bytes land, and only `committed` rows may be referenced
 * by a truth record. `delete_pending` is the tombstone the GC worker drives, so
 * a failed R2 delete is retryable instead of leaving usage silently wrong.
 */
export const OBJECT_STATES = ['pending', 'committed', 'delete_pending', 'deleted'] as const;
export type ObjectState = (typeof OBJECT_STATES)[number];

/** Legal manifest transitions. Anything else raises `object_state_invalid`. */
export const OBJECT_STATE_TRANSITIONS: Readonly<Record<ObjectState, readonly ObjectState[]>> = {
  pending: ['committed', 'delete_pending'],
  committed: ['delete_pending'],
  delete_pending: ['deleted', 'committed'],
  deleted: [],
};

export function isLegalObjectTransition(from: ObjectState, to: ObjectState): boolean {
  return OBJECT_STATE_TRANSITIONS[from].includes(to);
}

/** One row of `object_manifest` (§12.7.6). */
export interface ObjectManifestEntry {
  readonly tenantId: TenantId;
  readonly hash: ContentHash;
  /** Declared at reservation time, re-verified at commit against the store's `HEAD`. */
  readonly byteSize: bigint;
  readonly contentType: string;
  readonly state: ObjectState;
  /** Number of live {@link ObjectReference} rows. `0` makes the object GC-eligible after grace. */
  readonly refCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when the row entered `delete_pending`; the grace window is measured from here. */
  readonly deletePendingAt?: string;
}

/** What references an object. `refKind`/`refId` are opaque to core. */
export interface ObjectReference {
  readonly tenantId: TenantId;
  readonly hash: ContentHash;
  readonly refKind: string;
  readonly refId: string;
  readonly createdAt: string;
}

export interface ObjectManifestInput {
  readonly hash: ContentHash;
  readonly byteSize: bigint;
  readonly contentType: string;
}

/**
 * Finalize input. `byteSize`/`contentType` are what the composition actually
 * observed on the object store, not what the client declared — the whole point
 * of the check is that the two can differ (§12.7.7 step 4).
 */
export interface ObjectCommitInput {
  readonly hash: ContentHash;
  readonly observedByteSize: bigint;
  readonly observedContentType: string;
}

export interface ObjectReferenceInput {
  readonly hash: ContentHash;
  readonly refKind: string;
  readonly refId: string;
}

export interface ObjectListQuery {
  readonly state?: ObjectState;
  /** Only rows whose `deletePendingAt` is at or before this instant. */
  readonly deletePendingBefore?: string;
  readonly limit?: number;
}

/**
 * Object manifest port. Tenant-first, async, metadata only.
 *
 * Raises: `object_not_found`, `object_state_invalid`,
 * `storage_integrity_mismatch` (commit observed size/type disagreeing with the
 * declared manifest row).
 */
export interface ObjectStore {
  /** Creates or returns the `pending` row for `hash`. Idempotent per (tenant, hash). */
  putManifest(tenant: TenantId, input: ObjectManifestInput): Promise<ObjectManifestEntry>;
  /** `pending` → `committed` after verifying observed size/type. */
  commit(tenant: TenantId, input: ObjectCommitInput): Promise<ObjectManifestEntry>;
  get(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry | undefined>;
  list(tenant: TenantId, query: ObjectListQuery): Promise<readonly ObjectManifestEntry[]>;
  /** Idempotent per (tenant, hash, refKind, refId) — re-adding does not double-count. */
  addReference(tenant: TenantId, input: ObjectReferenceInput): Promise<ObjectManifestEntry>;
  removeReference(tenant: TenantId, input: ObjectReferenceInput): Promise<ObjectManifestEntry>;
  /** Tombstone step 1: only legal at `refCount === 0`. */
  markDeletePending(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry>;
  /** Tombstone step 3: the object store delete succeeded. */
  markDeleted(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry>;
}
