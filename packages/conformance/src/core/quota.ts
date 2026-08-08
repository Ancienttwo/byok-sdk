/**
 * Storage entitlement / usage / reservation conformance (§12.7.6-12.7.7).
 *
 * The invariant under test is `committed + reserved + expected <= hardLimit`,
 * and the reason it needs a conformance suite rather than a unit test is that
 * it is exactly the property a SQL implementation gets wrong: check outside the
 * transaction, or increment after the upload, and concurrent writers oversell
 * the tenant. The assertions below are written so a composition passes only if
 * the check and the increment are one step.
 *
 * Entitlements are numeric and versioned. Nothing here mentions a plan, a tier,
 * or a price — the constraint test asserts the same about `quota.ts`, because
 * the moment the SDK knows what "pro" means, every host inherits the SDK's
 * commercial model.
 */
import { describe, expect, it } from 'vitest';
import {
  isCoreConflictError,
  isCoreError,
  type CoreConflictError,
  type CoreStores,
  type TenantStorageEntitlement,
} from '@byok/core';
import { ENTITLEMENT, hashOf, TENANT_A } from './fixtures';
import { withComposition, type CoreCompositionFactory } from './harness';

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

function reservation(id: string, bytes: bigint, seed: number) {
  return {
    reservationId: id,
    kind: 'object' as const,
    expectedBytes: bytes,
    contentHash: hashOf(seed),
    contentType: 'application/octet-stream',
    ttlMs: 60_000,
  };
}

async function putReservationManifest(
  stores: CoreStores,
  id: string,
): Promise<void> {
  const held = await stores.quota.readReservation(TENANT_A, id);
  if (held === undefined) throw new Error(`missing reservation ${id}`);
  await stores.objects.putManifest(TENANT_A, {
    hash: held.contentHash,
    byteSize: held.expectedBytes,
    contentType: held.contentType,
  });
}

export function runQuotaConformance(factory: CoreCompositionFactory): void {
  describe('quota', () => {
    it('applies entitlement version CAS and returns the current row on a stale write', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.quota.writeEntitlement(TENANT_A, { ...ENTITLEMENT, version: 2n });

        const stale = await captureError(
          stores.quota.writeEntitlement(TENANT_A, {
            ...ENTITLEMENT,
            version: 1n,
            hardLimitBytes: 10n,
          }),
        );
        expect(isCoreConflictError(stale, 'storage_entitlement_version_conflict')).toBe(true);
        const current = (stale as CoreConflictError<TenantStorageEntitlement>).current;
        expect(current.version).toBe(2n);
        expect(current.hardLimitBytes).toBe(ENTITLEMENT.hardLimitBytes);

        // Same version is also stale: version is monotonic, not merely different.
        const same = await captureError(
          stores.quota.writeEntitlement(TENANT_A, { ...ENTITLEMENT, version: 2n }),
        );
        expect(isCoreConflictError(same, 'storage_entitlement_version_conflict')).toBe(true);

        const applied = await stores.quota.writeEntitlement(TENANT_A, {
          ...ENTITLEMENT,
          version: 3n,
          hardLimitBytes: 2_000n,
        });
        expect(applied.hardLimitBytes).toBe(2_000n);
      });
    });

    it('moves bytes from reserved to committed on finalize', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);

        await stores.quota.reserve(TENANT_A, reservation('res-1', 300n, 1));
        await putReservationManifest(stores, 'res-1');
        const reserved = await stores.quota.readUsage(TENANT_A);
        expect(reserved.reservedBytes).toBe(300n);
        expect(reserved.committedObjectBytes).toBe(0n);

        const result = await stores.quota.finalizeReservation(TENANT_A, {
          reservationId: 'res-1',
          observedByteSize: 300n,
          observedContentType: 'application/octet-stream',
        });
        expect(result.deduplicated).toBe(false);
        expect(result.usage.reservedBytes).toBe(0n);
        expect(result.usage.committedObjectBytes).toBe(300n);
        expect(result.usage.objectCount).toBe(1n);
      });
    });

    it('replays a response-lost finalize without double-accounting', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);
        await stores.quota.reserve(TENANT_A, reservation('res-replay', 300n, 9));
        await putReservationManifest(stores, 'res-replay');

        const input = {
          reservationId: 'res-replay',
          observedByteSize: 300n,
          observedContentType: 'application/octet-stream',
        };
        const first = await stores.quota.finalizeReservation(TENANT_A, input);
        const replay = await stores.quota.finalizeReservation(TENANT_A, input);

        expect(replay.reservation).toEqual(first.reservation);
        expect(replay.usage.committedObjectBytes).toBe(300n);
        expect(replay.usage.objectCount).toBe(1n);
        expect(
          (await stores.objects.get(TENANT_A, first.reservation.contentHash))?.state,
        ).toBe('committed');
      });
    });

    it('never lets committed + reserved + expected exceed the hard limit', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);

        await stores.quota.reserve(TENANT_A, reservation('res-1', 400n, 1));
        await putReservationManifest(stores, 'res-1');
        await stores.quota.finalizeReservation(TENANT_A, {
          reservationId: 'res-1',
          observedByteSize: 400n,
          observedContentType: 'application/octet-stream',
        });
        await stores.quota.reserve(TENANT_A, reservation('res-2', 400n, 2));

        // 400 committed + 400 reserved + 400 expected > 1000.
        const overcommit = await captureError(
          stores.quota.reserve(TENANT_A, reservation('res-3', 400n, 3)),
        );
        expect(isCoreError(overcommit, 'storage_quota_exceeded')).toBe(true);

        const usage = await stores.quota.readUsage(TENANT_A);
        expect(usage.committedObjectBytes + usage.reservedBytes).toBeLessThanOrEqual(
          ENTITLEMENT.hardLimitBytes,
        );
      });
    });

    it('rejects a single write over the per-object and per-inline limits', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);

        const tooBig = await captureError(
          stores.quota.reserve(TENANT_A, reservation('res-1', 401n, 1)),
        );
        expect(isCoreError(tooBig, 'storage_object_too_large')).toBe(true);

        const inlineTooBig = await captureError(
          stores.quota.reserve(TENANT_A, {
            ...reservation('res-2', 101n, 2),
            kind: 'inline',
          }),
        );
        expect(isCoreError(inlineTooBig, 'storage_object_too_large')).toBe(true);
      });
    });

    it('expires a reservation, releases its bytes, and refuses to finalize it', async () => {
      await withComposition(factory, async (handle) => {
        const { stores } = handle;
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);
        await stores.quota.reserve(TENANT_A, reservation('res-1', 300n, 1));

        await handle.advanceTime(60_000);

        const expired = await stores.quota.expireReservations(TENANT_A);
        expect(expired.map((entry) => entry.reservationId)).toEqual(['res-1']);
        expect((await stores.quota.readUsage(TENANT_A)).reservedBytes).toBe(0n);

        const late = await captureError(
          stores.quota.finalizeReservation(TENANT_A, {
            reservationId: 'res-1',
            observedByteSize: 300n,
            observedContentType: 'application/octet-stream',
          }),
        );
        expect(isCoreError(late, 'storage_reservation_expired')).toBe(true);
      });
    });

    it('reaps expired abandoned reservations before admitting the next write', async () => {
      await withComposition(factory, async (handle) => {
        const { stores } = handle;
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);
        await stores.quota.reserve(TENANT_A, reservation('abandoned-1', 400n, 1));
        await stores.quota.reserve(TENANT_A, reservation('abandoned-2', 400n, 2));

        await handle.advanceTime(60_000);

        const admitted = await stores.quota.reserve(
          TENANT_A,
          reservation('replacement', 300n, 3),
        );
        expect(admitted.state).toBe('reserved');
        expect((await stores.quota.readReservation(TENANT_A, 'abandoned-1'))?.state).toBe(
          'expired',
        );
        expect((await stores.quota.readReservation(TENANT_A, 'abandoned-2'))?.state).toBe(
          'expired',
        );
        expect((await stores.quota.readUsage(TENANT_A)).reservedBytes).toBe(300n);
      });
    });

    it('releases reservations when observed size or content type disagrees', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);
        await stores.quota.reserve(TENANT_A, reservation('res-size', 300n, 1));

        const sizeMismatch = await captureError(
          stores.quota.finalizeReservation(TENANT_A, {
            reservationId: 'res-size',
            observedByteSize: 299n,
            observedContentType: 'application/octet-stream',
          }),
        );
        expect(isCoreError(sizeMismatch, 'storage_integrity_mismatch')).toBe(true);

        await stores.quota.reserve(TENANT_A, reservation('res-type', 300n, 2));
        const typeMismatch = await captureError(
          stores.quota.finalizeReservation(TENANT_A, {
            reservationId: 'res-type',
            observedByteSize: 300n,
            observedContentType: 'application/json',
          }),
        );
        expect(isCoreError(typeMismatch, 'storage_integrity_mismatch')).toBe(true);

        const usage = await stores.quota.readUsage(TENANT_A);
        expect(usage.reservedBytes).toBe(0n);
        expect(usage.committedObjectBytes).toBe(0n);
      });
    });

    it('counts the same hash once per tenant', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);

        for (const id of ['res-1', 'res-2']) {
          await stores.quota.reserve(TENANT_A, reservation(id, 300n, 7));
          await putReservationManifest(stores, id);
          const result = await stores.quota.finalizeReservation(TENANT_A, {
            reservationId: id,
            observedByteSize: 300n,
            observedContentType: 'application/octet-stream',
          });
          expect(result.deduplicated).toBe(id === 'res-2');
        }

        const usage = await stores.quota.readUsage(TENANT_A);
        expect(usage.committedObjectBytes).toBe(300n);
        expect(usage.objectCount).toBe(1n);
        expect(usage.reservedBytes).toBe(0n);
      });
    });

    it('aborts idempotently', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);
        await stores.quota.reserve(TENANT_A, reservation('res-1', 300n, 1));

        const aborted = await stores.quota.abortReservation(TENANT_A, 'res-1');
        expect(aborted.state).toBe('aborted');
        const again = await stores.quota.abortReservation(TENANT_A, 'res-1');
        expect(again.state).toBe('aborted');
        expect((await stores.quota.readUsage(TENANT_A)).reservedBytes).toBe(0n);
      });
    });

    it('suspends durable writes once a downgrade grace has ended over the limit', async () => {
      await withComposition(factory, async (handle) => {
        const { stores } = handle;
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);
        await stores.quota.reserve(TENANT_A, reservation('res-1', 400n, 1));
        await putReservationManifest(stores, 'res-1');
        await stores.quota.finalizeReservation(TENANT_A, {
          reservationId: 'res-1',
          observedByteSize: 400n,
          observedContentType: 'application/octet-stream',
        });

        // The host downgrades the tenant below its current usage and grants grace.
        const graceUntil = new Date(Date.parse(handle.now()) + 10 * 60_000).toISOString();
        await stores.quota.writeEntitlement(TENANT_A, {
          ...ENTITLEMENT,
          version: 2n,
          hardLimitBytes: 200n,
          downgradeGraceUntil: graceUntil,
        });
        expect((await stores.quota.readStatus(TENANT_A)).posture).toBe('blocked');

        await handle.advanceTime(10 * 60_000);

        const status = await stores.quota.readStatus(TENANT_A);
        expect(status.posture).toBe('suspended');
        expect(status.graceActive).toBe(false);
        expect(status.availableBytes).toBe(0n);

        const suspended = await captureError(
          stores.quota.reserve(TENANT_A, reservation('res-2', 10n, 2)),
        );
        expect(isCoreError(suspended, 'storage_write_suspended')).toBe(true);
      });
    });

    it('bounds mailbox bytes by the entitlement', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);

        const usage = await stores.quota.applyMailboxDelta(TENANT_A, { deltaBytes: 500n });
        expect(usage.mailboxBytes).toBe(500n);

        const over = await captureError(
          stores.quota.applyMailboxDelta(TENANT_A, { deltaBytes: 1n }),
        );
        expect(isCoreError(over, 'storage_quota_exceeded')).toBe(true);

        const released = await stores.quota.applyMailboxDelta(TENANT_A, { deltaBytes: -500n });
        expect(released.mailboxBytes).toBe(0n);
      });
    });

    it('reads reservations tenant-scoped and rejects id reuse with a different declaration', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);
        const first = await stores.quota.reserve(TENANT_A, reservation('res-bound', 300n, 1));
        expect(await stores.quota.readReservation(TENANT_A, 'res-bound')).toEqual(first);

        const collision = await captureError(
          stores.quota.reserve(TENANT_A, reservation('res-bound', 299n, 2)),
        );
        expect(isCoreError(collision, 'storage_integrity_mismatch')).toBe(true);
        expect((await stores.quota.readUsage(TENANT_A)).reservedBytes).toBe(300n);
      });
    });

    it('aborts object finalize when the matching manifest is absent', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);
        await stores.quota.reserve(TENANT_A, reservation('res-no-manifest', 300n, 1));

        const missing = await captureError(
          stores.quota.finalizeReservation(TENANT_A, {
            reservationId: 'res-no-manifest',
            observedByteSize: 300n,
            observedContentType: 'application/octet-stream',
          }),
        );
        expect(isCoreError(missing, 'storage_integrity_mismatch')).toBe(true);
        expect((await stores.quota.readReservation(TENANT_A, 'res-no-manifest'))?.state).toBe(
          'aborted',
        );
        expect((await stores.quota.readUsage(TENANT_A)).reservedBytes).toBe(0n);
      });
    });
  });
}
