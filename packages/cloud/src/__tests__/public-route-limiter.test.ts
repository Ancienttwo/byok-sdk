import { createInProcessMailboxWake } from '@byok-sdk/cloud';
/**
 * `ByokCloudOptions.publicRouteLimiter` — an admission hook in front of the
 * three unauthenticated auth routes. These tests pin that a refusal happens
 * BEFORE the handler and before any store, that the default is unchanged, and
 * that a limiter which fails does not fail open.
 */
import { createInMemoryCoreStores, createMutableClock } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { createHmacTokenSigner } from '../auth/tokens';
import { fullCapabilityDeclaration } from '../capabilities';
import { createByokCloud, type LimitedPublicRoute, type PublicRouteLimiter } from '../cloud';
import { createWebCrypto } from '../crypto/web-crypto';
import { createInMemoryBlobBytes } from '../stores/in-memory/blobs';
import { createInMemoryCloudStores } from '../stores/in-memory/index';
import type { CloudStores } from '../stores/ports';
import { CLOUD_ORIGIN, TENANT_A, createHarness } from './support/harness';

const PUBLIC_ROUTES = ['/byok/pair', '/byok/challenge', '/byok/token'] as const;

/** Every method call on any store port, counted — a limited request must leave this at zero. */
function countingStores(stores: CloudStores, calls: string[]): CloudStores {
  const wrapped: Record<string, unknown> = {};
  for (const [name, port] of Object.entries(stores)) {
    if (port === null || typeof port !== 'object') {
      wrapped[name] = port;
      continue;
    }
    wrapped[name] = new Proxy(port, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(`${name}.${String(property)}`);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }
  return wrapped as unknown as CloudStores;
}

function composeCloud(publicRouteLimiter: PublicRouteLimiter | undefined, calls: string[]) {
  const clock = createMutableClock();
  const crypto = createWebCrypto();
  const objectBytes = createInMemoryBlobBytes(clock, crypto);
  const core = createInMemoryCoreStores({ clock, objectBytes }).stores;
  const composition = createInMemoryCloudStores(clock, crypto, core.objects, core.mailbox, objectBytes);
  return createByokCloud({
    proofReceiptRetention: { authority: composition.proofReceiptAuthority },
        mailboxWake: createInProcessMailboxWake(),
    core,
    cloud: countingStores(composition.stores, calls),
    blobContentProxy: composition.blobContentProxy,
    crypto,
    tokenSigner: createHmacTokenSigner(globalThis.crypto.getRandomValues(new Uint8Array(32)), clock),
    clock,
    capabilities: fullCapabilityDeclaration(),
    ...(publicRouteLimiter === undefined ? {} : { publicRouteLimiter }),
  });
}

function post(path: string, body: unknown): Request {
  return new Request(`${CLOUD_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('publicRouteLimiter', () => {
  it('a deny-all limiter answers 429 on all three routes without touching any store', async () => {
    const calls: string[] = [];
    const seen: LimitedPublicRoute[] = [];
    const cloud = composeCloud((route) => {
      seen.push(route);
      return false;
    }, calls);

    for (const path of PUBLIC_ROUTES) {
      // Well-formed bodies: with no limiter these would reach the store.
      const response = await cloud.fetch(
        post(path, { pairingCode: 'ABCD2345', deviceName: 'd', devicePublicKey: 'k', deviceId: 'dev', nonce: 'n', signature: 's' }),
      );
      expect(response.status, path).toBe(429);
      expect(await response.json(), path).toEqual({ error: 'rate limit exceeded' });
    }
    expect(seen).toEqual(PUBLIC_ROUTES.map((path) => ({ method: 'POST', path })));
    expect(calls).toEqual([]);
  });

  it('supports an async limiter and passes the request through', async () => {
    const calls: string[] = [];
    let seenUrl: string | undefined;
    const cloud = composeCloud(async (_route, request) => {
      seenUrl = request.url;
      await Promise.resolve();
      return false;
    }, calls);

    const response = await cloud.fetch(post('/byok/challenge', { deviceId: 'dev' }));
    expect(response.status).toBe(429);
    expect(seenUrl).toBe(`${CLOUD_ORIGIN}/byok/challenge`);
    expect(calls).toEqual([]);
  });

  it('an allow limiter reaches the handler and its stores', async () => {
    const calls: string[] = [];
    const cloud = composeCloud(() => true, calls);

    const response = await cloud.fetch(post('/byok/challenge', { deviceId: 'dev' }));
    expect(response.status).toBe(401);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('does not guard the authenticated routes or the capability document', async () => {
    const calls: string[] = [];
    const cloud = composeCloud(() => false, calls);

    expect((await cloud.fetch(new Request(`${CLOUD_ORIGIN}/byok/capabilities`))).status).toBe(200);
    // Bearer auth, not the public limiter, answers here.
    expect((await cloud.fetch(new Request(`${CLOUD_ORIGIN}/byok/events`))).status).toBe(401);
  });

  it('fails the request when the limiter throws, rather than letting it through', async () => {
    const calls: string[] = [];
    const cloud = composeCloud(() => {
      throw new Error('limiter backend down');
    }, calls);

    const response = await cloud.fetch(post('/byok/challenge', { deviceId: 'dev' }));
    expect(response.status).toBe(500);
    expect(calls).toEqual([]);
  });

  it('without a limiter the full pair -> challenge -> token flow is unchanged', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const challenge = await harness.json('/byok/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: device.deviceId }),
    });
    expect(challenge.status).toBe(200);
    const { nonce } = challenge.body as { nonce: string };
    const token = await harness.json('/byok/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: device.deviceId, nonce, signature: device.keys.signNonce(nonce) }),
    });
    expect(token.status).toBe(200);
  });

  it('createInMemoryByokCloud forwards the limiter', async () => {
    const harness = createHarness({ publicRouteLimiter: () => false });
    const response = await harness.request('/byok/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(429);
  });
});
