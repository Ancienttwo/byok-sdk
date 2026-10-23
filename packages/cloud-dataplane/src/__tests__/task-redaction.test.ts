/**
 * Scoped row-delete of plaintext task content on Postgres and S3 (#654 E5a).
 *
 * Tasks A and B run on one device of tenant 1, and a task with A's id runs in
 * tenant 2. Task D is cancelled before a claim, with its canary in the
 * instruction and in the cancel reason. Each task carries its own canary.
 * After `redactTasks([A, D])` the canary scan of `hosted-plaintext-inventory`
 * finds neither A's nor D's canary in any table, object or console line, and
 * every row and object of B and of tenant 2 is byte-equal to its state before.
 */
import { randomUUID } from 'node:crypto';
import { format } from 'node:util';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { isCloudError } from '@byok-sdk/cloud';
import { tenantId } from '@byok-sdk/core';
import { createEnvelope } from '@byok-sdk/protocol';
import { migrate } from '../migrate';
import { createDataplaneScope, createObjectStorageScope, SKIP_DATAPLANE, SKIP_REASON } from './support/dataplane';
import { readObjects, readTenantRows, record, scanObjects, scanPostgres, type Hits } from './support/plaintext-scan';
import {
  AGENT_REF,
  completeEnvelope,
  completeTask,
  composeRedactionHost,
  createCanary,
  executionInput,
  pairDevice,
  progressEnvelope,
  publishEnvelope,
  runTask,
  startTask,
  type Canary,
} from './support/redaction-flow';
import { fileURLToPath } from 'node:url';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT_1 = tenantId('tenant-redaction-1');
const TENANT_2 = tenantId('tenant-redaction-2');

/** The text of every row whose text holds one of `marks`, sorted. */
async function rowsMarkedBy(pool: Pool, marks: readonly string[]): Promise<string[]> {
  const { rows } = await readTenantRows(pool);
  return rows
    .map((row) => `${row.table}:${JSON.stringify(row.values.map((value) => (Buffer.isBuffer(value) ? value.toString('hex') : value)))}`)
    .filter((text) => marks.some((mark) => text.includes(mark)))
    .sort();
}

/** Every row, as text, sorted. */
async function allRows(pool: Pool): Promise<string[]> {
  return rowsMarkedBy(pool, ['']);
}

async function hitsFor(
  pool: Pool,
  storage: Awaited<ReturnType<typeof createObjectStorageScope>>,
  canary: Canary,
  console: readonly unknown[][],
): Promise<Record<string, string[]>> {
  const hits: Hits = new Map();
  for (const args of console) record(hits, 'log:console', format(...args), canary.needles);
  expect(await scanPostgres(pool, canary.needles, hits)).toBeGreaterThan(0);
  await scanObjects(storage, TENANT_1, canary.needles, hits);
  return Object.fromEntries([...hits].map(([location, forms]) => [location, [...forms].sort()]));
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return isCloudError(error) ? error.code : `unexpected: ${String(error)}`;
  }
}

describe.skipIf(SKIP_DATAPLANE)(`task redaction on Postgres — ${SKIP_REASON}`, () => {
  it('leaves zero canary hits for the redacted tasks and no change for any other task', async () => {
    const scope = await createDataplaneScope();
    const consoleSpies = (['debug', 'info', 'log', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level));
    const consoleCalls = () => consoleSpies.flatMap((spy) => spy.mock.calls);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const storage = await createObjectStorageScope();
      const host = await composeRedactionHost(scope.pool, storage);
      const device = await pairDevice(host, TENANT_1);
      const other = await pairDevice(host, TENANT_2);
      const canaryA = createCanary('a');
      const canaryB = createCanary('b');
      const canaryD = createCanary('d');
      const canaryOther = createCanary('t');
      const taskA = `task-a-${randomUUID()}`;
      const taskB = `task-b-${randomUUID()}`;
      const taskD = `task-d-${randomUUID()}`;
      const redact = (...taskIds: string[]) => host.cloud.redactTasks(TENANT_1, { taskIds });

      // A running task is refused; nothing changes.
      const startedA = await startTask(host, device, taskA, canaryA);
      const running = await allRows(scope.pool);
      expect((await redact(taskA)).tasks).toEqual([{ taskId: taskA, outcome: 'refused', reason: 'task_not_terminal' }]);
      expect(await allRows(scope.pool)).toEqual(running);

      // A terminal task with an unacked mailbox row is refused until the device acks it.
      const runA = await completeTask(host, device, startedA, canaryA);
      expect((await redact(taskA)).tasks).toEqual([{ taskId: taskA, outcome: 'refused', reason: 'pending_delivery' }]);
      await device.poll();

      const runB = await runTask(host, device, taskB, canaryB);
      const runOther = await runTask(host, other, taskA, canaryOther);
      await host.cloud.submitAgentExecution(TENANT_1, executionInput(taskD, device.deviceId, `instruction ${canaryD.text}`));
      await host.cloud.cancelTask(TENANT_1, taskD, `reason ${canaryD.text}`);
      await expect(host.cloud.readTaskAttempt(TENANT_1, taskD)).resolves.toMatchObject({ status: 'cancelled' });
      await device.poll();
      await device.poll();

      // What a Host resubmit answers before the redaction.
      const resubmit = () => host.cloud.submitAgentExecution(TENANT_1, executionInput(taskA, device.deviceId, `instruction ${canaryA.text}`));
      const changed = () => host.cloud.submitAgentExecution(TENANT_1, executionInput(taskA, device.deviceId, 'another instruction'));
      const resubmitBefore = await errorCode(resubmit());
      const changedBefore = await errorCode(changed());
      expect(resubmitBefore).toBeDefined();

      const offerB = await host.cloud.readTaskOffer(TENANT_1, taskB);
      const marksB = [canaryB.core, taskB, offerB!.messageId, runB.artifactHex, runB.messageId];
      const rowsB = await rowsMarkedBy(scope.pool, marksB);
      const rowsOther = await rowsMarkedBy(scope.pool, [TENANT_2]);
      const objectsBefore = await readObjects(storage);
      expect(rowsB.length).toBeGreaterThan(5);
      expect(await hitsFor(scope.pool, storage, canaryA, consoleCalls())).not.toEqual({});

      const result = await redact(taskA, taskD);
      expect(result.tasks).toEqual([
        {
          taskId: taskA,
          outcome: 'redacted',
          counts: { receiptsRedacted: 3, admissionsRedacted: 1, outboxRedacted: 2, ephemeralRowsDeleted: 1, objectsDeleted: 1 },
        },
        {
          taskId: taskD,
          outcome: 'redacted',
          counts: { receiptsRedacted: 2, admissionsRedacted: 0, outboxRedacted: 2, ephemeralRowsDeleted: 0, objectsDeleted: 0 },
        },
      ]);

      // Zero hits for the redacted tasks.
      expect(await hitsFor(scope.pool, storage, canaryA, consoleCalls())).toEqual({});
      expect(await hitsFor(scope.pool, storage, canaryD, consoleCalls())).toEqual({});
      // No change for task B or for tenant 2.
      expect(await rowsMarkedBy(scope.pool, marksB)).toEqual(rowsB);
      expect(await rowsMarkedBy(scope.pool, [TENANT_2])).toEqual(rowsOther);
      const objectsAfter = await readObjects(storage);
      const deletedKeys = [...objectsBefore.keys()].filter((key) => !objectsAfter.has(key));
      expect(deletedKeys).toEqual([`tenants/${TENANT_1}/objects/sha256/${runA.artifactHex}`]);
      for (const [key, bytes] of objectsAfter) expect(bytes.equals(objectsBefore.get(key)!), key).toBe(true);
      expect(objectsAfter.has(`tenants/${TENANT_2}/objects/sha256/${runOther.artifactHex}`)).toBe(true);
      expect(Object.keys(await hitsFor(scope.pool, storage, canaryB, consoleCalls())).length).toBeGreaterThan(3);

      // A second call changes no row.
      const settled = await allRows(scope.pool);
      expect((await redact(taskA, taskD)).tasks.map((task) => task.outcome)).toEqual(['already_redacted', 'already_redacted']);
      expect(await allRows(scope.pool)).toEqual(settled);

      // Content reads are closed; status reads stay.
      expect(await errorCode(host.cloud.readTaskOffer(TENANT_1, taskA))).toBe('task_content_redacted');
      expect(await errorCode(host.cloud.readTaskResult(TENANT_1, taskA))).toBe('task_content_redacted');
      await expect(host.cloud.readTaskAttempt(TENANT_1, taskA)).resolves.toMatchObject({ status: 'complete' });
      await expect(host.cloud.readTaskResult(TENANT_1, taskD)).resolves.toMatchObject({ state: 'cancelled' });
      await expect(host.cloud.cancelTask(TENANT_1, taskD)).resolves.toMatchObject({ status: 'cancelled' });

      // Device replays after the redaction keep no content and raise no error.
      expect(await device.send(completeEnvelope(taskA, canaryA.text))).toMatchObject({ status: 200, body: { accepted: 1 } });
      expect(await device.send(progressEnvelope(taskA, 2, canaryA.text))).toMatchObject({ status: 200, body: { accepted: 1 } });
      expect(await device.send(await publishEnvelope(taskA, canaryA.text, randomUUID())))
        .toMatchObject({ status: 200, body: { accepted: 0, rejected: 1 } });
      expect(await device.send(createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: AGENT_REF, runtime: 'codex' }, { taskId: taskA })))
        .toMatchObject({ status: 200, body: { accepted: 0, rejected: 1 } });
      expect(host.consumed.filter((body) => body.includes(canaryA.core))).toHaveLength(1);
      // Host resubmits answer as before.
      expect(await errorCode(resubmit())).toBe(resubmitBefore);
      expect(await errorCode(changed())).toBe(changedBefore);
      await device.poll();
      expect(await hitsFor(scope.pool, storage, canaryA, consoleCalls())).toEqual({});
      expect(await rowsMarkedBy(scope.pool, marksB)).toEqual(rowsB);
    } finally {
      vi.restoreAllMocks();
      await scope.dispose();
    }
  }, 120_000);
});
