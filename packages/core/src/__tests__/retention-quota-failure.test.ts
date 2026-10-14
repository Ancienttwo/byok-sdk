import { describe, expect, it, vi } from 'vitest';
import { contentHash, createInMemoryCoreStores, createMutableClock, InMemoryStorageLedger, tenantId } from '../index';

describe('quota maintenance committed prefix', () => {
  it('reports the first settlement if the next row fails and retries without double release', async () => {
    const clock = createMutableClock();
    const tenant = tenantId('quota-partial');
    const { stores } = createInMemoryCoreStores({ clock, objectBytes: { deleteObject() {} } });
    await stores.quota.writeEntitlement(tenant, { version: 1n, hardLimitBytes: 100n, maxObjectBytes: 100n,
      maxInlineBytes: 100n, mailboxLimitBytes: 100n, retentionPolicyId: 'test' });
    for (let i = 1; i <= 2; i++) {
      await stores.quota.reserve(tenant, { reservationId: `r${i}`, kind: 'inline', expectedBytes: 10n,
        contentHash: contentHash(`sha256:${String(i).repeat(64)}`), contentType: 'text/plain', ttlMs: 1 });
    }
    clock.advance(2);
    const write = InMemoryStorageLedger.prototype.writeReservation;
    const spy = vi.spyOn(InMemoryStorageLedger.prototype, 'writeReservation').mockImplementation(function (this: InMemoryStorageLedger, key, record) {
      if (record.reservation.reservationId === 'r2') throw new Error('injected row failure');
      return write.call(this, key, record);
    });
    const input = { now: clock.now().toISOString(), settledBefore: clock.now().toISOString(), limit: 2 };
    try {
      await expect(stores.quota.collectExpired(tenant, input)).rejects.toMatchObject({
        committed: { removed: 0, expired: 1, releasedBytes: 10n }, failedRows: 1, more: true,
      });
      expect((await stores.quota.readUsage(tenant)).reservedBytes).toBe(10n);
      expect((await stores.quota.readReservation(tenant, 'r1'))?.state).toBe('expired');
      expect((await stores.quota.readReservation(tenant, 'r2'))?.state).toBe('reserved');
    } finally { spy.mockRestore(); }
    expect(await stores.quota.collectExpired(tenant, input)).toEqual({ removed: 0, expired: 1, releasedBytes: 10n, more: false });
    expect((await stores.quota.readUsage(tenant)).reservedBytes).toBe(0n);
  });
});
