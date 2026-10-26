/**
 * The embedded SQLite runner of the one-shot wire v3 -> v4 migration (#925).
 * An operator runs it on a stopped server's database file, after draining v3
 * work: {@link preflightSqliteWireV4Migration} lists, read-only, the legacy
 * tasks and every row with no v4 form; {@link migrateSqliteToWireV4} takes the
 * confirmed legacy task list back and changes the file in one transaction, or
 * not at all. Both take the file's exclusive ownership, so they fail while a
 * server owns it. The approval timeline is in memory on SQLite, so no
 * approval row is stored. It ships in 0.31.x only; 0.32.0 removes it (#1017).
 */
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import {
  assertWireV4MigrationConfirmed,
  migrateWireV3Receipt,
  wireV3LegacyOfferReceiptKeys,
  wireV3LegacyOfferType,
  wireV4ReceiptKind,
  type WireV3LegacyTask,
  type WireV4MigrationPreflight,
  type WireV4ReceiptMigrationResult,
  type WireV4UnmappableRow,
} from '@byok-sdk/cloud';
import { openSqliteDatabase, SqliteSchemaError } from '../../sqlite-support';
import { SQLITE_SCHEMA_VERSION } from './index';

const PAGE_SIZE = 500;

interface LegacyTaskRow extends WireV3LegacyTask {
  readonly ownerDeviceId: string | null;
  readonly receiptKeys: readonly string[];
}

interface Scan {
  readonly legacyTasks: readonly LegacyTaskRow[];
  readonly unmappable: readonly WireV4UnmappableRow[];
}

interface ReceiptRow {
  readonly tenant_id: string;
  readonly key: string;
  readonly body: string;
}

/** Lists the legacy tasks and every unmappable row of the store at `path`. Changes nothing. */
export async function preflightSqliteWireV4Migration(path: string): Promise<WireV4MigrationPreflight> {
  const db = openStore(path);
  try {
    db.exec('BEGIN');
    try {
      assertSchema(db);
      return publicPreflight(await scan(db));
    } finally {
      db.exec('ROLLBACK');
    }
  } finally {
    db.close();
  }
}

/**
 * Migrates the store at `path` when the preflight finds no unmappable row and
 * `confirmedLegacyTasks` is exactly the preflight's legacy task list: deletes
 * every row of those tasks, then re-encodes the remaining offer and terminal
 * receipts, in one transaction. Otherwise it throws and changes nothing.
 */
export async function migrateSqliteToWireV4(
  path: string,
  confirmedLegacyTasks: readonly WireV3LegacyTask[],
): Promise<WireV4ReceiptMigrationResult> {
  const db = openStore(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      assertSchema(db);
      const found = await scan(db);
      assertWireV4MigrationConfirmed(publicPreflight(found), confirmedLegacyTasks);
      for (const task of found.legacyTasks) deleteLegacyTask(db, task);
      const result = reencodeReceipts(db);
      db.exec('COMMIT');
      return { ...result, deletedTasks: found.legacyTasks.length };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

function openStore(path: string): DatabaseSync {
  if (path === ':memory:' || !existsSync(path)) {
    throw new SqliteSchemaError('SQLITE_SCHEMA_INVALID', `No BYOK SQLite database at ${path}`, undefined, SQLITE_SCHEMA_VERSION);
  }
  return openSqliteDatabase(path);
}

function assertSchema(db: DatabaseSync): void {
  const version = (db.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined)?.value;
  if (version !== SQLITE_SCHEMA_VERSION) {
    throw new SqliteSchemaError(
      'SQLITE_SCHEMA_UNSUPPORTED',
      `The wire v4 migration needs BYOK SQLite schema version ${SQLITE_SCHEMA_VERSION}, found ${JSON.stringify(version)}`,
      version,
      SQLITE_SCHEMA_VERSION,
    );
  }
}

function publicPreflight(found: Scan): WireV4MigrationPreflight {
  return {
    legacyTasks: found.legacyTasks.map(({ tenantId, taskId, deviceId, type }) => ({ tenantId, taskId, deviceId, type })),
    unmappable: found.unmappable,
  };
}

async function scan(db: DatabaseSync): Promise<Scan> {
  const legacyTasks = await findLegacyTasks(db);
  const legacyKeys = new Set(legacyTasks.flatMap((task) => task.receiptKeys.map((key) => `${task.tenantId}\u0000${key}`)));
  const unmappable: WireV4UnmappableRow[] = [];
  eachReceipt(db, (row) => {
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
  return { legacyTasks, unmappable };
}

/**
 * Every task without an AgentRef. Only the removed lanes opened one; a task
 * whose offer receipt was never recorded is still legacy, with no type.
 */
async function findLegacyTasks(db: DatabaseSync): Promise<LegacyTaskRow[]> {
  const rows = db.prepare(
    `SELECT tenant_id, task_id, device_id, owner_device_id FROM task_attempt
      WHERE agent_ref_json IS NULL ORDER BY tenant_id, task_id`,
  ).all() as unknown as { tenant_id: string; task_id: string; device_id: string; owner_device_id: string | null }[];
  const offerBody = db.prepare('SELECT body FROM request_receipt WHERE tenant_id = ? AND key = ?');
  const tasks: LegacyTaskRow[] = [];
  for (const row of rows) {
    const keys = await wireV3LegacyOfferReceiptKeys(row.tenant_id, row.task_id, row.device_id);
    const body = (offerBody.get(row.tenant_id, keys.offer) as { body: string } | undefined)?.body;
    tasks.push({
      tenantId: row.tenant_id,
      taskId: row.task_id,
      deviceId: row.device_id,
      type: body === undefined ? null : wireV3LegacyOfferType(body) ?? null,
      ownerDeviceId: row.owner_device_id,
      receiptKeys: [keys.offer, keys.delivered, `task:${row.task_id}:terminal`],
    });
  }
  return tasks;
}

/** Keyset pages bound memory; the receipt families never expire, so the table can be large. */
function eachReceipt(db: DatabaseSync, visit: (row: ReceiptRow) => void): void {
  const page = db.prepare(
    `SELECT tenant_id, key, body FROM request_receipt
      WHERE (key LIKE 'task-offer:%' OR key LIKE 'task:%') AND (tenant_id, key) > (?, ?)
      ORDER BY tenant_id, key LIMIT ?`,
  );
  let after = { tenantId: '', key: '' };
  for (;;) {
    const rows = page.all(after.tenantId, after.key, PAGE_SIZE) as unknown as ReceiptRow[];
    for (const row of rows) visit(row);
    const last = rows.at(-1);
    if (rows.length < PAGE_SIZE || last === undefined) return;
    after = { tenantId: last.tenant_id, key: last.key };
  }
}

function reencodeReceipts(db: DatabaseSync): { migrated: number; unchanged: number } {
  const update = db.prepare('UPDATE request_receipt SET body = ? WHERE tenant_id = ? AND key = ?');
  let migrated = 0;
  let unchanged = 0;
  eachReceipt(db, (row) => {
    const kind = wireV4ReceiptKind(row.key);
    if (kind === undefined) return;
    const result = migrateWireV3Receipt(kind, row.body);
    // The preflight in this transaction refused nothing, and legacy rows are gone.
    if (result.outcome === 'refused') throw new Error(`receipt ${row.tenant_id}/${row.key} changed during the migration`);
    if (result.outcome === 'unchanged') {
      unchanged += 1;
      return;
    }
    update.run(result.body, row.tenant_id, row.key);
    migrated += 1;
  });
  return { migrated, unchanged };
}

/** Deletes every row a legacy task owns. Object bytes are left to orphan GC once their references are gone. */
function deleteLegacyTask(db: DatabaseSync, task: LegacyTaskRow): void {
  const tenant = task.tenantId;
  const devices = task.ownerDeviceId === null || task.ownerDeviceId === task.deviceId
    ? [task.deviceId]
    : [task.deviceId, task.ownerDeviceId];
  const deleteReceipt = db.prepare('DELETE FROM request_receipt WHERE tenant_id = ? AND key = ?');
  for (const key of [...task.receiptKeys, ...devices.map((device) => `agent-message-offer:${device}:${task.taskId}`)]) {
    deleteReceipt.run(tenant, key);
  }
  // An envelope names its task in a compact top-level `task_id`: the text filter
  // narrows the scan and the parse confirms each match.
  const select = db.prepare(
    'SELECT seq, body FROM mailbox_message WHERE tenant_id = ? AND device_id = ? AND instr(body, ?) > 0',
  );
  const remove = db.prepare('DELETE FROM mailbox_message WHERE tenant_id = ? AND device_id = ? AND seq = ?');
  for (const device of devices) {
    const rows = select.all(tenant, device, `"task_id":${JSON.stringify(task.taskId)}`) as unknown as { seq: number; body: string }[];
    for (const row of rows) if (envelopeTaskId(row.body) === task.taskId) remove.run(tenant, device, row.seq);
  }
  db.prepare('DELETE FROM agent_message_admission WHERE tenant_id = ? AND task_id = ?').run(tenant, task.taskId);
  db.prepare("DELETE FROM object_reference WHERE tenant_id = ? AND ref_kind = 'sealed-task' AND ref_id = ?").run(tenant, task.taskId);
  db.prepare('DELETE FROM task_attempt WHERE tenant_id = ? AND task_id = ?').run(tenant, task.taskId);
}

function envelopeTaskId(body: string): unknown {
  try {
    const value = JSON.parse(body) as unknown;
    return value !== null && typeof value === 'object' ? (value as { readonly task_id?: unknown }).task_id : undefined;
  } catch {
    return undefined;
  }
}
