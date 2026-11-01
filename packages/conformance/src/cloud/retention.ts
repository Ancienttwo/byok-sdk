import { describe, expect, it } from 'vitest';
import { DEFAULT_APPROVAL_TIMELINE_TTL_MS, REQUEST_RECEIPT_PREFIXES } from '@byok-sdk/cloud';
import { TENANT_A, TENANT_B, registration } from './fixtures';
import { withCloudComposition, type CloudCompositionFactory } from './harness';
const IDENTITY_KEYS = [
  'task-offer:1', 'task-offer-delivered:1', 'task:1:terminal', 'agent-message-offer:1',
  'agent-content-request:1', 'agent-content-receipt:1', 'agent-home-projection-request:1',
  'agent-home-projection-completion:1', 'agent-input-preparation-request:1',
  'agent-input-preparation-completion:1', 'pairing-completion:v1:1', 'host-unregistered:1',
  'e2ee-scope-shred:scope-1',
];
export function runCloudRetentionConformance(name: string, factory: CloudCompositionFactory, options: { readonly requestPrefixMock?: string } = {}): void {
  describe(`cloud retention [${name}]`, () => {
    it('uses only the kernel request projection and preserves every identity family', async () => {
      expect(REQUEST_RECEIPT_PREFIXES).toEqual(options.requestPrefixMock === undefined ? [] : [options.requestPrefixMock]);
      await withCloudComposition(factory, async handle => {
        for (const key of IDENTITY_KEYS) await handle.stores.receipts.record(TENANT_A, { key, body: key });
        await handle.advanceTime(1000);
        const input = { now: handle.now(), limit: 2, requestBefore: handle.now() };
        expect(await handle.stores.receipts.collectExpired(TENANT_A, input)).toEqual({ removed: 0, expired: 0, releasedBytes: 0n, more: false });
        for (const key of IDENTITY_KEYS) expect(await handle.stores.receipts.get(TENANT_A, key)).toMatchObject({ body: key });
      });
    });
    if (options.requestPrefixMock !== undefined) it('deletes only old request rows up to the limit and reports an actual remainder', async () => {
      await withCloudComposition(factory, async handle => {
        const prefix = options.requestPrefixMock!;
        for (let n = 1; n <= 3; n++) await handle.stores.receipts.record(TENANT_A, { key: prefix + n, body: String(n) });
        await handle.stores.receipts.record(TENANT_B, { key: prefix + 'other', body: 'other' });
        await handle.advanceTime(1000);
        const input = { now: handle.now(), limit: 2, requestBefore: handle.now() };
        await handle.stores.receipts.record(TENANT_A, { key: prefix + 'fresh', body: 'fresh' });
        expect(await handle.stores.receipts.collectExpired(TENANT_A, input)).toEqual({ removed: 2, expired: 0, releasedBytes: 0n, more: true });
        expect(await handle.stores.receipts.collectExpired(TENANT_A, { ...input, limit: 1 })).toEqual({ removed: 1, expired: 0, releasedBytes: 0n, more: false });
        expect(await handle.stores.receipts.get(TENANT_A, prefix + 'fresh')).toBeDefined();
        expect(await handle.stores.receipts.get(TENANT_B, prefix + 'other')).toBeDefined();
      });
    });
    it('collects spent nonces in bounded batches without crossing tenants', async () => {
      await withCloudComposition(factory, async handle => {
        const nonces = handle.stores.nonces;
        for (let n = 1; n <= 3; n++) { const value = await nonces.issue(TENANT_A, 'device'); expect(await nonces.consumeIfValid(TENANT_A, 'device', value)).toBe(true); }
        const protectedNonce = await nonces.issue(TENANT_B, 'device');
        const input = { now: handle.now(), limit: 2 };
        expect(await nonces.collectExpired(TENANT_A, input)).toEqual({ removed: 2, expired: 0, releasedBytes: 0n, more: true });
        expect(await nonces.collectExpired(TENANT_A, { ...input, limit: 1 })).toEqual({ removed: 1, expired: 0, releasedBytes: 0n, more: false });
        expect(await nonces.consumeIfValid(TENANT_B, 'device', protectedNonce)).toBe(true);
      });
    });
    it('preserves redeemed pairing identity state and collects only strictly expired unused codes', async () => {
      await withCloudComposition(factory, async handle => {
        const { stores } = handle;
        const expiresAt = handle.now();
        for (const code of ['used', 'unused-1', 'unused-2']) await stores.pairingCodes.issue(TENANT_A, { code, productId: 'product-1', expiresAt });
        const device = registration('paired');
        const input = { pairingCode: 'used', deviceId: device.deviceId, deviceName: device.deviceName, devicePublicKey: device.devicePublicKey, proofKeyId: device.proofKeyId, proofKeyEpoch: device.proofKeyEpoch };
        const enrolled = await stores.pairing.redeemAndRegister(input);
        expect(enrolled).toBeDefined();
        expect(await stores.pairingCodes.collectExpired(TENANT_A, { now: handle.now(), limit: 1 })).toEqual({ removed: 0, expired: 0, releasedBytes: 0n, more: false });
        await handle.advanceTime(1);
        expect(await stores.pairingCodes.collectExpired(TENANT_A, { now: handle.now(), limit: 1 })).toEqual({ removed: 1, expired: 0, releasedBytes: 0n, more: true });
        expect(await stores.pairingCodes.collectExpired(TENANT_A, { now: handle.now(), limit: 1 })).toEqual({ removed: 1, expired: 0, releasedBytes: 0n, more: false });
        expect(await stores.pairing.redeemAndRegister(input)).toEqual(enrolled);
      });
    });
    for (const kind of ['activity', 'approvals'] as const) it(`bounds expired ${kind} tails and protects another tenant`, async () => {
      await withCloudComposition(factory, async handle => {
        const seed = async (tenant: typeof TENANT_A, n: number) => kind === 'activity'
          ? handle.stores.activity.append(tenant, { taskId: `tail-${n}`, sourceEnvelopeId: `source-${n}`, batchSeq: 1, events: [{ type: 'progress', text: 'one' }], dropped: 0, ttlMs: 1000 })
          : handle.stores.approvals.append(tenant, { taskId: `tail-${n}`, sourceEnvelopeId: `source-${n}`, event: { type: 'approval_requested', summary: 'Approve', approvalId: String(n) } });
        for (let n = 1; n <= 3; n++) await seed(TENANT_A, n);
        await seed(TENANT_B, 4);
        if (kind === 'activity') {
          for (let n = 1; n <= 3; n++) await handle.stores.activity.settle(TENANT_A, `tail-${n}`, handle.now());
          await handle.stores.activity.settle(TENANT_B, 'tail-4', handle.now());
        } else {
          // An approval timeline expires only after its task's output closes (#1113 A3).
          const close = async (tenant: typeof TENANT_A, taskId: string) => {
            await handle.stores.tasks.open(tenant, { taskId, deviceId: 'device-1' });
            await handle.stores.tasks.claim(tenant, { taskId, deviceId: 'device-1' });
            await handle.stores.tasks.recordStatus(tenant, { taskId, status: 'complete' });
          };
          for (let n = 1; n <= 3; n++) await close(TENANT_A, `tail-${n}`);
          await close(TENANT_B, 'tail-4');
        }
        await handle.advanceTime(kind === 'activity' ? 1000 : DEFAULT_APPROVAL_TIMELINE_TTL_MS);
        const store = handle.stores[kind];
        const input = { now: handle.now(), limit: 2 };
        expect(await store.collectExpired(TENANT_A, input)).toEqual({ removed: 2, expired: 0, releasedBytes: 0n, more: true });
        expect(await store.collectExpired(TENANT_A, { ...input, limit: 1 })).toEqual({ removed: 1, expired: 0, releasedBytes: 0n, more: false });
        // Moving the injected read clock back proves B's physical row survived.
        await handle.advanceTime(-1);
        expect(await store.read(TENANT_B, 'tail-4')).toBeDefined();
      });
    });
  });
}
