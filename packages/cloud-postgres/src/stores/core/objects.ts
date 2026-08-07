/**
 * Postgres {@link ObjectStore} — the manifest, and only the manifest
 * (§12.7.4, §12.7.8).
 *
 * Zero bytes cross this file. The manifest is the transaction authority and the
 * object store holds the payload; the R2 adapter that moves bytes is S4A-c.
 * What lives here is the state machine that stands between a failed object-store
 * delete and either a leaked object or a deleted one a truth record still points
 * at.
 *
 * Three properties the SQL is shaped around:
 *
 * - **`ref_count` is recomputed, never incremented.** Every reference mutation
 *   sets it to `count(*)` over `object_reference`. An increment drifts the
 *   moment a retried `addReference` lands twice, and a drifted count strands
 *   the object forever because `markDeletePending` refuses at `refCount != 0`.
 *   The reference table's primary key already makes the write idempotent; the
 *   count just reads it.
 * - **Reference mutations hold the manifest row under `FOR UPDATE`.** The
 *   recomputation above is only authoritative because of this lock, not on its
 *   own: under READ COMMITTED the `count(*)` subquery is evaluated on the
 *   snapshot its statement started with, so an unlocked `addReference` reads a
 *   `committed` state, and `markDeletePending`'s `ref_count = 0` guard can pass
 *   in the window before the reference row lands — leaving `delete_pending`
 *   with a live reference, which is a truth record pointing at bytes S4B's GC
 *   is entitled to delete. Taking the manifest row exclusively first makes the
 *   tombstone and the reference write queue against each other, exactly as
 *   `PostgresQuotaStore.reserve` serializes reservers on the entitlement row.
 * - **Every state move is a guarded `UPDATE`.** The legal transitions are the
 *   guard, so an illegal one writes nothing and the row is re-read to say which
 *   typed rejection applies. `commit` additionally guards on the DECLARED size
 *   and type, because the whole point of the check is that what the composition
 *   observed on the object store and what the client declared can differ
 *   (§12.7.7 step 4).
 */
import {
  ByokCoreError,
  assertCanonicalTimestamp,
  type Clock,
  type ContentHash,
  type ObjectCommitInput,
  type ObjectListQuery,
  type ObjectManifestEntry,
  type ObjectManifestInput,
  type ObjectReferenceInput,
  type ObjectState,
  type ObjectStore,
  type TenantId,
} from '@byok/core';
import type { Pool, PoolClient } from 'pg';

const DEFAULT_LIST_LIMIT = 100;

const MANIFEST_COLUMNS =
  'tenant_id, hash, byte_size, content_type, state, ref_count, created_at, updated_at, delete_pending_at';

interface ManifestRow {
  readonly tenant_id: string;
  readonly hash: string;
  readonly byte_size: bigint;
  readonly content_type: string;
  readonly state: string;
  readonly ref_count: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly delete_pending_at: string | null;
}

function toEntry(row: ManifestRow): ObjectManifestEntry {
  return {
    tenantId: row.tenant_id as TenantId,
    hash: row.hash as ContentHash,
    byteSize: row.byte_size,
    contentType: row.content_type,
    state: row.state as ObjectState,
    refCount: row.ref_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.delete_pending_at === null ? {} : { deletePendingAt: row.delete_pending_at }),
  };
}

export class PostgresObjectStore implements ObjectStore {
  readonly #pool: Pool;
  readonly #clock: Clock;

  constructor(pool: Pool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async putManifest(
    tenant: TenantId,
    input: ObjectManifestInput,
  ): Promise<ObjectManifestEntry> {
    const now = this.#now();
    // Idempotent per (tenant, hash): a row that exists in any state but
    // `deleted` is returned untouched, so a retried reservation cannot reset a
    // committed object back to `pending` and orphan its references. A `deleted`
    // row is the one case where the same hash legitimately starts over, and the
    // `WHERE` on the conflict path is what limits the reset to it.
    const upserted = await this.#pool.query<ManifestRow>(
      `INSERT INTO object_manifest (${MANIFEST_COLUMNS})
       VALUES ($1, $2, $3::bigint, $4, 'pending', 0, $5, $5, NULL)
       ON CONFLICT (tenant_id, hash) DO UPDATE
          SET byte_size         = EXCLUDED.byte_size,
              content_type      = EXCLUDED.content_type,
              state             = 'pending',
              ref_count         = 0,
              created_at        = EXCLUDED.created_at,
              updated_at        = EXCLUDED.updated_at,
              delete_pending_at = NULL
        WHERE object_manifest.state = 'deleted'
       RETURNING ${MANIFEST_COLUMNS}`,
      [tenant, input.hash, input.byteSize, input.contentType, now],
    );
    const row = upserted.rows[0];
    if (row !== undefined) return toEntry(row);
    return this.#require(tenant, input.hash);
  }

  async commit(tenant: TenantId, input: ObjectCommitInput): Promise<ObjectManifestEntry> {
    const committed = await this.#pool.query<ManifestRow>(
      `UPDATE object_manifest
          SET state = 'committed', updated_at = $3
        WHERE tenant_id = $1 AND hash = $2
          AND state = 'pending'
          AND byte_size = $4::bigint
          AND content_type = $5
       RETURNING ${MANIFEST_COLUMNS}`,
      [tenant, input.hash, this.#now(), input.observedByteSize, input.observedContentType],
    );
    const row = committed.rows[0];
    if (row !== undefined) return toEntry(row);

    const current = await this.#require(tenant, input.hash);
    // Integrity outranks state: an object whose observed shape disagrees is a
    // mismatch whatever state the row is in, and it stays `pending` so the GC
    // worker can reclaim the bytes rather than a truth record pointing at them.
    if (
      current.byteSize !== input.observedByteSize ||
      current.contentType !== input.observedContentType
    ) {
      throw new ByokCoreError(
        'storage_integrity_mismatch',
        `Observed object ${input.hash} (${String(input.observedByteSize)} bytes, ${input.observedContentType}) does not match the declared manifest.`,
      );
    }
    if (current.state === 'committed') return current;
    throw this.#stateInvalid(current.state, 'committed');
  }

  async get(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry | undefined> {
    const result = await this.#pool.query<ManifestRow>(
      `SELECT ${MANIFEST_COLUMNS} FROM object_manifest WHERE tenant_id = $1 AND hash = $2`,
      [tenant, hash],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toEntry(row);
  }

  async list(
    tenant: TenantId,
    query: ObjectListQuery,
  ): Promise<readonly ObjectManifestEntry[]> {
    // The cutoff is compared against `delete_pending_at` as text, which only
    // equals a time comparison for the canonical form. A GC sweep reading a
    // mis-parsed cutoff would either miss tombstones or take live objects, so
    // this rejects rather than interprets.
    if (query.deletePendingBefore !== undefined) {
      assertCanonicalTimestamp(query.deletePendingBefore, 'deletePendingBefore');
    }
    const result = await this.#pool.query<ManifestRow>(
      `SELECT ${MANIFEST_COLUMNS} FROM object_manifest
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR state = $2::text)
          AND ($3::text IS NULL
               OR (delete_pending_at IS NOT NULL AND delete_pending_at < $3::text))
        ORDER BY hash COLLATE "C"
        LIMIT $4`,
      [
        tenant,
        query.state ?? null,
        query.deletePendingBefore ?? null,
        query.limit ?? DEFAULT_LIST_LIMIT,
      ],
    );
    return result.rows.map(toEntry);
  }

  async addReference(
    tenant: TenantId,
    input: ObjectReferenceInput,
  ): Promise<ObjectManifestEntry> {
    // The state read, the reference write, and the recount are one transaction
    // holding the manifest row, so `markDeletePending` cannot slip its guard
    // between the read and the write.
    return this.#withManifestLocked(tenant, input.hash, async (client, current) => {
      if (current.state !== 'committed') {
        return new ByokCoreError(
          'object_state_invalid',
          `Only committed objects can be referenced; ${input.hash} is ${current.state}.`,
        );
      }
      await client.query(
        `INSERT INTO object_reference (tenant_id, hash, ref_kind, ref_id, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, hash, ref_kind, ref_id) DO NOTHING`,
        [tenant, input.hash, input.refKind, input.refId, this.#now()],
      );
      return this.#recount(client, tenant, input.hash);
    });
  }

  async removeReference(
    tenant: TenantId,
    input: ObjectReferenceInput,
  ): Promise<ObjectManifestEntry> {
    // The mirror of `addReference`, on the same lock. Holding the manifest row
    // is also what replaces the delete's old `EXISTS` guard: the lock already
    // established that this tenant has the row, so `object_not_found` is
    // reported before anything is removed rather than after.
    return this.#withManifestLocked(tenant, input.hash, async (client) => {
      await client.query(
        `DELETE FROM object_reference
          WHERE tenant_id = $1 AND hash = $2 AND ref_kind = $3 AND ref_id = $4`,
        [tenant, input.hash, input.refKind, input.refId],
      );
      return this.#recount(client, tenant, input.hash);
    });
  }

  async markDeletePending(
    tenant: TenantId,
    hash: ContentHash,
  ): Promise<ObjectManifestEntry> {
    // `ref_count = 0` is in the guard, not checked beforehand: a reference
    // added between a check and a write would otherwise tombstone an object a
    // truth record still points at. Nothing else is needed here — this `UPDATE`
    // takes the same manifest row exclusively that `addReference` locks, so a
    // concurrent reference write either lands entirely before this statement
    // (and the guard sees its count) or queues behind it (and re-reads the
    // tombstone it must refuse against).
    const marked = await this.#pool.query<ManifestRow>(
      `UPDATE object_manifest
          SET state = 'delete_pending', delete_pending_at = $3, updated_at = $3
        WHERE tenant_id = $1 AND hash = $2
          AND ref_count = 0
          AND state IN ('pending', 'committed')
       RETURNING ${MANIFEST_COLUMNS}`,
      [tenant, hash, this.#now()],
    );
    const row = marked.rows[0];
    if (row !== undefined) return toEntry(row);

    const current = await this.#require(tenant, hash);
    if (current.refCount !== 0) {
      throw new ByokCoreError(
        'object_state_invalid',
        `Object ${hash} still has ${current.refCount} reference(s).`,
      );
    }
    throw this.#stateInvalid(current.state, 'delete_pending');
  }

  async markDeleted(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry> {
    const deleted = await this.#pool.query<ManifestRow>(
      `UPDATE object_manifest
          SET state = 'deleted', updated_at = $3
        WHERE tenant_id = $1 AND hash = $2 AND state = 'delete_pending'
       RETURNING ${MANIFEST_COLUMNS}`,
      [tenant, hash, this.#now()],
    );
    const row = deleted.rows[0];
    if (row !== undefined) return toEntry(row);

    const current = await this.#require(tenant, hash);
    throw this.#stateInvalid(current.state, 'deleted');
  }

  /**
   * Runs a reference mutation with the manifest row held under `FOR UPDATE`.
   *
   * The lock is taken before anything is read, so the state the callback judges
   * is the state no concurrent `markDeletePending` can move underneath it. A
   * typed refusal is RETURNED rather than thrown, the way
   * `PostgresQuotaStore.reserve` defers its rejection past `COMMIT`: it keeps
   * the `catch` reserved for genuine faults, so a rollback that itself fails
   * cannot replace this store's own answer.
   */
  async #withManifestLocked(
    tenant: TenantId,
    hash: ContentHash,
    mutate: (
      client: PoolClient,
      current: ObjectManifestEntry,
    ) => Promise<ObjectManifestEntry | ByokCoreError>,
  ): Promise<ObjectManifestEntry> {
    const client = await this.#pool.connect();
    let settled: ObjectManifestEntry | ByokCoreError;
    try {
      await client.query('BEGIN');
      const locked = await client.query<ManifestRow>(
        `SELECT ${MANIFEST_COLUMNS} FROM object_manifest
          WHERE tenant_id = $1 AND hash = $2
          FOR UPDATE`,
        [tenant, hash],
      );
      const row = locked.rows[0];
      settled = row === undefined ? this.#notFound(hash) : await mutate(client, toEntry(row));
      await client.query('COMMIT');
    } catch (error) {
      // Best-effort, for the same reason the migration runner's is: a rollback
      // that throws must not replace the failure the caller needs to see.
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    if (settled instanceof ByokCoreError) throw settled;
    return settled;
  }

  /** Sets `ref_count` to what the reference rows actually say. */
  async #recount(
    client: PoolClient,
    tenant: TenantId,
    hash: ContentHash,
  ): Promise<ObjectManifestEntry> {
    const result = await client.query<ManifestRow>(
      `UPDATE object_manifest
          SET ref_count = (SELECT count(*) FROM object_reference r
                            WHERE r.tenant_id = $1 AND r.hash = $2),
              updated_at = $3
        WHERE tenant_id = $1 AND hash = $2
       RETURNING ${MANIFEST_COLUMNS}`,
      [tenant, hash, this.#now()],
    );
    const row = result.rows[0];
    if (row === undefined) throw this.#notFound(hash);
    return toEntry(row);
  }

  async #require(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry> {
    const entry = await this.get(tenant, hash);
    if (entry === undefined) throw this.#notFound(hash);
    return entry;
  }

  #notFound(hash: ContentHash): ByokCoreError {
    return new ByokCoreError(
      'object_not_found',
      `Object ${hash} has no manifest row in this tenant.`,
    );
  }

  #stateInvalid(from: ObjectState, to: ObjectState): ByokCoreError {
    return new ByokCoreError(
      'object_state_invalid',
      `${from} to ${to} is not a legal object manifest transition.`,
    );
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}
