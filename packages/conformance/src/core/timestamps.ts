/**
 * Canonical-instant conformance.
 *
 * This is the one conformance file that exists because two compositions would
 * otherwise *silently* disagree rather than fail. The in-memory reference
 * compares caller-supplied deadlines as strings; a Postgres composition
 * compares them as `timestamptz`. Those two agree only on the canonical
 * `YYYY-MM-DDTHH:mm:ss.sssZ` form — feed either one `2026-08-08T00:00:00+08:00`
 * and both happily return an answer, but not the same answer, and nothing in
 * the behavioral suites would notice.
 *
 * So the contract is a rejection, asserted here rather than in a package-local
 * unit test: every composition must refuse a non-canonical instant at the port
 * boundary, and none may normalize one into a guess about what the caller meant.
 */
import { describe, expect, it } from 'vitest';
import { isCoreError } from '@byok-sdk/core';
import { ENTITLEMENT, TENANT_A } from './fixtures';
import { withComposition, type CoreCompositionFactory } from './harness';

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

/**
 * Each of these parses as *something* somewhere, which is the problem: an
 * offset shifts the instant relative to a lexicographic compare, a missing
 * millisecond field sorts before every `.000Z` sibling of the same second, and
 * a space separator or bare date is not an instant at all.
 */
const NON_CANONICAL = [
  '2026-08-08T00:00:00+08:00',
  '2026-08-08T00:00:00Z',
  '2026-08-08T00:00:00.000',
  '2026-08-08T00:00:00.000+00:00',
  '2026-08-08 00:00:00.000Z',
  '2026-08-08',
  '+002026-08-08T00:00:00.000Z',
  '2026-02-30T00:00:00.000Z',
  'now',
  '',
] as const;

export function runTimestampConformance(factory: CoreCompositionFactory): void {
  describe('canonical instants', () => {
    it('rejects a non-canonical downgradeGraceUntil instead of interpreting it', async () => {
      await withComposition(factory, async ({ stores }) => {
        for (const [index, candidate] of NON_CANONICAL.entries()) {
          const rejected = await captureError(
            stores.quota.writeEntitlement(TENANT_A, {
              ...ENTITLEMENT,
              version: BigInt(index + 1),
              downgradeGraceUntil: candidate,
            }),
          );
          expect(
            isCoreError(rejected, 'timestamp_not_canonical'),
            `expected ${JSON.stringify(candidate)} to be rejected`,
          ).toBe(true);
        }

        // Nothing was written: a rejected entitlement is not a partial one.
        expect(await stores.quota.readEntitlement(TENANT_A)).toBeUndefined();
      });
    });

    it('rejects a non-canonical deletePendingBefore on the GC list query', async () => {
      await withComposition(factory, async ({ stores }) => {
        for (const candidate of NON_CANONICAL) {
          const rejected = await captureError(
            stores.objects.list(TENANT_A, { deletePendingBefore: candidate }),
          );
          expect(
            isCoreError(rejected, 'timestamp_not_canonical'),
            `expected ${JSON.stringify(candidate)} to be rejected`,
          ).toBe(true);
        }
      });
    });

    it('rejects non-canonical mailbox retention cutoffs before deleting anything', async () => {
      await withComposition(factory, async ({ stores }) => {
        const canonical = '2999-01-01T00:00:00.000Z';
        for (const candidate of NON_CANONICAL) {
          const badAcked = await captureError(
            stores.mailbox.collectRetired(TENANT_A, {
              ackedBefore: candidate,
              expireUnackedBefore: canonical,
            }),
          );
          expect(
            isCoreError(badAcked, 'timestamp_not_canonical'),
            `expected ackedBefore ${JSON.stringify(candidate)} to be rejected`,
          ).toBe(true);

          const badUnacked = await captureError(
            stores.mailbox.collectRetired(TENANT_A, {
              ackedBefore: canonical,
              expireUnackedBefore: candidate,
            }),
          );
          expect(
            isCoreError(badUnacked, 'timestamp_not_canonical'),
            `expected expireUnackedBefore ${JSON.stringify(candidate)} to be rejected`,
          ).toBe(true);
        }
      });
    });

    it('accepts the output of the composition clock as canonical', async () => {
      // The store-produced side of the contract: whatever a composition emits
      // must be feedable straight back in, or the format pin is unusable.
      await withComposition(factory, async (handle) => {
        const { stores } = handle;
        const now = handle.now();
        const written = await stores.quota.writeEntitlement(TENANT_A, {
          ...ENTITLEMENT,
          downgradeGraceUntil: now,
        });
        expect(written.downgradeGraceUntil).toBe(now);
        await stores.objects.list(TENANT_A, { deletePendingBefore: now });
        await stores.mailbox.collectRetired(TENANT_A, {
          ackedBefore: now,
          expireUnackedBefore: now,
        });
      });
    });
  });
}
