import { createHash } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authenticateBearer,
  createHmacTokenSigner,
  DeviceRegistry,
  mintAccessToken,
} from '../auth';
import { createByokServer, type ByokServer } from '../index';
import { generateFakeDeviceIdentity, pairFakeDaemon, startServer, stopServer } from './test-support';

/**
 * The instance-equality half of the S1 product boundary: a device row belongs
 * to ONE product, and a server instance serves ONE product (`productId` on
 * `createByokServer`). The WS side has always enforced that transitively —
 * `conn.hello` compares the announced product against both the instance and
 * the row (`ws-server.ts`) — while every bearer-authed HTTP route only ever
 * asked whether the token matched the row it named. A code minted for another
 * product (`createPairingCode` takes the product per code) therefore produced
 * a device that WS refused but that could still poll events, inject envelopes,
 * and reserve blobs over HTTP.
 *
 * `authenticateBearer` (`auth.ts`) is where that gap closes, so the guarantee
 * lands once for every surface that shares it — the routes below are the
 * observable proof, not three separate checks.
 */

const PRODUCT_ID = 'acme';
const OTHER_PRODUCT_ID = 'other-product';
const TENANT_A = 'tenant-a';

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
   * Pair a device through a code minted for `productId`. The token comes back
   * from `/byok/pair` itself — genuinely signed by the instance's own signer,
   * carrying the row's own claims. Nothing here is forged: this is exactly the
   * credential a device paired through a cross-product code holds.
   */
  async function pairInto(
    baseUrl: string,
    instance: ByokServer,
    productId: string,
  ): Promise<{ deviceId: string; accessToken: string }> {
    const { code } = instance.pairing.createPairingCode({ tenantId: TENANT_A, productId });
    const { deviceId, accessToken } = await pairFakeDaemon(baseUrl, code, {
      identity: generateFakeDeviceIdentity(),
    });
    return { deviceId, accessToken };
  }

  it('refuses a cross-product device on every bearer-authed route', async () => {
    const started = await startWith();
    const foreign = await pairInto(started.baseUrl, started.byok, OTHER_PRODUCT_ID);

    const answers = [
      await pollEvents(started.baseUrl, foreign.accessToken),
      await sendMessages(started.baseUrl, foreign.accessToken),
      await createBlob(started.baseUrl, foreign.accessToken, 'foreign-reservation'),
    ];

    for (const answer of answers) {
      expect(answer.status).toBe(401);
      // Same body every other auth failure gets — an instance mismatch must
      // not be distinguishable from an unknown, wrong-tenant, or revoked
      // device, or the 401 becomes an oracle for what this server serves.
      expect(answer.body).toEqual({ error: 'unauthorized' });
    }
  });

  it('leaves a same-product device working on all three routes', async () => {
    const started = await startWith();
    const local = await pairInto(started.baseUrl, started.byok, PRODUCT_ID);

    expect((await pollEvents(started.baseUrl, local.accessToken)).status).toBe(200);
    expect((await sendMessages(started.baseUrl, local.accessToken)).status).toBe(200);
    expect((await createBlob(started.baseUrl, local.accessToken, 'local-reservation')).status).toBe(200);
  });

  it('answers a cross-product token and a garbage token identically', async () => {
    const started = await startWith();
    const foreign = await pairInto(started.baseUrl, started.byok, OTHER_PRODUCT_ID);

    const crossProduct = await sendMessages(started.baseUrl, foreign.accessToken);
    const garbage = await sendMessages(started.baseUrl, 'not-a-jwt');

    expect(crossProduct).toEqual(garbage);
    expect(JSON.stringify(crossProduct.body)).not.toContain(OTHER_PRODUCT_ID);
    expect(JSON.stringify(crossProduct.body)).not.toContain(foreign.deviceId);
  });

  /**
   * The WS-relevant fact, asserted where it actually lives: the upgrade path
   * shares this one function, so a row from another product now fails auth
   * before `conn.hello` is ever read.
   */
  it('fails at authenticateBearer itself when the row disagrees with the instance', async () => {
    const tokenSigner = createHmacTokenSigner();
    const devices = new DeviceRegistry();
    devices.register({
      tenantId: TENANT_A,
      productId: OTHER_PRODUCT_ID,
      deviceId: 'device-foreign',
      deviceName: 'foreign-laptop',
      devicePublicKey: generateFakeDeviceIdentity().publicKeyBase64Url,
    });
    devices.register({
      tenantId: TENANT_A,
      productId: PRODUCT_ID,
      deviceId: 'device-local',
      deviceName: 'local-laptop',
      devicePublicKey: generateFakeDeviceIdentity().publicKeyBase64Url,
    });

    const foreignToken = await mintAccessToken(tokenSigner, {
      deviceId: 'device-foreign',
      tenantId: TENANT_A,
      productId: OTHER_PRODUCT_ID,
    });
    const localToken = await mintAccessToken(tokenSigner, {
      deviceId: 'device-local',
      tenantId: TENANT_A,
      productId: PRODUCT_ID,
    });

    const deps = { tokenSigner, devices, productId: PRODUCT_ID };

    expect(await authenticateBearer(`Bearer ${foreignToken.accessToken}`, deps)).toBeUndefined();
    expect(await authenticateBearer(`Bearer ${localToken.accessToken}`, deps)).toEqual({
      deviceId: 'device-local',
      tenantId: TENANT_A,
      productId: PRODUCT_ID,
    });
  });
});
