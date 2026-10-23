import { describe, expect, it } from 'vitest';
import { tenantId } from '@byok-sdk/core';
import type { E2eeMemberStore, E2eeScopeKeyPackageRow } from '@byok-sdk/cloud';

export interface E2eeMemberCompositionHandle {
  readonly store: E2eeMemberStore;
  dispose?(): void | Promise<void>;
}
export interface E2eeMemberCompositionFactory {
  create(): E2eeMemberCompositionHandle | Promise<E2eeMemberCompositionHandle>;
}

const tenant = tenantId('e2ee-tenant');
const other = tenantId('e2ee-other');
const T0 = '2026-10-24T00:00:00.000Z';
const T1 = '2026-10-24T00:10:00.000Z';
const BEFORE_T1 = '2026-10-24T00:09:59.999Z';
const entry = (seq: number, note = 'a') => ({ seq, entry: `{"note":"${note}","seq":${seq}}` });
const pkg = (epoch: number, recipient: string, keyId: string, note = 'a'): E2eeScopeKeyPackageRow => ({
  scopeId: 'scope-1', epoch, recipient, keyId, sender: 'sender', package: `{"epoch":${epoch},"keyId":"${keyId}","note":"${note}","recipient":"${recipient}"}`,
});
const registration = (deviceId: string, memberId: string, bundle = `{"memberId":"${memberId}"}`, deviceMac = 'mac-1') =>
  ({ deviceId, memberId, bundle, deviceMac, macExpiresAt: T1 });

/** The store contract every E2EE member store backend must meet (#654 E2c). */
export function runE2eeMemberStoreConformance(name: string, factory: E2eeMemberCompositionFactory): void {
  const check = (title: string, body: (store: E2eeMemberStore) => Promise<void>) => it(title, async () => {
    const h = await factory.create();
    try { await body(h.store); } finally { await h.dispose?.(); }
  });
  describe(`E2EE member store conformance [${name}]`, () => {
    check('appends a contiguous chain, pages it, and keeps tenants apart', async store => {
      expect(await store.appendChainEntries(tenant, [entry(1), entry(2), entry(3)])).toEqual({ outcome: 'appended', appended: 3, replayed: 0 });
      expect(await store.readChainEntries(tenant, { afterSeq: 0, limit: 2 })).toEqual([entry(1), entry(2)]);
      expect(await store.readChainEntries(tenant, { afterSeq: 2, limit: 256 })).toEqual([entry(3)]);
      expect(await store.readChainEntries(tenant, { afterSeq: 3, limit: 256 })).toEqual([]);
      expect(await store.readChainEntries(other, { afterSeq: 0, limit: 256 })).toEqual([]);
      expect(await store.appendChainEntries(other, [entry(1, 'b')])).toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
      expect(await store.readChainEntries(tenant, { afterSeq: 0, limit: 1 })).toEqual([entry(1)]);
    });
    check('replays a stored prefix and appends the rest in one call', async store => {
      await store.appendChainEntries(tenant, [entry(1), entry(2)]);
      expect(await store.appendChainEntries(tenant, [entry(1), entry(2)])).toEqual({ outcome: 'appended', appended: 0, replayed: 2 });
      expect(await store.appendChainEntries(tenant, [entry(2), entry(3), entry(4)])).toEqual({ outcome: 'appended', appended: 2, replayed: 1 });
      expect((await store.readChainEntries(tenant, { afterSeq: 0, limit: 256 })).map(row => row.seq)).toEqual([1, 2, 3, 4]);
    });
    check('refuses a different entry at a stored seq and writes nothing', async store => {
      await store.appendChainEntries(tenant, [entry(1), entry(2)]);
      expect(await store.appendChainEntries(tenant, [entry(2, 'b'), entry(3)])).toEqual({ outcome: 'conflict', seq: 2 });
      expect(await store.appendChainEntries(tenant, [entry(1), entry(2, 'b'), entry(3)])).toEqual({ outcome: 'conflict', seq: 2 });
      expect(await store.readChainEntries(tenant, { afterSeq: 0, limit: 256 })).toEqual([entry(1), entry(2)]);
    });
    check('refuses a gap after the head and writes nothing', async store => {
      expect(await store.appendChainEntries(tenant, [entry(2), entry(3)])).toEqual({ outcome: 'gap', seq: 2, headSeq: 0 });
      await store.appendChainEntries(tenant, [entry(1)]);
      expect(await store.appendChainEntries(tenant, [entry(3)])).toEqual({ outcome: 'gap', seq: 3, headSeq: 1 });
      expect(await store.readChainEntries(tenant, { afterSeq: 0, limit: 256 })).toEqual([entry(1)]);
    });
    check('lets exactly one of two concurrent writers take a seq', async store => {
      const results = await Promise.all([
        store.appendChainEntries(tenant, [entry(1, 'a')]),
        store.appendChainEntries(tenant, [entry(1, 'b')]),
      ]);
      expect(results.map(result => result.outcome).sort()).toEqual(['appended', 'conflict']);
      const stored = await store.readChainEntries(tenant, { afterSeq: 0, limit: 256 });
      expect(stored).toHaveLength(1);
      expect([entry(1, 'a'), entry(1, 'b')]).toContainEqual(stored[0]);
    });
    check('fixes one keyId per scope epoch and replaces a package only under it', async store => {
      expect(await store.putScopeKeyPackages(tenant, [pkg(1, 'r1', 'k1'), pkg(1, 'r2', 'k1')])).toEqual({ outcome: 'stored', stored: 2 });
      expect(await store.putScopeKeyPackages(tenant, [pkg(1, 'r3', 'k1'), pkg(1, 'r4', 'k2')]))
        .toEqual({ outcome: 'key_id_conflict', scopeId: 'scope-1', epoch: 1, keyId: 'k1' });
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1' })).toEqual([pkg(1, 'r1', 'k1'), pkg(1, 'r2', 'k1')]);
      // A KEM rotation re-wraps the same scope key: same keyId, new package bytes.
      expect(await store.putScopeKeyPackages(tenant, [pkg(1, 'r1', 'k1', 'rewrapped')])).toEqual({ outcome: 'stored', stored: 1 });
      expect(await store.putScopeKeyPackages(tenant, [pkg(2, 'r1', 'k2')])).toEqual({ outcome: 'stored', stored: 1 });
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1' }))
        .toEqual([pkg(1, 'r1', 'k1', 'rewrapped'), pkg(1, 'r2', 'k1'), pkg(2, 'r1', 'k2')]);
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1', epoch: 2 })).toEqual([pkg(2, 'r1', 'k2')]);
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1', recipient: 'r2' })).toEqual([pkg(1, 'r2', 'k1')]);
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-2' })).toEqual([]);
      expect(await store.readScopeKeyPackages(other, { scopeId: 'scope-1' })).toEqual([]);
      expect(await store.putScopeKeyPackages(other, [pkg(1, 'r1', 'k9')])).toEqual({ outcome: 'stored', stored: 1 });
    });
    check('serializes two concurrent first puts of one scope epoch', async store => {
      const results = await Promise.all([
        store.putScopeKeyPackages(tenant, [pkg(1, 'r1', 'k1')]),
        store.putScopeKeyPackages(tenant, [pkg(1, 'r2', 'k2')]),
      ]);
      expect(results.map(result => result.outcome).sort()).toEqual(['key_id_conflict', 'stored']);
      const stored = await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1' });
      expect(stored).toHaveLength(1);
      expect([pkg(1, 'r1', 'k1'), pkg(1, 'r2', 'k2')]).toContainEqual(stored[0]);
    });
    check('registers one bundle per device and one device per member', async store => {
      expect(await store.registerMember(tenant, registration('dev-1', 'm1'))).toBe('registered');
      expect(await store.readMemberRegistration(tenant, { deviceId: 'dev-1', now: T0 }))
        .toEqual({ memberId: 'm1', bundle: '{"memberId":"m1"}', deviceMac: 'mac-1' });
      expect(await store.registerMember(tenant, registration('dev-1', 'm1', undefined, 'mac-2'))).toBe('replayed');
      expect(await store.readMemberRegistration(tenant, { deviceId: 'dev-1', now: T0 }))
        .toEqual({ memberId: 'm1', bundle: '{"memberId":"m1"}', deviceMac: 'mac-2' });
      expect(await store.registerMember(tenant, registration('dev-1', 'm1', '{"memberId":"m1","other":1}'))).toBe('device_conflict');
      expect(await store.registerMember(tenant, registration('dev-1', 'm2'))).toBe('device_conflict');
      expect(await store.registerMember(tenant, registration('dev-2', 'm1'))).toBe('member_conflict');
      expect(await store.readMemberRegistration(tenant, { deviceId: 'dev-2', now: T0 })).toBeUndefined();
      expect(await store.readMemberRegistration(tenant, { deviceId: 'dev-1', now: T0 }))
        .toEqual({ memberId: 'm1', bundle: '{"memberId":"m1"}', deviceMac: 'mac-2' });
      expect(await store.readMemberRegistration(other, { deviceId: 'dev-1', now: T0 })).toBeUndefined();
      expect(await store.registerMember(other, registration('dev-1', 'm1'))).toBe('registered');
    });
    check('returns a pairing MAC only before its expiry', async store => {
      await store.registerMember(tenant, registration('dev-1', 'm1'));
      expect(await store.readMemberRegistration(tenant, { deviceId: 'dev-1', now: BEFORE_T1 }))
        .toEqual({ memberId: 'm1', bundle: '{"memberId":"m1"}', deviceMac: 'mac-1' });
      expect(await store.readMemberRegistration(tenant, { deviceId: 'dev-1', now: T1 }))
        .toEqual({ memberId: 'm1', bundle: '{"memberId":"m1"}' });
    });
    check('relays the client MAC only to a registered device', async store => {
      expect(await store.putClientPairingMac(tenant, { deviceId: 'dev-1', body: '{"mac":"c1"}', expiresAt: T1 })).toBe('not_registered');
      expect(await store.readClientPairingMac(tenant, { deviceId: 'dev-1', now: T0 })).toBeUndefined();
      await store.registerMember(tenant, registration('dev-1', 'm1'));
      expect(await store.putClientPairingMac(tenant, { deviceId: 'dev-1', body: '{"mac":"c1"}', expiresAt: T1 })).toBe('stored');
      expect(await store.readClientPairingMac(tenant, { deviceId: 'dev-1', now: BEFORE_T1 })).toBe('{"mac":"c1"}');
      expect(await store.readClientPairingMac(tenant, { deviceId: 'dev-1', now: T1 })).toBeUndefined();
      expect(await store.putClientPairingMac(tenant, { deviceId: 'dev-1', body: '{"mac":"c2"}', expiresAt: '2026-10-24T00:20:00.000Z' })).toBe('stored');
      expect(await store.readClientPairingMac(tenant, { deviceId: 'dev-1', now: T1 })).toBe('{"mac":"c2"}');
      expect(await store.readClientPairingMac(other, { deviceId: 'dev-1', now: T0 })).toBeUndefined();
      expect(await store.putClientPairingMac(other, { deviceId: 'dev-1', body: '{"mac":"c1"}', expiresAt: T1 })).toBe('not_registered');
    });
  });
}
