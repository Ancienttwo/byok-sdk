import { testScratchRoot } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { DaemonHaltError } from '../daemon/daemon-lifecycle';
import { readDeviceEnrollmentIdentity, readDeviceEnrollmentStatus } from '../daemon/store';
import { DeviceStoreBindingMismatchError } from '../daemon/daemon-errors';
import { repairDeviceEnrollmentMetadata } from '../diagnostics/device-doctor';
import { connectControlClient } from '../bin/control-client';
import { OPEN_LIFECYCLE, waitForDaemonOpen } from './fixtures/lifecycle-barrier';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

vi.mock('../bin/control-client', () => ({ connectControlClient: vi.fn() }));

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
});
