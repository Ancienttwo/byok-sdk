import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { contentHash, createMutableClock, isCoreError, tenantId } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { PROTOCOL_VERSION } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { isSqliteAvailable, SqliteSchemaError } from '../sqlite-support';
import { createSqliteEmbeddedStores } from '../stores/sqlite';
import { ACTIVITY_LOG_SCHEMA } from '../stores/sqlite/activity';
import { APPROVAL_TIMELINE_V7_REBUILD } from '../stores/sqlite/approval-timeline';
import { rewindToV7 } from './sqlite-v7-fixture';

/**
 * The in-place SQLite upgrades: schema 6 to 7 (#1160) over the store the
 * 0.31.0 release wrote, with rows added through SQL in that file's own v6
 * schema, then 7 to 8 (#1113), which adds the durable activity log empty.
 */

const describeSqlite = (isSqliteAvailable() || process.env.BYOK_REQUIRE_SQLITE === '1') ? describe : describe.skip;
const V6_FIXTURE = fileURLToPath(new URL('../../../../scripts/release/fixtures/stores/0.31.0/server-sqlite.db', import.meta.url));
const TENANT = tenantId('tenant-v6-upgrade');
const NOW = '2026-10-01T00:00:00.000Z';

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A copy of the released v6 store holding a registered device and the stream of one revoked before the upgrade. */
function seededV6Store(): string {
  const directory = mkdtempSync(join(tmpdir(), 'byok-sqlite-v6-'));
  scratch.push(directory);
  const file = join(directory, 'server.db');
  copyFileSync(V6_FIXTURE, file);
  const db = new DatabaseSync(file);
  try {
    expect(db.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()).toEqual({ value: '6' });
    db.prepare(`INSERT INTO device_directory
      (tenant_id, device_id, product_id, machine_id, device_name, device_public_key, proof_key_id, proof_key_epoch)
      VALUES (?, 'kept', 'product', NULL, 'kept device', 'public-key', 'proof-key', 0)`).run(TENANT);
    for (const deviceId of ['kept', 'gone']) {
      db.prepare('INSERT INTO mailbox_cursor (tenant_id, device_id, next_seq, updated_at) VALUES (?, ?, 2, ?)').run(TENANT, deviceId, NOW);
      const body = JSON.stringify({ v: PROTOCOL_VERSION, type: 'task.offer', task_id: `${deviceId}-task` });
      db.prepare(`INSERT INTO mailbox_message
        (tenant_id, device_id, seq, message_id, body, body_hash, byte_size, state, appended_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, 'pending', ?)`)
        .run(TENANT, deviceId, `${deviceId}-offer`, body, `sha256:${'a'.repeat(64)}`, String(body.length), NOW);
    }
  } finally {
    db.close();
  }
  return file;
}

function open(file: string) {
  return createSqliteEmbeddedStores({ path: file }, { clock: createMutableClock(new Date(NOW)), crypto: createWebCrypto() });
}

/**
 * A v7 file: this build's schema without the activity log tables and output
 * closure that v8 added, and with v7's idle-expiring approval timeline.
 * Besides an open task it holds tasks whose output already closed: a
 * completed one, a claimed one with an accepted cancellation, and a failed
 * one from before terminal_at was recorded, last updated months before the
 * upgrade. The open, completed and failed tasks each hold an approval request.
 */
async function seededV7Store(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'byok-sqlite-v7-'));
  scratch.push(directory);
  const file = join(directory, 'server.db');
  const stores = open(file);
  try {
    for (const taskId of ['kept-task', 'done-task', 'cancel-task', 'legacy-task']) {
      await stores.cloud.tasks.open(TENANT, { taskId, deviceId: 'kept' });
    }
    for (const taskId of ['kept-task', 'done-task', 'legacy-task']) await stores.cloud.approvals.append(TENANT, approval(taskId));
    await stores.cloud.tasks.recordStatus(TENANT, { taskId: 'done-task', status: 'complete' });
  } finally {
    await stores.close();
  }
  const db = new DatabaseSync(file);
  try {
    // Under v7's idle expiry every approval row had already lapsed by NOW.
    db.exec(`${rewindToV7('2026-09-30T00:00:00.000Z')}
      UPDATE task_attempt SET status = 'cancel_requested', owner_device_id = 'kept', cancellation_requested_at = '2026-09-30T23:59:00.000Z' WHERE task_id = 'cancel-task';
      UPDATE task_attempt SET status = 'failed', updated_at = '2026-01-01T00:02:00.000Z' WHERE task_id = 'legacy-task';`);
  } finally {
    db.close();
  }
  return file;
}

function activityTables(file: string): unknown[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'activity_log_%' ORDER BY name").all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function approval(taskId: string) {
  return { taskId, sourceEnvelopeId: `${taskId}-request`, event: { type: 'approval_requested' as const, summary: 'Allow', approvalId: `${taskId}-approval` } };
}

const progress = { taskId: 'kept-task', sourceEnvelopeId: 'after-upgrade', batchSeq: 1, events: [{ type: 'turn_end' as const }], dropped: 0, ttlMs: 600_000 };

function append(deviceId: string, messageId: string) {
  const body = JSON.stringify({ v: PROTOCOL_VERSION, type: 'task.cancel', task_id: messageId });
  return {
    deviceId,
    messageId,
    admission: 'cancellation' as const,
    materialize: () => ({ body, bodyHash: contentHash(`sha256:${'b'.repeat(64)}`), byteSize: BigInt(body.length) }),
  };
}

describeSqlite('SQLite in-place schema upgrades', () => {
  it('upgrades the released v6 store in place, keeping its pairings and rows, and closes the streams of retired devices', async () => {
    const file = seededV6Store();
    const stores = open(file);
    try {
      await expect(stores.cloud.devices.get(TENANT, 'kept')).resolves.toMatchObject({ deviceId: 'kept' });
      const kept = await stores.core.mailbox.readAfter(TENANT, { deviceId: 'kept', afterSeq: 0 });
      expect(kept.messages.map((message) => [message.messageId, message.state])).toEqual([['kept-offer', 'pending']]);
      await expect(stores.core.mailbox.append(TENANT, append('kept', 'kept-next'))).resolves.toMatchObject({ seq: 2, state: 'pending' });

      // The device revoked before the upgrade: its row is dead-lettered and its stream refuses appends.
      const gone = await stores.core.mailbox.readAfter(TENANT, { deviceId: 'gone', afterSeq: 0 });
      expect(gone.messages).toEqual([]);
      expect(gone.recoverableFrom).toBe(2);
      const refused = await stores.core.mailbox.append(TENANT, append('gone', 'gone-next')).then(() => undefined, (caught: unknown) => caught);
      expect(isCoreError(refused, 'mailbox_stream_closed')).toBe(true);
      expect(refused).toMatchObject({ deviceId: 'gone', closeCause: 'device_revoked' });
    } finally {
      await stores.close();
    }

    const db = new DatabaseSync(file);
    try {
      expect(db.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()).toEqual({ value: '8' });
      expect(db.prepare('SELECT count(*) AS heads FROM activity_log_head').get()).toEqual({ heads: 0 });
      expect(db.prepare('SELECT device_id, closed_cause FROM mailbox_cursor ORDER BY device_id').all())
        .toEqual([{ device_id: 'gone', closed_cause: 'device_revoked' }, { device_id: 'kept', closed_cause: null }]);
    } finally {
      db.close();
    }

    // A v8 file opens as it is: the upgrade ran once, and its activity log is usable.
    const reopened = open(file);
    try {
      await expect(reopened.cloud.activity.append(TENANT, progress)).resolves.toMatchObject({ cursor: { revision: 1 } });
    } finally {
      await reopened.close();
    }
    expect(activityTables(file)).toEqual(['activity_log_entry', 'activity_log_head']);
  });

  it('upgrades a v7 store in place to 8, adding the activity log empty and keeping its tasks', async () => {
    const file = await seededV7Store();
    expect(activityTables(file)).toEqual([]);
    const stores = open(file);
    try {
      await expect(stores.cloud.tasks.get(TENANT, 'kept-task')).resolves.toMatchObject({ taskId: 'kept-task', deviceId: 'kept' });
      await expect(stores.cloud.activity.read(TENANT, 'kept-task')).resolves.toBeUndefined();
      await expect(stores.cloud.activity.append(TENANT, progress)).resolves.toMatchObject({ cursor: { revision: 1 } });
    } finally {
      await stores.close();
    }
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      expect(db.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()).toEqual({ value: '8' });
    } finally {
      db.close();
    }
    expect(activityTables(file)).toEqual(['activity_log_entry', 'activity_log_head']);
  });

  it('closes the activity of tasks whose output closed before the upgrade, at their original deadline', async () => {
    const file = await seededV7Store();
    const stores = open(file);
    try {
      const done = await stores.cloud.tasks.get(TENANT, 'done-task');
      const closedAt = { 'done-task': done?.terminalAt, 'cancel-task': '2026-09-30T23:59:00.000Z' };
      for (const [taskId, at] of Object.entries(closedAt)) {
        expect(at, taskId).toBeDefined();
        await expect(stores.cloud.activity.read(TENANT, taskId), taskId).resolves.toMatchObject({
          entries: [], terminalAt: at, expiresAt: new Date(Date.parse(at!) + 600_000).toISOString(),
        });
        await expect(stores.cloud.activity.append(TENANT, { ...progress, taskId }), taskId).rejects.toMatchObject({ code: 'activity_task_settled' });
        const timeline = await stores.cloud.approvals.read(TENANT, taskId);
        expect(timeline, taskId).toMatchObject({ terminalAt: at, expiresAt: new Date(Date.parse(at!) + 600_000).toISOString() });
        expect(timeline?.entries.map((entry) => entry.sourceEnvelopeId), taskId).toEqual(taskId === 'done-task' ? ['done-task-request'] : []);
        await expect(stores.cloud.approvals.append(TENANT, { ...approval(taskId), sourceEnvelopeId: 'late' }), taskId).rejects.toMatchObject({ code: 'approval_timeline_settled' });
      }
      // Closed at its last update months ago: already expired, never given a new ten minutes.
      await expect(stores.cloud.activity.read(TENANT, 'legacy-task')).resolves.toBeUndefined();
      await expect(stores.cloud.activity.append(TENANT, { ...progress, taskId: 'legacy-task' })).rejects.toMatchObject({ code: 'activity_task_settled' });
      await expect(stores.cloud.approvals.read(TENANT, 'legacy-task')).resolves.toBeUndefined();
      await expect(stores.cloud.activity.append(TENANT, progress)).resolves.not.toHaveProperty('terminalAt');
      // The open task's request outlived v7's idle deadline and stays pending.
      await expect(stores.cloud.approvals.read(TENANT, 'kept-task')).resolves.toMatchObject({ entries: [{ sourceEnvelopeId: 'kept-task-request' }] });
      await expect(stores.cloud.approvals.read(TENANT, 'kept-task')).resolves.not.toHaveProperty('expiresAt');
    } finally {
      await stores.close();
    }
  });

  it('refuses a v8 file missing its task output closure', async () => {
    const file = await seededV7Store();
    const db = new DatabaseSync(file);
    db.exec(`${ACTIVITY_LOG_SCHEMA}; ${APPROVAL_TIMELINE_V7_REBUILD} UPDATE byok_sqlite_meta SET value = '8' WHERE key = 'schema_version'`);
    db.close();
    expect(() => open(file)).toThrow(expect.objectContaining({
      code: 'SQLITE_SCHEMA_INVALID', foundVersion: '8', message: expect.stringContaining('task output closure'),
    }));
  });

  it.each(['activity_log_entry', 'activity_log_head'])('refuses a v8 file missing %s without recreating it', async (table) => {
    const file = await seededV7Store();
    const db = new DatabaseSync(file);
    db.exec(`${ACTIVITY_LOG_SCHEMA}; ${APPROVAL_TIMELINE_V7_REBUILD} DROP TABLE ${table}; UPDATE byok_sqlite_meta SET value = '8' WHERE key = 'schema_version'`);
    db.close();
    expect(() => open(file)).toThrow(expect.objectContaining({
      code: 'SQLITE_SCHEMA_INVALID', foundVersion: '8', message: expect.stringContaining(`FROM ${table}`),
    }));
    expect(activityTables(file)).not.toContain(table);
  });

  it('still refuses every other older version', () => {
    const file = seededV6Store();
    const db = new DatabaseSync(file);
    db.prepare("UPDATE byok_sqlite_meta SET value = '5' WHERE key = 'schema_version'").run();
    db.close();
    expect(() => open(file)).toThrow(SqliteSchemaError);
    expect(() => open(file)).toThrow(expect.objectContaining({ code: 'SQLITE_SCHEMA_UNSUPPORTED', foundVersion: '5', requiredVersion: '8' }));
    expect(() => open(file)).toThrow('upgrades only 6 and 7 in place');
  });
});
