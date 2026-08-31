/**
 * Challenge nonce conformance: bound to one (tenant, device), consumable once, and
 * dead after `NONCE_TTL_MS`.
 *
 * `NONCE_TTL_MS` is imported rather than restated because it is the contract
 * (docs/protocol.md §6.2), not an in-memory implementation detail: a
 * composition that outlived it would widen the replay window without anything
 * failing. Expiry is asserted through the injected clock, so a durable
 * composition has to bind its own clock into the predicate instead of letting
 * the database answer `now()`.
 */
import { describe, expect, it } from 'vitest';
import { NONCE_TTL_MS } from '@byok-sdk/cloud';
import { TENANT_A } from './fixtures';
import { withCloudComposition, type CloudCompositionFactory } from './harness';

export function runNonceConformance(factory: CloudCompositionFactory): void {
  describe('nonces', () => {
    it('consumes a freshly issued nonce only for its own device', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const nonce = await stores.nonces.issue(TENANT_A, 'device-1');
        expect(nonce.length).toBeGreaterThan(0);

        // Same tenant, different device: the nonce is bound to the pair.
        expect(await stores.nonces.consumeIfValid(TENANT_A, 'device-2', nonce)).toBe(false);
        expect(await stores.nonces.consumeIfValid(TENANT_A, 'device-1', nonce)).toBe(true);
      });
    });

    it('rejects a nonce that was never issued', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        expect(await stores.nonces.consumeIfValid(TENANT_A, 'device-1', 'never-issued')).toBe(false);
      });
    });

    it('admits exactly one consume winner', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const nonce = await stores.nonces.issue(TENANT_A, 'device-1');
        const results = await Promise.all([
          stores.nonces.consumeIfValid(TENANT_A, 'device-1', nonce),
          stores.nonces.consumeIfValid(TENANT_A, 'device-1', nonce),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await stores.nonces.consumeIfValid(TENANT_A, 'device-1', nonce)).toBe(false);
      });
    });

    it('stops consuming once the TTL has elapsed', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        const valid = await stores.nonces.issue(TENANT_A, 'device-1');
        const expired = await stores.nonces.issue(TENANT_A, 'device-1');

        await handle.advanceTime(NONCE_TTL_MS - 1);
        expect(await stores.nonces.consumeIfValid(TENANT_A, 'device-1', valid)).toBe(true);

        await handle.advanceTime(2);
        expect(await stores.nonces.consumeIfValid(TENANT_A, 'device-1', expired)).toBe(false);
      });
    });

    it('issues a distinct nonce every time', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const issued = new Set<string>();
        for (let index = 0; index < 8; index += 1) {
          issued.add(await stores.nonces.issue(TENANT_A, 'device-1'));
        }
        expect(issued.size).toBe(8);
      });
    });
  });
}
