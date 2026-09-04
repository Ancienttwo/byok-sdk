/**
 * Typed long-poll route diagnostics prove a route failure carries its
 * credential-free `{transport, host, path}` endpoint projection. The tests
 * mock `global.fetch` (setup mirrors
 * `long-poll-validation-stall.test.ts`) because its two routes fail on the
 * HTTP response alone — no server behavior is involved beyond the status.
 */
import { generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../daemon/auth-manager';
import { exportPrivateKeyPem } from '../daemon/device-keys';
import { LongPollClient, LongPollRouteError } from '../daemon/long-poll-transport';
import { DeviceStore } from '../daemon/store';
import { seedDeviceEnrollment } from './fixtures/device-enrollment';
import { describeEndpoint } from '../daemon/url';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('LongPollRouteError names the failing route', () => {
  let auth: AuthManager;
  let fetchMock: ReturnType<typeof vi.fn>;
  let warnMock: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const storeDir = await tmpDir('byok-transport-diagnostics-store-');
    const store = new DeviceStore(storeDir);
    await seedDeviceEnrollment(store, {
      deviceId: 'dev-1',
      tenantId: 'tenant-transport',
      accessToken: 'tok-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), // far future — never renews, never touches the network
      devicePrivateKeyPem: 'unused-in-this-test',
      devicePublicKey: 'unused-in-this-test',
    });
    auth = new AuthManager({ serverUrl: 'http://example.invalid', store });
    await auth.loadExisting();

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnMock.mockRestore();
    vi.unstubAllGlobals();
  });

  /**
   * An `AuthManager` whose stored token is already expired, so the very first
   * `getValidAccessToken()` must renew — i.e. it fails (or reports the device
   * revoked) BEFORE any request to `/byok/events` or `/byok/messages` is made.
   * The keypair is real because renewal imports it before it ever reaches the
   * network; a placeholder PEM would fail for the wrong reason.
   */
  async function expiredTokenAuth(): Promise<AuthManager> {
    const storeDir = await tmpDir('byok-transport-diagnostics-expired-');
    const store = new DeviceStore(storeDir);
    const keys = generateKeyPairSync('ed25519');
    const publicJwk = keys.publicKey.export({ format: 'jwk' });
    await seedDeviceEnrollment(store, {
      deviceId: 'dev-expired',
      tenantId: 'tenant-transport',
      accessToken: 'tok-expired',
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
      devicePrivateKeyPem: exportPrivateKeyPem(keys.privateKey),
      devicePublicKey: publicJwk.x ?? 'x',
    });
    const expired = new AuthManager({ serverUrl: 'http://example.invalid', store });
    await expired.loadExisting();
    return expired;
  }

  function warnedRouteErrors(): LongPollRouteError[] {
    return (warnMock.mock.calls as unknown[][])
      .map((call) => call[1])
      .filter((arg): arg is LongPollRouteError => arg instanceof LongPollRouteError);
  }

  it('warns once with /byok/events + 503 when the poll route is rejected', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);

    const client = new LongPollClient({
      serverUrl: 'http://example.invalid',
      auth,
      getCursor: () => undefined,
      onEnvelope: vi.fn(),
      retryDelayMs: 50,
      idleDelayMs: 20,
    });
    client.start();
    await vi.waitFor(() => expect(warnedRouteErrors().length).toBeGreaterThan(0));
    client.stop();

    const errors = warnedRouteErrors();
    expect(errors[0]?.endpoint).toEqual({
      transport: 'long-poll',
      host: 'example.invalid',
      path: '/byok/events',
    });
    expect(errors[0]?.status).toBe(503);
    // Deduped by `path:status` — the loop retries every 50ms, so an unguarded
    // warn would already have fired many times by now.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(warnedRouteErrors()).toHaveLength(1);
  });

  it('warns with /byok/messages when postBatch is rejected', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);

    const client = new LongPollClient({
      serverUrl: 'http://example.invalid',
      auth,
      getCursor: () => undefined,
      onEnvelope: vi.fn(),
    });
    expect(await client.postBatch([])).toBeUndefined();

    const errors = warnedRouteErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.endpoint).toEqual({
      transport: 'long-poll',
      host: 'example.invalid',
      path: '/byok/messages',
    });
    expect(errors[0]?.status).toBe(503);
  });

  it('carries the response status when a 200 body fails to parse', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ events: 'not-an-array', cursor: 1 }),
    } as unknown as Response);

    const client = new LongPollClient({
      serverUrl: 'http://example.invalid',
      auth,
      getCursor: () => undefined,
      onEnvelope: vi.fn(),
      retryDelayMs: 50,
      idleDelayMs: 20,
    });
    client.start();
    await vi.waitFor(() => expect(warnedRouteErrors().length).toBeGreaterThan(0));
    client.stop();

    const [error] = warnedRouteErrors();
    // The route DID answer — a malformed 200 is still a 200. Reporting
    // `undefined` here would claim no response ever arrived.
    expect(error?.status).toBe(200);
    expect(error?.endpoint.path).toBe('/byok/events');
    expect(error?.message).toContain('failed with HTTP 200');
    expect((error?.cause as Error).message).toContain('events poll response.events is not an array');
  });

  it('reports a revoked device through onRevoked only, never as a route failure', async () => {
    // Renewal's first hop (POST /byok/challenge) answering 401 is what marks
    // the device revoked — see AuthManager.doRenew.
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => '' } as unknown as Response);
    const revokedAuth = await expiredTokenAuth();
    const onRevoked = vi.fn();

    const client = new LongPollClient({
      serverUrl: 'http://example.invalid',
      auth: revokedAuth,
      getCursor: () => undefined,
      onEnvelope: vi.fn(),
      onRevoked,
      retryDelayMs: 20,
      idleDelayMs: 20,
    });
    client.start();
    await vi.waitFor(() => expect(onRevoked).toHaveBeenCalled());
    client.stop();

    expect(warnedRouteErrors()).toHaveLength(0);
    expect(await client.postBatch([])).toBeUndefined();
    expect(warnedRouteErrors()).toHaveLength(0);
  });

  it('does not attribute a token-acquisition failure to either route', async () => {
    // A renewal that fails for an ordinary reason (HTTP 500 on /byok/challenge)
    // happens before any /byok/events or /byok/messages request exists.
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => '' } as unknown as Response);
    const staleAuth = await expiredTokenAuth();
    const outcomes: string[] = [];

    const client = new LongPollClient({
      serverUrl: 'http://example.invalid',
      auth: staleAuth,
      getCursor: () => undefined,
      onEnvelope: vi.fn(),
      onOperationalOutcome: (outcome) => outcomes.push(outcome),
      retryDelayMs: 20,
      idleDelayMs: 20,
    });
    client.start();
    await vi.waitFor(() => expect(outcomes.filter((o) => o === 'failure').length).toBeGreaterThan(1));
    client.stop();

    expect(warnedRouteErrors()).toHaveLength(0);
    expect(await client.postBatch([])).toBeUndefined();
    expect(warnedRouteErrors()).toHaveLength(0);
  });
});

describe('describeEndpoint redaction', () => {
  it('keeps host + path only — userinfo, query and fragment never survive', () => {
    const endpoint = describeEndpoint('long-poll', 'https://device:s3cr3t@cloud.example:8443/byok/events?sig=abc&exp=1#frag');
    expect(endpoint).toEqual({ transport: 'long-poll', host: 'cloud.example:8443', path: '/byok/events' });
    expect(JSON.stringify(endpoint)).not.toContain('s3cr3t');
    expect(JSON.stringify(endpoint)).not.toContain('sig');
  });
});
