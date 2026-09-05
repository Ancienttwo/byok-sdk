/**
 * Inbound dedup conformance: check-and-record is one call, and the retained set
 * is bounded.
 *
 * The wire is at-least-once (docs/protocol.md §9), so this port is what makes
 * processing at-most-once. Two properties have to hold together, and asserting
 * only the first is the easy mistake: a composition that remembers every
 * envelope id forever also passes "the second delivery is a duplicate", and
 * then grows without limit under a chatty device.
 *
 * `DEDUP_RING_CAPACITY` is imported rather than restated because the bound is
 * the contract, not an in-memory detail — a durable composition reclaims to the
 * same depth, and eviction is oldest-first so the ids most likely to be
 * redelivered are the ones still remembered.
 */
import { describe, expect, it } from 'vitest';
import { DEDUP_RING_CAPACITY } from '@byok-sdk/cloud';
import { TENANT_A } from './fixtures';
import { withCloudComposition, type CloudCompositionFactory } from './harness';

export function runDedupConformance(factory: CloudCompositionFactory): void {
  describe('inbound dedup', () => {
    it('reports the first delivery as new and every repeat as a duplicate', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        expect(await stores.dedup.checkAndRecord(TENANT_A, 'device-1', 'env-1')).toBe(false);
        expect(await stores.dedup.checkAndRecord(TENANT_A, 'device-1', 'env-1')).toBe(true);
        expect(await stores.dedup.checkAndRecord(TENANT_A, 'device-1', 'env-1')).toBe(true);
      });
    });

    it('scopes the record to one device', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        expect(await stores.dedup.checkAndRecord(TENANT_A, 'device-1', 'env-1')).toBe(false);
        // The same envelope id from a different device is a different fact.
        expect(await stores.dedup.checkAndRecord(TENANT_A, 'device-2', 'env-1')).toBe(false);
      });
    });

    it('keeps the same envelope id independent for two Agents on one device', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const firstAgent = { agentId: 'agent-one', profileRevision: 'profile-one' } as const;
        const secondAgent = { agentId: 'agent-two', profileRevision: 'profile-two' } as const;
        expect(await stores.dedup.checkAndRecordAgent(TENANT_A, 'device-1', firstAgent, 'env-shared')).toBe(false);
        expect(await stores.dedup.checkAndRecordAgent(TENANT_A, 'device-1', secondAgent, 'env-shared')).toBe(false);
        expect(await stores.dedup.checkAndRecordAgent(TENANT_A, 'device-1', firstAgent, 'env-shared')).toBe(true);
      });
    });

    it(
      'retains at most the contracted capacity, evicting oldest first',
      async () => {
        await withCloudComposition(factory, async ({ stores }) => {
          // The oldest id goes in ALONE, so it is unambiguously first however
          // the rest are ordered — that is the id the eviction assertion below
          // turns on.
          expect(await stores.dedup.checkAndRecord(TENANT_A, 'device-1', 'env-oldest')).toBe(false);

          // The remaining fill is batched rather than serial: a durable
          // composition pays a round trip per call, and DEDUP_RING_CAPACITY of
          // them in sequence is minutes of wall clock for an assertion that
          // does not care about their relative order.
          const remaining = DEDUP_RING_CAPACITY - 1;
          const batchSize = 32;
          for (let start = 0; start < remaining; start += batchSize) {
            const batch = Array.from(
              { length: Math.min(batchSize, remaining - start) },
              (_unused, offset) => `env-${start + offset}`,
            );
            const seen = await Promise.all(
              batch.map((envelopeId) =>
                stores.dedup.checkAndRecord(TENANT_A, 'device-1', envelopeId),
              ),
            );
            expect(seen).toEqual(batch.map(() => false));
          }

          // Exactly at capacity, nothing has been dropped yet.
          expect(await stores.dedup.checkAndRecord(TENANT_A, 'device-1', 'env-oldest')).toBe(true);

          // One past capacity evicts the oldest...
          expect(await stores.dedup.checkAndRecord(TENANT_A, 'device-1', 'overflow')).toBe(false);
          expect(await stores.dedup.checkAndRecord(TENANT_A, 'device-1', 'env-oldest')).toBe(false);
          // ...and the newest is still remembered, which is the half that
          // matters on the wire: a redelivery arrives soon after the original.
          expect(await stores.dedup.checkAndRecord(TENANT_A, 'device-1', 'overflow')).toBe(true);
        });
      },
      // A real database, a real bound: this case makes DEDUP_RING_CAPACITY + 4
      // round trips on purpose, and the default 5s is a budget for assertions
      // that make one.
      60_000,
    );
  });
}
