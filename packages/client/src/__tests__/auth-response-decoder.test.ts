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
      expect(error).toMatchObject({
        name: 'AuthResponseInvalidError',
        route: 'challenge',
        cause: { name: 'ZodError', issues: [expect.objectContaining({ path: ['nonce'] })] },
      });
      expect(server.httpRequests.filter((request) => request.pathname === '/byok/token')).toHaveLength(tokenRequestsBefore);
      expect(auth.isRevoked()).toBe(false);
      expect(await store.credentials.read()).toEqual(before);
    } finally {
      await auth.stop();
    }
  });

  it.each([
    ['a missing accessToken', { expiresAt: '2030-01-01T00:00:00.000Z' }, ['accessToken']],
    ['a missing expiresAt', { accessToken: 'fresh-token' }, ['expiresAt']],
    ['an expiresAt with no offset', { accessToken: 'fresh-token', expiresAt: '2030-01-01T00:00:00' }, ['expiresAt']],
    ['an expiresAt that is not an ISO timestamp', { accessToken: 'fresh-token', expiresAt: 'Tue, 01 Jan 2030 00:00:00 GMT' }, ['expiresAt']],
  ])('refuses a token response with %s and keeps the prior credential', async (_case, body, issuePath) => {
    const { auth, store, before } = await pairedWithResponse('/byok/token', body);
    try {
      const error = await auth.handleUnauthorized().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthResponseInvalidError);
      expect(error).toMatchObject({
        name: 'AuthResponseInvalidError',
        route: 'token',
        cause: { name: 'ZodError', issues: [expect.objectContaining({ path: issuePath })] },
      });
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
      expect((error as AuthResponseInvalidError).cause).toBeInstanceOf(SyntaxError);
      expect(server.httpRequests.filter((request) => request.pathname === '/byok/token')).toHaveLength(tokenRequestsBefore);
      expect(auth.isRevoked()).toBe(false);
      expect(await store.credentials.read()).toEqual(before);
    } finally {
      await auth.stop();
    }
  });

  it.each([
    ['a truncated', '{"accessToken":"fresh-token","expiresAt":"2030-'],
    ['a non-JSON', 'fresh-token'],
  ])('refuses %s token body as AuthResponseInvalidError and keeps the prior credential', async (_case, raw) => {
    const { auth, store, before } = await pairedWithRawResponse('/byok/token', raw);
    try {
      const error = await auth.handleUnauthorized().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthResponseInvalidError);
      expect(error).toMatchObject({ name: 'AuthResponseInvalidError', route: 'token' });
      expect((error as AuthResponseInvalidError).cause).toBeInstanceOf(SyntaxError);
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

  it('accepts a token expiresAt with a numeric offset', async () => {
    // An hour out keeps the proactive renewal timer far from this test.
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString().replace('Z', '+00:00');
    const { auth, store } = await pairedWithResponse('/byok/token', { accessToken: 'fresh-token', expiresAt });
    try {
      await expect(auth.handleUnauthorized()).resolves.toBe('fresh-token');
      expect(await store.credentials.read()).toMatchObject({ accessToken: 'fresh-token', expiresAt });
    } finally {
      await auth.stop();
    }
  });
});
