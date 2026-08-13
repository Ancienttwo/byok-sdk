/**
 * Host-owned S4B-c maintenance for the Postgres + R2 composition.
 *
 * Postgres remains the manifest/accounting authority. R2 is touched only after
 * a durable `delete_pending` tombstone, and a missing object is an idempotent
 * DELETE replay — never evidence that a committed manifest was truthful.
 */
import { createHash } from 'node:crypto';
import {
  ByokCoreError,
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
import {
  R2ObjectMaintenanceStore,
  type R2BlobStoreOptions,
  type R2ObjectMaintenance,
} from './stores/r2-blobs';
import { allocateMailboxSequence } from './stores/core/mailbox-sequence';

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1000;
const ADVISORY_LOCK_NAMESPACE = 1_106_736_963;
const OUTBOX_COLUMNS =
  'tenant_id, device_id, seq, message_id, body, body_hash, byte_size, state, appended_at, replay_source_seq';

export const CLOUD_CLEANUP_ERROR_CODES = {
  cleanup_invalid_input: 'cleanup_invalid_input',
  cleanup_policy_missing: 'cleanup_policy_missing',
  cleanup_job_running: 'cleanup_job_running',
  cleanup_dead_letter_not_found: 'cleanup_dead_letter_not_found',
  cleanup_accounting_drift: 'cleanup_accounting_drift',
} as const;

export type CloudCleanupErrorCode =
  (typeof CLOUD_CLEANUP_ERROR_CODES)[keyof typeof CLOUD_CLEANUP_ERROR_CODES];

export class CloudCleanupError extends Error {
  readonly code: CloudCleanupErrorCode;

  constructor(code: CloudCleanupErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CloudCleanupError';
    this.code = code;
  }
}

export interface TenantRetentionPolicyInput {
  readonly policyId: string;
  readonly mailboxAckedRetentionMs: bigint;
  readonly mailboxUnackedRetentionMs: bigint;
  readonly requestReceiptRetentionMs: bigint;
  readonly objectOrphanGraceMs: bigint;
}

export interface TenantRetentionPolicy extends TenantRetentionPolicyInput {
  readonly tenantId: TenantId;
  readonly updatedAt: string;
}

export type CleanupJobState = 'running' | 'completed' | 'completed_with_errors' | 'failed';

export interface CloudCleanupResult {
  readonly tenantId: TenantId;
  readonly jobId: string;
  readonly state: CleanupJobState;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly mailboxDeletedCount: bigint;
  readonly mailboxExpiredCount: bigint;
  readonly mailboxReleasedBytes: bigint;
  readonly reservationsExpired: bigint;
  readonly ttlRowsDeleted: bigint;
  readonly objectsTombstoned: bigint;
  readonly objectsDeleted: bigint;
  readonly objectReleasedBytes: bigint;
  readonly orphanWitnessesCreated: bigint;
  readonly missingObjects: bigint;
  readonly shapeDrift: bigint;
  readonly invalidObjectKeys: bigint;
  readonly operationErrors: bigint;
  readonly errorMessage?: string;
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
  readonly pool: Pool;
  readonly clock: Clock;
  readonly objectStorage: R2ObjectMaintenance;
  readonly batchSize?: number;
}

export interface PostgresCloudMaintenanceOptions {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly objectStorage: Omit<R2BlobStoreOptions, 'objects'>;
  readonly batchSize?: number;
}

interface RetentionPolicyRow {
  readonly tenant_id: string;
  readonly policy_id: string;
  readonly mailbox_acked_retention_ms: bigint;
  readonly mailbox_unacked_retention_ms: bigint;
  readonly request_receipt_retention_ms: bigint;
  readonly object_orphan_grace_ms: bigint;
  readonly updated_at: string;
}

interface CleanupJobRow {
  readonly tenant_id: string;
  readonly job_id: string;
  readonly state: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly mailbox_deleted_count: bigint;
  readonly mailbox_expired_count: bigint;
  readonly mailbox_released_bytes: bigint;
  readonly reservations_expired: bigint;
  readonly ttl_rows_deleted: bigint;
  readonly objects_tombstoned: bigint;
  readonly objects_deleted: bigint;
  readonly object_released_bytes: bigint;
  readonly orphan_witnesses_created: bigint;
  readonly missing_objects: bigint;
  readonly shape_drift: bigint;
  readonly invalid_object_keys: bigint;
  readonly operation_errors: bigint;
  readonly error_message: string | null;
}

interface RetentionResultRow {
  readonly mailbox_deleted_count: bigint;
  readonly mailbox_expired_count: bigint;
  readonly mailbox_released_bytes: bigint;
  readonly usage_accounted: bigint;
  readonly reservations_expired: bigint;
  readonly ttl_rows_deleted: bigint;
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
  mailboxDeletedCount: bigint;
  mailboxExpiredCount: bigint;
  mailboxReleasedBytes: bigint;
  reservationsExpired: bigint;
  ttlRowsDeleted: bigint;
  objectsTombstoned: bigint;
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
    this.#pool = options.pool;
    this.#clock = options.clock;
    this.#objectStorage = options.objectStorage;
    this.#batchSize = assertBatchSize(options.batchSize ?? DEFAULT_BATCH_SIZE);
  }

  async writeRetentionPolicy(
    tenant: TenantId,
    input: TenantRetentionPolicyInput,
  ): Promise<TenantRetentionPolicy> {
    assertPolicy(input);
    const written = await this.#pool.query<RetentionPolicyRow>(
       `INSERT INTO tenant_retention_policy (
         tenant_id, policy_id, mailbox_acked_retention_ms,
         mailbox_unacked_retention_ms, request_receipt_retention_ms,
         object_orphan_grace_ms, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, policy_id) DO UPDATE
          SET mailbox_acked_retention_ms = EXCLUDED.mailbox_acked_retention_ms,
              mailbox_unacked_retention_ms = EXCLUDED.mailbox_unacked_retention_ms,
              request_receipt_retention_ms = EXCLUDED.request_receipt_retention_ms,
              object_orphan_grace_ms = EXCLUDED.object_orphan_grace_ms,
              updated_at = EXCLUDED.updated_at
       RETURNING tenant_id, policy_id, mailbox_acked_retention_ms,
                 mailbox_unacked_retention_ms, request_receipt_retention_ms,
                 object_orphan_grace_ms, updated_at`,
      [
        tenant,
        input.policyId,
        input.mailboxAckedRetentionMs,
        input.mailboxUnackedRetentionMs,
        input.requestReceiptRetentionMs,
        input.objectOrphanGraceMs,
        this.#now(),
      ],
    );
    return toPolicy(written.rows[0]!);
  }

  async readRetentionPolicy(tenant: TenantId): Promise<TenantRetentionPolicy> {
    return this.#readRetentionPolicy(this.#pool, tenant);
  }

  /** Run one bounded tenant maintenance cycle. Completed job ids are replay-safe. */
  async runTenant(tenant: TenantId, jobId: string): Promise<CloudCleanupResult> {
    assertIdentifier(jobId, 'jobId');
    const client = await this.#pool.connect();
    let jobStarted = false;
    try {
      const lock = await client.query<{ readonly locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS locked',
        [tenant, ADVISORY_LOCK_NAMESPACE],
      );
      if (lock.rows[0]?.locked !== true) {
        throw new CloudCleanupError(
          'cleanup_job_running',
          `A cleanup job is already running for tenant ${tenant}.`,
        );
      }

      const replay = await this.#startJob(client, tenant, jobId);
      if (replay !== undefined) return replay;
      jobStarted = true;

      const policy = await this.#readRetentionPolicy(client, tenant);
      const counts = emptyCounts();
      const retention = await this.#runRetention(client, tenant, policy);
      counts.mailboxDeletedCount = retention.mailbox_deleted_count;
      counts.mailboxExpiredCount = retention.mailbox_expired_count;
      counts.mailboxReleasedBytes = retention.mailbox_released_bytes;
      counts.reservationsExpired = retention.reservations_expired;
      counts.ttlRowsDeleted = retention.ttl_rows_deleted;

      const orphanCutoff = cutoff(this.#clock.now(), policy.objectOrphanGraceMs);
      counts.objectsTombstoned = await this.#markTombstones(client, tenant, orphanCutoff);

      const deleteCursor = await this.#readCursor(client, tenant, 'delete');
      const pending = await client.query<ManifestMaintenanceRow>(
        `SELECT hash, byte_size, content_type, state,
                gc_accounted_bytes, gc_accounted_object
           FROM object_manifest
          WHERE tenant_id = $1
            AND state = 'delete_pending'
            AND gc_accounted_bytes IS NOT NULL
            AND gc_accounted_object IS NOT NULL
            AND hash > $2
          ORDER BY hash
          LIMIT $3`,
        [tenant, deleteCursor ?? '', this.#batchSize],
      );
      for (const manifest of pending.rows) {
        try {
          await this.#objectStorage.deleteObject(tenant, manifest.hash as ContentHash);
          const released = await this.#settleDeleted(client, tenant, manifest.hash as ContentHash);
          if (released !== undefined) {
            counts.objectsDeleted += 1n;
            counts.objectReleasedBytes += released;
          }
        } catch {
          // The tombstone is the retry record. Preserve it and expose the
          // failure count; a later run repeats DELETE and settlement.
          counts.operationErrors += 1n;
        }
      }
      await this.#advanceLexicalCursor(
        client,
        tenant,
        'delete',
        pending.rows.at(-1)?.hash,
        pending.rows.length,
      );

      await this.#reconcileManifests(client, tenant, counts);
      await this.#reconcileR2(client, tenant, counts);

      const state: CleanupJobState =
        counts.operationErrors === 0n ? 'completed' : 'completed_with_errors';
      return this.#finishJob(client, tenant, jobId, state, counts);
    } catch (cause) {
      if (jobStarted) {
        await this.#failJob(client, tenant, jobId, cause).catch(() => {});
      }
      throw cause;
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtextextended($1, $2))', [
          tenant,
          ADVISORY_LOCK_NAMESPACE,
        ])
        .catch(() => {});
      client.release();
    }
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

  /** Clone an expired row to a new monotonic seq. The original remains evidence. */
  async replayDeadLetter(
    tenant: TenantId,
    input: DeadLetterReplayInput,
  ): Promise<MailboxMessage> {
    assertDeadLetterRef(input);
    assertIdentifier(input.replayMessageId, 'replayMessageId');
    const client = await this.#pool.connect();
    let result: MailboxMessage | undefined;
    let rejection: Error | undefined;
    let rollbackAllocation = false;
    try {
      await client.query('BEGIN');
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
        const existing = existingResult.rows[0];
        if (existing !== undefined) {
          if (!replayMatches(existing, original)) {
            rejection = new CloudCleanupError(
              'cleanup_invalid_input',
              `Replay id ${input.replayMessageId} already binds a different replay delivery.`,
            );
          } else {
            result = toMailboxMessage(existing);
          }
        } else {
          const entitlement = await client.query<{
            readonly mailbox_limit_bytes: bigint;
            readonly mailbox_bytes: bigint;
          }>(
            `SELECT e.mailbox_limit_bytes, u.mailbox_bytes
               FROM storage_entitlement e
               JOIN storage_usage u ON u.tenant_id = e.tenant_id
              WHERE e.tenant_id = $1
              FOR UPDATE OF e, u`,
            [tenant],
          );
          const capacity = entitlement.rows[0];
          // A different dead-letter row may race on the same operator-issued
          // replay id. The usage lock above is the serialization point; read
          // the idempotency key again after acquiring it so the loser returns
          // the winner instead of surfacing a raw unique violation.
          const serializedExisting = await client.query<OutboxRow>(
            `SELECT ${OUTBOX_COLUMNS} FROM outbox
              WHERE tenant_id = $1 AND device_id = $2 AND message_id = $3`,
            [tenant, input.deviceId, input.replayMessageId],
          );
          const winner = serializedExisting.rows[0];
          if (winner !== undefined) {
            if (!replayMatches(winner, original)) {
              rejection = new CloudCleanupError(
                'cleanup_invalid_input',
                `Replay id ${input.replayMessageId} already binds a different replay delivery.`,
              );
            } else {
              result = toMailboxMessage(winner);
            }
          } else if (capacity === undefined) {
            rejection = new CloudCleanupError(
              'cleanup_policy_missing',
              `Tenant ${tenant} has no storage entitlement/usage row.`,
            );
          } else {
            // Hold the same per-device allocator lock as normal mailbox append
            // until the rebound envelope row is inserted. This keeps replay
            // commits ordered with live offers.
            const seq = await allocateMailboxSequence(
              client,
              tenant,
              input.deviceId,
              this.#now(),
            );
            // Normal mailbox append uses this same device lock. Recheck after
            // acquiring it so an append that won between the usage check and
            // allocation resolves through typed idempotency rather than a raw
            // unique violation. Roll back the unused allocation either way.
            const afterAllocation = await client.query<OutboxRow>(
              `SELECT ${OUTBOX_COLUMNS} FROM outbox
                WHERE tenant_id = $1 AND device_id = $2 AND message_id = $3`,
              [tenant, input.deviceId, input.replayMessageId],
            );
            const appendWinner = afterAllocation.rows[0];
            if (appendWinner !== undefined) {
              rollbackAllocation = true;
              if (!replayMatches(appendWinner, original)) {
                rejection = new CloudCleanupError(
                  'cleanup_invalid_input',
                  `Replay id ${input.replayMessageId} already binds a different replay delivery.`,
                );
              } else {
                result = toMailboxMessage(appendWinner);
              }
            } else {
              const rebound = materializeReplayBody(original, seq);
              if (capacity.mailbox_bytes + rebound.byteSize > capacity.mailbox_limit_bytes) {
                rejection = new ByokCoreError(
                  'storage_quota_exceeded',
                  `Replaying the dead letter would exceed tenant ${tenant}'s mailbox limit.`,
                );
              } else {
                const inserted = await client.query<OutboxRow>(
                  `INSERT INTO outbox (${OUTBOX_COLUMNS})
                   VALUES ($1, $2, $3::bigint, $4, $5, $6, $7::bigint, 'pending', $8, $9)
                   RETURNING ${OUTBOX_COLUMNS}`,
                  [
                    tenant,
                    input.deviceId,
                    seq,
                    input.replayMessageId,
                    rebound.body,
                    rebound.bodyHash,
                    rebound.byteSize,
                    this.#now(),
                    original.seq,
                  ],
                );
                await client.query(
                  `UPDATE storage_usage
                      SET mailbox_bytes = mailbox_bytes + $2::bigint, updated_at = $3
                    WHERE tenant_id = $1`,
                  [tenant, rebound.byteSize, this.#now()],
                );
                result = toMailboxMessage(inserted.rows[0]!);
              }
            }
          }
        }
      }
      if (rejection === undefined && !rollbackAllocation) await client.query('COMMIT');
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

  /** Explicit operator discard. Automatic retention never deletes dead letters. */
  async discardDeadLetter(tenant: TenantId, ref: DeadLetterRef): Promise<MailboxMessage> {
    assertDeadLetterRef(ref);
    const client = await this.#pool.connect();
    let row: OutboxRow | undefined;
    let rejection: Error | undefined;
    try {
      await client.query('BEGIN');
      const existing = await client.query<OutboxRow>(
        `SELECT ${OUTBOX_COLUMNS} FROM outbox
          WHERE tenant_id = $1 AND device_id = $2 AND seq = $3::bigint
            AND state = 'expired'
          FOR UPDATE`,
        [tenant, ref.deviceId, ref.seq],
      );
      const deadLetter = existing.rows[0];
      const usage = await client.query<{ readonly mailbox_bytes: bigint }>(
        'SELECT mailbox_bytes FROM storage_usage WHERE tenant_id = $1 FOR UPDATE',
        [tenant],
      );
      if (deadLetter === undefined) {
        rejection = deadLetterMissing(ref);
      } else if (usage.rows[0] === undefined || usage.rows[0].mailbox_bytes < deadLetter.byte_size) {
        rejection = new CloudCleanupError(
          'cleanup_accounting_drift',
          `Mailbox accounting cannot release dead letter ${ref.deviceId}/${String(ref.seq)}.`,
        );
      } else {
        const removed = await client.query<OutboxRow>(
          `DELETE FROM outbox
            WHERE tenant_id = $1 AND device_id = $2 AND seq = $3::bigint
              AND state = 'expired'
            RETURNING ${OUTBOX_COLUMNS}`,
          [tenant, ref.deviceId, ref.seq],
        );
        await client.query(
          `UPDATE storage_usage
              SET mailbox_bytes = mailbox_bytes - $2::bigint, updated_at = $3
            WHERE tenant_id = $1`,
          [tenant, deadLetter.byte_size, this.#now()],
        );
        row = removed.rows[0];
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
    return toMailboxMessage(row!);
  }

  /**
   * Explicit recovery operation: rebuild object accounting from committed
   * Postgres manifests. Reconciliation must run first; R2 LIST is never used as
   * billing authority and inline/mailbox usage is left untouched.
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

  async #readRetentionPolicy(
    queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
    tenant: TenantId,
  ): Promise<TenantRetentionPolicy> {
    const result = await queryable.query<RetentionPolicyRow>(
      `SELECT p.tenant_id, p.policy_id, p.mailbox_acked_retention_ms,
              p.mailbox_unacked_retention_ms, p.request_receipt_retention_ms,
              p.object_orphan_grace_ms, p.updated_at
         FROM storage_entitlement e
         JOIN tenant_retention_policy p
           ON p.tenant_id = e.tenant_id AND p.policy_id = e.retention_policy_id
        WHERE e.tenant_id = $1`,
      [tenant],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new CloudCleanupError(
        'cleanup_policy_missing',
        `Tenant ${tenant} has no retention policy matching its entitlement.`,
      );
    }
    const policy = toPolicy(row);
    assertPolicy(policy);
    return policy;
  }

  async #startJob(
    client: PoolClient,
    tenant: TenantId,
    jobId: string,
  ): Promise<CloudCleanupResult | undefined> {
    const now = this.#now();
    const started = await client.query<CleanupJobRow>(
      `INSERT INTO cleanup_job (tenant_id, job_id, kind, state, started_at)
       VALUES ($1, $2, 'tenant_cleanup', 'running', $3)
       ON CONFLICT (tenant_id, job_id) DO UPDATE
          SET state = 'running', started_at = EXCLUDED.started_at,
              finished_at = NULL, error_message = NULL
        WHERE cleanup_job.state IN ('running', 'failed')
       RETURNING ${JOB_COLUMNS}`,
      [tenant, jobId, now],
    );
    if (started.rows[0] !== undefined) return undefined;
    const existing = await this.#readJob(client, tenant, jobId);
    return toCleanupResult(existing);
  }

  async #runRetention(
    client: PoolClient,
    tenant: TenantId,
    policy: TenantRetentionPolicy,
  ): Promise<RetentionResultRow> {
    const ackedBefore = cutoff(this.#clock.now(), policy.mailboxAckedRetentionMs);
    const expireBefore = cutoff(this.#clock.now(), policy.mailboxUnackedRetentionMs);
    const receiptBefore = cutoff(this.#clock.now(), policy.requestReceiptRetentionMs);
    const now = this.#now();
    try {
      await client.query('BEGIN');
      const swept = await client.query<RetentionResultRow>(
        `WITH deleted AS (
           DELETE FROM outbox
            WHERE tenant_id = $1 AND state = 'acked' AND appended_at < $2
           RETURNING byte_size
         ), released AS MATERIALIZED (
           SELECT COALESCE(SUM(byte_size), 0)::bigint AS bytes FROM deleted
         ), expired AS (
           UPDATE outbox SET state = 'expired'
            WHERE tenant_id = $1 AND state = 'pending' AND appended_at < $3
           RETURNING 1
         ), reservations AS (
           UPDATE storage_reservation SET state = 'expired', settled_at = $4
            WHERE tenant_id = $1 AND state = 'reserved' AND expires_at <= $4
           RETURNING 1
         ), nonces AS (
           DELETE FROM auth_nonce
            WHERE tenant_id = $1 AND (used OR expires_at <= $4::timestamptz)
           RETURNING 1
         ), pairing_codes AS (
           DELETE FROM pairing_code
            WHERE tenant_id = $1
              AND (redeemed_at IS NOT NULL OR expires_at <= $4::timestamptz)
           RETURNING 1
         ), receipts AS (
           DELETE FROM device_request_receipts
            WHERE tenant_id = $1 AND recorded_at < $5::timestamptz
           RETURNING 1
         ), presence AS (
           DELETE FROM device_presence
            WHERE tenant_id = $1 AND expires_at <= $4
           RETURNING 1
         ), activity AS (
           DELETE FROM activity_tail
            WHERE tenant_id = $1 AND expires_at <= $4
           RETURNING 1
         ), accounted AS (
           UPDATE storage_usage u
              SET mailbox_bytes = u.mailbox_bytes - released.bytes, updated_at = $4
             FROM released
            WHERE u.tenant_id = $1 AND u.mailbox_bytes >= released.bytes
           RETURNING released.bytes
         )
         SELECT (SELECT count(*) FROM deleted)::bigint AS mailbox_deleted_count,
                (SELECT count(*) FROM expired)::bigint AS mailbox_expired_count,
                (SELECT bytes FROM released)::bigint AS mailbox_released_bytes,
                (SELECT count(*) FROM accounted)::bigint AS usage_accounted,
                (SELECT count(*) FROM reservations)::bigint AS reservations_expired,
                ((SELECT count(*) FROM nonces)
                 + (SELECT count(*) FROM pairing_codes)
                 + (SELECT count(*) FROM receipts)
                 + (SELECT count(*) FROM presence)
                 + (SELECT count(*) FROM activity))::bigint AS ttl_rows_deleted`,
        [tenant, ackedBefore, expireBefore, now, receiptBefore],
      );
      const result = swept.rows[0]!;
      if (result.usage_accounted !== 1n) {
        throw new CloudCleanupError(
          'cleanup_accounting_drift',
          `Mailbox accounting cannot release ${String(result.mailbox_released_bytes)} deleted bytes for tenant ${tenant}.`,
        );
      }
      await client.query('COMMIT');
      return result;
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => {});
      throw cause;
    }
  }

  async #markTombstones(
    client: PoolClient,
    tenant: TenantId,
    orphanCutoff: string,
  ): Promise<bigint> {
    try {
      await client.query('BEGIN');
      // Reservation admission uses this same tenant row as its serialization
      // point. Acquiring it before the candidate statement gives that
      // statement a fresh snapshot after every already-started reservation,
      // while later reservations see `delete_pending` and fail closed.
      await client.query(
        'SELECT 1 FROM storage_entitlement WHERE tenant_id = $1 FOR UPDATE',
        [tenant],
      );
      const marked = await client.query<{ readonly hash: string }>(
        `WITH candidates AS MATERIALIZED (
         SELECT m.tenant_id, m.hash
           FROM object_manifest m
          WHERE m.tenant_id = $1
            AND m.state IN ('pending', 'committed')
            AND m.ref_count = 0
            AND m.updated_at < $2
            AND NOT EXISTS (
              SELECT 1 FROM object_reference r
               WHERE r.tenant_id = m.tenant_id AND r.hash = m.hash
            )
            AND NOT EXISTS (
              SELECT 1 FROM storage_reservation s
               WHERE s.tenant_id = m.tenant_id AND s.content_hash = m.hash
                 AND s.state = 'reserved'
            )
          ORDER BY m.updated_at, m.hash
          LIMIT $3
          FOR UPDATE OF m SKIP LOCKED
       )
       UPDATE object_manifest m
          SET gc_accounted_bytes = CASE WHEN m.state = 'committed' THEN m.byte_size ELSE 0 END,
              gc_accounted_object = (m.state = 'committed'),
              state = 'delete_pending', delete_pending_at = $4, updated_at = $4
         FROM candidates c
        WHERE m.tenant_id = c.tenant_id AND m.hash = c.hash
       RETURNING m.hash`,
        [tenant, orphanCutoff, this.#batchSize, this.#now()],
      );
      await client.query('COMMIT');
      return BigInt(marked.rowCount ?? 0);
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => {});
      throw cause;
    }
  }

  async #settleDeleted(
    client: PoolClient,
    tenant: TenantId,
    hash: ContentHash,
  ): Promise<bigint | undefined> {
    const settled = await client.query<{
      readonly gc_accounted_bytes: bigint;
    }>(
      `WITH candidate AS MATERIALIZED (
         SELECT m.gc_accounted_bytes, m.gc_accounted_object
           FROM object_manifest m
           JOIN storage_usage u ON u.tenant_id = m.tenant_id
          WHERE m.tenant_id = $1 AND m.hash = $2
            AND m.state = 'delete_pending'
            AND m.ref_count = 0
            AND m.gc_accounted_bytes IS NOT NULL
            AND m.gc_accounted_object IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM object_reference r
               WHERE r.tenant_id = m.tenant_id AND r.hash = m.hash
            )
            AND u.committed_object_bytes >= m.gc_accounted_bytes
            AND u.object_count >= CASE WHEN m.gc_accounted_object THEN 1 ELSE 0 END
          FOR UPDATE OF m, u
       ), moved AS (
         UPDATE object_manifest m
            SET state = 'deleted', updated_at = $3
           FROM candidate c
          WHERE m.tenant_id = $1 AND m.hash = $2 AND m.state = 'delete_pending'
         RETURNING c.gc_accounted_bytes, c.gc_accounted_object
       ), accounted AS (
         UPDATE storage_usage u
            SET committed_object_bytes = u.committed_object_bytes - moved.gc_accounted_bytes,
                object_count = u.object_count - CASE WHEN moved.gc_accounted_object THEN 1 ELSE 0 END,
                updated_at = $3
           FROM moved
          WHERE u.tenant_id = $1
         RETURNING moved.gc_accounted_bytes
       )
       SELECT gc_accounted_bytes FROM accounted`,
      [tenant, hash, this.#now()],
    );
    const row = settled.rows[0];
    if (row !== undefined) return row.gc_accounted_bytes;
    const current = await client.query<{ readonly state: string }>(
      'SELECT state FROM object_manifest WHERE tenant_id = $1 AND hash = $2',
      [tenant, hash],
    );
    if (current.rows[0]?.state === 'deleted') return undefined;
    throw new CloudCleanupError(
      'cleanup_accounting_drift',
      `Object ${hash} could not settle its delete tombstone against storage usage.`,
    );
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
            const released = await this.#settleDeleted(
              client,
              tenant,
              manifest.hash as ContentHash,
            );
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

  async #finishJob(
    client: PoolClient,
    tenant: TenantId,
    jobId: string,
    state: CleanupJobState,
    counts: MutableCounts,
  ): Promise<CloudCleanupResult> {
    const finished = await client.query<CleanupJobRow>(
      `UPDATE cleanup_job SET
         state = $3, finished_at = $4,
         mailbox_deleted_count = $5, mailbox_expired_count = $6,
         mailbox_released_bytes = $7, reservations_expired = $8,
         ttl_rows_deleted = $9,
         objects_tombstoned = $10, objects_deleted = $11,
         object_released_bytes = $12, orphan_witnesses_created = $13,
         missing_objects = $14, shape_drift = $15,
         invalid_object_keys = $16, operation_errors = $17,
         error_message = NULL
       WHERE tenant_id = $1 AND job_id = $2
       RETURNING ${JOB_COLUMNS}`,
      [
        tenant,
        jobId,
        state,
        this.#now(),
        counts.mailboxDeletedCount,
        counts.mailboxExpiredCount,
        counts.mailboxReleasedBytes,
        counts.reservationsExpired,
        counts.ttlRowsDeleted,
        counts.objectsTombstoned,
        counts.objectsDeleted,
        counts.objectReleasedBytes,
        counts.orphanWitnessesCreated,
        counts.missingObjects,
        counts.shapeDrift,
        counts.invalidObjectKeys,
        counts.operationErrors,
      ],
    );
    return toCleanupResult(finished.rows[0]!);
  }

  async #failJob(
    client: PoolClient,
    tenant: TenantId,
    jobId: string,
    cause: unknown,
  ): Promise<void> {
    const message = (cause instanceof Error ? cause.message : String(cause)).slice(0, 2000);
    await client.query(
      `UPDATE cleanup_job
          SET state = 'failed', finished_at = $3, error_message = $4
        WHERE tenant_id = $1 AND job_id = $2`,
      [tenant, jobId, this.#now(), message],
    );
  }

  async #readJob(client: PoolClient, tenant: TenantId, jobId: string): Promise<CleanupJobRow> {
    const result = await client.query<CleanupJobRow>(
      `SELECT ${JOB_COLUMNS} FROM cleanup_job WHERE tenant_id = $1 AND job_id = $2`,
      [tenant, jobId],
    );
    return result.rows[0]!;
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

const JOB_COLUMNS = [
  'tenant_id',
  'job_id',
  'state',
  'started_at',
  'finished_at',
  'mailbox_deleted_count',
  'mailbox_expired_count',
  'mailbox_released_bytes',
  'reservations_expired',
  'ttl_rows_deleted',
  'objects_tombstoned',
  'objects_deleted',
  'object_released_bytes',
  'orphan_witnesses_created',
  'missing_objects',
  'shape_drift',
  'invalid_object_keys',
  'operation_errors',
  'error_message',
].join(', ');

function emptyCounts(): MutableCounts {
  return {
    mailboxDeletedCount: 0n,
    mailboxExpiredCount: 0n,
    mailboxReleasedBytes: 0n,
    reservationsExpired: 0n,
    ttlRowsDeleted: 0n,
    objectsTombstoned: 0n,
    objectsDeleted: 0n,
    objectReleasedBytes: 0n,
    orphanWitnessesCreated: 0n,
    missingObjects: 0n,
    shapeDrift: 0n,
    invalidObjectKeys: 0n,
    operationErrors: 0n,
  };
}

function toPolicy(row: RetentionPolicyRow): TenantRetentionPolicy {
  return {
    tenantId: tenantId(row.tenant_id),
    policyId: row.policy_id,
    mailboxAckedRetentionMs: row.mailbox_acked_retention_ms,
    mailboxUnackedRetentionMs: row.mailbox_unacked_retention_ms,
    requestReceiptRetentionMs: row.request_receipt_retention_ms,
    objectOrphanGraceMs: row.object_orphan_grace_ms,
    updatedAt: row.updated_at,
  };
}

function toCleanupResult(row: CleanupJobRow): CloudCleanupResult {
  return {
    tenantId: tenantId(row.tenant_id),
    jobId: row.job_id,
    state: row.state as CleanupJobState,
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    mailboxDeletedCount: row.mailbox_deleted_count,
    mailboxExpiredCount: row.mailbox_expired_count,
    mailboxReleasedBytes: row.mailbox_released_bytes,
    reservationsExpired: row.reservations_expired,
    ttlRowsDeleted: row.ttl_rows_deleted,
    objectsTombstoned: row.objects_tombstoned,
    objectsDeleted: row.objects_deleted,
    objectReleasedBytes: row.object_released_bytes,
    orphanWitnessesCreated: row.orphan_witnesses_created,
    missingObjects: row.missing_objects,
    shapeDrift: row.shape_drift,
    invalidObjectKeys: row.invalid_object_keys,
    operationErrors: row.operation_errors,
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
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

function assertPolicy(input: TenantRetentionPolicyInput): void {
  assertIdentifier(input.policyId, 'policyId');
  for (const [field, value] of [
    ['mailboxAckedRetentionMs', input.mailboxAckedRetentionMs],
    ['mailboxUnackedRetentionMs', input.mailboxUnackedRetentionMs],
    ['requestReceiptRetentionMs', input.requestReceiptRetentionMs],
    ['objectOrphanGraceMs', input.objectOrphanGraceMs],
  ] as const) {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CloudCleanupError(
        'cleanup_invalid_input',
        `${field} must be a non-negative duration no larger than Number.MAX_SAFE_INTEGER milliseconds.`,
      );
    }
  }
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

function cutoff(now: Date, durationMs: bigint): string {
  return new Date(now.getTime() - Number(durationMs)).toISOString();
}

function deadLetterMissing(ref: DeadLetterRef): CloudCleanupError {
  return new CloudCleanupError(
    'cleanup_dead_letter_not_found',
    `Expired mailbox row ${ref.deviceId}/${String(ref.seq)} was not found.`,
  );
}
