import { createTestDeviceStore } from './fixtures/device-credentials';
/**
 * #1114: a renewal whose fresh token is already inside the renewal margin —
 * a device clock running ahead of the server, or a server TTL under the
 * margin — must not re-arm an immediate renewal. Before the fix each renewal
 * re-scheduled itself with delay 0 and every `getValidAccessToken()` call
 * renewed again, so the loop never ended and each lap rewrote the OS
 * credential entry. Renewals that a server 401 did not force are now spaced by
 * a floor that doubles across consecutive short-lived renewals.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../daemon/auth-manager';
import { TestServer } from './fixtures/test-server';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

describe('token renewal is rate-limited when the fresh token is already near expiry (#1114)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await server.close();
  });

  /**
   * Pairs against the real test server, then moves the device clock
   * `deviceClockAheadMs` ahead of the server and answers challenge/token in
   * process: the server mints tokens valid for `tokenTtlMs` by its own clock.
   */
  async function pairedWithSkewedClock(deviceClockAheadMs: number, tokenTtlMs: number) {
    const store = createTestDeviceStore(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-auth-renewal-rate-')));
    const auth = new AuthManager({ serverUrl: server.url, store });
    server.setTokenTtlMs(tokenTtlMs);
    await auth.pair('pairing-code');

    // A low loop limit turns a pre-fix renewal loop into a prompt failure.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
      now: Date.now() + deviceClockAheadMs,
      loopLimit: 500,
    });
    let minted = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/byok/challenge') return json({ nonce: `nonce-${minted}` });
      if (url.pathname === '/byok/token') {
        minted += 1;
        const serverNow = Date.now() - deviceClockAheadMs;
        return json({ accessToken: `token-${minted}`, expiresAt: new Date(serverNow + tokenTtlMs).toISOString() });
      }
      throw new Error(`unexpected request ${url.pathname}`);
    });
    const replace = vi.spyOn(store.credentials, 'replace');
    return { auth, replace, tokenRequests: () => minted };
  }

  /** Advances the device clock one second at a time while a long-poll-shaped caller asks for a token twice per step. */
  async function runFor(auth: AuthManager, durationMs: number): Promise<void> {
    for (let elapsed = 0; elapsed < durationMs; elapsed += 1000) {
      await auth.getValidAccessToken();
      await auth.getValidAccessToken();
      await vi.advanceTimersByTimeAsync(1000);
    }
  }

  it('a device clock two hours fast does not loop renewals or keychain writes', async () => {
    const { auth, replace, tokenRequests } = await pairedWithSkewedClock(2 * HOUR_MS, HOUR_MS);
    try {
      await auth.loadExisting();
      await runFor(auth, 10 * MINUTE_MS);

      // Floors of 30s, 60s, 120s and 240s after the first renewal at t=0 put
      // renewals at 0, 30s, 90s, 210s and 450s inside ten minutes.
      expect(tokenRequests()).toBeGreaterThan(0);
      expect(tokenRequests()).toBeLessThanOrEqual(6);
      expect(replace.mock.calls.length).toBe(tokenRequests());
      expect(auth.isRevoked()).toBe(false);
    } finally {
      await auth.stop();
    }
  });

  it('a server token TTL under the renewal margin keeps a minimum interval between renewals', async () => {
    const { auth, replace, tokenRequests } = await pairedWithSkewedClock(0, 10 * 1000);
    try {
      await auth.loadExisting();
      await runFor(auth, 10 * MINUTE_MS);

      expect(tokenRequests()).toBeGreaterThan(0);
      expect(tokenRequests()).toBeLessThanOrEqual(6);
      expect(replace.mock.calls.length).toBe(tokenRequests());
    } finally {
      await auth.stop();
    }
  });

  it('a server 401 still renews immediately inside the floor', async () => {
    const { auth, tokenRequests } = await pairedWithSkewedClock(2 * HOUR_MS, HOUR_MS);
    try {
      await auth.loadExisting();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(tokenRequests()).toBe(1));

      expect(await auth.getValidAccessToken()).toBe('token-1');
      expect(tokenRequests()).toBe(1);
      expect(await auth.handleUnauthorized()).toBe('token-2');
      expect(tokenRequests()).toBe(2);
    } finally {
      await auth.stop();
    }
  });

  it('a healthy token lifetime keeps the normal renewal point', async () => {
    const { auth, tokenRequests } = await pairedWithSkewedClock(0, HOUR_MS);
    try {
      await auth.loadExisting();
      // The paired token is good for an hour; nothing renews until its margin.
      await runFor(auth, 10 * MINUTE_MS);
      expect(tokenRequests()).toBe(0);
    } finally {
      await auth.stop();
    }
  });
});
