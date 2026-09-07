import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';
import { DeviceStore } from '../daemon/store';
import { startRealCloud } from './fixtures/real-cloud';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const clean of cleanup.reverse()) await clean(); cleanup.length = 0; });

it('real pageLimit=2 reaches approve/cancel behind an unfinished offer without acknowledging it', async () => {
  const cloud = await startRealCloud({ productId: 'read-ahead', eventsPageLimit: 2, longPollHoldMs: 20, longPollIntervalMs: 5 });
  cleanup.push(() => cloud.close());
  const root = await mkdtemp(path.join(os.tmpdir(), 'byok-read-ahead-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const auth = new AuthManager({ serverUrl: cloud.url, store: new DeviceStore(root) });
  const device = await auth.pair((await cloud.createPairingCode()).code);
  const a = await cloud.enqueueOffer(device.deviceId, 'slow A');
  const b = await cloud.enqueueOffer(device.deviceId, 'fast B');
  const cursorStore = new CursorStore(root);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controls: string[] = [];
  let aCalls = 0, bCalls = 0;
  const connection = new ConnectionManager({ serverUrl: cloud.url, deviceId: device.deviceId, productId: 'read-ahead',
    capabilities: [], runtimes: [], auth, cursorStore, longPollIdleDelayMs: 5, longPollRetryDelayMs: 5,
    onEnvelope: async envelope => {
      if (envelope.type === 'task.offer' && envelope.task_id === a.taskId) { aCalls++; await gate; }
      if (envelope.type === 'task.offer' && envelope.task_id === b.taskId) bCalls++;
      if (envelope.type === 'task.approve' || envelope.type === 'task.cancel') controls.push(envelope.type);
    } });
  cleanup.push(async () => { release(); await connection.stop(); await auth.stop(); });
  await connection.start();
  await vi.waitFor(() => expect([aCalls, bCalls]).toEqual([1, 1]));
  const post = async (envelope: Envelope) => {
    const response = await fetch(`${cloud.url}/byok/messages`, { method: 'POST', headers: { authorization: `Bearer ${device.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [envelope] }) });
    expect(await response.json()).toMatchObject({ accepted: 1 });
  };
  await post(createEnvelope('task.claim', { deviceId: device.deviceId, runtime: 'pi' }, { taskId: b.taskId }));
  await post(createEnvelope('task.started', {}, { taskId: b.taskId }));
  await post(createEnvelope('task.await_approval', { summary: 'approve B' }, { taskId: b.taskId }));
  await cloud.cloud.approveTask(cloud.tenant, b.taskId);
  await cloud.cancelTask(a.taskId, 'cancel A before its handler completes');
  // Cloud now filters the first offer, but page one still contains B.
  await vi.waitFor(() => expect(controls).toEqual(['task.approve', 'task.cancel']), { timeout: 1000 });
  expect(await cursorStore.load(cloud.url, device.deviceId)).toBe(0);
  expect([aCalls, bCalls]).toEqual([1, 1]);
  release();
  await vi.waitFor(async () => expect(await cursorStore.load(cloud.url, device.deviceId)).toBe(4));
});

it('R5/R6: real paginated cancel retires never-returning prepare and permits same-home reuse', async () => {
  const { createDaemonWithAdapters } = await import('../daemon/create-daemon');
  const { StubRuntimeAdapter } = await import('./fixtures/stub-adapter');
  const cloud = await startRealCloud({ productId: 'read-ahead', eventsPageLimit: 2, longPollHoldMs: 20, longPollIntervalMs: 5 });
  cleanup.push(() => cloud.close());
  const root = await mkdtemp(path.join(os.tmpdir(), 'byok-read-ahead-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const adapter = new StubRuntimeAdapter('acme-harness');
  const daemon = createDaemonWithAdapters({ productId: 'read-ahead', productName: 'Read ahead',
    localAgentRelease: { version: '0.0.0-test' }, serverUrl: cloud.url, storeDir: root,
    workspaceRoot: path.join(root, 'work'), agentHome: { hostStorageRoot: path.join(root, 'home') },
    startupTimeoutMs: 10000,
  }, [adapter], { longPoll: { idleDelayMs: 5, retryDelayMs: 5 } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  cleanup.push(async () => { release(); await daemon.stop(); });
  const device = await daemon.pair((await cloud.createPairingCode()).code); await daemon.start();
  await vi.waitFor(async () => expect((await cloud.cloud.listDevices(cloud.tenant))[0]?.harnesses?.[0]?.id).toBe('acme-harness'));
  const prepare = adapter.prepare.bind(adapter);
  let blocked = false;
  vi.spyOn(adapter, 'prepare').mockImplementation(async input => {
    if (!blocked) { blocked = true; await gate; }
    return prepare(input);
  });
  const payload = (agentId: string) => ({ instruction: 'work', policy: { mode: 'auto' as const }, harnessId: 'acme-harness', agentRef: { agentId, profileRevision: 'r1' } });
  const a = await cloud.enqueueAgentOffer(device.deviceId, payload('a'));
  await vi.waitFor(() => expect(blocked).toBe(true));
  const b = await cloud.enqueueAgentOffer(device.deviceId, payload('b'));
  await vi.waitFor(async () => expect((await cloud.readTaskAttempt(b.taskId))?.status).toBe('running'));
  await cloud.cancelTask(a.taskId, 'cancel blocked prepare');
  await vi.waitFor(async () => expect(await cloud.readTerminalBody(a.taskId)).toContain('cancelled before claim'), { timeout: 1500 });
  expect(adapter.startCalls).toHaveLength(1);
  const replacement = await cloud.enqueueAgentOffer(device.deviceId, payload('a'));
  await vi.waitFor(async () => expect((await cloud.readTaskAttempt(replacement.taskId))?.status).toBe('running'));
  release(); await gate; await new Promise(resolve => setImmediate(resolve));
  expect(adapter.startCalls).toHaveLength(2);
  for (const session of adapter.sessions) session.emit({ type: 'turn_end' });
});
