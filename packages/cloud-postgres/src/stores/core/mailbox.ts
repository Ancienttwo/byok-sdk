/**
 * Postgres {@link MailboxStore} (§12.7.3).
 *
 * The load-bearing rule, and the one a composition can break silently:
 * **reading is not acknowledging.** `readAfter` is a `SELECT` and nothing else.
 * The only ack is `advanceCursor`, which the daemon calls after it has durably
 * journaled the envelope, and it is monotonic — a lower cursor is refused with
 * the cursor it lost to rather than quietly re-delivering work the device has
 * already run.
 *
 * `collectRetired` deletes acked rows and **marks** unacked ones `expired`. It
 * never deletes an unacked row. §12.7.5 requires an envelope that aged out
 * before anyone consumed it to stay visible; deleting it would make "we dropped
 * work" indistinguishable from "there was no work", and dead-lettering those
 * rows is S4B's job (O-009), not this one's.
 *
 * Every row lives under `(tenant_id, device_id, seq)`, so a cross-tenant read
 * is not denied — it addresses a different key space and finds nothing. That is
 * the SQL expression of §12.6.2 layer 3: there is no bare device index to
 * accidentally query.
 */
import {
  ByokCoreError,
  CoreConflictError,
  assertCanonicalTimestamp,
  type Clock,
  type ContentHash,
  type MailboxAdvanceCursorInput,
  type MailboxAppendInput,
  type MailboxCursorState,
  type MailboxMessage,
  type MailboxMessageState,
  type MailboxPage,
  type MailboxReadQuery,
  type MailboxRetentionInput,
  type MailboxRetentionResult,
  type MailboxStore,
  type TenantId,
} from '@byok/core';
import type { Pool } from 'pg';

const DEFAULT_READ_LIMIT = 50;

const OUTBOX_COLUMNS =
  'tenant_id, device_id, seq, message_id, body, body_hash, byte_size, state, appended_at';

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
}

interface CursorRow {
  readonly acked_seq: bigint;
  readonly acked_at: string | null;
}

interface RetentionRow {
  readonly deleted_count: bigint;
  readonly expired_count: bigint;
  readonly released_bytes: bigint;
}

function toMessage(row: OutboxRow): MailboxMessage {
  return {
    tenantId: row.tenant_id as TenantId,
    deviceId: row.device_id,
    // `seq` is bigint in the column and `number` on the port, because it is the
    // envelope `seq` on the wire. The column is wide so the counter cannot wrap
    // into a redelivery bug; the narrowing happens once, here.
    seq: Number(row.seq),
    messageId: row.message_id,
    body: row.body,
    bodyHash: row.body_hash as ContentHash,
    byteSize: row.byte_size,
    state: row.state as MailboxMessageState,
    appendedAt: row.appended_at,
  };
}

export class PostgresMailboxStore implements MailboxStore {
  readonly #pool: Pool;
  readonly #clock: Clock;

  constructor(pool: Pool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async append(tenant: TenantId, input: MailboxAppendInput): Promise<MailboxMessage> {
    this.#requireDeviceId(input.deviceId);
    const now = this.#now();

    // One statement. The `allocated` CTE bumps the same per-device allocator
    // `cloud.sequence` uses — the daemon's redelivery cursor IS that number, so
    // handing the same one out twice would make an envelope unacknowledgeable.
    // The main insert's `ON CONFLICT DO NOTHING` is the producer's idempotency
    // key doing the deciding: a replayed `messageId` enqueues nothing.
    //
    // A replay burns an allocation. That is the deliberate trade: `seq` is
    // contractually monotonic, never contractually gapless, and the alternative
    // (look first, then allocate) is the racy read-then-write this package does
    // not do.
    const inserted = await this.#pool.query<OutboxRow>(
      `WITH allocated AS (
         INSERT INTO device_stream (tenant_id, device_id, next_seq, acked_seq, acked_at)
         VALUES ($1, $2, 2, 0, $7)
         ON CONFLICT (tenant_id, device_id) DO UPDATE
            SET next_seq = device_stream.next_seq + 1
         RETURNING next_seq - 1 AS seq
       )
       INSERT INTO outbox (${OUTBOX_COLUMNS})
       SELECT $1, $2, allocated.seq, $3, $4, $5, $6::bigint, 'pending', $7
         FROM allocated
       ON CONFLICT (tenant_id, device_id, message_id) DO NOTHING
       RETURNING ${OUTBOX_COLUMNS}`,
      [
        tenant,
        input.deviceId,
        input.messageId,
        input.body,
        input.bodyHash,
        input.byteSize,
        now,
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return toMessage(row);

    const existing = await this.#pool.query<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM outbox
        WHERE tenant_id = $1 AND device_id = $2 AND message_id = $3`,
      [tenant, input.deviceId, input.messageId],
    );
    const replayed = existing.rows[0];
    // Unreachable in practice: the insert only declines when the row exists.
    if (replayed === undefined) {
      throw new ByokCoreError(
        'mailbox_message_not_found',
        `Message ${input.messageId} vanished during an idempotent append.`,
      );
    }
    return toMessage(replayed);
  }

  async readAfter(tenant: TenantId, query: MailboxReadQuery): Promise<MailboxPage> {
    const limit = query.limit ?? DEFAULT_READ_LIMIT;
    // One row past the page answers `hasMore` without a second count query, and
    // without the count and the page disagreeing about which snapshot they saw.
    const result = await this.#pool.query<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM outbox
        WHERE tenant_id = $1 AND device_id = $2 AND state = 'pending' AND seq > $3::bigint
        ORDER BY seq
        LIMIT $4`,
      [tenant, query.deviceId, query.afterSeq, limit + 1],
    );

    const page = result.rows.slice(0, limit).map(toMessage);
    return {
      messages: page,
      // Nothing above was mutated, so an identical call replays the same page.
      // The returned position is a READ cursor and moves no ack.
      nextSeq: page.at(-1)?.seq ?? query.afterSeq,
      hasMore: result.rows.length > page.length,
    };
  }

  async advanceCursor(
    tenant: TenantId,
    input: MailboxAdvanceCursorInput,
  ): Promise<MailboxCursorState> {
    this.#requireDeviceId(input.deviceId);
    const now = this.#now();

    // The monotonic guard lives in `WHERE device_stream.acked_seq <=
    // EXCLUDED.acked_seq`, so a stale ack updates nothing rather than winning a
    // last-write race and re-opening envelopes the device already journaled.
    //
    // Marking the rows is folded into the same statement on purpose. Split
    // across two round trips, a crash between them would leave the cursor ahead
    // of the rows it acked, and `readAfter` would re-serve work the device has
    // run. When the guard rejects, `(SELECT acked_seq FROM moved)` is NULL and
    // `seq <= NULL` marks nothing — the rejection is total, not partial.
    const moved = await this.#pool.query<CursorRow>(
      `WITH moved AS (
         INSERT INTO device_stream (tenant_id, device_id, next_seq, acked_seq, acked_at)
         VALUES ($1, $2, 1, $3::bigint, $4)
         ON CONFLICT (tenant_id, device_id) DO UPDATE
            SET acked_seq = EXCLUDED.acked_seq, acked_at = EXCLUDED.acked_at
          WHERE device_stream.acked_seq <= EXCLUDED.acked_seq
         RETURNING acked_seq, acked_at
       ), marked AS (
         UPDATE outbox
            SET state = 'acked'
          WHERE tenant_id = $1 AND device_id = $2 AND state = 'pending'
            AND seq <= (SELECT acked_seq FROM moved)
         RETURNING 1
       )
       SELECT acked_seq, acked_at FROM moved`,
      [tenant, input.deviceId, input.ackedSeq, now],
    );

    const row = moved.rows[0];
    if (row !== undefined) {
      return {
        tenantId: tenant,
        deviceId: input.deviceId,
        ackedSeq: Number(row.acked_seq),
        updatedAt: row.acked_at ?? now,
      };
    }

    const current = await this.readCursor(tenant, input.deviceId);
    throw new CoreConflictError(
      'mailbox_cursor_regression',
      `Cursor for device ${input.deviceId} is at ${current.ackedSeq}; refusing to move it back to ${input.ackedSeq}.`,
      current,
      this.#now(),
    );
  }

  async readCursor(tenant: TenantId, deviceId: string): Promise<MailboxCursorState> {
    const result = await this.#pool.query<CursorRow>(
      `SELECT acked_seq, acked_at FROM device_stream
        WHERE tenant_id = $1 AND device_id = $2`,
      [tenant, deviceId],
    );
    const row = result.rows[0];
    // No row, or a row `cloud.sequence` created without the mailbox ever having
    // moved its cursor: the position is 0 and there is no recorded instant to
    // report, so the read's own clock stands in. Reporting a stored instant
    // that does not exist would be the one thing worse than reporting this one.
    return {
      tenantId: tenant,
      deviceId,
      ackedSeq: row === undefined ? 0 : Number(row.acked_seq),
      updatedAt: row?.acked_at ?? this.#now(),
    };
  }

  async collectRetired(
    tenant: TenantId,
    input: MailboxRetentionInput,
  ): Promise<MailboxRetentionResult> {
    // Both cutoffs are compared against `appended_at` as text; the canonical
    // form is what makes that a time comparison rather than an arbitrary one.
    // Validate before the sweep so a malformed cutoff deletes nothing at all
    // rather than a wrong prefix of history.
    assertCanonicalTimestamp(input.ackedBefore, 'ackedBefore');
    assertCanonicalTimestamp(input.expireUnackedBefore, 'expireUnackedBefore');

    // Delete and dead-letter in one statement, so a sweep is all or nothing and
    // the two counts an operator reads describe the same moment. The two CTEs
    // select disjoint sets — one `acked`, one `pending` — so no row can be both
    // counted and marked.
    const swept = await this.#pool.query<RetentionRow>(
      `WITH deleted AS (
         DELETE FROM outbox
          WHERE tenant_id = $1
            AND ($2::text IS NULL OR device_id = $2::text)
            AND state = 'acked'
            AND appended_at < $3
         RETURNING byte_size
       ), expired AS (
         UPDATE outbox
            SET state = 'expired'
          WHERE tenant_id = $1
            AND ($2::text IS NULL OR device_id = $2::text)
            AND state = 'pending'
            AND appended_at < $4
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM deleted)                           AS deleted_count,
              (SELECT count(*) FROM expired)                           AS expired_count,
              (SELECT COALESCE(SUM(byte_size), 0) FROM deleted)::bigint AS released_bytes`,
      [tenant, input.deviceId ?? null, input.ackedBefore, input.expireUnackedBefore],
    );

    const row = swept.rows[0]!;
    return {
      deletedCount: Number(row.deleted_count),
      expiredCount: Number(row.expired_count),
      releasedBytes: row.released_bytes,
    };
  }

  /**
   * The in-memory reference refuses an empty device id rather than opening a
   * mailbox nothing can address. Kept here so the two compositions answer the
   * same way; the table itself would happily store the row.
   */
  #requireDeviceId(deviceId: string): void {
    if (deviceId.length === 0) {
      throw new ByokCoreError('mailbox_message_not_found', 'Device id must not be empty.');
    }
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}
