import { createEnvelope } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { handleInboundEnvelope } from '../inbound';
import { tenantStoresFor } from '../tenant-stores';
import { createHarness, offerPayload, TENANT_A } from './support/harness';

function storesFor(harness: ReturnType<typeof createHarness>, deviceId: string) {
  return tenantStoresFor(
    { kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId },
    { core: harness.core, cloud: harness.stores },
  );
}

describe('protocol-version admission at cloud lifecycle boundaries', () => {
  it('rejects v:2 at the exported inbound gate before the claim lifecycle mutation', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    const v2Claim = { ...createEnvelope('task.claim', { deviceId: device.deviceId }, { taskId: offer.taskId }), v: 2 };

    await expect(handleInboundEnvelope(storesFor(harness, device.deviceId), device.deviceId, v2Claim)).resolves.toBe('rejected');
    expect((await harness.cloud.readTaskAttempt(TENANT_A, offer.taskId))?.status).toBe('offered');
    await expect(
      handleInboundEnvelope(storesFor(harness, device.deviceId), device.deviceId, { ...v2Claim, v: 1 }),
    ).resolves.toBe('accepted');
    expect((await harness.cloud.readTaskAttempt(TENANT_A, offer.taskId))?.status).toBe('claimed');
  });

  it('rejects v:2 at POST /byok/messages before it can be acknowledged as accepted', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    const v2Claim = { ...createEnvelope('task.claim', { deviceId: device.deviceId }, { taskId: offer.taskId }), v: 2 };

    const response = await harness.request('/byok/messages', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [v2Claim] }),
    });
    expect(response.status).toBe(400);
    expect((await harness.cloud.readTaskAttempt(TENANT_A, offer.taskId))?.status).toBe('offered');
  });

  it('keeps the supported v:1 claim path accepted', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    const v1Claim = createEnvelope('task.claim', { deviceId: device.deviceId }, { taskId: offer.taskId });

    await expect(handleInboundEnvelope(storesFor(harness, device.deviceId), device.deviceId, v1Claim)).resolves.toBe('accepted');
    expect((await harness.cloud.readTaskAttempt(TENANT_A, offer.taskId))?.status).toBe('claimed');
  });
});
