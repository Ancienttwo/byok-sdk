import { PairResponseSchema } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import {
  PRODUCT_ID,
  TENANT_A,
  TENANT_B,
  createDeviceKeys,
  createHarness,
  type CloudHarness,
} from './support/harness';

async function pair(harness: CloudHarness, tenant: typeof TENANT_A, requestTenant?: string) {
  const pairing = await harness.cloud.createPairingCode(tenant, { productId: PRODUCT_ID });
  const keys = createDeviceKeys();
  const response = await harness.request('/byok/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairingCode: pairing.code,
      deviceName: 'projection-test-device',
      devicePublicKey: keys.publicKeyBase64Url,
      ...(requestTenant === undefined ? {} : { tenantId: requestTenant }),
    }),
  });
  const body = PairResponseSchema.parse(await response.json());
  return { response, body };
}

describe('authenticated enrollment tenant projection (hosted cloud)', () => {
  it('returns the exact redeemed device-row tenant and ignores a request-authored tenant', async () => {
    const harness = createHarness();
    const { response, body } = await pair(harness, TENANT_A, TENANT_B);

    expect(response.status).toBe(200);
    expect(body.tenantId).toBe(TENANT_A);
    expect((await harness.stores.devices.get(TENANT_A, body.deviceId))?.tenantId).toBe(TENANT_A);
    expect(await harness.stores.devices.get(TENANT_B, body.deviceId)).toBeUndefined();
  });

  it('keeps pair responses isolated when two authenticated codes belong to different tenants', async () => {
    const harness = createHarness();
    const first = await pair(harness, TENANT_A);
    const second = await pair(harness, TENANT_B);

    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(first.body.tenantId).toBe(TENANT_A);
    expect(second.body.tenantId).toBe(TENANT_B);
    expect(first.body.tenantId).not.toBe(second.body.tenantId);
  });
});
