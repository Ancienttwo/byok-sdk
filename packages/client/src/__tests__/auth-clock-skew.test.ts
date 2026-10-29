import { createTestDeviceStore } from './fixtures/device-credentials';
/**
 * #1114: the device clock is measured against the HTTP `Date` header of the
 * pair and token responses, as a reported value only. Token lifetime stays
 * receipt time + `expiresIn`, and a response without a parseable `Date` clears
 * the observation instead of leaving a stale one.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../daemon/auth-manager';

const HOUR_MS = 60 * 60 * 1000;
// A whole second, so the header's one-second resolution loses nothing.
const DEVICE_NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

type DateHeader = { readonly at: number } | 'absent' | 'garbage';

describe('device clock skew observation (#1114)', () => {
  let auth: AuthManager;
  let dateHeader: DateHeader;

  beforeEach(async () => {
    // Freeze only Date: sentAt equals receivedAt, so uncertainty is the bare 1 s header resolution.
    vi.useFakeTimers({ toFake: ['Date'], now: DEVICE_NOW });
    dateHeader = { at: DEVICE_NOW };
    let minted = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (dateHeader === 'garbage') headers.date = 'not a date';
      else if (dateHeader !== 'absent') headers.date = new Date(dateHeader.at).toUTCString();
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers });
      if (url.pathname === '/byok/pair') {
        return json({ deviceId: 'device-skew', tenantId: 'tenant-skew', accessToken: 'token-0', expiresIn: 3600 });
      }
      if (url.pathname === '/byok/challenge') return json({ nonce: `nonce-${minted}` });
      if (url.pathname === '/byok/token') {
        minted += 1;
        return json({ accessToken: `token-${minted}`, expiresAt: '2026-10-14T00:00:00Z', expiresIn: 3600 });
      }
      throw new Error(`unexpected request ${url.pathname}`);
    });
    const store = createTestDeviceStore(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-auth-clock-skew-')));
    auth = new AuthManager({ serverUrl: 'http://127.0.0.1:1', store });
  });

  afterEach(async () => {
    await auth.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is unknown before any exchange', () => {
    expect(auth.clockSkew()).toBeUndefined();
  });

  it('is unknown when the device clock is set back while the request is in flight', async () => {
    vi.mocked(globalThis.fetch).mockImplementationOnce(async () => {
      vi.setSystemTime(DEVICE_NOW - 120_000);
      return new Response(JSON.stringify({ deviceId: 'device-skew', tenantId: 'tenant-skew', accessToken: 'token-0', expiresIn: 3600 }),
        { status: 200, headers: { date: new Date(DEVICE_NOW).toUTCString() } });
    });
    await auth.pair('pairing-code');
    expect(auth.clockSkew()).toBeUndefined();
  });

  it.each([
    ['ahead of', 2 * HOUR_MS, -2 * HOUR_MS],
    ['behind', -2 * HOUR_MS, 2 * HOUR_MS],
    ['in sync with', 0, 0],
  ])('pairing measures a device clock %s the server', async (_case, serverAheadMs, deviceAheadMs) => {
    dateHeader = { at: DEVICE_NOW + serverAheadMs };
    await auth.pair('pairing-code');
    expect(auth.clockSkew()).toEqual({ deviceAheadMs, uncertaintyMs: 1000, observedAt: new Date(DEVICE_NOW).toISOString() });
  });

  it('halves the round trip into the measurement and its uncertainty', async () => {
    dateHeader = { at: DEVICE_NOW };
    vi.mocked(globalThis.fetch).mockImplementationOnce(async () => {
      vi.setSystemTime(DEVICE_NOW + 3000);
      return new Response(
        JSON.stringify({ deviceId: 'device-skew', tenantId: 'tenant-skew', accessToken: 'token-0', expiresIn: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json', date: new Date(DEVICE_NOW + 1000).toUTCString() } },
      );
    });
    await auth.pair('pairing-code');
    // Midpoint of [sent, received] is +1.5 s on the device clock; the server stamped +1 s.
    expect(auth.clockSkew()).toEqual({ deviceAheadMs: 500, uncertaintyMs: 2500, observedAt: new Date(DEVICE_NOW + 3000).toISOString() });
  });

  it.each([['absent'], ['garbage']] as const)('a pair response with %s Date stays unknown', async (header) => {
    dateHeader = header;
    await auth.pair('pairing-code');
    expect(auth.clockSkew()).toBeUndefined();
  });

  it('a renewal replaces the observation, and one without a parseable Date clears it', async () => {
    dateHeader = { at: DEVICE_NOW + 2 * HOUR_MS };
    await auth.pair('pairing-code');
    expect(auth.clockSkew()?.deviceAheadMs).toBe(-2 * HOUR_MS);

    dateHeader = { at: DEVICE_NOW - 2 * HOUR_MS };
    await auth.handleUnauthorized();
    expect(auth.clockSkew()).toEqual({ deviceAheadMs: 2 * HOUR_MS, uncertaintyMs: 1000, observedAt: new Date(DEVICE_NOW).toISOString() });

    dateHeader = 'garbage';
    await auth.handleUnauthorized();
    expect(auth.clockSkew()).toBeUndefined();

    dateHeader = { at: DEVICE_NOW };
    await auth.handleUnauthorized();
    expect(auth.clockSkew()?.deviceAheadMs).toBe(0);

    dateHeader = 'absent';
    await auth.handleUnauthorized();
    expect(auth.clockSkew()).toBeUndefined();
  });

  it('never feeds token lifetime: expiry is receipt time plus expiresIn whatever the Date says', async () => {
    dateHeader = { at: DEVICE_NOW + 2 * HOUR_MS };
    const record = await auth.pair('pairing-code');
    expect(record.expiresAt).toBe(new Date(DEVICE_NOW + 3600 * 1000).toISOString());
  });
});
