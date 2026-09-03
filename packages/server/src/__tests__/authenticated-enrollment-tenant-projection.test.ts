import { PairResponseSchema } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { createByokServer, type ByokServer } from '../index';
import { generateFakeDeviceIdentity, startServer, stopServer, testPairingClaims } from './test-support';

const PRODUCT_ID = 'acme';
const OTHER_PRODUCT_ID = 'other-product';

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
  const servers: HttpServer[] = [];
  const instances: ByokServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await stopServer(server);
    for (const instance of instances.splice(0)) instance.stop();
  });

  async function start(productId: string): Promise<{ byok: ByokServer; baseUrl: string }> {
    const byok = createByokServer({ productId });
    const started = await startServer(byok);
    servers.push(started.server);
    instances.push(byok);
    return { byok, baseUrl: started.baseUrl };
  }

  it('returns the exact redeemed device-row tenant and ignores a request-authored tenant', async () => {
    const started = await start(PRODUCT_ID);
    const { code } = await started.byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const control = await started.byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));

    const { response, body } = await pair(started.baseUrl, code, 'tenant-b');
    // A second enrollment on the same instance, redeemed with NO tenant in the
    // request at all, is what makes "the row's tenant, not the request's" a
    // comparison rather than a restatement: the two agree, and neither is the
    // tenant the first request tried to author.
    const untampered = await pair(started.baseUrl, control.code);

    expect(response.status).toBe(200);
    expect(body.tenantId).not.toBe('tenant-b');
    expect(body.tenantId).toBe(untampered.body.tenantId);
    expect((await started.byok.machines.list()).find((machine) => machine.deviceId === body.deviceId)).toBeDefined();
  });

  it('keeps pair responses isolated when two authenticated codes belong to different tenants', async () => {
    // One embedded server serves exactly ONE tenant, derived from its own
    // `productId` (`stores.ts`), so two tenants means two instances — a code
    // naming any other product is refused at the mint (the case below), which
    // is precisely why a single instance can no longer straddle two.
    const a = await start(PRODUCT_ID);
    const b = await start(OTHER_PRODUCT_ID);
    const codeA = await a.byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const codeB = await b.byok.pairing.createPairingCode(testPairingClaims(OTHER_PRODUCT_ID));

    const first = await pair(a.baseUrl, codeA.code);
    const second = await pair(b.baseUrl, codeB.code);

    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(first.body.tenantId).not.toBe(second.body.tenantId);
  });

  it('refuses to mint a pairing code for a product this instance does not serve', async () => {
    const started = await start(PRODUCT_ID);

    await expect(started.byok.pairing.createPairingCode(testPairingClaims(OTHER_PRODUCT_ID))).rejects.toThrow(
      /does not match this server's product/,
    );
  });

  // 2d gap: `createPairingCode` no longer accepts a caller-authored `tenantId`
  // — an embedded server derives its one tenant from `productId` at
  // construction — so a malformed or oversize tenant CLAIM has no input to
  // arrive on, and the `PAIR_RESPONSE_TENANT_ID_MAX_LENGTH` rejection cannot be
  // provoked from this surface at all. The mint-point validation itself is
  // core's (`tenantId()`), covered by `packages/core`'s own suite.
  it.skip('rejects malformed and oversize tenant claims before a response can be emitted', () => {
    // intentionally empty — see the 2d gap note above.
  });
});
