import { contentHash, tenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { withCloudComposition, type CloudCompositionFactory } from './harness';
import { PI_EXECUTOR } from './fixtures';

const AGENT_REF = { agentId: 'agent-1', profileRevision: 'rev-1' } as const;

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
        await stores.tasks.reserveAgentOffer(TENANT, { taskId: 'unclaimed', deviceId: 'device-1', agentRef: AGENT_REF });
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

        await stores.tasks.reserveAgentOffer(TENANT, { taskId: 'claimed', deviceId: 'device-1', agentRef: AGENT_REF });
        await stores.tasks.claim(TENANT, { taskId: 'claimed', deviceId: 'device-1', executor: PI_EXECUTOR });
        const claimed = await stores.cancellations.request(TENANT, {
          taskId: 'claimed',
          proposedMessageId: 'cancel-claimed',
          materialize: async () => body('cancel-claimed'),
        });
        expect(claimed?.attempt.status).toBe('cancel_requested');
      });
    });

    it('cancels only unclaimed work when asked ifUnclaimed, in either order against claim', async () => {
      await withCloudComposition(factory, async ({ stores, mailbox }) => {
        const cancel = (taskId: string, proposedMessageId: string, ifUnclaimed?: true) =>
          stores.cancellations.request(TENANT, {
            taskId,
            proposedMessageId,
            ...(ifUnclaimed === undefined ? {} : { ifUnclaimed }),
            materialize: async () => body(proposedMessageId),
          });
        await stores.tasks.reserveAgentOffer(TENANT, { taskId: 'claimed-first', deviceId: 'device-if', agentRef: AGENT_REF });
        const claimed = await stores.tasks.claim(TENANT, { taskId: 'claimed-first', deviceId: 'device-if', executor: PI_EXECUTOR });
        await expect(cancel('claimed-first', 'cancel-if-claimed', true)).resolves.toEqual({ attempt: claimed });
        await expect(stores.tasks.get(TENANT, 'claimed-first')).resolves.toEqual(claimed);
        expect((await mailbox.inspect(TENANT, 'device-if')).pending).toEqual([]);

        // A conditional request never lends its answer to a concurrent unconditional one.
        const [, forced] = await Promise.all([
          cancel('claimed-first', 'cancel-if-again', true),
          cancel('claimed-first', 'cancel-forced'),
        ]);
        expect(forced?.attempt.status).toBe('cancel_requested');
        expect(forced?.message?.messageId).toBe('cancel-forced');

        await stores.tasks.reserveAgentOffer(TENANT, { taskId: 'cancel-first', deviceId: 'device-if', agentRef: AGENT_REF });
        const cancelled = await cancel('cancel-first', 'cancel-if-unclaimed', true);
        expect(cancelled?.attempt.status).toBe('cancelled');
        expect(cancelled?.message?.messageId).toBe('cancel-if-unclaimed');
        await expect(stores.tasks.claim(TENANT, { taskId: 'cancel-first', deviceId: 'device-if', executor: PI_EXECUTOR }))
          .resolves.toEqual(cancelled?.attempt);
      });
    });

    it('is idempotent and retains the first tombstone and delivery', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        await stores.tasks.reserveAgentOffer(TENANT, { taskId: 'repeat', deviceId: 'device-repeat', agentRef: AGENT_REF });
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
        await stores.tasks.reserveAgentOffer(TENANT, { taskId: 'retired', deviceId: 'device-retired', agentRef: AGENT_REF });
        await stores.tasks.claim(TENANT, { taskId: 'retired', deviceId: 'device-retired', executor: PI_EXECUTOR });
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
        await stores.tasks.reserveAgentOffer(TENANT, { taskId: 'rollback', deviceId: 'device-rollback', agentRef: AGENT_REF });
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
