/**
 * GAP-6: the instance half of the S1 product boundary, on the hosted surface.
 *
 * A device row belongs to ONE product, and `createPairingCode` takes the
 * product per code — so a tenant can hold devices for several products at
 * once, which is exactly what a multi-product hosted control plane is for.
 * Cloud's bearer check has therefore only ever asked whether the token agrees
 * with the row it names (`auth/bearer.ts`), and that is the whole authority
 * for that deployment shape.
 *
 * A single-product instance is a different shape with a different authority:
 * `@byok-sdk/server` has always compared the row against the instance's own
 * `productId` as well (`packages/server/src/auth.ts`), and its sentinel
 * (`packages/server/src/__tests__/bearer-instance-product.test.ts`) is what
 * keeps that true. `ByokCloudOptions.instanceProductId` is how a deployment
 * declares it here, so a façade built over this kernel carries the same
 * posture instead of silently widening it.
 *
 * The two shapes are two explicit authorities, not a check and its fallback —
 * which is why the last suite below pins the absent-option behaviour as
 * unchanged rather than as a weaker version of the same rule.
 */
import { createHash } from 'node:crypto';
import type { Clock } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { createHmacTokenSigner } from '../auth/tokens';
import { PRODUCT_ID, TENANT_A, createHarness, type CloudHarness, type PairedDevice } from './support/harness';

const OTHER_PRODUCT_ID = 'other-product';

interface RouteAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** The three bearer-authed route classes a device actually reaches: read, write, and reserve. */
async function bearerRoutes(harness: CloudHarness, authorization: string, key: string): Promise<readonly RouteAnswer[]> {
  const bytes = new TextEncoder().encode('hello');
  const events = await harness.json('/byok/events?cursor=0', { headers: { authorization } });
  const messages = await harness.json('/byok/messages', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  });
  const blob = await harness.json('/byok/blobs', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({
      size: bytes.length,
      contentType: 'text/plain',
      contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    }),
  });
  return [events, messages, blob];
}

function bearer(device: PairedDevice): string {
  return device.authorization.authorization;
}

describe('instance-product bearer (GAP-6)', () => {
  it('refuses a cross-product device on every bearer-authed route when the instance declares its product', async () => {
    const harness = createHarness({ instanceProductId: PRODUCT_ID });
    // Genuinely paired, genuinely signed by this deployment's own signer,
    // token and row in perfect agreement — and for another product.
    const foreign = await harness.pairDevice(TENANT_A, OTHER_PRODUCT_ID);

    for (const answer of await bearerRoutes(harness, bearer(foreign), 'foreign-reservation')) {
      expect(answer.status).toBe(401);
      // Byte-identical to every other auth failure: an instance mismatch must
      // not be distinguishable from an unknown, wrong-tenant, or revoked
      // device, or the 401 becomes an oracle for what this instance serves.
      expect(answer.body).toEqual({ error: 'unauthorized' });
    }
  });

  it('answers a cross-product token and a garbage token identically', async () => {
    const harness = createHarness({ instanceProductId: PRODUCT_ID });
    const foreign = await harness.pairDevice(TENANT_A, OTHER_PRODUCT_ID);

    const crossProduct = await harness.json('/byok/events?cursor=0', {
      headers: { authorization: bearer(foreign) },
    });
    const garbage = await harness.json('/byok/events?cursor=0', {
      headers: { authorization: 'Bearer not-a-jwt' },
    });

    expect(crossProduct).toEqual(garbage);
    expect(JSON.stringify(crossProduct.body)).not.toContain(OTHER_PRODUCT_ID);
    expect(JSON.stringify(crossProduct.body)).not.toContain(foreign.deviceId);
  });

  it('leaves a same-product device working on all three routes', async () => {
    const harness = createHarness({ instanceProductId: PRODUCT_ID });
    const local = await harness.pairDevice(TENANT_A, PRODUCT_ID);

    for (const answer of await bearerRoutes(harness, bearer(local), 'local-reservation')) {
      expect(answer.status).toBe(200);
    }
  });

  it('rejects a token minted for a third product even when the instance product is one the tenant has devices for', async () => {
    const clock: Clock = { now: () => new Date() };
    const signer = createHmacTokenSigner(new Uint8Array(32).fill(11), clock);
    const harness = createHarness({ instanceProductId: PRODUCT_ID, tokenSigner: signer, clock });
    const local = await harness.pairDevice(TENANT_A, PRODUCT_ID);

    // Signed by this deployment's own key and naming a real, same-tenant
    // device — but claiming a product neither the row nor the instance has.
    // The row check already refuses this; asserted so the instance check is
    // proven additive rather than a replacement for it.
    const forged = await signer.sign(
      { deviceId: local.deviceId, tenantId: TENANT_A, productId: 'third-product' },
      60,
    );

    const answer = await harness.json('/byok/events?cursor=0', {
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({ error: 'unauthorized' });
  });
});

describe('without an instance product, the device row stays the whole product authority', () => {
  it('accepts a cross-product device whose token and row agree, exactly as before', async () => {
    const harness = createHarness();
    const foreign = await harness.pairDevice(TENANT_A, OTHER_PRODUCT_ID);

    for (const answer of await bearerRoutes(harness, bearer(foreign), 'multi-product-reservation')) {
      expect(answer.status).toBe(200);
    }
  });

  it('still refuses a token whose product disagrees with the row it names', async () => {
    const clock: Clock = { now: () => new Date() };
    const signer = createHmacTokenSigner(new Uint8Array(32).fill(13), clock);
    const harness = createHarness({ tokenSigner: signer, clock });
    const device = await harness.pairDevice(TENANT_A, PRODUCT_ID);

    const forged = await signer.sign(
      { deviceId: device.deviceId, tenantId: TENANT_A, productId: OTHER_PRODUCT_ID },
      60,
    );

    const answer = await harness.json('/byok/events?cursor=0', {
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({ error: 'unauthorized' });
  });

  it('serves several products in one tenant off the same instance', async () => {
    const harness = createHarness();
    const first = await harness.pairDevice(TENANT_A, PRODUCT_ID);
    const second = await harness.pairDevice(TENANT_A, OTHER_PRODUCT_ID);

    const firstPoll = await harness.json('/byok/events?cursor=0', {
      headers: { authorization: bearer(first) },
    });
    const secondPoll = await harness.json('/byok/events?cursor=0', {
      headers: { authorization: bearer(second) },
    });

    expect(firstPoll.status).toBe(200);
    expect(secondPoll.status).toBe(200);
  });
});
