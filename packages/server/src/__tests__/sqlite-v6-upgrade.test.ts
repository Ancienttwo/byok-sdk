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

/**
 * #1160: the one in-place SQLite upgrade, schema 6 to 7, over the store the
 * 0.31.0 release wrote. Rows are added through SQL in that file's own v6
 * schema, then this build opens it.
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

function append(deviceId: string, messageId: string) {
  const body = JSON.stringify({ v: PROTOCOL_VERSION, type: 'task.cancel', task_id: messageId });
  return {
    deviceId,
    messageId,
    admission: 'cancellation' as const,
    materialize: () => ({ body, bodyHash: contentHash(`sha256:${'b'.repeat(64)}`), byteSize: BigInt(body.length) }),
  };
}

describeSqlite('SQLite schema 6 to 7', () => {
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
      expect(db.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()).toEqual({ value: '7' });
      expect(db.prepare('SELECT device_id, closed_cause FROM mailbox_cursor ORDER BY device_id').all())
        .toEqual([{ device_id: 'gone', closed_cause: 'device_revoked' }, { device_id: 'kept', closed_cause: null }]);
    } finally {
      db.close();
    }

    // A v7 file opens as it is: the upgrade ran once.
    const reopened = open(file);
    await reopened.close();
  });

  it('still refuses every other older version', () => {
    const file = seededV6Store();
    const db = new DatabaseSync(file);
    db.prepare("UPDATE byok_sqlite_meta SET value = '5' WHERE key = 'schema_version'").run();
    db.close();
    expect(() => open(file)).toThrow(SqliteSchemaError);
    expect(() => open(file)).toThrow(expect.objectContaining({ code: 'SQLITE_SCHEMA_UNSUPPORTED', foundVersion: '5', requiredVersion: '7' }));
  });
});
