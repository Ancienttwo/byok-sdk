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

const DEFAULT_LIST_LIMIT = 100;

export class InMemoryObjectStore implements ObjectStore {
  readonly #manifest = new Map<string, ObjectManifestEntry>();
  readonly #references = new Map<string, ObjectReference>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
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
