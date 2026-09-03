/**
 * Postgres {@link MailboxStore} (§12.7.3).
 *
 * The load-bearing rule, and the one a composition can break silently:
 * **reading is not acknowledging.** `readAfter` is a `SELECT` and nothing else.
 * The only ack is `advanceCursor`, which the daemon calls after it has durably
 * journaled the envelope. It is monotonic and bounded by `recordDelivery`:
 * regression and future cursors are refused with the cursor state they lost
 * to rather than re-delivering or silently skipping work.
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
  type MailboxRecordDeliveryInput,
  type MailboxRetentionInput,
  type MailboxRetentionResult,
  type MailboxStore,
  type TenantId,
} from '@byok-sdk/core';
import type { Pool } from 'pg';
import { allocateMailboxSequence } from './mailbox-sequence';

const DEFAULT_READ_LIMIT = 50;

export const OUTBOX_COLUMNS =
  'tenant_id, device_id, seq, message_id, body, body_hash, byte_size, state, appended_at';

export interface OutboxRow {
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
  readonly delivered_seq: bigint;
}

interface RetentionRow {
  readonly deleted_count: bigint;
  readonly expired_count: bigint;
  readonly released_bytes: bigint;
}

export function toMailboxMessage(row: OutboxRow): MailboxMessage {
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
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query<OutboxRow>(
        `SELECT ${OUTBOX_COLUMNS} FROM outbox
          WHERE tenant_id = $1 AND device_id = $2 AND message_id = $3`,
        [tenant, input.deviceId, input.messageId],
      );
      const replayed = existing.rows[0];
      if (replayed !== undefined) {
        await client.query('COMMIT');
        return toMailboxMessage(replayed);
      }

      // The device_stream row lock serializes the whole allocate -> materialize
      // -> insert unit. Releasing it before insertion would let seq N+1 become
      // visible before N; a daemon could then ack N+1 and permanently skip the
      // late N row.
      const seq = await allocateMailboxSequence(client, tenant, input.deviceId, this.#now());
      const serializedExisting = await client.query<OutboxRow>(
        `SELECT ${OUTBOX_COLUMNS} FROM outbox
          WHERE tenant_id = $1 AND device_id = $2 AND message_id = $3`,
        [tenant, input.deviceId, input.messageId],
      );
      const winnerAfterLock = serializedExisting.rows[0];
      if (winnerAfterLock !== undefined) {
        await client.query('ROLLBACK');
        return toMailboxMessage(winnerAfterLock);
      }
      const materialized = await input.materialize(seq);
      const now = this.#now();
      const inserted = await client.query<OutboxRow>(
        `INSERT INTO outbox (${OUTBOX_COLUMNS})
         VALUES ($1, $2, $3::bigint, $4, $5, $6, $7::bigint, 'pending', $8)
         ON CONFLICT (tenant_id, device_id, message_id) DO NOTHING
         RETURNING ${OUTBOX_COLUMNS}`,
        [
          tenant,
          input.deviceId,
          seq,
          input.messageId,
          materialized.body,
          materialized.bodyHash,
          materialized.byteSize,
          now,
        ],
      );
      const row = inserted.rows[0];
      if (row !== undefined) {
        await client.query('COMMIT');
        return toMailboxMessage(row);
      }

      // A concurrent append with the same idempotency key won while this
      // transaction waited on the per-device allocator. Roll back our sequence
      // bump so an idempotent retry consumes neither a row nor a number.
      const winner = await client.query<OutboxRow>(
        `SELECT ${OUTBOX_COLUMNS} FROM outbox
          WHERE tenant_id = $1 AND device_id = $2 AND message_id = $3`,
        [tenant, input.deviceId, input.messageId],
      );
      await client.query('ROLLBACK');
      const won = winner.rows[0];
      if (won === undefined) {
        throw new ByokCoreError(
          'mailbox_message_not_found',
          `Message ${input.messageId} vanished during an idempotent append.`,
        );
      }
      return toMailboxMessage(won);
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => {});
      throw cause;
    } finally {
      client.release();
    }
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

    const page = result.rows.slice(0, limit).map(toMailboxMessage);
    return {
      messages: page,
      // Nothing above was mutated, so an identical call replays the same page.
      // The returned position is a READ cursor and moves no ack.
      nextSeq: page.at(-1)?.seq ?? query.afterSeq,
      hasMore: result.rows.length > page.length,
      recoverableFrom: await this.#recoverableFrom(tenant, query.deviceId),
    };
  }

  /**
   * One past the highest row this device lost, which is exactly the highest
   * `expired` seq — `1` when it has lost nothing.
   *
   * No column and no migration, because `collectRetired` never deletes an
   * unacked row: §12.7.5 keeps the dead letter, so the loss is already durable
   * in `outbox` and a stored floor would be a second authority free to drift
   * from the sweep that moved it. Whatever eventually reaps dead letters (S4B,
   * O-009) is the change that has to carry this floor forward instead.
   *
   * `acked` rows are not counted: a consumed row is not a lost one.
   *
   * Read AFTER the page on purpose. A sweep landing between the two reads can
   * only report a floor HIGHER than the page it accompanies, which makes the
   * caller fail closed over a page that may already be missing rows; reading
   * the floor first would report one too low and serve that gap silently.
   */
  async #recoverableFrom(tenant: TenantId, deviceId: string): Promise<number> {
    const result = await this.#pool.query<{ readonly recoverable_from: bigint }>(
      `SELECT (COALESCE(MAX(seq), 0) + 1)::bigint AS recoverable_from
         FROM outbox
        WHERE tenant_id = $1 AND device_id = $2 AND state = 'expired'`,
      [tenant, deviceId],
    );
    return Number(result.rows[0]!.recoverable_from);
  }

  async advanceCursor(
    tenant: TenantId,
    input: MailboxAdvanceCursorInput,
  ): Promise<MailboxCursorState> {
    this.#requireDeviceId(input.deviceId);
    const now = this.#now();

    // Both cursor guards live on this UPDATE: a stale ack and a future ack
    // update nothing, so neither can win a last-write race or mark outbox rows.
    //
    // Marking the rows is folded into the same statement on purpose. Split
    // across two round trips, a crash between them would leave the cursor ahead
    // of the rows it acked, and `readAfter` would re-serve work the device has
    // run. When the guard rejects, `(SELECT acked_seq FROM moved)` is NULL and
    // `seq <= NULL` marks nothing — the rejection is total, not partial.
    const moved = await this.#pool.query<CursorRow>(
      `WITH moved_zero AS (
         INSERT INTO device_stream (
           tenant_id, device_id, next_seq, acked_seq, acked_at, delivered_seq
         )
         SELECT $1, $2, 1, 0, $4, 0
          WHERE $3::bigint = 0
         ON CONFLICT (tenant_id, device_id) DO UPDATE
            SET acked_seq = 0, acked_at = EXCLUDED.acked_at
          WHERE device_stream.acked_seq <= 0
            AND device_stream.delivered_seq >= 0
         RETURNING acked_seq, acked_at, delivered_seq
       ), moved_positive AS (
         UPDATE device_stream
            SET acked_seq = $3::bigint, acked_at = $4
          WHERE tenant_id = $1 AND device_id = $2
            AND $3::bigint > 0
            AND acked_seq <= $3::bigint
            AND delivered_seq >= $3::bigint
         RETURNING acked_seq, acked_at, delivered_seq
       ), moved AS (
         SELECT acked_seq, acked_at, delivered_seq FROM moved_zero
         UNION ALL
         SELECT acked_seq, acked_at, delivered_seq FROM moved_positive
       ), marked AS (
         UPDATE outbox
            SET state = 'acked'
          WHERE tenant_id = $1 AND device_id = $2 AND state = 'pending'
            AND seq <= (SELECT acked_seq FROM moved)
         RETURNING 1
       )
       SELECT acked_seq, acked_at, delivered_seq FROM moved`,
      [tenant, input.deviceId, input.ackedSeq, now],
    );

    const row = moved.rows[0];
    if (row !== undefined) {
      return {
        tenantId: tenant,
        deviceId: input.deviceId,
        deliveredSeq: Number(row.delivered_seq),
        ackedSeq: Number(row.acked_seq),
        updatedAt: row.acked_at ?? now,
      };
    }

    const current = await this.readCursor(tenant, input.deviceId);
    if (input.ackedSeq < current.ackedSeq) {
      throw new CoreConflictError(
        'mailbox_cursor_regression',
        `Cursor for device ${input.deviceId} is at ${current.ackedSeq}; refusing to move it back to ${input.ackedSeq}.`,
        current,
        this.#now(),
      );
    }
    throw new CoreConflictError(
      'mailbox_cursor_ahead_of_delivery',
      `Cursor for device ${input.deviceId} was delivered through ${current.deliveredSeq}; refusing to acknowledge future cursor ${input.ackedSeq}.`,
      current,
      this.#now(),
    );
  }

  async recordDelivery(
    tenant: TenantId,
    input: MailboxRecordDeliveryInput,
  ): Promise<MailboxCursorState> {
    this.#requireDeviceId(input.deviceId);
    const recorded = await this.#pool.query<CursorRow>(
      `INSERT INTO device_stream (
         tenant_id, device_id, next_seq, acked_seq, acked_at, delivered_seq
       )
       VALUES ($1, $2, 1, 0, NULL, $3::bigint)
       ON CONFLICT (tenant_id, device_id) DO UPDATE
          SET delivered_seq = GREATEST(device_stream.delivered_seq, EXCLUDED.delivered_seq)
       RETURNING acked_seq, acked_at, delivered_seq`,
      [tenant, input.deviceId, input.deliveredSeq],
    );
    const row = recorded.rows[0]!;
    return {
      tenantId: tenant,
      deviceId: input.deviceId,
      deliveredSeq: Number(row.delivered_seq),
      ackedSeq: Number(row.acked_seq),
      updatedAt: row.acked_at ?? this.#now(),
    };
  }

  async readCursor(tenant: TenantId, deviceId: string): Promise<MailboxCursorState> {
    const result = await this.#pool.query<CursorRow>(
      `SELECT acked_seq, acked_at, delivered_seq FROM device_stream
        WHERE tenant_id = $1 AND device_id = $2`,
      [tenant, deviceId],
    );
    const row = result.rows[0];
    // No row, or a row the mailbox created without ever moving its cursor: the
    // position is 0 and there is no recorded ack instant to report, so the
    // read's own clock stands in.
    return {
      tenantId: tenant,
      deviceId,
      deliveredSeq: row === undefined ? 0 : Number(row.delivered_seq),
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
