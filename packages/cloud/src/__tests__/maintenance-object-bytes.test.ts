import { describe, expect, it } from 'vitest';
import { contentHash, createInMemoryCoreStores, createMutableClock, tenantId } from '@byok-sdk/core';
import { createInMemoryByokCloud } from '../composition/in-memory';
const tenant = tenantId('byte-retention');
const entitlement = { version: 1n, hardLimitBytes: 1000n, maxObjectBytes: 100n, maxInlineBytes: 100n, mailboxLimitBytes: 100n, retentionPolicyId: 'test' };
describe('in-memory object retention', () => {
  it('deletes deployed blob bytes and releases the same accounted object once', async () => {
    const clock = createMutableClock();
    const composition = createInMemoryByokCloud({ clock });
    const bytes = new TextEncoder().encode('stored object');
    const hash = contentHash(await composition.crypto.sha256(bytes));
    await composition.core.quota.writeEntitlement(tenant, entitlement);
    const reservation = await composition.core.quota.reserve(tenant, { reservationId: 'one', kind: 'object', expectedBytes: BigInt(bytes.length), contentHash: hash, contentType: 'text/plain', ttlMs: 60_000 });
    const grant = await composition.stores.blobs.createUpload(tenant, reservation);
    expect(await composition.blobContentProxy.writeContent(grant.blobId, bytes)).toEqual({ ok: true });
    await composition.core.quota.finalizeReservation(tenant, { reservationId: 'one', observedByteSize: BigInt(bytes.length), observedContentType: 'text/plain' });
    clock.advance(1);
    const input = { now: clock.now().toISOString(), orphanBefore: clock.now().toISOString(), limit: 1 };
    expect(await composition.core.objects.collectExpired(tenant, input)).toEqual({ removed: 1, expired: 0, releasedBytes: BigInt(bytes.length), more: false });
    expect(await composition.blobContentProxy.readContent(grant.blobId)).toBeUndefined();
    expect(await composition.core.quota.readUsage(tenant)).toMatchObject({ committedObjectBytes: 0n, objectCount: 0n });
    expect(await composition.core.objects.collectExpired(tenant, input)).toEqual({ removed: 0, expired: 0, releasedBytes: 0n, more: false });
  });
  it('gives fresh orphans progress while still retrying a permanent failed tombstone at limit one', async () => {
    const clock = createMutableClock();
    const hashes = [1, 2, 3].map(n => contentHash('sha256:' + String(n).padStart(64, '0')));
    let poison = true;
    const calls: string[] = [];
    const { stores } = createInMemoryCoreStores({ clock, objectBytes: { deleteObject(_tenant, hash) { calls.push(hash); if (hash === hashes[0] && poison) throw new Error('DELETE outage'); } } });
    await stores.quota.writeEntitlement(tenant, entitlement);
    for (let n = 0; n < hashes.length; n++) {
      await stores.quota.reserve(tenant, { reservationId: String(n), kind: 'object', expectedBytes: 10n, contentHash: hashes[n]!, contentType: 'text/plain', ttlMs: 60_000 });
      await stores.objects.putManifest(tenant, { hash: hashes[n]!, byteSize: 10n, contentType: 'text/plain' });
      await stores.quota.finalizeReservation(tenant, { reservationId: String(n), observedByteSize: 10n, observedContentType: 'text/plain' });
    }
    await stores.objects.markDeletePending(tenant, hashes[0]!);
    clock.advance(1);
    const input = { now: clock.now().toISOString(), orphanBefore: clock.now().toISOString(), limit: 1 };
    await expect(stores.objects.collectExpired(tenant, input)).rejects.toMatchObject({ committed: { removed: 0, releasedBytes: 0n }, more: true, failedRows: 1 });
    expect(await stores.objects.collectExpired(tenant, input)).toMatchObject({ removed: 1, releasedBytes: 10n, more: true });
    await expect(stores.objects.collectExpired(tenant, input)).rejects.toMatchObject({ failedRows: 1 });
    expect(await stores.objects.collectExpired(tenant, input)).toMatchObject({ removed: 1, releasedBytes: 10n, more: true });
    expect(calls).toEqual([hashes[0], hashes[1], hashes[0], hashes[2]]);
    poison = false;
    expect(await stores.objects.collectExpired(tenant, input)).toEqual({ removed: 1, expired: 0, releasedBytes: 10n, more: false });
  });
});
