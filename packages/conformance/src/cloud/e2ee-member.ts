import { describe, expect, it } from 'vitest';
import { tenantId } from '@byok-sdk/core';
import type { E2eeMemberStore, E2eeScopeKeyPackageRow, E2eeScopeShred, RequestReceiptStore } from '@byok-sdk/cloud';

export interface E2eeMemberCompositionHandle {
  readonly store: E2eeMemberStore;
  /** The request receipt store of the same composition, where a shred receipt must land. */
  readonly receipts: Pick<RequestReceiptStore, 'get'>;
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
let requests = 0;
/** A device-proof binding with a requestId no other write has used. */
const freshRequest = () => ({ requestId: `request-${++requests}`, operation: 'e2ee-member-key.register', resource: '/byok/e2ee/member-key', bodySha256: 'sha256', bodySize: 1 });
const entry = (seq: number, note = 'a') => ({ seq, entry: `{"note":"${note}","seq":${seq}}` });
const pkg = (epoch: number, recipient: string, keyId: string, note = 'a', scopeId = 'scope-1'): E2eeScopeKeyPackageRow => ({
  scopeId, epoch, recipient, keyId, sender: 'sender', package: `{"epoch":${epoch},"keyId":"${keyId}","note":"${note}","recipient":"${recipient}"}`,
});
/** Put rows: the package's `recipientKemEpoch` travels beside the opaque package text. */
const v2 = (rows: readonly E2eeScopeKeyPackageRow[], kemEpoch = 1) => rows.map(row => ({ ...row, recipientKemEpoch: kemEpoch }));
const rotation = (seq: number, memberId: string, kemEpoch: number) => ({ seq, memberId, kemEpoch });
const proof = (requestId: string, bodySha256 = 'sha256-a', deviceId = 'dev-1') =>
  ({ deviceId, request: { requestId, operation: 'op', resource: '/resource', bodySha256, bodySize: 10 } });
const shred = (seq: number, scopeId = 'scope-1', note = 'a'): E2eeScopeShred => ({
  seq, scopeId, receipt: { key: `e2ee-scope-shred:${scopeId}`, body: `{"chainSeq":${seq},"note":"${note}"}` },
});
const registration = (deviceId: string, memberId: string, bundle = `{"memberId":"${memberId}"}`, deviceMac = 'mac-1') =>
  ({ deviceId, memberId, bundle, deviceMac, macExpiresAt: T1, request: freshRequest() });

/** The store contract every E2EE member store backend must meet (#654 E2c). */
export function runE2eeMemberStoreConformance(name: string, factory: E2eeMemberCompositionFactory): void {
  const check = (title: string, body: (store: E2eeMemberStore, h: E2eeMemberCompositionHandle) => Promise<void>) => it(title, async () => {
    const h = await factory.create();
    try { await body(h.store, h); } finally { await h.dispose?.(); }
  });
  const receiptBody = async (h: E2eeMemberCompositionHandle, scopeId: string) =>
    (await h.receipts.get(tenant, `e2ee-scope-shred:${scopeId}`))?.body;
  describe(`E2EE member store conformance [${name}]`, () => {
    check('appends a contiguous chain, pages it, and keeps tenants apart', async store => {
      expect(await store.appendChainEntries(tenant, { rows: [entry(1), entry(2), entry(3)], rotations: [], shreds: [] })).toEqual({ outcome: 'appended', appended: 3, replayed: 0 });
      expect(await store.readChainEntries(tenant, { afterSeq: 0, limit: 2 })).toEqual([entry(1), entry(2)]);
      expect(await store.readChainEntries(tenant, { afterSeq: 2, limit: 256 })).toEqual([entry(3)]);
      expect(await store.readChainEntries(tenant, { afterSeq: 3, limit: 256 })).toEqual([]);
      expect(await store.readChainEntries(other, { afterSeq: 0, limit: 256 })).toEqual([]);
      expect(await store.appendChainEntries(other, { rows: [entry(1, 'b')], rotations: [], shreds: [] })).toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
      expect(await store.readChainEntries(tenant, { afterSeq: 0, limit: 1 })).toEqual([entry(1)]);
    });
    check('replays a stored prefix and appends the rest in one call', async store => {
      await store.appendChainEntries(tenant, { rows: [entry(1), entry(2)], rotations: [], shreds: [] });
      expect(await store.appendChainEntries(tenant, { rows: [entry(1), entry(2)], rotations: [], shreds: [] })).toEqual({ outcome: 'appended', appended: 0, replayed: 2 });
      expect(await store.appendChainEntries(tenant, { rows: [entry(2), entry(3), entry(4)], rotations: [], shreds: [] })).toEqual({ outcome: 'appended', appended: 2, replayed: 1 });
      expect((await store.readChainEntries(tenant, { afterSeq: 0, limit: 256 })).map(row => row.seq)).toEqual([1, 2, 3, 4]);
    });
    check('refuses a different entry at a stored seq and writes nothing', async store => {
      await store.appendChainEntries(tenant, { rows: [entry(1), entry(2)], rotations: [], shreds: [] });
      expect(await store.appendChainEntries(tenant, { rows: [entry(2, 'b'), entry(3)], rotations: [], shreds: [] })).toEqual({ outcome: 'conflict', seq: 2 });
      expect(await store.appendChainEntries(tenant, { rows: [entry(1), entry(2, 'b'), entry(3)], rotations: [], shreds: [] })).toEqual({ outcome: 'conflict', seq: 2 });
      expect(await store.readChainEntries(tenant, { afterSeq: 0, limit: 256 })).toEqual([entry(1), entry(2)]);
    });
    check('refuses a gap after the head and writes nothing', async store => {
      expect(await store.appendChainEntries(tenant, { rows: [entry(2), entry(3)], rotations: [], shreds: [] })).toEqual({ outcome: 'gap', seq: 2, headSeq: 0 });
      await store.appendChainEntries(tenant, { rows: [entry(1)], rotations: [], shreds: [] });
      expect(await store.appendChainEntries(tenant, { rows: [entry(3)], rotations: [], shreds: [] })).toEqual({ outcome: 'gap', seq: 3, headSeq: 1 });
      expect(await store.readChainEntries(tenant, { afterSeq: 0, limit: 256 })).toEqual([entry(1)]);
    });
    check('lets exactly one of two concurrent writers take a seq', async store => {
      const results = await Promise.all([
        store.appendChainEntries(tenant, { rows: [entry(1, 'a')], rotations: [], shreds: [] }),
        store.appendChainEntries(tenant, { rows: [entry(1, 'b')], rotations: [], shreds: [] }),
      ]);
      expect(results.map(result => result.outcome).sort()).toEqual(['appended', 'conflict']);
      const stored = await store.readChainEntries(tenant, { afterSeq: 0, limit: 256 });
      expect(stored).toHaveLength(1);
      expect([entry(1, 'a'), entry(1, 'b')]).toContainEqual(stored[0]);
    });
    check('fixes one keyId per scope epoch and replaces a package only under it', async store => {
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1'), pkg(1, 'r2', 'k1')]) })).toEqual({ outcome: 'stored', stored: 2 });
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r3', 'k1'), pkg(1, 'r4', 'k2')]) }))
        .toEqual({ outcome: 'key_id_conflict', scopeId: 'scope-1', epoch: 1, keyId: 'k1' });
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1' })).toEqual([pkg(1, 'r1', 'k1'), pkg(1, 'r2', 'k1')]);
      // A KEM rotation re-wraps the same scope key: same keyId, new package bytes.
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1', 'rewrapped')]) })).toEqual({ outcome: 'stored', stored: 1 });
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(2, 'r1', 'k2')]) })).toEqual({ outcome: 'stored', stored: 1 });
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1' }))
        .toEqual([pkg(1, 'r1', 'k1', 'rewrapped'), pkg(1, 'r2', 'k1'), pkg(2, 'r1', 'k2')]);
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1', epoch: 2 })).toEqual([pkg(2, 'r1', 'k2')]);
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1', recipient: 'r2' })).toEqual([pkg(1, 'r2', 'k1')]);
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-2' })).toEqual([]);
      expect(await store.readScopeKeyPackages(other, { scopeId: 'scope-1' })).toEqual([]);
      expect(await store.putScopeKeyPackages(other, { rows: v2([pkg(1, 'r1', 'k9')]) })).toEqual({ outcome: 'stored', stored: 1 });
    });
    check('lets the first row of a new scope epoch fix its keyId within one put', async store => {
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1'), pkg(1, 'r2', 'k2')]) }))
        .toEqual({ outcome: 'key_id_conflict', scopeId: 'scope-1', epoch: 1, keyId: 'k1' });
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1' })).toEqual([]);
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r2', 'k2')]) })).toEqual({ outcome: 'stored', stored: 1 });
    });
    check('serializes two concurrent first puts of one scope epoch', async store => {
      const results = await Promise.all([
        store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1')]) }),
        store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r2', 'k2')]) }),
      ]);
      expect(results.map(result => result.outcome).sort()).toEqual(['key_id_conflict', 'stored']);
      const stored = await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1' });
      expect(stored).toHaveLength(1);
      expect([pkg(1, 'r1', 'k1'), pkg(1, 'r2', 'k2')]).toContainEqual(stored[0]);
    });
    check('a shred deletes its scope packages and epochs, records its receipt, and refuses later puts of the scope', async (store, h) => {
      await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1'), pkg(1, 'r2', 'k1'), pkg(2, 'r1', 'k2')]) });
      await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k9', 'a', 'scope-2')]) });
      await store.putScopeKeyPackages(other, { rows: v2([pkg(1, 'r1', 'k1')]) });
      expect(await store.appendChainEntries(tenant, { rows: [entry(1), entry(2, 'shred')], rotations: [], shreds: [shred(2)] }))
        .toEqual({ outcome: 'appended', appended: 2, replayed: 0 });
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1' })).toEqual([]);
      expect(await receiptBody(h, 'scope-1')).toBe('{"chainSeq":2,"note":"a"}');
      // A new epoch, an old epoch, and a put that also names a live scope: all refused, nothing written.
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(3, 'r1', 'k3')]) })).toEqual({ outcome: 'scope_shredded', scopeId: 'scope-1' });
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1')]) })).toEqual({ outcome: 'scope_shredded', scopeId: 'scope-1' });
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1'), pkg(1, 'r3', 'k9', 'a', 'scope-2')]) }))
        .toEqual({ outcome: 'scope_shredded', scopeId: 'scope-1' });
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1' })).toEqual([]);
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-2' })).toEqual([pkg(1, 'r1', 'k9', 'a', 'scope-2')]);
      // Another tenant's scope of the same id is untouched.
      expect(await store.readScopeKeyPackages(other, { scopeId: 'scope-1' })).toEqual([pkg(1, 'r1', 'k1')]);
      expect(await store.putScopeKeyPackages(other, { rows: v2([pkg(2, 'r1', 'k2')]) })).toEqual({ outcome: 'stored', stored: 1 });
      expect(await h.receipts.get(other, 'e2ee-scope-shred:scope-1')).toBeUndefined();
    });
    check('a later shred of the same scope keeps the first receipt', async (store, h) => {
      await store.appendChainEntries(tenant, { rows: [entry(1, 'shred')], rotations: [], shreds: [shred(1)] });
      expect(await store.appendChainEntries(tenant, { rows: [entry(2, 'shred')], rotations: [], shreds: [shred(2, 'scope-1', 'b')] }))
        .toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
      expect(await receiptBody(h, 'scope-1')).toBe('{"chainSeq":1,"note":"a"}');
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1')]) })).toEqual({ outcome: 'scope_shredded', scopeId: 'scope-1' });
    });
    check('a replayed row shreds nothing', async (store, h) => {
      await store.appendChainEntries(tenant, { rows: [entry(1)], rotations: [], shreds: [] });
      await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1')]) });
      expect(await store.appendChainEntries(tenant, { rows: [entry(1), entry(2)], rotations: [], shreds: [shred(1)] }))
        .toEqual({ outcome: 'appended', appended: 1, replayed: 1 });
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1' })).toEqual([pkg(1, 'r1', 'k1')]);
      expect(await receiptBody(h, 'scope-1')).toBeUndefined();
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(2, 'r1', 'k2')]) })).toEqual({ outcome: 'stored', stored: 1 });
    });
    check('a refused append shreds nothing', async (store, h) => {
      await store.appendChainEntries(tenant, { rows: [entry(1)], rotations: [], shreds: [] });
      await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1')]) });
      expect(await store.appendChainEntries(tenant, { rows: [entry(2, 'shred'), entry(3)], rotations: [], shreds: [shred(2)] }))
        .toEqual({ outcome: 'appended', appended: 2, replayed: 0 });
      await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1', 'a', 'scope-2')]) });
      // A conflict after the shred row, and a gap: neither deletes or records anything.
      expect(await store.appendChainEntries(tenant, { rows: [entry(3, 'x'), entry(4, 'shred')], rotations: [], shreds: [shred(4, 'scope-2')] }))
        .toEqual({ outcome: 'conflict', seq: 3 });
      expect(await store.appendChainEntries(tenant, { rows: [entry(5, 'shred')], rotations: [], shreds: [shred(5, 'scope-2')] }))
        .toEqual({ outcome: 'gap', seq: 5, headSeq: 3 });
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-2' })).toEqual([pkg(1, 'r1', 'k1', 'a', 'scope-2')]);
      expect(await receiptBody(h, 'scope-2')).toBeUndefined();
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(2, 'r1', 'k2', 'a', 'scope-2')]) })).toEqual({ outcome: 'stored', stored: 1 });
    });
    check('a concurrent later shred of a scope does not take the first shred receipt', async (store, h) => {
      const results = await Promise.all([
        store.appendChainEntries(tenant, { rows: [entry(1, 'shred'), entry(2, 'shred')], rotations: [], shreds: [shred(1, 'scope-a'), shred(2, 'scope-b')] }),
        store.appendChainEntries(tenant, { rows: [entry(3, 'shred')], rotations: [], shreds: [shred(3, 'scope-b', 'later')] }),
      ]);
      expect(results[0]).toEqual({ outcome: 'appended', appended: 2, replayed: 0 });
      expect(await receiptBody(h, 'scope-b')).toBe('{"chainSeq":2,"note":"a"}');
    });
    check('a shred and a concurrent put of a new epoch leave the scope with no packages', async store => {
      await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1')]) });
      const [, put] = await Promise.all([
        store.appendChainEntries(tenant, { rows: [entry(1, 'shred')], rotations: [], shreds: [shred(1)] }),
        store.putScopeKeyPackages(tenant, { rows: v2([pkg(2, 'r1', 'k2')]) }),
      ]);
      expect(['stored', 'scope_shredded']).toContain(put.outcome);
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1' })).toEqual([]);
    });
    check('a rotate raises its member KEM floor and never lowers it', async store => {
      expect(await store.appendChainEntries(tenant, { rows: [entry(1, 'rotate')], rotations: [rotation(1, 'r1', 3)], shreds: [] }))
        .toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1')], 2) }))
        .toEqual({ outcome: 'kem_epoch_stale', recipient: 'r1', kemEpoch: 2, floor: 3 });
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1')], 3) })).toEqual({ outcome: 'stored', stored: 1 });
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(2, 'r1', 'k2')], 4) })).toEqual({ outcome: 'stored', stored: 1 });
      // A lower rotate leaves the floor where it is; a higher one raises it.
      await store.appendChainEntries(tenant, { rows: [entry(2, 'rotate')], rotations: [rotation(2, 'r1', 2)], shreds: [] });
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1')], 2) }))
        .toEqual({ outcome: 'kem_epoch_stale', recipient: 'r1', kemEpoch: 2, floor: 3 });
      await store.appendChainEntries(tenant, { rows: [entry(3, 'rotate')], rotations: [rotation(3, 'r1', 5)], shreds: [] });
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1')], 4) }))
        .toEqual({ outcome: 'kem_epoch_stale', recipient: 'r1', kemEpoch: 4, floor: 5 });
      // Another member, and the same member id in another tenant, have no floor.
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r2', 'k1')]) })).toEqual({ outcome: 'stored', stored: 1 });
      expect(await store.putScopeKeyPackages(other, { rows: v2([pkg(1, 'r1', 'k1')]) })).toEqual({ outcome: 'stored', stored: 1 });
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1' })).toEqual([pkg(1, 'r1', 'k1'), pkg(1, 'r2', 'k1'), pkg(2, 'r1', 'k2')]);
    });
    check('a package below its recipient floor refuses the whole put and writes nothing', async store => {
      await store.appendChainEntries(tenant, {
        rows: [entry(1, 'rotate'), entry(2, 'rotate')], rotations: [rotation(1, 'r1', 2), rotation(2, 'r2', 2)], shreds: [],
      });
      // The first stale row in put order is named; the new epoch's keyId is not fixed.
      expect(await store.putScopeKeyPackages(tenant, { rows: [...v2([pkg(1, 'r1', 'kA')]), ...v2([pkg(1, 'r2', 'kA')]), ...v2([pkg(1, 'r3', 'kA')])] }))
        .toEqual({ outcome: 'kem_epoch_stale', recipient: 'r1', kemEpoch: 1, floor: 2 });
      expect(await store.putScopeKeyPackages(tenant, { rows: [...v2([pkg(1, 'r1', 'kA')], 2), ...v2([pkg(1, 'r2', 'kA')]), ...v2([pkg(1, 'r3', 'kA')])] }))
        .toEqual({ outcome: 'kem_epoch_stale', recipient: 'r2', kemEpoch: 1, floor: 2 });
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1' })).toEqual([]);
      expect(await store.readOwnScopeKeyPackages(tenant, { scopeId: 'scope-1', recipient: 'r3', afterEpoch: 0, limit: 16 }))
        .toEqual({ rows: [], scopeHeadEpoch: undefined });
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r3', 'kB')]) })).toEqual({ outcome: 'stored', stored: 1 });
      // The floor check comes before the keyId check, and a shred before both.
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'kC')]) }))
        .toEqual({ outcome: 'kem_epoch_stale', recipient: 'r1', kemEpoch: 1, floor: 2 });
      await store.appendChainEntries(tenant, { rows: [entry(3, 'shred')], rotations: [], shreds: [shred(3)] });
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(2, 'r1', 'k2')]) })).toEqual({ outcome: 'scope_shredded', scopeId: 'scope-1' });
    });
    check('a replayed or refused rotate raises no floor', async store => {
      await store.appendChainEntries(tenant, { rows: [entry(1, 'rotate')], rotations: [rotation(1, 'r1', 2)], shreds: [], proof: proof('k1') });
      expect(await store.appendChainEntries(tenant, { rows: [entry(1, 'rotate'), entry(2)], rotations: [rotation(1, 'r1', 9)], shreds: [] }))
        .toEqual({ outcome: 'appended', appended: 1, replayed: 1 });
      expect(await store.appendChainEntries(tenant, { rows: [entry(1, 'rotate')], rotations: [rotation(1, 'r1', 9)], shreds: [], proof: proof('k1') }))
        .toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
      expect(await store.appendChainEntries(tenant, { rows: [entry(2, 'x'), entry(3, 'rotate')], rotations: [rotation(3, 'r1', 9)], shreds: [] }))
        .toEqual({ outcome: 'conflict', seq: 2 });
      expect(await store.appendChainEntries(tenant, { rows: [entry(4, 'rotate')], rotations: [rotation(4, 'r1', 9)], shreds: [] }))
        .toEqual({ outcome: 'gap', seq: 4, headSeq: 2 });
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1')], 2) })).toEqual({ outcome: 'stored', stored: 1 });
    });
    check('pages a member own packages of a scope by epoch, with the scope head', async store => {
      const page = (afterEpoch: number, limit = 16, recipient = 'r1', on = tenant) =>
        store.readOwnScopeKeyPackages(on, { scopeId: 'scope-1', recipient, afterEpoch, limit });
      expect(await page(0)).toEqual({ rows: [], scopeHeadEpoch: undefined });
      // Stored out of epoch order; the head epoch 6 holds no package of r1.
      await store.putScopeKeyPackages(tenant, { rows: v2([pkg(5, 'r1', 'k5'), pkg(6, 'r2', 'k6')]) });
      await store.putScopeKeyPackages(tenant, { rows: v2([1, 2, 3, 4].flatMap(epoch => [pkg(epoch, 'r1', `k${epoch}`), pkg(epoch, 'r2', `k${epoch}`)])) });
      await store.putScopeKeyPackages(tenant, { rows: v2([pkg(9, 'r1', 'k9', 'a', 'scope-2')]) });
      expect(await page(0, 2)).toEqual({ rows: [pkg(1, 'r1', 'k1'), pkg(2, 'r1', 'k2')], scopeHeadEpoch: 6 });
      expect(await page(2, 2)).toEqual({ rows: [pkg(3, 'r1', 'k3'), pkg(4, 'r1', 'k4')], scopeHeadEpoch: 6 });
      expect(await page(4)).toEqual({ rows: [pkg(5, 'r1', 'k5')], scopeHeadEpoch: 6 });
      expect(await page(5)).toEqual({ rows: [], scopeHeadEpoch: 6 });
      expect(await page(0, 16, 'r3')).toEqual({ rows: [], scopeHeadEpoch: 6 });
      expect(await page(0, 16, 'r1', other)).toEqual({ rows: [], scopeHeadEpoch: undefined });
    });
    check('a shred empties the paged read of its scope', async store => {
      await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1'), pkg(2, 'r1', 'k2')]) });
      await store.appendChainEntries(tenant, { rows: [entry(1, 'shred')], rotations: [], shreds: [shred(1)] });
      expect(await store.readOwnScopeKeyPackages(tenant, { scopeId: 'scope-1', recipient: 'r1', afterEpoch: 0, limit: 16 }))
        .toEqual({ rows: [], scopeHeadEpoch: undefined });
    });
    check('records a device append request once: the same binding gets the recorded result, another is refused', async store => {
      expect(await store.appendChainEntries(tenant, { rows: [entry(1)], rotations: [], shreds: [], proof: proof('a1') }))
        .toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
      expect(await store.appendChainEntries(tenant, { rows: [entry(1)], rotations: [], shreds: [], proof: proof('a1') }))
        .toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
      expect(await store.appendChainEntries(tenant, { rows: [entry(2)], rotations: [], shreds: [], proof: proof('a1', 'sha256-b') }))
        .toEqual({ outcome: 'request_conflict' });
      expect((await store.readChainEntries(tenant, { afterSeq: 0, limit: 256 })).map(row => row.seq)).toEqual([1]);
      // The id is per device and per tenant, and a Host write records nothing.
      expect(await store.appendChainEntries(tenant, { rows: [entry(2)], rotations: [], shreds: [], proof: proof('a1', 'sha256-b', 'dev-2') }))
        .toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
      expect(await store.appendChainEntries(other, { rows: [entry(1)], rotations: [], shreds: [], proof: proof('a1', 'sha256-b') }))
        .toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
      expect(await store.appendChainEntries(tenant, { rows: [entry(3)], rotations: [], shreds: [] })).toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
    });
    check('a recorded append request shreds nothing again', async (store, h) => {
      await store.appendChainEntries(tenant, { rows: [entry(1, 'shred')], rotations: [], shreds: [shred(1)], proof: proof('s1') });
      expect(await store.appendChainEntries(tenant, { rows: [entry(1, 'shred')], rotations: [], shreds: [shred(1, 'scope-1', 'b')], proof: proof('s1') }))
        .toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
      expect(await receiptBody(h, 'scope-1')).toBe('{"chainSeq":1,"note":"a"}');
    });
    check('a refused device request records nothing, so the same request can succeed later', async store => {
      expect(await store.appendChainEntries(tenant, { rows: [entry(2)], rotations: [], shreds: [], proof: proof('g1') }))
        .toEqual({ outcome: 'gap', seq: 2, headSeq: 0 });
      await store.appendChainEntries(tenant, { rows: [entry(1)], rotations: [], shreds: [] });
      expect(await store.appendChainEntries(tenant, { rows: [entry(2)], rotations: [], shreds: [], proof: proof('g1') }))
        .toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
      await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1')]) });
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r2', 'k2')]), proof: proof('p0') }))
        .toEqual({ outcome: 'key_id_conflict', scopeId: 'scope-1', epoch: 1, keyId: 'k1' });
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r2', 'k2')]), proof: proof('p0', 'sha256-b') }))
        .toEqual({ outcome: 'key_id_conflict', scopeId: 'scope-1', epoch: 1, keyId: 'k1' });
    });
    check('a recorded put request does not overwrite a newer package', async store => {
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1', 'old')]), proof: proof('p1') })).toEqual({ outcome: 'stored', stored: 1 });
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1', 'new')]), proof: proof('p2') })).toEqual({ outcome: 'stored', stored: 1 });
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1', 'old')]), proof: proof('p1') })).toEqual({ outcome: 'stored', stored: 1 });
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1' })).toEqual([pkg(1, 'r1', 'k1', 'new')]);
      expect(await store.putScopeKeyPackages(tenant, { rows: v2([pkg(1, 'r1', 'k1', 'other')]), proof: proof('p1', 'sha256-b') }))
        .toEqual({ outcome: 'request_conflict' });
      expect(await store.readScopeKeyPackages(tenant, { scopeId: 'scope-1' })).toEqual([pkg(1, 'r1', 'k1', 'new')]);
    });
    check('a recorded registration request does not touch the MAC', async store => {
      const register = (mac: string, requestId: string, bodySha256?: string) =>
        store.registerMember(tenant, { ...registration('dev-1', 'm1', undefined, mac), request: proof(requestId, bodySha256).request });
      expect(await register('mac-1', 'r1')).toBe('registered');
      expect(await register('mac-2', 'r2')).toBe('replayed');
      expect(await register('mac-1', 'r1')).toBe('registered');
      expect(await register('mac-3', 'r1', 'sha256-b')).toBe('request_conflict');
      expect(await store.readMemberRegistration(tenant, { deviceId: 'dev-1', now: T0 }))
        .toEqual({ memberId: 'm1', bundle: '{"memberId":"m1"}', deviceMac: 'mac-2' });
    });
    check('a refused registration records nothing, so its request id stays free', async store => {
      expect(await store.registerMember(tenant, registration('dev-1', 'm1'))).toBe('registered');
      const request = (bodySha256: string) => proof('c1', bodySha256).request;
      expect(await store.registerMember(tenant, { ...registration('dev-1', 'm1', '{"memberId":"m1","other":true}'), request: request('sha256-a') }))
        .toBe('device_conflict');
      // Another binding of the same id would be refused had the first attempt recorded it.
      expect(await store.registerMember(tenant, { ...registration('dev-1', 'm1'), request: request('sha256-b') })).toBe('replayed');
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
