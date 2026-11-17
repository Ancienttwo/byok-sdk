import { createTestDeviceStore } from './fixtures/device-credentials';
/**
 * #386 decoder cutover: token renewal decodes `/byok/challenge` and
 * `/byok/token` with protocol's `ChallengeResponseSchema` /
 * `TokenResponseSchema`. A body that fails its schema is refused with
 * `AuthResponseInvalidError` through renewal's existing error path: no token
 * request is signed from a bad challenge, the prior credential stays intact,
 * and the device is not marked revoked. A body that is not JSON at all takes
 * the same path, and Hosts import the error from the package root.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthManager, AuthResponseInvalidError } from '../daemon/auth-manager';
import { AuthResponseInvalidError as PublicAuthResponseInvalidError } from '../index';
import { TestServer } from './fixtures/test-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('AuthManager decodes renewal responses with protocol schemas (#386)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  /** Pairs for real, then answers `route` with `body` (HTTP 200) while every other request reaches the server. */
  async function pairedWithResponse(route: '/byok/challenge' | '/byok/token', body: unknown) {
    return pairedWithRawResponse(route, JSON.stringify(body));
  }

  /** Pairs for real, then answers `route` with the exact `raw` bytes (HTTP 200, JSON content type). */
  async function pairedWithRawResponse(route: '/byok/challenge' | '/byok/token', raw: string) {
    const store = createTestDeviceStore(await tmpDir('byok-auth-response-decoder-'));
    const auth = new AuthManager({ serverUrl: server.url, store });
    await auth.pair('pairing-code');
    const before = await store.credentials.read();
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === route) {
        return new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input, init);
    });
    return { auth, store, before };
  }

  it.each([
    ['a missing nonce', {}],
    ['a non-string nonce', { nonce: 42 }],
  ])('refuses a challenge response with %s before any token request', async (_case, body) => {
    const { auth, store, before } = await pairedWithResponse('/byok/challenge', body);
    const tokenRequestsBefore = server.httpRequests.filter((request) => request.pathname === '/byok/token').length;
    try {
      const error = await auth.handleUnauthorized().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthResponseInvalidError);
      expect(error).toMatchObject({ name: 'AuthResponseInvalidError', route: 'challenge' });
      expect(error).not.toHaveProperty('cause');
      expect(server.httpRequests.filter((request) => request.pathname === '/byok/token')).toHaveLength(tokenRequestsBefore);
      expect(auth.isRevoked()).toBe(false);
      expect(await store.credentials.read()).toEqual(before);
    } finally {
      await auth.stop();
    }
  });

  it.each([
    ['a missing accessToken', { expiresIn: 3600 }],
    // #1114: expiresIn is the device's only lifetime authority, so the client requires it.
    ['a missing expiresIn', { accessToken: 'fresh-token' }],
    ['a non-integer expiresIn', { accessToken: 'fresh-token', expiresIn: 1.5 }],
    ['a zero expiresIn', { accessToken: 'fresh-token', expiresIn: 0 }],
    ['a negative expiresIn', { accessToken: 'fresh-token', expiresIn: -60 }],
    ['a string expiresIn', { accessToken: 'fresh-token', expiresIn: '3600' }],
  ])('refuses a token response with %s and keeps the prior credential', async (_case, body) => {
    const { auth, store, before } = await pairedWithResponse('/byok/token', body);
    try {
      const error = await auth.handleUnauthorized().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthResponseInvalidError);
      expect(error).toMatchObject({ name: 'AuthResponseInvalidError', route: 'token' });
      expect(error).not.toHaveProperty('cause');
      expect(auth.isRevoked()).toBe(false);
      expect(await store.credentials.read()).toEqual(before);
    } finally {
      await auth.stop();
    }
  });

  it.each([
    ['a truncated', '{"nonce":"abc'],
    ['an empty', ''],
    ['a non-JSON', '<html>gateway</html>'],
  ])('refuses %s challenge body as AuthResponseInvalidError before any token request', async (_case, raw) => {
    const { auth, store, before } = await pairedWithRawResponse('/byok/challenge', raw);
    const tokenRequestsBefore = server.httpRequests.filter((request) => request.pathname === '/byok/token').length;
    try {
      const error = await auth.handleUnauthorized().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthResponseInvalidError);
      expect(error).toMatchObject({ name: 'AuthResponseInvalidError', route: 'challenge' });
      expect((error as AuthResponseInvalidError).cause).toBeUndefined();
      expect(server.httpRequests.filter((request) => request.pathname === '/byok/token')).toHaveLength(tokenRequestsBefore);
      expect(auth.isRevoked()).toBe(false);
      expect(await store.credentials.read()).toEqual(before);
    } finally {
      await auth.stop();
    }
  });

  it.each([
    ['a truncated', '{"accessToken":"fresh-token","expiresIn":36'],
    ['a non-JSON', 'fresh-token'],
  ])('refuses %s token body as AuthResponseInvalidError and keeps the prior credential', async (_case, raw) => {
    const { auth, store, before } = await pairedWithRawResponse('/byok/token', raw);
    try {
      const error = await auth.handleUnauthorized().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthResponseInvalidError);
      expect(error).toMatchObject({ name: 'AuthResponseInvalidError', route: 'token' });
      expect((error as AuthResponseInvalidError).cause).toBeUndefined();
      expect(auth.isRevoked()).toBe(false);
      expect(await store.credentials.read()).toEqual(before);
    } finally {
      await auth.stop();
    }
  });

  it('throws the class Hosts import from the package root', async () => {
    const { auth } = await pairedWithRawResponse('/byok/token', '{');
    try {
      const error = await auth.handleUnauthorized().catch((caught: unknown) => caught);
      expect(PublicAuthResponseInvalidError).toBe(AuthResponseInvalidError);
      expect(error).toBeInstanceOf(PublicAuthResponseInvalidError);
    } finally {
      await auth.stop();
    }
  });

  it('ignores a stray expiresAt and keeps the device-local expiry from expiresIn (#1114)', async () => {
    // An hour out keeps the proactive renewal timer far from this test.
    const { auth, store, before } = await pairedWithResponse('/byok/token', { accessToken: 'fresh-token', expiresAt: 'not a timestamp', expiresIn: 3600 });
    // Date and performance stand still unless advanced, so the renewal's
    // receipt time is exact and its renewal floor elapses on the same clock.
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    const tokenRequests = () => vi.mocked(globalThis.fetch).mock.calls
      .filter(([input]) => new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url).pathname === '/byok/token').length;
    try {
      await expect(auth.handleUnauthorized()).resolves.toBe('fresh-token');
      // The token lives only in memory (#2045): the stored record is untouched.
      expect(await store.credentials.read()).toEqual(before);
      const minted = tokenRequests();
      // Expiry is receipt + 3600 s, so renewal starts 60 s before it.
      vi.advanceTimersByTime(3_540_000 - 1);
      await expect(auth.getValidAccessToken()).resolves.toBe('fresh-token');
      expect(tokenRequests()).toBe(minted);
      vi.advanceTimersByTime(2);
      await expect(auth.getValidAccessToken()).resolves.toBe('fresh-token');
      expect(tokenRequests()).toBe(minted + 1);
    } finally {
      await auth.stop();
      vi.useRealTimers();
    }
  });

  it('refuses a pair response without expiresIn and stores no enrollment (#1114)', async () => {
    const store = createTestDeviceStore(await tmpDir('byok-auth-response-decoder-pair-'));
    const auth = new AuthManager({ serverUrl: server.url, store });
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/byok/pair') {
        const body = { deviceId: 'device-no-ttl', tenantId: 'tenant-no-ttl', accessToken: 'paired-token', refreshHint: '2030-01-01T00:00:00.000Z' };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input, init);
    });
    try {
      const error = await auth.pair('pairing-code').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthResponseInvalidError);
      expect(error).toMatchObject({ name: 'AuthResponseInvalidError', route: 'pair' });
      expect(error).not.toHaveProperty('cause');
      expect(auth.deviceId).toBeUndefined();
      expect(await store.credentials.read()).toBeUndefined();
      expect(await store.load()).toBeUndefined();
    } finally {
      await auth.stop();
    }
  });

  it('takes the pair token expiry from expiresIn, not refreshHint (#1114)', async () => {
    const store = createTestDeviceStore(await tmpDir('byok-auth-response-decoder-pair-ttl-'));
    const auth = new AuthManager({ serverUrl: server.url, store });
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/byok/pair') {
        // refreshHint is two hours off this device's clock; only expiresIn may set the lifetime.
        const body = {
          deviceId: 'device-relative-ttl',
          tenantId: 'tenant-relative-ttl',
          accessToken: 'paired-token',
          refreshHint: new Date(Date.now() - 7_200_000).toISOString(),
          expiresIn: 900,
        };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // The paired device exists only in this stub, so its renewal is answered here too.
      if (url.pathname === '/byok/challenge') return Response.json({ nonce: 'relative-ttl-nonce' });
      if (url.pathname === '/byok/token') return Response.json({ accessToken: 'renewed-token', expiresIn: 900 });
      return realFetch(input, init);
    });
    // Only Date is frozen, so the pair's receipt time is exact.
    vi.useFakeTimers({ toFake: ['Date'] });
    const pairedAt = Date.now();
    const tokenRequests = () => vi.mocked(globalThis.fetch).mock.calls
      .filter(([input]) => new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url).pathname === '/byok/token').length;
    try {
      const record = await auth.pair('pairing-code');
      // The token lives only in memory (#2045): the stored record carries none.
      expect(await store.credentials.read()).toEqual(record);
      // Expiry is receipt + 900 s, so renewal starts 60 s before it.
      vi.setSystemTime(pairedAt + 840_000 - 1);
      await expect(auth.getValidAccessToken()).resolves.toBe('paired-token');
      expect(tokenRequests()).toBe(0);
      vi.setSystemTime(pairedAt + 840_000 + 1);
      await expect(auth.getValidAccessToken()).resolves.toBe('renewed-token');
      expect(tokenRequests()).toBe(1);
    } finally {
      await auth.stop();
      vi.useRealTimers();
    }
  });
});
