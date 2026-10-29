import { testScratchRoot } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthManager, DeviceRevokedError } from '../daemon/auth-manager';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import {
  DeviceCredentialCommandAbortedError,
  DeviceCredentialStore,
  type DeviceCommandResult,
  type DeviceCommandRunner,
  runDeviceCommand,
} from '../daemon/device-credential-store';
import { DeviceStore } from '../daemon/store';
import { createTestDeviceStore } from './fixtures/device-credentials';
import { OPEN_LIFECYCLE, waitForDaemonOpen } from './fixtures/lifecycle-barrier';
import { type RealServerHandle, startRealServer } from './fixtures/real-server';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const OK: DeviceCommandResult = { exitCode: 0, stdout: '', stderr: '' };

/**
 * A `secret-tool` stand-in for the production DeviceCredentialStore. While
 * `hangWrites` is set, `store` never answers until its signal aborts, as a
 * locked keyring waiting on an unlock prompt does.
 */
function linuxKeyring() {
  let value: string | undefined;
  const state = { hangWrites: false, hungWrites: 0 };
  let writeHung!: () => void;
  const hung = new Promise<void>((resolve) => { writeHung = resolve; });
  const run: DeviceCommandRunner = async (_executable, args, stdin, signal) => {
    if (args[0] === 'lookup') return value === undefined ? { exitCode: 1, stdout: '', stderr: '' } : { ...OK, stdout: value };
    if (args[0] === 'clear') { value = undefined; return OK; }
    if (state.hangWrites) {
      state.hungWrites += 1;
      writeHung();
      return new Promise<DeviceCommandResult>((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    value = stdin;
    return OK;
  };
  return { run, state, hung };
}

/** Answers the routes in `inject` in place of the server; every other request passes through. */
function interceptAuthRoutes(inject: (pathname: string, call: number) => Response | undefined): Map<string, number> {
  const nativeFetch = globalThis.fetch;
  const calls = new Map<string, number>();
  vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const { pathname } = new URL(input instanceof Request ? input.url : String(input));
    const call = (calls.get(pathname) ?? 0) + 1;
    calls.set(pathname, call);
    return inject(pathname, call) ?? nativeFetch(input, init);
  }) as typeof fetch);
  return calls;
}

const untyped401 = (error: string) => new Response(JSON.stringify({ error }), { status: 401, headers: { 'content-type': 'application/json' } });

describe('#1117 renewal 401: only the typed body is revocation', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await TestServer.start();
    server.setTokenTtlMs(60 * 60 * 1000);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await server.close();
  });

  it('an untyped 401 backs off, rechecks once, and renews without halting', async () => {
    const onRevoked = vi.fn();
    const auth = new AuthManager({ serverUrl: server.url, store: createTestDeviceStore(await tmpDir('byok-untyped-401-')), onRevoked });
    const record = await auth.pair('pairing-code');
    const calls = interceptAuthRoutes((pathname, call) => (pathname === '/byok/challenge' && call === 1 ? untyped401('upstream proxy said no') : undefined));

    const startedAt = performance.now();
    const renewed = await auth.handleUnauthorized();

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(renewed).toBe(server.currentAccessToken(record.deviceId));
    expect(calls.get('/byok/challenge')).toBe(2);
    expect(auth.isRevoked()).toBe(false);
    expect(onRevoked).not.toHaveBeenCalled();
    await auth.stop();
  });

  it('an untyped 401 that the recheck meets again halts as revoked', async () => {
    const onRevoked = vi.fn();
    const auth = new AuthManager({ serverUrl: server.url, store: createTestDeviceStore(await tmpDir('byok-untyped-401-twice-')), onRevoked });
    await auth.pair('pairing-code');
    const calls = interceptAuthRoutes((pathname) => (pathname === '/byok/token' ? untyped401('invalid signature') : undefined));

    await expect(auth.handleUnauthorized()).rejects.toBeInstanceOf(DeviceRevokedError);

    expect(calls.get('/byok/challenge')).toBe(2);
    expect(calls.get('/byok/token')).toBe(2);
    expect(auth.isRevoked()).toBe(true);
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });

  it('a 401 whose body only resembles the typed one by message text is untyped', async () => {
    const auth = new AuthManager({ serverUrl: server.url, store: createTestDeviceStore(await tmpDir('byok-401-text-')) });
    await auth.pair('pairing-code');
    const calls = interceptAuthRoutes((pathname, call) => (pathname === '/byok/challenge' && call === 1
      ? untyped401('device_not_registered: unknown or revoked device')
      : undefined));

    await auth.handleUnauthorized();

    expect(calls.get('/byok/challenge')).toBe(2);
    expect(auth.isRevoked()).toBe(false);
    await auth.stop();
  });

  it('stop() during the back-off returns at once and leaves the device unrevoked', async () => {
    const auth = new AuthManager({ serverUrl: server.url, store: createTestDeviceStore(await tmpDir('byok-401-backoff-stop-')) });
    await auth.pair('pairing-code');
    const calls = interceptAuthRoutes((pathname) => (pathname === '/byok/challenge' ? untyped401('transient') : undefined));

    const renewal = auth.handleUnauthorized();
    const rejected = expect(renewal).rejects.toMatchObject({ name: 'AuthRequestAbortedError', reason: 'stopped' });
    await vi.waitFor(() => expect(calls.get('/byok/challenge')).toBe(1));
    const stoppedAt = performance.now();
    await auth.stop();

    expect(performance.now() - stoppedAt).toBeLessThan(500);
    await rejected;
    expect(calls.get('/byok/challenge')).toBe(1);
    expect(auth.isRevoked()).toBe(false);
  });

  it('the typed body halts at once with no recheck', async () => {
    const auth = new AuthManager({ serverUrl: server.url, store: createTestDeviceStore(await tmpDir('byok-typed-401-')) });
    const record = await auth.pair('pairing-code');
    const calls = interceptAuthRoutes(() => undefined);
    server.revokeDevice(record.deviceId);

    const startedAt = performance.now();
    await expect(auth.handleUnauthorized()).rejects.toBeInstanceOf(DeviceRevokedError);

    expect(performance.now() - startedAt).toBeLessThan(900);
    expect(calls.get('/byok/challenge')).toBe(1);
    expect(auth.isRevoked()).toBe(true);
  });
});

describe('#1117 typed revocation end to end against the reference server', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    real = await startRealServer({ productId: 'test-product' });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await daemon?.stop();
    daemon = undefined;
    await real.close();
  });

  it('a revoked device renewing against the cloud auth handlers halts on its first challenge', async () => {
    const auth = new AuthManager({ serverUrl: real.url, store: createTestDeviceStore(await tmpDir('byok-real-typed-401-')) });
    const record = await auth.pair((await real.createPairingCode()).code);
    const calls = interceptAuthRoutes(() => undefined);
    await real.byok.devices.revoke(record.deviceId);

    await expect(auth.handleUnauthorized()).rejects.toBeInstanceOf(DeviceRevokedError);

    expect(calls.get('/byok/challenge')).toBe(1);
    expect(calls.get('/byok/token')).toBeUndefined();
    expect(auth.isRevoked()).toBe(true);
  });

  it('a running daemon whose device is revoked halts as device_revoked with no recheck', async () => {
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, storeDir: await tmpDir('byok-real-typed-daemon-') },
      [new StubRuntimeAdapter()],
    );
    const record = await daemon.pair((await real.createPairingCode()).code);
    await daemon.start();
    await waitForDaemonOpen(daemon);
    const calls = interceptAuthRoutes(() => undefined);

    await real.byok.devices.revoke(record.deviceId);

    await vi.waitFor(() => expect(daemon?.status().lifecycle).toMatchObject({ phase: 'halted', reason: 'device_revoked' }), { timeout: 5_000 });
    expect(calls.get('/byok/challenge')).toBe(1);
  });
});

describe('#1117 keychain command deadline and cancellation', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  it('a hung keychain write fails the renewal with a typed error after its deadline and keeps the prior record', async () => {
    server.setTokenTtlMs(60 * 60 * 1000);
    const keyring = linuxKeyring();
    const storeDir = await tmpDir('byok-keychain-deadline-');
    const credentials = new DeviceCredentialStore({ storeDir, productId: 'test-product', platform: 'linux', commandRunner: keyring.run, commandDeadlineMs: 200 });
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir, credentials) });
    const record = await auth.pair('pairing-code');
    keyring.state.hangWrites = true;

    const startedAt = performance.now();
    const error: unknown = await auth.handleUnauthorized().catch((caught: unknown) => caught);

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(error).toBeInstanceOf(DeviceCredentialCommandAbortedError);
    expect(error).toMatchObject({ reason: 'deadline' });
    expect(auth.isRevoked()).toBe(false);
    expect((await credentials.read())?.accessToken).toBe(record.accessToken);
    await auth.stop();
  });

  it('stop() cancels a hung keychain write well before its deadline', async () => {
    server.setTokenTtlMs(60 * 60 * 1000);
    const keyring = linuxKeyring();
    const storeDir = await tmpDir('byok-keychain-stop-');
    const credentials = new DeviceCredentialStore({ storeDir, productId: 'test-product', platform: 'linux', commandRunner: keyring.run });
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir, credentials) });
    await auth.pair('pairing-code');
    keyring.state.hangWrites = true;

    const renewal = auth.handleUnauthorized().catch((caught: unknown) => caught);
    await keyring.hung;
    const stoppedAt = performance.now();
    await auth.stop();

    expect(performance.now() - stoppedAt).toBeLessThan(500);
    expect(await renewal).toMatchObject({ name: 'DeviceCredentialCommandAbortedError', reason: 'cancelled' });
  });

  it('daemon.stop() cancels a start hung in its startup keychain read and kills the child', async () => {
    server.setTokenTtlMs(60 * 60 * 1000);
    const keyring = linuxKeyring();
    const storeDir = await tmpDir('byok-keychain-startup-stop-');
    const pidFile = path.join(storeDir, 'hung-read.pid');
    let hangReads = false;
    let readHung!: () => void;
    const hung = new Promise<void>((resolve) => { readHung = resolve; });
    // A real provider child that never answers stands in for a keychain lookup blocked on an unlock prompt.
    const run: DeviceCommandRunner = (executable, args, stdin, signal) => {
      if (!hangReads || args[0] !== 'lookup') return keyring.run(executable, args, stdin, signal);
      const child = runDeviceCommand(
        process.execPath,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`],
        undefined,
        signal,
      );
      readHung();
      return child;
    };
    const commandDeadlineMs = 10_000;
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: server.url, storeDir },
      [new StubRuntimeAdapter()],
      { deviceCredentials: new DeviceCredentialStore({ storeDir, productId: 'test-product', platform: 'linux', commandRunner: run, commandDeadlineMs }) },
    );
    await daemon.pair('pairing-code');
    // A fresh daemon of the same store, as after a process restart: its start must read the keychain.
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: server.url, storeDir },
      [new StubRuntimeAdapter()],
      { deviceCredentials: new DeviceCredentialStore({ storeDir, productId: 'test-product', platform: 'linux', commandRunner: run, commandDeadlineMs }) },
    );
    hangReads = true;
    const started = daemon.start().then(() => undefined, (error: unknown) => error);
    await hung;
    await vi.waitFor(() => fs.access(pidFile));

    const stoppedAt = performance.now();
    await daemon.stop();
    daemon = undefined;

    expect(performance.now() - stoppedAt).toBeLessThan(2_000);
    const outcome = await started;
    expect(outcome).toBeInstanceOf(DeviceCredentialCommandAbortedError);
    expect(outcome).toMatchObject({ reason: 'cancelled' });
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' })));
  });

  it('daemon.stop() cancels a pair hung in its keychain write', async () => {
    const keyring = linuxKeyring();
    const storeDir = await tmpDir('byok-keychain-pair-stop-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: server.url, storeDir },
      [new StubRuntimeAdapter()],
      { deviceCredentials: new DeviceCredentialStore({ storeDir, productId: 'test-product', platform: 'linux', commandRunner: keyring.run }) },
    );
    keyring.state.hangWrites = true;
    const paired = daemon.pair('pairing-code').then(() => undefined, (error: unknown) => error);
    await keyring.hung;

    const stoppedAt = performance.now();
    await daemon.stop();
    daemon = undefined;

    // The default per-command deadline is 15s; returning well inside it proves cancellation.
    expect(performance.now() - stoppedAt).toBeLessThan(2_000);
    expect(await paired).toMatchObject({ name: 'DeviceCredentialCommandAbortedError', reason: 'cancelled' });
    expect(server.httpRequests.filter((request) => request.pathname === '/byok/pair')).toHaveLength(0);
  });

  it('daemon.stop() returns in time while a renewal is stuck in a hung keychain write', async () => {
    // Just over the 60s renewal margin: the proactive renewal fires ~1s after start.
    server.setTokenTtlMs(61_000);
    const keyring = linuxKeyring();
    const storeDir = await tmpDir('byok-keychain-daemon-stop-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: server.url, storeDir },
      [new StubRuntimeAdapter()],
      { deviceCredentials: new DeviceCredentialStore({ storeDir, productId: 'test-product', platform: 'linux', commandRunner: keyring.run }) },
    );
    await daemon.pair('pairing-code');
    // Armed before start: under load the first renewal can fire before open.
    keyring.state.hangWrites = true;
    await daemon.start();
    await waitForDaemonOpen(daemon);
    expect(daemon.status().lifecycle).toEqual(OPEN_LIFECYCLE);
    await keyring.hung;

    const stoppedAt = performance.now();
    await daemon.stop();
    daemon = undefined;

    // The default per-command deadline is 15s; returning well inside it proves cancellation.
    expect(performance.now() - stoppedAt).toBeLessThan(3_000);
    expect(keyring.state.hungWrites).toBe(1);
  });
});
