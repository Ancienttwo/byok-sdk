/**
 * Migration 0035 over tasks whose output closed before it (#1113 A3).
 *
 * The one-shot backfill gives each such task a closed activity head and a
 * closed approval timeline at its original deadline, never a new ten minutes. That covers a terminal task, a
 * claimed task with an accepted cancellation, and a terminal task from before
 * terminal_at was recorded, which closes at its last update. An open task
 * stays open, and archived content stays removed. An open task's approval
 * timeline loses its idle deadline and keeps every observation. From then on
 * the trigger closes each task in the update that first closes its output.
 */
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebCrypto, taskArchiveInput } from '@byok-sdk/cloud';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { retireAgentlessTasks } from '../retire-agentless-tasks';
import { PostgresBoardStore } from '../stores/core/board';
import { PostgresTaskArchiveStore } from '../stores/task-archive';
import { PostgresTaskAttemptStore } from '../stores/task-attempts';
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
      // Before 0035 every approval row had an idle deadline; both had lapsed.
      const request = (taskId: string) => JSON.stringify([{ taskId, sourceEnvelopeId: 'request', revision: 1, receivedAt: '2026-01-01T00:00:00.000Z', event: { type: 'approval_requested', summary: 'Allow' } }]);
      for (const taskId of ['running', 'logged']) {
        await scope.pool.query(
          `INSERT INTO approval_timeline_tail (tenant_id, task_id, entries, next_revision, dropped, capacity, expires_at)
           VALUES ('tenant', $1, $2::jsonb, 2, 0, 50, '2026-01-01T00:04:00.000Z')`,
          [taskId, request(taskId)],
        );
      }
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

      const tails = await scope.pool.query<{ task_id: string; terminal_at: string | null; expires_at: string | null; entries: number }>(
        `SELECT task_id, terminal_at, expires_at, jsonb_array_length(entries) AS entries FROM approval_timeline_tail WHERE tenant_id = 'tenant' ORDER BY task_id`,
      );
      expect(tails.rows).toEqual([
        { task_id: 'archived', terminal_at: '2026-01-01T00:02:00.000Z', expires_at: '2026-01-01T00:12:00.000Z', entries: 0 },
        { task_id: 'before-terminal-at', terminal_at: '2026-01-01T00:05:00.000Z', expires_at: '2026-01-01T00:15:00.000Z', entries: 0 },
        { task_id: 'cancel-requested', terminal_at: '2026-01-01T00:01:00.000Z', expires_at: '2026-01-01T00:11:00.000Z', entries: 0 },
        { task_id: 'complete', terminal_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-01T00:10:00.000Z', entries: 0 },
        { task_id: 'logged', terminal_at: '2026-01-01T00:03:00.000Z', expires_at: '2026-01-01T00:13:00.000Z', entries: 1 },
        { task_id: 'running', terminal_at: null, expires_at: null, entries: 1 },
      ]);

      await scope.pool.query(`UPDATE task SET status = 'complete', terminal_at = '2026-01-01T00:20:00.123Z' WHERE task_id = 'running'`);
      const closed = await scope.pool.query(`SELECT terminal_at, expires_at FROM activity_log_head WHERE task_id = 'running'`);
      expect(closed.rows).toEqual([{ terminal_at: '2026-01-01T00:20:00.123Z', expires_at: '2026-01-01T00:30:00.123Z' }]);
      const closedTail = await scope.pool.query(`SELECT terminal_at, expires_at, jsonb_array_length(entries) AS entries FROM approval_timeline_tail WHERE task_id = 'running'`);
      expect(closedTail.rows).toEqual([{ terminal_at: '2026-01-01T00:20:00.123Z', expires_at: '2026-01-01T00:30:00.123Z', entries: 1 }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await scope.dispose();
    }
  });
});

describe.skipIf(SKIP_DATAPLANE)(`Postgres 0038, retireAgentlessTasks, 0039 over tasks without an Agent identity — ${SKIP_REASON}`, () => {
  it('refuses a live one, archives and retires the terminal ones, keeps their ids fenced, then sets NOT NULL', async () => {
    const scope = await createDataplaneScope();
    const directory = await mkdtemp(join(tmpdir(), 'byok-before-0038-'));
    const clock = createMutableClock();
    const crypto = createWebCrypto();
    const tasks = new PostgresTaskAttemptStore(scope.pool, clock);
    const tenant = tenantId('tenant');
    const copy = async (below: string) => {
      for (const name of await readdir(DEPLOY_SQL)) {
        if (name.endsWith('.sql') && name < below) await copyFile(join(DEPLOY_SQL, name), join(directory, name));
      }
    };
    try {
      await copy('0038');
      await migrate(scope.pool, directory);
      await scope.pool.query(`INSERT INTO task (tenant_id, task_id, device_id, agent_id, agent_profile_revision, status, updated_at, archive_after)
        VALUES ('tenant', 'legacy-done', 'device', NULL, NULL, 'complete', now(), '2026-01-01T00:00:00.000Z'),
               ('tenant', 'legacy-live', 'device', NULL, NULL, 'running', now(), NULL),
               ('tenant', 'agent', 'device', 'a', '1', 'offered', now(), NULL)`);
      const [offerKey] = (await taskArchiveInput(crypto, tenant, { taskId: 'legacy-done', deviceId: 'device' }, clock.now().toISOString())).receiptKeys;
      await scope.pool.query(`INSERT INTO device_request_receipts (tenant_id, key, body, recorded_at) VALUES ('tenant', $1, '{"secret":"offer"}', now())`, [offerKey]);
      await new PostgresBoardStore(scope.pool, clock).create(tenant, { itemId: 'legacy-done', channel: 'c', title: 't' });
      await scope.pool.query(`INSERT INTO object_manifest (tenant_id, hash, byte_size, content_type, state, ref_count, created_at, updated_at)
        VALUES ('tenant', 'sha256:x', 1, 'application/octet-stream', 'committed', 1, 'now', 'now')`);
      await scope.pool.query(`INSERT INTO object_reference (tenant_id, hash, ref_kind, ref_id, created_at) VALUES ('tenant', 'sha256:x', 'sealed-task', 'legacy-done', 'now')`);
      // A terminal task whose cancel never reached its offline device.
      await scope.pool.query(`INSERT INTO outbox (tenant_id, device_id, seq, message_id, body, body_hash, byte_size, state, appended_at)
        VALUES ('tenant', 'device', 1, 'm1', '{"task_id":"legacy-done"}', 'h', 25, 'pending', '2026-01-01T00:00:00.000Z')`);
      await expect(tasks.get(tenant, 'legacy-done')).rejects.toMatchObject({ code: 'task_attempt_agent_ref_missing', message: expect.stringContaining('retireAgentlessTasks') });
      await expect(new PostgresTaskArchiveStore(scope.pool, clock).listWork(tenant, { archiveBefore: '2026-02-01T00:00:00.000Z', limit: 10 }))
        .rejects.toMatchObject({ code: 'task_attempt_agent_ref_missing' });
      await copy('0040');

      await expect(migrate(scope.pool, directory)).rejects.toThrow(/2 task\(s\) have no Agent identity; nothing was changed/);
      await expect(retireAgentlessTasks(scope.pool, { clock, crypto })).rejects.toThrow('{"tenant":{"pending_delivery":1,"task_not_terminal":1}}');
      await scope.pool.query(`UPDATE task SET status = 'cancelled' WHERE task_id = 'legacy-live'`);
      await expect(retireAgentlessTasks(scope.pool, { clock, crypto })).rejects.toThrow('{"tenant":{"pending_delivery":1}}');
      expect((await scope.pool.query(`SELECT count(*)::int AS n FROM task_agentless_retired`)).rows).toEqual([{ n: 0 }]);

      await scope.pool.query(`UPDATE outbox SET state = 'expired'`);
      await expect(retireAgentlessTasks(scope.pool, { clock, crypto })).resolves.toEqual({ retired: { tenant: 2 } });
      await expect(retireAgentlessTasks(scope.pool, { clock, crypto })).resolves.toEqual({ retired: {} });
      expect((await scope.pool.query(`SELECT body FROM device_request_receipts WHERE key = $1`, [offerKey])).rows[0].body).not.toContain('secret');
      expect((await scope.pool.query(`SELECT count(*)::int AS n FROM board_item`)).rows).toEqual([{ n: 0 }]);
      expect((await scope.pool.query(`SELECT ref_count FROM object_manifest WHERE hash = 'sha256:x'`)).rows).toEqual([{ ref_count: 0 }]);
      expect((await scope.pool.query(`SELECT task_id FROM task_agentless_retired ORDER BY task_id`)).rows)
        .toEqual([{ task_id: 'legacy-done' }, { task_id: 'legacy-live' }]);
      await expect(migrate(scope.pool, directory)).resolves.toMatchObject({ applied: ['0039_task_agent_ref_not_null.sql'] });
      expect((await scope.pool.query(`SELECT task_id FROM task`)).rows).toEqual([{ task_id: 'agent' }]);
      await expect(scope.pool.query(`INSERT INTO task (tenant_id, task_id, device_id, status, updated_at) VALUES ('tenant', 'x', 'device', 'offered', now())`))
        .rejects.toThrow(/agent_id/);
      await expect(tasks.reserveAgentOffer(tenant, { taskId: 'legacy-done', deviceId: 'device', agentRef: { agentId: 'a', profileRevision: '1' } }))
        .rejects.toMatchObject({ code: 'agent_task_already_exists' });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await scope.dispose();
    }
  });
});
