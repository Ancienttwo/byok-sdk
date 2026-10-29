import { describe, expect, it } from 'vitest';
import { ENTITLEMENT, TENANT_A, TENANT_B, hashOf } from './fixtures';
import { withComposition, type CoreCompositionFactory } from './harness';
export function runCoreRetentionConformance(name: string, factory: CoreCompositionFactory): void {
  describe(`core retention [${name}]`, () => {
    it('shares one mailbox budget; unacked rows expire to retained dead letters that hold no quota (#1115)', async () => {
      await withComposition(factory, async handle => {
        const { stores } = handle;
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);
        for (let n = 1; n <= 3; n++) await stores.mailbox.append(TENANT_A, {
          deviceId: 'retention-device', messageId: `retention-${n}`, admission: 'limited',
          materialize: seq => ({ body: String(seq), bodyHash: hashOf(n), byteSize: 1n }),
        });
        await stores.mailbox.recordDelivery(TENANT_A, { deviceId: 'retention-device', deliveredSeq: 1 });
        await stores.mailbox.advanceCursor(TENANT_A, { deviceId: 'retention-device', ackedSeq: 1 });
        await handle.advanceTime(1);
        const input = { now: handle.now(), limit: 2, ackedBefore: handle.now(), expireUnackedBefore: handle.now() };
        const floor = async () => (await stores.mailbox.readAfter(TENANT_A, { deviceId: 'retention-device', afterSeq: 0 })).recoverableFrom;
        expect(await stores.mailbox.collectExpired(TENANT_A, input)).toEqual({ removed: 1, expired: 1, releasedBytes: 0n, more: true });
        expect((await stores.mailbox.readUsage(TENANT_A)).bytes).toBe(1n);
        expect(await floor()).toBe(3);
        expect(await stores.mailbox.collectExpired(TENANT_A, { ...input, limit: 1 })).toEqual({ removed: 0, expired: 1, releasedBytes: 0n, more: false });
        expect((await stores.mailbox.readUsage(TENANT_A)).bytes).toBe(0n);
        expect(await floor()).toBe(4);
        expect(await stores.mailbox.collectExpired(TENANT_A, input)).toEqual({ removed: 0, expired: 0, releasedBytes: 0n, more: false });
      });
    });
    it('bounds presence expiry and preserves another tenant at the exact TTL boundary', async () => {
      await withComposition(factory, async handle => {
        for (let n = 1; n <= 3; n++) await handle.stores.presence.publish(TENANT_A, { deviceId: `device-${n}`, level: 'online', ttlMs: 1000, minimumIntervalMs: 0 });
        await handle.stores.presence.publish(TENANT_B, { deviceId: 'other', level: 'online', ttlMs: 1000, minimumIntervalMs: 0 });
        await handle.advanceTime(1000);
        const input = { now: handle.now(), limit: 2 };
        expect(await handle.stores.presence.collectExpired(TENANT_A, input)).toEqual({ removed: 2, expired: 0, releasedBytes: 0n, more: true });
        expect(await handle.stores.presence.collectExpired(TENANT_A, { ...input, limit: 1 })).toEqual({ removed: 1, expired: 0, releasedBytes: 0n, more: false });
        await handle.advanceTime(-1);
        expect(await handle.stores.presence.read(TENANT_B, 'other')).toBeDefined();
      });
    });
    it('expires reserved bytes first, then deletes settled rows with the remaining budget', async () => {
      await withComposition(factory, async handle => {
        const { stores } = handle;
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);
        for (let n = 1; n <= 3; n++) await stores.quota.reserve(TENANT_A, { reservationId: `retention-${n}`, kind: 'object', expectedBytes: 10n, contentHash: hashOf(n), contentType: 'text/plain', ttlMs: 1000 });
        await handle.advanceTime(1000);
        const bounds = { now: handle.now(), limit: 2, settledBefore: '1970-01-01T00:00:00.000Z' };
        expect(await stores.quota.collectExpired(TENANT_A, bounds)).toEqual({ removed: 0, expired: 2, releasedBytes: 20n, more: true });
        expect((await stores.quota.readUsage(TENANT_A)).reservedBytes).toBe(10n);
        expect(await stores.quota.collectExpired(TENANT_A, { ...bounds, limit: 1 })).toEqual({ removed: 0, expired: 1, releasedBytes: 10n, more: false });
        await handle.advanceTime(1);
        const settled = { now: handle.now(), limit: 2, settledBefore: handle.now() };
        expect(await stores.quota.collectExpired(TENANT_A, settled)).toEqual({ removed: 2, expired: 0, releasedBytes: 0n, more: true });
        expect(await stores.quota.collectExpired(TENANT_A, { ...settled, limit: 1 })).toEqual({ removed: 1, expired: 0, releasedBytes: 0n, more: false });
      });
    });
    it('protects committed accounting identity and its stored finalize replay after grace', async () => {
      await withComposition(factory, async handle => {
        const { stores } = handle;
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);
        await stores.quota.reserve(TENANT_A, { reservationId: 'inline-identity', kind: 'inline', expectedBytes: 10n, contentHash: hashOf(10), contentType: 'text/plain', ttlMs: 60_000 });
        const inline = await stores.quota.finalizeReservation(TENANT_A, { reservationId: 'inline-identity', observedByteSize: 10n, observedContentType: 'text/plain' });
        await stores.quota.reserve(TENANT_A, { reservationId: 'object-identity', kind: 'object', expectedBytes: 10n, contentHash: hashOf(11), contentType: 'text/plain', ttlMs: 60_000 });
        await stores.objects.putManifest(TENANT_A, { hash: hashOf(11), byteSize: 10n, contentType: 'text/plain' });
        const object = await stores.quota.finalizeReservation(TENANT_A, { reservationId: 'object-identity', observedByteSize: 10n, observedContentType: 'text/plain' });
        await handle.advanceTime(1000);
        expect(await stores.quota.collectExpired(TENANT_A, { now: handle.now(), settledBefore: handle.now(), limit: 1 })).toEqual({ removed: 0, expired: 0, releasedBytes: 0n, more: false });
        const retainedUsage = await stores.quota.readUsage(TENANT_A);
        expect(await stores.quota.finalizeReservation(TENANT_A, { reservationId: 'inline-identity', observedByteSize: 10n, observedContentType: 'text/plain' })).toEqual({ ...inline, usage: retainedUsage });
        expect(await stores.quota.finalizeReservation(TENANT_A, { reservationId: 'object-identity', observedByteSize: 10n, observedContentType: 'text/plain' })).toEqual({ ...object, usage: retainedUsage });
        await stores.quota.reserve(TENANT_A, { reservationId: 'inline-repeat', kind: 'inline', expectedBytes: 10n, contentHash: hashOf(10), contentType: 'text/plain', ttlMs: 60_000 });
        expect(await stores.quota.finalizeReservation(TENANT_A, { reservationId: 'inline-repeat', observedByteSize: 10n, observedContentType: 'text/plain' })).toMatchObject({ deduplicated: true });
        expect(await stores.quota.readUsage(TENANT_A)).toMatchObject({ committedObjectBytes: 10n, committedInlineBytes: 10n, objectCount: 1n });
      });
    });
    it('retries tombstones first and collects at most limit distinct objects without crossing protection', async () => {
      await withComposition(factory, async handle => {
        const { stores } = handle;
        await stores.quota.writeEntitlement(TENANT_A, ENTITLEMENT);
        for (let n = 1; n <= 4; n++) {
          await stores.quota.reserve(TENANT_A, { reservationId: `object-${n}`, kind: 'object', expectedBytes: 10n, contentHash: hashOf(n), contentType: 'text/plain', ttlMs: 60_000 });
          await stores.objects.putManifest(TENANT_A, { hash: hashOf(n), byteSize: 10n, contentType: 'text/plain' });
          await stores.quota.finalizeReservation(TENANT_A, { reservationId: `object-${n}`, observedByteSize: 10n, observedContentType: 'text/plain' });
        }
        await stores.objects.addReference(TENANT_A, { hash: hashOf(4), refKind: 'test', refId: 'retained' });
        await stores.quota.reserve(TENANT_A, { reservationId: 'active-object', kind: 'object', expectedBytes: 10n, contentHash: hashOf(5), contentType: 'text/plain', ttlMs: 60_000 });
        await stores.objects.putManifest(TENANT_A, { hash: hashOf(5), byteSize: 10n, contentType: 'text/plain' });
        await stores.objects.putManifest(TENANT_B, { hash: hashOf(7), byteSize: 10n, contentType: 'text/plain' });
        await handle.advanceTime(1);
        await stores.objects.markDeletePending(TENANT_A, hashOf(3));
        await stores.objects.putManifest(TENANT_A, { hash: hashOf(6), byteSize: 10n, contentType: 'text/plain' });
        const bounds = { now: handle.now(), limit: 2, orphanBefore: handle.now() };
        expect(await stores.objects.collectExpired(TENANT_A, bounds)).toEqual({ removed: 2, expired: 0, releasedBytes: 20n, more: true });
        expect((await stores.objects.get(TENANT_A, hashOf(3)))?.state).toBe('deleted');
        expect(await stores.objects.collectExpired(TENANT_A, { ...bounds, limit: 1 })).toEqual({ removed: 1, expired: 0, releasedBytes: 10n, more: false });
        expect(await stores.quota.readUsage(TENANT_A)).toMatchObject({ committedObjectBytes: 10n, objectCount: 1n, reservedBytes: 10n });
        for (const n of [4, 5, 6]) expect((await stores.objects.get(TENANT_A, hashOf(n)))?.state).not.toBe('deleted');
        expect((await stores.objects.get(TENANT_B, hashOf(7)))?.state).toBe('pending');
      });
    });
  });
}
