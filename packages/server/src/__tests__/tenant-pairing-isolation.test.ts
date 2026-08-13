import { randomBytes } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { createEnvelope, PROTOCOL_VERSION } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createByokServer, createHmacTokenSigner, type AccessTokenClaims, type ByokServer } from '../index';
import {
  generateFakeDeviceIdentity,
  pairFakeDaemon,
  send,
  startServer,
  stopServer,
  type FakeDeviceIdentity,
} from './test-support';

/**
 * S1 (I2/I5/I9 + the S1.3 negative matrix): the tenant boundary a device gets
 * at pairing time, and the domain-separated nonce signature that boundary
 * ships with.
 *
 * The two live in one suite on purpose — they are one breaking batch (sprint
 * S1.5). A tenant-bound device row whose renewal credential is a
 * cross-protocol-replayable signature is not actually bound to anything.
 */

const PRODUCT_ID = 'acme';
const OTHER_PRODUCT_ID = 'other-product';
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

/**
 * A {@link TokenSigner} the test can mint arbitrary claims through — the only
 * way to construct a token the server would never issue itself (one naming a
 * tenant that does not own the device, or a product the row disagrees with)
 * without weakening any production path to allow it.
 */
function createForgingTokenSigner() {
  const signer = createHmacTokenSigner(randomBytes(32));
  return {
    signer,
    forge: (claims: AccessTokenClaims) => signer.sign(claims, 60 * 60),
  };
}

async function requestChallenge(baseUrl: string, deviceId: string): Promise<{ status: number; nonce?: string }> {
  const res = await fetch(`${baseUrl}/byok/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  if (!res.ok) return { status: res.status };
  const { nonce } = (await res.json()) as { nonce: string };
  return { status: res.status, nonce };
}

async function requestToken(
  baseUrl: string,
  deviceId: string,
  nonce: string,
  signature: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/byok/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, nonce, signature }),
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Probe a bearer-authed route. `POST /byok/messages` with an empty batch is
 * the cheapest one that answers immediately either way — `GET /byok/events`
 * would hold the poll open for the full hold window on success.
 */
async function probeAuthedRoute(baseUrl: string, accessToken: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/byok/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  });
  return { status: res.status, body: await res.json() };
}

/** Resolve once the WS upgrade is refused (HTTP status) or the socket errors out. */
async function expectUpgradeRejected(port: number, accessToken: string): Promise<'error' | number> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/byok/ws`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  try {
    return await new Promise<'error' | number>((resolve) => {
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? -1));
      ws.once('error', () => resolve('error'));
      ws.once('open', () => resolve(-1)); // upgrade succeeded — the assertion below fails loudly
    });
  } finally {
    ws.terminate();
  }
}

/**
 * Upgrade (which must succeed — the token is genuine), then send `conn.hello`
 * and report how the server answered: the close code, or `'ack'` if the
 * connection was actually registered.
 */
async function helloOutcome(
  port: number,
  opts: { deviceId: string; accessToken: string; productId: string },
): Promise<{ closeCode?: number; acked: boolean }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/byok/ws`, {
    headers: { authorization: `Bearer ${opts.accessToken}` },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const outcome = new Promise<{ closeCode?: number; acked: boolean }>((resolve) => {
      ws.once('close', (code) => resolve({ closeCode: code, acked: false }));
      ws.once('message', () => resolve({ acked: true }));
    });
    send(
      ws,
      createEnvelope('conn.hello', {
        protocolVersions: [PROTOCOL_VERSION],
        capabilities: [],
        deviceId: opts.deviceId,
        productId: opts.productId,
      }),
    );
    return await outcome;
  } finally {
    ws.terminate();
  }
}

describe('S1: tenant/product isolation at pairing, token, and hello (I2/I5/I9)', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    if (server) await stopServer(server);
    byok?.stop();
    server = undefined;
    byok = undefined;
  });

  async function startWith(opts: { productId?: string; tokenSigner?: ByokServerFixtureSigner } = {}) {
    byok = createByokServer({ productId: opts.productId ?? PRODUCT_ID, tokenSigner: opts.tokenSigner });
    const started = await startServer(byok);
    server = started.server;
    return { byok, ...started };
  }

  type ByokServerFixtureSigner = Parameters<typeof createByokServer>[0]['tokenSigner'];

  /** Pair a device through a code minted for `claims`. */
  async function pairInto(
    baseUrl: string,
    instance: ByokServer,
    claims: { tenantId: string; productId: string },
  ): Promise<{ deviceId: string; accessToken: string; identity: FakeDeviceIdentity }> {
    const { code } = instance.pairing.createPairingCode(claims);
    return pairFakeDaemon(baseUrl, code, { identity: generateFakeDeviceIdentity() });
  }

  // -----------------------------------------------------------------------
  // I2: the code's claims decide where the device lands — and nothing else.
  // -----------------------------------------------------------------------

  it("lands a redeemed device in the code's tenant, and in no other", async () => {
    const started = await startWith();
    const device = await pairInto(started.baseUrl, started.byok, { tenantId: TENANT_A, productId: PRODUCT_ID });

    // Revocation is the observable proof of ownership: tenant B cannot touch
    // a device it does not own, so this is a no-op and the device keeps working.
    started.byok.devices.revoke(TENANT_B, device.deviceId);
    expect((await probeAuthedRoute(started.baseUrl, device.accessToken)).status).toBe(200);

    // ...and the owning tenant can, which is what proves the row is under A.
    started.byok.devices.revoke(TENANT_A, device.deviceId);
    expect((await probeAuthedRoute(started.baseUrl, device.accessToken)).status).toBe(401);
  });

  it('keeps two devices paired under different tenants independent', async () => {
    const started = await startWith();
    const a = await pairInto(started.baseUrl, started.byok, { tenantId: TENANT_A, productId: PRODUCT_ID });
    const b = await pairInto(started.baseUrl, started.byok, { tenantId: TENANT_B, productId: PRODUCT_ID });

    started.byok.devices.revoke(TENANT_A, a.deviceId);

    expect((await probeAuthedRoute(started.baseUrl, a.accessToken)).status).toBe(401);
    expect((await probeAuthedRoute(started.baseUrl, b.accessToken)).status).toBe(200);
  });

  // -----------------------------------------------------------------------
  // I5: the registry row is the authority; token claims are lookup keys.
  // -----------------------------------------------------------------------

  it('rejects a token whose tenant does not own the device', async () => {
    const forging = createForgingTokenSigner();
    const started = await startWith({ tokenSigner: forging.signer });
    const device = await pairInto(started.baseUrl, started.byok, { tenantId: TENANT_A, productId: PRODUCT_ID });

    const crossTenant = await forging.forge({
      deviceId: device.deviceId,
      tenantId: TENANT_B,
      productId: PRODUCT_ID,
    });

    expect((await probeAuthedRoute(started.baseUrl, crossTenant)).status).toBe(401);
    expect(await expectUpgradeRejected(started.port, crossTenant)).not.toBe(-1);
    // The genuine token for the same device still works — the rejection is
    // about the forged tenant, not about the device being unusable.
    expect((await probeAuthedRoute(started.baseUrl, device.accessToken)).status).toBe(200);
  });

  it('rejects a token whose product disagrees with the device row', async () => {
    const forging = createForgingTokenSigner();
    const started = await startWith({ tokenSigner: forging.signer });
    const device = await pairInto(started.baseUrl, started.byok, { tenantId: TENANT_A, productId: PRODUCT_ID });

    const wrongProduct = await forging.forge({
      deviceId: device.deviceId,
      tenantId: TENANT_A,
      productId: OTHER_PRODUCT_ID,
    });

    expect((await probeAuthedRoute(started.baseUrl, wrongProduct)).status).toBe(401);
    expect(await expectUpgradeRejected(started.port, wrongProduct)).not.toBe(-1);
  });

  it('answers unknown, wrong-tenant, and revoked identically — no existence oracle', async () => {
    const forging = createForgingTokenSigner();
    const started = await startWith({ tokenSigner: forging.signer });
    const device = await pairInto(started.baseUrl, started.byok, { tenantId: TENANT_A, productId: PRODUCT_ID });
    const revoked = await pairInto(started.baseUrl, started.byok, { tenantId: TENANT_A, productId: PRODUCT_ID });
    started.byok.devices.revoke(TENANT_A, revoked.deviceId);

    const unknownDevice = await forging.forge({
      deviceId: 'device-that-never-existed',
      tenantId: TENANT_A,
      productId: PRODUCT_ID,
    });
    const unknownTenant = await forging.forge({
      deviceId: device.deviceId,
      tenantId: 'tenant-that-never-existed',
      productId: PRODUCT_ID,
    });
    const wrongTenant = await forging.forge({
      deviceId: device.deviceId,
      tenantId: TENANT_B,
      productId: PRODUCT_ID,
    });

    const answers = await Promise.all(
      [unknownDevice, unknownTenant, wrongTenant, revoked.accessToken].map((token) =>
        probeAuthedRoute(started.baseUrl, token),
      ),
    );

    for (const answer of answers) {
      expect(answer).toEqual(answers[0]);
      expect(answer.status).toBe(401);
      // Nothing in the response may hint at which tenant/device does or
      // doesn't exist.
      const serialized = JSON.stringify(answer.body);
      expect(serialized).not.toContain(TENANT_A);
      expect(serialized).not.toContain(TENANT_B);
      expect(serialized).not.toContain(device.deviceId);
    }
  });

  it('answers an unknown and a revoked device identically on the pre-tenant challenge route', async () => {
    const started = await startWith();
    const device = await pairInto(started.baseUrl, started.byok, { tenantId: TENANT_A, productId: PRODUCT_ID });
    started.byok.devices.revoke(TENANT_A, device.deviceId);

    const forRevoked = await requestChallenge(started.baseUrl, device.deviceId);
    const forUnknown = await requestChallenge(started.baseUrl, 'device-that-never-existed');

    expect(forRevoked).toEqual(forUnknown);
    expect(forRevoked.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // I9: `conn.hello.productId` must match the DEVICE ROW, not just the
  // instance config.
  // -----------------------------------------------------------------------

  it('refuses the upgrade for a device row outside the instance product, before any hello', async () => {
    // The instance serves PRODUCT_ID, but this device was paired into a code
    // minted for OTHER_PRODUCT_ID. The enforcement point moved (slice
    // longpoll-auth-parity): `authenticateBearer` (`auth.ts`) now compares the
    // row against the product this instance serves, so such a row is refused
    // at the upgrade and never gets to announce anything — the hello gate's
    // own row check (`ws-server.ts:121`) is thereby unreachable and kept as
    // belt-and-braces under this slice's zero-diff freeze on that file.
    const started = await startWith();
    const device = await pairInto(started.baseUrl, started.byok, {
      tenantId: TENANT_A,
      productId: OTHER_PRODUCT_ID,
    });

    // 401 rather than 101 — no hello is ever exchanged.
    expect(await expectUpgradeRejected(started.port, device.accessToken)).toBe(401);
    // Never registered: the hub knows the device (it is paired) but has no
    // connection for it.
    const machine = started.byok.machines.list().find((m) => m.deviceId === device.deviceId);
    expect(machine?.connected).toBe(false);
  });

  it('accepts a hello whose productId matches the device row', async () => {
    const started = await startWith();
    const device = await pairInto(started.baseUrl, started.byok, {
      tenantId: TENANT_A,
      productId: PRODUCT_ID,
    });

    const outcome = await helloOutcome(started.port, {
      deviceId: device.deviceId,
      accessToken: device.accessToken,
      productId: PRODUCT_ID,
    });

    expect(outcome.acked).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Revocation, across every surface a tenant-bound device has.
  // -----------------------------------------------------------------------

  it('refuses challenge, token, and connect for a revoked device', async () => {
    const started = await startWith();
    const device = await pairInto(started.baseUrl, started.byok, { tenantId: TENANT_A, productId: PRODUCT_ID });

    // Take a valid nonce + signature BEFORE revoking so the token surface
    // below exercises revocation, not a missing nonce.
    const challenge = await requestChallenge(started.baseUrl, device.deviceId);
    const signature = device.identity.signNonce(challenge.nonce!);

    started.byok.devices.revoke(TENANT_A, device.deviceId);

    expect((await requestChallenge(started.baseUrl, device.deviceId)).status).toBe(401);
    expect((await requestToken(started.baseUrl, device.deviceId, challenge.nonce!, signature)).status).toBe(401);
    expect(await expectUpgradeRejected(started.port, device.accessToken)).not.toBe(-1);
  });

  // -----------------------------------------------------------------------
  // T-006: nonce domain separation, both directions.
  // -----------------------------------------------------------------------

  it('accepts a domain-prefixed nonce signature and refuses the raw one', async () => {
    const started = await startWith();
    const device = await pairInto(started.baseUrl, started.byok, { tenantId: TENANT_A, productId: PRODUCT_ID });

    // Raw (pre-S1) signature over the bare nonce: rejected, and the nonce is
    // NOT burned by the failed attempt.
    const first = await requestChallenge(started.baseUrl, device.deviceId);
    const raw = await requestToken(
      started.baseUrl,
      device.deviceId,
      first.nonce!,
      device.identity.sign(first.nonce!),
    );
    expect(raw.status).toBe(401);

    // The same nonce, signed with the domain prefix: accepted.
    const prefixed = await requestToken(
      started.baseUrl,
      device.deviceId,
      first.nonce!,
      device.identity.signNonce(first.nonce!),
    );
    expect(prefixed.status).toBe(200);
  });

  it('mints a renewed token that still carries the device row identity', async () => {
    const started = await startWith();
    const device = await pairInto(started.baseUrl, started.byok, { tenantId: TENANT_A, productId: PRODUCT_ID });

    const challenge = await requestChallenge(started.baseUrl, device.deviceId);
    const renewed = await requestToken(
      started.baseUrl,
      device.deviceId,
      challenge.nonce!,
      device.identity.signNonce(challenge.nonce!),
    );
    expect(renewed.status).toBe(200);
    const { accessToken } = renewed.body as { accessToken: string };

    // The renewed token authenticates, and revoking through the OWNING tenant
    // kills it — i.e. it was bound to tenant A, which only the row could have
    // supplied (the renewal request carries no tenant at all).
    expect((await probeAuthedRoute(started.baseUrl, accessToken)).status).toBe(200);
    started.byok.devices.revoke(TENANT_A, device.deviceId);
    expect((await probeAuthedRoute(started.baseUrl, accessToken)).status).toBe(401);
  });
});
