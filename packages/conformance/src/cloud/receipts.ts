/**
 * Request receipt conformance: the FIRST fact is the fact.
 *
 * The wire is at-least-once, so a retried terminal arrives again with the same
 * key. It must not overwrite what was recorded the first time (§12.6.4:
 * 不覆写第一份事实), and the caller learns it was a replay from `created:
 * false` rather than from comparing bodies. A durable composition expresses
 * this as `INSERT ... ON CONFLICT DO NOTHING` — an upsert that updates would
 * pass the naive "record twice" check while silently rewriting history.
 */
import { describe, expect, it } from 'vitest';
import { TENANT_A } from './fixtures';
import { withCloudComposition, type CloudCompositionFactory } from './harness';

export function runReceiptConformance(factory: CloudCompositionFactory): void {
  describe('request receipts', () => {
    it('records a new receipt and reads it back', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        const { receipt, created } = await stores.receipts.record(TENANT_A, {
          key: 'terminal:task-1',
          body: 'first',
        });
        expect(created).toBe(true);
        expect(receipt).toMatchObject({ tenantId: TENANT_A, key: 'terminal:task-1', body: 'first' });
        expect(receipt.recordedAt).toBe(handle.now());

        expect(await stores.receipts.get(TENANT_A, 'terminal:task-1')).toEqual(receipt);
      });
    });

    it('never overwrites the first fact', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        const first = await stores.receipts.record(TENANT_A, {
          key: 'terminal:task-1',
          body: 'first',
        });

        await handle.advanceTime(60_000);

        const replay = await stores.receipts.record(TENANT_A, {
          key: 'terminal:task-1',
          body: 'second',
        });
        expect(replay.created).toBe(false);
        expect(replay.receipt).toEqual(first.receipt);
        // Including the instant: a replay does not restamp the fact.
        expect(replay.receipt.recordedAt).toBe(first.receipt.recordedAt);
        expect((await stores.receipts.get(TENANT_A, 'terminal:task-1'))?.body).toBe('first');
      });
    });

    it('answers undefined for a key that was never recorded', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        expect(await stores.receipts.get(TENANT_A, 'terminal:never')).toBeUndefined();
      });
    });

    it('resolves exactly one winner when the same key races', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const results = await Promise.all(
          ['a', 'b', 'c', 'd'].map((body) =>
            stores.receipts.record(TENANT_A, { key: 'terminal:task-1', body }),
          ),
        );
        expect(results.filter((result) => result.created)).toHaveLength(1);

        const stored = await stores.receipts.get(TENANT_A, 'terminal:task-1');
        const winner = results.find((result) => result.created)!;
        expect(stored).toEqual(winner.receipt);
        // Every replay was handed the winner's body, not its own.
        for (const result of results) {
          expect(result.receipt.body).toBe(winner.receipt.body);
        }
      });
    });
  });
}
