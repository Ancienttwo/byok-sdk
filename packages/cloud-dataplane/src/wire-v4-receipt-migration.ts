/**
 * The Postgres runner of the one-shot wire v3 -> v4 migration (#925). An
 * operator runs it once, after draining v3 work and before starting a v4
 * cloud: {@link preflightPostgresWireV4Migration} lists, read-only, the legacy
 * tasks and every row with no v4 form; {@link migratePostgresToWireV4} takes
 * the confirmed legacy task list back and changes the store in one
 * transaction, or not at all. It ships in 0.31.x only; 0.32.0 removes it
 * (#1017).
 */
import {
  assertWireV4MigrationConfirmed,
  hasUnnamedApproval,
  migrateWireV3Receipt,
  wireV3LegacyOfferReceiptKeys,
  wireV3LegacyOfferType,
  wireV4ReceiptKind,
  type WireV3LegacyTask,
  type WireV4MigrationPreflight,
  type WireV4ReceiptMigrationResult,
  type WireV4UnmappableRow,
} from '@byok-sdk/cloud';
import type { Pool, PoolClient } from 'pg';

const PAGE_SIZE = 500;

interface LegacyTaskRow extends WireV3LegacyTask {
  readonly ownerDeviceId: string | null;
  /** Receipt keys this task owns; the receipt scan skips them. */
  readonly receiptKeys: readonly string[];
}

interface Scan {
  readonly legacyTasks: readonly LegacyTaskRow[];
  readonly unmappable: readonly WireV4UnmappableRow[];
}

/** Lists the legacy tasks and every unmappable row. Changes nothing. */
export async function preflightPostgresWireV4Migration(pool: Pool): Promise<WireV4MigrationPreflight> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return publicPreflight(await scan(client));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/**
 * Migrates the store when the preflight finds no unmappable row and
 * `confirmedLegacyTasks` is exactly the preflight's legacy task list: deletes
 * every row of those tasks, then re-encodes the remaining offer and terminal
 * receipts, in one transaction. Otherwise it throws and changes nothing.
 * Writers must be stopped while it runs.
 */
export async function migratePostgresToWireV4(
  pool: Pool,
  confirmedLegacyTasks: readonly WireV3LegacyTask[],
): Promise<WireV4ReceiptMigrationResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    const found = await scan(client);
    assertWireV4MigrationConfirmed(publicPreflight(found), confirmedLegacyTasks);
    for (const task of found.legacyTasks) await deleteLegacyTask(client, task);
    const { migrated, unchanged } = await reencodeReceipts(client);
    await client.query('COMMIT');
    return { migrated, unchanged, deletedTasks: found.legacyTasks.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function publicPreflight(found: Scan): WireV4MigrationPreflight {
  return {
    legacyTasks: found.legacyTasks.map(({ tenantId, taskId, deviceId, type }) => ({ tenantId, taskId, deviceId, type })),
    unmappable: found.unmappable,
  };
}

async function scan(client: PoolClient): Promise<Scan> {
  const legacyTasks = await findLegacyTasks(client);
  const legacyKeys = new Set(legacyTasks.flatMap((task) => task.receiptKeys.map((key) => `${task.tenantId}\u0000${key}`)));
  const legacyTaskIds = new Set(legacyTasks.map((task) => `${task.tenantId}\u0000${task.taskId}`));
  const unmappable: WireV4UnmappableRow[] = [];
  await eachReceipt(client, (row) => {
    const kind = wireV4ReceiptKind(row.key);
    if (kind === undefined || legacyKeys.has(`${row.tenant_id}\u0000${row.key}`)) return;
    const result = migrateWireV3Receipt(kind, row.body);
    if (result.outcome !== 'refused') return;
    unmappable.push({
      kind: 'receipt',
      tenantId: row.tenant_id,
      key: row.key,
      receiptKind: kind,
      refusal: result.refusal,
      ...(result.type === undefined ? {} : { type: result.type }),
    });
  });
  // Expired tails count until maintenance collects them: drain, wait out the TTL, then migrate.
  const approvals = await client.query<{ tenant_id: string; task_id: string; entries: unknown }>(
    'SELECT tenant_id, task_id, entries FROM approval_timeline_tail ORDER BY tenant_id, task_id',
  );
  for (const row of approvals.rows) {
    if (legacyTaskIds.has(`${row.tenant_id}\u0000${row.task_id}`) || !hasUnnamedApproval(row.entries)) continue;
    unmappable.push({ kind: 'approval', tenantId: row.tenant_id, taskId: row.task_id, refusal: 'approval_id_missing' });
  }
  return { legacyTasks, unmappable };
}

/**
 * Every task without an AgentRef. Only the removed lanes opened one; a task
 * whose offer receipt was never recorded is still legacy, with no type.
 */
async function findLegacyTasks(client: PoolClient): Promise<LegacyTaskRow[]> {
  const tasks: LegacyTaskRow[] = [];
  let after = { tenantId: '', taskId: '' };
  for (;;) {
    const page = await client.query<{ tenant_id: string; task_id: string; device_id: string; owner_device_id: string | null }>(
      `SELECT tenant_id, task_id, device_id, owner_device_id FROM task
        WHERE agent_id IS NULL AND (tenant_id, task_id) > ($1, $2)
        ORDER BY tenant_id, task_id LIMIT $3`,
      [after.tenantId, after.taskId, PAGE_SIZE],
    );
    for (const row of page.rows) {
      const keys = await wireV3LegacyOfferReceiptKeys(row.tenant_id, row.task_id, row.device_id);
      const offer = await client.query<{ body: string }>(
        'SELECT body FROM device_request_receipts WHERE tenant_id = $1 AND key = $2',
        [row.tenant_id, keys.offer],
      );
      const body = offer.rows[0]?.body;
      tasks.push({
        tenantId: row.tenant_id,
        taskId: row.task_id,
        deviceId: row.device_id,
        type: body === undefined ? null : wireV3LegacyOfferType(body) ?? null,
        ownerDeviceId: row.owner_device_id,
        receiptKeys: [keys.offer, keys.delivered, `task:${row.task_id}:terminal`],
      });
    }
    const last = page.rows.at(-1);
    if (page.rows.length < PAGE_SIZE || last === undefined) return tasks;
    after = { tenantId: last.tenant_id, taskId: last.task_id };
  }
}

interface ReceiptRow {
  readonly tenant_id: string;
  readonly key: string;
  readonly body: string;
}

/** Keyset pages bound memory; the receipt families never expire, so the table can be large. */
async function eachReceipt(client: PoolClient, visit: (row: ReceiptRow) => void | Promise<void>): Promise<void> {
  let after = { tenantId: '', key: '' };
  for (;;) {
    const page = await client.query<ReceiptRow>(
      `SELECT tenant_id, key, body FROM device_request_receipts
        WHERE (key LIKE 'task-offer:%' OR key LIKE 'task:%') AND (tenant_id, key) > ($1, $2)
        ORDER BY tenant_id, key LIMIT $3`,
      [after.tenantId, after.key, PAGE_SIZE],
    );
    for (const row of page.rows) await visit(row);
    const last = page.rows.at(-1);
    if (page.rows.length < PAGE_SIZE || last === undefined) return;
    after = { tenantId: last.tenant_id, key: last.key };
  }
}

async function reencodeReceipts(client: PoolClient): Promise<{ migrated: number; unchanged: number }> {
  let migrated = 0;
  let unchanged = 0;
  await eachReceipt(client, async (row) => {
    const kind = wireV4ReceiptKind(row.key);
    if (kind === undefined) return;
    const result = migrateWireV3Receipt(kind, row.body);
    // The preflight in this transaction refused nothing, and legacy rows are gone.
    if (result.outcome === 'refused') throw new Error(`receipt ${row.tenant_id}/${row.key} changed during the migration`);
    if (result.outcome === 'unchanged') {
      unchanged += 1;
      return;
    }
    await client.query('UPDATE device_request_receipts SET body = $3 WHERE tenant_id = $1 AND key = $2', [
      row.tenant_id,
      row.key,
      result.body,
    ]);
    migrated += 1;
  });
  return { migrated, unchanged };
}

/**
 * Deletes every row a legacy task owns. The redaction audit receipt
 * (`task-redaction:<taskId>`) and memory-projection metering receipts are
 * kept: they hold no wire bytes. Object bytes are left to orphan GC once
 * their references are gone.
 */
async function deleteLegacyTask(client: PoolClient, task: LegacyTaskRow): Promise<void> {
  const tenant = task.tenantId;
  const devices = task.ownerDeviceId === null || task.ownerDeviceId === task.deviceId
    ? [task.deviceId]
    : [task.deviceId, task.ownerDeviceId];
  await client.query('DELETE FROM device_request_receipts WHERE tenant_id = $1 AND key = ANY($2::text[])', [
    tenant,
    [...task.receiptKeys, ...devices.map((device) => `agent-message-offer:${device}:${task.taskId}`)],
  ]);
  // An envelope names its task in a compact top-level `task_id`: the text filter
  // narrows the scan and the parse confirms each match, as task redaction does.
  const mailbox = await client.query<{ device_id: string; seq: string; body: string }>(
    `SELECT device_id, seq::text AS seq, body FROM outbox
      WHERE tenant_id = $1 AND device_id = ANY($2::text[]) AND strpos(body, $3) > 0`,
    [tenant, devices, `"task_id":${JSON.stringify(task.taskId)}`],
  );
  for (const row of mailbox.rows.filter((candidate) => envelopeTaskId(candidate.body) === task.taskId)) {
    await client.query('DELETE FROM outbox WHERE tenant_id = $1 AND device_id = $2 AND seq = $3::bigint', [
      tenant,
      row.device_id,
      row.seq,
    ]);
  }
  for (const table of ['approval_timeline_tail', 'activity_tail', 'agent_message_draft']) {
    await client.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND task_id = $2`, [tenant, task.taskId]);
  }
  await releaseReferences(client, tenant, 'sealed-task', task.taskId);
  await releaseReferences(client, tenant, 'truth', `task.terminal:${task.taskId}`);
  await client.query("DELETE FROM attested_record WHERE tenant_id = $1 AND kind = 'task.terminal' AND subject_id = $2", [
    tenant,
    task.taskId,
  ]);
  // `agent_message_admission` rows follow by ON DELETE CASCADE.
  await client.query('DELETE FROM task WHERE tenant_id = $1 AND task_id = $2', [tenant, task.taskId]);
}

/** Manifest row first, then the reference: the lock order of `addReference`. */
async function releaseReferences(client: PoolClient, tenant: string, refKind: string, refId: string): Promise<void> {
  const held = await client.query<{ hash: string }>(
    'SELECT hash FROM object_reference WHERE tenant_id = $1 AND ref_kind = $2 AND ref_id = $3 ORDER BY hash',
    [tenant, refKind, refId],
  );
  for (const { hash } of held.rows) {
    await client.query('SELECT 1 FROM object_manifest WHERE tenant_id = $1 AND hash = $2 FOR UPDATE', [tenant, hash]);
    await client.query('DELETE FROM object_reference WHERE tenant_id = $1 AND hash = $2 AND ref_kind = $3 AND ref_id = $4', [
      tenant,
      hash,
      refKind,
      refId,
    ]);
    await client.query(
      `UPDATE object_manifest SET ref_count = (SELECT count(*) FROM object_reference r WHERE r.tenant_id = $1 AND r.hash = $2)
        WHERE tenant_id = $1 AND hash = $2`,
      [tenant, hash],
    );
  }
}

function envelopeTaskId(body: string): unknown {
  try {
    const value = JSON.parse(body) as unknown;
    return value !== null && typeof value === 'object' ? (value as { readonly task_id?: unknown }).task_id : undefined;
  } catch {
    return undefined;
  }
}
