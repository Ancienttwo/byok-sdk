/**
 * Postgres {@link TruthStore} (§12.3, §12.6.4).
 *
 * Two write models over one table, and the primary key does the deciding for
 * both.
 *
 * - `task.terminal` is first-write-wins: `INSERT ... ON CONFLICT DO NOTHING`
 *   plus an equality re-read. A replay of the identical hash returns the
 *   ORIGINAL row — same `rev`, same `writtenAt`, same `requestId` — and a
 *   different hash for the same task is refused with the record already
 *   committed attached. An upsert would pass a naive "write it twice" check
 *   while quietly restamping the first fact, which §12.6.4 forbids outright.
 * - `profile` / `memory` are per-key snapshots under an `expectedRev` CAS:
 *   `UPDATE ... WHERE rev = $expectedRev`, with `expectedRev = 0` expressed as
 *   the insert. Zero rows is the conflict, and the caller gets the current
 *   record — or `undefined` when it claimed a revision of a record that does
 *   not exist.
 *
 * The store never merges bodies. A conflict hands back what it lost to and
 * stops, because the device holding the context is the only party that can
 * decide what the merged truth should be (§12.3).
 */
import {
  CoreConflictError,
  type Clock,
  type ContentHash,
  type SnapshotWriteInput,
  type TenantId,
  type TerminalWriteInput,
  type TruthBodyRef,
  type TruthManifestEntry,
  type TruthManifestQuery,
  type TruthRecord,
  type TruthRecordKind,
  type TruthRecordSelector,
  type TruthStore,
} from '@byok/core';
import type { Pool } from 'pg';

const DEFAULT_MANIFEST_LIMIT = 100;

const RECORD_COLUMNS =
  'tenant_id, kind, subject_id, rev, content_hash, byte_size, body_kind, body_inline, body_object_hash, label, request_id, written_at';

interface RecordRow {
  readonly tenant_id: string;
  readonly kind: string;
  readonly subject_id: string;
  readonly rev: number;
  readonly content_hash: string;
  readonly byte_size: bigint;
  readonly body_kind: string;
  readonly body_inline: string | null;
  readonly body_object_hash: string | null;
  readonly label: string | null;
  readonly request_id: string | null;
  readonly written_at: string;
}

interface ManifestRow {
  readonly kind: string;
  readonly subject_id: string;
  readonly rev: number;
  readonly content_hash: string;
  readonly byte_size: bigint;
  readonly label: string | null;
  readonly written_at: string;
}

function toBody(row: RecordRow): TruthBodyRef {
  return row.body_kind === 'inline'
    ? { kind: 'inline', body: row.body_inline ?? '' }
    : { kind: 'object', hash: (row.body_object_hash ?? '') as ContentHash };
}

function toRecord(row: RecordRow): TruthRecord {
  return {
    tenantId: row.tenant_id as TenantId,
    kind: row.kind as TruthRecordKind,
    recordKey: row.subject_id,
    rev: row.rev,
    contentHash: row.content_hash as ContentHash,
    byteSize: row.byte_size,
    body: toBody(row),
    ...(row.label === null ? {} : { label: row.label }),
    ...(row.request_id === null ? {} : { requestId: row.request_id }),
    writtenAt: row.written_at,
  };
}

/** Splits the two-case `TruthBodyRef` union into the two nullable columns. */
function bodyColumns(body: TruthBodyRef): readonly [string, string | null, string | null] {
  return body.kind === 'inline'
    ? ['inline', body.body, null]
    : ['object', null, body.hash as string];
}

export class PostgresTruthStore implements TruthStore {
  readonly #pool: Pool;
  readonly #clock: Clock;

  constructor(pool: Pool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async writeTerminal(tenant: TenantId, input: TerminalWriteInput): Promise<TruthRecord> {
    const [bodyKind, bodyInline, bodyObjectHash] = bodyColumns(input.body);
    const inserted = await this.#pool.query<RecordRow>(
      `INSERT INTO attested_record (${RECORD_COLUMNS})
       VALUES ($1, 'task.terminal', $2, 1, $3, $4::bigint, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, kind, subject_id) DO NOTHING
       RETURNING ${RECORD_COLUMNS}`,
      [
        tenant,
        input.taskId,
        input.contentHash,
        input.byteSize,
        bodyKind,
        bodyInline,
        bodyObjectHash,
        input.label ?? null,
        input.requestId ?? null,
        this.#now(),
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return toRecord(row);

    const existing = await this.getRecord(tenant, {
      kind: 'task.terminal',
      recordKey: input.taskId,
    });
    if (existing === undefined) {
      throw new Error(`terminal record for ${input.taskId} vanished during a first write`);
    }
    // Exact replay of a committed fact: the original, unchanged. A retry after
    // a lost response is therefore safe and observably a no-op.
    if (existing.contentHash === input.contentHash) return existing;
    throw new CoreConflictError(
      'terminal_conflict',
      `Task ${input.taskId} already has an immutable terminal record with a different hash.`,
      existing,
      this.#now(),
    );
  }

  async writeSnapshot(tenant: TenantId, input: SnapshotWriteInput): Promise<TruthRecord> {
    const [bodyKind, bodyInline, bodyObjectHash] = bodyColumns(input.body);
    const now = this.#now();

    // `expectedRev = 0` asserts "no record yet", which in SQL is the insert
    // itself: the primary key rejects a caller whose assertion is stale. Every
    // other expected revision is the `rev = $expectedRev` guard on the update.
    // Both are one statement, and both report zero rows as the same conflict.
    const written =
      input.expectedRev === 0
        ? await this.#pool.query<RecordRow>(
            `INSERT INTO attested_record (${RECORD_COLUMNS})
             VALUES ($1, $2, $3, 1, $4, $5::bigint, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (tenant_id, kind, subject_id) DO NOTHING
             RETURNING ${RECORD_COLUMNS}`,
            [
              tenant,
              input.kind,
              input.recordKey,
              input.contentHash,
              input.byteSize,
              bodyKind,
              bodyInline,
              bodyObjectHash,
              input.label ?? null,
              input.requestId ?? null,
              now,
            ],
          )
        : await this.#pool.query<RecordRow>(
            `UPDATE attested_record
                SET rev              = rev + 1,
                    content_hash     = $4,
                    byte_size        = $5::bigint,
                    body_kind        = $6,
                    body_inline      = $7,
                    body_object_hash = $8,
                    label            = $9,
                    request_id       = $10,
                    written_at       = $11
              WHERE tenant_id = $1 AND kind = $2 AND subject_id = $3 AND rev = $12
             RETURNING ${RECORD_COLUMNS}`,
            [
              tenant,
              input.kind,
              input.recordKey,
              input.contentHash,
              input.byteSize,
              bodyKind,
              bodyInline,
              bodyObjectHash,
              input.label ?? null,
              input.requestId ?? null,
              now,
              input.expectedRev,
            ],
          );

    const row = written.rows[0];
    if (row !== undefined) return toRecord(row);

    const current = await this.getRecord(tenant, {
      kind: input.kind,
      recordKey: input.recordKey,
    });
    throw new CoreConflictError<TruthRecord | undefined>(
      'truth_revision_conflict',
      `Record ${input.kind}/${input.recordKey} is at rev ${current?.rev ?? 0}, not ${input.expectedRev}.`,
      current,
      this.#now(),
    );
  }

  async getRecord(
    tenant: TenantId,
    selector: TruthRecordSelector,
  ): Promise<TruthRecord | undefined> {
    const result = await this.#pool.query<RecordRow>(
      `SELECT ${RECORD_COLUMNS} FROM attested_record
        WHERE tenant_id = $1 AND kind = $2 AND subject_id = $3`,
      [tenant, selector.kind, selector.recordKey],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  async listManifest(
    tenant: TenantId,
    query: TruthManifestQuery,
  ): Promise<readonly TruthManifestEntry[]> {
    // Metadata only — the body columns are not in the projection at all, so a
    // manifest listing cannot accidentally ship payloads. Selecting which
    // bodies to fetch is a local decision (§S6.4), and an unbounded response
    // would defeat it.
    //
    // `COLLATE "C"` pins the order to byte order, which is what the in-memory
    // reference's `localeCompare` produces for these keys and, unlike the
    // database's default collation, does not depend on how the server was
    // initialized.
    const result = await this.#pool.query<ManifestRow>(
      `SELECT kind, subject_id, rev, content_hash, byte_size, label, written_at
         FROM attested_record
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR kind = $2::text)
          AND ($3::text IS NULL OR starts_with(subject_id, $3::text))
        ORDER BY kind COLLATE "C", subject_id COLLATE "C"
        LIMIT $4`,
      [tenant, query.kind ?? null, query.keyPrefix ?? null, query.limit ?? DEFAULT_MANIFEST_LIMIT],
    );

    return result.rows.map((row) => ({
      kind: row.kind as TruthRecordKind,
      recordKey: row.subject_id,
      rev: row.rev,
      contentHash: row.content_hash as ContentHash,
      byteSize: row.byte_size,
      ...(row.label === null ? {} : { label: row.label }),
      updatedAt: row.written_at,
    }));
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}
