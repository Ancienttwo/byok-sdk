/**
 * Postgres {@link QuotaStore} — entitlement, usage, reservation (§12.7.6-12.7.7).
 *
 * The invariant this file exists to hold is
 * `committed + reserved + expected <= hardLimitBytes`, and the reason it is the
 * hardest statement in the slice is that the obvious shapes all get it wrong in
 * a way nothing throws about.
 *
 * **Why `reserve` opens a transaction.** Admission is one guarded
 * `INSERT ... SELECT ... WHERE`, exactly as every other CAS in this package is
 * one guarded statement. But the guard's operand is an AGGREGATE over the
 * tenant's live reservations, and under READ COMMITTED a statement's snapshot
 * is taken when the statement starts. Two concurrent reservers therefore both
 * read a pre-insert world and both pass — the classic oversell. Postgres'
 * EvalPlanQual re-check, which is what makes `UPDATE ... WHERE status = $x` a
 * genuine CAS elsewhere in this package, re-evaluates the qual only against the
 * updated TARGET row; a subquery over another table keeps the original
 * snapshot. So no single statement over this shape can serialize reservers.
 *
 * The two ways out are a counter column CAS'd in place, or a lock. The counter
 * loses: it has to be decremented on all three of finalize / abort / expire,
 * and a path that settles without decrementing leaves a tenant permanently
 * short of quota it actually released — durable drift, invisible until someone
 * audits. So `storage_usage` has NO `reserved_bytes` column and
 * `TenantStorageUsage.reservedBytes` is a `SUM` over live reservations, which
 * cannot drift, and admission takes `FOR UPDATE` on the tenant's entitlement
 * row first. The next statement in that transaction takes a FRESH snapshot,
 * acquired behind the lock, so it sees every committed reservation. This is the
 * "row-locked transaction" `packages/core/src/in-memory/quota.ts` names as the
 * Postgres shape.
 *
 * What is NOT happening here: a read whose result is compared in TypeScript and
 * then written. Every admission decision lives in the SQL guard. The reads on
 * the rejection path exist only to answer "which of the five typed rejections
 * is this", after the write has already been refused.
 *
 * Nothing in this file calls SQL `now()`. Every instant is the injected clock's,
 * so reservation expiry is assertable under a test clock — and
 * `__tests__/constraints.test.ts` scans this directory to keep it that way.
 */
import {
  ByokCoreError,
  CoreConflictError,
  assertCanonicalTimestamp,
  type Clock,
  type ContentHash,
  type MailboxUsageDeltaInput,
  type QuotaStore,
  type StorageFinalizeInput,
  type StorageFinalizeResult,
  type StorageReservation,
  type StorageReservationInput,
  type StorageReservationState,
  type StorageStatus,
  type StorageWriteKind,
  type StorageWritePosture,
  type TenantId,
  type TenantStorageEntitlement,
  type TenantStorageEntitlementInput,
  type TenantStorageUsage,
} from '@byok/core';
import type { Pool, PoolClient } from 'pg';

/** Warning threshold from §12.7.8: 80% of the hard limit. */
const WARNING_NUMERATOR = 80n;
const WARNING_DENOMINATOR = 100n;

const ENTITLEMENT_COLUMNS =
  'tenant_id, version, hard_limit_bytes, max_object_bytes, max_inline_bytes, mailbox_limit_bytes, retention_policy_id, downgrade_grace_until';

const RESERVATION_COLUMNS =
  'tenant_id, reservation_id, state, kind, expected_bytes, content_hash, content_type, created_at, expires_at, settled_at, deduplicated';

interface EntitlementRow {
  readonly tenant_id: string;
  readonly version: bigint;
  readonly hard_limit_bytes: bigint;
  readonly max_object_bytes: bigint;
  readonly max_inline_bytes: bigint;
  readonly mailbox_limit_bytes: bigint;
  readonly retention_policy_id: string;
  readonly downgrade_grace_until: string | null;
}

interface ReservationRow {
  readonly tenant_id: string;
  readonly reservation_id: string;
  readonly state: string;
  readonly kind: string;
  readonly expected_bytes: bigint;
  readonly content_hash: string;
  readonly content_type: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly settled_at: string | null;
  readonly deduplicated: boolean;
}

interface UsageRow {
  readonly committed_object_bytes: bigint;
  readonly committed_inline_bytes: bigint;
  readonly reserved_bytes: bigint;
  readonly mailbox_bytes: bigint;
  readonly object_count: bigint;
  readonly updated_at: string;
}

function toEntitlement(row: EntitlementRow): TenantStorageEntitlement {
  return {
    tenantId: row.tenant_id as TenantId,
    version: row.version,
    hardLimitBytes: row.hard_limit_bytes,
    maxObjectBytes: row.max_object_bytes,
    maxInlineBytes: row.max_inline_bytes,
    mailboxLimitBytes: row.mailbox_limit_bytes,
    retentionPolicyId: row.retention_policy_id,
    ...(row.downgrade_grace_until === null
      ? {}
      : { downgradeGraceUntil: row.downgrade_grace_until }),
  };
}

function toReservation(row: ReservationRow): StorageReservation {
  return {
    tenantId: row.tenant_id as TenantId,
    reservationId: row.reservation_id,
    state: row.state as StorageReservationState,
    kind: row.kind as StorageWriteKind,
    expectedBytes: row.expected_bytes,
    contentHash: row.content_hash as ContentHash,
    contentType: row.content_type,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
  };
}

function toUsage(row: UsageRow): TenantStorageUsage {
  return {
    committedObjectBytes: row.committed_object_bytes,
    committedInlineBytes: row.committed_inline_bytes,
    reservedBytes: row.reserved_bytes,
    mailboxBytes: row.mailbox_bytes,
    objectCount: row.object_count,
    updatedAt: row.updated_at,
  };
}

/**
 * `reservedBytes` is derived here, not stored — see the file header. The
 * `LEFT JOIN` is what lets a tenant with no usage row read as all zeros without
 * a write happening on a read path.
 */
const USAGE_SQL = `
  SELECT
    COALESCE(u.committed_object_bytes, 0)::bigint AS committed_object_bytes,
    COALESCE(u.committed_inline_bytes, 0)::bigint AS committed_inline_bytes,
    COALESCE(u.mailbox_bytes, 0)::bigint          AS mailbox_bytes,
    COALESCE(u.object_count, 0)::bigint           AS object_count,
    COALESCE(u.updated_at, $2)                    AS updated_at,
    COALESCE((SELECT SUM(r.expected_bytes) FROM storage_reservation r
               WHERE r.tenant_id = $1 AND r.state = 'reserved'), 0)::bigint AS reserved_bytes
    FROM (SELECT $1::text AS tenant_id) AS scope
    LEFT JOIN storage_usage u ON u.tenant_id = scope.tenant_id`;

export class PostgresQuotaStore implements QuotaStore {
  readonly #pool: Pool;
  readonly #clock: Clock;

  constructor(pool: Pool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async readEntitlement(tenant: TenantId): Promise<TenantStorageEntitlement | undefined> {
    const result = await this.#pool.query<EntitlementRow>(
      `SELECT ${ENTITLEMENT_COLUMNS} FROM storage_entitlement WHERE tenant_id = $1`,
      [tenant],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toEntitlement(row);
  }

  async writeEntitlement(
    tenant: TenantId,
    input: TenantStorageEntitlementInput,
  ): Promise<TenantStorageEntitlement> {
    // Validated before the version CAS and before any statement runs: an
    // unusable deadline is a bad write regardless of which version wins, and a
    // rejected entitlement must not be a partially written one.
    if (input.downgradeGraceUntil !== undefined) {
      assertCanonicalTimestamp(input.downgradeGraceUntil, 'downgradeGraceUntil');
    }

    // The `seeded` CTE is what establishes this composition's standing
    // invariant: a `storage_usage` row exists whenever a `storage_entitlement`
    // row does. Every later accounting write is then a guarded `UPDATE` rather
    // than an upsert that would have to restate its guard in two places.
    const applied = await this.#pool.query<EntitlementRow>(
      `WITH applied AS (
         INSERT INTO storage_entitlement (${ENTITLEMENT_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id) DO UPDATE
            SET version               = EXCLUDED.version,
                hard_limit_bytes      = EXCLUDED.hard_limit_bytes,
                max_object_bytes      = EXCLUDED.max_object_bytes,
                max_inline_bytes      = EXCLUDED.max_inline_bytes,
                mailbox_limit_bytes   = EXCLUDED.mailbox_limit_bytes,
                retention_policy_id   = EXCLUDED.retention_policy_id,
                downgrade_grace_until = EXCLUDED.downgrade_grace_until
          WHERE storage_entitlement.version < EXCLUDED.version
         RETURNING ${ENTITLEMENT_COLUMNS}
       ), seeded AS (
         INSERT INTO storage_usage (tenant_id, updated_at)
         SELECT $1, $9 FROM applied
         ON CONFLICT (tenant_id) DO NOTHING
         RETURNING 1
       )
       SELECT ${ENTITLEMENT_COLUMNS} FROM applied`,
      [
        tenant,
        input.version,
        input.hardLimitBytes,
        input.maxObjectBytes,
        input.maxInlineBytes,
        input.mailboxLimitBytes,
        input.retentionPolicyId,
        input.downgradeGraceUntil ?? null,
        this.#now(),
      ],
    );
    const row = applied.rows[0];
    if (row !== undefined) return toEntitlement(row);

    // The guard rejected: the stored version is at or above the one offered.
    // Version is monotonic, not merely different, so an equal version is stale
    // too — and the caller gets the row it lost to rather than a bare failure.
    const current = await this.readEntitlement(tenant);
    if (current === undefined) {
      throw new Error(`entitlement for ${tenant} vanished during a version CAS`);
    }
    throw new CoreConflictError(
      'storage_entitlement_version_conflict',
      `Entitlement is at version ${String(current.version)}; refusing to apply version ${String(input.version)}.`,
      current,
      this.#now(),
    );
  }

  async readUsage(tenant: TenantId): Promise<TenantStorageUsage> {
    const result = await this.#pool.query<UsageRow>(USAGE_SQL, [tenant, this.#now()]);
    return toUsage(result.rows[0]!);
  }

  async readStatus(tenant: TenantId): Promise<StorageStatus> {
    const entitlement = await this.readEntitlement(tenant);
    if (entitlement === undefined) throw this.#entitlementMissing();
    const usage = await this.readUsage(tenant);
    const used = usedBytes(usage);
    const graceActive = this.#graceActive(entitlement);
    return {
      entitlement,
      usage,
      posture: posture(entitlement, usage, graceActive),
      availableBytes:
        used >= entitlement.hardLimitBytes ? 0n : entitlement.hardLimitBytes - used,
      graceActive,
    };
  }

  async reserve(
    tenant: TenantId,
    input: StorageReservationInput,
  ): Promise<StorageReservation> {
    const client = await this.#pool.connect();
    let admitted: StorageReservation | undefined;
    let rejection: ByokCoreError | undefined;
    try {
      await client.query('BEGIN');

      // The serialization point. Every reserver for this tenant queues here,
      // and the guarded insert below runs on a snapshot taken AFTER the lock is
      // held — which is the only way its aggregate sees a competitor's row.
      const entitlement = await this.#lockEntitlement(client, tenant);
      if (entitlement === undefined) {
        rejection = this.#entitlementMissing();
      } else {
        const inserted = await client.query<ReservationRow>(
          `WITH ent AS (
             SELECT hard_limit_bytes, max_object_bytes, max_inline_bytes, downgrade_grace_until
               FROM storage_entitlement WHERE tenant_id = $1
           ), used AS (
             SELECT COALESCE((SELECT committed_object_bytes + committed_inline_bytes
                                FROM storage_usage WHERE tenant_id = $1), 0)::bigint
                  + COALESCE((SELECT SUM(expected_bytes) FROM storage_reservation
                               WHERE tenant_id = $1 AND state = 'reserved'), 0)::bigint
                  AS used_bytes
           )
           INSERT INTO storage_reservation
             (tenant_id, reservation_id, state, kind, expected_bytes,
              content_hash, content_type, created_at, expires_at)
           SELECT $1, $2, 'reserved', $3::text, $4::bigint, $5, $6, $7, $8
             FROM ent, used
            WHERE $4::bigint <= (CASE WHEN $3::text = 'object'
                                      THEN ent.max_object_bytes
                                      ELSE ent.max_inline_bytes END)
              AND used.used_bytes + $4::bigint <= ent.hard_limit_bytes
              AND NOT (used.used_bytes >= ent.hard_limit_bytes
                       AND ent.downgrade_grace_until IS NOT NULL
                       AND ent.downgrade_grace_until <= $9)
           ON CONFLICT (tenant_id, reservation_id) DO NOTHING
           RETURNING ${RESERVATION_COLUMNS}`,
          [
            tenant,
            input.reservationId,
            input.kind,
            input.expectedBytes,
            input.contentHash,
            input.contentType,
            this.#now(),
            this.#expiry(input.ttlMs),
            this.#now(),
          ],
        );
        const row = inserted.rows[0];
        if (row !== undefined) {
          admitted = toReservation(row);
        } else {
          const outcome = await this.#explainRefusedReservation(
            client,
            tenant,
            input,
            entitlement,
          );
          if (outcome instanceof ByokCoreError) rejection = outcome;
          else admitted = outcome;
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      // Best-effort, for the same reason the migration runner's is: a rollback
      // that throws must not replace the failure the caller needs to see.
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    // Thrown outside the transaction block so the catch above stays reserved
    // for genuine faults rather than for this store's own typed rejections.
    if (rejection !== undefined) throw rejection;
    return admitted!;
  }

  async finalizeReservation(
    tenant: TenantId,
    input: StorageFinalizeInput,
  ): Promise<StorageFinalizeResult> {
    const existing = await this.#readReservation(tenant, input.reservationId);
    if (existing === undefined) throw this.#reservationMissing(input.reservationId);

    if (existing.reservation.state === 'committed') {
      // A replayed finalize answers the same way the original did, including
      // `deduplicated` — which is why that flag is stored rather than
      // recomputed against a set this row is now a member of.
      return {
        reservation: existing.reservation,
        usage: await this.readUsage(tenant),
        deduplicated: existing.deduplicated,
      };
    }
    if (existing.reservation.state !== 'reserved') {
      throw new ByokCoreError(
        'storage_reservation_expired',
        `Reservation ${input.reservationId} is ${existing.reservation.state}.`,
      );
    }
    if (this.#now() >= existing.reservation.expiresAt) {
      await this.#settle(tenant, input.reservationId, 'expired');
      throw new ByokCoreError(
        'storage_reservation_expired',
        `Reservation ${input.reservationId} expired at ${existing.reservation.expiresAt}.`,
      );
    }
    if (
      input.observedContentHash !== existing.reservation.contentHash ||
      input.observedByteSize !== existing.reservation.expectedBytes ||
      input.observedContentType !== existing.reservation.contentType
    ) {
      // §12.7.7 step 6: a failed finalize releases the bytes and the uploaded
      // object becomes an orphan candidate for the GC worker. Releasing is the
      // state transition itself — nothing decrements a counter.
      await this.#settle(tenant, input.reservationId, 'aborted');
      throw new ByokCoreError(
        'storage_integrity_mismatch',
        `Observed object does not match reservation ${input.reservationId}.`,
      );
    }

    // One statement: the guarded transition decides, and the usage row moves
    // only for a transition that won. Per-tenant hash deduplication is computed
    // inside it against the rows already committed, so "same tenant, same hash,
    // counted once" (§12.7.6) cannot disagree with what was actually added.
    const settled = await this.#pool.query<ReservationRow>(
      `WITH settled AS (
         UPDATE storage_reservation r
            SET state        = 'committed',
                settled_at   = $3,
                deduplicated = EXISTS (SELECT 1 FROM storage_reservation p
                                        WHERE p.tenant_id = r.tenant_id
                                          AND p.content_hash = r.content_hash
                                          AND p.state = 'committed')
          WHERE r.tenant_id = $1 AND r.reservation_id = $2 AND r.state = 'reserved'
         RETURNING ${RESERVATION_COLUMNS}
       ), accounted AS (
         UPDATE storage_usage u
            SET committed_object_bytes = u.committed_object_bytes
                  + CASE WHEN s.kind = 'object' AND NOT s.deduplicated
                         THEN s.expected_bytes ELSE 0 END,
                committed_inline_bytes = u.committed_inline_bytes
                  + CASE WHEN s.kind = 'inline' AND NOT s.deduplicated
                         THEN s.expected_bytes ELSE 0 END,
                object_count = u.object_count
                  + CASE WHEN s.kind = 'object' AND NOT s.deduplicated THEN 1 ELSE 0 END,
                updated_at = $3
           FROM settled s
          WHERE u.tenant_id = $1
         RETURNING 1
       )
       SELECT ${RESERVATION_COLUMNS} FROM settled`,
      [tenant, input.reservationId, this.#now()],
    );

    const row = settled.rows[0];
    if (row === undefined) {
      // Lost the transition to a concurrent settle between the read above and
      // this statement. Report whatever actually happened rather than retrying
      // into it.
      const raced = await this.#readReservation(tenant, input.reservationId);
      if (raced !== undefined && raced.reservation.state === 'committed') {
        return {
          reservation: raced.reservation,
          usage: await this.readUsage(tenant),
          deduplicated: raced.deduplicated,
        };
      }
      throw new ByokCoreError(
        'storage_reservation_expired',
        `Reservation ${input.reservationId} was settled concurrently.`,
      );
    }

    return {
      reservation: toReservation(row),
      usage: await this.readUsage(tenant),
      deduplicated: row.deduplicated,
    };
  }

  async abortReservation(
    tenant: TenantId,
    reservationId: string,
  ): Promise<StorageReservation> {
    const existing = await this.#readReservation(tenant, reservationId);
    if (existing === undefined) throw this.#reservationMissing(reservationId);
    // Idempotent by contract: an already-settled reservation returns its
    // settled row instead of failing a retry that has nothing left to release.
    if (existing.reservation.state !== 'reserved') return existing.reservation;

    const settled = await this.#settle(tenant, reservationId, 'aborted');
    if (settled !== undefined) return settled;
    const raced = await this.#readReservation(tenant, reservationId);
    if (raced === undefined) throw this.#reservationMissing(reservationId);
    return raced.reservation;
  }

  async expireReservations(tenant: TenantId): Promise<readonly StorageReservation[]> {
    // The cutoff is the injected clock's instant, passed as a parameter. A SQL
    // `now()` here would make reservation expiry unassertable without sleeping,
    // and the suite advances a test clock instead.
    const expired = await this.#pool.query<ReservationRow>(
      `UPDATE storage_reservation
          SET state = 'expired', settled_at = $2
        WHERE tenant_id = $1 AND state = 'reserved' AND expires_at <= $2
       RETURNING ${RESERVATION_COLUMNS}`,
      [tenant, this.#now()],
    );
    return expired.rows
      .map(toReservation)
      .sort((left, right) => left.reservationId.localeCompare(right.reservationId));
  }

  async applyMailboxDelta(
    tenant: TenantId,
    input: MailboxUsageDeltaInput,
  ): Promise<TenantStorageUsage> {
    // Mailbox bytes are platform-protection accounting, not user capacity: the
    // bound is its own entitlement field. A release (negative delta) is never
    // refused and clamps at zero, so a retention sweep that double-reports
    // cannot drive the counter negative.
    const applied = await this.#pool.query(
      `WITH ent AS (
         SELECT mailbox_limit_bytes FROM storage_entitlement WHERE tenant_id = $1
       )
       UPDATE storage_usage u
          SET mailbox_bytes = GREATEST(u.mailbox_bytes + $2::bigint, 0::bigint),
              updated_at    = $3
         FROM ent
        WHERE u.tenant_id = $1
          AND ($2::bigint <= 0 OR u.mailbox_bytes + $2::bigint <= ent.mailbox_limit_bytes)
       RETURNING 1`,
      [tenant, input.deltaBytes, this.#now()],
    );

    if (applied.rowCount === 0) {
      const entitlement = await this.readEntitlement(tenant);
      if (entitlement === undefined) throw this.#entitlementMissing();
      const usage = await this.readUsage(tenant);
      throw new ByokCoreError(
        'storage_quota_exceeded',
        `Mailbox would reach ${String(usage.mailboxBytes + input.deltaBytes)} bytes, over the limit of ${String(entitlement.mailboxLimitBytes)} bytes.`,
      );
    }
    return this.readUsage(tenant);
  }

  async #lockEntitlement(
    client: PoolClient,
    tenant: TenantId,
  ): Promise<TenantStorageEntitlement | undefined> {
    const result = await client.query<EntitlementRow>(
      `SELECT ${ENTITLEMENT_COLUMNS} FROM storage_entitlement WHERE tenant_id = $1 FOR UPDATE`,
      [tenant],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toEntitlement(row);
  }

  /**
   * Names the refusal. Runs only after the guarded insert has already declined,
   * inside the same locked transaction, so the state it reads is the state that
   * refused. The order matches the contract's precedence: an existing
   * reservation is an idempotent answer, not a rejection; a suspended tenant is
   * read-only (423) before it is over-quota (507); a single oversized write is
   * 413 regardless of how much room is left.
   */
  async #explainRefusedReservation(
    client: PoolClient,
    tenant: TenantId,
    input: StorageReservationInput,
    entitlement: TenantStorageEntitlement,
  ): Promise<StorageReservation | ByokCoreError> {
    const existing = await client.query<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS} FROM storage_reservation
        WHERE tenant_id = $1 AND reservation_id = $2`,
      [tenant, input.reservationId],
    );
    const held = existing.rows[0];
    if (held !== undefined) {
      if (held.state === 'reserved') return toReservation(held);
      return new ByokCoreError(
        'storage_reservation_expired',
        `Reservation ${input.reservationId} is already ${held.state}.`,
      );
    }

    const usageResult = await client.query<UsageRow>(USAGE_SQL, [tenant, this.#now()]);
    const usage = toUsage(usageResult.rows[0]!);
    if (posture(entitlement, usage, this.#graceActive(entitlement)) === 'suspended') {
      return new ByokCoreError(
        'storage_write_suspended',
        'Tenant is over its hard limit and its downgrade grace has ended; durable writes are suspended.',
      );
    }

    const perWriteLimit =
      input.kind === 'object' ? entitlement.maxObjectBytes : entitlement.maxInlineBytes;
    if (input.expectedBytes > perWriteLimit) {
      return new ByokCoreError(
        'storage_object_too_large',
        `${String(input.expectedBytes)} bytes exceeds the ${input.kind} limit of ${String(perWriteLimit)} bytes.`,
      );
    }
    return new ByokCoreError(
      'storage_quota_exceeded',
      `Reserving ${String(input.expectedBytes)} bytes would exceed the hard limit of ${String(entitlement.hardLimitBytes)} bytes.`,
    );
  }

  async #readReservation(
    tenant: TenantId,
    reservationId: string,
  ): Promise<{ reservation: StorageReservation; deduplicated: boolean } | undefined> {
    const result = await this.#pool.query<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS} FROM storage_reservation
        WHERE tenant_id = $1 AND reservation_id = $2`,
      [tenant, reservationId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return { reservation: toReservation(row), deduplicated: row.deduplicated };
  }

  /**
   * The settle guard. `WHERE state = 'reserved'` is what makes two settlements
   * of the same reservation produce one winner; the loser gets zero rows and
   * re-reads rather than stamping a second `settled_at` over the first.
   * Releasing the reserved bytes needs no second write: they were never a
   * counter, only the sum of rows in this state.
   */
  async #settle(
    tenant: TenantId,
    reservationId: string,
    state: Exclude<StorageReservationState, 'reserved'>,
  ): Promise<StorageReservation | undefined> {
    const result = await this.#pool.query<ReservationRow>(
      `UPDATE storage_reservation
          SET state = $3, settled_at = $4
        WHERE tenant_id = $1 AND reservation_id = $2 AND state = 'reserved'
       RETURNING ${RESERVATION_COLUMNS}`,
      [tenant, reservationId, state, this.#now()],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toReservation(row);
  }

  #graceActive(entitlement: TenantStorageEntitlement): boolean {
    return (
      entitlement.downgradeGraceUntil !== undefined &&
      this.#now() < entitlement.downgradeGraceUntil
    );
  }

  #entitlementMissing(): ByokCoreError {
    return new ByokCoreError(
      'storage_entitlement_missing',
      'No storage entitlement has been issued for this tenant.',
    );
  }

  #reservationMissing(reservationId: string): ByokCoreError {
    return new ByokCoreError(
      'storage_reservation_not_found',
      `Reservation ${reservationId} does not exist in this tenant.`,
    );
  }

  #expiry(ttlMs: number): string {
    return new Date(this.#clock.now().getTime() + ttlMs).toISOString();
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}

function usedBytes(usage: TenantStorageUsage): bigint {
  return usage.committedObjectBytes + usage.committedInlineBytes + usage.reservedBytes;
}

/**
 * Effective write posture (§12.7.8). A tenant that was downgraded gets its
 * configured grace window; once it ends and usage is still over the limit, the
 * tenant is read-only (423) rather than merely unable to add bytes (507).
 */
function posture(
  entitlement: TenantStorageEntitlement,
  usage: TenantStorageUsage,
  graceActive: boolean,
): StorageWritePosture {
  const used = usedBytes(usage);
  if (used >= entitlement.hardLimitBytes) {
    const graceConfigured = entitlement.downgradeGraceUntil !== undefined;
    return graceConfigured && !graceActive ? 'suspended' : 'blocked';
  }
  if (
    entitlement.hardLimitBytes > 0n &&
    used * WARNING_DENOMINATOR >= entitlement.hardLimitBytes * WARNING_NUMERATOR
  ) {
    return 'warning';
  }
  return 'normal';
}
