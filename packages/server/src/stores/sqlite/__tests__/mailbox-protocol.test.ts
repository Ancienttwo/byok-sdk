import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableClock } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { PROTOCOL_VERSION } from '@byok-sdk/protocol';
import { createSqliteEmbeddedStores } from '..';
import { isSqliteAvailable, SqliteSchemaError } from '../../../sqlite-support';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const open = (path: string) => createSqliteEmbeddedStores({ path }, { clock: createMutableClock(), crypto: createWebCrypto() });
// Historical v1 golden from 9c6df0fc^; the task.cancel payload is unchanged in v2, v3 and v4.
const legacyEnvelope = {"v": 1, "id": "00000000-0000-4000-8000-000000000006", "ts": "2026-01-01T00:00:05.000Z", "type": "task.cancel", "task_id": "task-golden-1", "seq": 4, "payload": {"reason": "user cancelled"}};
const envelope = (v: unknown) => JSON.stringify({ ...legacyEnvelope, v });

async function seed(body: string, state: string): Promise<{ readonly dir: string; readonly path: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'byok-mailbox-protocol-'));
  directories.push(dir);
  const path = join(dir, 'store.sqlite');
  await open(path).close();
  const db = new DatabaseSync(path);
  db.prepare('INSERT INTO mailbox_message VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('tenant', 'device', 1, '00000000-0000-4000-8000-000000000001', body,
      'sha256:' + createHash('sha256').update(body).digest('hex'), String(Buffer.byteLength(body)), state, '2026-10-08T00:00:00.000Z');
  db.close();
  return { dir, path };
}

/**
 * Every durable file in the state directory with its content hash: the main
 * database and any WAL. The `-shm` wal-index is excluded: it is a transient
 * shared-memory index (created by the read-only verification readers below),
 * never database content.
 */
function footprint(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).filter((name) => !name.endsWith('-shm')).sort().map((name) =>
    [name, createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')]));
}

function rows(path: string): unknown[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM mailbox_message ORDER BY tenant_id, device_id, seq').all();
  } finally {
    db.close();
  }
}

((isSqliteAvailable() || process.env.BYOK_REQUIRE_SQLITE === '1') ? describe : describe.skip)('SQLite mailbox protocol preflight', () => {
  it('fences on wire v4', () => {
    expect(PROTOCOL_VERSION).toBe(4);
  });

  it.each([envelope(1), envelope(2), envelope(3), envelope(5), envelope('4'), envelope(undefined), 'broken json', 'null'])('rejects unsupported pending authority without changing it: %s', async (body) => {
    const { path } = await seed(body, 'pending');
    expect(() => open(path)).toThrow(SqliteSchemaError);
    expect(() => open(path)).toThrow(expect.objectContaining({ code: 'SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED' }));
    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare('SELECT body, state FROM mailbox_message').get()).toEqual({ body, state: 'pending' });
    db.close();
  });

  it('refuses to open with an undrained pending v3 row and leaves the database byte- and row-identical', async () => {
    const body = envelope(3);
    const { dir, path } = await seed(body, 'pending');
    const bytesBefore = footprint(dir);
    const rowsBefore = rows(path);
    expect(rowsBefore).toHaveLength(1);

    let refusal: unknown;
    try {
      open(path);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SqliteSchemaError);
    expect(refusal).toMatchObject({ code: 'SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED' });
    expect((refusal as Error).message).toContain(`protocol v${PROTOCOL_VERSION}`);

    expect(footprint(dir)).toEqual(bytesBefore);
    expect(rows(path)).toEqual(rowsBefore);
    // A second attempt fails the same way: the refusal did not consume or
    // reclassify the row.
    expect(() => open(path)).toThrow(expect.objectContaining({ code: 'SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED' }));
    expect(footprint(dir)).toEqual(bytesBefore);
  });

  it.each([[1, 'acked'], [1, 'expired'], [2, 'acked'], [2, 'expired'], [3, 'acked'], [3, 'expired']])('permits retained v%i history in state %s', async (v, state) => {
    const { path } = await seed(envelope(v), state);
    await open(path).close();
  });

  it('opens pending v4 messages', async () => {
    const { path } = await seed(envelope(PROTOCOL_VERSION), 'pending');
    await open(path).close();
  });
});
