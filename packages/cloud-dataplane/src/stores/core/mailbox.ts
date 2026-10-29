import { assertCollectExpiredInput } from '@byok-sdk/core';
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
 * `collectExpired` deletes acked rows and **marks** unacked ones `expired`.
 * It never deletes a `pending` row. §12.7.5 requires an envelope that aged out
 * before anyone consumed it to stay visible, so a dead letter stays queryable
 * until its grace period (`reapDeadLettersBefore`) passes. Then it is reaped,
 * except the device's highest-seq dead letter: that row is the
 * `recoverableFrom` floor, so losing work stays distinguishable from having
 * had none.
 *
 * Rows are written only by `outbox-writer.ts`, which also admits them against
 * `mailboxLimitBytes`. Mailbox usage is the sum over the `pending` rows, so
 * neither the ack, the dead-lettering, nor any delete here does accounting.
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
  type MailboxCollectExpiredInput,
  type MailboxExpirePendingInput,
  type CollectExpiredResult,
  type MailboxStore,
  type MailboxUsage,
  type TenantId,
} from '@byok-sdk/core';
import type { Pool } from 'pg';
import type { ByokPool } from '../../pool';
import {
  BEGIN_OUTBOX_WRITE,
  expirePendingRows,
  insertOutboxRow,
  lockDeviceStreams,
  readMailboxBytes,
} from './outbox-writer';

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

  constructor(pool: ByokPool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async append(tenant: TenantId, input: MailboxAppendInput): Promise<MailboxMessage> {
    this.#requireDeviceId(input.deviceId);
    const client = await this.#pool.connect();
    try {
      await client.query(BEGIN_OUTBOX_WRITE);

      // An existing `messageId` answers before any lock or admission check, so
      // a retry against a full mailbox is never refused.
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

      const written = await insertOutboxRow(client, tenant, {
        deviceId: input.deviceId,
        messageId: input.messageId,
        admission: input.admission,
        now: this.#now(),
        materialize: input.materialize,
      });
      await client.query('COMMIT');
      return toMailboxMessage(written.row);
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => {});
      throw cause;
    } finally {
      client.release();
    }
  }

  async readUsage(tenant: TenantId): Promise<MailboxUsage> {
    return { bytes: await readMailboxBytes(this.#pool, tenant) };
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
   * No column and no migration: the loss is durable in `outbox` itself, and a
   * stored floor would be a second authority free to drift from the sweep that
   * moved it. `collectExpired` reaps old dead letters but never the device's
   * highest-seq one, so the row this reads survives every reap and the floor
   * never moves back.
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

  async expirePending(tenant: TenantId, input: MailboxExpirePendingInput): Promise<{ readonly expired: number }> {
    this.#requireDeviceId(input.deviceId);
    const client = await this.#pool.connect();
    try {
      await client.query(BEGIN_OUTBOX_WRITE);
      await lockDeviceStreams(client, tenant, [input.deviceId]);
      const expired = await expirePendingRows(client, tenant, input.deviceId, input.seqs);
      await client.query('COMMIT');
      return { expired };
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => {});
      throw cause;
    } finally {
      client.release();
    }
  }

  async collectExpired(tenant: TenantId, input: MailboxCollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    assertCanonicalTimestamp(input.ackedBefore, 'ackedBefore');
    assertCanonicalTimestamp(input.expireUnackedBefore, 'expireUnackedBefore');
    assertCanonicalTimestamp(input.reapDeadLettersBefore, 'reapDeadLettersBefore');
    // One statement, one snapshot: the reap sees only rows that were `expired`
    // before this call, and a higher `expired` sibling in that snapshot keeps
    // its own row. Dead letters only ever leave `expired` by deletion, so a
    // device's highest-seq dead letter has no higher sibling in any snapshot
    // and no concurrent sweep can reap it. The last `more` clause covers rows
    // this call's expiry makes reapable for the next call.
    const result = await this.#pool.query<{removed: string; expired: string; more: boolean}>(
      `WITH acked AS MATERIALIZED (
         SELECT ctid FROM outbox WHERE tenant_id = $1 AND state = 'acked' AND appended_at < $2
         ORDER BY appended_at, ctid LIMIT $4 + 1 FOR UPDATE SKIP LOCKED
       ), deleted AS (
         DELETE FROM outbox WHERE ctid IN (SELECT ctid FROM acked LIMIT $4) RETURNING 1
       ), reapable AS MATERIALIZED (
         SELECT o.ctid FROM outbox o
          WHERE o.tenant_id = $1 AND o.state = 'expired' AND o.appended_at < $5
            AND EXISTS (SELECT 1 FROM outbox h WHERE h.tenant_id = $1 AND h.device_id = o.device_id
                          AND h.state = 'expired' AND h.seq > o.seq)
          ORDER BY o.appended_at, o.ctid LIMIT $4 - (SELECT count(*) FROM deleted) + 1 FOR UPDATE SKIP LOCKED
       ), reaped AS (
         DELETE FROM outbox WHERE ctid IN
           (SELECT ctid FROM reapable LIMIT $4 - (SELECT count(*) FROM deleted)) RETURNING device_id, seq
       ), pending AS MATERIALIZED (
         SELECT ctid FROM outbox WHERE tenant_id = $1 AND state = 'pending' AND appended_at < $3
         ORDER BY appended_at, ctid
         LIMIT $4 - (SELECT count(*) FROM deleted) - (SELECT count(*) FROM reaped) + 1 FOR UPDATE SKIP LOCKED
       ), expired AS (
         UPDATE outbox SET state = 'expired' WHERE ctid IN
           (SELECT ctid FROM pending LIMIT $4 - (SELECT count(*) FROM deleted) - (SELECT count(*) FROM reaped))
         RETURNING device_id, seq, appended_at
       ) SELECT ((SELECT count(*) FROM deleted) + (SELECT count(*) FROM reaped))::text AS removed,
                (SELECT count(*) FROM expired)::text AS expired,
                EXISTS(SELECT 1 FROM acked OFFSET $4) OR
                (SELECT count(*) FROM reapable) > $4 - (SELECT count(*) FROM deleted) OR
                (SELECT count(*) FROM pending) > $4 - (SELECT count(*) FROM deleted) - (SELECT count(*) FROM reaped) OR
                EXISTS(SELECT 1 FROM expired e WHERE
                  (e.appended_at < $5 AND EXISTS(SELECT 1 FROM outbox h WHERE h.tenant_id = $1
                     AND h.device_id = e.device_id AND h.state = 'expired' AND h.seq > e.seq))
                  OR EXISTS(SELECT 1 FROM expired r WHERE r.device_id = e.device_id
                     AND r.seq < e.seq AND r.appended_at < $5)
                  OR EXISTS(SELECT 1 FROM outbox r WHERE r.tenant_id = $1 AND r.device_id = e.device_id
                     AND r.state = 'expired' AND r.seq < e.seq AND r.appended_at < $5
                     AND NOT EXISTS(SELECT 1 FROM reaped x WHERE x.device_id = r.device_id AND x.seq = r.seq))) AS more`,
      [tenant, input.ackedBefore, input.expireUnackedBefore, input.limit, input.reapDeadLettersBefore],
    );
    const row = result.rows[0]!;
    return { removed: Number(row.removed), expired: Number(row.expired), releasedBytes: 0n, more: row.more };
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
