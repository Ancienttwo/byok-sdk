import { InMemoryStorageLedger } from './storage-ledger';
import { assertCollectExpiredInput, CollectExpiredFailure, type CollectExpiredResult } from '../retention';
import type { ObjectCollectExpiredInput } from '../blob';
/**
 * In-memory {@link ObjectStore} reference (§12.7.4, §12.7.8).
 *
 * Metadata only — there are no bytes here, and there are none in the Postgres
 * composition either: the manifest is the transaction authority and the object
 * store holds the payload. `refCount` is derived from the reference rows rather
 * than incremented in place, so a double `addReference` for the same
 * `(refKind, refId)` cannot inflate it and strand an object forever.
 */
import {
  isLegalObjectTransition,
  type ContentHash,
  type ObjectCommitInput,
  type ObjectListQuery,
  type ObjectManifestEntry,
  type ObjectManifestInput,
  type ObjectReference,
  type ObjectReferenceInput,
  type ObjectStore,
} from '../blob';
import { ByokCoreError } from '../errors';
import type { Clock } from '../stores';
import { tenantKey, type TenantId } from '../tenant';
import { assertCanonicalTimestamp } from '../time';
import { registerArchiveAccess } from './archive-access';

const DEFAULT_LIST_LIMIT = 100;

export class InMemoryObjectStore implements ObjectStore {
  readonly #manifest = new Map<string, ObjectManifestEntry>();
  readonly #references = new Map<string, ObjectReference>();
  readonly #clock: Clock;
  readonly #deleteCursor = new Map<TenantId, string>();

  constructor(clock: Clock, private readonly maintenance: { readonly ledger: InMemoryStorageLedger; readonly bytes: InMemoryObjectBytes }) {
    this.#clock = clock;
    if (maintenance === undefined || maintenance.ledger === undefined ||
      typeof maintenance.bytes?.deleteObject !== 'function') {
      throw new ByokCoreError('retention_input_invalid', 'ObjectStore requires its shared ledger and an explicit byte authority.');
    }
    registerArchiveAccess(this, {
      releaseReferences: (tenant, refKind, refId) => {
        const hashes = new Set<ContentHash>();
        let released = 0;
        for (const [key, reference] of this.#references) {
          if (reference.tenantId !== tenant || reference.refKind !== refKind || reference.refId !== refId) continue;
          this.#references.delete(key);
          hashes.add(reference.hash);
          released += 1;
        }
        for (const hash of hashes) {
          const entry = this.#manifest.get(tenantKey(tenant, hash));
          if (entry !== undefined) this.#recount(tenant, entry);
        }
        return released;
      },
    });
  }

  async putManifest(
    tenant: TenantId,
    input: ObjectManifestInput,
  ): Promise<ObjectManifestEntry> {
    const key = tenantKey(tenant, input.hash);
    const existing = this.#manifest.get(key);
    if (existing !== undefined && existing.state !== 'deleted') return existing;

    const now = this.#now();
    const entry: ObjectManifestEntry = {
      tenantId: tenant,
      hash: input.hash,
      byteSize: input.byteSize,
      contentType: input.contentType,
      state: 'pending',
      refCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.#manifest.set(key, entry);
    return entry;
  }

  async commit(tenant: TenantId, input: ObjectCommitInput): Promise<ObjectManifestEntry> {
    const entry = this.#require(tenant, input.hash);
    if (
      entry.byteSize !== input.observedByteSize ||
      entry.contentType !== input.observedContentType
    ) {
      throw new ByokCoreError(
        'storage_integrity_mismatch',
        `Observed object ${input.hash} (${String(input.observedByteSize)} bytes, ${input.observedContentType}) does not match the declared manifest.`,
      );
    }
    if (entry.state === 'committed') return entry;
    return this.#transition(tenant, entry, 'committed');
  }

  async get(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry | undefined> {
    return this.#manifest.get(tenantKey(tenant, hash));
  }

  async list(
    tenant: TenantId,
    query: ObjectListQuery,
  ): Promise<readonly ObjectManifestEntry[]> {
    // The cutoff is compared against `deletePendingAt` as a string below, which
    // only equals a time comparison for the canonical form. A GC sweep reading
    // a mis-parsed cutoff would either miss tombstones or take live ones.
    if (query.deletePendingBefore !== undefined) {
      assertCanonicalTimestamp(query.deletePendingBefore, 'deletePendingBefore');
    }
    const prefix = tenantKey(tenant, '');
    const matches: ObjectManifestEntry[] = [];
    for (const [key, entry] of this.#manifest.entries()) {
      if (!key.startsWith(prefix)) continue;
      if (query.state !== undefined && entry.state !== query.state) continue;
      if (query.deletePendingBefore !== undefined) {
        if (entry.deletePendingAt === undefined) continue;
        if (entry.deletePendingAt >= query.deletePendingBefore) continue;
      }
      matches.push(entry);
    }
    matches.sort((left, right) => left.hash.localeCompare(right.hash));
    return matches.slice(0, query.limit ?? DEFAULT_LIST_LIMIT);
  }

  async addReference(
    tenant: TenantId,
    input: ObjectReferenceInput,
  ): Promise<ObjectManifestEntry> {
    const entry = this.#require(tenant, input.hash);
    if (entry.state !== 'committed') {
      throw new ByokCoreError(
        'object_state_invalid',
        `Only committed objects can be referenced; ${input.hash} is ${entry.state}.`,
      );
    }
    const refKey = tenantKey(tenant, input.hash, input.refKind, input.refId);
    if (!this.#references.has(refKey)) {
      this.#references.set(refKey, {
        tenantId: tenant,
        hash: input.hash,
        refKind: input.refKind,
        refId: input.refId,
        createdAt: this.#now(),
      });
    }
    return this.#recount(tenant, entry);
  }

  async removeReference(
    tenant: TenantId,
    input: ObjectReferenceInput,
  ): Promise<ObjectManifestEntry> {
    const entry = this.#require(tenant, input.hash);
    this.#references.delete(tenantKey(tenant, input.hash, input.refKind, input.refId));
    return this.#recount(tenant, entry);
  }

  async markDeletePending(
    tenant: TenantId,
    hash: ContentHash,
  ): Promise<ObjectManifestEntry> {
    const entry = this.#require(tenant, hash);
    if (entry.refCount !== 0) {
      throw new ByokCoreError(
        'object_state_invalid',
        `Object ${hash} still has ${entry.refCount} reference(s).`,
      );
    }
    return this.#transition(tenant, entry, 'delete_pending');
  }

  async markDeleted(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry> {
    const entry = this.#require(tenant, hash);
    return this.#transition(tenant, entry, 'deleted');
  }

  async collectExpired(tenant: TenantId, input: ObjectCollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    assertCanonicalTimestamp(input.orphanBefore, 'orphanBefore');
    const eligible = (entry: ObjectManifestEntry): boolean => entry.tenantId === tenant && entry.refCount === 0
      && !this.maintenance.ledger.hasReservedObject(tenant, entry.hash)
      && (entry.state === 'delete_pending' || ((entry.state === 'pending' || entry.state === 'committed') && entry.updatedAt < input.orphanBefore));
    let removed = 0, releasedBytes = 0n, more = false, visited = 0, failures = 0;
    let firstFailure: unknown;
    const cursor = this.#deleteCursor.get(tenant) ?? '';
    // Retry tombstones first. Each distinct object consumes one shared slot.
    const entries = [...this.#manifest.values()].filter(eligible);
    const pending = entries.filter(entry => entry.state === 'delete_pending').sort((a, b) => a.hash.localeCompare(b.hash));
    const first = pending.filter(entry => entry.hash > cursor).slice(0, input.limit);
    const fresh = entries.filter(entry => entry.state !== 'delete_pending').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.hash.localeCompare(b.hash)).slice(0, input.limit - first.length);
    const wrapped = pending.filter(entry => entry.hash <= cursor).slice(0, input.limit - first.length - fresh.length);
    const candidates = [...first, ...fresh, ...wrapped];
    more = entries.length > candidates.length;
    for (const candidate of candidates) {
      if (visited++ === input.limit) { more = true; break; }
      const entry = this.#manifest.get(tenantKey(tenant, candidate.hash))!;
      if (!eligible(entry)) continue;
      const pending = entry.state === 'delete_pending' ? entry : { ...entry, state: 'delete_pending' as const, deletePendingAt: input.now, updatedAt: input.now };
      this.#manifest.set(tenantKey(tenant, entry.hash), pending);
      try {
        // No await may split protection, byte deletion and accounting.
        const release = this.maintenance.ledger.prepareCollectedObjectRelease(tenant, entry.hash, entry.byteSize, input.now);
        this.maintenance.bytes.deleteObject(tenant, entry.hash);
        release.commit();
        const released = release.releasedBytes;
        this.#manifest.set(tenantKey(tenant, entry.hash), { ...pending, state: 'deleted', updatedAt: input.now });
        removed++; releasedBytes += released;
      } catch (cause) {
        failures++; firstFailure ??= cause;
      }
    }
    this.#deleteCursor.set(tenant, wrapped.at(-1)?.hash ?? first.at(-1)?.hash ?? '');
    if (failures > 0) throw new CollectExpiredFailure({ removed, expired: 0, releasedBytes }, failures, true, { cause: firstFailure });
    return { removed, expired: 0, releasedBytes, more };
  }

  #transition(
    tenant: TenantId,
    entry: ObjectManifestEntry,
    next: ObjectManifestEntry['state'],
  ): ObjectManifestEntry {
    if (!isLegalObjectTransition(entry.state, next)) {
      throw new ByokCoreError(
        'object_state_invalid',
        `${entry.state} to ${next} is not a legal object manifest transition.`,
      );
    }
    const now = this.#now();
    const updated: ObjectManifestEntry = {
      ...entry,
      state: next,
      updatedAt: now,
      ...(next === 'delete_pending' ? { deletePendingAt: now } : {}),
    };
    this.#manifest.set(tenantKey(tenant, entry.hash), updated);
    return updated;
  }

  #recount(tenant: TenantId, entry: ObjectManifestEntry): ObjectManifestEntry {
    const refPrefix = tenantKey(tenant, entry.hash, '');
    let refCount = 0;
    for (const key of this.#references.keys()) {
      if (key.startsWith(refPrefix)) refCount += 1;
    }
    const updated: ObjectManifestEntry = { ...entry, refCount, updatedAt: this.#now() };
    this.#manifest.set(tenantKey(tenant, entry.hash), updated);
    return updated;
  }

  #require(tenant: TenantId, hash: ContentHash): ObjectManifestEntry {
    const entry = this.#manifest.get(tenantKey(tenant, hash));
    if (entry === undefined) {
      throw new ByokCoreError(
        'object_not_found',
        `Object ${hash} has no manifest row in this tenant.`,
      );
    }
    return entry;
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}

export interface InMemoryObjectBytes {
  deleteObject(tenant: TenantId, hash: ContentHash): void;
}
