import { contentHash, tenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { withCloudComposition, type CloudCompositionFactory } from './harness';

const TENANT = tenantId('tenant-cancellation-conformance');

function body(label: string) {
  return {
    body: label,
    bodyHash: contentHash(`sha256:${'a'.repeat(64)}`),
    byteSize: BigInt(new TextEncoder().encode(label).length),
  };
}

export function runTaskCancellationConformance(factory: CloudCompositionFactory): void {
  describe('task cancellation port', () => {
    it('cancels unclaimed work immediately and marks claimed work requested', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.open(TENANT, { taskId: 'unclaimed', deviceId: 'device-1' });
        const unclaimed = await stores.cancellations.request(TENANT, {
          taskId: 'unclaimed',
          proposedMessageId: 'cancel-unclaimed',
          reason: 'stop',
          materialize: async () => body('cancel-unclaimed'),
        });
        expect(unclaimed?.attempt).toMatchObject({
          status: 'cancelled',
          cancellation: { reason: 'stop' },
        });

        await stores.tasks.open(TENANT, { taskId: 'claimed', deviceId: 'device-1' });
        await stores.tasks.claim(TENANT, { taskId: 'claimed', deviceId: 'device-1' });
        const claimed = await stores.cancellations.request(TENANT, {
          taskId: 'claimed',
          proposedMessageId: 'cancel-claimed',
          materialize: async () => body('cancel-claimed'),
        });
        expect(claimed?.attempt.status).toBe('cancel_requested');
      });
    });

    it('is idempotent and retains the first tombstone and delivery', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.open(TENANT, { taskId: 'repeat', deviceId: 'device-repeat' });
        const first = await stores.cancellations.request(TENANT, {
          taskId: 'repeat',
          proposedMessageId: 'cancel-first',
          reason: 'first',
          materialize: async () => body('first'),
        });
        const second = await stores.cancellations.request(TENANT, {
          taskId: 'repeat',
          proposedMessageId: 'cancel-second',
          reason: 'second',
          materialize: async () => body('second'),
        });
        expect(second).toEqual(first);
      });
    });

    it('settles a repeat cancel of claimed work once its delivery row is retired', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        await stores.tasks.open(TENANT, { taskId: 'retired', deviceId: 'device-retired' });
        await stores.tasks.claim(TENANT, { taskId: 'retired', deviceId: 'device-retired' });
        const first = await stores.cancellations.request(TENANT, {
          taskId: 'retired',
          proposedMessageId: 'cancel-retired',
          reason: 'stuck runtime',
          materialize: async () => body('cancel-retired'),
        });
        expect(first?.attempt.status).toBe('cancel_requested');
        expect(first?.message).toBeDefined();
        await expect(handle.retireCancellationDelivery(TENANT, 'device-retired')).resolves.toBe(1);

        let materializations = 0;
        const replay = await stores.cancellations.request(TENANT, {
          taskId: 'retired',
          proposedMessageId: 'cancel-retired-retry',
          reason: 'ignored retry',
          materialize: async () => {
            materializations += 1;
            return body('cancel-retired-retry');
          },
        });

        expect(replay?.attempt).toEqual(first?.attempt);
        expect(replay?.message).toBeUndefined();
        expect(materializations).toBe(0);
        await expect(handle.retireCancellationDelivery(TENANT, 'device-retired')).resolves.toBe(0);
      });
    });

    it('commits neither side when materialization fails and writes nothing for an unknown task', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.open(TENANT, { taskId: 'rollback', deviceId: 'device-rollback' });
        await expect(
          stores.cancellations.request(TENANT, {
            taskId: 'rollback',
            proposedMessageId: 'cancel-rollback',
            materialize: async () => {
              throw new Error('injected failure');
            },
          }),
        ).rejects.toThrow('injected failure');
        await expect(stores.tasks.get(TENANT, 'rollback')).resolves.toMatchObject({
          status: 'offered',
        });
        await expect(
          stores.cancellations.request(TENANT, {
            taskId: 'missing',
            proposedMessageId: 'cancel-missing',
            materialize: async () => body('missing'),
          }),
        ).resolves.toBeUndefined();
      });
    });
  });
}
