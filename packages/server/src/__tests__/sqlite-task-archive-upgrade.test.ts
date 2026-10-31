import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { isSqliteAvailable } from '../sqlite-support';
import { createSqliteEmbeddedStores } from '../stores/sqlite';

const describeSqlite = (isSqliteAvailable() || process.env.BYOK_REQUIRE_SQLITE === '1') ? describe : describe.skip;
const TENANT = tenantId('sqlite-task-archive');

function archiveAfter(path: string): Record<string, string | null> {
  const db = new DatabaseSync(path);
  try {
    const rows = db.prepare('SELECT task_id, archive_after FROM task_attempt ORDER BY task_id').all() as { task_id: string; archive_after: string | null }[];
    return Object.fromEntries(rows.map((row) => [row.task_id, row.archive_after]));
  } finally {
    db.close();
  }
}

describeSqlite('SQLite terminal-task archive columns (#1120)', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('backfills archive_after once on open to a file from before it, and later opens keep it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-sqlite-archive-'));
    directories.push(directory);
    const path = join(directory, 'server.sqlite');
    const clock = createMutableClock(new Date('2026-10-27T00:00:00.000Z'));
    const open = () => createSqliteEmbeddedStores({ path }, { clock, crypto: createWebCrypto() });

    const first = open();
    await first.cloud.tasks.open(TENANT, { taskId: 'done', deviceId: 'device-1' });
    await first.cloud.tasks.recordStatus(TENANT, { taskId: 'done', status: 'complete' });
    await first.cloud.tasks.open(TENANT, { taskId: 'running', deviceId: 'device-1' });
    await first.close();
    // The file as an earlier release wrote it: no archive columns, and a
    // terminal task whose terminal instant was never recorded.
    const raw = new DatabaseSync(path);
    raw.exec('DROP INDEX task_attempt_archive_idx; DROP INDEX task_attempt_unsettled_idx;');
    for (const column of ['archive_after', 'archived_at', 'archive_settled_at']) raw.exec(`ALTER TABLE task_attempt DROP COLUMN ${column}`);
    raw.prepare("UPDATE task_attempt SET terminal_at = NULL, updated_at = '2026-10-26T00:00:00.000Z' WHERE task_id = 'done'").run();
    raw.close();

    clock.advance(1_000);
    await (await open()).close();
    expect(archiveAfter(path)).toEqual({ done: '2026-10-26T00:00:00.000Z', running: null });

    // A later open finds the column and backfills nothing.
    const moved = new DatabaseSync(path);
    moved.prepare("UPDATE task_attempt SET archive_after = '2026-10-25T00:00:00.000Z' WHERE task_id = 'done'").run();
    moved.close();
    const reopened = open();
    try {
      expect(await reopened.cloud.tasks.get(TENANT, 'done')).not.toHaveProperty('terminalAt');
    } finally {
      await reopened.close();
    }
    expect(archiveAfter(path)).toEqual({ done: '2026-10-25T00:00:00.000Z', running: null });
  });
});
