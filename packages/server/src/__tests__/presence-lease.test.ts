import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceConnections } from '../connections';
import { createByokServer, type ByokServer } from '../index';
import { connectFakeDaemonLongPoll, startServer, stopServer, waitFor } from './test-support';

/**
 * Issue #388 item 1: presence is an expiring lease over `lastSeen`, judged by
 * one rule (`DeviceConnections.isConnected`) that `MachineInfo.connected`,
 * ambient selection, the "not connected" gate and `stats()` all share.
 *
 * Only `Date` is faked: the HTTP server, the long-poll hold and every other
 * timer stay real, and the lease is judged against the faked wall clock.
 */

const PRODUCT_ID = 'presence-lease';
const T0 = Date.parse('2026-10-13T00:00:00.000Z');

describe('DeviceConnections presence lease', () => {
  it('is connected exactly while the last observation is within presenceTtlMs', () => {
    let now = T0;
    const connections = new DeviceConnections({ presenceTtlMs: 1_000, now: () => now });
    connections.touch('dev-a', new Date(T0).toISOString());
    connections.announce('dev-b', {}, new Date(T0).toISOString());

    now = T0 + 1_000;
    expect(connections.isConnected('dev-a')).toBe(true);
    expect(connections.connectedCount()).toBe(2);

    now = T0 + 1_001;
    expect(connections.isConnected('dev-a')).toBe(false);
    expect(connections.isConnected('dev-b')).toBe(false);
    expect(connections.connectedCount()).toBe(0);
    // The observation itself is kept: a lapsed lease is not a forgotten device.
    expect(connections.get('dev-a')?.lastSeen).toBe(new Date(T0).toISOString());

    connections.touch('dev-a', new Date(now).toISOString());
    expect(connections.isConnected('dev-a')).toBe(true);
    expect(connections.connectedCount()).toBe(1);

    connections.forget('dev-a');
    expect(connections.isConnected('dev-a')).toBe(false);
    expect(connections.get('dev-a')).toBeUndefined();
  });
});

describe('server presence lease', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await byok?.close();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  async function start(options: { longPollHoldMs?: number; presenceTtlMs?: number }) {
    const instance = createByokServer({ productId: PRODUCT_ID, ...options });
    const started = await startServer(instance);
    server = started.server;
    byok = instance;
    return { byok: instance, baseUrl: started.baseUrl };
  }

  function connectedOf(machines: Awaited<ReturnType<ByokServer['machines']['list']>>, deviceId: string) {
    return machines.find((machine) => machine.deviceId === deviceId)?.connected;
  }

  it('expires a device that stopped polling: listMachines, ambient dispatch, the explicit gate and stats agree', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const started = await start({ longPollHoldMs: 100, presenceTtlMs: 1_000 });
    // `stale` is observed first, so ambient selection would pick it if presence never expired.
    const stale = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });
    const online = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

    vi.setSystemTime(T0 + 800);
    await online.next(); // a poll renews `online`'s lease; `stale` has gone quiet

    vi.setSystemTime(T0 + 1_500);
    const machines = await started.byok.machines.list();
    expect(connectedOf(machines, stale.deviceId)).toBe(false);
    expect(connectedOf(machines, online.deviceId)).toBe(true);
    expect((await started.byok.stats()).connectedDeviceCount).toBe(1);

    const ambient = await started.byok.dispatch({ instruction: 'whoever is really there' });
    expect((await started.byok.tasks.get(ambient.taskId))?.deviceId).toBe(online.deviceId);

    await expect(
      started.byok.dispatch({ deviceId: stale.deviceId, instruction: 'to the closed laptop' }),
    ).rejects.toThrow(`device ${stale.deviceId} is not connected`);

    // Polling again renews the lease; nothing else had to clear or reset it.
    await stale.next();
    expect(connectedOf(await started.byok.machines.list(), stale.deviceId)).toBe(true);
    expect((await started.byok.stats()).connectedDeviceCount).toBe(2);
  });

  it('keeps a device connected through a full default 50s hold, and lapses it 15s after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    // Defaults: longPollHoldMs 50s, presenceTtlMs = 50s + 15s.
    const started = await start({});
    // Never announces, so the poll's own start is the only observation.
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      announce: false,
    });
    expect(connectedOf(await started.byok.machines.list(), daemon.deviceId)).toBe(false);

    const held = new AbortController();
    const poll = fetch(`${started.baseUrl}/byok/events?cursor=0`, {
      headers: { authorization: `Bearer ${daemon.accessToken}` },
      signal: held.signal,
    }).catch(() => undefined);
    try {
      await waitFor(async () => connectedOf(await started.byok.machines.list(), daemon.deviceId) === true);

      vi.setSystemTime(T0 + 50_000);
      expect(connectedOf(await started.byok.machines.list(), daemon.deviceId)).toBe(true);
      vi.setSystemTime(T0 + 65_000);
      expect(connectedOf(await started.byok.machines.list(), daemon.deviceId)).toBe(true);
      vi.setSystemTime(T0 + 65_001);
      expect(connectedOf(await started.byok.machines.list(), daemon.deviceId)).toBe(false);
    } finally {
      held.abort();
      await poll;
    }
  });

  it('refuses a lease that a held poll would outlive', () => {
    expect(() => createByokServer({ productId: PRODUCT_ID, longPollHoldMs: 1_000, presenceTtlMs: 1_000 })).toThrow(
      /presenceTtlMs must be an integer greater than longPollHoldMs/,
    );
    expect(() => createByokServer({ productId: PRODUCT_ID, presenceTtlMs: 50_000 })).toThrow(
      /presenceTtlMs must be an integer greater than longPollHoldMs \(50000\)/,
    );
  });
});
