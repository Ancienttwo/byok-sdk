/**
 * The S1 auth matrix, ported to the hosted surface.
 *
 * Every negative here exists because it was a real decision on the reference
 * server: claims are lookup keys, a pairing code redeems once, a nonce is
 * single-use and domain-separated, and unknown/revoked answer identically. If
 * any one of them drifted, a hosted deployment would be weaker than the
 * self-hosted one against the same attack — which is exactly the failure this
 * slice exists to make impossible.
 */
import { createMutableClock, tenantId, type Clock } from '@byok-sdk/core';
import type { ChallengeResponse, TokenResponse } from '@byok-sdk/protocol';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthPlane } from '../auth/plane';
import { ACCESS_TOKEN_TTL_SECONDS, createHmacTokenSigner } from '../auth/tokens';
import { tokenHandler } from '../handlers/auth';
import { NONCE_TTL_MS } from '../stores/in-memory/nonces';
import {
  CLOUD_ORIGIN,
  PRODUCT_ID,
  TENANT_A,
  TENANT_B,
  createDeviceKeys,
  createHarness,
  type CloudHarness,
} from './support/harness';

async function challenge(harness: CloudHarness, deviceId: string): Promise<{ status: number; nonce?: string }> {
  const response = await harness.request('/byok/challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  if (response.status !== 200) return { status: response.status };
  const body = (await response.json()) as ChallengeResponse;
  return { status: response.status, nonce: body.nonce };
}

function token(harness: CloudHarness, body: unknown): Promise<Response> {
  return harness.request('/byok/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('pairing (§6.1)', () => {
  let harness: CloudHarness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('takes the device tenant and product from the redeemed code, never from the request', async () => {
    const device = await harness.pairDevice(TENANT_A);

    const row = await harness.stores.devices.get(TENANT_A, device.deviceId);
    expect(row?.tenantId).toBe(TENANT_A);
    expect(row?.productId).toBe(PRODUCT_ID);
    // The same deviceId under another tenant is not a different view of the
    // same row — it is nothing at all.
    expect(await harness.stores.devices.get(TENANT_B, device.deviceId)).toBeUndefined();
  });

  it('refuses a second redeem of the same code, and writes no second device row', async () => {
    const pairing = await harness.cloud.createPairingCode(TENANT_A, { productId: PRODUCT_ID });
    const keys = createDeviceKeys();
    const body = JSON.stringify({
      pairingCode: pairing.code,
      deviceName: 'twice',
      devicePublicKey: keys.publicKeyBase64Url,
    });
    const headers = { 'content-type': 'application/json' };

    const first = await harness.request('/byok/pair', { method: 'POST', headers, body });
    const second = await harness.request('/byok/pair', { method: 'POST', headers, body });

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(await harness.cloud.listDevices(TENANT_A)).toHaveLength(1);
  });

  it('answers unknown, expired, and already-used codes identically — no oracle', async () => {
    const clock = createMutableClock();
    const expiring = createHarness({ clock });
    const pairing = await expiring.cloud.createPairingCode(TENANT_A, { productId: PRODUCT_ID });
    const used = await expiring.cloud.createPairingCode(TENANT_A, { productId: PRODUCT_ID });
    await expiring.stores.pairingCodes.redeem(used.code);

    clock.advance(11 * 60 * 1000);

    const answers = await Promise.all(
      [pairing.code, used.code, 'NEVERMINTED'].map(async (code) =>
        expiring.json('/byok/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pairingCode: code, deviceName: 'd', devicePublicKey: 'x' }),
        }),
      ),
    );

    expect(answers.map((answer) => answer.status)).toEqual([401, 401, 401]);
    expect(new Set(answers.map((answer) => JSON.stringify(answer.body))).size).toBe(1);
    expect(answers[0]?.body).toEqual({ error: 'invalid pairing code' });
  });

  it('400s a request missing a required field, without consuming the code', async () => {
    const pairing = await harness.cloud.createPairingCode(TENANT_A, { productId: PRODUCT_ID });
    const bad = await harness.json('/byok/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: pairing.code, deviceName: 'no key' }),
    });
    expect(bad.status).toBe(400);
    expect(await harness.stores.pairingCodes.redeem(pairing.code)).toBeDefined();
  });
});

describe('token renewal (§6.2)', () => {
  let harness: CloudHarness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('mints a fresh token for a correctly domain-separated signature', async () => {
    const device = await harness.pairDevice(TENANT_A);
    const { nonce } = await challenge(harness, device.deviceId);
    expect(nonce).toBeDefined();

    const response = await token(harness, {
      deviceId: device.deviceId,
      nonce,
      signature: device.keys.signNonce(nonce ?? ''),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as TokenResponse;
    expect(body.accessToken).toBeTypeOf('string');
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('rejects a raw, undomained signature over the bare nonce', async () => {
    const device = await harness.pairDevice(TENANT_A);
    const { nonce } = await challenge(harness, device.deviceId);

    const response = await token(harness, {
      deviceId: device.deviceId,
      nonce,
      signature: device.keys.signRawNonce(nonce ?? ''),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid signature' });
  });

  it('does not burn the nonce on a failed signature check', async () => {
    const device = await harness.pairDevice(TENANT_A);
    const { nonce } = await challenge(harness, device.deviceId);

    const failed = await token(harness, {
      deviceId: device.deviceId,
      nonce,
      signature: device.keys.signRawNonce(nonce ?? ''),
    });
    expect(failed.status).toBe(401);

    // The legitimate device's own nonce still works: an attacker cannot burn
    // it by attempting a bad signature against it.
    const succeeded = await token(harness, {
      deviceId: device.deviceId,
      nonce,
      signature: device.keys.signNonce(nonce ?? ''),
    });
    expect(succeeded.status).toBe(200);
  });

  it('burns the nonce on success, so a replay of the whole triple fails', async () => {
    const device = await harness.pairDevice(TENANT_A);
    const { nonce } = await challenge(harness, device.deviceId);
    const payload = {
      deviceId: device.deviceId,
      nonce,
      signature: device.keys.signNonce(nonce ?? ''),
    };

    expect((await token(harness, payload)).status).toBe(200);
    const replay = await token(harness, payload);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: 'invalid, expired, or already-used nonce' });
  });

  it('allows exactly one concurrent valid request to mint from a nonce', async () => {
    let minted = 0;
    let consumed = false;
    const device = {
      tenantId: TENANT_A,
      productId: PRODUCT_ID,
      deviceId: 'dev_atomic-nonce',
      deviceName: 'atomic-nonce',
      devicePublicKey: 'test-key',
      proofKeyId: 'identity',
      proofKeyEpoch: 0,
      revoked: false,
    };
    const auth: AuthPlane = {
      createPairingCode: async () => {
        throw new Error('not used by token route test');
      },
      redeemAndRegister: async () => {
        throw new Error('not used by token route test');
      },
      resolveDevice: async () => device,
      issueNonce: async () => {
        throw new Error('not used by token route test');
      },
      verifySignature: async () => true,
      consumeNonceIfValid: async () => {
        if (consumed) return false;
        consumed = true;
        return true;
      },
      mintAccessToken: async () => ({ accessToken: `token-${++minted}`, expiresAt: new Date().toISOString() }),
    };
    const app = new Hono();
    app.post('/byok/token', tokenHandler({ auth }));
    const request = () =>
      app.fetch(
        new Request(`${CLOUD_ORIGIN}/byok/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deviceId: device.deviceId, nonce: 'same-nonce', signature: 'valid' }),
        }),
      );

    const responses = await Promise.all([request(), request()]);

    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 401)).toHaveLength(1);
    expect(minted).toBe(1);
  });

  it('expires a nonce after its TTL', async () => {
    const clock = createMutableClock();
    const expiring = createHarness({ clock });
    const device = await expiring.pairDevice(TENANT_A);
    const { nonce } = await challenge(expiring, device.deviceId);

    clock.advance(NONCE_TTL_MS + 1);

    const response = await token(expiring, {
      deviceId: device.deviceId,
      nonce,
      signature: device.keys.signNonce(nonce ?? ''),
    });
    expect(response.status).toBe(401);
  });

  it('refuses a nonce issued to a different device', async () => {
    const mine = await harness.pairDevice(TENANT_A);
    const other = await harness.pairDevice(TENANT_A);
    const { nonce } = await challenge(harness, other.deviceId);

    const response = await token(harness, {
      deviceId: mine.deviceId,
      nonce,
      signature: mine.keys.signNonce(nonce ?? ''),
    });
    expect(response.status).toBe(401);
  });

  it('answers an unknown device and a revoked device identically on both pre-tenant routes', async () => {
    const revoked = await harness.pairDevice(TENANT_A);
    await harness.cloud.revokeDevice(TENANT_A, revoked.deviceId);

    const revokedChallenge = await harness.json('/byok/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: revoked.deviceId }),
    });
    const unknownChallenge = await harness.json('/byok/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev_does-not-exist' }),
    });

    expect(revokedChallenge).toEqual(unknownChallenge);
    expect(revokedChallenge.status).toBe(401);
    expect(revokedChallenge.body).toEqual({ error: 'unknown or revoked device' });

    const revokedToken = await token(harness, { deviceId: revoked.deviceId, nonce: 'n', signature: 's' });
    const unknownToken = await token(harness, { deviceId: 'dev_does-not-exist', nonce: 'n', signature: 's' });
    expect(revokedToken.status).toBe(unknownToken.status);
    expect(await revokedToken.json()).toEqual(await unknownToken.json());
  });
});

describe('bearer authentication', () => {
  it('rejects a revoked device on a device-class route, even with a still-unexpired token', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);

    expect((await harness.request('/byok/events', { headers: device.authorization })).status).toBe(200);
    await harness.cloud.revokeDevice(TENANT_A, device.deviceId);

    const response = await harness.json('/byok/events', { headers: device.authorization });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
  });

  it('rejects an expired token', async () => {
    const clock = createMutableClock();
    const harness = createHarness({ clock });
    const device = await harness.pairDevice(TENANT_A);

    clock.advance((ACCESS_TOKEN_TTL_SECONDS + 1) * 1000);

    expect((await harness.request('/byok/events', { headers: device.authorization })).status).toBe(401);
  });

  it('rejects a token forged under a different signing secret', async () => {
    const harness = createHarness();
    const foreign = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const impostor = await foreign.pairDevice(TENANT_A);

    // A structurally perfect token, signed by a deployment this one never
    // shared a secret with, naming a device this one does know.
    expect(impostor.accessToken).not.toBe(device.accessToken);
    const response = await harness.request('/byok/events', {
      headers: { authorization: `Bearer ${impostor.accessToken}` },
    });
    expect(response.status).toBe(401);
  });

  it('rejects a missing and a malformed authorization header identically', async () => {
    const harness = createHarness();
    const none = await harness.json('/byok/events');
    const malformed = await harness.json('/byok/events', { headers: { authorization: 'Token abc' } });
    const empty = await harness.json('/byok/events', { headers: { authorization: 'Bearer ' } });

    expect(none).toEqual(malformed);
    expect(none).toEqual(empty);
    expect(none.status).toBe(401);
  });

  it('refuses a validly signed token whose tenant claim core would not mint', async () => {
    const clock: Clock = { now: () => new Date() };
    const signer = createHmacTokenSigner(new Uint8Array(32).fill(7), clock);
    const harness = createHarness({ tokenSigner: signer, clock });
    const device = await harness.pairDevice(TENANT_A);

    // Signed by this deployment's own key, naming a device it really has —
    // and a tenant string core refuses to mint (leading/trailing whitespace).
    expect(() => tenantId(` ${TENANT_A} `)).toThrow();
    const forged = await signer.sign(
      { deviceId: device.deviceId, tenantId: ` ${TENANT_A} `, productId: PRODUCT_ID },
      60,
    );

    const response = await harness.json('/byok/events', { headers: { authorization: `Bearer ${forged}` } });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
  });
});
