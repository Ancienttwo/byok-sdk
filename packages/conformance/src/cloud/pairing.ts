/**
 * Pairing code conformance: single consumption, and one answer for every way a
 * redemption can fail.
 *
 * Single-use is what makes the caller's "redeem, then register the device row"
 * sequence exclusive — a second redeem can never reach the registration step.
 * That is why a durable composition has to consume with a guarded single
 * statement (`UPDATE ... WHERE redeemed_at IS NULL RETURNING ...`, zero rows =
 * rejection) rather than read-then-write: two concurrent redemptions of the
 * same code must not both observe it unused.
 *
 * `redeem` answers `undefined` for unknown, expired, and already-used alike.
 * The distinction is exactly what an attacker enumerating codes would pay for,
 * so no composition may make it observable.
 */
import { describe, expect, it } from 'vitest';
import { TENANT_A } from './fixtures';
import { withCloudComposition, type CloudCompositionFactory } from './harness';

const CODE_TTL_MS = 10 * 60 * 1000;

export function runPairingConformance(factory: CloudCompositionFactory): void {
  describe('pairing codes', () => {
    it('returns the claims it was minted with, exactly once', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        const expiresAt = new Date(Date.parse(handle.now()) + CODE_TTL_MS).toISOString();
        const info = await stores.pairingCodes.issue(TENANT_A, {
          code: 'code-1',
          productId: 'product-1',
          expiresAt,
        });
        expect(info.code).toBe('code-1');
        expect(info.expiresAt).toBe(expiresAt);

        const claims = await stores.pairingCodes.redeem('code-1');
        expect(claims).toEqual({ tenantId: TENANT_A, productId: 'product-1' });

        // The second redemption is the one that must not reach registration.
        expect(await stores.pairingCodes.redeem('code-1')).toBeUndefined();
      });
    });

    it('answers undefined for a code that was never minted', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        expect(await stores.pairingCodes.redeem('never-minted')).toBeUndefined();
      });
    });

    it('answers undefined once the code has expired', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        await stores.pairingCodes.issue(TENANT_A, {
          code: 'code-2',
          productId: 'product-1',
          expiresAt: new Date(Date.parse(handle.now()) + CODE_TTL_MS).toISOString(),
        });

        await handle.advanceTime(CODE_TTL_MS + 1);

        expect(await stores.pairingCodes.redeem('code-2')).toBeUndefined();
      });
    });

    it('does not consume a code it rejected as expired', async () => {
      // An expired code that stays un-consumed is the honest state: nothing
      // succeeded, so nothing was spent. A composition that marks it used on
      // the failed path is hiding a write behind a rejection.
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        await stores.pairingCodes.issue(TENANT_A, {
          code: 'code-3',
          productId: 'product-1',
          expiresAt: new Date(Date.parse(handle.now()) + CODE_TTL_MS).toISOString(),
        });

        await handle.advanceTime(CODE_TTL_MS + 1);
        expect(await stores.pairingCodes.redeem('code-3')).toBeUndefined();

        // Re-issuing the same code with a fresh deadline must work: the row was
        // never spent, and a mint is the host's control plane speaking.
        await stores.pairingCodes.issue(TENANT_A, {
          code: 'code-3',
          productId: 'product-2',
          expiresAt: new Date(Date.parse(handle.now()) + CODE_TTL_MS).toISOString(),
        });
        expect(await stores.pairingCodes.redeem('code-3')).toEqual({
          tenantId: TENANT_A,
          productId: 'product-2',
        });
      });
    });
  });
}
