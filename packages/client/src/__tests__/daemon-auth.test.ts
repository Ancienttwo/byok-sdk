import { testAgentHomeConfig } from './fixtures/test-agent';
import { createTestDeviceStore, testDeviceCredentials } from './fixtures/device-credentials';
import { testScratchRoot } from "./fixtures/execution-scratch";
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthManager, DeviceRevokedError } from '../daemon/auth-manager';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { DeviceStore } from '../daemon/store';
import { acquireDaemonOwner, DaemonOwnerActiveError, storeMutexEndpoint } from '../daemon/daemon-owner';
import { DaemonHaltError } from '../daemon/daemon-lifecycle';
import { quarantineCorruptOperationalHealth } from '../diagnostics/diagnostics';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';
import { OPEN_LIFECYCLE, waitForDaemonOpen } from './fixtures/lifecycle-barrier';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Fails the regression deterministically instead of leaving a pre-fix HTTP/body hang in the test runner. */
async function settleWithin<T>(operation: Promise<T>, timeoutMs = 250): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`auth request regression guard exceeded ${timeoutMs}ms`)), timeoutMs);
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function authWithDeadline(serverUrl: string, store: DeviceStore, authRequestDeadlineMs: number): AuthManager {
  // The temporary assertion makes this guard compile against the unfixed base,
  // where AuthManager has not yet declared its one deadline configuration.
  return new AuthManager({ serverUrl, store, authRequestDeadlineMs } as ConstructorParameters<typeof AuthManager>[0]);
}

describe('device pairing + Ed25519 keypair (protocol §6.1)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it('generates a device keypair on first pair and persists only metadata in device.json', async () => {
    const storeDir = await tmpDir('byok-auth-store-');
    const store = createTestDeviceStore(storeDir);
    const auth = new AuthManager({ serverUrl: server.url, store });

    const record = await auth.pair('pairing-code');
    expect(record.deviceId).toBe('device-1');
    expect(record.devicePublicKey.length).toBeGreaterThan(0);
    expect(record.devicePrivateKeyPem).toContain('PRIVATE KEY');

    const filePath = path.join(storeDir, 'device.json');
    const stat = await fs.stat(filePath);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);

    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
    expect(onDisk.devicePrivateKeyPem).toBeUndefined();
    expect(onDisk.accessToken).toBeUndefined();
    expect(onDisk.devicePublicKey).toBe(record.devicePublicKey);
    expect(await store.credentials.read()).toMatchObject({
      accessToken: record.accessToken,
      devicePrivateKeyPem: record.devicePrivateKeyPem,
    });

    auth.stop();
  });

  it('refuses a device.json symlink before reading its external target', async () => {
    const storeDir = await tmpDir('byok-auth-symlink-store-');
    const outsideDir = await tmpDir('byok-auth-symlink-outside-');
    const outside = path.join(outsideDir, 'external-device.json');
    await fs.writeFile(outside, JSON.stringify({
      deviceId: 'external-device',
      accessToken: 'external-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
      devicePrivateKeyPem: 'external-private-key',
      devicePublicKey: 'external-public-key',
    }));
    await fs.symlink(outside, path.join(storeDir, 'device.json'));

    await expect(createTestDeviceStore(storeDir).load()).rejects.toThrow(/not a real regular file|opened safely/);
    expect(JSON.parse(await fs.readFile(outside, 'utf8'))).toMatchObject({ accessToken: 'external-token' });
  });

  it('sends the public key base64url-encoded in the pair request', async () => {
    const storeDir = await tmpDir('byok-auth-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: createTestDeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');
    // base64url alphabet only (no '+', '/', or padding '=').
    expect(record.devicePublicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    auth.stop();
  });

  it('sends the resolved machineId in the pair body, and OMITS the field when the probe resolves nothing', async () => {
    // The optional wire field is what lets the server collapse one physical
    // machine's stale device rows (protocol §6.1). Its ABSENCE is the load
    // bearing half: a client that cannot identify its machine must send no
    // field at all — an empty string or a `null` would be a single fake
    // "machine" every unidentifiable device on the fleet shares, and the
    // server would supersede them against each other.
    const machineId = 'a'.repeat(64);
    const withProbe = new AuthManager({
      serverUrl: server.url,
      store: createTestDeviceStore(await tmpDir('byok-auth-machine-')),
      machineId: async () => machineId,
    });
    await withProbe.pair('pairing-code');
    withProbe.stop();

    expect(server.pairRequests.at(-1)).toMatchObject({ machineId });

    const withoutProbe = new AuthManager({
      serverUrl: server.url,
      store: createTestDeviceStore(await tmpDir('byok-auth-machine-none-')),
      machineId: async () => undefined,
    });
    await withoutProbe.pair('pairing-code-2');
    withoutProbe.stop();

    expect('machineId' in server.pairRequests.at(-1)!).toBe(false);

    // No option at all behaves exactly like an unresolved probe.
    const noOption = new AuthManager({
      serverUrl: server.url,
      store: createTestDeviceStore(await tmpDir('byok-auth-machine-absent-')),
    });
    await noOption.pair('pairing-code-3');
    noOption.stop();

    expect('machineId' in server.pairRequests.at(-1)!).toBe(false);
  });

  it('reuses the existing keypair (does not regenerate) across a second pair() call', async () => {
    const storeDir = await tmpDir('byok-auth-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: createTestDeviceStore(storeDir) });

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
    const auth = new AuthManager({ serverUrl: server.url, store: createTestDeviceStore(storeDir) });

    await auth.pair('pairing-code');
    await auth.loadExisting();
    expect(server.httpRequests.some((r) => r.pathname === '/byok/token')).toBe(false);

    await vi.waitFor(() => {
      expect(server.httpRequests.filter((r) => r.pathname === '/byok/challenge')).not.toHaveLength(0);
      expect(server.httpRequests.filter((r) => r.pathname === '/byok/token')).not.toHaveLength(0);
    });

    auth.stop();
  });

  it('keeps proactive renewal at the renewal point for a token that expires beyond one timer range', async () => {
    const MAX_TIMER_DELAY_MS = 2_147_483_647;
    const RENEW_MARGIN_MS = 60 * 1000;
    const ttlMs = 60 * 24 * 60 * 60 * 1000; // 60 days
    server.setTokenTtlMs(ttlMs);
    const storeDir = await tmpDir('byok-auth-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: createTestDeviceStore(storeDir) });
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.name);
    process.on('warning', onWarning);

    await auth.pair('pairing-code');
    expect(server.httpRequests.some((r) => r.pathname === '/byok/token')).toBe(false);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, delay?: number) => {
      delays.push(delay ?? 0);
      return realSetTimeout(handler, delay);
    }) as typeof setTimeout);
    const tokenRequests = () => server.httpRequests.filter((r) => r.pathname === '/byok/token').length;
    // Fake timers clamp an over-range delay to 1 ms exactly as the runtime does,
    // so renewal starting early is observed on `renew` itself (it runs
    // synchronously from the timer callback), before any HTTP is involved.
    const renewSpy = vi.spyOn(auth as unknown as { renew(): Promise<string> }, 'renew');
    try {
      // The timer armed by pair() predates fake timers; re-arm under them.
      await auth.loadExisting();
      const startedAt = Date.now();
      expect(delays.length).toBeGreaterThan(0);
      expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);

      await vi.advanceTimersByTimeAsync(1);
      expect(renewSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
      expect(renewSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
      expect(renewSpy).not.toHaveBeenCalled();
      expect(tokenRequests()).toBe(0);

      const remaining = startedAt + ttlMs - RENEW_MARGIN_MS - Date.now();
      await vi.advanceTimersByTimeAsync(remaining - 1_000);
      expect(renewSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(renewSpy).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(tokenRequests()).toBeGreaterThan(0));

      expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(warnings).not.toContain('TimeoutOverflowWarning');
    } finally {
      process.off('warning', onWarning);
      renewSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      await auth.stop();
      vi.useRealTimers();
    }
  });

  it('reactively renews via handleUnauthorized() after a 401, independent of the cached token\'s believed expiry', async () => {
    server.setTokenTtlMs(60 * 60 * 1000); // long-lived — no proactive renewal should fire on its own
    const storeDir = await tmpDir('byok-auth-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: createTestDeviceStore(storeDir) });

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

  it('waits for an in-flight reactive renewal instead of returning the stale cached token', async () => {
    server.setTokenTtlMs(60 * 60 * 1000);
    const storeDir = await tmpDir('byok-auth-read-during-renewal-');
    const store = createTestDeviceStore(storeDir);
    const auth = new AuthManager({ serverUrl: server.url, store });
    const record = await auth.pair('pairing-code');
    server.rotateDeviceToken(record.deviceId);

    let renewalSaveReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      renewalSaveReached = resolve;
    });
    let releaseRenewalSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseRenewalSave = resolve;
    });
    const realReplace = store.credentials.replace.bind(store.credentials);
    vi.spyOn(store.credentials, 'replace').mockImplementation(async (next) => {
      if (next.accessToken !== record.accessToken) {
        renewalSaveReached();
        await saveGate;
      }
      await realReplace(next);
    });

    const renewal = auth.handleUnauthorized();
    await reached;

    const tokenRead = auth.getValidAccessToken();
    await expect(
      Promise.race([
        tokenRead.then(() => 'settled'),
        new Promise<string>((resolve) => setImmediate(() => resolve('pending'))),
      ]),
    ).resolves.toBe('pending');

    releaseRenewalSave();
    const renewedToken = await renewal;
    await expect(tokenRead).resolves.toBe(renewedToken);
    expect(renewedToken).toBe(server.currentAccessToken(record.deviceId));
    await auth.stop();
  });

  it('stop waits for an already-started renewal writer before it resolves', async () => {
    server.setTokenTtlMs(60 * 60 * 1000);
    const storeDir = await tmpDir('byok-auth-stop-barrier-');
    const store = createTestDeviceStore(storeDir);
    const auth = new AuthManager({ serverUrl: server.url, store });
    const record = await auth.pair('pairing-code');
    server.rotateDeviceToken(record.deviceId);

    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const realReplace = store.credentials.replace.bind(store.credentials);
    const save = vi.spyOn(store.credentials, 'replace').mockImplementation(async (next) => {
      await saveGate;
      await realReplace(next);
    });
    const renewal = auth.handleUnauthorized();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    let stopped = false;
    const stopping = auth.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseSave();
    await expect(renewal).resolves.not.toBe(record.accessToken);
    await stopping;
    expect(stopped).toBe(true);
  });

  it('serializes pair behind an in-flight renewal so the old identity cannot overwrite the new pair', async () => {
    server.setTokenTtlMs(60 * 60 * 1000);
    const storeDir = await tmpDir('byok-auth-pair-renewal-race-');
    const store = createTestDeviceStore(storeDir);
    const auth = new AuthManager({ serverUrl: server.url, store });
    const first = await auth.pair('pairing-code');
    server.rotateDeviceToken(first.deviceId);

    let renewalSaveReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      renewalSaveReached = resolve;
    });
    let releaseRenewalSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseRenewalSave = resolve;
    });
    const realReplace = store.credentials.replace.bind(store.credentials);
    vi.spyOn(store.credentials, 'replace').mockImplementation(async (record) => {
      if (record.accessToken !== first.accessToken) {
        renewalSaveReached();
        await saveGate;
      }
      await realReplace(record);
    });

    const renewal = auth.handleUnauthorized();
    await reached;
    let pairSettled = false;
    const pairing = auth.pair('replacement-pairing-code').then((record) => {
      pairSettled = true;
      return record;
    });
    await Promise.resolve();
    expect(pairSettled).toBe(false);
    releaseRenewalSave();
    const renewedToken = await renewal;
    const replacement = await pairing;
    expect(replacement.accessToken).not.toBe(renewedToken);
    expect(await store.load()).toMatchObject({ deviceId: replacement.deviceId });
    expect(await store.credentials.read()).toMatchObject({ accessToken: replacement.accessToken });
    await auth.stop();
  });

  it('a device revoked at the server surfaces DeviceRevokedError from handleUnauthorized(), not a retryable error', async () => {
    const storeDir = await tmpDir('byok-auth-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: createTestDeviceStore(storeDir) });
    const record = await auth.pair('pairing-code');

    server.revokeDevice(record.deviceId);

    await expect(auth.handleUnauthorized()).rejects.toBeInstanceOf(DeviceRevokedError);
    expect(auth.isRevoked()).toBe(true);
    auth.stop();
  });

  it('bounds a hung pairing response without persisting a partial credential or treating it as revocation', async () => {
    const store = createTestDeviceStore(await tmpDir('byok-auth-pair-deadline-'));
    const auth = authWithDeadline(server.url, store, 40);
    const releasePair = server.blockNextPair();
    try {
      await expect(settleWithin(auth.pair('pairing-code'))).rejects.toMatchObject({
        name: 'AuthRequestAbortedError',
        reason: 'deadline',
      });
      expect(auth.isRevoked()).toBe(false);
      await expect(store.load()).resolves.toBeUndefined();
      await expect(store.credentials.read()).resolves.toBeUndefined();
    } finally {
      releasePair();
      await auth.stop();
    }
  });

  it('stop aborts a hung challenge before waiting for the credential mutation tail', async () => {
    server.setTokenTtlMs(60 * 60 * 1000);
    const store = createTestDeviceStore(await tmpDir('byok-auth-stop-deadline-'));
    const auth = authWithDeadline(server.url, store, 500);
    const record = await auth.pair('pairing-code');
    const before = await store.credentials.read();
    server.rotateDeviceToken(record.deviceId);
    const releaseChallenge = server.blockNextChallenge();
    const renewal = auth.handleUnauthorized();
    await vi.waitFor(() => expect(server.httpRequests.some((request) => request.pathname === '/byok/challenge')).toBe(true));
    const stopping = auth.stop();
    try {
      const [renewalResult] = await settleWithin(Promise.allSettled([renewal, stopping]));
      expect(renewalResult).toMatchObject({
        status: 'rejected',
        reason: { name: 'AuthRequestAbortedError', reason: 'stopped' },
      });
      expect(auth.isRevoked()).toBe(false);
      expect(await store.credentials.read()).toEqual(before);
    } finally {
      releaseChallenge();
      await auth.stop();
    }
  });

  it('bounds a hung token response body and preserves the complete prior credential', async () => {
    server.setTokenTtlMs(60 * 60 * 1000);
    const store = createTestDeviceStore(await tmpDir('byok-auth-token-body-deadline-'));
    const auth = authWithDeadline(server.url, store, 40);
    const record = await auth.pair('pairing-code');
    const before = await store.credentials.read();
    server.rotateDeviceToken(record.deviceId);
    const realFetch = globalThis.fetch;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/byok/token') {
        return new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return realFetch(input, init);
    });
    try {
      await expect(settleWithin(auth.handleUnauthorized())).rejects.toMatchObject({
        name: 'AuthRequestAbortedError',
        reason: 'deadline',
      });
      expect(auth.isRevoked()).toBe(false);
      expect(await store.credentials.read()).toEqual(before);
    } finally {
      fetch.mockRestore();
      // The unfixed base cannot settle this body read. Keep its deterministic
      // regression guard short without turning teardown itself into a 10s
      // test timeout; the fixed path independently proves stop/renew abort.
      void auth.stop().catch(() => undefined);
    }
  });

  it('bounds a hung error body instead of leaving safeErrorText unbounded', async () => {
    const store = createTestDeviceStore(await tmpDir('byok-auth-error-body-deadline-'));
    const auth = authWithDeadline(server.url, store, 40);
    const realFetch = globalThis.fetch;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    try {
      await expect(settleWithin(auth.pair('pairing-code'))).rejects.toMatchObject({
        name: 'AuthRequestAbortedError',
        reason: 'deadline',
      });
      expect(auth.isRevoked()).toBe(false);
      await expect(store.credentials.read()).resolves.toBeUndefined();
    } finally {
      fetch.mockRestore();
      void auth.stop().catch(() => undefined);
    }
  });

  it('allows a pairing response released close to the configured deadline to complete', async () => {
    const store = createTestDeviceStore(await tmpDir('byok-auth-near-deadline-'));
    const auth = authWithDeadline(server.url, store, 500);
    const releasePair = server.blockNextPair();
    let signalIssued!: () => void;
    const issued = new Promise<void>(resolve => { signalIssued = resolve; });
    const realFetch = globalThis.fetch;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const response = realFetch(input, init);
      signalIssued();
      return response;
    });
    // Advance the request's deadline explicitly after fetch begins. Real HTTP
    // and credential I/O cannot consume an uncontrolled part of that window.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pairing = auth.pair('pairing-code');
      await Promise.race([issued, pairing.then(() => {
        throw new Error('pairing completed before its held request was issued');
      })]);
      await vi.advanceTimersByTimeAsync(450);
      releasePair();
      await expect(pairing).resolves.toMatchObject({ deviceId: 'device-1' });
      await vi.advanceTimersByTimeAsync(100);
      expect(auth.isRevoked()).toBe(false);
    } finally {
      releasePair();
      await auth.stop();
      fetch.mockRestore();
      vi.useRealTimers();
    }
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

  it('composes the configured auth request deadline into the daemon-owned AuthManager', async () => {
    const workspaceRoot = await tmpDir('byok-daemon-auth-deadline-workspace-');
    const storeDir = await tmpDir('byok-daemon-auth-deadline-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test',
        productId: 'test-auth-deadline',
        serverUrl: server.url,
        workspaceRoot,
        agentHome: testAgentHomeConfig(),
        storeDir,
        authRequestDeadlineMs: 40,
      },
      [new StubRuntimeAdapter()],
    );
    const releasePair = server.blockNextPair();
    try {
      // The 40ms request deadline starts inside AuthManager after daemon-owned
      // key/store setup. Keep the outer regression guard well below the 15s
      // default without racing that legitimate pre-request work under CI load.
      await expect(settleWithin(daemon.pair('pairing-code'), 2_000)).rejects.toMatchObject({
        name: 'AuthRequestAbortedError',
        reason: 'deadline',
      });
    } finally {
      releasePair();
    }
  });

  it('recovers a stale-token WS rejection by reactively renewing, without operator intervention', async () => {
    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },  localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter()],
      {} ,
    );

    const record = await daemon.pair('pairing-code');
    await daemon.start();
    await waitForDaemonOpen(daemon);
    expect(daemon.status().lifecycle).toEqual(OPEN_LIFECYCLE);

    server.rotateDeviceToken(record.deviceId);

    await vi.waitFor(() => expect(server.httpRequests.some((r) => r.pathname === '/byok/challenge')).toBe(true), {
      timeout: 5000,
    });
    await vi.waitFor(() => expect(daemon?.status().lifecycle).toEqual(OPEN_LIFECYCLE), { timeout: 5000 });
    expect(daemon.status().lifecycle.phase).not.toBe('halted');
  });

  it('a rejected second daemon never arms an uncovered proactive-renewal writer', async () => {
    server.setTokenTtlMs(60 * 60 * 1000);
    const workspaceRoot = await tmpDir('byok-client-owner-auth-workspace-');
    const storeDir = await tmpDir('byok-client-owner-auth-store-');
    const config = { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-owner-auth', serverUrl: server.url, workspaceRoot, storeDir };
    daemon = createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(config) }, [new StubRuntimeAdapter()]);
    await daemon.pair('pairing-code');
    await daemon.start();
    const before = server.httpRequests.filter((r) => r.pathname === '/byok/challenge').length;

    const rejected = createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...(config) }, [new StubRuntimeAdapter()]);
    const rejection = await rejected.start().then(() => undefined, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(DaemonHaltError);
    expect((rejection as DaemonHaltError).reason).toBe('store_owned');
    expect((rejection as DaemonHaltError).cause).toBeInstanceOf(DaemonOwnerActiveError);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.httpRequests.filter((r) => r.pathname === '/byok/challenge')).toHaveLength(before);
    await rejected.stop();
  });

  // This probe tests SQLite ownership. Transfer its synthetic enrollment over
  // IPC and explicitly inject custody in the child; no OS provider is needed.
  it('a separate hosted daemon owns SQLite before any contender can open or quarantine it', async () => {
    const workspaceRoot = await tmpDir('byok-client-hosted-owner-workspace-');
    const storeDir = await tmpDir('byok-client-hosted-owner-store-');
    const config = {
      storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Test',
      productId: 'test-hosted-owner',
      serverUrl: server.url,
      workspaceRoot,
      agentHome: testAgentHomeConfig(),
      storeDir,
    };
    const pairer = createDaemonWithAdapters(config, [new StubRuntimeAdapter()]);
    await pairer.pair('pairing-code');

    const distEntry = new URL('../../dist/index.js', import.meta.url).href;
    const childSource = `
      const { createDaemonWithAdapters } = await import(process.argv[1]);
      const { InMemoryDeviceCredentialStore } = await import(process.argv[3]);
      const credentials = new InMemoryDeviceCredentialStore();
      await credentials.replace(await new Promise(resolve => process.once('message', resolve)));
      const config = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
      const adapter = {
        descriptor: Object.freeze({
          id: 'pi',
          supportsDispatchSelection: true,
          capabilities: Object.freeze({ steer: true, resume: true, approvalInteractive: false }),
        }),
        detect: async () => ({ kind: 'available', version: 'test', authPresent: true }),
        prepare: async () => ({ kind: 'prepared', operation: { start: async () => { throw new Error('not used'); } } }),
      };
      const daemon = createDaemonWithAdapters(config, [adapter], { deviceCredentials: credentials });
      try {
        await daemon.start();
        process.send?.({ kind: 'started' });
      } catch (error) {
        process.send?.({ kind: 'error', message: error instanceof Error ? error.stack : String(error) });
      }
    `;
    const child = spawn(
      process.execPath,
      ['-e', childSource, distEntry, Buffer.from(JSON.stringify(config)).toString('base64url'), new URL('../../../../scripts/testing/device-credentials.mjs', import.meta.url).href],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    const enrollment = await testDeviceCredentials(config.productId).read();
    expect(enrollment).toBeDefined();
    if (enrollment === undefined) throw new Error('paired owner fixture is missing its enrollment');
    child.send(enrollment);
    let childStderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { childStderr += chunk; });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => reject(new Error(`hosted owner child exited early (${code ?? signal}): ${childStderr}`)));
        child.on('message', (message: unknown) => {
          const shaped = message as { kind?: string; message?: string };
          if (shaped.kind === 'started') resolve();
          if (shaped.kind === 'error') reject(new Error(`hosted owner child failed: ${shaped.message ?? childStderr}`));
        });
      });

      daemon = createDaemonWithAdapters(config, [new StubRuntimeAdapter()]);
      const error = await daemon.start().then(() => undefined, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(DaemonHaltError);
      expect((error as DaemonHaltError).reason).toBe('store_owned');
      expect((error as DaemonHaltError).cause).toBeInstanceOf(DaemonOwnerActiveError);
      await expect(quarantineCorruptOperationalHealth(storeDir)).rejects.toBeInstanceOf(DaemonOwnerActiveError);
      // A live SQLite owner may legitimately append/checkpoint WAL bytes
      // while these refusals execute, so byte-for-byte WAL snapshots cannot
      // attribute a change to the contender. The actual invariant is that the
      // contender and quarantine path both fail before taking ownership,
      // while the owner process and its database files remain live.
      expect(child.exitCode).toBeNull();
      for (const name of ['daemon.db', 'daemon.db-wal', 'daemon.db-shm']) {
        expect((await fs.stat(path.join(storeDir, name))).isFile()).toBe(true);
      }
    } finally {
      child.kill('SIGKILL');
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
    }

    // The dead child's owner record carries its PID/start identity and closed
    // liveness port. A real second process crash must therefore be reclaimable,
    // while the live-child phase above stayed strictly fail-closed.
    const recovered = await acquireDaemonOwner(storeDir, 'doctor');
    await recovered.release();
  }, 20_000);

  it('retains the lease in a real process when a post-open SQLite fault cannot prove handle cleanup', async () => {
    const workspaceRoot = await tmpDir('byok-client-open-cleanup-workspace-');
    const storeDir = await tmpDir('byok-client-open-cleanup-store-');
    const config = {
      storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Test',
      productId: 'test-open-cleanup-owner',
      serverUrl: server.url,
      workspaceRoot,
      agentHome: testAgentHomeConfig(),
      storeDir,
    };
    const pairer = createDaemonWithAdapters(config, [new StubRuntimeAdapter()]);
    await pairer.pair('pairing-code');

    const distEntry = new URL('../../dist/index.js', import.meta.url).href;
    const childSource = `
      const { createDaemonWithAdapters } = await import(process.argv[1]);
      const config = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
      const adapter = {
        descriptor: Object.freeze({
          id: 'pi',
          supportsDispatchSelection: true,
          capabilities: Object.freeze({ steer: true, resume: true, approvalInteractive: false }),
        }),
        detect: async () => ({ kind: 'available', version: 'test', authPresent: true }),
        prepare: async () => ({ kind: 'prepared', operation: { start: async () => { throw new Error('not used'); } } }),
      };
      const daemon = createDaemonWithAdapters(config, [adapter], {
        journalOpenFaults: {
          onStep(step) {
            if (step === 'after-open') throw new Error('injected post-open failure');
          },
          close(db) {
            db.close();
            throw new Error('injected close-report failure');
          },
        },
      });
      try {
        await daemon.start();
        process.send?.({ kind: 'unexpected-start' });
      } catch {
        process.send?.({ kind: 'failed-with-retained-lease' });
        setInterval(() => undefined, 1_000);
      }
    `;
    const child = spawn(
      process.execPath,
      ['-e', childSource, distEntry, Buffer.from(JSON.stringify(config)).toString('base64url')],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let childStderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { childStderr += chunk; });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => reject(new Error(`cleanup-fault child exited early (${code ?? signal}): ${childStderr}`)));
        child.on('message', (message: unknown) => {
          const shaped = message as { kind?: string };
          if (shaped.kind === 'failed-with-retained-lease') resolve();
          if (shaped.kind === 'unexpected-start') reject(new Error('cleanup-fault daemon unexpectedly started'));
        });
      });
      await expect(acquireDaemonOwner(storeDir, 'doctor')).rejects.toBeInstanceOf(DaemonOwnerActiveError);
    } finally {
      child.kill('SIGKILL');
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
    }

    const recovered = await acquireDaemonOwner(storeDir, 'doctor');
    await recovered.release();
  }, 20_000);

  it('reads the identity to remove only after unpair reacquires the mutation lease', async () => {
    const workspaceRoot = await tmpDir('byok-client-unpair-lease-workspace-');
    const storeDir = await tmpDir('byok-client-unpair-lease-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },  localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-unpair-lease', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter()],
    );
    await daemon.pair('pairing-code');
    const originalRemove = DeviceStore.prototype.remove;
    const remove = vi.spyOn(DeviceStore.prototype, 'remove').mockImplementation(async function (this: DeviceStore) {
      await expect(acquireDaemonOwner(storeDir, 'doctor')).rejects.toBeInstanceOf(DaemonOwnerActiveError);
      return originalRemove.call(this);
    });
    try {
      await daemon.unpair();
      expect(remove).toHaveBeenCalledOnce();
    } finally {
      remove.mockRestore();
    }
    await expect(fs.stat(path.join(storeDir, 'device.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the ownership lease across each queued daemon-level pair mutation', async () => {
    const workspaceRoot = await tmpDir('byok-client-pair-queue-workspace-');
    const storeDir = await tmpDir('byok-client-pair-queue-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },  localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-pair-queue', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter()],
    );
    const realSave = DeviceStore.prototype.save;
    let saveCount = 0;
    let secondSaveReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      secondSaveReached = resolve;
    });
    let releaseSecondSave!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSecondSave = resolve;
    });
    const save = vi.spyOn(DeviceStore.prototype, 'save').mockImplementation(async function (this: DeviceStore, record) {
      saveCount += 1;
      if (saveCount === 2) {
        secondSaveReached();
        await gate;
      }
      await realSave.call(this, record);
    });
    try {
      const first = daemon.pair('first-pairing-code');
      const second = daemon.pair('second-pairing-code');
      await first;
      await reached;
      await expect(acquireDaemonOwner(storeDir, 'doctor')).rejects.toBeInstanceOf(DaemonOwnerActiveError);
      releaseSecondSave();
      await second;
    } finally {
      releaseSecondSave();
      save.mockRestore();
    }
  });

  it('serializes start behind an in-flight pair instead of borrowing and outliving its lease', async () => {
    const workspaceRoot = await tmpDir('byok-client-pair-start-workspace-');
    const storeDir = await tmpDir('byok-client-pair-start-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },  localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-pair-start', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter()],
    );
    const realSave = DeviceStore.prototype.save;
    let saveReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      saveReached = resolve;
    });
    let releaseSave!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const save = vi.spyOn(DeviceStore.prototype, 'save').mockImplementation(async function (this: DeviceStore, record) {
      saveReached();
      await gate;
      await realSave.call(this, record);
    });
    try {
      const pairing = daemon.pair('pairing-code');
      await reached;
      let startSettled = false;
      const starting = daemon.start().finally(() => {
        startSettled = true;
      });
      await Promise.resolve();
      expect(startSettled).toBe(false);
      await expect(acquireDaemonOwner(storeDir, 'doctor')).rejects.toBeInstanceOf(DaemonOwnerActiveError);
      releaseSave();
      await pairing;
      await starting;
      await waitForDaemonOpen(daemon);
      expect(daemon.status().lifecycle).toEqual(OPEN_LIFECYCLE);
    } finally {
      releaseSave();
      save.mockRestore();
    }
  });

  it('serializes stop behind an in-flight pair and releases only after its credential write', async () => {
    const workspaceRoot = await tmpDir('byok-client-pair-stop-workspace-');
    const storeDir = await tmpDir('byok-client-pair-stop-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },  localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-pair-stop', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter()],
    );
    await daemon.pair('initial-pairing-code');
    await daemon.start();
    const realSave = DeviceStore.prototype.save;
    let saveReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      saveReached = resolve;
    });
    let releaseSave!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const save = vi.spyOn(DeviceStore.prototype, 'save').mockImplementation(async function (this: DeviceStore, record) {
      saveReached();
      await gate;
      await realSave.call(this, record);
    });
    try {
      const pairing = daemon.pair('replacement-pairing-code');
      await reached;
      let stopSettled = false;
      const stopping = daemon.stop().finally(() => {
        stopSettled = true;
      });
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      await expect(acquireDaemonOwner(storeDir, 'doctor')).rejects.toBeInstanceOf(DaemonOwnerActiveError);
      releaseSave();
      await pairing;
      await stopping;
      const doctor = await acquireDaemonOwner(storeDir, 'doctor');
      await doctor.release();
    } finally {
      releaseSave();
      save.mockRestore();
    }
  });

  it('serializes unpair behind an in-flight pair and removes the replacement identity under its cleanup lease', async () => {
    const workspaceRoot = await tmpDir('byok-client-pair-unpair-workspace-');
    const storeDir = await tmpDir('byok-client-pair-unpair-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },  localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-pair-unpair', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter()],
    );
    await daemon.pair('initial-pairing-code');
    await daemon.start();
    const realSave = DeviceStore.prototype.save;
    let saveReached!: () => void;
    const reached = new Promise<void>((resolve) => { saveReached = resolve; });
    let releaseSave!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSave = resolve; });
    const save = vi.spyOn(DeviceStore.prototype, 'save').mockImplementation(async function (this: DeviceStore, record) {
      saveReached();
      await gate;
      await realSave.call(this, record);
    });
    try {
      const pairing = daemon.pair('replacement-pairing-code');
      await reached;
      let unpairSettled = false;
      const unpairing = daemon.unpair().finally(() => { unpairSettled = true; });
      await Promise.resolve();
      expect(unpairSettled).toBe(false);
      await expect(acquireDaemonOwner(storeDir, 'doctor')).rejects.toBeInstanceOf(DaemonOwnerActiveError);
      releaseSave();
      await pairing;
      await unpairing;
      await expect(fs.stat(path.join(storeDir, 'device.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      const doctor = await acquireDaemonOwner(storeDir, 'doctor');
      await doctor.release();
    } finally {
      releaseSave();
      save.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('fails closed without blocking when unpair sees a FIFO device record', async () => {
    const workspaceRoot = await tmpDir('byok-client-unpair-fifo-workspace-');
    const storeDir = await tmpDir('byok-client-unpair-fifo-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },  localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-unpair-fifo', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter()],
    );
    await daemon.pair('pairing-code');
    const devicePath = path.join(storeDir, 'device.json');
    await fs.rm(devicePath);
    execFileSync('mkfifo', [devicePath]);
    const started = Date.now();
    await expect(daemon.unpair()).rejects.toThrow(/device identity/);
    expect(Date.now() - started).toBeLessThan(1_000);
    await fs.rm(devicePath);
    const lease = await acquireDaemonOwner(storeDir, 'doctor');
    await lease.release();
  });

  it('maps a store directory alias to the same cross-process mutation mutex', async () => {
    const parent = await tmpDir('byok-owner-alias-parent-');
    const storeDir = path.join(parent, 'real-store');
    const aliasDir = path.join(parent, 'store-alias');
    await fs.mkdir(storeDir);
    await fs.symlink(storeDir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir');

    const lease = await acquireDaemonOwner(storeDir, 'doctor');
    try {
      await expect(acquireDaemonOwner(aliasDir, 'doctor')).rejects.toBeInstanceOf(DaemonOwnerActiveError);
    } finally {
      await lease.release();
    }

    const aliasLease = await acquireDaemonOwner(aliasDir, 'doctor');
    await aliasLease.release();
  });

  it('fails closed on a listener that holds this store\'s lock address but never proves the mutex identity', async () => {
    // The store-scoped counterpart of the two tests this replaces, both of
    // which were written against the abandoned shared TCP port band: one
    // demanded that an unrelated store whose hash-derived PORT collided still
    // get its lease, the other that a foreign listener on that port deny the
    // lease. The first is now structural (independent addresses — see
    // `daemon-owner-mutex-collision.test.ts` A/C), the second was the defect
    // itself: a third-party listener could permanently lock a store out.
    // What survives is the part that was always about THIS store: a listener
    // occupying this store's own lock address that never presents the identity
    // contract cannot be proven absent, so the lease stays refused.
    if (process.platform === 'win32') return; // binding a foreign listener at the pipe name needs the win32 branch's own precedent
    const storeDir = await tmpDir('byok-owner-foreign-listener-');
    const canonicalStoreDir = await fs.realpath(storeDir);
    const endpoint = storeMutexEndpoint(canonicalStoreDir, createHash('sha256').update(canonicalStoreDir).digest('hex'));
    const foreign = createServer(() => undefined);
    await fs.mkdir(path.dirname(endpoint), { recursive: true, mode: 0o700 }); // the long-path fallback directory the acquire would have created itself
    await new Promise<void>((resolve, reject) => {
      foreign.once('error', reject);
      foreign.listen(endpoint, () => resolve());
    });
    try {
      await expect(acquireDaemonOwner(storeDir, 'doctor')).rejects.toBeInstanceOf(DaemonOwnerActiveError);
    } finally {
      await new Promise<void>((resolve, reject) => foreign.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('a revoked device halts as device_revoked without retry-looping, then recovers via a fresh pair()', async () => {
    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },  localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter()],
      {} ,
    );

    const record = await daemon.pair('pairing-code');
    await daemon.start();
    await waitForDaemonOpen(daemon);
    expect(daemon.status().lifecycle).toEqual(OPEN_LIFECYCLE);

    server.revokeDevice(record.deviceId);

    await vi.waitFor(() => expect(daemon?.status().lifecycle).toMatchObject({ phase: 'halted', reason: 'device_revoked' }), { timeout: 5000 });
    expect(daemon.status().lifecycle.phase).toBe('halted');

    // Never a retry loop: once revoked, events polls must stop.
    const pollsAfterRevoked = server.httpRequests.filter((request) => request.pathname === '/byok/events').length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.httpRequests.filter((request) => request.pathname === '/byok/events')).toHaveLength(pollsAfterRevoked);

    // Recourse is re-pairing from scratch (same keypair, reused per §6.3) —
    // this must actually recover the device, not just clear the flag.
    await daemon.pair('a-fresh-pairing-code');
    await daemon.start();
    await vi.waitFor(() => expect(daemon?.status().lifecycle).toEqual(OPEN_LIFECYCLE), { timeout: 5000 });
    expect(daemon.status().lifecycle.phase).not.toBe('halted');
  });

  it('#391: a cold start() against an already-revoked device resolves, halts as device_revoked within 5s, and then polls nothing', async () => {
    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },  localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter()],
    );

    const record = await daemon.pair('pairing-code');
    server.revokeDevice(record.deviceId); // revoked before the daemon ever attempts to connect

    // start() reports local startup only; the revocation is a lifecycle fact.
    await daemon.start();
    await vi.waitFor(() => expect(daemon?.status().lifecycle).toMatchObject({ phase: 'halted', reason: 'device_revoked' }), { timeout: 5_000 });

    // Never a retry loop: once halted as revoked, no events polls and no further handshakes.
    const pollsAfterRevoked = server.httpRequests.filter((request) => request.pathname === '/byok/events').length;
    const postsAfterRevoked = server.httpRequests.filter((request) => request.pathname === '/byok/messages').length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.httpRequests.filter((request) => request.pathname === '/byok/events')).toHaveLength(pollsAfterRevoked);
    expect(server.httpRequests.filter((request) => request.pathname === '/byok/messages')).toHaveLength(postsAfterRevoked);
  });
});
