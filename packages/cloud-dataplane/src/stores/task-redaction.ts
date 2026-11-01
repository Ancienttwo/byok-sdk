/**
 * Postgres authority for `ByokCloud.redactTasks` (#654 E5a).
 *
 * One call handles one terminal task in two steps:
 *
 * 1. Read the task's bodies without a lock and delete every object they name,
 *    unless another receipt body or a pending mailbox row of the tenant also
 *    names it, and only under the orphan-GC guards (no reference, no reserved
 *    upload).
 * 2. In one transaction that holds the task row lock (the lock admission and
 *    cancellation also take), fence an absent terminal receipt, replace each
 *    body with the cloud tombstone, clear the free-text task columns, delete
 *    the ephemeral rows and write the audit receipt.
 *
 * Objects go first. If the call stops between the steps, the bodies are still
 * there, so a retry finds the same hashes and an object already gone is
 * `absent`. Rows stay, so mailbox cursors, the dead-letter floor and every
 * receipt fence keep their meaning. Only `pg` and `fetch` are used, so the
 * store runs on Workers through `./runtime`.
 */
import type { ContentHash, Clock, TenantId } from '@byok-sdk/core';
import type {
  TaskRedactionCodec,
  TaskRedactionCounts,
  TaskRedactionStore,
  TaskRedactionStoreInput,
  TaskRedactionTaskResult,
} from '@byok-sdk/cloud';
import type { Pool, PoolClient } from 'pg';
import type { ByokPool } from '../pool';
import { assertByokPool } from '../pool-brand';
import { settleDeletedObject } from './core/object-gc';
import { BEGIN_OUTBOX_WRITE } from './core/outbox-writer';
import { R2ObjectMaintenanceStore, type R2ObjectMaintenance } from './r2-blobs';
import type { PostgresObjectStorageOptions } from './index';

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['complete', 'failed', 'cancelled']);
/** Tables whose rows exist only while a task runs. Each is keyed by `(tenant_id, task_id)`. */
const EPHEMERAL_TABLES = ['approval_timeline_tail', 'agent_message_draft'] as const;

export interface PostgresTaskRedactionStoreOptions {
  readonly pool: ByokPool;
  readonly clock: Clock;
  /** The bucket the blob composition writes to. */
  readonly objectStorage: PostgresObjectStorageOptions;
}

export interface TaskRow {
  readonly device_id: string;
  readonly owner_device_id: string | null;
  readonly status: string;
}

interface OutboxBody {
  readonly device_id: string;
  readonly seq: string;
  readonly state: string;
  readonly body: string;
}

interface AdmissionBody {
  readonly device_id: string;
  readonly payload_body: string;
  readonly terminal_body: string | null;
}

export type Querier = Pick<PoolClient, 'query'>;

export class PostgresTaskRedactionStore implements TaskRedactionStore {
  readonly #pool: Pool;
  readonly #clock: Clock;
  readonly #objects: Pick<R2ObjectMaintenance, 'deleteObject'>;

  constructor(options: PostgresTaskRedactionStoreOptions) {
    assertByokPool(options.pool, 'PostgresTaskRedactionStore');
    this.#pool = options.pool;
    this.#clock = options.clock;
    this.#objects = new R2ObjectMaintenanceStore(options.objectStorage);
  }

  async redactTask(input: TaskRedactionStoreInput): Promise<TaskRedactionTaskResult> {
    const { tenantId: tenant, taskId, codec } = input;
    const task = await readTask(this.#pool, tenant, taskId, false);
    if (task === undefined) return { taskId, outcome: 'not_found' };
    const refusal = await refusalFor(this.#pool, tenant, taskId, task, false);
    if (refusal !== undefined) return refusal;
    // The task is terminal with no pending delivery, so it no longer needs the
    // objects it holds (#654). Release them before the deletes below.
    await this.#releaseReferences(tenant, input.releaseObjectReferences);

    const bodies = [
      ...(await readReceipts(this.#pool, tenant, input.receiptKeys, false)).map((row) => row.body),
      ...(await readAdmissions(this.#pool, tenant, taskId, false)).flatMap((row) =>
        row.terminal_body === null ? [row.payload_body] : [row.payload_body, row.terminal_body]),
      ...(await readOutbox(this.#pool, tenant, taskId, task, false)).map((row) => row.body),
    ];
    const hashes = new Set(bodies.filter((body) => !codec.isTombstone(body)).flatMap((body) => codec.blobHashes(body)));
    let objectsDeleted = 0;
    for (const hash of hashes) {
      if (await this.#deleteObject(tenant, hash, input.receiptKeys)) objectsDeleted += 1;
    }
    const result = await this.#redactRows(input, objectsDeleted);
    // A device report can add a reference after the release above and before
    // the row step commits, for example a terminal replay whose receipt still
    // read the original body. Nothing names that blob once the bodies are
    // tombstones, so release again and leave the blob to orphan GC. A report
    // that lands later reads the tombstone or the audit receipt and releases
    // its own reference. Only a redacted result has `counts`.
    if ('counts' in result) await this.#releaseReferences(tenant, input.releaseObjectReferences);
    return result;
  }

  async #redactRows(input: TaskRedactionStoreInput, objectsDeleted: number): Promise<TaskRedactionTaskResult> {
    const { tenantId: tenant, taskId, codec } = input;
    const client = await this.#pool.connect();
    try {
      await client.query(BEGIN_OUTBOX_WRITE);
      const task = await readTask(client, tenant, taskId, true);
      if (task === undefined) {
        await client.query('ROLLBACK');
        return { taskId, outcome: 'not_found' };
      }
      const refusal = await refusalFor(client, tenant, taskId, task, true);
      if (refusal !== undefined) {
        await client.query('ROLLBACK');
        return refusal;
      }

      const rewritten = await rewriteTaskBodies(client, {
        tenant, taskId, task, codec, receiptKeys: input.receiptKeys, terminalReceiptKey: input.terminalReceiptKey, now: this.#clock.now(),
      });
      const { receiptsRedacted, admissionsRedacted, outboxRedacted, ephemeralRowsDeleted } = rewritten;

      const counts: TaskRedactionCounts = {
        receiptsRedacted,
        admissionsRedacted,
        outboxRedacted,
        ephemeralRowsDeleted,
        objectsDeleted,
      };
      const now = this.#clock.now();
      const audit = await client.query(
        `INSERT INTO device_request_receipts (tenant_id, key, body, recorded_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, key) DO NOTHING`,
        [tenant, input.auditReceiptKey, JSON.stringify({ redactedAt: now.toISOString(), counts }), now],
      );
      await client.query('COMMIT');
      const changed = audit.rowCount === 1 || rewritten.columnsCleared
        || Object.values(counts).some((count) => count > 0);
      return { taskId, outcome: changed ? 'redacted' : 'already_redacted', counts };
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => {});
      throw cause;
    } finally {
      client.release();
    }
  }

  async #releaseReferences(tenant: TenantId, releases: TaskRedactionStoreInput['releaseObjectReferences']): Promise<void> {
    for (const { refKind, refId } of releases) {
      const held = await this.#pool.query<{ hash: string }>(
        'SELECT hash FROM object_reference WHERE tenant_id = $1 AND ref_kind = $2 AND ref_id = $3',
        [tenant, refKind, refId],
      );
      for (const { hash } of held.rows) {
        // Manifest row first, then the reference: the lock order of `addReference`.
        await inTransaction(this.#pool, async (client) => {
          await client.query('SELECT 1 FROM object_manifest WHERE tenant_id = $1 AND hash = $2 FOR UPDATE', [tenant, hash]);
          await client.query(
            'DELETE FROM object_reference WHERE tenant_id = $1 AND hash = $2 AND ref_kind = $3 AND ref_id = $4',
            [tenant, hash, refKind, refId],
          );
          await client.query(
            `UPDATE object_manifest SET ref_count = (SELECT count(*) FROM object_reference r WHERE r.tenant_id = $1 AND r.hash = $2),
                    updated_at = $3
              WHERE tenant_id = $1 AND hash = $2`,
            [tenant, hash, this.#clock.now().toISOString()],
          );
        });
      }
    }
  }

  async #deleteObject(tenant: TenantId, hash: ContentHash, ownKeys: readonly string[]): Promise<boolean> {
    // Delete one object. It is kept, and left to orphan GC, when a receipt body
    // outside this task or a pending mailbox row of the tenant holds the hash as
    // a substring. That check scans the tenant's bodies without an index, so it
    // runs first and without a lock: receipt and mailbox writes do not take the
    // upload gate, so holding the gate would not make it exact.
    //
    // Then the orphan-GC guards apply: no `object_reference`, no reserved upload,
    // `ref_count = 0`. Their age floor is not used, because a terminal task's own
    // bodies name the object. The mark and the physical delete are separate
    // transactions, as in `PostgresObjectStore`, so the upload gate is not held
    // during the network call.
    const named = await this.#pool.query(
      `SELECT 1 FROM device_request_receipts WHERE tenant_id = $1 AND key <> ALL($3::text[]) AND strpos(body, $2) > 0
       UNION ALL SELECT 1 FROM outbox WHERE tenant_id = $1 AND state = 'pending' AND strpos(body, $2) > 0 LIMIT 1`,
      [tenant, hash, [...ownKeys]],
    );
    if (named.rowCount !== 0) return false;
    const now = this.#clock.now().toISOString();
    const unreferenced = `NOT EXISTS (SELECT 1 FROM object_reference r WHERE r.tenant_id = m.tenant_id AND r.hash = m.hash)
      AND NOT EXISTS (SELECT 1 FROM storage_reservation s
                       WHERE s.tenant_id = m.tenant_id AND s.content_hash = m.hash AND s.state = 'reserved')`;
    await inTransaction(this.#pool, async (client) => {
      await client.query('SELECT 1 FROM storage_entitlement WHERE tenant_id = $1 FOR UPDATE', [tenant]);
      await client.query(
        `UPDATE object_manifest m
            SET gc_accounted_bytes = CASE WHEN m.state = 'committed' THEN m.byte_size ELSE 0 END,
                gc_accounted_object = (m.state = 'committed'),
                state = 'delete_pending', delete_pending_at = $3, updated_at = $3
          WHERE m.tenant_id = $1 AND m.hash = $2 AND m.state IN ('pending', 'committed') AND m.ref_count = 0
            AND ${unreferenced}`,
        [tenant, hash, now],
      );
    });
    return inTransaction(this.#pool, async (client) => {
      const locked = await client.query(
        `SELECT 1 FROM object_manifest m
          WHERE m.tenant_id = $1 AND m.hash = $2 AND m.state = 'delete_pending' AND m.ref_count = 0
            AND m.gc_accounted_bytes IS NOT NULL AND m.gc_accounted_object IS NOT NULL
            AND ${unreferenced}
          FOR UPDATE OF m`,
        [tenant, hash],
      );
      if (locked.rowCount !== 1) return false;
      await this.#objects.deleteObject(tenant, hash);
      return (await settleDeletedObject(client as PoolClient, tenant, hash, now)) !== undefined;
    });
  }
}

export function createPostgresTaskRedactionStore(options: PostgresTaskRedactionStoreOptions): TaskRedactionStore {
  return new PostgresTaskRedactionStore(options);
}

/** What {@link rewriteTaskBodies} changed. */
export interface RewrittenTaskBodies {
  readonly receiptsRedacted: number;
  readonly admissionsRedacted: number;
  readonly outboxRedacted: number;
  readonly ephemeralRowsDeleted: number;
  readonly columnsCleared: boolean;
}

/**
 * The row half that redaction and the archive step share (#654, #1120). The
 * caller holds the task row lock inside its transaction and has refused a task
 * that is not terminal or still has a pending delivery. Mailbox rows are
 * rewritten, never deleted.
 */
export async function rewriteTaskBodies(
  client: Querier,
  input: {
    readonly tenant: TenantId;
    readonly taskId: string;
    readonly task: TaskRow;
    readonly codec: TaskRedactionCodec;
    readonly receiptKeys: readonly string[];
    readonly terminalReceiptKey: string;
    readonly now: Date;
  },
): Promise<RewrittenTaskBodies> {
  const { tenant, taskId, task, codec } = input;
  // Fence an absent terminal key first (a task cancelled before a claim
  // has none). A device terminal that commits before this insert is read
  // and replaced below; one that arrives later finds the fence and stores nothing.
  await client.query(
    `INSERT INTO device_request_receipts (tenant_id, key, body, recorded_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, key) DO NOTHING`,
    [tenant, input.terminalReceiptKey, codec.absent, input.now],
  );
  let receiptsRedacted = 0;
  for (const row of await readReceipts(client, tenant, input.receiptKeys, true)) {
    if (codec.isTombstone(row.body)) continue;
    await client.query('UPDATE device_request_receipts SET body = $3 WHERE tenant_id = $1 AND key = $2', [
      tenant,
      row.key,
      (await codec.tombstone(row.body)).body,
    ]);
    receiptsRedacted += 1;
  }

  let admissionsRedacted = 0;
  for (const row of await readAdmissions(client, tenant, taskId, true)) {
    const payload = await replacement(codec, row.payload_body);
    const terminal = row.terminal_body === null ? undefined : await replacement(codec, row.terminal_body);
    if (payload === undefined && terminal === undefined) continue;
    await client.query(
      `UPDATE agent_message_admission
          SET payload_body = COALESCE($4, payload_body), terminal_body = COALESCE($5, terminal_body)
        WHERE tenant_id = $1 AND device_id = $2 AND task_id = $3`,
      [tenant, row.device_id, taskId, payload ?? null, terminal ?? null],
    );
    admissionsRedacted += 1;
  }

  let outboxRedacted = 0;
  for (const row of await readOutbox(client, tenant, taskId, task, true)) {
    // Only acked/expired rows are rewritten here, and those hold no mailbox quota (#1115).
    const tombstone = await codec.tombstone(row.body);
    await client.query(
      `UPDATE outbox SET body = $4, body_hash = $5, byte_size = $6
        WHERE tenant_id = $1 AND device_id = $2 AND seq = $3`,
      [tenant, row.device_id, row.seq, tombstone.body, tombstone.bodyHash, tombstone.byteSize],
    );
    outboxRedacted += 1;
  }

  const cleared = await client.query(
    `UPDATE task SET terminal_cause = NULL, cancel_reason = NULL
      WHERE tenant_id = $1 AND task_id = $2 AND (terminal_cause IS NOT NULL OR cancel_reason IS NOT NULL)`,
    [tenant, taskId],
  );

  // The head survives content removal so a concurrent append cannot recreate history.
  // Both admission and redaction serialize on this row, including when it was absent.
  const createdHead = await client.query(
    'INSERT INTO activity_log_head (tenant_id, task_id, removed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING RETURNING task_id',
    [tenant, taskId],
  );
  const head = await client.query<{ removed: boolean; revision: bigint }>(
    'SELECT removed, revision FROM activity_log_head WHERE tenant_id = $1 AND task_id = $2 FOR UPDATE', [tenant, taskId],
  );
  // A head closed with nothing logged held no history.
  let ephemeralRowsDeleted = createdHead.rowCount === 0 && head.rows[0]?.removed === false && head.rows[0].revision > 0n ? 1 : 0;
  await client.query(
    'UPDATE activity_log_entry SET body = NULL, byte_size = 0 WHERE tenant_id = $1 AND task_id = $2 AND body IS NOT NULL', [tenant, taskId],
  );
  await client.query(
    'UPDATE activity_log_head SET removed = true, floor = revision, retained_bytes = 0 WHERE tenant_id = $1 AND task_id = $2', [tenant, taskId],
  );
  for (const table of EPHEMERAL_TABLES) {
    const deleted = await client.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND task_id = $2`, [tenant, taskId]);
    ephemeralRowsDeleted += deleted.rowCount ?? 0;
  }
  return { receiptsRedacted, admissionsRedacted, outboxRedacted, ephemeralRowsDeleted, columnsCleared: (cleared.rowCount ?? 0) > 0 };
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => {});
    throw cause;
  } finally {
    client.release();
  }
}

async function replacement(codec: TaskRedactionCodec, body: string): Promise<string | undefined> {
  return codec.isTombstone(body) ? undefined : (await codec.tombstone(body)).body;
}

function lock(forUpdate: boolean): string {
  return forUpdate ? ' FOR UPDATE' : '';
}

export async function readTask(db: Querier, tenant: TenantId, taskId: string, forUpdate: boolean): Promise<TaskRow | undefined> {
  const result = await db.query<TaskRow>(
    `SELECT device_id, owner_device_id, status FROM task WHERE tenant_id = $1 AND task_id = $2${lock(forUpdate)}`,
    [tenant, taskId],
  );
  return result.rows[0];
}

/** A cancellation that is still requested is not terminal, whatever the device reported. */
export async function refusalFor(
  db: Querier,
  tenant: TenantId,
  taskId: string,
  task: TaskRow,
  forUpdate: boolean,
): Promise<TaskRedactionTaskResult | undefined> {
  if (!TERMINAL_STATUSES.has(task.status)) return { taskId, outcome: 'refused', reason: 'task_not_terminal' };
  const outbox = await readOutbox(db, tenant, taskId, task, forUpdate, true);
  return outbox.length > 0 ? { taskId, outcome: 'refused', reason: 'pending_delivery' } : undefined;
}

async function readReceipts(
  db: Querier,
  tenant: TenantId,
  keys: readonly string[],
  forUpdate: boolean,
): Promise<readonly { readonly key: string; readonly body: string }[]> {
  const result = await db.query<{ readonly key: string; readonly body: string }>(
    `SELECT key, body FROM device_request_receipts WHERE tenant_id = $1 AND key = ANY($2::text[]) ORDER BY key${lock(forUpdate)}`,
    [tenant, [...keys]],
  );
  return result.rows;
}

async function readAdmissions(
  db: Querier,
  tenant: TenantId,
  taskId: string,
  forUpdate: boolean,
): Promise<readonly AdmissionBody[]> {
  const result = await db.query<AdmissionBody>(
    `SELECT device_id, payload_body, terminal_body FROM agent_message_admission
      WHERE tenant_id = $1 AND task_id = $2 ORDER BY device_id${lock(forUpdate)}`,
    [tenant, taskId],
  );
  return result.rows;
}

/**
 * The task's mailbox rows on its target and owner devices. An envelope names
 * its task in a top-level `task_id`; `encodeEnvelope` writes compact JSON, so
 * the text filter narrows the scan and the parse confirms each match. A
 * tombstone has no `task_id`, so a redacted row is not read again.
 */
export async function readOutbox(
  db: Querier,
  tenant: TenantId,
  taskId: string,
  task: TaskRow,
  forUpdate: boolean,
  pendingOnly = false,
): Promise<readonly OutboxBody[]> {
  const devices = task.owner_device_id === null || task.owner_device_id === task.device_id
    ? [task.device_id]
    : [task.device_id, task.owner_device_id];
  const result = await db.query<OutboxBody>(
    `SELECT device_id, seq::text AS seq, state, body FROM outbox
      WHERE tenant_id = $1 AND device_id = ANY($2::text[]) AND strpos(body, $3) > 0
        AND state ${pendingOnly ? "= 'pending'" : "IN ('acked', 'expired')"}
      ORDER BY device_id, seq${lock(forUpdate)}`,
    [tenant, devices, `"task_id":${JSON.stringify(taskId)}`],
  );
  return result.rows.filter((row) => envelopeTaskId(row.body) === taskId);
}

function envelopeTaskId(body: string): unknown {
  try {
    const value = JSON.parse(body) as unknown;
    return value !== null && typeof value === 'object' ? (value as { readonly task_id?: unknown }).task_id : undefined;
  } catch {
    return undefined;
  }
}
