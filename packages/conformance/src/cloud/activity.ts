import { describe, expect, it } from 'vitest';
import type { ActivityStore } from '@byok-sdk/cloud';
import { TENANT_A } from './fixtures';

export interface ActivityCompositionHandle {
  readonly store: ActivityStore;
  advanceTime(ms: number): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface ActivityCompositionFactory {
  create(): ActivityCompositionHandle | Promise<ActivityCompositionHandle>;
}

async function withActivityComposition(
  factory: ActivityCompositionFactory,
  body: (handle: ActivityCompositionHandle) => Promise<void>,
): Promise<void> {
  const handle = await factory.create();
  try {
    await body(handle);
  } finally {
    await handle.dispose?.();
  }
}

function progress(text: string) {
  return { type: 'progress' as const, text };
}

export function runActivityConformance(
  name: string,
  factory: ActivityCompositionFactory,
): void {
  describe(`activity store conformance [${name}]`, () => {
    it('stores typed events in stable batch order with source identity and cursor', async () => {
      await withActivityComposition(factory, async ({ store }) => {
        await store.append(TENANT_A, {
          taskId: 'task-1',
          sourceEnvelopeId: 'envelope-2',
          batchSeq: 2,
          events: [progress('two-a'), progress('two-b')],
          dropped: 0,
          ttlMs: 300_000,
          capacity: 4,
        });
        const tail = await store.append(TENANT_A, {
          taskId: 'task-1',
          sourceEnvelopeId: 'envelope-1',
          batchSeq: 1,
          events: [progress('one')],
          dropped: 0,
          ttlMs: 300_000,
          capacity: 4,
        });

        expect(tail.entries.map((entry) => [entry.batchSeq, entry.eventIndex, entry.event])).toEqual([
          [1, 0, progress('one')],
          [2, 0, progress('two-a')],
          [2, 1, progress('two-b')],
        ]);
        expect(tail.entries.map((entry) => entry.sourceEnvelopeId)).toEqual([
          'envelope-1',
          'envelope-2',
          'envelope-2',
        ]);
        expect(tail.cursor).toEqual({ batchSeq: 2, eventIndex: 1 });
        expect(tail.entries.every((entry) => entry.taskId === 'task-1')).toBe(true);
        expect(tail.entries.every((entry) => entry.receivedAt.length > 0)).toBe(true);
      });
    });

    it('bounds the tail and adds producer loss to capacity eviction', async () => {
      await withActivityComposition(factory, async ({ store }) => {
        const tail = await store.append(TENANT_A, {
          taskId: 'task-dropped',
          sourceEnvelopeId: 'envelope-drop',
          batchSeq: 7,
          events: [progress('one'), progress('two'), progress('three')],
          dropped: 4,
          ttlMs: 300_000,
          capacity: 2,
        });
        expect(tail.entries.map((entry) => entry.event)).toEqual([progress('two'), progress('three')]);
        expect(tail.dropped).toBe(5);
        expect(tail.capacity).toBe(2);
        expect(tail.cursor).toEqual({ batchSeq: 7, eventIndex: 2 });
      });
    });

    it('retains an unknown event at its original event index', async () => {
      await withActivityComposition(factory, async ({ store }) => {
        const tail = await store.append(TENANT_A, {
          taskId: 'task-unknown',
          sourceEnvelopeId: 'envelope-unknown',
          batchSeq: 3,
          events: [progress('before'), { type: 'future_observation', value: 7 }, { type: 'turn_end' }],
          dropped: 0,
          ttlMs: 300_000,
        });
        expect(tail.entries[1]).toMatchObject({
          eventIndex: 1,
          event: { type: 'future_observation', value: 7 },
        });
      });
    });

    it('fails closed when two source envelopes claim the same order key', async () => {
      await withActivityComposition(factory, async ({ store }) => {
        await store.append(TENANT_A, {
          taskId: 'task-order-collision',
          sourceEnvelopeId: 'envelope-a',
          batchSeq: 4,
          events: [progress('first')],
          dropped: 0,
          ttlMs: 300_000,
        });
        await expect(
          store.append(TENANT_A, {
            taskId: 'task-order-collision',
            sourceEnvelopeId: 'envelope-b',
            batchSeq: 4,
            events: [progress('second')],
            dropped: 0,
            ttlMs: 300_000,
          }),
        ).rejects.toThrow();
      });
    });

    it('treats an expired tail as absent', async () => {
      await withActivityComposition(factory, async (handle) => {
        await handle.store.append(TENANT_A, {
          taskId: 'task-expiry',
          sourceEnvelopeId: 'envelope-expiry',
          batchSeq: 1,
          events: [{ type: 'turn_end' }],
          dropped: 0,
          ttlMs: 300_000,
        });
        expect(await handle.store.read(TENANT_A, 'task-expiry')).toBeDefined();
        await handle.advanceTime(300_000);
        expect(await handle.store.read(TENANT_A, 'task-expiry')).toBeUndefined();
      });
    });

    it('fails closed on malformed known events and missing stable identity', async () => {
      await withActivityComposition(factory, async ({ store }) => {
        await expect(
          store.append(TENANT_A, {
            taskId: 'task-invalid',
            sourceEnvelopeId: ' ',
            batchSeq: 1,
            events: [{ type: 'turn_end' }],
            dropped: 0,
            ttlMs: 300_000,
          }),
        ).rejects.toThrow();
        await expect(
          store.append(TENANT_A, {
            taskId: 'task-invalid',
            sourceEnvelopeId: 'envelope-invalid',
            batchSeq: 1,
            events: [{ type: 'progress' } as never],
            dropped: 0,
            ttlMs: 300_000,
          }),
        ).rejects.toThrow();
      });
    });
  });
}
