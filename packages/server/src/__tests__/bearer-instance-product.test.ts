import { createHash } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createByokServer, type ByokServer } from '../index';
import { generateFakeDeviceIdentity, pairFakeDaemon, startServer, stopServer, testPairingClaims } from './test-support';

/**
 * The instance-equality half of the S1 product boundary: a device row belongs
 * to ONE product, and a server instance serves ONE product (`productId` on
 * `createByokServer`).
 *
 * WP3B Step 2 moved the enforcement, and with it the reachable surface. The
 * bearer check itself is the cloud kernel's now
 * (`packages/cloud/src/auth/bearer.ts`, `instanceProductId`), and this façade
 * ALSO fails closed one step earlier: `pairing.createPairingCode` refuses a
 * product this instance does not serve, because an embedded server derives its
 * one tenant from its own `productId`. A cross-product device row therefore
 * cannot be brought into existence through this package's public surface at
 * all, which is why the cross-product cases below are skipped rather than
 * rewritten — see each one's own `2d gap` note.
 */

const PRODUCT_ID = 'acme';

/** Short enough that a successful poll answers immediately instead of holding. */
const SHORT_HOLD_MS = 50;

interface RouteAnswer {
  status: number;
  body: unknown;
}

async function pollEvents(baseUrl: string, accessToken: string): Promise<RouteAnswer> {
  const res = await fetch(`${baseUrl}/byok/events?cursor=0`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return { status: res.status, body: await res.json() };
}

async function sendMessages(baseUrl: string, accessToken: string): Promise<RouteAnswer> {
  const res = await fetch(`${baseUrl}/byok/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  });
  return { status: res.status, body: await res.json() };
}

async function createBlob(baseUrl: string, accessToken: string, key: string): Promise<RouteAnswer> {
  const content = Buffer.from('hello');
  const res = await fetch(`${baseUrl}/byok/blobs`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify({
      size: content.length,
      contentType: 'text/plain',
      contentHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    }),
  });
  return { status: res.status, body: await res.json() };
}

describe('S1: a bearer token is only good on the instance serving its product', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    // This suite is made almost entirely of requests the server rejects
    // mid-request, which is what surfaced the unread-body connection pin
    // `stopServer` now handles for every server suite — see its doc comment.
    if (server) await stopServer(server);
    byok?.stop();
    server = undefined;
    byok = undefined;
  });

  async function startWith() {
    byok = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    const started = await startServer(byok);
    server = started.server;
    return { byok, ...started };
  }

  /**
   * Pair a device through a code minted for this instance's product. The token
   * comes back from `/byok/pair` itself — genuinely signed by the instance's own
   * signer, carrying the row's own claims.
   */
  async function pairInto(
    baseUrl: string,
    instance: ByokServer,
    productId: string,
  ): Promise<{ deviceId: string; accessToken: string }> {
    const { code } = await instance.pairing.createPairingCode(testPairingClaims(productId));
    const { deviceId, accessToken } = await pairFakeDaemon(baseUrl, code, {
      identity: generateFakeDeviceIdentity(),
    });
    return { deviceId, accessToken };
  }

  // 2d gap: constructing a cross-product device row is no longer possible from
  // this package's public surface — `createPairingCode` refuses a foreign
  // product before a code exists, and there is no other way to enroll a device
  // into an embedded instance. The bearer-time check this pinned lives in the
  // kernel and is covered there by
  // `packages/cloud/src/__tests__/bearer-instance-product.test.ts`, which drives
  // `instanceProductId` directly against a multi-product device directory.
  it.skip('refuses a cross-product device on every bearer-authed route', () => {
    // intentionally empty — see the 2d gap note above.
  });

  it('leaves a same-product device working on all three routes', async () => {
    const started = await startWith();
    const local = await pairInto(started.baseUrl, started.byok, PRODUCT_ID);

    expect((await pollEvents(started.baseUrl, local.accessToken)).status).toBe(200);
    expect((await sendMessages(started.baseUrl, local.accessToken)).status).toBe(200);
    expect((await createBlob(started.baseUrl, local.accessToken, 'local-reservation')).status).toBe(200);
  });

  // 2d gap: same reason as the first case — the cross-product token half of
  // this comparison cannot be minted here any more. The "every auth failure
  // answers identically" property it guarded is still pinned on this surface by
  // `tenant-pairing-isolation.test.ts` ("answers unknown, wrong-tenant, and
  // revoked identically — no existence oracle").
  it.skip('answers a cross-product token and a garbage token identically', () => {
    // intentionally empty — see the 2d gap note above.
  });

  it('refuses to mint a pairing code for a product this instance does not serve, before any row exists', async () => {
    const started = await startWith();

    await expect(started.byok.pairing.createPairingCode(testPairingClaims('other-product'))).rejects.toThrow(
      /does not match this server's product/,
    );
    // Nothing was enrolled by the refusal.
    expect(await started.byok.machines.list()).toEqual([]);
  });
});
