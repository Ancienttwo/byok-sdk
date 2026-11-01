/**
 * Task output closure conformance (#1113 A3).
 *
 * The attempt write that first closes a task's output closes its activity
 * log in the same commit, whichever port wrote it. That write is the task's
 * first terminal (`recordStatus`, abandonment, device retirement) or an
 * accepted Host cancellation, claimed or not. From then on no append is
 * admitted, and the log expires ten minutes after that instant. Reads,
 * replays and later terminals never renew it.
 */
import { contentHash, tenantId } from '@byok-sdk/core';
import type { ActivityAppendInput } from '@byok-sdk/cloud';
import { describe, expect, it } from 'vitest';
import { registration } from './fixtures';
import { withCloudComposition, type CloudCompositionFactory, type CloudConformanceStores } from './harness';

const TENANT = tenantId('tenant-output-closure-conformance');
const TTL_MS = 600_000;

function progress(taskId: string, seq: number): ActivityAppendInput {
  return { taskId, sourceEnvelopeId: `${taskId}-${seq}`, batchSeq: seq, events: [{ type: 'progress', text: `${seq}` }], dropped: 0, ttlMs: TTL_MS };
}

function cancelBody(label: string) {
  return { body: label, bodyHash: contentHash(`sha256:${'c'.repeat(64)}`), byteSize: BigInt(new TextEncoder().encode(label).length) };
}

function deadline(at: string): string {
  return new Date(Date.parse(at) + TTL_MS).toISOString();
}

async function claimed(stores: CloudConformanceStores, taskId: string, deviceId = 'device-1'): Promise<void> {
  await stores.tasks.open(TENANT, { taskId, deviceId });
  await stores.tasks.claim(TENANT, { taskId, deviceId });
}

/** The log is closed at `at`: it keeps what it had, refuses the next append, and expires at `at` + ten minutes. */
async function expectClosedAt(stores: CloudConformanceStores, taskId: string, at: string | undefined, retained: number): Promise<void> {
  expect(at, taskId).toBeDefined();
  const tail = await stores.activity.read(TENANT, taskId);
  expect(tail, taskId).toMatchObject({ terminalAt: at, expiresAt: deadline(at!) });
  expect(tail?.entries, taskId).toHaveLength(retained);
  await expect(stores.activity.append(TENANT, progress(taskId, 99)), taskId).rejects.toMatchObject({ code: 'activity_task_settled' });
}

export function runTaskOutputClosureConformance(factory: CloudCompositionFactory): void {
  describe('task output closure', () => {
    it('the first terminal closes the activity log at its instant, and nothing renews the deadline', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        await claimed(stores, 'task');
        const logged = await stores.activity.append(TENANT, progress('task', 1));
        const terminal = await stores.tasks.recordStatus(TENANT, { taskId: 'task', status: 'complete' });
        await expectClosedAt(stores, 'task', terminal?.terminalAt, 1);
        // A replay of what was admitted still returns the log; it is not new output.
        await expect(stores.activity.append(TENANT, progress('task', 1))).resolves.toMatchObject({ cursor: logged.cursor, terminalAt: terminal?.terminalAt });
        await handle.advanceTime(TTL_MS - 1);
        await stores.tasks.recordStatus(TENANT, { taskId: 'task', status: 'failed' });
        await expectClosedAt(stores, 'task', terminal?.terminalAt, 1);
        await handle.advanceTime(1);
        await expect(stores.activity.read(TENANT, 'task')).resolves.toBeUndefined();
        await expect(stores.activity.read(TENANT, 'task', { after: logged.cursor })).rejects.toMatchObject({ code: 'activity_history_gap' });
        await expect(stores.activity.append(TENANT, progress('task', 2))).rejects.toMatchObject({ code: 'activity_task_settled' });
      });
    });

    it('a task that logged nothing is closed too', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await claimed(stores, 'silent');
        const terminal = await stores.tasks.recordStatus(TENANT, { taskId: 'silent', status: 'failed' });
        await expectClosedAt(stores, 'silent', terminal?.terminalAt, 0);
      });
    });

    it('an accepted Host cancellation closes the log at its request instant, claimed or not', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.devices.register(TENANT, registration('device-1'));
        await stores.tasks.open(TENANT, { taskId: 'unclaimed', deviceId: 'device-1' });
        const unclaimed = await stores.cancellations.request(TENANT, {
          taskId: 'unclaimed', proposedMessageId: 'cancel-unclaimed', materialize: async () => cancelBody('cancel-unclaimed'),
        });
        await expectClosedAt(stores, 'unclaimed', unclaimed?.attempt.cancellation?.requestedAt, 0);

        await claimed(stores, 'running');
        await stores.tasks.recordStatus(TENANT, { taskId: 'running', status: 'running' });
        await stores.activity.append(TENANT, progress('running', 1));
        const requested = await stores.cancellations.request(TENANT, {
          taskId: 'running', proposedMessageId: 'cancel-running', materialize: async () => cancelBody('cancel-running'),
        });
        expect(requested?.attempt.status).toBe('cancel_requested');
        const requestedAt = requested?.attempt.cancellation?.requestedAt;
        await expectClosedAt(stores, 'running', requestedAt, 1);
        // The device's own cancelled terminal later keeps the request's deadline.
        await stores.tasks.recordStatus(TENANT, { taskId: 'running', status: 'cancelled' });
        await expectClosedAt(stores, 'running', requestedAt, 1);
      });
    });

    it('abandonment and device retirement close every task they settle', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.devices.register(TENANT, registration('kept'));
        await stores.devices.register(TENANT, registration('retired'));
        await claimed(stores, 'abandoned', 'kept');
        await stores.activity.append(TENANT, progress('abandoned', 1));
        const abandoned = await stores.cancellations.abandon(TENANT, { taskId: 'abandoned', cause: 'operator' });
        await expectClosedAt(stores, 'abandoned', abandoned?.terminalAt, 1);

        await stores.tasks.open(TENANT, { taskId: 'retired-offered', deviceId: 'retired' });
        await claimed(stores, 'retired-running', 'retired');
        await stores.activity.append(TENANT, progress('retired-running', 1));
        await claimed(stores, 'kept-running', 'kept');
        await stores.devices.revoke(TENANT, 'retired');
        for (const taskId of ['retired-offered', 'retired-running']) {
          const attempt = await stores.tasks.get(TENANT, taskId);
          await expectClosedAt(stores, taskId, attempt?.terminalAt, taskId === 'retired-running' ? 1 : 0);
        }
        // A task the retirement did not settle stays open.
        await expect(stores.activity.append(TENANT, progress('kept-running', 1))).resolves.toMatchObject({ entries: [{ revision: 1 }] });
        await expect(stores.activity.read(TENANT, 'kept-running')).resolves.not.toHaveProperty('terminalAt');
      });
    });
  });
}
