import { testScratchRoot } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig, type EmbeddedPairingServer } from '../daemon/create-daemon';
import { DaemonHaltError } from '../daemon/daemon-lifecycle';
import { DeviceRecordRePairRequiredError, DeviceStore, readDeviceEnrollmentIdentity, readDeviceEnrollmentStatus } from '../daemon/store';
import { DeviceStoreBindingMismatchError, FirstPairingAttemptRefusedError } from '../daemon/daemon-errors';
import { acquireEnrollmentGate } from '../daemon/enrollment-gate';
import { acquirePathMutationGate, type PathMutationGate } from '../util/path-mutation-gate';
import { createTestDeviceStore, InMemoryDeviceCredentialBackend } from './fixtures/device-credentials';
import { testDeviceCredentials } from './fixtures/credential-backend';
import { clearDeviceEnrollment, DeviceEnrollmentClearError } from '../daemon/enrollment-clear';
import { repairDeviceEnrollmentMetadata } from '../diagnostics/device-doctor';
import { connectControlClient } from '../daemon/control-client';
import { OPEN_LIFECYCLE, waitForDaemonOpen } from './fixtures/lifecycle-barrier';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

vi.mock('../daemon/control-client', () => ({ connectControlClient: vi.fn() }));
vi.mock('../util/path-mutation-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../util/path-mutation-gate')>();
  return { ...actual, acquirePathMutationGate: vi.fn(actual.acquirePathMutationGate) };
});
vi.mock('../daemon/enrollment-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon/enrollment-gate')>();
  return { acquireEnrollmentGate: vi.fn(actual.acquireEnrollmentGate) };
});

/**
 * #1094 pairing binding. The unit-suite credential backend is keyed by
 * productId alone, exactly as the OS entry is (`serviceFor(productId)`), so
 * two storeDirs of one productId share it here as they do in production.
 */
describe('#1094 a storeDir only uses the enrollment it paired', () => {
  let server: TestServer;
  const daemons: Daemon[] = [];
  let productId: string;

  beforeEach(async () => {
    server = await TestServer.start();
    productId = `binding-${randomUUID()}`;
    vi.mocked(connectControlClient).mockResolvedValue({ ok: false, reason: 'offline' });
  });

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
    await server.close();
    vi.restoreAllMocks();
  });

  async function storeConfig(): Promise<DaemonConfig> {
    return {
      storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test',
      productId, serverUrl: server.url, storeDir: await fs.mkdtemp(path.join(os.tmpdir(), 'byok-binding-store-')),
    };
  }

  function daemonFor(config: DaemonConfig): Daemon {
    const daemon = createDaemonWithAdapters(config, [new StubRuntimeAdapter()]);
    daemons.push(daemon);
    return daemon;
  }

  async function startRejection(daemon: Daemon): Promise<unknown> {
    return daemon.start().then(() => undefined, (error: unknown) => error);
  }

  it('a normally paired store starts unchanged', async () => {
    const config = await storeConfig();
    const daemon = daemonFor(config);
    const { deviceId } = await daemon.pair('pairing-code');
    await daemon.start();
    await waitForDaemonOpen(daemon);

    expect(daemon.status().lifecycle).toEqual(OPEN_LIFECYCLE);
    expect(await readDeviceEnrollmentStatus(config)).toEqual({ state: 'paired', deviceId });
  });

  it('a second storeDir of the same productId gets the typed error and adopts nothing', async () => {
    const first = await storeConfig();
    const { deviceId } = await daemonFor(first).pair('pairing-code');
    const second = await storeConfig();

    const statusError: unknown = await readDeviceEnrollmentStatus(second).catch((error: unknown) => error);
    expect(statusError).toBeInstanceOf(DeviceStoreBindingMismatchError);
    expect(statusError).toMatchObject({ code: 'device_store_not_bound', stored: { deviceId }, bound: undefined });

    const halted = await startRejection(daemonFor(second));
    expect(halted).toBeInstanceOf(DaemonHaltError);
    expect(halted).toMatchObject({ reason: 'store_not_bound' });
    await expect(fs.access(path.join(second.storeDir!, 'device.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readDeviceEnrollmentStatus(first)).toEqual({ state: 'paired', deviceId });
  });

  it('a missing device.json is the typed error; the doctor action restores the same device', async () => {
    const config = await storeConfig();
    const daemon = daemonFor(config);
    const { deviceId } = await daemon.pair('pairing-code');
    const identity = await readDeviceEnrollmentIdentity(config);
    if (identity.state !== 'paired') throw new Error('expected a paired identity');
    await fs.unlink(path.join(config.storeDir!, 'device.json'));

    // A fresh process: the pairing daemon still caches its own record.
    expect(await startRejection(daemonFor(config))).toMatchObject({ reason: 'store_not_bound' });
    await expect(fs.access(path.join(config.storeDir!, 'device.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    expect(await repairDeviceEnrollmentMetadata(config, {
      confirmed: true, expectedDeviceId: identity.deviceId, expectedTenantId: identity.tenantId,
    })).toMatchObject({ status: 'repaired' });
    const restarted = daemonFor(config);
    await restarted.start();
    await waitForDaemonOpen(restarted);
    expect(await readDeviceEnrollmentStatus(config)).toEqual({ state: 'paired', deviceId });
  });

  it('pairing over another store\'s enrollment refuses without --replace-other-store and replaces with it', async () => {
    const first = await storeConfig();
    const { deviceId: firstDeviceId } = await daemonFor(first).pair('pairing-code');
    const second = await storeConfig();
    const secondDaemon = daemonFor(second);

    const refused: unknown = await secondDaemon.pair('pairing-code').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DeviceStoreBindingMismatchError);
    expect(refused).toMatchObject({ stored: { deviceId: firstDeviceId } });
    expect(String((refused as Error).message)).not.toMatch(/BEGIN|accessToken|token/u);
    expect(await readDeviceEnrollmentStatus(first)).toEqual({ state: 'paired', deviceId: firstDeviceId });

    const { deviceId: secondDeviceId } = await secondDaemon.pair('pairing-code', { replaceOtherStore: true });
    expect(secondDeviceId).not.toBe(firstDeviceId);
    expect(await readDeviceEnrollmentStatus(second)).toEqual({ state: 'paired', deviceId: secondDeviceId });
    // The first store is now bound to a device the OS entry no longer holds.
    expect(await readDeviceEnrollmentStatus(first).catch((error: unknown) => error)).toMatchObject({
      code: 'device_store_not_bound', stored: { deviceId: secondDeviceId }, bound: { deviceId: firstDeviceId },
    });
  });

  it('a daemon that cached its record still revalidates the binding at start', async () => {
    const first = await storeConfig();
    const firstDaemon = daemonFor(first);
    await firstDaemon.pair('pairing-code');
    const second = await storeConfig();
    await daemonFor(second).pair('pairing-code', { replaceOtherStore: true });
    expect(await readDeviceEnrollmentStatus(first).catch((error: unknown) => error)).toMatchObject({ code: 'device_store_not_bound' });

    const started = await startRejection(firstDaemon);

    expect(started).toBeInstanceOf(DaemonHaltError);
    expect(started).toMatchObject({ reason: 'store_not_bound' });
    expect(firstDaemon.status().lifecycle.phase).not.toBe('running');
  });

  it('unpair from a store that did not pair the enrollment fails closed and leaves it in place', async () => {
    const first = await storeConfig();
    const { deviceId } = await daemonFor(first).pair('pairing-code');
    const second = await storeConfig();

    await expect(daemonFor(second).unpair()).rejects.toBeInstanceOf(DeviceStoreBindingMismatchError);
    expect(await readDeviceEnrollmentStatus(first)).toEqual({ state: 'paired', deviceId });
  });

  describe('renewal and pairing take the enrollment lock (#2034)', () => {
    // Strictly under the 10 s test timeout, so each test settles and restores its mocks before the next starts.
    const settle = { timeout: 5_000 };
    const within = <T>(promise: Promise<T>): Promise<T> => Promise.race([
      promise,
      new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('barrier not reached')), settle.timeout).unref(); }),
    ]);

    async function trackGate() {
      const { acquireEnrollmentGate: acquire } = await vi.importActual<typeof import('../daemon/enrollment-gate')>('../daemon/enrollment-gate');
      const gate = {
        held: 0,
        taken: 0,
        onWait: undefined as (() => void) | undefined,
        restore: () => { vi.mocked(acquireEnrollmentGate).mockReset().mockImplementation(acquire); },
      };
      vi.mocked(acquireEnrollmentGate).mockImplementation(async (id, signal) => {
        gate.onWait?.();
        const acquired = await acquire(id, signal);
        gate.held += 1;
        gate.taken += 1;
        return { ...acquired, release: async () => { gate.held -= 1; await acquired.release(); } };
      });
      return gate;
    }

    it('a running daemon whose enrollment another store replaced halts as store_not_bound on renewal and writes nothing', async () => {
      const first = await storeConfig();
      const firstDaemon = daemonFor(first);
      const { deviceId: firstDeviceId } = await firstDaemon.pair('pairing-code');
      await firstDaemon.start();
      await waitForDaemonOpen(firstDaemon);
      const second = await storeConfig();
      const { deviceId } = await daemonFor(second).pair('pairing-code', { replaceOtherStore: true });

      server.rotateDeviceToken(firstDeviceId);

      await vi.waitFor(() => expect(firstDaemon.status().lifecycle).toMatchObject({ phase: 'halted', reason: 'store_not_bound' }), settle);
      expect(await readDeviceEnrollmentStatus(second)).toEqual({ state: 'paired', deviceId });
    });

    it('a renewal waiting on another store\'s clear does not restore the cleared credential and halts as re_pair_required', async () => {
      const first = await storeConfig();
      const firstDaemon = daemonFor(first);
      const { deviceId: firstDeviceId } = await firstDaemon.pair('pairing-code');
      await firstDaemon.start();
      await waitForDaemonOpen(firstDaemon);
      const second = await storeConfig();
      await daemonFor(second).pair('pairing-code', { replaceOtherStore: true });
      const credentials = testDeviceCredentials(productId);
      const gate = await trackGate();
      let renewalArrived!: () => void;
      const arrived = new Promise<void>((resolve) => { renewalArrived = resolve; });
      const deleteEntry = credentials.clear.bind(credentials);
      const write = credentials.replace.bind(credentials);
      vi.spyOn(credentials, 'replace').mockImplementation(async (record) => { renewalArrived(); return write(record); });
      vi.spyOn(credentials, 'clear').mockImplementationOnce(async () => {
        const taken = gate.taken;
        gate.onWait = renewalArrived;
        server.rotateDeviceToken(firstDeviceId);
        // Released once the renewal has either written or is waiting on the gate this clear holds.
        await within(arrived);
        gate.onWait = undefined;
        expect(gate.taken).toBe(taken);
        return deleteEntry();
      });

      try {
        await clearDeviceEnrollment({ productId, storeDir: second.storeDir! }, { deviceCredentials: credentials });
        await vi.waitFor(() => expect(firstDaemon.status().lifecycle).toMatchObject({ phase: 'halted', reason: 're_pair_required' }), settle);
        // Completion barrier: the renewal has released the gate.
        await vi.waitFor(() => expect(gate.held).toBe(0), settle);
      } finally {
        gate.restore();
      }
      expect(await credentials.read()).toBeUndefined();
    });

    it('holds the lock across a pairing request (#2045 F1) and never across a renewal request', async () => {
      const config = await storeConfig();
      const daemon = daemonFor(config);
      const gate = await trackGate();
      const send = globalThis.fetch;
      const requests: Array<{ readonly path: string; readonly held: number }> = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        requests.push({ path: new URL(String(input instanceof Request ? input.url : input)).pathname, held: gate.held });
        return send(input, init);
      });

      try {
        const { deviceId } = await daemon.pair('pairing-code');
        await daemon.start();
        await waitForDaemonOpen(daemon);
        server.rotateDeviceToken(deviceId);
        // Completion barrier: the pairing's and the renewal's gates were both taken and released.
        await vi.waitFor(() => {
          expect(requests.some((request) => request.path === '/byok/token')).toBe(true);
          expect(gate.taken).toBeGreaterThanOrEqual(2);
          expect(gate.held).toBe(0);
        }, settle);
      } finally {
        gate.restore();
      }
      expect(requests.filter((request) => request.path === '/byok/pair').map((request) => request.held)).toEqual([1]);
      expect(requests.filter((request) => request.path !== '/byok/pair' && request.held > 0)).toEqual([]);
    });

    it('an aborted caller starts no acquisition', async () => {
      vi.mocked(acquirePathMutationGate).mockClear();

      await expect(acquireEnrollmentGate(`gate-${randomUUID()}`, AbortSignal.abort())).rejects.toThrow();

      expect(acquirePathMutationGate).not.toHaveBeenCalled();
    });

    it('a caller aborted while waiting releases the gate its acquisition obtains later', async () => {
      const id = `gate-${randomUUID()}`;
      const holder = await acquireEnrollmentGate(id);
      vi.mocked(acquirePathMutationGate).mockClear();
      const controller = new AbortController();
      const waiting = acquireEnrollmentGate(id, controller.signal);
      controller.abort();
      await expect(waiting).rejects.toThrow();
      const abandoned = vi.mocked(acquirePathMutationGate).mock.results[0]!.value as Promise<PathMutationGate>;

      await holder.release();
      const late = await within(abandoned);

      const next = await acquirePathMutationGate({ scope: late.scope as `device-enrollment:${string}` }, { waitMs: 1_000 });
      await next.release();
    });
  });

  describe('clearDeviceEnrollment clears a store without a daemon (#1841)', () => {
    const clear = (config: DaemonConfig) =>
      clearDeviceEnrollment({ productId, storeDir: config.storeDir! }, { deviceCredentials: testDeviceCredentials(productId) });

    it('clears a paired store, and a second call succeeds', async () => {
      const config = await storeConfig();
      await daemonFor(config).pair('pairing-code');

      await clear(config);

      expect(await testDeviceCredentials(productId).read()).toBeUndefined();
      expect(await readDeviceEnrollmentStatus(config)).toEqual({ state: 'unpaired' });
      await clear(config);
    });

    it('refuses with store_owned while a daemon holds the store and leaves the enrollment', async () => {
      const config = await storeConfig();
      const daemon = daemonFor(config);
      const { deviceId } = await daemon.pair('pairing-code');
      await daemon.start();
      await waitForDaemonOpen(daemon);

      const refused: unknown = await clear(config).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(DeviceEnrollmentClearError);
      expect(refused).toMatchObject({ code: 'store_owned' });
      expect(await readDeviceEnrollmentStatus(config)).toEqual({ state: 'paired', deviceId });
    });

    it('refuses with store_not_bound on another store\'s enrollment and leaves it', async () => {
      const first = await storeConfig();
      const { deviceId } = await daemonFor(first).pair('pairing-code');

      const refused: unknown = await clear(await storeConfig()).catch((error: unknown) => error);

      expect(refused).toMatchObject({ code: 'store_not_bound', cause: expect.any(DeviceStoreBindingMismatchError) });
      expect(await readDeviceEnrollmentStatus(first)).toEqual({ state: 'paired', deviceId });
    });

    it('refuses a store whose device.json cannot be parsed before deleting anything', async () => {
      const first = await storeConfig();
      const { deviceId } = await daemonFor(first).pair('pairing-code');
      const second = await storeConfig();
      await fs.writeFile(path.join(second.storeDir!, 'device.json'), 'not json');

      const refused: unknown = await clear(second).catch((error: unknown) => error);

      expect(refused).toMatchObject({ code: 'clear_failed', cause: expect.any(DeviceRecordRePairRequiredError) });
      expect(await readDeviceEnrollmentStatus(first)).toEqual({ state: 'paired', deviceId });
    });

    // A pairing whose server cannot be reached keeps its staged attempt, as after a lost response.
    const unreachable = (config: DaemonConfig): DaemonConfig => ({ ...config, serverUrl: 'http://127.0.0.1:1' });

    it.each(['credential', 'staged attempt'] as const)('another store pairing between the validation and the deletion keeps its %s (#1964)', async (kept) => {
      const first = await storeConfig();
      await daemonFor(first).pair('pairing-code');
      const second = await storeConfig();
      const secondDaemon = daemonFor(kept === 'credential' ? second : unreachable(second));
      const credentials = testDeviceCredentials(productId);
      const deleteEntry = credentials.clear.bind(credentials);
      const { acquireEnrollmentGate: acquire } = await vi.importActual<typeof import('../daemon/enrollment-gate')>('../daemon/enrollment-gate');
      let held = 0;
      let inWindow = false;
      let reachedGate!: () => void;
      const pairingAtGate = new Promise<void>((resolve) => { reachedGate = resolve; });
      vi.mocked(acquireEnrollmentGate).mockImplementation(async (id) => {
        if (inWindow) reachedGate();
        const gate = await acquire(id);
        held += 1;
        return { ...gate, release: async () => { held -= 1; await gate.release(); } };
      });
      let pairing: Promise<unknown> = Promise.resolve();
      vi.spyOn(credentials, 'clear').mockImplementationOnce(async () => {
        // The clear holds the productId gate from its validation to here.
        expect(held).toBe(1);
        inWindow = true;
        pairing = secondDaemon.pair('pairing-code', { replaceOtherStore: true }).catch((error: unknown) => error);
        // Released once the pairing has either written in this window or is waiting on the held gate.
        await Promise.race([pairing, pairingAtGate]);
        return deleteEntry();
      });

      try {
        await clear(first);
        await pairing;
      } finally {
        vi.mocked(acquireEnrollmentGate).mockImplementation(acquire);
      }

      if (kept === 'credential') expect(await readDeviceEnrollmentStatus(second)).toMatchObject({ state: 'paired' });
      else expect(await credentials.readFirstPairingAttempt()).toBeDefined();
    });

    it('refuses another store\'s staged first pairing with store_not_bound and leaves it (#1964)', async () => {
      await expect(daemonFor(unreachable(await storeConfig())).pair('pairing-code')).rejects.toThrow();
      const credentials = testDeviceCredentials(productId);

      expect(await clear(await storeConfig()).catch((error: unknown) => error)).toMatchObject({ code: 'store_not_bound' });
      expect(await credentials.readFirstPairingAttempt()).toBeDefined();
    });

    it('an unpaired store clears the first pairing it staged (#1964, #1767)', async () => {
      const staging = await storeConfig();
      await expect(daemonFor(unreachable(staging)).pair('pairing-code')).rejects.toThrow();
      const credentials = testDeviceCredentials(productId);
      const own = new DeviceStore(productId, DeviceStore.resolveDir(productId, staging.storeDir), credentials).identity;
      expect((await credentials.readFirstPairingAttempt())?.storeIdentity).toMatch(/^[0-9a-f]{64}$/u);
      expect((await credentials.readFirstPairingAttempt())?.storeIdentity).toBe(own);

      await clear(staging);
      expect(await credentials.readFirstPairingAttempt()).toBeUndefined();
    });

    it.each(['another store', 'no store'] as const)('pairing refuses a staged first pairing of %s and leaves it (#2033)', async (owner) => {
      const credentials = testDeviceCredentials(productId);
      if (owner === 'another store') await expect(daemonFor(unreachable(await storeConfig())).pair('pairing-code')).rejects.toThrow();
      else await credentials.saveFirstPairingAttempt({ kind: 'first-pairing-attempt-v1', deviceName: 'legacy', devicePublicKey: 'legacy-public-key', devicePrivateKeyPem: 'legacy-private-key' });
      const staged = await credentials.readFirstPairingAttempt();

      const refused: unknown = await daemonFor(await storeConfig()).pair('pairing-code').catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(FirstPairingAttemptRefusedError);
      expect(refused).toMatchObject({ code: owner === 'another store' ? 'store_not_bound' : 'pairing_attempt_unattributed' });
      expect(await credentials.readFirstPairingAttempt()).toEqual(staged);
    });

    it('refuses a staged first pairing that names no store unless told to clear it (#1964)', async () => {
      const config = await storeConfig();
      const credentials = testDeviceCredentials(productId);
      await credentials.saveFirstPairingAttempt({
        kind: 'first-pairing-attempt-v1', deviceName: 'legacy', devicePublicKey: 'legacy-public-key', devicePrivateKeyPem: 'legacy-private-key',
      });

      expect(await clear(config).catch((error: unknown) => error)).toMatchObject({ code: 'pairing_attempt_unattributed' });
      expect(await credentials.readFirstPairingAttempt()).toBeDefined();

      await clearDeviceEnrollment({ productId, storeDir: config.storeDir!, clearUnattributedAttempt: true }, { deviceCredentials: credentials });
      expect(await credentials.readFirstPairingAttempt()).toBeUndefined();
    });

    it('Daemon.unpair reports a credential that cannot be deleted as clear_failed and stays paired', async () => {
      const config = await storeConfig();
      const credentials = new InMemoryDeviceCredentialBackend();
      const daemon = createDaemonWithAdapters(config, [new StubRuntimeAdapter()], { deviceCredentials: credentials });
      daemons.push(daemon);
      const { deviceId } = await daemon.pair('pairing-code');
      const providerError = new Error('provider refused');
      vi.spyOn(credentials, 'clear').mockRejectedValueOnce(providerError);

      const failed: unknown = await daemon.unpair().catch((error: unknown) => error);

      expect(failed).toBeInstanceOf(DeviceEnrollmentClearError);
      expect(failed).toMatchObject({ code: 'clear_failed', cause: providerError });
      expect((await credentials.read())?.deviceId).toBe(deviceId);
    });
  });

  describe('pairEmbedded reconciles the enrollment with the in-process server (#1840)', () => {
    function embeddedServer(deviceIds: string[]): EmbeddedPairingServer & { codes: number } {
      const server = {
        codes: 0,
        pairing: { createPairingCode: async () => { server.codes += 1; return { code: 'pairing-code' }; } },
        machines: { list: async () => deviceIds.map((deviceId) => ({ deviceId })) },
      };
      return server;
    }

    async function refusal(daemon: Daemon, server: EmbeddedPairingServer): Promise<unknown> {
      return daemon.pairEmbedded(server).then(() => undefined, (error: unknown) => error);
    }

    it('an unpaired store against an empty server pairs', async () => {
      const config = await storeConfig();
      const server = embeddedServer([]);
      const { deviceId } = await daemonFor(config).pairEmbedded(server);
      expect(server.codes).toBe(1);
      expect(await readDeviceEnrollmentStatus(config)).toEqual({ state: 'paired', deviceId });
    });

    it('an unpaired store against a server with devices refuses with enrollment_missing and writes nothing', async () => {
      const config = await storeConfig();
      const server = embeddedServer(['another-device']);
      expect(await refusal(daemonFor(config), server)).toMatchObject({ name: 'EmbeddedPairingError', reason: 'enrollment_missing' });
      expect(server.codes).toBe(0);
      expect(await readDeviceEnrollmentStatus(config)).toEqual({ state: 'unpaired' });
    });

    it('a paired store whose device the server lists is accepted without a new pairing', async () => {
      const config = await storeConfig();
      const { deviceId } = await daemonFor(config).pair('pairing-code');
      const server = embeddedServer([deviceId]);
      expect(await daemonFor(config).pairEmbedded(server)).toEqual({ deviceId });
      expect(server.codes).toBe(0);
    });

    it('a paired store whose device the server does not list refuses with device_unknown', async () => {
      const config = await storeConfig();
      const { deviceId } = await daemonFor(config).pair('pairing-code');
      const server = embeddedServer(['another-device']);
      expect(await refusal(daemonFor(config), server)).toMatchObject({ reason: 'device_unknown' });
      expect(server.codes).toBe(0);
      expect(await readDeviceEnrollmentStatus(config)).toEqual({ state: 'paired', deviceId });
    });

    it('a device record without its OS entry refuses with re_pair_required', async () => {
      const config = await storeConfig();
      await daemonFor(config).pair('pairing-code');
      await createTestDeviceStore(config.storeDir!, undefined, productId).credentials.clear();
      expect(await refusal(daemonFor(config), embeddedServer([]))).toMatchObject({ reason: 're_pair_required' });
    });

    it('an OS entry another storeDir paired refuses with store_not_bound', async () => {
      const { deviceId } = await daemonFor(await storeConfig()).pair('pairing-code');
      const server = embeddedServer([deviceId]);
      expect(await refusal(daemonFor(await storeConfig()), server)).toMatchObject({ reason: 'store_not_bound' });
      expect(server.codes).toBe(0);
    });
  });
});
