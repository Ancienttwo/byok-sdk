import { settleDeletedObject } from './stores/core/object-gc';
/**
 * Host-owned S4B-c maintenance for the Postgres + R2 composition.
 *
 * Postgres remains the manifest/accounting authority. R2 is touched only after
 * a durable `delete_pending` tombstone, and a missing object is an idempotent
 * DELETE replay — never evidence that a committed manifest was truthful.
 */
import { CloudCleanupError } from './maintenance-errors';
import { createHash } from 'node:crypto';
import {
  contentHash,
  tenantId,
  type Clock,
  type ContentHash,
  type MailboxMessage,
  type MailboxMessageState,
  type TenantId,
} from '@byok-sdk/core';
import { decodeEnvelope, encodeEnvelope, EnvelopeSchema, isServerToDaemonType } from '@byok-sdk/protocol';
import type { Pool, PoolClient } from 'pg';
import { assertByokPool, type ByokPool } from './pool';
import {
  R2ObjectMaintenanceStore,
  type R2ObjectMaintenance,
  type R2ObjectMaintenanceOptions,
} from './stores/r2-blobs';
import { BEGIN_OUTBOX_WRITE, insertOutboxRow } from './stores/core/outbox-writer';

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1000;
const OUTBOX_COLUMNS =
  'tenant_id, device_id, seq, message_id, body, body_hash, byte_size, state, appended_at, replay_source_seq';

export interface ObjectStorageReconcileResult {
  readonly objectsDeleted: bigint;
  readonly objectReleasedBytes: bigint;
  readonly orphanWitnessesCreated: bigint;
  readonly missingObjects: bigint;
  readonly shapeDrift: bigint;
  readonly invalidObjectKeys: bigint;
  readonly operationErrors: bigint;
}

export interface DeadLetterQuery {
  readonly deviceId?: string;
  /** Exclusive composite cursor; use the last message from the prior page. */
  readonly after?: DeadLetterRef;
  readonly limit?: number;
}

export interface DeadLetterPage {
  readonly messages: readonly MailboxMessage[];
  readonly hasMore: boolean;
}

export interface DeadLetterReplayInput {
  readonly deviceId: string;
  readonly seq: number;
  /** Operator-issued idempotency key for the new delivery. */
  readonly replayMessageId: string;
}

export interface DeadLetterRef {
  readonly deviceId: string;
  readonly seq: number;
}

export interface ObjectUsageRebuildResult {
  readonly committedObjectBytes: bigint;
  readonly objectCount: bigint;
  readonly updatedAt: string;
}

export interface PostgresCloudCleanupOptions {
  readonly pool: ByokPool;
  readonly clock: Clock;
  readonly objectStorage: R2ObjectMaintenance;
  readonly batchSize?: number;
}

export interface PostgresCloudMaintenanceOptions {
  readonly pool: ByokPool;
  readonly clock: Clock;
  readonly objectStorage: R2ObjectMaintenanceOptions;
  readonly batchSize?: number;
}

interface ManifestMaintenanceRow {
  readonly hash: string;
  readonly byte_size: bigint;
  readonly content_type: string;
  readonly state: string;
  readonly gc_accounted_bytes: bigint | null;
  readonly gc_accounted_object: boolean | null;
}

interface OutboxRow {
  readonly tenant_id: string;
  readonly device_id: string;
  readonly seq: bigint;
  readonly message_id: string;
  readonly body: string;
  readonly body_hash: string;
  readonly byte_size: bigint;
  readonly state: string;
  readonly appended_at: string;
  readonly replay_source_seq: bigint | null;
}

interface MutableCounts {
  objectsDeleted: bigint;
  objectReleasedBytes: bigint;
  orphanWitnessesCreated: bigint;
  missingObjects: bigint;
  shapeDrift: bigint;
  invalidObjectKeys: bigint;
  operationErrors: bigint;
}

export class PostgresCloudCleanup {
  readonly #pool: Pool;
  readonly #clock: Clock;
  readonly #objectStorage: R2ObjectMaintenance;
  readonly #batchSize: number;

  constructor(options: PostgresCloudCleanupOptions) {
    assertByokPool(options.pool, 'PostgresCloudCleanup');
    this.#pool = options.pool;
    this.#clock = options.clock;
    this.#objectStorage = options.objectStorage;
    this.#batchSize = assertBatchSize(options.batchSize ?? DEFAULT_BATCH_SIZE);
  }

  /** Reconcile manifest/R2 observations as an explicit operator action. */
  async reconcileObjectStorage(tenant: TenantId): Promise<ObjectStorageReconcileResult> {
    const client = await this.#pool.connect();
    try {
      const counts = emptyCounts();
      await this.#reconcileManifests(client, tenant, counts);
      await this.#reconcileR2(client, tenant, counts);
      return counts;
    } finally { client.release(); }
  }

  async listDeadLetters(tenant: TenantId, query: DeadLetterQuery = {}): Promise<DeadLetterPage> {
    const limit = assertBatchSize(query.limit ?? DEFAULT_BATCH_SIZE);
    if (query.deviceId !== undefined) assertIdentifier(query.deviceId, 'deviceId');
    if (query.after !== undefined) assertDeadLetterRef(query.after);
    if (
      query.deviceId !== undefined &&
      query.after !== undefined &&
      query.deviceId !== query.after.deviceId
    ) {
      throw new CloudCleanupError(
        'cleanup_invalid_input',
        'A device-scoped dead-letter cursor must belong to the same device.',
      );
    }
    const listed = await this.#pool.query<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM outbox
        WHERE tenant_id = $1
          AND state = 'expired'
          AND ($2::text IS NULL OR device_id = $2::text)
          AND (device_id > $3 OR (device_id = $3 AND seq > $4::bigint))
        ORDER BY device_id, seq
        LIMIT $5`,
      [
        tenant,
        query.deviceId ?? null,
        query.after?.deviceId ?? '',
        query.after?.seq ?? 0,
        limit + 1,
      ],
    );
    return {
      messages: listed.rows.slice(0, limit).map(toMailboxMessage),
      hasMore: listed.rows.length > limit,
    };
  }

  /**
   * Clone an expired row to a new monotonic seq. The original remains evidence.
   *
   * The clone is a `limited` mailbox append: it goes through the one outbox
   * writer, so it is admitted against `mailboxLimitBytes` like any other new
   * row and is ordered with live offers by the same locks.
   */
  async replayDeadLetter(
    tenant: TenantId,
    input: DeadLetterReplayInput,
  ): Promise<MailboxMessage> {
    assertDeadLetterRef(input);
    assertIdentifier(input.replayMessageId, 'replayMessageId');
    const client = await this.#pool.connect();
    let result: MailboxMessage | undefined;
    let rejection: Error | undefined;
    try {
      await client.query(BEGIN_OUTBOX_WRITE);
      const originalResult = await client.query<OutboxRow>(
        `SELECT ${OUTBOX_COLUMNS} FROM outbox
          WHERE tenant_id = $1 AND device_id = $2 AND seq = $3::bigint
            AND state = 'expired'
          FOR UPDATE`,
        [tenant, input.deviceId, input.seq],
      );
      const original = originalResult.rows[0];
      if (original === undefined) {
        rejection = deadLetterMissing(input);
      } else {
        const existingResult = await client.query<OutboxRow>(
          `SELECT ${OUTBOX_COLUMNS} FROM outbox
            WHERE tenant_id = $1 AND device_id = $2 AND message_id = $3`,
          [tenant, input.deviceId, input.replayMessageId],
        );
        // A different dead-letter row, or a normal append, may race on the
        // same operator-issued id. The writer re-reads the key behind its
        // locks, so the loser resolves here instead of a raw unique violation.
        const bound =
          existingResult.rows[0] ??
          (
            await insertOutboxRow(client, tenant, {
              deviceId: input.deviceId,
              messageId: input.replayMessageId,
              admission: 'limited',
              now: this.#now(),
              materialize: (seq) => materializeReplayBody(original, seq),
              replaySourceSeq: original.seq,
            })
          ).row;
        if (!replayMatches(bound, original)) {
          rejection = new CloudCleanupError(
            'cleanup_invalid_input',
            `Replay id ${input.replayMessageId} already binds a different replay delivery.`,
          );
        } else {
          result = toMailboxMessage(bound);
        }
      }
      if (rejection === undefined) await client.query('COMMIT');
      else await client.query('ROLLBACK');
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => {});
      throw cause;
    } finally {
      client.release();
    }
    if (rejection !== undefined) throw rejection;
    return result!;
  }

  /**
   * Explicit operator discard. Automatic retention never deletes dead letters.
   * Mailbox usage is the sum over retained rows, so deleting one is the whole
   * operation.
   */
  async discardDeadLetter(tenant: TenantId, ref: DeadLetterRef): Promise<MailboxMessage> {
    assertDeadLetterRef(ref);
    const removed = await this.#pool.query<OutboxRow>(
      `DELETE FROM outbox
        WHERE tenant_id = $1 AND device_id = $2 AND seq = $3::bigint
          AND state = 'expired'
        RETURNING ${OUTBOX_COLUMNS}`,
      [tenant, ref.deviceId, ref.seq],
    );
    const row = removed.rows[0];
    if (row === undefined) throw deadLetterMissing(ref);
    return toMailboxMessage(row);
  }

  /**
   * Explicit recovery operation: rebuild object accounting from committed
   * Postgres manifests. Reconciliation must run first; R2 LIST is never used as
   * billing authority and inline usage is left untouched.
   */
  async rebuildObjectUsage(tenant: TenantId): Promise<ObjectUsageRebuildResult> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        'SELECT 1 FROM storage_usage WHERE tenant_id = $1 FOR UPDATE',
        [tenant],
      );
      if (locked.rowCount === 0) {
        throw new CloudCleanupError(
          'cleanup_policy_missing',
          `Tenant ${tenant} has no storage usage row to rebuild.`,
        );
      }
      const rebuilt = await client.query<{
        readonly committed_object_bytes: bigint;
        readonly object_count: bigint;
        readonly updated_at: string;
      }>(
        `WITH authority AS MATERIALIZED (
           SELECT COALESCE(SUM(byte_size), 0)::bigint AS committed_object_bytes,
                  count(*)::bigint AS object_count
             FROM object_manifest
            WHERE tenant_id = $1 AND state = 'committed'
         )
         UPDATE storage_usage u
            SET committed_object_bytes = authority.committed_object_bytes,
                object_count = authority.object_count,
                updated_at = $2
           FROM authority
          WHERE u.tenant_id = $1
         RETURNING u.committed_object_bytes, u.object_count, u.updated_at`,
        [tenant, this.#now()],
      );
      await client.query('COMMIT');
      const row = rebuilt.rows[0]!;
      return {
        committedObjectBytes: row.committed_object_bytes,
        objectCount: row.object_count,
        updatedAt: row.updated_at,
      };
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => {});
      throw cause;
    } finally {
      client.release();
    }
  }

  async #reconcileManifests(
    client: PoolClient,
    tenant: TenantId,
    counts: MutableCounts,
  ): Promise<void> {
    const cursor = await this.#readCursor(client, tenant, 'manifest');
    const page = await client.query<ManifestMaintenanceRow>(
      `SELECT hash, byte_size, content_type, state,
              gc_accounted_bytes, gc_accounted_object
         FROM object_manifest
        WHERE tenant_id = $1
          AND state IN ('committed', 'delete_pending')
          AND hash > $2
        ORDER BY hash
        LIMIT $3`,
      [tenant, cursor ?? '', this.#batchSize],
    );
    for (const manifest of page.rows) {
      const observed = await this.#objectStorage.inspectObject(
        tenant,
        manifest.hash as ContentHash,
      );
      if (manifest.state === 'delete_pending') {
        if (observed === undefined) {
          try {
            const released = await settleDeletedObject(client, tenant, manifest.hash as ContentHash, this.#now());
            if (released !== undefined) {
              counts.objectsDeleted += 1n;
              counts.objectReleasedBytes += released;
            }
          } catch {
            counts.operationErrors += 1n;
          }
        }
        continue;
      }
      if (observed === undefined) {
        counts.missingObjects += 1n;
      } else if (
        observed.observedByteSize !== manifest.byte_size ||
        observed.observedContentType !== manifest.content_type
      ) {
        counts.shapeDrift += 1n;
      }
    }
    await this.#advanceLexicalCursor(
      client,
      tenant,
      'manifest',
      page.rows.at(-1)?.hash,
      page.rows.length,
    );
  }

  async #reconcileR2(
    client: PoolClient,
    tenant: TenantId,
    counts: MutableCounts,
  ): Promise<void> {
    const cursor = await this.#readCursor(client, tenant, 'r2');
    const page = await this.#objectStorage.listTenantObjects(
      tenant,
      cursor ?? undefined,
      this.#batchSize,
    );
    for (const object of page.objects) {
      if (object.hash === undefined) {
        counts.invalidObjectKeys += 1n;
        continue;
      }
      const manifest = await client.query<{ readonly state: string }>(
        'SELECT state FROM object_manifest WHERE tenant_id = $1 AND hash = $2',
        [tenant, object.hash],
      );
      const state = manifest.rows[0]?.state;
      if (state !== undefined && state !== 'deleted') continue;
      const observed = await this.#objectStorage.inspectObject(tenant, object.hash);
      if (observed === undefined) continue;
      const witnessed = await client.query(
        `INSERT INTO object_manifest (
           tenant_id, hash, byte_size, content_type, state, ref_count,
           created_at, updated_at, delete_pending_at,
           gc_accounted_bytes, gc_accounted_object
         ) VALUES ($1, $2, $3, $4, 'pending', 0, $5, $5, NULL, NULL, NULL)
         ON CONFLICT (tenant_id, hash) DO UPDATE
            SET byte_size = EXCLUDED.byte_size,
                content_type = EXCLUDED.content_type,
                state = 'pending', ref_count = 0,
                created_at = EXCLUDED.created_at,
                updated_at = EXCLUDED.updated_at,
                delete_pending_at = NULL,
                gc_accounted_bytes = NULL,
                gc_accounted_object = NULL
          WHERE object_manifest.state = 'deleted'
         RETURNING 1`,
        [
          tenant,
          object.hash,
          observed.observedByteSize,
          observed.observedContentType,
          this.#now(),
        ],
      );
      counts.orphanWitnessesCreated += BigInt(witnessed.rowCount ?? 0);
    }
    if (page.nextContinuationToken === undefined) {
      await this.#clearCursor(client, tenant, 'r2');
    } else {
      await this.#writeCursor(client, tenant, 'r2', page.nextContinuationToken);
    }
  }

  async #advanceLexicalCursor(
    client: PoolClient,
    tenant: TenantId,
    kind: string,
    lastValue: string | undefined,
    rowCount: number,
  ): Promise<void> {
    if (lastValue === undefined || rowCount < this.#batchSize) {
      await this.#clearCursor(client, tenant, kind);
    } else {
      await this.#writeCursor(client, tenant, kind, lastValue);
    }
  }

  async #readCursor(
    client: PoolClient,
    tenant: TenantId,
    kind: string,
  ): Promise<string | null> {
    const result = await client.query<{ readonly cursor_value: string | null }>(
      'SELECT cursor_value FROM gc_cursor WHERE tenant_id = $1 AND cursor_kind = $2',
      [tenant, kind],
    );
    return result.rows[0]?.cursor_value ?? null;
  }

  async #writeCursor(
    client: PoolClient,
    tenant: TenantId,
    kind: string,
    value: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO gc_cursor (tenant_id, cursor_kind, cursor_value, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, cursor_kind) DO UPDATE
          SET cursor_value = EXCLUDED.cursor_value, updated_at = EXCLUDED.updated_at`,
      [tenant, kind, value, this.#now()],
    );
  }

  async #clearCursor(client: PoolClient, tenant: TenantId, kind: string): Promise<void> {
    await client.query(
      'DELETE FROM gc_cursor WHERE tenant_id = $1 AND cursor_kind = $2',
      [tenant, kind],
    );
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}

/** Build the maintenance composition against the same Postgres/R2 authority. */
export function createPostgresCloudMaintenance(
  options: PostgresCloudMaintenanceOptions,
): PostgresCloudCleanup {
  const objectStorage = new R2ObjectMaintenanceStore(options.objectStorage);
  return new PostgresCloudCleanup({
    pool: options.pool,
    clock: options.clock,
    objectStorage,
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
  });
}

function emptyCounts(): MutableCounts {
  return {
    objectsDeleted: 0n,
    objectReleasedBytes: 0n,
    orphanWitnessesCreated: 0n,
    missingObjects: 0n,
    shapeDrift: 0n,
    invalidObjectKeys: 0n,
    operationErrors: 0n,
  };
}

function toMailboxMessage(row: OutboxRow): MailboxMessage {
  return {
    tenantId: tenantId(row.tenant_id),
    deviceId: row.device_id,
    seq: Number(row.seq),
    messageId: row.message_id,
    body: row.body,
    bodyHash: row.body_hash as ContentHash,
    byteSize: row.byte_size,
    state: row.state as MailboxMessageState,
    appendedAt: row.appended_at,
  };
}

interface ReplayBody {
  readonly body: string;
  readonly bodyHash: ContentHash;
  readonly byteSize: bigint;
}

function materializeReplayBody(original: OutboxRow, seq: number): ReplayBody {
  try {
    const envelope = decodeEnvelope(original.body);
    if (!isServerToDaemonType(envelope.type)) {
      throw new Error(`Envelope type ${envelope.type} is not server-to-daemon.`);
    }
    const rebound = EnvelopeSchema.parse({ ...envelope, seq });
    const body = encodeEnvelope(rebound);
    const bytes = new TextEncoder().encode(body);
    return {
      body,
      bodyHash: contentHash(`sha256:${createHash('sha256').update(bytes).digest('hex')}`),
      byteSize: BigInt(bytes.length),
    };
  } catch (cause) {
    throw new CloudCleanupError(
      'cleanup_invalid_input',
      `Dead letter ${original.device_id}/${String(original.seq)} is not a replayable server-to-daemon envelope.`,
      { cause },
    );
  }
}

function replayMatches(row: OutboxRow, original: OutboxRow): boolean {
  if (row.replay_source_seq !== original.seq) return false;
  const expected = materializeReplayBody(original, Number(row.seq));
  return (
    row.body === expected.body &&
    row.body_hash === expected.bodyHash &&
    row.byte_size === expected.byteSize
  );
}

function assertBatchSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_BATCH_SIZE) {
    throw new CloudCleanupError(
      'cleanup_invalid_input',
      `batchSize/limit must be a whole number in [1, ${String(MAX_BATCH_SIZE)}].`,
    );
  }
  return value;
}

function assertIdentifier(value: string, field: string): void {
  if (value.length === 0 || value.length > 256 || value.trim() !== value) {
    throw new CloudCleanupError(
      'cleanup_invalid_input',
      `${field} must be a non-empty, unpadded string no longer than 256 characters.`,
    );
  }
}

function assertDeadLetterRef(ref: DeadLetterRef): void {
  assertIdentifier(ref.deviceId, 'deviceId');
  if (!Number.isSafeInteger(ref.seq) || ref.seq < 1) {
    throw new CloudCleanupError(
      'cleanup_invalid_input',
      'A dead-letter seq must be a positive safe integer.',
    );
  }
}

function deadLetterMissing(ref: DeadLetterRef): CloudCleanupError {
  return new CloudCleanupError(
    'cleanup_dead_letter_not_found',
    `Expired mailbox row ${ref.deviceId}/${String(ref.seq)} was not found.`,
  );
}
