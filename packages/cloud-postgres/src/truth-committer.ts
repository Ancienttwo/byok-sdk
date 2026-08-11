import {
  TRUTH_REQUEST_ID_MAX_LENGTH,
  TruthCommitResponseSchema,
  TruthCommitError,
  truthRecordMetadata,
  type CloudCrypto,
  type PreparedTruthWrite,
  type ProofRequestReceipt,
  type TruthCommitInput,
  type TruthCommitResponse,
  type TruthCommitResult,
  type TruthCommitter,
} from '@byok-sdk/cloud';
import {
  ByokCoreError,
  CoreConflictError,
  type Clock,
  type ContentHash,
  type TenantId,
  type TruthBodyRef,
  type TruthRecord,
  type TruthRecordKind,
} from '@byok-sdk/core';
import type { Pool, PoolClient } from 'pg';
import { PostgresTruthStore } from './stores/core/truth';

const RECORD_COLUMNS =
  'tenant_id, kind, subject_id, rev, content_hash, byte_size, body_kind, body_inline, body_object_hash, label, request_id, written_at';
const RECEIPT_COLUMNS =
  'tenant_id, device_id, request_id, operation, resource, body_sha256, body_size, response_status, response_body, recorded_at';

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

interface ReceiptRow {
  readonly tenant_id: string;
  readonly device_id: string;
  readonly request_id: string;
  readonly operation: string;
  readonly resource: string;
  readonly body_sha256: string;
  readonly body_size: bigint;
  readonly response_status: number;
  readonly response_body: string;
  readonly recorded_at: Date;
}

interface EntitlementRow {
  readonly hard_limit_bytes: bigint;
  readonly max_inline_bytes: bigint;
  readonly downgrade_grace_until: string | null;
}

interface UsageRow {
  readonly committed_object_bytes: bigint;
  readonly committed_inline_bytes: bigint;
  readonly reserved_bytes: bigint;
}

interface ManifestRow {
  readonly hash: string;
  readonly byte_size: bigint;
  readonly state: string;
}

interface InlineHashRow {
  readonly content_hash: string;
  readonly byte_size: bigint;
  readonly ref_count: bigint;
}

interface AppliedWrite {
  readonly input: PreparedTruthWrite;
  readonly before: TruthRecord | undefined;
  readonly record: TruthRecord;
  readonly mutated: boolean;
}

export interface PostgresTruthCommitterOptions {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly crypto: Pick<CloudCrypto, 'sha256'>;
}

function toBody(row: RecordRow): TruthBodyRef {
  return row.body_kind === 'inline'
    ? { kind: 'inline', body: row.body_inline ?? '' }
    : { kind: 'object', hash: (row.body_object_hash ?? '') as ContentHash };
}

function toRecord(tenant: TenantId, row: RecordRow): TruthRecord {
  return {
    tenantId: tenant,
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

function toReceipt(tenant: TenantId, row: ReceiptRow): ProofRequestReceipt {
  return {
    tenantId: tenant,
    deviceId: row.device_id,
    requestId: row.request_id,
    operation: row.operation,
    resource: row.resource,
    bodySha256: row.body_sha256,
    bodySize: row.body_size,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    recordedAt: row.recorded_at.toISOString(),
  };
}

function sameBinding(receipt: ProofRequestReceipt, input: TruthCommitInput): boolean {
  return (
    receipt.operation === input.operation &&
    receipt.resource === input.resource &&
    receipt.bodySha256 === input.proofBodySha256 &&
    receipt.bodySize === input.proofBodySize
  );
}

function bodyColumns(body: TruthBodyRef): readonly [string, string | null, string | null] {
  return body.kind === 'inline'
    ? ['inline', body.body, null]
    : ['object', null, body.hash];
}

function writeKey(write: PreparedTruthWrite): string {
  return `${write.kind}\u0000${write.recordKey}`;
}

function referenceId(write: PreparedTruthWrite): string {
  return `${write.kind}:${write.recordKey}`;
}

export class PostgresTruthCommitter implements TruthCommitter {
  readonly #pool: Pool;
  readonly #clock: Clock;
  readonly #crypto: Pick<CloudCrypto, 'sha256'>;
  readonly #truth: PostgresTruthStore;

  constructor(options: PostgresTruthCommitterOptions) {
    this.#pool = options.pool;
    this.#clock = options.clock;
    this.#crypto = options.crypto;
    this.#truth = new PostgresTruthStore(options.pool, options.clock);
  }

  getRecord(tenant: TenantId, selector: Parameters<TruthCommitter['getRecord']>[1]) {
    return this.#truth.getRecord(tenant, selector);
  }

  listManifest(tenant: TenantId, query: Parameters<TruthCommitter['listManifest']>[1]) {
    return this.#truth.listManifest(tenant, query);
  }

  async commit(tenant: TenantId, input: TruthCommitInput): Promise<TruthCommitResult> {
    await this.#validateInput(input);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // Serializes the absence case too. A row lock cannot lock a receipt that
      // does not exist; without this, two first deliveries could both mutate
      // truth before one loses the receipt PK race.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        JSON.stringify(['truth-receipt', tenant, input.deviceId, input.requestId]),
      ]);

      const replay = await this.#readReceipt(client, tenant, input.deviceId, input.requestId);
      if (replay !== undefined) {
        if (!sameBinding(replay, input)) {
          throw new TruthCommitError(
            'proof_request_conflict',
            `Request ${input.requestId} was already used with a different binding.`,
          );
        }
        const response = TruthCommitResponseSchema.parse(JSON.parse(replay.responseBody));
        await client.query('COMMIT');
        return { response, replayed: true };
      }

      const before = await this.#lockCurrentRecords(client, tenant, input.writes);
      this.#assertWritePreconditions(input.writes, before);
      await this.#lockAndVerifyObjects(client, tenant, input.writes, before);

      const inlineAffected = input.writes.some((write) => {
        const current = before.get(writeKey(write));
        if (write.kind === 'task.terminal' && current !== undefined) return false;
        return current?.body.kind === 'inline' || write.body.kind === 'inline';
      });
      const inlineDelta = inlineAffected
        ? await this.#prepareInlineAccounting(client, tenant, input.writes, before)
        : 0n;

      const applied = await this.#applyWrites(client, tenant, input, before);
      await this.#replaceObjectReferences(client, tenant, applied);
      await this.#settleInlineAccounting(client, tenant, inlineDelta);

      const response: TruthCommitResponse = {
        primary: truthRecordMetadata(applied[0]!.record),
        snapshots: applied.slice(1).map((entry) => truthRecordMetadata(entry.record)),
      };
      await client.query(
        `INSERT INTO proof_request_receipt (${RECEIPT_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, 200, $8, $9)`,
        [
          tenant,
          input.deviceId,
          input.requestId,
          input.operation,
          input.resource,
          input.proofBodySha256,
          input.proofBodySize,
          JSON.stringify(response),
          this.#now(),
        ],
      );
      await client.query('COMMIT');
      return { response, replayed: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #validateInput(input: TruthCommitInput): Promise<void> {
    if (input.requestId.length === 0 || input.requestId.length > TRUTH_REQUEST_ID_MAX_LENGTH) {
      throw new TruthCommitError('proof_request_conflict', 'Request id is outside the record contract.');
    }
    const seen = new Set<string>();
    const objectSizes = new Map<string, bigint>();
    for (const write of input.writes) {
      const key = writeKey(write);
      if (seen.has(key)) {
        throw new TruthCommitError('proof_request_conflict', `Duplicate truth write ${key}.`);
      }
      seen.add(key);
      if (write.body.kind === 'inline') {
        const bytes = new TextEncoder().encode(write.body.body);
        if (BigInt(bytes.byteLength) !== write.byteSize) {
          throw new ByokCoreError('storage_integrity_mismatch', 'Inline byte size disagrees with its content.');
        }
        if ((await this.#crypto.sha256(bytes)) !== write.contentHash) {
          throw new ByokCoreError('storage_integrity_mismatch', 'Inline hash disagrees with its content.');
        }
      } else if (write.body.hash !== write.contentHash) {
        throw new ByokCoreError('storage_integrity_mismatch', 'Object body hash disagrees with record hash.');
      } else {
        const priorSize = objectSizes.get(write.body.hash);
        if (priorSize !== undefined && priorSize !== write.byteSize) {
          throw new ByokCoreError(
            'storage_integrity_mismatch',
            `Object ${write.body.hash} was declared with inconsistent byte sizes.`,
          );
        }
        objectSizes.set(write.body.hash, write.byteSize);
      }
    }
  }

  async #readReceipt(
    client: PoolClient,
    tenant: TenantId,
    deviceId: string,
    requestId: string,
  ): Promise<ProofRequestReceipt | undefined> {
    const result = await client.query<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS} FROM proof_request_receipt
        WHERE tenant_id = $1 AND device_id = $2 AND request_id = $3`,
      [tenant, deviceId, requestId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toReceipt(tenant, row);
  }

  async #lockCurrentRecords(
    client: PoolClient,
    tenant: TenantId,
    writes: readonly PreparedTruthWrite[],
  ): Promise<Map<string, TruthRecord | undefined>> {
    const current = new Map<string, TruthRecord | undefined>();
    const ordered = [...writes].sort((a, b) => writeKey(a).localeCompare(writeKey(b)));
    // Row locks cannot protect a missing snapshot. Per-key advisory locks make
    // expectedRev=0 deterministic: the waiter observes the winner and raises a
    // typed revision conflict instead of leaking a unique-constraint error.
    for (const write of ordered) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        JSON.stringify(['truth-record', tenant, write.kind, write.recordKey]),
      ]);
    }
    for (const write of ordered) {
      const result = await client.query<RecordRow>(
        `SELECT ${RECORD_COLUMNS} FROM attested_record
          WHERE tenant_id = $1 AND kind = $2 AND subject_id = $3
          FOR UPDATE`,
        [tenant, write.kind, write.recordKey],
      );
      current.set(
        writeKey(write),
        result.rows[0] === undefined ? undefined : toRecord(tenant, result.rows[0]),
      );
    }
    return current;
  }

  #assertWritePreconditions(
    writes: readonly PreparedTruthWrite[],
    current: ReadonlyMap<string, TruthRecord | undefined>,
  ): void {
    for (const write of writes) {
      const before = current.get(writeKey(write));
      if (write.kind === 'task.terminal') {
        if (before !== undefined && before.contentHash !== write.contentHash) {
          throw new CoreConflictError(
            'terminal_conflict',
            `Task ${write.recordKey} already has a different immutable terminal.`,
            before,
            this.#now(),
          );
        }
      } else if ((before?.rev ?? 0) !== write.expectedRev) {
        throw new CoreConflictError(
          'truth_revision_conflict',
          `${write.kind}/${write.recordKey} is at rev ${before?.rev ?? 0}, not ${write.expectedRev}.`,
          before,
          this.#now(),
        );
      }
    }
  }

  async #lockAndVerifyObjects(
    client: PoolClient,
    tenant: TenantId,
    writes: readonly PreparedTruthWrite[],
    current: ReadonlyMap<string, TruthRecord | undefined>,
  ): Promise<void> {
    const requested = new Map<string, bigint>();
    const affected = new Set<string>();
    for (const write of writes) {
      const before = current.get(writeKey(write));
      if (write.kind === 'task.terminal' && before !== undefined) continue;
      if (before?.body.kind === 'object') affected.add(before.body.hash);
      if (write.body.kind === 'object') {
        const existing = requested.get(write.body.hash);
        if (existing !== undefined && existing !== write.byteSize) {
          throw new ByokCoreError(
            'storage_integrity_mismatch',
            `Object ${write.body.hash} was declared with inconsistent byte sizes.`,
          );
        }
        requested.set(write.body.hash, write.byteSize);
        affected.add(write.body.hash);
      }
    }
    // Lock both the old and new manifests in one global order. Locking only
    // the new side lets two snapshots swapping A/B each hold its destination
    // and deadlock while recounting the other's source reference.
    for (const hash of [...affected].sort()) {
      const result = await client.query<ManifestRow>(
        `SELECT hash, byte_size, state FROM object_manifest
          WHERE tenant_id = $1 AND hash = $2 FOR UPDATE`,
        [tenant, hash],
      );
      const manifest = result.rows[0];
      const byteSize = requested.get(hash);
      if (
        manifest === undefined ||
        (byteSize !== undefined &&
          (manifest.state !== 'committed' || manifest.byte_size !== byteSize))
      ) {
        throw new TruthCommitError(
          'truth_object_not_committed',
          `Object ${hash} is not a committed matching manifest.`,
        );
      }
    }
  }

  async #prepareInlineAccounting(
    client: PoolClient,
    tenant: TenantId,
    writes: readonly PreparedTruthWrite[],
    current: ReadonlyMap<string, TruthRecord | undefined>,
  ): Promise<bigint> {
    const entitlementResult = await client.query<EntitlementRow>(
      `SELECT hard_limit_bytes, max_inline_bytes, downgrade_grace_until
         FROM storage_entitlement WHERE tenant_id = $1 FOR UPDATE`,
      [tenant],
    );
    const entitlement = entitlementResult.rows[0];
    if (entitlement === undefined) {
      throw new ByokCoreError('storage_entitlement_missing', 'Tenant has no storage entitlement.');
    }
    const now = this.#now();
    await client.query(
      `UPDATE storage_reservation SET state = 'expired', settled_at = $2
        WHERE tenant_id = $1 AND state = 'reserved' AND expires_at <= $2`,
      [tenant, now],
    );
    const usageResult = await client.query<UsageRow>(
      `SELECT u.committed_object_bytes, u.committed_inline_bytes,
              COALESCE((SELECT SUM(expected_bytes) FROM storage_reservation r
                         WHERE r.tenant_id = $1 AND r.state = 'reserved'), 0)::bigint AS reserved_bytes
         FROM storage_usage u WHERE u.tenant_id = $1 FOR UPDATE`,
      [tenant],
    );
    const usage = usageResult.rows[0];
    if (usage === undefined) throw new Error(`storage usage for ${tenant} is missing`);

    const affectedHashes = new Set<string>();
    const sizes = new Map<string, bigint>();
    for (const write of writes) {
      const before = current.get(writeKey(write));
      if (write.kind === 'task.terminal' && before !== undefined) continue;
      if (before?.body.kind === 'inline') {
        affectedHashes.add(before.contentHash);
        sizes.set(before.contentHash, before.byteSize);
      }
      if (write.body.kind !== 'inline') continue;
      if (write.byteSize > entitlement.max_inline_bytes) {
        throw new ByokCoreError(
          'storage_object_too_large',
          `Inline truth ${write.kind}/${write.recordKey} exceeds maxInlineBytes.`,
        );
      }
      const knownSize = sizes.get(write.contentHash);
      if (knownSize !== undefined && knownSize !== write.byteSize) {
        throw new ByokCoreError(
          'storage_integrity_mismatch',
          `Inline hash ${write.contentHash} was declared with inconsistent byte sizes.`,
        );
      }
      affectedHashes.add(write.contentHash);
      sizes.set(write.contentHash, write.byteSize);
    }

    const hashes = [...affectedHashes].sort();
    const baseline = new Map<string, bigint>(hashes.map((hash) => [hash, 0n]));
    const existing = await client.query<InlineHashRow>(
      `SELECT content_hash, byte_size, count(*)::bigint AS ref_count
         FROM attested_record
        WHERE tenant_id = $1 AND body_kind = 'inline' AND content_hash = ANY($2::text[])
        GROUP BY content_hash, byte_size`,
      [tenant, hashes],
    );
    for (const row of existing.rows) {
      const knownSize = sizes.get(row.content_hash);
      if (knownSize !== undefined && knownSize !== row.byte_size) {
        throw new ByokCoreError(
          'storage_integrity_mismatch',
          `Stored inline hash ${row.content_hash} disagrees on byte size.`,
        );
      }
      if ((baseline.get(row.content_hash) ?? 0n) !== 0n) {
        throw new ByokCoreError(
          'storage_integrity_mismatch',
          `Stored inline hash ${row.content_hash} has multiple byte sizes.`,
        );
      }
      baseline.set(row.content_hash, row.ref_count);
      sizes.set(row.content_hash, row.byte_size);
    }

    const projected = new Map(baseline);
    for (const write of writes) {
      const before = current.get(writeKey(write));
      if (write.kind === 'task.terminal' && before !== undefined) continue;
      if (before?.body.kind === 'inline') {
        projected.set(before.contentHash, (projected.get(before.contentHash) ?? 0n) - 1n);
      }
      if (write.body.kind === 'inline') {
        projected.set(write.contentHash, (projected.get(write.contentHash) ?? 0n) + 1n);
      }
    }

    let delta = 0n;
    let newlyCommitted = 0n;
    for (const hash of hashes) {
      const before = baseline.get(hash) ?? 0n;
      const after = projected.get(hash) ?? 0n;
      if (after < 0n) throw new Error(`inline reference count for ${hash} would become negative`);
      const byteSize = sizes.get(hash);
      if (byteSize === undefined) throw new Error(`inline byte size for ${hash} is missing`);
      if (before === 0n && after > 0n) {
        delta += byteSize;
        newlyCommitted += byteSize;
      } else if (before > 0n && after === 0n) {
        delta -= byteSize;
      }
    }

    const used = usage.committed_object_bytes + usage.committed_inline_bytes + usage.reserved_bytes;
    if (
      newlyCommitted > 0n &&
      used >= entitlement.hard_limit_bytes &&
      entitlement.downgrade_grace_until !== null &&
      entitlement.downgrade_grace_until <= now
    ) {
      throw new ByokCoreError('storage_write_suspended', 'Durable writes are suspended.');
    }
    if (used + delta > entitlement.hard_limit_bytes) {
      throw new ByokCoreError('storage_quota_exceeded', 'Final inline truth usage exceeds quota.');
    }
    return delta;
  }

  async #applyWrites(
    client: PoolClient,
    tenant: TenantId,
    input: TruthCommitInput,
    current: ReadonlyMap<string, TruthRecord | undefined>,
  ): Promise<AppliedWrite[]> {
    const applied: AppliedWrite[] = [];
    for (const write of input.writes) {
      const before = current.get(writeKey(write));
      if (write.kind === 'task.terminal' && before !== undefined) {
        applied.push({ input: write, before, record: before, mutated: false });
        continue;
      }
      const [bodyKind, bodyInline, bodyObjectHash] = bodyColumns(write.body);
      const values = [
        tenant,
        write.kind,
        write.recordKey,
        write.contentHash,
        write.byteSize,
        bodyKind,
        bodyInline,
        bodyObjectHash,
        write.label ?? null,
        input.requestId,
        this.#now(),
      ];
      const result =
        before === undefined
          ? await client.query<RecordRow>(
              `INSERT INTO attested_record (${RECORD_COLUMNS})
               VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11)
               RETURNING ${RECORD_COLUMNS}`,
              values,
            )
          : await client.query<RecordRow>(
              `UPDATE attested_record
                  SET rev = rev + 1, content_hash = $4, byte_size = $5,
                      body_kind = $6, body_inline = $7, body_object_hash = $8,
                      label = $9, request_id = $10, written_at = $11
                WHERE tenant_id = $1 AND kind = $2 AND subject_id = $3
               RETURNING ${RECORD_COLUMNS}`,
              values,
            );
      applied.push({
        input: write,
        before,
        record: toRecord(tenant, result.rows[0]!),
        mutated: true,
      });
    }
    return applied;
  }

  async #replaceObjectReferences(
    client: PoolClient,
    tenant: TenantId,
    applied: readonly AppliedWrite[],
  ): Promise<void> {
    const affected = new Set<string>();
    for (const entry of applied) {
      if (!entry.mutated) continue;
      const refId = referenceId(entry.input);
      if (entry.input.body.kind === 'object') {
        affected.add(entry.input.body.hash);
        await client.query(
          `INSERT INTO object_reference (tenant_id, hash, ref_kind, ref_id, created_at)
           VALUES ($1, $2, 'truth', $3, $4)
           ON CONFLICT (tenant_id, hash, ref_kind, ref_id) DO NOTHING`,
          [tenant, entry.input.body.hash, refId, this.#now()],
        );
      }
      if (
        entry.before?.body.kind === 'object' &&
        (entry.input.body.kind !== 'object' || entry.input.body.hash !== entry.before.body.hash)
      ) {
        affected.add(entry.before.body.hash);
        await client.query(
          `DELETE FROM object_reference
            WHERE tenant_id = $1 AND hash = $2 AND ref_kind = 'truth' AND ref_id = $3`,
          [tenant, entry.before.body.hash, refId],
        );
      }
    }
    for (const hash of [...affected].sort()) {
      await client.query(
        `UPDATE object_manifest
            SET ref_count = (SELECT count(*) FROM object_reference r
                              WHERE r.tenant_id = $1 AND r.hash = $2),
                updated_at = $3
          WHERE tenant_id = $1 AND hash = $2`,
        [tenant, hash, this.#now()],
      );
    }
  }

  async #settleInlineAccounting(
    client: PoolClient,
    tenant: TenantId,
    delta: bigint,
  ): Promise<void> {
    if (delta !== 0n) {
      const updated = await client.query(
        `UPDATE storage_usage
            SET committed_inline_bytes = committed_inline_bytes + $2::bigint,
                updated_at = $3
          WHERE tenant_id = $1 AND committed_inline_bytes + $2::bigint >= 0
         RETURNING 1`,
        [tenant, delta, this.#now()],
      );
      if (updated.rowCount !== 1) throw new Error('inline accounting would become negative');
    }
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}
