import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createByokServer } from '../index';
import { generateFakeDeviceIdentity, pairFakeDaemon, startServer, stopServer } from './test-support';

const PRODUCT_ID = 'acme';

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
): Promise<{ status: number; accessToken?: string; expiresAt?: string }> {
  const res = await fetch(`${baseUrl}/byok/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, nonce, signature }),
  });
  if (!res.ok) return { status: res.status };
  const body = (await res.json()) as { accessToken: string; expiresAt: string };
  return { status: res.status, ...body };
}

describe('Auth v2: challenge/token renewal + revocation (§6)', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server) await stopServer(server);
    server = undefined;
    ws = undefined;
    vi.useRealTimers();
  });

  it('challenge -> sign -> token happy path mints a fresh access token', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const identity = generateFakeDeviceIdentity();
    const { deviceId } = await pairFakeDaemon(started.baseUrl, code, { identity });

    const challenge = await requestChallenge(started.baseUrl, deviceId);
    expect(challenge.status).toBe(200);
    const nonce = challenge.nonce!;

    const signature = identity.sign(nonce);
    const token = await requestToken(started.baseUrl, deviceId, nonce, signature);
    expect(token.status).toBe(200);
    expect(token.accessToken).toBeTruthy();
    expect(new Date(token.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects a token request with an invalid signature (wrong key)', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const identity = generateFakeDeviceIdentity();
    const impostor = generateFakeDeviceIdentity();
    const { deviceId } = await pairFakeDaemon(started.baseUrl, code, { identity });

    const { nonce } = await requestChallenge(started.baseUrl, deviceId);
    const wrongSignature = impostor.sign(nonce!); // signed with a different private key
    const token = await requestToken(started.baseUrl, deviceId, nonce!, wrongSignature);
    expect(token.status).toBe(401);
  });

  it('rejects a replayed nonce (single-use)', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const identity = generateFakeDeviceIdentity();
    const { deviceId } = await pairFakeDaemon(started.baseUrl, code, { identity });

    const { nonce } = await requestChallenge(started.baseUrl, deviceId);
    const signature = identity.sign(nonce!);

    const first = await requestToken(started.baseUrl, deviceId, nonce!, signature);
    expect(first.status).toBe(200);

    const replay = await requestToken(started.baseUrl, deviceId, nonce!, signature);
    expect(replay.status).toBe(401);
  });

  it('rejects an expired nonce (~5min TTL)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const identity = generateFakeDeviceIdentity();
    const { deviceId } = await pairFakeDaemon(started.baseUrl, code, { identity });

    const { nonce } = await requestChallenge(started.baseUrl, deviceId);

    vi.setSystemTime(new Date('2026-01-01T00:06:00.000Z')); // +6min, past the ~5min TTL

    const signature = identity.sign(nonce!);
    const token = await requestToken(started.baseUrl, deviceId, nonce!, signature);
    expect(token.status).toBe(401);
  });

  it('revoking a device 401s its next challenge, token, WS, and authed-HTTP calls', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const identity = generateFakeDeviceIdentity();
    const { deviceId, accessToken } = await pairFakeDaemon(started.baseUrl, code, { identity });

    // Get a valid nonce+signature BEFORE revoking, so the token-surface
    // check below exercises revocation specifically, not "missing nonce".
    const { nonce } = await requestChallenge(started.baseUrl, deviceId);
    const signature = identity.sign(nonce!);

    byok.devices.revoke(deviceId);

    // Surface 1: /byok/challenge
    const challengeAfterRevoke = await requestChallenge(started.baseUrl, deviceId);
    expect(challengeAfterRevoke.status).toBe(401);

    // Surface 2: /byok/token (valid nonce + signature, but device is revoked)
    const tokenAfterRevoke = await requestToken(started.baseUrl, deviceId, nonce!, signature);
    expect(tokenAfterRevoke.status).toBe(401);

    // Surface 3: WSS upgrade, using the (still otherwise-valid) pre-revocation access token
    const badWs = new WebSocket(`ws://127.0.0.1:${started.port}/byok/ws`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    ws = badWs;
    const closeOrError = await new Promise<'error' | number>((resolve) => {
      badWs.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? -1));
      badWs.once('error', () => resolve('error'));
    });
    expect(closeOrError === 401 || closeOrError === 'error').toBe(true);

    // Surface 4: authed HTTP (events long-poll), same pre-revocation access token
    const eventsRes = await fetch(`${started.baseUrl}/byok/events?cursor=0`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(eventsRes.status).toBe(401);
  });
});
