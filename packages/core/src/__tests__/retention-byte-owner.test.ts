import { describe, expect, it, vi } from 'vitest';
import {
  contentHash,
  createInMemoryCoreStores,
  createMutableClock,
  tenantId,
  type InMemoryObjectBytes,
  type TenantId,
  type ContentHash,
} from '../index';

describe('in-memory retention byte authority', () => {
  it.each([undefined, 'metadata-only', {}])('rejects an absent byte authority: %s', bytes => {
    expect(() => createInMemoryCoreStores({
      clock: createMutableClock(), objectBytes: bytes as InMemoryObjectBytes,
    })).toThrow('explicit byte authority');
  });

  it('deletes bytes exactly once for a collected object and preserves referenced bytes', async () => {
    const tenant = tenantId('retention-byte-owner');
    const orphan = contentHash(`sha256:${'1'.repeat(64)}`);
    const retained = contentHash(`sha256:${'2'.repeat(64)}`);
    const bytes = new Map([[orphan, new Uint8Array([1])], [retained, new Uint8Array([2])]]);
    const deleteObject = vi.fn((_tenant: TenantId, hash: ContentHash) => { bytes.delete(hash); });
    const clock = createMutableClock();
    const { stores } = createInMemoryCoreStores({ clock, objectBytes: { deleteObject } });
    for (const hash of [orphan, retained]) {
      await stores.objects.putManifest(tenant, { hash, byteSize: 1n, contentType: 'text/plain' });
    }
    await stores.objects.commit(tenant, { hash: retained, observedByteSize: 1n, observedContentType: 'text/plain' });
    await stores.objects.addReference(tenant, { hash: retained, refKind: 'test', refId: 'protected' });
    clock.advance(1);
    const input = { now: clock.now().toISOString(), orphanBefore: clock.now().toISOString(), limit: 1 };
    expect(await stores.objects.collectExpired(tenant, input)).toEqual({ removed: 1, expired: 0, releasedBytes: 0n, more: false });
    expect(deleteObject).toHaveBeenCalledExactlyOnceWith(tenant, orphan);
    expect(bytes.has(orphan)).toBe(false);
    expect(bytes.has(retained)).toBe(true);
    expect((await stores.objects.get(tenant, retained))?.state).toBe('committed');
    expect(await stores.objects.collectExpired(tenant, input)).toEqual({ removed: 0, expired: 0, releasedBytes: 0n, more: false });
    expect(deleteObject).toHaveBeenCalledTimes(1);
  });
});
