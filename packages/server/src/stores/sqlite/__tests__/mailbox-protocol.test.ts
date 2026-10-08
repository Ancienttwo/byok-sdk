import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableClock } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { createSqliteEmbeddedStores } from '..';
import { isSqliteAvailable, openSqliteDatabase, SqliteSchemaError } from '../../../sqlite-support';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const open = (path: string) => createSqliteEmbeddedStores({ path }, { clock: createMutableClock(), crypto: createWebCrypto() });
// Historical v1 golden from 9c6df0fc^; task.cancel payload is unchanged in v2.
const legacyEnvelope = {"v": 1, "id": "00000000-0000-4000-8000-000000000006", "ts": "2026-01-01T00:00:05.000Z", "type": "task.cancel", "task_id": "task-golden-1", "seq": 4, "payload": {"reason": "user cancelled"}};
const envelope = (v: unknown) => JSON.stringify({ ...legacyEnvelope, v });

async function seed(body: string, state: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'byok-mailbox-protocol-'));
  directories.push(dir);
  const path = join(dir, 'store.sqlite');
  await open(path).close();
  const db = openSqliteDatabase(path);
  db.prepare('INSERT INTO mailbox_message VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('tenant', 'device', 1, '00000000-0000-4000-8000-000000000001', body,
      'sha256:' + createHash('sha256').update(body).digest('hex'), String(Buffer.byteLength(body)), state, '2026-10-08T00:00:00.000Z');
  db.close();
  return path;
}

(isSqliteAvailable() ? describe : describe.skip)('SQLite mailbox protocol preflight', () => {
  it.each([envelope(1), envelope(3), envelope('2'), envelope(undefined), 'broken json', 'null'])('rejects unsupported pending authority without changing it: %s', async (body) => {
    const path = await seed(body, 'pending');
    expect(() => open(path)).toThrow(SqliteSchemaError);
    expect(() => open(path)).toThrow(expect.objectContaining({ code: 'SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED' }));
    const db = openSqliteDatabase(path, { readOnly: true });
    expect(db.prepare('SELECT body, state FROM mailbox_message').get()).toEqual({ body, state: 'pending' });
    db.close();
  });

  it.each(['acked', 'expired'])('permits retained v1 history in state %s', async (state) => {
    const path = await seed(envelope(1), state);
    await open(path).close();
  });

  it('opens pending v2 messages', async () => {
    const path = await seed(envelope(2), 'pending');
    await open(path).close();
  });
});
