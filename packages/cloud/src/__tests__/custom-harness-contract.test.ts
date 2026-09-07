import { describe, expect, it } from 'vitest';
import { createEnvelope, HarnessIdSchema, HarnessInventorySchema } from '@byok-sdk/protocol';
import { handleInboundEnvelope } from '../inbound';
import { tenantStoresFor } from '../tenant-stores';
import { createHarness, TENANT_A, offerPayload } from './support/harness';

const capabilities = { steer: true, resume: true, approvalInteractive: false, permissionModes: ['auto' as const] };
const inventory = [{ id: 'acme-harness', version: '1.2.3', capabilities }];

async function setup() {
  const h = createHarness();
  const device = await h.pairDevice(TENANT_A);
  const stores = tenantStoresFor({ kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId: device.deviceId }, { core: h.core, cloud: h.stores });
  return { h, stores, deviceId: device.deviceId };
}

describe('custom harness protocol authority', () => {
  it('rejects reserved, malformed and duplicate inventory identities', () => {
    for (const id of ['pi', 'claude', 'codex', '', '../secret', 'x'.repeat(129)]) expect(HarnessIdSchema.safeParse(id).success).toBe(false);
    expect(HarnessInventorySchema.safeParse([...inventory, ...inventory]).success).toBe(false);
  });

  it('requires the capability and advertised inventory before reserving an offer', async () => {
    const { h, stores, deviceId } = await setup();
    await expect(h.cloud.enqueueOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), harnessId: 'acme-harness' } })).rejects.toThrow('custom-harness');
    await stores.devices.recordCapabilities({ capabilities: ['custom-harness'], harnesses: inventory });
    await expect(h.cloud.enqueueOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), harnessId: 'other' } })).rejects.toThrow();
    await expect(h.cloud.enqueueOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), harnessId: 'acme-harness', runtime: 'pi' } })).rejects.toThrow();
    const hello = createEnvelope('conn.hello', { deviceId, productId: 'test-product', protocolVersions: [1], capabilities: [], runtimes: [], harnesses: inventory });
    expect(await handleInboundEnvelope(stores, deviceId, hello)).toBe('rejected');
  });

  it('seals explicit selection, claim CAS and terminal echo for the actual device', async () => {
    const { h, stores, deviceId } = await setup();
    await stores.devices.recordCapabilities({ capabilities: ['custom-harness'], harnesses: [...inventory, { ...inventory[0]!, id: 'other' }] });
    const { taskId } = await h.cloud.enqueueOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), harnessId: 'acme-harness' } });
    for (const payload of [{ deviceId }, { deviceId, harnessId: 'other' }, { deviceId, harnessId: 'acme-harness', runtime: 'pi' as const }]) {
      expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', payload, { taskId }))).toBe('rejected');
    }
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, harnessId: 'acme-harness', capabilities }, { taskId }))).toBe('accepted');
    expect((await stores.tasks.get(taskId))?.claimedHarnessId).toBe('acme-harness');
    for (const harnessId of [undefined, 'other']) {
      expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.complete', { summary: 'done', sessionRef: 's', ...(harnessId ? { harnessId } : {}) }, { taskId }))).toBe('rejected');
    }
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.complete', { summary: 'done', sessionRef: 's', harnessId: 'acme-harness' }, { taskId }))).toBe('accepted');
  });

  it('keeps two device inventories and actual claims isolated, including implicit selection', async () => {
    const { h, stores, deviceId } = await setup();
    const other = await h.pairDevice(TENANT_A);
    const otherStores = tenantStoresFor({ kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId: other.deviceId }, { core: h.core, cloud: h.stores });
    await stores.devices.recordCapabilities({ capabilities: ['custom-harness'], harnesses: inventory });
    await otherStores.devices.recordCapabilities({ capabilities: ['custom-harness'], harnesses: [{ ...inventory[0]!, id: 'other' }] });
    await expect(h.cloud.enqueueOffer(TENANT_A, other.deviceId, { payload: { ...offerPayload(), harnessId: 'acme-harness' } })).rejects.toThrow();
    const { taskId } = await h.cloud.enqueueOffer(TENANT_A, deviceId, { payload: offerPayload() });
    expect(await handleInboundEnvelope(otherStores, other.deviceId, createEnvelope('task.claim', { deviceId: other.deviceId, harnessId: 'other' }, { taskId }))).toBe('rejected');
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, harnessId: 'acme-harness' }, { taskId }))).toBe('accepted');
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, runtime: 'pi' }, { taskId }))).toBe('rejected');
    expect((await stores.tasks.get(taskId))?.claimedHarnessId).toBe('acme-harness');
    const builtin = await h.cloud.enqueueOffer(TENANT_A, deviceId, { payload: { ...offerPayload(), runtime: 'pi' } });
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, harnessId: 'acme-harness' }, { taskId: builtin.taskId }))).toBe('rejected');
  });

  it('does not permit a custom terminal identity on a built-in claim', async () => {
    const { h, stores, deviceId } = await setup();
    const { taskId } = await h.cloud.enqueueOffer(TENANT_A, deviceId, { payload: offerPayload() });
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, runtime: 'pi' }, { taskId }))).toBe('accepted');
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.fail', { reason: 'x', retryable: false, harnessId: 'acme-harness' }, { taskId }))).toBe('rejected');
  });
});
