import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthManager, DeviceRevokedError } from '../daemon/auth-manager';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { DeviceStore } from '../daemon/store';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('device pairing + Ed25519 keypair (protocol §6.1)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it('generates a device keypair on first pair and persists device.json 0600', async () => {
    const storeDir = await tmpDir('byok-auth-store-');
    const store = new DeviceStore(storeDir);
    const auth = new AuthManager({ serverUrl: server.url, store });

    const record = await auth.pair('pairing-code');
    expect(record.deviceId).toBe('device-1');
    expect(record.devicePublicKey.length).toBeGreaterThan(0);
    expect(record.devicePrivateKeyPem).toContain('PRIVATE KEY');

    const filePath = path.join(storeDir, 'device.json');
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);

    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
    expect(onDisk.devicePrivateKeyPem).toBe(record.devicePrivateKeyPem);
    expect(onDisk.devicePublicKey).toBe(record.devicePublicKey);

    auth.stop();
  });

  it('sends the public key base64url-encoded in the pair request', async () => {
    const storeDir = await tmpDir('byok-auth-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');
    // base64url alphabet only (no '+', '/', or padding '=').
    expect(record.devicePublicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    auth.stop();
  });

  it('reuses the existing keypair (does not regenerate) across a second pair() call', async () => {
    const storeDir = await tmpDir('byok-auth-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir) });

    const first = await auth.pair('pairing-code');
    const second = await auth.pair('pairing-code-2');

    expect(second.devicePublicKey).toBe(first.devicePublicKey);
    expect(second.devicePrivateKeyPem).toBe(first.devicePrivateKeyPem);
    auth.stop();
  });
});

describe('access token renewal (protocol §6.2)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it('renews proactively, in the background, before the token would expire', async () => {
    // A TTL under the auth manager's fixed renewal margin makes the
    // computed proactive-renewal delay clamp to 0 — the background timer
    // fires essentially immediately, without any caller ever asking for a
    // token, which is exactly what isolates "proactive" from "lazy/reactive".
    server.setTokenTtlMs(2000);
    const storeDir = await tmpDir('byok-auth-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir) });

    await auth.pair('pairing-code');
    expect(server.httpRequests.some((r) => r.pathname === '/byok/token')).toBe(false);

    await vi.waitFor(() => {
      expect(server.httpRequests.filter((r) => r.pathname === '/byok/challenge')).not.toHaveLength(0);
      expect(server.httpRequests.filter((r) => r.pathname === '/byok/token')).not.toHaveLength(0);
    });

    auth.stop();
  });

  it('reactively renews via handleUnauthorized() after a 401, independent of the cached token\'s believed expiry', async () => {
    server.setTokenTtlMs(60 * 60 * 1000); // long-lived — no proactive renewal should fire on its own
    const storeDir = await tmpDir('byok-auth-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir) });

    const record = await auth.pair('pairing-code');
    const staleToken = record.accessToken;
    expect(await auth.getValidAccessToken()).toBe(staleToken);

    // Simulate the server invalidating the cached token out-of-band (e.g. a
    // forced rotation) — the client's own expiry bookkeeping has no way to
    // know this happened until something actually gets a 401.
    server.rotateDeviceToken(record.deviceId);

    const renewed = await auth.handleUnauthorized();
    expect(renewed).not.toBe(staleToken);
    expect(renewed).toBe(server.currentAccessToken(record.deviceId));
    expect(server.httpRequests.some((r) => r.pathname === '/byok/challenge')).toBe(true);

    auth.stop();
  });

  it('a device revoked at the server surfaces DeviceRevokedError from handleUnauthorized(), not a retryable error', async () => {
    const storeDir = await tmpDir('byok-auth-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');

    server.revokeDevice(record.deviceId);

    await expect(auth.handleUnauthorized()).rejects.toBeInstanceOf(DeviceRevokedError);
    expect(auth.isRevoked()).toBe(true);
    auth.stop();
  });
});

describe('daemon-level auth integration (WS reconnect + revocation)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    await server.close();
  });

  it('recovers a stale-token WS rejection by reactively renewing, without operator intervention', async () => {
    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-');
    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter()],
      { backoff: { baseMs: 20, maxMs: 100, factor: 2 } },
    );

    const record = await daemon.pair('pairing-code');
    await daemon.start();
    expect(daemon.status().connected).toBe(true);

    server.rotateDeviceToken(record.deviceId);
    server.dropConnection(); // force a reconnect attempt that will present the now-stale cached token

    await vi.waitFor(() => expect(server.httpRequests.some((r) => r.pathname === '/byok/challenge')).toBe(true), {
      timeout: 5000,
    });
    await vi.waitFor(() => expect(daemon?.status().connected).toBe(true), { timeout: 5000 });
    expect(daemon.status().revoked).toBe(false);
  });

  it('a revoked device surfaces status().revoked without retry-looping, then recovers via a fresh pair()', async () => {
    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-');
    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter()],
      { backoff: { baseMs: 20, maxMs: 100, factor: 2 } },
    );

    const record = await daemon.pair('pairing-code');
    await daemon.start();
    expect(daemon.status().connected).toBe(true);

    server.revokeDevice(record.deviceId);
    server.dropConnection();

    await vi.waitFor(() => expect(daemon?.status().revoked).toBe(true), { timeout: 5000 });
    expect(daemon.status().connected).toBe(false);

    // Never a retry loop: once revoked, WS upgrade attempts must stop.
    const attemptsAfterRevoked = server.wsUpgradeAttempts;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.wsUpgradeAttempts).toBe(attemptsAfterRevoked);

    // Recourse is re-pairing from scratch (same keypair, reused per §6.3) —
    // this must actually recover the device, not just clear the flag.
    await daemon.pair('a-fresh-pairing-code');
    await daemon.start();
    await vi.waitFor(() => expect(daemon?.status().connected).toBe(true), { timeout: 5000 });
    expect(daemon.status().revoked).toBe(false);
  });

  it('a cold start() against an already-revoked device fails fast with DeviceRevokedError instead of hanging for the ack timeout', async () => {
    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-');
    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter()],
    );

    const record = await daemon.pair('pairing-code');
    server.revokeDevice(record.deviceId); // revoked before the daemon ever attempts to connect

    const startedAt = Date.now();
    await expect(daemon.start()).rejects.toBeInstanceOf(DeviceRevokedError);
    expect(Date.now() - startedAt).toBeLessThan(2000); // well under waitForAck's 10s default timeout

    expect(daemon.status().revoked).toBe(true);

    // Never a retry loop: once settled as revoked, no further WS upgrade attempts.
    const attemptsAfterRevoked = server.wsUpgradeAttempts;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.wsUpgradeAttempts).toBe(attemptsAfterRevoked);
  });
});
