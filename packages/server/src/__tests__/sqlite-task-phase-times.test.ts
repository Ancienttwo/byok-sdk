import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { isSqliteAvailable } from '../sqlite-support';
import { rewindToV7 } from './sqlite-v7-fixture';
import { createSqliteEmbeddedStores } from '../stores/sqlite';

const describeSqlite = (isSqliteAvailable() || process.env.BYOK_REQUIRE_SQLITE === '1') ? describe : describe.skip;
const TENANT = tenantId('sqlite-phase-times');
const PHASE_COLUMNS = ['offered_at', 'claimed_at', 'first_output_at', 'terminal_at'];

describeSqlite('SQLite task attempt phase instants (#980)', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('adds the phase columns on open to a v7 file from before them, without backfill', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-sqlite-phases-'));
    directories.push(directory);
    const path = join(directory, 'server.sqlite');
    const clock = createMutableClock(new Date('2026-10-27T00:00:00.000Z'));
    const open = () => createSqliteEmbeddedStores({ path }, { clock, crypto: createWebCrypto() });

    const first = open();
    await first.cloud.tasks.open(TENANT, { taskId: 'old', deviceId: 'device-1' });
    await first.close();
    // v8's activity output closure reads the phase columns, so only an older
    // file can lack them: rewind this one to v7, which had neither.
    const raw = new DatabaseSync(path);
    raw.exec(rewindToV7('2026-10-27T00:10:00.000Z'));
    for (const column of PHASE_COLUMNS) raw.exec(`ALTER TABLE task_attempt DROP COLUMN ${column}`);
    raw.close();

    clock.advance(1_000);
    const reopened = open();
    try {
      const old = await reopened.cloud.tasks.get(TENANT, 'old');
      expect(old).toMatchObject({ status: 'offered', updatedAt: '2026-10-27T00:00:00.000Z' });
      for (const field of ['offeredAt', 'claimedAt', 'firstOutputAt', 'terminalAt']) expect(old).not.toHaveProperty(field);
      const claimed = await reopened.cloud.tasks.claim(TENANT, { taskId: 'old', deviceId: 'device-1' });
      expect(claimed).toMatchObject({ claimedAt: '2026-10-27T00:00:01.000Z' });
      expect(claimed).not.toHaveProperty('offeredAt');
    } finally {
      await reopened.close();
    }
    const check = new DatabaseSync(path);
    expect(check.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()).toEqual({ value: '8' });
    const columns = (check.prepare('PRAGMA table_info(task_attempt)').all() as { name: string }[]).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(PHASE_COLUMNS));
    check.close();
  });
});
