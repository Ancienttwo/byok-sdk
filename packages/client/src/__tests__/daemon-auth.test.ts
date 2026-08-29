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
import { isSqliteAvailable } from '../daemon/journal/sqlite-support';
import { quarantineCorruptOperationalHealth } from '../diagnostics/diagnostics';
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

  it('generates a device keypair on first pair and persists only metadata in device.json', async () => {
    const storeDir = await tmpDir('byok-auth-store-');
    const store = new DeviceStore(storeDir);
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

    await expect(new DeviceStore(storeDir).load()).rejects.toThrow(/not a real regular file|opened safely/);
    expect(JSON.parse(await fs.readFile(outside, 'utf8'))).toMatchObject({ accessToken: 'external-token' });
  });

  it('sends the public key base64url-encoded in the pair request', async () => {
    const storeDir = await tmpDir('byok-auth-store-');
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir) });
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
      store: new DeviceStore(await tmpDir('byok-auth-machine-')),
      machineId: async () => machineId,
    });
    await withProbe.pair('pairing-code');
    withProbe.stop();

    expect(server.pairRequests.at(-1)).toMatchObject({ machineId });

    const withoutProbe = new AuthManager({
      serverUrl: server.url,
      store: new DeviceStore(await tmpDir('byok-auth-machine-none-')),
      machineId: async () => undefined,
    });
    await withoutProbe.pair('pairing-code-2');
    withoutProbe.stop();

    expect('machineId' in server.pairRequests.at(-1)!).toBe(false);

    // No option at all behaves exactly like an unresolved probe.
    const noOption = new AuthManager({
      serverUrl: server.url,
      store: new DeviceStore(await tmpDir('byok-auth-machine-absent-')),
    });
    await noOption.pair('pairing-code-3');
    noOption.stop();

    expect('machineId' in server.pairRequests.at(-1)!).toBe(false);
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
    await auth.loadExisting();
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

  it('waits for an in-flight reactive renewal instead of returning the stale cached token', async () => {
    server.setTokenTtlMs(60 * 60 * 1000);
    const storeDir = await tmpDir('byok-auth-read-during-renewal-');
    const store = new DeviceStore(storeDir);
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
    const store = new DeviceStore(storeDir);
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
    const store = new DeviceStore(storeDir);
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
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
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

  it('a rejected second daemon never arms an uncovered proactive-renewal writer', async () => {
    server.setTokenTtlMs(60 * 60 * 1000);
    const workspaceRoot = await tmpDir('byok-client-owner-auth-workspace-');
    const storeDir = await tmpDir('byok-client-owner-auth-store-');
    const config = { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-owner-auth', serverUrl: server.url, workspaceRoot, storeDir };
    daemon = createDaemonWithAdapters(config, [new StubRuntimeAdapter()]);
    await daemon.pair('pairing-code');
    await daemon.start();
    const before = server.httpRequests.filter((r) => r.pathname === '/byok/challenge').length;

    const rejected = createDaemonWithAdapters(config, [new StubRuntimeAdapter()]);
    await expect(rejected.start()).rejects.toBeInstanceOf(DaemonOwnerActiveError);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.httpRequests.filter((r) => r.pathname === '/byok/challenge')).toHaveLength(before);
    await rejected.stop();
  });

  // The isolated in-memory credential double deliberately has no cross-process
  // persistence. This process-bound SQLite-owner probe continues on a real OS
  // credential-provider run; same-process owner rejection remains covered in
  // this suite without touching a user's credential entry.
  it.skipIf(!isSqliteAvailable() || process.env.BYOK_TEST_DEVICE_CREDENTIAL_STORE === '1')('a separate hosted daemon owns SQLite before any contender can open or quarantine it', async () => {
    const workspaceRoot = await tmpDir('byok-client-hosted-owner-workspace-');
    const storeDir = await tmpDir('byok-client-hosted-owner-store-');
    const config = {
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Test',
      productId: 'test-hosted-owner',
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
      hostedJournal: { mode: 'sqlite' as const },
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
          capabilities: Object.freeze({ steer: true, resume: true, approvalInteractive: false, permissionModes: Object.freeze(['auto', 'confirm', 'deny']) }),
          environmentRequirements: Object.freeze({ credentialNames: Object.freeze([]) }),
        }),
        detect: async () => ({ present: true, version: 'test', authPresent: true }),
        prepare: async () => ({ kind: 'prepared', operation: { start: async () => { throw new Error('not used'); } } }),
      };
      const daemon = createDaemonWithAdapters(config, [adapter]);
      try {
        await daemon.start();
        process.send?.({ kind: 'started' });
      } catch (error) {
        process.send?.({ kind: 'error', message: error instanceof Error ? error.stack : String(error) });
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
        child.once('exit', (code, signal) => reject(new Error(`hosted owner child exited early (${code ?? signal}): ${childStderr}`)));
        child.on('message', (message: unknown) => {
          const shaped = message as { kind?: string; message?: string };
          if (shaped.kind === 'started') resolve();
          if (shaped.kind === 'error') reject(new Error(`hosted owner child failed: ${shaped.message ?? childStderr}`));
        });
      });

      daemon = createDaemonWithAdapters(config, [new StubRuntimeAdapter()]);
      await expect(daemon.start()).rejects.toBeInstanceOf(DaemonOwnerActiveError);
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

  it.skipIf(!isSqliteAvailable())('retains the lease in a real process when a post-open SQLite fault cannot prove handle cleanup', async () => {
    const workspaceRoot = await tmpDir('byok-client-open-cleanup-workspace-');
    const storeDir = await tmpDir('byok-client-open-cleanup-store-');
    const config = {
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Test',
      productId: 'test-open-cleanup-owner',
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
      hostedJournal: { mode: 'sqlite' as const },
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
          capabilities: Object.freeze({ steer: true, resume: true, approvalInteractive: false, permissionModes: Object.freeze(['auto', 'confirm', 'deny']) }),
          environmentRequirements: Object.freeze({ credentialNames: Object.freeze([]) }),
        }),
        detect: async () => ({ present: true, version: 'test', authPresent: true }),
        prepare: async () => ({ kind: 'prepared', operation: { start: async () => { throw new Error('not used'); } } }),
      };
      const daemon = createDaemonWithAdapters(config, [adapter], {
        hostedJournal: {
          openFaults: {
            onStep(step) {
              if (step === 'after-open') throw new Error('injected post-open failure');
            },
            close(db) {
              db.close();
              throw new Error('injected close-report failure');
            },
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
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-unpair-lease', serverUrl: server.url, workspaceRoot, storeDir },
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
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-pair-queue', serverUrl: server.url, workspaceRoot, storeDir },
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
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-pair-start', serverUrl: server.url, workspaceRoot, storeDir },
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
      expect(daemon.status().connected).toBe(true);
    } finally {
      releaseSave();
      save.mockRestore();
    }
  });

  it('serializes stop behind an in-flight pair and releases only after its credential write', async () => {
    const workspaceRoot = await tmpDir('byok-client-pair-stop-workspace-');
    const storeDir = await tmpDir('byok-client-pair-stop-store-');
    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-pair-stop', serverUrl: server.url, workspaceRoot, storeDir },
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
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-pair-unpair', serverUrl: server.url, workspaceRoot, storeDir },
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
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-unpair-fifo', serverUrl: server.url, workspaceRoot, storeDir },
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

  it('a revoked device surfaces status().revoked without retry-looping, then recovers via a fresh pair()', async () => {
    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-');
    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
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
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
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
