/**
 * Terminal-task archive on Postgres (#1120).
 *
 * Task A completed past `terminalTaskArchiveMs`; task B completed inside the
 * window; task C is still running. One maintenance run archives A only: its
 * canaries leave every row, its board item goes, and its task row and
 * tombstoned receipts stay as the fence. Every device replay and Host
 * resubmit is answered exactly as before the archive. A crash inside the
 * archive transaction changes nothing, and a crash after it leaves an archived
 * task that the next run settles.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RETENTION_POLICY, isCloudError } from '@byok-sdk/cloud';
import { tenantId } from '@byok-sdk/core';
import { createEnvelope } from '@byok-sdk/protocol';
import { migrate } from '../migrate';
import { PostgresActivityStore } from '../stores/activity';
import { createDataplaneScope, createObjectStorageScope, SKIP_DATAPLANE, SKIP_REASON, type DataplaneScope } from './support/dataplane';
import { readTenantRows } from './support/plaintext-scan';
import {
  AGENT_REF,
  completeEnvelope,
  composeRedactionHost,
  createCanary,
  executionInput,
  pairDevice,
  progressEnvelope,
  runTask,
  startTask,
  type Device,
  type RedactionHost,
} from './support/redaction-flow';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('tenant-archive');
const DAY_MS = 86_400_000;

async function rowsMarkedBy(pool: Pool, marks: readonly string[]): Promise<string[]> {
  const { rows } = await readTenantRows(pool);
  return rows
    .map((row) => `${row.table}:${JSON.stringify(row.values.map((value) => (Buffer.isBuffer(value) ? value.toString('hex') : value)))}`)
    .filter((text) => marks.some((mark) => text.includes(mark)))
    .sort();
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return isCloudError(error) ? error.code : String(error);
  }
}

/** Moves a terminal task's eligibility back, as if it ended `days` ago. */
async function age(pool: Pool, taskId: string, days: number): Promise<void> {
  const aged = await pool.query(
    `UPDATE task SET archive_after = archive_after - make_interval(days => $3)
      WHERE tenant_id = $1 AND task_id = $2 AND archive_after IS NOT NULL`,
    [TENANT, taskId, days],
  );
  expect(aged.rowCount).toBe(1);
}

async function maintain(host: RedactionHost) {
  const report = await host.cloud.runMaintenance({ tenant: TENANT, now: host.clock.now().toISOString(), policy: DEFAULT_RETENTION_POLICY });
  return report.steps.find((step) => step.step === 'tasks');
}

async function archiveColumns(pool: Pool, taskId: string) {
  const { rows } = await pool.query<{ archived: boolean; settled: boolean }>(
    'SELECT archived_at IS NOT NULL AS archived, archive_settled_at IS NOT NULL AS settled FROM task WHERE tenant_id = $1 AND task_id = $2',
    [TENANT, taskId],
  );
  return rows[0];
}

/** The Host's board item for a task: same id as the task. */
async function board(host: RedactionHost, taskId: string): Promise<void> {
  await host.core.board.create(TENANT, { itemId: taskId, channel: 'archive', title: taskId });
}

async function setUp(scope: DataplaneScope): Promise<{ host: RedactionHost; device: Device }> {
  await migrate(scope.pool, DEPLOY_SQL);
  const host = await composeRedactionHost(scope.pool, await createObjectStorageScope());
  return { host, device: await pairDevice(host, TENANT) };
}

describe.skipIf(SKIP_DATAPLANE)(`terminal-task archive on Postgres — ${SKIP_REASON}`, () => {
  it('archives only the aged terminal task, keeps its fence, and answers every replay as before', async () => {
    const scope = await createDataplaneScope();
    try {
      const { host, device } = await setUp(scope);
      const canaryA = createCanary('a');
      const canaryB = createCanary('b');
      const canaryC = createCanary('c');
      const taskA = `task-a-${randomUUID()}`;
      const taskB = `task-b-${randomUUID()}`;
      const taskC = `task-c-${randomUUID()}`;
      await board(host, taskA);
      await board(host, taskB);
      await runTask(host, device, taskA, canaryA);
      const runB = await runTask(host, device, taskB, canaryB);
      await startTask(host, device, taskC, canaryC);
      await age(scope.pool, taskA, 91);
      const offerB = await host.cloud.readTaskOffer(TENANT, taskB);
      const rowsB = await rowsMarkedBy(scope.pool, [canaryB.core, taskB, offerB!.messageId, runB.messageId]);
      const rowsC = await rowsMarkedBy(scope.pool, [canaryC.core, taskC]);
      expect(await host.core.board.get(TENANT, taskA)).toBeDefined();
      expect(await rowsMarkedBy(scope.pool, [canaryA.core])).not.toEqual([]);

      const replays = async () => {
        const answers = [];
        for (const envelope of [
          completeEnvelope(taskA, canaryA.text),
          createEnvelope('task.fail', { reason: 'a different terminal', retryable: false, agentRef: AGENT_REF }, { taskId: taskA }),
          progressEnvelope(taskA, 2, canaryA.text),
          createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: AGENT_REF, runtime: 'codex' }, { taskId: taskA }),
        ]) {
          // Each replay is a new envelope id; the answer is what is compared.
          const { status, body } = await device.send(envelope);
          const { outcomes, ...counts } = body as { outcomes: { id: string }[] };
          answers.push({ status, ...counts, outcomes: outcomes.map(({ id: _id, ...outcome }) => outcome) });
        }
        return answers;
      };
      const resubmit = () => errorCode(host.cloud.submitAgentExecution(TENANT, executionInput(taskA, device.deviceId, `instruction ${canaryA.text}`)));
      const before = await replays();
      const resubmitBefore = await resubmit();
      expect(resubmitBefore).toBeDefined();
      // The replays above wrote nothing new for A.
      expect(await rowsMarkedBy(scope.pool, [canaryA.core])).not.toEqual([]);

      expect(await maintain(host)).toEqual({ step: 'tasks', status: 'ok', archived: 1, settled: 1, refused: 0, more: false });

      expect(await rowsMarkedBy(scope.pool, [canaryA.core])).toEqual([]);
      expect(await archiveColumns(scope.pool, taskA)).toEqual({ archived: true, settled: true });
      expect((await scope.pool.query('SELECT removed, retained_bytes FROM activity_log_head WHERE tenant_id = $1 AND task_id = $2', [TENANT, taskA])).rows).toEqual([{ removed: true, retained_bytes: 0 }]);
      expect((await scope.pool.query('SELECT count(*) FROM activity_log_entry WHERE tenant_id = $1 AND task_id = $2 AND body IS NOT NULL', [TENANT, taskA])).rows[0].count).toBe(0n);
      const log = new PostgresActivityStore(scope.pool, { now: () => new Date() });
      await expect(log.append(TENANT, { taskId: taskA, sourceEnvelopeId: 'post-removal', batchSeq: 99, events: [{ type: 'turn_end' }], dropped: 0, ttlMs: 600_000 })).rejects.toMatchObject({ code: 'activity_history_gap' });

      expect(await host.core.board.get(TENANT, taskA)).toBeUndefined();
      await expect(host.cloud.readTaskAttempt(TENANT, taskA)).resolves.toMatchObject({ status: 'complete', archivedAt: expect.any(String) });
      expect(await errorCode(host.cloud.readTaskResult(TENANT, taskA))).toBe('task_content_redacted');
      // B and C are untouched.
      expect(await rowsMarkedBy(scope.pool, [canaryB.core, taskB, offerB!.messageId, runB.messageId])).toEqual(rowsB);
      expect(await rowsMarkedBy(scope.pool, [canaryC.core, taskC])).toEqual(rowsC);
      expect(await host.core.board.get(TENANT, taskB)).toBeDefined();

      // Every answer is what it was before the archive, and nothing new is
      // stored. The winning claim is answered from the task's claim snapshot.
      expect(before[3]).toMatchObject({ accepted: 1 });
      expect(await replays()).toEqual(before);
      expect(await resubmit()).toBe(resubmitBefore);
      expect(await rowsMarkedBy(scope.pool, [canaryA.core])).toEqual([]);

      // A second run finds no work.
      expect(await maintain(host)).toEqual({ step: 'tasks', status: 'ok', archived: 0, settled: 0, refused: 0, more: false });
    } finally {
      await scope.dispose();
    }
  }, 120_000);

  it('answers an unclaimed daemon_interrupted recovery replay as before the archive', async () => {
    const scope = await createDataplaneScope();
    try {
      const { host, device } = await setUp(scope);
      const taskId = `task-recovery-${randomUUID()}`;
      await host.cloud.submitAgentExecution(TENANT, executionInput(taskId, device.deviceId, 'instruction'));
      const offer = (await device.poll()).find((event) => event.type === 'task.offer' && event.task_id === taskId)!;
      const recovery = createEnvelope('task.fail', { reason: 'daemon_interrupted', retryable: false, agentRef: AGENT_REF,
        recovery: { kind: 'daemon_interrupted', offerId: offer.id } }, { taskId });
      expect((await device.send(recovery)).body).toMatchObject({ accepted: 1 });
      await device.poll();
      const before = await device.send(recovery);
      expect(before.body).toMatchObject({ outcomes: [{ outcome: 'duplicate' }] });
      await age(scope.pool, taskId, 91);

      expect(await maintain(host)).toEqual({ step: 'tasks', status: 'ok', archived: 1, settled: 1, refused: 0, more: false });
      expect(await archiveColumns(scope.pool, taskId)).toEqual({ archived: true, settled: true });
      expect(await device.send(recovery)).toEqual(before);
      // A new envelope with the same report no longer matches anything the task kept.
      expect((await device.send(createEnvelope('task.fail', recovery.payload, { taskId }))).body)
        .toMatchObject({ rejected: 1, outcomes: [{ outcome: 'rejected', reason: 'not_permitted' }] });
    } finally {
      await scope.dispose();
    }
  }, 120_000);

  it.each(['redaction then archive', 'archive then redaction'] as const)('refuses a claim once an explicit redaction ran: %s', async (order) => {
    const scope = await createDataplaneScope();
    try {
      const { host, device } = await setUp(scope);
      const taskId = `task-redacted-${randomUUID()}`;
      await runTask(host, device, taskId, createCanary('redacted'));
      const claim = async () => {
        const { outcomes, ...counts } = (await device.send(createEnvelope('task.claim',
          { deviceId: device.deviceId, agentRef: AGENT_REF, runtime: 'codex' }, { taskId }))).body as { outcomes: { id: string }[] };
        return { ...counts, outcomes: outcomes.map(({ id: _id, ...outcome }) => outcome) };
      };
      const refused = { accepted: 0, rejected: 1, outcomes: [{ outcome: 'rejected', reason: 'not_permitted' }] };
      expect(await claim()).toMatchObject({ accepted: 1 });
      const redact = async () => { await host.cloud.redactTasks(TENANT, { taskIds: [taskId] }); };
      const archive = async () => {
        await age(scope.pool, taskId, 91);
        expect(await maintain(host)).toEqual({ step: 'tasks', status: 'ok', archived: 1, settled: 1, refused: 0, more: false });
      };
      if (order === 'redaction then archive') {
        await redact();
        expect(await claim()).toEqual(refused);
        await archive();
      } else {
        await archive();
        expect(await claim()).toMatchObject({ accepted: 1 });
        await redact();
      }
      expect(await claim()).toEqual(refused);
    } finally {
      await scope.dispose();
    }
  }, 120_000);

  it('rolls back a crash inside the archive transaction and archives on the next run', async () => {
    const scope = await createDataplaneScope();
    try {
      const { host, device } = await setUp(scope);
      const canary = createCanary('crash-in');
      const taskId = `task-crash-in-${randomUUID()}`;
      await board(host, taskId);
      await runTask(host, device, taskId, canary);
      await age(scope.pool, taskId, 91);
      const rows = await rowsMarkedBy(scope.pool, [canary.core, taskId]);
      // The last statement of the transaction fails, after every rewrite ran.
      await scope.pool.query(`
        CREATE FUNCTION archive_crash() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'crash inside the archive transaction'; END $$;
        CREATE TRIGGER archive_crash BEFORE UPDATE OF archived_at ON task FOR EACH ROW EXECUTE FUNCTION archive_crash();`);

      expect(await maintain(host)).toMatchObject({ step: 'tasks', status: 'failed' });
      expect(await rowsMarkedBy(scope.pool, [canary.core, taskId])).toEqual(rows);
      expect(await host.core.board.get(TENANT, taskId)).toBeDefined();

      await scope.pool.query('DROP TRIGGER archive_crash ON task; DROP FUNCTION archive_crash();');
      expect(await maintain(host)).toEqual({ step: 'tasks', status: 'ok', archived: 1, settled: 1, refused: 0, more: false });
      expect(await rowsMarkedBy(scope.pool, [canary.core])).toEqual([]);
      expect(await host.core.board.get(TENANT, taskId)).toBeUndefined();
    } finally {
      await scope.dispose();
    }
  }, 120_000);

  it('settles on the next run after a crash between the archive transaction and the board removal', async () => {
    const scope = await createDataplaneScope();
    try {
      const { host, device } = await setUp(scope);
      const canary = createCanary('crash-after');
      const taskId = `task-crash-after-${randomUUID()}`;
      await board(host, taskId);
      await runTask(host, device, taskId, canary);
      await age(scope.pool, taskId, 91);
      const remove = vi.spyOn(host.core.board, 'remove').mockRejectedValueOnce(new Error('crash after the archive transaction'));

      expect(await maintain(host)).toMatchObject({ step: 'tasks', status: 'failed' });
      // The content is gone and the fence holds; only the board item remains.
      expect(await rowsMarkedBy(scope.pool, [canary.core])).toEqual([]);
      expect(await archiveColumns(scope.pool, taskId)).toEqual({ archived: true, settled: false });
      expect(await host.core.board.get(TENANT, taskId)).toBeDefined();

      expect(await maintain(host)).toEqual({ step: 'tasks', status: 'ok', archived: 0, settled: 1, refused: 0, more: false });
      expect(await archiveColumns(scope.pool, taskId)).toEqual({ archived: true, settled: true });
      expect(await host.core.board.get(TENANT, taskId)).toBeUndefined();
      expect(remove).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
      await scope.dispose();
    }
  }, 120_000);
});
