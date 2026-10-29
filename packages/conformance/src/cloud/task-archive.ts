/**
 * Terminal-task archive conformance (#1120).
 *
 * The archive step keeps a task's identity fence and drops its content: the
 * task row stays and reports `archivedAt`, each receipt body becomes the
 * codec's tombstone, an absent terminal receipt is fenced, and the listing
 * hands back an archived task for settling until `settle` records it. The
 * codec here is a test double: the store must apply whatever codec cloud
 * passes, never its own idea of a tombstone.
 */
import { describe, expect, it } from 'vitest';
import { contentHash, type TenantId } from '@byok-sdk/core';
import type { TaskArchiveStoreInput, TaskRedactionCodec } from '@byok-sdk/cloud';
import { TENANT_A, TENANT_B } from './fixtures';
import { withCloudComposition, type CloudCompositionFactory, type CloudCompositionHandle } from './harness';

const DAY_MS = 86_400_000;
const TOMBSTONE = '{"byokRedacted":1,"test":';

const codec: TaskRedactionCodec = {
  async tombstone(body) {
    const tombstone = `${TOMBSTONE}${JSON.stringify(body.length)}}`;
    return { body: tombstone, bodyHash: contentHash(`sha256:${'0'.repeat(64)}`), byteSize: BigInt(tombstone.length) };
  },
  absent: '{"byokRedacted":1,"absent":true}',
  isTombstone: (body) => body.startsWith('{"byokRedacted":1,'),
  blobHashes: () => [],
};

const terminalKey = (taskId: string) => `task:${taskId}:terminal`;
const tombstoneOf = (body: string) => `${TOMBSTONE}${JSON.stringify(body.length)}}`;
const TERMINAL_BODY = '{"type":"task.complete","secret":"canary"}';
const OFFER_BODY = '{"type":"task.offer","secret":"canary"}';

function archiveInput(taskId: string, archivedAt: string, extraKeys: readonly string[] = []): TaskArchiveStoreInput {
  return {
    taskId,
    receiptKeys: [...extraKeys, terminalKey(taskId)],
    terminalReceiptKey: terminalKey(taskId),
    releaseObjectReferences: [],
    archivedAt,
    codec,
  };
}

async function terminalTask(handle: CloudCompositionHandle, tenant: TenantId, taskId: string, terminalBody?: string): Promise<void> {
  await handle.stores.tasks.open(tenant, { taskId, deviceId: 'device-1' });
  await handle.stores.tasks.recordStatus(tenant, { taskId, status: 'complete' });
  if (terminalBody !== undefined) await handle.stores.receipts.record(tenant, { key: terminalKey(taskId), body: terminalBody });
}

function later(handle: CloudCompositionHandle, ms: number): string {
  return new Date(Date.parse(handle.now()) + ms).toISOString();
}

export function runTaskArchiveConformance(factory: CloudCompositionFactory): void {
  describe('task archive', () => {
    it('lists terminal tasks by archive_after before the cutoff, oldest first, up to the limit, per tenant', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { taskArchive } = handle.stores;
        await terminalTask(handle, TENANT_A, 'archive-old');
        await handle.advanceTime(DAY_MS);
        await terminalTask(handle, TENANT_A, 'archive-newer');
        await handle.stores.tasks.open(TENANT_A, { taskId: 'archive-running', deviceId: 'device-1' });
        await handle.stores.tasks.recordStatus(TENANT_A, { taskId: 'archive-running', status: 'claimed' });
        await terminalTask(handle, TENANT_B, 'archive-other-tenant');
        const cutoff = later(handle, 1);

        expect((await taskArchive.listWork(TENANT_A, { archiveBefore: cutoff, limit: 10 })).map((unit) => [unit.taskId, unit.phase]))
          .toEqual([['archive-old', 'archive'], ['archive-newer', 'archive']]);
        expect((await taskArchive.listWork(TENANT_A, { archiveBefore: cutoff, limit: 1 })).map((unit) => unit.taskId)).toEqual(['archive-old']);
        expect(await taskArchive.listWork(TENANT_A, { archiveBefore: later(handle, 1 - DAY_MS), limit: 10 }))
          .toEqual([expect.objectContaining({ taskId: 'archive-old', deviceId: 'device-1', phase: 'archive' })]);
      });
    });

    it('tombstones the receipt bodies, keeps the rows as the fence, and reports archivedAt', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { taskArchive, receipts, tasks } = handle.stores;
        await terminalTask(handle, TENANT_A, 'archive-a', TERMINAL_BODY);
        await receipts.record(TENANT_A, { key: 'task-offer:archive-a', body: OFFER_BODY });
        await terminalTask(handle, TENANT_B, 'archive-a', '{"type":"task.complete","other":true}');
        const archivedAt = later(handle, 1);

        const result = await taskArchive.archive(TENANT_A, archiveInput('archive-a', archivedAt, ['task-offer:archive-a']));
        expect(result).toMatchObject({ outcome: 'archived', counts: { receiptsRedacted: 2, referencesReleased: 0 } });
        const terminal = await receipts.get(TENANT_A, terminalKey('archive-a'));
        expect(terminal?.body).toBe(tombstoneOf(TERMINAL_BODY));
        expect((await receipts.get(TENANT_A, 'task-offer:archive-a'))?.body).toBe(tombstoneOf(OFFER_BODY));
        expect(await tasks.get(TENANT_A, 'archive-a')).toMatchObject({ status: 'complete', archivedAt });
        // The other tenant's task with the same id is untouched.
        expect((await receipts.get(TENANT_B, terminalKey('archive-a')))?.body).toBe('{"type":"task.complete","other":true}');
        expect((await tasks.get(TENANT_B, 'archive-a'))?.archivedAt).toBeUndefined();
        // A replayed terminal finds the tombstone; the first fact is not overwritten.
        expect((await receipts.record(TENANT_A, { key: terminalKey('archive-a'), body: TERMINAL_BODY })).receipt.body)
          .toBe(tombstoneOf(TERMINAL_BODY));
      });
    });

    it('fences an absent terminal receipt, refuses a task that is not terminal, and is safe to repeat', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { taskArchive, receipts, tasks } = handle.stores;
        await terminalTask(handle, TENANT_A, 'archive-no-terminal');
        await tasks.open(TENANT_A, { taskId: 'archive-running', deviceId: 'device-1' });
        const archivedAt = later(handle, 1);

        expect(await taskArchive.archive(TENANT_A, archiveInput('archive-missing', archivedAt))).toEqual({ outcome: 'not_found' });
        expect(await taskArchive.archive(TENANT_A, archiveInput('archive-running', archivedAt)))
          .toEqual({ outcome: 'refused', reason: 'task_not_terminal' });
        expect(await receipts.get(TENANT_A, terminalKey('archive-running'))).toBeUndefined();
        expect((await tasks.get(TENANT_A, 'archive-running'))?.archivedAt).toBeUndefined();

        expect(await taskArchive.archive(TENANT_A, archiveInput('archive-no-terminal', archivedAt)))
          .toMatchObject({ outcome: 'archived', counts: { receiptsRedacted: 0 } });
        expect((await receipts.get(TENANT_A, terminalKey('archive-no-terminal')))?.body).toBe(codec.absent);
        // A late terminal finds the fence and stores nothing.
        expect((await receipts.record(TENANT_A, { key: terminalKey('archive-no-terminal'), body: '{"type":"task.fail"}' })).created).toBe(false);
        expect(await taskArchive.archive(TENANT_A, archiveInput('archive-no-terminal', later(handle, 2))))
          .toEqual({ outcome: 'already_archived' });
        expect((await tasks.get(TENANT_A, 'archive-no-terminal'))?.archivedAt).toBe(archivedAt);
      });
    });

    it('lists an archived task for settling, ahead of new work, until settle records it', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { taskArchive } = handle.stores;
        await terminalTask(handle, TENANT_A, 'archive-first');
        await terminalTask(handle, TENANT_A, 'archive-second');
        const cutoff = later(handle, 1);
        expect(await taskArchive.archive(TENANT_A, archiveInput('archive-second', cutoff))).toMatchObject({ outcome: 'archived' });

        expect((await taskArchive.listWork(TENANT_A, { archiveBefore: cutoff, limit: 10 })).map((unit) => [unit.taskId, unit.phase]))
          .toEqual([['archive-second', 'settle'], ['archive-first', 'archive']]);
        await taskArchive.settle(TENANT_A, 'archive-second', cutoff);
        await taskArchive.settle(TENANT_A, 'archive-second', cutoff);
        await taskArchive.settle(TENANT_A, 'archive-unknown', cutoff);
        expect((await taskArchive.listWork(TENANT_A, { archiveBefore: cutoff, limit: 10 })).map((unit) => [unit.taskId, unit.phase]))
          .toEqual([['archive-first', 'archive']]);
      });
    });
  });
}
