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
import { acquireEnrollmentGate, writeUnderBinding } from '../daemon/enrollment-gate';
import { acquirePathMutationGate, type PathMutationGate, PathMutationGateBusyError } from '../util/path-mutation-gate';
import { createTestDeviceStore, InMemoryDeviceCredentialBackend } from './fixtures/device-credentials';
import { AuthManager } from '../daemon/auth-manager';
import { DeviceMemberKeyStore, DeviceMemberRecords } from '../daemon/device-member-custody';
import { testDeviceCredentials, testDeviceMemberCustody } from './fixtures/credential-backend';
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
  return { ...actual, acquireEnrollmentGate: vi.fn(actual.acquireEnrollmentGate) };
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
      scope: undefined as string | undefined,
      onWait: undefined as (() => void) | undefined,
      restore: () => { vi.mocked(acquireEnrollmentGate).mockReset().mockImplementation(acquire); },
      /**
       * Resolves once `pairing` has settled, or once it waits on the gate one
       * holder has: the real lock then refuses a probe, so the pairing is
       * blocked rather than merely late (#2030 F3).
       */
      excludes: async (pairing: Promise<unknown>) => {
        const waiting = new Promise<boolean>((resolve) => { gate.onWait = () => resolve(true); });
        const blocked = await within(Promise.race([pairing.then(() => false), waiting]));
        gate.onWait = undefined;
        if (!blocked) return;
        expect(gate.held).toBe(1);
        await expect(acquirePathMutationGate({ scope: gate.scope as `device-enrollment:${string}` })).rejects.toBeInstanceOf(PathMutationGateBusyError);
      },
    };
    vi.mocked(acquireEnrollmentGate).mockImplementation(async (id, signal) => {
      gate.onWait?.();
      const acquired = await acquire(id, signal);
      gate.held += 1;
      gate.taken += 1;
      gate.scope = acquired.scope;
      return { ...acquired, release: async () => { gate.held -= 1; await acquired.release(); } };
    });
    return gate;
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

    it('a running daemon\'s member resume writes no member entry of another store\'s enrollment and halts as store_not_bound (#2055)', async () => {
      const first = await storeConfig();
      const firstDaemon = daemonFor(first);
      await firstDaemon.pair('pairing-code');
      const { tenantId, deviceId } = await readDeviceEnrollmentIdentity(first) as { tenantId: string; deviceId: string };
      const second = await storeConfig();
      const custody = testDeviceMemberCustody(productId);
      const jwk = { x: 'x', y: 'y' };
      vi.spyOn(DeviceMemberKeyStore.prototype, 'load').mockResolvedValue({ signing: { publicJwk: jwk }, kem: { publicJwk: jwk } } as never);
      const point = { seq: 1, hash: `sha256:${'0'.repeat(64)}` };
      let resumed!: () => void;
      const reading = new Promise<void>((resolve) => { resumed = resolve; });
      let replaced!: () => void;
      const paired = new Promise<void>((resolve) => { replaced = resolve; });
      vi.spyOn(DeviceMemberRecords.prototype, 'readState').mockImplementationOnce(async () => {
        resumed();
        await paired;
        return { tenantId, deviceId, member: { signingPublicJwk: jwk, kemPublicJwk: jwk }, anchor: { approverSigningPublicJwk: jwk, entry: point }, head: point } as never;
      });
      await firstDaemon.start();
      await within(reading);

      // The resume read its state; another store pairs over the enrollment and stages its member entry before the first write.
      await daemonFor(second).pair('pairing-code', { replaceOtherStore: true });
      custody.entries.set('pairing-verification', 'second store');
      const gate = await trackGate();
      try {
        replaced();
        await vi.waitFor(() => expect(firstDaemon.status().lifecycle).toMatchObject({ phase: 'halted', reason: 'store_not_bound' }), settle);
        // The binding was reread under the gate.
        await vi.waitFor(() => expect({ taken: gate.taken, held: gate.held }).toEqual({ taken: 1, held: 0 }), settle);
      } finally {
        gate.restore();
      }
      expect(custody.entries.get('pairing-verification')).toBe('second store');
      expect(await readDeviceEnrollmentStatus(second)).toMatchObject({ state: 'paired' });
    });

    it.each(['saveState', 'deletePending', 'beginKemRotation', 'finishKemRotation'] as const)('a running daemon\'s member %s holds the gate through its write and read-back, then writes nothing over another store\'s enrollment (#2055)', async (point) => {
      const first = await storeConfig();
      const lost = vi.fn();
      const auth = new AuthManager({
        serverUrl: server.url, store: new DeviceStore(productId, DeviceStore.resolveDir(productId, first.storeDir), testDeviceCredentials(productId)), onBindingLost: lost,
      });
      const { tenantId, deviceId } = await auth.pair('pairing-code');
      const binding = { tenantId, deviceId };
      const custody = testDeviceMemberCustody(productId);
      const unguarded = new DeviceMemberRecords(custody);
      custody.entries.set('pairing-verification', 'pending');
      if (point === 'beginKemRotation' || point === 'finishKemRotation') await unguarded.keys.loadOrCreate(binding);
      const epoch = point === 'finishKemRotation' ? (await unguarded.keys.beginKemRotation(binding)).nextKem!.epoch : 0;
      const records = unguarded.guardedBy((write) => writeUnderBinding(auth, write, new AbortController().signal));
      const write = {
        saveState: () => records.saveState({ tenantId, deviceId, member: {} as never }),
        deletePending: () => records.deletePending(),
        beginKemRotation: () => records.keys.beginKemRotation(binding),
        finishKemRotation: () => records.keys.finishKemRotation(binding, epoch),
      }[point];
      const second = daemonFor(await storeConfig());
      const gate = await trackGate();
      // Every custody operation of the write, read-back included where it has one, records the gate; its first change starts the other store's pairing.
      const heldAt: number[] = [];
      let writing = true;
      let pairing: Promise<unknown> | undefined;
      for (const op of ['read', 'replace', 'delete'] as const) {
        const original = custody[op].bind(custody) as (...args: unknown[]) => Promise<unknown>;
        vi.spyOn(custody, op).mockImplementation((async (...args: unknown[]) => {
          if (writing && op !== 'read' && pairing === undefined) {
            pairing = second.pair('pairing-code', { replaceOtherStore: true });
            await gate.excludes(pairing);
          }
          if (writing) heldAt.push(gate.held);
          return original(...args);
        }) as never);
      }

      try {
        await write();
        writing = false;
        await within(pairing!);
        for (const entry of ['member-state', 'member-keys', 'pairing-verification']) custody.entries.set(entry, 'second store');
        const entries = new Map(custody.entries);

        await expect(write()).rejects.toBeInstanceOf(DeviceStoreBindingMismatchError);

        expect(custody.entries).toEqual(entries);
      } finally {
        gate.restore();
      }
      expect(heldAt).not.toHaveLength(0);
      expect(new Set(heldAt)).toEqual(new Set([1]));
      expect(lost).toHaveBeenCalledWith('store_not_bound');
    });

    it('a member write cancelled while queued behind a credential mutation leaves the queue at once and writes nothing (#2055)', async () => {
      const first = await storeConfig();
      const credentials = testDeviceCredentials(productId);
      const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(productId, DeviceStore.resolveDir(productId, first.storeDir), credentials) });
      await auth.pair('pairing-code');
      let unblock!: () => void;
      const blocked = new Promise<void>((resolve) => { unblock = resolve; });
      const read = credentials.read.bind(credentials);
      vi.spyOn(credentials, 'read').mockImplementationOnce(async () => { await blocked; return read(); });
      const order: string[] = [];
      // Stands in for a renewal that waits on the gate a re-pair holds while the re-pair aborts its member run.
      const predecessor = auth.readCurrent().then(() => order.push('predecessor'));
      const abort = new AbortController();
      const write = vi.fn(async () => undefined);
      const member = writeUnderBinding(auth, write, abort.signal);
      const successor = auth.readCurrent().then(() => order.push('successor'));

      const reason = new Error('member run aborted');
      abort.abort(reason);

      await expect(within(member)).rejects.toBe(reason);
      expect(order).toEqual([]);
      unblock();
      await within(Promise.all([predecessor, successor]));
      expect(order).toEqual(['predecessor', 'successor']);
      expect(write).not.toHaveBeenCalled();
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

    it.each(['not json', ''])('refuses a store whose device.json cannot be parsed (%j) before deleting anything (#1965)', async (text) => {
      const first = await storeConfig();
      const { deviceId } = await daemonFor(first).pair('pairing-code');
      const second = await storeConfig();
      await fs.writeFile(path.join(second.storeDir!, 'device.json'), text);

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
      const gate = await trackGate();
      let pairing: Promise<unknown> = Promise.resolve();
      vi.spyOn(credentials, 'clear').mockImplementationOnce(async () => {
        pairing = secondDaemon.pair('pairing-code', { replaceOtherStore: true }).catch((error: unknown) => error);
        // The clear holds the gate from its validation to here, so the pairing must wait on it.
        await gate.excludes(pairing);
        return deleteEntry();
      });

      try {
        await clear(first);
        await within(pairing);
      } finally {
        gate.restore();
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

    it.each(['another store', 'no store'] as const)('a paired store refuses to re-pair beside a staged first pairing of %s and leaves both (#2030 F1)', async (owner) => {
      const first = await storeConfig();
      const firstDaemon = daemonFor(first);
      const { deviceId } = await firstDaemon.pair('pairing-code');
      const credentials = testDeviceCredentials(productId);
      if (owner === 'another store') await expect(daemonFor(unreachable(await storeConfig())).pair('pairing-code', { replaceOtherStore: true })).rejects.toThrow();
      else await credentials.saveFirstPairingAttempt({ kind: 'first-pairing-attempt-v1', deviceName: 'legacy', devicePublicKey: 'legacy-public-key', devicePrivateKeyPem: 'legacy-private-key' });
      const staged = await credentials.readFirstPairingAttempt();

      const refused: unknown = await firstDaemon.pair('pairing-code').catch((error: unknown) => error);

      expect(refused).toMatchObject({ name: 'FirstPairingAttemptRefusedError', code: owner === 'another store' ? 'store_not_bound' : 'pairing_attempt_unattributed' });
      expect(await credentials.readFirstPairingAttempt()).toEqual(staged);
      expect(await readDeviceEnrollmentStatus(first)).toEqual({ state: 'paired', deviceId });
    });

    it('a re-pair rereads the enrollment under the gate instead of its cached record (#2045 F4)', async () => {
      const first = await storeConfig();
      const credentials = testDeviceCredentials(productId);
      const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(productId, DeviceStore.resolveDir(productId, first.storeDir), credentials) });
      await auth.pair('pairing-code');
      const second = await storeConfig();
      const { deviceId } = await daemonFor(second).pair('pairing-code', { replaceOtherStore: true });

      await expect(auth.pair('pairing-code')).rejects.toBeInstanceOf(DeviceStoreBindingMismatchError);

      expect(await readDeviceEnrollmentStatus(second)).toEqual({ state: 'paired', deviceId });
    });

    it('another store\'s pairing waits for a pairing\'s member custody (#2030 F2)', async () => {
      const first = await storeConfig();
      const firstDaemon = daemonFor(first);
      const secondDaemon = daemonFor(await storeConfig());
      const gate = await trackGate();
      const order: string[] = [];
      let pairing: Promise<unknown> = Promise.resolve();
      const clearMembers = DeviceMemberRecords.prototype.clear;
      vi.spyOn(DeviceMemberRecords.prototype, 'clear').mockImplementationOnce(async function (this: DeviceMemberRecords) {
        pairing = secondDaemon.pair('pairing-code', { replaceOtherStore: true }).then(() => order.push('second paired'));
        await gate.excludes(pairing);
        await clearMembers.call(this);
        order.push('first members written');
      });

      try {
        await firstDaemon.pair('pairing-code');
        await within(pairing);
      } finally {
        gate.restore();
      }

      expect(order).toEqual(['first members written', 'second paired']);
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
