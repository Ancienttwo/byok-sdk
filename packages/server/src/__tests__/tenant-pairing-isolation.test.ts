import { randomBytes } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, PROTOCOL_VERSION } from '@byok-sdk/protocol';
import { tenantId as brandTenantId } from '@byok-sdk/cloud';
import {
  createByokServer,
  createHmacTokenSigner,
  type AccessTokenClaims,
  type ByokServer,
  type TenantId,
} from '../index';
import {
  connectFakeDaemonLongPoll,
  generateFakeDeviceIdentity,
  pairFakeDaemon,
  sendOne,
  startServer,
  stopServer,
  testPairingClaims,
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
 *
 * WP3B Step 2: an embedded `createByokServer` serves exactly ONE tenant, derived
 * from its own `productId` (`stores.ts`), so a pairing code can no longer name
 * one and the enrollment's tenant is read back off the `POST /byok/pair`
 * response. A FOREIGN tenant is still nameable in one place — a forged token's
 * CLAIMS — which is what keeps the negative half of the I5 cases expressible;
 * `devices.revoke` takes only a device id now, because the façade binds its one
 * tenant itself. The cases that needed two tenants enrolled INTO one instance
 * are skipped with their own `2d gap` notes.
 */

const PRODUCT_ID = 'acme';
const OTHER_PRODUCT_ID = 'other-product';
/** A tenant this server does not serve — never the derived one, whatever `productId` is. */
const FOREIGN_TENANT: TenantId = brandTenantId('tenant-nobody-here');
/** Short enough that a successful poll answers immediately instead of holding. */
const SHORT_HOLD_MS = 200;

/**
 * A {@link TokenSigner} the test can mint arbitrary claims through — the only
 * way to construct a token the server would never issue itself (one naming a
 * tenant that does not own the device, or a product the row disagrees with)
 * without weakening any production path to allow it.
 */
function createForgingTokenSigner() {
  const signer = createHmacTokenSigner(randomBytes(32), { now: () => new Date() });
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

describe('S1: tenant/product isolation at pairing, token, and hello (I2/I5/I9)', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    if (server) await stopServer(server);
    byok?.stop();
    server = undefined;
    byok = undefined;
  });

  type ByokServerFixtureSigner = Parameters<typeof createByokServer>[0]['tokenSigner'];

  async function startWith(opts: { productId?: string; tokenSigner?: ByokServerFixtureSigner } = {}) {
    byok = createByokServer({
      productId: opts.productId ?? PRODUCT_ID,
      longPollHoldMs: SHORT_HOLD_MS,
      tokenSigner: opts.tokenSigner,
    });
    const started = await startServer(byok);
    server = started.server;
    return { byok, ...started };
  }

  /** Pair a device through a code minted for this instance's one product+tenant. */
  async function pairInto(
    baseUrl: string,
    instance: ByokServer,
    productId: string = PRODUCT_ID,
  ): Promise<{ deviceId: string; accessToken: string; identity: FakeDeviceIdentity; tenantId: TenantId }> {
    const { code } = await instance.pairing.createPairingCode(testPairingClaims(productId));
    return pairFakeDaemon(baseUrl, code, { identity: generateFakeDeviceIdentity() });
  }

  // -----------------------------------------------------------------------
  // I2: the enrollment's own tenant decides where the device lands — and
  // nothing else can reach it.
  // -----------------------------------------------------------------------

  it("lands a redeemed device in the code's tenant, and in no other", async () => {
    const started = await startWith();
    const device = await pairInto(started.baseUrl, started.byok);

    // The device is live under this instance's one tenant...
    expect((await probeAuthedRoute(started.baseUrl, device.accessToken)).status).toBe(200);

    // ...and revoking it there kills it, which is what proves the row is under
    // that tenant. (The mirror-image half — that a FOREIGN tenant's revoke is a
    // silent no-op — has no input left to state: `devices.revoke` takes only a
    // device id now, because an embedded server binds its one tenant itself.
    // "and in no other tenant" is pinned instead by the forged cross-tenant
    // token below.)
    await started.byok.devices.revoke(device.deviceId);
    expect((await probeAuthedRoute(started.baseUrl, device.accessToken)).status).toBe(401);
    expect((await started.byok.machines.list()).map((machine) => machine.deviceId)).not.toContain(device.deviceId);
  });

  // 2d gap: an embedded server has exactly one tenant, so two devices can no
  // longer be paired under DIFFERENT tenants into the same instance — the input
  // that decided it (`createPairingCode({ tenantId })`) is gone. Tenant-scoped
  // enrollment isolation is covered at the port level by
  // `packages/conformance/src/cloud/pairing.ts`, which registers under two
  // tenants against one directory.
  it.skip('keeps two devices paired under different tenants independent', () => {
    // intentionally empty — see the 2d gap note above.
  });

  // -----------------------------------------------------------------------
  // I5: the registry row is the authority; token claims are lookup keys.
  // -----------------------------------------------------------------------

  it('rejects a token whose tenant does not own the device', async () => {
    const forging = createForgingTokenSigner();
    const started = await startWith({ tokenSigner: forging.signer });
    const device = await pairInto(started.baseUrl, started.byok);

    const crossTenant = await forging.forge({
      deviceId: device.deviceId,
      tenantId: FOREIGN_TENANT,
      productId: PRODUCT_ID,
    });

    expect((await probeAuthedRoute(started.baseUrl, crossTenant)).status).toBe(401);
    // The genuine token for the same device still works — the rejection is
    // about the forged tenant, not about the device being unusable.
    expect((await probeAuthedRoute(started.baseUrl, device.accessToken)).status).toBe(200);
  });

  it('rejects a token whose product disagrees with the device row', async () => {
    const forging = createForgingTokenSigner();
    const started = await startWith({ tokenSigner: forging.signer });
    const device = await pairInto(started.baseUrl, started.byok);

    const wrongProduct = await forging.forge({
      deviceId: device.deviceId,
      tenantId: device.tenantId,
      productId: OTHER_PRODUCT_ID,
    });

    expect((await probeAuthedRoute(started.baseUrl, wrongProduct)).status).toBe(401);
  });

  it('answers unknown, wrong-tenant, and revoked identically — no existence oracle', async () => {
    const forging = createForgingTokenSigner();
    const started = await startWith({ tokenSigner: forging.signer });
    const device = await pairInto(started.baseUrl, started.byok);
    const revoked = await pairInto(started.baseUrl, started.byok);
    await started.byok.devices.revoke(revoked.deviceId);
    // §6.3: revocation DELETES the row, so "revoked" is not a fourth state
    // the listing could still expose — the device id is now byte-for-byte one
    // that was never registered.
    expect((await started.byok.machines.list()).map((machine) => machine.deviceId)).not.toContain(revoked.deviceId);

    const unknownDevice = await forging.forge({
      deviceId: 'device-that-never-existed',
      tenantId: device.tenantId,
      productId: PRODUCT_ID,
    });
    const unknownTenant = await forging.forge({
      deviceId: device.deviceId,
      tenantId: 'tenant-that-never-existed',
      productId: PRODUCT_ID,
    });
    const wrongTenant = await forging.forge({
      deviceId: device.deviceId,
      tenantId: FOREIGN_TENANT,
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
      expect(serialized).not.toContain(device.tenantId);
      expect(serialized).not.toContain(FOREIGN_TENANT);
      expect(serialized).not.toContain(device.deviceId);
    }
  });

  it('answers an unknown and a revoked device identically on the pre-tenant challenge route', async () => {
    const started = await startWith();
    const device = await pairInto(started.baseUrl, started.byok);
    await started.byok.devices.revoke(device.deviceId);
    expect((await started.byok.machines.list()).map((machine) => machine.deviceId)).not.toContain(device.deviceId);

    const forRevoked = await requestChallenge(started.baseUrl, device.deviceId);
    const forUnknown = await requestChallenge(started.baseUrl, 'device-that-never-existed');

    expect(forRevoked).toEqual(forUnknown);
    expect(forRevoked.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // I9: `conn.hello.productId` must match the DEVICE ROW, not just the
  // instance config.
  // -----------------------------------------------------------------------

  // 2d gap: a device row outside the instance's product cannot be brought into
  // existence from this surface — `createPairingCode` refuses a foreign product
  // before minting a code (see `bearer-instance-product.test.ts`), and the WS
  // upgrade this asserted on is deleted. The kernel-side check is covered by
  // `packages/cloud/src/__tests__/bearer-instance-product.test.ts`.
  it.skip('refuses the upgrade for a device row outside the instance product, before any hello', () => {
    // intentionally empty — see the 2d gap note above.
  });

  it('accepts a hello whose productId matches the device row', async () => {
    const started = await startWith();

    // `connectFakeDaemonLongPoll` publishes `conn.hello` over
    // `POST /byok/messages` and fails loudly unless the server accepted it —
    // the long-poll equivalent of the WS handshake's ack.
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

    expect((await started.byok.machines.list())).toEqual([
      expect.objectContaining({ deviceId: daemon.deviceId, connected: true }),
    ]);
  });

  it('refuses a hello whose productId disagrees with the device row', async () => {
    const started = await startWith();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

    // The same authenticated device, announcing another product: the hello gate
    // compares against the DEVICE ROW, so this is refused rather than absorbed.
    const refusedEnvelope = createEnvelope('conn.hello', {
      protocolVersions: [PROTOCOL_VERSION],
      capabilities: [],
      deviceId: daemon.deviceId,
      productId: OTHER_PRODUCT_ID,
    });
    const refused = await sendOne(daemon, refusedEnvelope);
    expect(refused).toEqual({
      status: 200,
      body: { outcomes: [{ id: refusedEnvelope.id, outcome: 'rejected', reason: 'inbound_rejected' }] },
    });
  });

  // -----------------------------------------------------------------------
  // Revocation, across every surface a tenant-bound device has.
  // -----------------------------------------------------------------------

  it('refuses challenge, token, and authed HTTP for a revoked device', async () => {
    const started = await startWith();
    const device = await pairInto(started.baseUrl, started.byok);

    // Take a valid nonce + signature BEFORE revoking so the token surface
    // below exercises revocation, not a missing nonce.
    const challenge = await requestChallenge(started.baseUrl, device.deviceId);
    const signature = device.identity.signNonce(challenge.nonce!);

    await started.byok.devices.revoke(device.deviceId);

    // The registration is gone, not flagged — nothing is left to list.
    expect((await started.byok.machines.list()).map((machine) => machine.deviceId)).not.toContain(device.deviceId);

    expect((await requestChallenge(started.baseUrl, device.deviceId)).status).toBe(401);
    expect((await requestToken(started.baseUrl, device.deviceId, challenge.nonce!, signature)).status).toBe(401);
    expect((await probeAuthedRoute(started.baseUrl, device.accessToken)).status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // T-006: nonce domain separation, both directions.
  // -----------------------------------------------------------------------

  it('accepts a domain-prefixed nonce signature and refuses the raw one', async () => {
    const started = await startWith();
    const device = await pairInto(started.baseUrl, started.byok);

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
    const device = await pairInto(started.baseUrl, started.byok);

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
    // kills it — i.e. it was bound to that tenant, which only the row could have
    // supplied (the renewal request carries no tenant at all).
    expect((await probeAuthedRoute(started.baseUrl, accessToken)).status).toBe(200);
    await started.byok.devices.revoke(device.deviceId);
    expect((await probeAuthedRoute(started.baseUrl, accessToken)).status).toBe(401);
  });
});
