/**
 * The one Postgres writer of mailbox rows: the only `INSERT INTO outbox`.
 *
 * Mailbox bytes have one authority, the retained rows. Usage is the tenant's
 * `SUM(byte_size)` over its `pending` rows, so there is no counter a writer
 * could forget to move and no release step when a row is acked, dead-lettered
 * or deleted (#1115): an `acked` or `expired` row is retained for retention and
 * §12.7.5 visibility but holds no quota, so neither one can wedge a tenant at
 * its limit. What has to be serialized instead is the limit check against that sum,
 * and that is this file's job. Append, cancellation and dead-letter replay all
 * call it, so admission and sequence allocation cannot drift between writers.
 *
 * The caller must already be in a transaction and keeps it open until it
 * commits; a refusal throws, and the caller's rollback undoes everything this
 * function did, including the sequence it allocated.
 *
 * Lock order, the same for every writer: the tenant mailbox lock (limited
 * admission only), then the per-device `device_stream` row. Dead-lettering
 * outside retention (`expirePendingRows`) takes only the stream row: it can
 * only lower the sum a limited append is checked against.
 *
 * - The tenant lock is a transaction-scoped advisory lock. A `limited` limit
 *   check reads an aggregate over other devices' rows, and under READ
 *   COMMITTED a single statement cannot serialize against inserts it does not
 *   see. Taking the lock first means the guarded `INSERT` below starts its
 *   snapshot after every earlier limited append has committed.
 * - The device row lock serializes allocate -> materialize -> insert. Releasing
 *   it before insertion would let seq N+1 become visible before N; a daemon
 *   could then ack N+1 and permanently skip the late N row.
 *
 * - The guarded limit check needs READ COMMITTED: its snapshot must start
 *   after the tenant lock is granted. Under REPEATABLE READ the snapshot is
 *   taken by the transaction's first statement, before the lock, and the sum
 *   misses rows committed while it waited. A pooled session whose default
 *   isolation was raised would silently oversell, so callers open with
 *   `BEGIN_OUTBOX_WRITE` and this function refuses any other level.
 *
 * Nothing here calls SQL `now()`: the caller passes its clock's instant.
 */
import {
  ByokCoreError,
  type MailboxAdmission,
  type MailboxBody,
  type TenantId,
} from '@byok-sdk/core';
import type { PoolClient } from 'pg';

/**
 * Seed for the tenant mailbox lock key. Distinct from the cleanup job's
 * session lock namespace, so a running cleanup never blocks an append.
 */
const MAILBOX_ADMISSION_LOCK_NAMESPACE = 1_298_756_948;

/** The `BEGIN` every transaction that reaches `insertOutboxRow` must open with. */
export const BEGIN_OUTBOX_WRITE = 'BEGIN ISOLATION LEVEL READ COMMITTED';

export const OUTBOX_WRITE_COLUMNS =
  'tenant_id, device_id, seq, message_id, body, body_hash, byte_size, state, appended_at, replay_source_seq';

export interface WrittenOutboxRow {
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

export interface OutboxWriteInput {
  readonly deviceId: string;
  readonly messageId: string;
  readonly admission: MailboxAdmission;
  /** The caller's clock instant, used for the row and a newly created stream. */
  readonly now: string;
  readonly materialize: (seq: number) => MailboxBody | Promise<MailboxBody>;
  /** Dead-letter replay only: the expired row this delivery re-sends. */
  readonly replaySourceSeq?: bigint;
}

export interface OutboxWriteResult {
  readonly row: WrittenOutboxRow;
  /** False when `messageId` already had a row; nothing was written. */
  readonly inserted: boolean;
}

export async function insertOutboxRow(
  client: PoolClient,
  tenant: TenantId,
  input: OutboxWriteInput,
): Promise<OutboxWriteResult> {
  // Fail closed: the limit check below is only a serialized decision under
  // READ COMMITTED, whatever the session default was when the caller began.
  const isolation = await client.query<{ readonly level: string }>(
    "SELECT current_setting('transaction_isolation') AS level",
  );
  if (isolation.rows[0]?.level !== 'read committed') {
    throw new Error(
      `insertOutboxRow requires a READ COMMITTED transaction, found ${String(isolation.rows[0]?.level)}.`,
    );
  }

  // Anything but the one exempt class is limited: an unknown admission fails
  // closed instead of skipping the check.
  const exempt = input.admission === 'cancellation';
  if (!exempt) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, $2))', [
      tenant,
      MAILBOX_ADMISSION_LOCK_NAMESPACE,
    ]);
  }

  // A no-op upsert takes the device row lock and reads the next sequence in
  // one statement. The sequence is only advanced after the row is inserted,
  // so an idempotent return or a refusal consumes no number.
  const stream = await client.query<{ readonly next_seq: bigint }>(
    `INSERT INTO device_stream (tenant_id, device_id, next_seq, acked_seq, acked_at)
     VALUES ($1, $2, 1, 0, $3)
     ON CONFLICT (tenant_id, device_id) DO UPDATE
        SET next_seq = device_stream.next_seq
     RETURNING next_seq`,
    [tenant, input.deviceId, input.now],
  );
  const seq = stream.rows[0]!.next_seq;

  // Re-read the idempotency key behind both locks. A caller's earlier
  // lock-free check can lose to a writer that committed while it waited.
  const existing = await client.query<WrittenOutboxRow>(
    `SELECT ${OUTBOX_WRITE_COLUMNS} FROM outbox
      WHERE tenant_id = $1 AND device_id = $2 AND message_id = $3`,
    [tenant, input.deviceId, input.messageId],
  );
  if (existing.rows[0] !== undefined) return { row: existing.rows[0], inserted: false };

  const materialized = await input.materialize(Number(seq));
  // The admission decision lives in this guard. A tenant without an
  // entitlement compares against NULL and inserts nothing.
  const inserted = await client.query<WrittenOutboxRow>(
    `INSERT INTO outbox (${OUTBOX_WRITE_COLUMNS})
     SELECT $1, $2, $3::bigint, $4, $5, $6, $7::bigint, 'pending', $8, $9::bigint
      WHERE $10::boolean
         OR (SELECT COALESCE(SUM(o.byte_size), 0) FROM outbox o
              WHERE o.tenant_id = $1 AND o.state = 'pending')
              + $7::bigint
            <= (SELECT e.mailbox_limit_bytes FROM storage_entitlement e WHERE e.tenant_id = $1)
     RETURNING ${OUTBOX_WRITE_COLUMNS}`,
    [
      tenant,
      input.deviceId,
      seq,
      input.messageId,
      materialized.body,
      materialized.bodyHash,
      materialized.byteSize,
      input.now,
      input.replaySourceSeq ?? null,
      exempt,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw await explainRefusal(client, tenant, materialized.byteSize);

  await client.query(
    `UPDATE device_stream SET next_seq = $3::bigint + 1
      WHERE tenant_id = $1 AND device_id = $2`,
    [tenant, input.deviceId, seq],
  );
  return { row, inserted: true };
}

/** The tenant's mailbox bytes: its `pending` rows on every device. */
export async function readMailboxBytes(
  queryable: Pick<PoolClient, 'query'>,
  tenant: TenantId,
): Promise<bigint> {
  const used = await queryable.query<{ readonly bytes: bigint }>(
    `SELECT COALESCE(SUM(byte_size), 0)::bigint AS bytes FROM outbox
      WHERE tenant_id = $1 AND state = 'pending'`,
    [tenant],
  );
  return used.rows[0]!.bytes;
}

/**
 * Takes the `device_stream` row lock of each device, in `device_id` order — the
 * lock every writer and the ack take before touching an outbox row. A caller
 * that holds it before {@link expirePendingRows} sees every row appended
 * before it, and never holds an outbox row an ack is waiting behind.
 */
export async function lockDeviceStreams(
  client: Pick<PoolClient, 'query'>,
  tenant: TenantId,
  deviceIds: readonly string[],
): Promise<void> {
  await client.query(
    `SELECT 1 FROM device_stream WHERE tenant_id = $1 AND device_id = ANY($2::text[])
      ORDER BY device_id FOR UPDATE`,
    [tenant, [...deviceIds]],
  );
}

/**
 * Dead-letters a device's `pending` rows — every one, or exactly the listed
 * seqs — under a stream lock the caller already holds. Only `pending` moves,
 * only to `expired`; the stream row and every other row stay as they are.
 */
export async function expirePendingRows(
  client: Pick<PoolClient, 'query'>,
  tenant: TenantId,
  deviceId: string,
  seqs: 'all' | readonly (number | string)[],
): Promise<number> {
  if (seqs !== 'all' && seqs.length === 0) return 0;
  const expired = await client.query(
    `UPDATE outbox SET state = 'expired'
      WHERE tenant_id = $1 AND device_id = $2 AND state = 'pending'
        AND ($3::bigint[] IS NULL OR seq = ANY($3::bigint[]))`,
    [tenant, deviceId, seqs === 'all' ? null : seqs.map(String)],
  );
  return expired.rowCount ?? 0;
}

/** Names the refusal. Runs inside the same locked transaction that refused. */
async function explainRefusal(
  client: PoolClient,
  tenant: TenantId,
  byteSize: bigint,
): Promise<ByokCoreError> {
  const entitlement = await client.query<{ readonly mailbox_limit_bytes: bigint }>(
    'SELECT mailbox_limit_bytes FROM storage_entitlement WHERE tenant_id = $1',
    [tenant],
  );
  const limit = entitlement.rows[0]?.mailbox_limit_bytes;
  if (limit === undefined) {
    return new ByokCoreError(
      'storage_entitlement_missing',
      'No storage entitlement has been issued for this tenant.',
    );
  }
  const used = await readMailboxBytes(client, tenant);
  return new ByokCoreError(
    'storage_quota_exceeded',
    `Mailbox would reach ${String(used + byteSize)} bytes, over the limit of ${String(limit)} bytes.`,
  );
}
