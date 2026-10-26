import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryPresenceStore } from '@byok-sdk/core';
import { composeFacadeStores, serverTenantId } from '../stores';
import { createByokServer, type ByokServer } from '../index';
import { connectFakeDaemonLongPoll, nextEnvelope, startServer, stopServer, waitFor, TEST_AGENT_DISPATCH } from './test-support';

const PRODUCT_ID = 'single-presence-lease';
const T0 = Date.parse('2026-10-14T00:00:00.000Z');

describe('single TTL presence lease', () => {
  let byok: ByokServer | undefined;
  let server: HttpServer | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    await byok?.close();
    if (server) await stopServer(server);
  });
  async function start(options: { longPollHoldMs?: number; presenceTtlMs?: number } = {}) {
    byok = createByokServer({ productId: PRODUCT_ID, ...options });
    const started = await startServer(byok);
    server = started.server;
    return { byok, baseUrl: started.baseUrl };
  }
  function clock() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  }

  it('expires the default lease after hold + 15s, including a device that only polls', async () => {
    clock();
    const h = await start();
    const daemon = await connectFakeDaemonLongPoll(h.baseUrl, h.byok, { productId: PRODUCT_ID, announce: false });
    expect((await h.byok.machines.list())[0]?.connected).toBe(false);
    const abort = new AbortController();
    const held = fetch(`${h.baseUrl}/byok/events?cursor=0`, {
      headers: { authorization: `Bearer ${daemon.accessToken}` }, signal: abort.signal,
    }).catch(() => undefined);
    try {
      await waitFor(async () => (await h.byok.machines.list())[0]?.connected === true);
      expect((await h.byok.stats()).connectedDeviceCount).toBe(1);
      vi.setSystemTime(T0 + 50_000);
      expect((await h.byok.machines.list())[0]?.connected).toBe(true);
      vi.setSystemTime(T0 + 65_000);
      expect((await h.byok.machines.list())[0]?.connected).toBe(false);
      expect((await h.byok.stats()).connectedDeviceCount).toBe(0);
    } finally {
      abort.abort();
      await held;
    }
  });

  it('heartbeat and polls renew the same lease and preserve live discovery facts', async () => {
    clock();
    const h = await start({ longPollHoldMs: 10, presenceTtlMs: 1_000 });
    const daemon = await connectFakeDaemonLongPoll(h.baseUrl, h.byok, {
      productId: PRODUCT_ID, clientVersion: '0.5.0', configuredToolsets: ['crm'],
      runtimes: [{ id: 'pi', version: '1.2.0', authPresent: true, capabilities: { steer: true } }],
    });
    expect((await h.byok.machines.list())[0]).toMatchObject({
      clientVersion: '0.5.0', configuredToolsets: ['crm'], runtimes: [{ id: 'pi', version: '1.2.0', authPresent: true }],
    });
    vi.setSystemTime(T0 + 800);
    await daemon.next();
    const machine = (await h.byok.machines.list())[0];
    expect(machine).toMatchObject({ connected: true, lastSeen: new Date(T0 + 800).toISOString() });
    expect(machine?.runtimes).toEqual([{ id: 'pi', version: '1.2.0', authPresent: true }]);
    vi.setSystemTime(T0 + 1_000);
    const heartbeat = await fetch(`${h.baseUrl}/byok/presence`, {
      method: 'PUT', headers: { authorization: `Bearer ${daemon.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'working' }),
    });
    expect(heartbeat.status).toBe(200);
    expect(((await heartbeat.json()) as { expiresAt: string }).expiresAt).toBe(new Date(T0 + 2_000).toISOString());
    vi.setSystemTime(T0 + 2_000);
    expect((await h.byok.machines.list())[0]?.connected).toBe(false);
  });

  it('queues work for an offline registered target and delivers it on the next poll', async () => {
    clock();
    const h = await start({ longPollHoldMs: 10, presenceTtlMs: 1_000 });
    const daemon = await connectFakeDaemonLongPoll(h.baseUrl, h.byok, { productId: PRODUCT_ID });
    vi.setSystemTime(T0 + 1_001);
    expect((await h.byok.machines.list())[0]?.connected).toBe(false);
    const task = await h.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'wait for this laptop' });
    expect((await h.byok.tasks.get(task.taskId))?.state).toBe('Offered');
    const offer = await nextEnvelope(daemon);
    expect(offer).toMatchObject({ type: 'task.offer_for_agent', task_id: task.taskId });
    expect((await h.byok.machines.list())[0]?.connected).toBe(true);
  });

  it('revocation removes the device from every machine projection', async () => {
    const h = await start({ longPollHoldMs: 10 });
    const daemon = await connectFakeDaemonLongPoll(h.baseUrl, h.byok, { productId: PRODUCT_ID });
    await h.byok.devices.revoke(daemon.deviceId);
    expect(await h.byok.machines.list()).toEqual([]);
    await expect(h.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'revoked' })).rejects.toMatchObject({ code: 'device_not_found' });
    expect((await h.byok.tasks.list()).tasks).toEqual([]);
  });

  it('rejects a TTL that cannot outlast a held poll', () => {
    expect(() => createByokServer({ productId: PRODUCT_ID, longPollHoldMs: 1_000, presenceTtlMs: 1_000 })).toThrow(/presenceTtlMs must be an integer greater than longPollHoldMs/);
  });
});


describe('concurrent lease observations', () => {
  it('keeps a lease renewed before a queued maintenance sweep reaches the store', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const tenant = serverTenantId(PRODUCT_ID);
    const composition = composeFacadeStores({ tenant, maxBlobSizeBytes: 1_000, presenceTtlMs: 1_000, onRateLimited: () => {} });
    let release!: () => void;
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const collect = InMemoryPresenceStore.prototype.collectExpired;
    const spy = vi.spyOn(InMemoryPresenceStore.prototype, 'collectExpired').mockImplementationOnce(async function (this: InMemoryPresenceStore, tenant, input) {
      enter(); await gate;
      return collect.call(this, tenant, input);
    });
    try {
      await composition.core.presence.publish(tenant, { deviceId: 'renewed-device', level: 'online', ttlMs: 1_000, minimumIntervalMs: 0 });
      vi.setSystemTime(T0 + 1_001);
      const sweep = composition.core.presence.collectExpired(tenant, { now: new Date().toISOString(), limit: 1 });
      await entered;
      await composition.core.presence.publish(tenant, { deviceId: 'renewed-device', level: 'working', ttlMs: 1_000, minimumIntervalMs: 0 });
      release();
      expect(await sweep).toEqual({ removed: 0, expired: 0, releasedBytes: 0n, more: false });
      expect(await composition.core.presence.read(tenant, 'renewed-device')).toMatchObject({ level: 'working' });
    } finally { release(); spy.mockRestore(); vi.useRealTimers(); await composition.close(); }
  });

  it('does not overwrite newer heartbeat facts with a concurrent transport renewal', async () => {
    const tenant = serverTenantId(PRODUCT_ID);
    const composition = composeFacadeStores({ tenant, maxBlobSizeBytes: 1_000, presenceTtlMs: 1_000,
      onRateLimited: () => {} });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const read = InMemoryPresenceStore.prototype.read;
    await composition.core.presence.publish(tenant, { deviceId: 'concurrent-device', level: 'online',
      clientVersion: 'old', ttlMs: 1_000, minimumIntervalMs: 0 });
    const spy = vi.spyOn(InMemoryPresenceStore.prototype, 'read').mockImplementationOnce(async function(this: InMemoryPresenceStore, tenant, deviceId) {
      const current = await read.call(this, tenant, deviceId);
      enter();
      await gate;
      return current;
    });
    try {
      const renewal = composition.core.mailbox.readCursor(tenant, 'concurrent-device');
      await entered;
      const heartbeat = composition.core.presence.publish(tenant, { deviceId: 'concurrent-device', level: 'working',
        clientVersion: 'new', ttlMs: 1_000, minimumIntervalMs: 0 });
      release();
      await Promise.all([renewal, heartbeat]);
      expect(await composition.core.presence.read(tenant, 'concurrent-device')).toMatchObject({ clientVersion: 'new', level: 'working' });
    } finally {
      release();
      spy.mockRestore();
      await composition.close();
    }
  });
});
