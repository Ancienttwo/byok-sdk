import {
  APPROVAL_SUMMARY_MAX_BYTES,
  ApprovalTimelineEventSchema,
  type ApprovalTimelineStore,
} from '@byok-sdk/cloud';
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B } from './fixtures';

export interface ApprovalTimelineCompositionHandle {
  readonly store: ApprovalTimelineStore;
  advanceTime(ms: number): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface ApprovalTimelineCompositionFactory {
  create():
    | ApprovalTimelineCompositionHandle
    | Promise<ApprovalTimelineCompositionHandle>;
}

async function withComposition(
  factory: ApprovalTimelineCompositionFactory,
  body: (handle: ApprovalTimelineCompositionHandle) => Promise<void>,
): Promise<void> {
  const handle = await factory.create();
  try {
    await body(handle);
  } finally {
    await handle.dispose?.();
  }
}

function requested(approvalId: string | undefined, summary = 'Allow mutation') {
  return {
    type: 'approval_requested' as const,
    summary,
    ...(approvalId === undefined ? {} : { approvalId }),
  };
}

export function runApprovalTimelineConformance(
  name: string,
  factory: ApprovalTimelineCompositionFactory,
): void {
  describe(`approval timeline store conformance [${name}]`, () => {
    it('assigns monotonic revisions and preserves exact lifecycle fields', async () => {
      await withComposition(factory, async ({ store }) => {
        await store.append(TENANT_A, {
          taskId: 'task-1',
          sourceEnvelopeId: 'request-1',
          event: requested('approval-1'),
        });
        const tail = await store.append(TENANT_A, {
          taskId: 'task-1',
          sourceEnvelopeId: 'resolution-1',
          event: {
            type: 'approval_resolved',
            approvalId: 'approval-1',
            decision: 'reject',
            resolvedBy: 'local',
            at: '2026-08-16T12:00:00.000Z',
          },
        });
        expect(tail.entries.map((entry) => entry.revision)).toEqual([1, 2]);
        expect(tail.cursor).toBe(2);
        expect(tail.entries[1]?.event).toEqual({
          type: 'approval_resolved',
          approvalId: 'approval-1',
          decision: 'reject',
          resolvedBy: 'local',
          at: '2026-08-16T12:00:00.000Z',
        });
      });
    });

    it('is idempotent by source envelope identity', async () => {
      await withComposition(factory, async ({ store }) => {
        const input = {
          taskId: 'task-dedup',
          sourceEnvelopeId: 'same-envelope',
          event: requested('approval-dedup'),
        } as const;
        await store.append(TENANT_A, input);
        const duplicate = await store.append(TENANT_A, input);
        expect(duplicate.entries).toHaveLength(1);
        expect(duplicate.cursor).toBe(1);
      });
    });

    it('atomically persists a host rejection payload, replays it exactly, and rejects conflicts', async () => {
      await withComposition(factory, async ({ store }) => {
        const request = await store.append(TENANT_A, {
          taskId: 'task-conditional-resolution',
          sourceEnvelopeId: 'request-conditional',
          event: requested('approval-conditional'),
        });
        const resolution = {
          taskId: 'task-conditional-resolution',
          expectedSourceEnvelopeId: 'request-conditional',
          expectedRevision: request.cursor!,
          sourceEnvelopeId: '10000000-0000-8000-8000-000000000001',
          event: {
            type: 'approval_resolved' as const,
            approvalId: 'approval-conditional',
            decision: 'reject' as const,
            resolvedBy: 'host' as const,
            reason: 'first reason' as const,
            at: '2026-09-05T00:00:00.000Z',
          },
        };
        await expect(store.resolvePending(TENANT_A, resolution)).resolves.toMatchObject({ status: 'applied' });
        await expect(store.resolvePending(TENANT_A, resolution)).resolves.toMatchObject({ status: 'replayed' });
        await expect(
          store.resolvePending(TENANT_A, {
            ...resolution,
            event: { ...resolution.event, reason: 'second reason' },
          }),
        ).resolves.toMatchObject({ status: 'conflict' });
        expect((await store.read(TENANT_A, 'task-conditional-resolution'))?.entries.at(-1)?.event).toMatchObject({
          resolvedBy: 'host',
          decision: 'reject',
          reason: 'first reason',
        });
      });
    });

    it('does not allow a local wire resolution to claim a host rejection payload', () => {
      expect(
        ApprovalTimelineEventSchema.safeParse({
          type: 'approval_resolved',
          approvalId: 'approval-local',
          decision: 'reject',
          resolvedBy: 'local',
          reason: 'not a host command',
          at: '2026-09-05T00:00:00.000Z',
        }).success,
      ).toBe(false);
      expect(
        ApprovalTimelineEventSchema.safeParse({
          type: 'approval_resolved',
          approvalId: 'approval-host',
          decision: 'reject',
          resolvedBy: 'host',
          at: '2026-09-05T00:00:00.000Z',
        }).success,
      ).toBe(false);
    });

    it('refuses a stale expected request after the daemon superseded it', async () => {
      await withComposition(factory, async ({ store }) => {
        const first = await store.append(TENANT_A, {
          taskId: 'task-superseded-resolution',
          sourceEnvelopeId: 'request-first',
          event: requested('approval-first'),
        });
        await store.append(TENANT_A, {
          taskId: 'task-superseded-resolution',
          sourceEnvelopeId: 'request-second',
          event: requested('approval-second'),
        });
        await expect(
          store.resolvePending(TENANT_A, {
            taskId: 'task-superseded-resolution',
            expectedSourceEnvelopeId: 'request-first',
            expectedRevision: first.cursor!,
            sourceEnvelopeId: '10000000-0000-8000-8000-000000000003',
            event: {
              type: 'approval_resolved',
              approvalId: 'approval-first',
              decision: 'approve',
              resolvedBy: 'host',
              at: '2026-09-05T00:00:00.000Z',
            },
          }),
        ).resolves.toMatchObject({ status: 'superseded' });
      });
    });

    it('fails closed when one source envelope identity claims another lifecycle event', async () => {
      await withComposition(factory, async ({ store }) => {
        await store.append(TENANT_A, {
          taskId: 'task-source-conflict',
          sourceEnvelopeId: 'same-envelope',
          event: requested('approval-1'),
        });
        await expect(
          store.append(TENANT_A, {
            taskId: 'task-source-conflict',
            sourceEnvelopeId: 'same-envelope',
            event: requested('approval-2'),
          }),
        ).rejects.toThrow();
      });
    });

    it('serializes concurrent appends to one per-task revision authority', async () => {
      await withComposition(factory, async ({ store }) => {
        await Promise.all([
          store.append(TENANT_A, {
            taskId: 'task-concurrent',
            sourceEnvelopeId: 'envelope-a',
            event: requested('approval-a'),
          }),
          store.append(TENANT_A, {
            taskId: 'task-concurrent',
            sourceEnvelopeId: 'envelope-b',
            event: requested('approval-b'),
          }),
        ]);
        const tail = await store.read(TENANT_A, 'task-concurrent');
        expect(tail?.entries.map((entry) => entry.revision)).toEqual([1, 2]);
        expect(new Set(tail?.entries.map((entry) => entry.sourceEnvelopeId)).size).toBe(2);
      });
    });

    it('bounds retained observations and reports eviction', async () => {
      await withComposition(factory, async ({ store }) => {
        for (let index = 1; index <= 3; index += 1) {
          await store.append(TENANT_A, {
            taskId: 'task-capacity',
            sourceEnvelopeId: `envelope-${index}`,
            event: requested(`approval-${index}`),
            capacity: 2,
          });
        }
        const tail = await store.read(TENANT_A, 'task-capacity');
        expect(tail?.entries.map((entry) => entry.revision)).toEqual([2, 3]);
        expect(tail?.dropped).toBe(1);
        expect(tail?.capacity).toBe(2);
      });
    });

    it('preserves missing request identity without inventing one and isolates tenants', async () => {
      await withComposition(factory, async ({ store }) => {
        const tail = await store.append(TENANT_A, {
          taskId: 'task-unpaired',
          sourceEnvelopeId: 'envelope-unpaired',
          event: requested(undefined),
        });
        expect(tail.entries[0]?.event).toEqual({
          type: 'approval_requested',
          summary: 'Allow mutation',
        });
        expect(await store.read(TENANT_B, 'task-unpaired')).toBeUndefined();
      });
    });

    it('expires the complete bounded window and restarts revision authority', async () => {
      await withComposition(factory, async (handle) => {
        await handle.store.append(TENANT_A, {
          taskId: 'task-expiry',
          sourceEnvelopeId: 'before-expiry',
          event: requested('approval-old'),
          ttlMs: 1_000,
        });
        await handle.advanceTime(1_000);
        expect(await handle.store.read(TENANT_A, 'task-expiry')).toBeUndefined();
        const restarted = await handle.store.append(TENANT_A, {
          taskId: 'task-expiry',
          sourceEnvelopeId: 'after-expiry',
          event: requested('approval-new'),
        });
        expect(restarted.entries.map((entry) => entry.revision)).toEqual([1]);
        expect(restarted.dropped).toBe(0);
      });
    });

    it('fails closed on blank stable identities', async () => {
      await withComposition(factory, async ({ store }) => {
        await expect(
          store.append(TENANT_A, {
            taskId: 'task-invalid',
            sourceEnvelopeId: ' ',
            event: requested('approval-1'),
          }),
        ).rejects.toThrow();
        await expect(
          store.append(TENANT_A, {
            taskId: 'task-invalid',
            sourceEnvelopeId: 'envelope-valid',
            event: requested(' '),
          }),
        ).rejects.toThrow();
        await expect(
          store.append(TENANT_A, {
            taskId: 'task-invalid',
            sourceEnvelopeId: 'envelope-oversized',
            event: requested(
              'approval-oversized',
              'a'.repeat(APPROVAL_SUMMARY_MAX_BYTES + 1),
            ),
          }),
        ).rejects.toThrow();
      });
    });
  });
}
