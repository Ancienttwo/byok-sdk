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
import { DEDUP_RING_CAPACITY } from '@byok/cloud';
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

    it('retains at most the contracted capacity, evicting oldest first', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        for (let index = 0; index < DEDUP_RING_CAPACITY; index += 1) {
          expect(await stores.dedup.checkAndRecord(TENANT_A, 'device-1', `env-${index}`)).toBe(
            false,
          );
        }
        // Still full, not yet over: the oldest is remembered at exactly capacity.
        expect(await stores.dedup.checkAndRecord(TENANT_A, 'device-1', 'env-0')).toBe(true);

        // One past capacity evicts the oldest.
        expect(await stores.dedup.checkAndRecord(TENANT_A, 'device-1', 'overflow')).toBe(false);
        expect(await stores.dedup.checkAndRecord(TENANT_A, 'device-1', 'env-0')).toBe(false);
        // ...and the newest is still remembered.
        expect(await stores.dedup.checkAndRecord(TENANT_A, 'device-1', 'overflow')).toBe(true);
      });
    });
  });
}
