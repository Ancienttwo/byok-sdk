import {
  APPROVAL_SUMMARY_MAX_BYTES,
  ApprovalTimelineEventSchema,
  type ApprovalTimelineStore,
} from '@byok-sdk/cloud';
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, sealedOutputMember } from './fixtures';

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

    it('keeps a sealed request, replays a reseal by its projection and resolves it while pending (#654 12e)', async () => {
      await withComposition(factory, async ({ store }) => {
        const sealedRequest = (fill: number, mac = 'a') => ({
          taskId: 'task-sealed-approval',
          sourceEnvelopeId: 'request-sealed',
          event: { type: 'approval_requested' as const, approvalId: 'approval-sealed', sealed: sealedOutputMember(fill, mac) },
        });
        const first = await store.append(TENANT_A, sealedRequest(1));
        expect(first.entries[0]?.event).toEqual(sealedRequest(1).event);
        await expect(store.append(TENANT_A, sealedRequest(2))).resolves.toEqual(first);
        await expect(store.append(TENANT_A, sealedRequest(1, 'c'))).rejects.toThrow();
        await expect(
          store.resolvePending(TENANT_A, {
            taskId: 'task-sealed-approval',
            expectedSourceEnvelopeId: 'request-sealed',
            expectedRevision: first.cursor!,
            sourceEnvelopeId: '10000000-0000-8000-8000-000000000654',
            event: {
              type: 'approval_resolved',
              approvalId: 'approval-sealed',
              decision: 'approve',
              resolvedBy: 'host',
              at: '2026-10-24T00:00:00.000Z',
            },
          }),
        ).resolves.toMatchObject({ status: 'applied' });
        expect((await store.read(TENANT_A, 'task-sealed-approval'))?.entries.map((entry) => entry.event.type)).toEqual([
          'approval_requested',
          'approval_resolved',
        ]);
      });
    });

    it('refuses a sealed request without native approval identity', async () => {
      await withComposition(factory, async ({ store }) => {
        await expect(
          store.append(TENANT_A, {
            taskId: 'task-sealed-no-identity',
            sourceEnvelopeId: 'request-sealed-no-identity',
            event: { type: 'approval_requested', sealed: sealedOutputMember() } as never,
          }),
        ).rejects.toThrow();
      });
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

    it('keeps an open timeline however long it idles', async () => {
      await withComposition(factory, async (handle) => {
        await handle.store.append(TENANT_A, {
          taskId: 'task-idle',
          sourceEnvelopeId: 'before-idle',
          event: requested('approval-idle'),
        });
        // An open task's timeline has no deadline; only its output closing starts one (#1113 A3).
        await handle.advanceTime(24 * 60 * 60 * 1_000);
        const tail = await handle.store.read(TENANT_A, 'task-idle');
        expect(tail?.entries.map((entry) => entry.sourceEnvelopeId)).toEqual(['before-idle']);
        expect(tail).not.toHaveProperty('expiresAt');
        const next = await handle.store.append(TENANT_A, {
          taskId: 'task-idle',
          sourceEnvelopeId: 'after-idle',
          event: { type: 'approval_resolved', approvalId: 'approval-idle', decision: 'approve', resolvedBy: 'local', at: '2026-08-16T12:00:00.000Z' },
        });
        expect(next.entries.map((entry) => entry.revision)).toEqual([1, 2]);
      });
    });

    it('never evicts the pending request', async () => {
      await withComposition(factory, async ({ store }) => {
        await store.append(TENANT_A, { taskId: 'task-pending', sourceEnvelopeId: 'request', event: requested('approval-pending'), capacity: 2 });
        for (const approvalId of ['other-1', 'other-2']) {
          await store.append(TENANT_A, {
            taskId: 'task-pending',
            sourceEnvelopeId: `resolution-${approvalId}`,
            event: { type: 'approval_resolved', approvalId, decision: 'reject', resolvedBy: 'local', at: '2026-08-16T12:00:00.000Z' },
            capacity: 2,
          });
        }
        const tail = await store.read(TENANT_A, 'task-pending');
        expect(tail?.entries.map((entry) => entry.sourceEnvelopeId)).toEqual(['request', 'resolution-other-2']);
        expect(tail?.dropped).toBe(1);
      });
    });

    it('refuses a capacity outside 2..50', async () => {
      await withComposition(factory, async ({ store }) => {
        for (const capacity of [1, 51]) {
          await expect(store.append(TENANT_A, {
            taskId: 'task-capacity-invalid', sourceEnvelopeId: `envelope-${capacity}`, event: requested('approval-1'), capacity,
          })).rejects.toMatchObject({ code: 'coordination_input_invalid' });
        }
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
