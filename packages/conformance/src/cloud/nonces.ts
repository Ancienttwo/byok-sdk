/**
 * Challenge nonce conformance: bound to one (tenant, device), valid once, and
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
    it('validates a freshly issued nonce for its own device only', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const nonce = await stores.nonces.issue(TENANT_A, 'device-1');
        expect(nonce.length).toBeGreaterThan(0);

        expect(await stores.nonces.validate(TENANT_A, 'device-1', nonce)).toBe(true);
        // Same tenant, different device: the nonce is bound to the pair.
        expect(await stores.nonces.validate(TENANT_A, 'device-2', nonce)).toBe(false);
      });
    });

    it('rejects a nonce that was never issued', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        expect(await stores.nonces.validate(TENANT_A, 'device-1', 'never-issued')).toBe(false);
      });
    });

    it('never validates a nonce twice once it has been consumed', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        const nonce = await stores.nonces.issue(TENANT_A, 'device-1');
        expect(await stores.nonces.validate(TENANT_A, 'device-1', nonce)).toBe(true);

        await stores.nonces.markUsed(TENANT_A, nonce);

        expect(await stores.nonces.validate(TENANT_A, 'device-1', nonce)).toBe(false);
        // Consuming twice is a no-op, not an error: the gate calls it after
        // every other check has already passed.
        await stores.nonces.markUsed(TENANT_A, nonce);
        expect(await stores.nonces.validate(TENANT_A, 'device-1', nonce)).toBe(false);
      });
    });

    it('stops validating once the TTL has elapsed', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        const nonce = await stores.nonces.issue(TENANT_A, 'device-1');

        await handle.advanceTime(NONCE_TTL_MS - 1);
        expect(await stores.nonces.validate(TENANT_A, 'device-1', nonce)).toBe(true);

        await handle.advanceTime(2);
        expect(await stores.nonces.validate(TENANT_A, 'device-1', nonce)).toBe(false);
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
