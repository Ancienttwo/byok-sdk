import { PAIR_RESPONSE_TENANT_ID_MAX_LENGTH, PairResponseSchema } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { createByokServer } from '../index';
import { generateFakeDeviceIdentity, startServer, stopServer } from './test-support';

const PRODUCT_ID = 'acme';

async function pair(
  baseUrl: string,
  pairingCode: string,
  requestTenant?: string,
): Promise<{ response: Response; body: ReturnType<typeof PairResponseSchema.parse> }> {
  const identity = generateFakeDeviceIdentity();
  const response = await fetch(`${baseUrl}/byok/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairingCode,
      deviceName: 'projection-test-device',
      devicePublicKey: identity.publicKeyBase64Url,
      ...(requestTenant === undefined ? {} : { tenantId: requestTenant }),
    }),
  });
  const body = PairResponseSchema.parse(await response.json());
  return { response, body };
}

describe('authenticated enrollment tenant projection (reference server)', () => {
  let server: HttpServer | undefined;

  afterEach(async () => {
    if (server !== undefined) await stopServer(server);
    server = undefined;
  });

  it('returns the exact redeemed device-row tenant and ignores a request-authored tenant', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const code = byok.pairing.createPairingCode({ tenantId: 'tenant-a', productId: PRODUCT_ID }).code;

    const { response, body } = await pair(started.baseUrl, code, 'tenant-b');

    expect(response.status).toBe(200);
    expect(body.tenantId).toBe('tenant-a');
    expect(byok.machines.list().find((machine) => machine.deviceId === body.deviceId)).toBeDefined();
  });

  it('keeps pair responses isolated when two authenticated codes belong to different tenants', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const codeA = byok.pairing.createPairingCode({ tenantId: 'tenant-a', productId: PRODUCT_ID }).code;
    const codeB = byok.pairing.createPairingCode({ tenantId: 'tenant-b', productId: PRODUCT_ID }).code;

    const first = await pair(started.baseUrl, codeA);
    const second = await pair(started.baseUrl, codeB);

    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(first.body.tenantId).toBe('tenant-a');
    expect(second.body.tenantId).toBe('tenant-b');
    expect(first.body.tenantId).not.toBe(second.body.tenantId);
  });

  it('rejects malformed and oversize tenant claims before a response can be emitted', () => {
    const byok = createByokServer({ productId: PRODUCT_ID });

    expect(() => byok.pairing.createPairingCode({ tenantId: '', productId: PRODUCT_ID })).toThrow(TypeError);
    expect(() => byok.pairing.createPairingCode({ tenantId: ' tenant-a', productId: PRODUCT_ID })).toThrow(TypeError);
    expect(() =>
      byok.pairing.createPairingCode({
        tenantId: 't'.repeat(PAIR_RESPONSE_TENANT_ID_MAX_LENGTH + 1),
        productId: PRODUCT_ID,
      }),
    ).toThrow(TypeError);
    byok.stop();
  });
});
