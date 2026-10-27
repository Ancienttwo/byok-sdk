import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableClock } from '@byok-sdk/core';
import {
  createWebCrypto,
  ReceiptMigrationUnmappableError,
  WireV4LegacyTaskListMismatchError,
  wireV3LegacyOfferReceiptKeys,
} from '@byok-sdk/cloud';
import { decodeEnvelope } from '@byok-sdk/protocol';
import { createSqliteEmbeddedStores } from '..';
import { isSqliteAvailable } from '../../../sqlite-support';
import { migrateSqliteToWireV4, preflightSqliteWireV4Migration } from '../wire-v4-receipt-migration';

const v3Terminal = readFileSync(new URL('../../../../../protocol/src/__tests__/golden/v3.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd().split('\n')
  .find((line) => (JSON.parse(line) as { type: string }).type === 'task.complete')!;
const AGENT = { agentId: 'agent-1', profileRevision: 'rev-1' };
// The stored v3 bytes: the v3 type name and `sessionRef`, not a v4 envelope.
const agentOffer = JSON.stringify({ deviceId: 'device-1', type: 'task.offer_for_agent', payload: { instruction: 'x', agentRef: AGENT, sessionRef: 'session-1' } });
const AT = '2026-10-01T00:00:00.000Z';
const LEGACY = { tenantId: 'tenant-a', taskId: 'legacy-1', deviceId: 'device-1', type: 'task.offer' };
const TABLES = ['task_attempt', 'request_receipt', 'mailbox_message', 'agent_message_admission', 'object_manifest', 'object_reference'] as const;

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function emptyStore(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'byok-wire-v4-migration-'));
  directories.push(dir);
  const path = join(dir, 'store.sqlite');
  await createSqliteEmbeddedStores({ path }, { clock: createMutableClock(), crypto: createWebCrypto() }).close();
  return path;
}

function write(path: string, run: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path);
  try { run(db); } finally { db.close(); }
}

function snapshot(path: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  write(path, (db) => { for (const table of TABLES) out[table] = db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3`).all(); });
  return out;
}

const receipt = (db: DatabaseSync, tenant: string, key: string, body: string) =>
  db.prepare('INSERT INTO request_receipt (tenant_id, key, body, recorded_at) VALUES (?, ?, ?, ?)').run(tenant, key, body, AT);
const attempt = (db: DatabaseSync, tenant: string, taskId: string, agent?: typeof AGENT) =>
  db.prepare("INSERT INTO task_attempt (tenant_id, task_id, device_id, agent_ref_json, status, updated_at) VALUES (?, ?, 'device-1', ?, 'complete', ?)")
    .run(tenant, taskId, agent === undefined ? null : JSON.stringify(agent), AT);
const mailbox = (db: DatabaseSync, tenant: string, seq: number, taskId: string, state = 'acked', v = 3) => {
  const body = JSON.stringify({ v, id: `m-${taskId}-${seq}`, ts: AT, type: 'task.cancel', task_id: taskId, seq, payload: {} });
  db.prepare("INSERT INTO mailbox_message VALUES (?, 'device-1', ?, ?, ?, ?, ?, ?, ?)")
    .run(tenant, seq, `m-${taskId}-${seq}`, body, `sha256:${'0'.repeat(64)}`, String(body.length), state, AT);
};

/** A legacy task with a row in every table a task can own on SQLite. */
async function seedLegacyTask(path: string): Promise<void> {
  const { tenantId: tenant, taskId } = LEGACY;
  const keys = await wireV3LegacyOfferReceiptKeys(tenant, taskId, 'device-1');
  write(path, (db) => {
    attempt(db, tenant, taskId);
    receipt(db, tenant, keys.offer, JSON.stringify({ deviceId: 'device-1', type: 'task.offer', payload: { instruction: 'legacy' } }));
    receipt(db, tenant, keys.delivered, keys.offer.slice('task-offer:'.length));
    receipt(db, tenant, `task:${taskId}:terminal`, v3Terminal.replace('task-golden-1', taskId));
    mailbox(db, tenant, 1, taskId);
    db.prepare("INSERT INTO agent_message_admission VALUES (?, ?, 'msg-1', '{}', NULL)").run(tenant, taskId);
    const hash = `sha256:${'b'.repeat(64)}`;
    db.prepare("INSERT INTO object_manifest VALUES (?, ?, '3', 'application/octet-stream', 'committed', ?, ?, NULL)").run(tenant, hash, AT, AT);
    db.prepare("INSERT INTO object_reference VALUES (?, ?, 'sealed-task', ?, ?)").run(tenant, hash, taskId, AT);
  });
}

describe.skipIf(!isSqliteAvailable())('SQLite wire v3 -> v4 migration (#925)', () => {
  it('deletes every row of a confirmed legacy task and re-encodes the remaining v3 receipts', async () => {
    const path = await emptyStore();
    await seedLegacyTask(path);
    write(path, (db) => {
      attempt(db, 'tenant-a', 'agent-1', AGENT);
      receipt(db, 'tenant-a', 'task:agent-1:terminal', v3Terminal);
      receipt(db, 'tenant-b', 'task:agent-1:terminal', v3Terminal);
      receipt(db, 'tenant-a', 'task-offer:agent-offer', agentOffer);
      mailbox(db, 'tenant-a', 2, 'agent-1');
    });

    const preflight = await preflightSqliteWireV4Migration(path);
    expect(preflight).toEqual({ legacyTasks: [LEGACY], unmappable: [] });
    // B2: migrated 2 / unchanged 1 -> migrated 3 / unchanged 0: a v3 `task.offer_for_agent` receipt is renamed to `task.offer` and gains `session`, so it is migrated, not unchanged
    expect(await migrateSqliteToWireV4(path, preflight.legacyTasks)).toEqual({ migrated: 3, unchanged: 0, deletedTasks: 1 });

    const after = snapshot(path);
    expect((after.task_attempt as { task_id: string }[]).map((row) => row.task_id)).toEqual(['agent-1']);
    expect(after.agent_message_admission).toEqual([]);
    expect(after.object_reference).toEqual([]);
    expect(after.object_manifest).toHaveLength(1);
    expect((after.mailbox_message as { message_id: string }[]).map((row) => row.message_id)).toEqual(['m-agent-1-2']);
    const receipts = after.request_receipt as { tenant_id: string; key: string; body: string }[];
    expect(receipts.map((row) => `${row.tenant_id}/${row.key}`).sort()).toEqual([
      'tenant-a/task-offer:agent-offer', 'tenant-a/task:agent-1:terminal', 'tenant-b/task:agent-1:terminal',
    ]);
    for (const row of receipts.filter((r) => r.key.endsWith(':terminal'))) expect(decodeEnvelope(row.body)).toMatchObject({ v: 4 });
    expect(JSON.parse(receipts.find((row) => row.key === 'task-offer:agent-offer')!.body)).toEqual({
      deviceId: 'device-1',
      type: 'task.offer',
      payload: { instruction: 'x', agentRef: AGENT, session: { mode: 'resume', sessionRef: 'session-1' } },
    });
    expect(await preflightSqliteWireV4Migration(path)).toEqual({ legacyTasks: [], unmappable: [] });
    expect(await migrateSqliteToWireV4(path, [])).toEqual({ migrated: 0, unchanged: 3, deletedTasks: 0 });
  });

  it('changes nothing when the confirmed legacy task list differs from the preflight', async () => {
    const path = await emptyStore();
    await seedLegacyTask(path);
    write(path, (db) => receipt(db, 'tenant-a', 'task:agent-1:terminal', v3Terminal));
    const before = snapshot(path);
    for (const confirmed of [[], [{ ...LEGACY, deviceId: 'device-2' }], [LEGACY, { ...LEGACY, taskId: 'other' }]]) {
      await expect(migrateSqliteToWireV4(path, confirmed)).rejects.toBeInstanceOf(WireV4LegacyTaskListMismatchError);
    }
    expect(snapshot(path)).toEqual(before);
  });

  it('changes nothing and lists every unmappable receipt and pending v3 mailbox row', async () => {
    const path = await emptyStore();
    await seedLegacyTask(path);
    write(path, (db) => {
      receipt(db, 'tenant-a', 'task-offer:bad', JSON.stringify({ deviceId: 'device-1', type: 'task.offer_for_agent', payload: { instruction: 'x' } }));
      // v3 `task.offer_for_agent` without `sessionRef` has no v4 form: a missing reference never means fresh.
      receipt(db, 'tenant-a', 'task-offer:no-session', JSON.stringify({ deviceId: 'device-1', type: 'task.offer_for_agent', payload: { instruction: 'x', agentRef: AGENT } }));
      mailbox(db, 'tenant-a', 2, 'agent-1');
      mailbox(db, 'tenant-a', 3, 'agent-1', 'pending');
      // A legacy task's pending row is deleted with the task, not refused.
      mailbox(db, 'tenant-a', 4, LEGACY.taskId, 'pending');
      // SQLite never replays a dead letter.
      mailbox(db, 'tenant-a', 5, 'agent-1', 'expired');
      mailbox(db, 'tenant-a', 6, 'agent-1', 'pending', 4);
    });
    const before = snapshot(path);
    const unmappable = [
      { kind: 'receipt', tenantId: 'tenant-a', key: 'task-offer:bad', receiptKind: 'offer', refusal: 'invalid_under_v4', type: 'task.offer_for_agent' },
      { kind: 'receipt', tenantId: 'tenant-a', key: 'task-offer:no-session', receiptKind: 'offer', refusal: 'invalid_under_v4', type: 'task.offer_for_agent' },
      { kind: 'mailbox', tenantId: 'tenant-a', deviceId: 'device-1', seq: 3, refusal: 'wire_version_unsupported' },
    ];

    expect(await preflightSqliteWireV4Migration(path)).toEqual({ legacyTasks: [LEGACY], unmappable });
    const failure = await migrateSqliteToWireV4(path, [LEGACY]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReceiptMigrationUnmappableError);
    expect((failure as ReceiptMigrationUnmappableError).unmappable).toEqual(unmappable);
    expect(snapshot(path)).toEqual(before);
  });

  it('refuses a path with no store instead of creating one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'byok-wire-v4-migration-'));
    directories.push(dir);
    await expect(preflightSqliteWireV4Migration(join(dir, 'missing.sqlite'))).rejects.toThrow(/No BYOK SQLite database/);
  });
});
