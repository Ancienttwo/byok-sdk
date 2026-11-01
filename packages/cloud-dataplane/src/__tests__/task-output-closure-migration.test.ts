/**
 * Migration 0035 over tasks whose output closed before it (#1113 A3).
 *
 * The one-shot backfill gives each such task a closed activity head at its
 * original deadline, never a new ten minutes. That covers a terminal task, a
 * claimed task with an accepted cancellation, and a terminal task from before
 * terminal_at was recorded, which closes at its last update. An open task
 * stays open, and archived content stays removed. From then on the trigger
 * closes each task in the update that first closes its output.
 */
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { createDataplaneScope, SKIP_DATAPLANE, SKIP_REASON } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const MIGRATION = '0035_task_output_closure.sql';

describe.skipIf(SKIP_DATAPLANE)(`Postgres 0035 over tasks closed before it — ${SKIP_REASON}`, () => {
  it('closes them at their original deadline and leaves open and archived tasks as they were', async () => {
    const scope = await createDataplaneScope();
    const directory = await mkdtemp(join(tmpdir(), 'byok-before-0035-'));
    try {
      for (const name of await readdir(DEPLOY_SQL)) {
        if (name.endsWith('.sql') && name < '0035') await copyFile(join(DEPLOY_SQL, name), join(directory, name));
      }
      await migrate(scope.pool, directory);
      const task = (taskId: string, status: string, columns: { terminal_at?: string; cancel_requested_at?: string } = {}) => scope.pool.query(
        `INSERT INTO task (tenant_id, task_id, device_id, status, updated_at, terminal_at, cancel_requested_at)
         VALUES ('tenant', $1, 'device', $2, '2026-01-01T00:05:00.000Z', $3, $4)`,
        [taskId, status, columns.terminal_at ?? null, columns.cancel_requested_at ?? null],
      );
      await task('complete', 'complete', { terminal_at: '2026-01-01T00:00:00.000Z' });
      await task('cancel-requested', 'cancel_requested', { cancel_requested_at: '2026-01-01T00:01:00.000Z' });
      await task('before-terminal-at', 'failed');
      await task('running', 'running');
      await task('archived', 'complete', { terminal_at: '2026-01-01T00:02:00.000Z' });
      await task('logged', 'complete', { terminal_at: '2026-01-01T00:03:00.000Z' });
      await scope.pool.query(`INSERT INTO activity_log_head (tenant_id, task_id, removed) VALUES ('tenant', 'archived', true)`);
      await scope.pool.query(`INSERT INTO activity_log_head (tenant_id, task_id, revision) VALUES ('tenant', 'logged', 4)`);
      await copyFile(join(DEPLOY_SQL, MIGRATION), join(directory, MIGRATION));

      await expect(migrate(scope.pool, directory)).resolves.toMatchObject({ applied: [MIGRATION] });

      const heads = await scope.pool.query<{ task_id: string; terminal_at: string | null; expires_at: string | null; removed: boolean; revision: string }>(
        `SELECT task_id, terminal_at, expires_at, removed, revision::text FROM activity_log_head WHERE tenant_id = 'tenant' ORDER BY task_id`,
      );
      expect(heads.rows).toEqual([
        { task_id: 'archived', terminal_at: null, expires_at: null, removed: true, revision: '0' },
        { task_id: 'before-terminal-at', terminal_at: '2026-01-01T00:05:00.000Z', expires_at: '2026-01-01T00:15:00.000Z', removed: false, revision: '0' },
        { task_id: 'cancel-requested', terminal_at: '2026-01-01T00:01:00.000Z', expires_at: '2026-01-01T00:11:00.000Z', removed: false, revision: '0' },
        { task_id: 'complete', terminal_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-01T00:10:00.000Z', removed: false, revision: '0' },
        { task_id: 'logged', terminal_at: '2026-01-01T00:03:00.000Z', expires_at: '2026-01-01T00:13:00.000Z', removed: false, revision: '4' },
      ]);

      await scope.pool.query(`UPDATE task SET status = 'complete', terminal_at = '2026-01-01T00:20:00.123Z' WHERE task_id = 'running'`);
      const closed = await scope.pool.query(`SELECT terminal_at, expires_at FROM activity_log_head WHERE task_id = 'running'`);
      expect(closed.rows).toEqual([{ terminal_at: '2026-01-01T00:20:00.123Z', expires_at: '2026-01-01T00:30:00.123Z' }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await scope.dispose();
    }
  });
});
