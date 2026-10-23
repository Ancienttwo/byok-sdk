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
import { tenantId, type ContentHash } from '@byok-sdk/core';
import { sealContent } from '@byok-sdk/core/sealed-payload';
import { byokBlobUrlPath, createEnvelope } from '@byok-sdk/protocol';
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
  uploadObject,
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
      // D had no terminal receipt. A late device terminal finds the fence and stores nothing.
      for (const type of ['task.decline', 'task.cancelled'] as const) {
        expect(await device.send(createEnvelope(type, { reason: `late ${canaryD.text}`, agentRef: AGENT_REF }, { taskId: taskD })))
          .toMatchObject({ status: 200, body: { accepted: 1 } });
      }
      expect(await errorCode(host.cloud.readTerminalReceipt(TENANT_1, taskD))).toBe('task_content_redacted');
      expect(await errorCode(host.cloud.readDeviceTerminal(TENANT_1, taskD))).toBe('task_content_redacted');
      await expect(host.cloud.readTaskAttempt(TENANT_1, taskD)).resolves.toMatchObject({ status: 'cancelled' });
      await expect(host.cloud.readTaskResult(TENANT_1, taskD)).resolves.toMatchObject({ state: 'cancelled' });
      expect(await hitsFor(scope.pool, storage, canaryD, consoleCalls())).toEqual({});
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

  it('keeps an object that another task still names and deletes the object only the redacted task names', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const storage = await createObjectStorageScope();
      const host = await composeRedactionHost(scope.pool, storage);
      const device = await pairDevice(host, TENANT_1);
      const shared = `shared artifact ${randomUUID()}\n`;
      const canaryA = createCanary('sa');
      const canaryC = createCanary('sc');
      const runA = await runTask(host, device, `task-a-${randomUUID()}`, canaryA, [shared, `artifact ${canaryA.text}\n`]);
      // Task C names the same object through A's BlobRef.
      const runC = await runTask(host, device, `task-c-${randomUUID()}`, canaryC, [runA.artifacts![0]!]);
      const objectsBefore = await readObjects(storage);

      expect((await host.cloud.redactTasks(TENANT_1, { taskIds: [runA.taskId] })).tasks)
        .toMatchObject([{ taskId: runA.taskId, outcome: 'redacted', counts: { objectsDeleted: 1 } }]);
      const objectsAfter = await readObjects(storage);
      expect([...objectsBefore.keys()].filter((key) => !objectsAfter.has(key)))
        .toEqual([`tenants/${TENANT_1}/objects/sha256/${runA.artifacts![1]!.hex}`]);
      // Task C still downloads the shared object.
      const response = await device.deviceFetch(byokBlobUrlPath(runC.artifacts![0]!.blobId), { method: 'GET' });
      expect(response.status).toBe(200);
      const { downloadUrl } = (await response.json()) as { downloadUrl: string };
      expect(await (await globalThis.fetch(downloadUrl)).text()).toBe(shared);
    } finally {
      await scope.dispose();
    }
  }, 120_000);

  it('releases the reference that a sealed task holds to its ciphertext blob, and deletes that blob (#654 E3b)', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const storage = await createObjectStorageScope();
      const host = await composeRedactionHost(scope.pool, storage);
      const device = await pairDevice(host, TENANT_1, ['sealed-payload-v1']);
      const taskId = `task-sealed-${randomUUID()}`;
      // Only the input is sealed, so the plaintext terminal below stays legal.
      const sealing = { scopeId: 'scope-redaction', epoch: 1, categories: ['task-input'] } as const;
      const content = await sealContent({
        scopeKey: new Uint8Array(32).fill(7),
        scope: { id: sealing.scopeId, epoch: sealing.epoch },
        chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` },
        sender: 'A'.repeat(43),
        category: 'task-input',
        binding: {
          tenantId: TENANT_1,
          family: 'task.offer_sealed',
          direction: 'server-to-daemon',
          identity: { taskId },
          deviceId: device.deviceId,
          agentRef: null,
          categories: [...sealing.categories],
          notAfter: null,
        },
        // Above the inline limit, so the member names its ciphertext blob.
        plaintext: { instruction: 'x'.repeat(300 * 1024) },
        maxContentLength: 2 * 1024 * 1024,
      });
      const blob = await uploadObject(device, content.ciphertext, 'application/octet-stream');
      const hash = (blob.ref as { contentHash: ContentHash }).contentHash;
      const key = `tenants/${TENANT_1}/objects/sha256/${blob.hex}`;

      await host.cloud.enqueueSealedOffer(TENANT_1, device.deviceId, {
        taskId,
        payload: { runtime: 'pi', sealing, sealed: { ...content.header, ciphertextRef: blob.ref } } as never,
      });
      expect((await host.core.objects.get(TENANT_1, hash))?.refCount).toBe(1);
      expect((await device.poll()).map((event) => [event.type, event.task_id])).toEqual([['task.offer_sealed', taskId]]);
      for (const envelope of [
        createEnvelope('task.claim', { deviceId: device.deviceId }, { taskId }),
        createEnvelope('task.started', {}, { taskId }),
        createEnvelope('task.complete', { summary: 'done', sessionRef: 'session-sealed' }, { taskId }),
      ]) {
        const sent = await device.send(envelope);
        expect(sent, JSON.stringify(sent.body)).toMatchObject({ status: 200, body: { accepted: 1 } });
      }
      await device.poll();
      expect((await readObjects(storage)).has(key)).toBe(true);

      expect((await host.cloud.redactTasks(TENANT_1, { taskIds: [taskId] })).tasks)
        .toMatchObject([{ taskId, outcome: 'redacted', counts: { objectsDeleted: 1 } }]);
      expect((await readObjects(storage)).has(key)).toBe(false);
      expect(await host.core.objects.get(TENANT_1, hash)).toMatchObject({ refCount: 0, state: 'deleted' });
    } finally {
      await scope.dispose();
    }
  }, 120_000);

  it('retries safely after a failure between the object step and the row step', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const storage = await createObjectStorageScope();
      let failRowStep = true;
      // The first tombstone call is the first write of the row step, so this fails after the objects are gone.
      const host = await composeRedactionHost(scope.pool, storage, (store) => ({
        redactTask: (input) => store.redactTask(failRowStep
          ? { ...input, codec: { ...input.codec, tombstone: async () => { throw new Error('row step failed'); } } }
          : input),
      }));
      const device = await pairDevice(host, TENANT_1);
      const canary = createCanary('r');
      const run = await runTask(host, device, `task-r-${randomUUID()}`, canary);
      const objectKey = `tenants/${TENANT_1}/objects/sha256/${run.artifactHex}`;
      const objectsBefore = await readObjects(storage);
      const contentRows = await rowsMarkedBy(scope.pool, [canary.core]);
      expect(objectsBefore.has(objectKey)).toBe(true);
      expect(contentRows.length).toBeGreaterThan(3);

      await expect(host.cloud.redactTasks(TENANT_1, { taskIds: [run.taskId] })).rejects.toThrow('row step failed');
      // The object is gone. The row step rolled back: every content row is as before and no audit row exists.
      // (The task has a terminal receipt, so the row step writes no fence.)
      const objectsAfter = await readObjects(storage);
      expect([...objectsBefore.keys()].filter((key) => !objectsAfter.has(key))).toEqual([objectKey]);
      expect(await rowsMarkedBy(scope.pool, [canary.core])).toEqual(contentRows);
      expect(await rowsMarkedBy(scope.pool, [`task-redaction:${run.taskId}`])).toEqual([]);
      await expect(host.cloud.readTaskResult(TENANT_1, run.taskId)).resolves.toMatchObject({ state: 'complete' });

      failRowStep = false;
      expect((await host.cloud.redactTasks(TENANT_1, { taskIds: [run.taskId] })).tasks).toEqual([{
        taskId: run.taskId,
        outcome: 'redacted',
        counts: { receiptsRedacted: 3, admissionsRedacted: 1, outboxRedacted: 2, ephemeralRowsDeleted: 1, objectsDeleted: 0 },
      }]);
      expect(await hitsFor(scope.pool, storage, canary, [])).toEqual({});
      const audit = await scope.pool.query<{ body: string }>(
        'SELECT body FROM device_request_receipts WHERE tenant_id = $1 AND key = $2',
        [TENANT_1, `task-redaction:${run.taskId}`],
      );
      expect(JSON.parse(audit.rows[0]!.body)).toMatchObject({ counts: { objectsDeleted: 0 } });
    } finally {
      await scope.dispose();
    }
  }, 120_000);
});
