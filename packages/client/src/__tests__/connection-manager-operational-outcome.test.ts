import { createTestDeviceStore } from './fixtures/device-credentials';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager, type ConnectionManagerOptions, type OutboundSettlement } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';
import { LongPollClient } from '../daemon/long-poll-transport';
import { seedDeviceEnrollment } from './fixtures/device-enrollment';

type Scenario = 'handshake-route-failure' | 'handshake-settlement-failure' | 'poll-success' | 'poll-failure'
  | 'upload-success' | 'upload-route-failure' | 'upload-settlement-failure';

const serverUrl = 'http://operational-observer.invalid';
const deviceId = 'operational-observer-device';
const roots: string[] = [];
let connection: ConnectionManager | undefined;

afterEach(async () => {
  await connection?.stop();
  connection = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

/** Only HTTP replies are fixtures: auth, schemas, poll, drain and cursor use their real implementations. */
async function setup(scenario: Scenario, onOperationalOutcome: ConnectionManagerOptions['onOperationalOutcome']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-operational-observer-'));
  roots.push(root);
  const store = createTestDeviceStore(root);
  await seedDeviceEnrollment(store, {
    deviceId, tenantId: 'observer-tenant', accessToken: 'fixture-token',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    devicePrivateKeyPem: 'fixture-private-key', devicePublicKey: 'fixture-public-key',
  });
  const auth = new AuthManager({ serverUrl, store });
  await auth.loadExisting();
  const cursorStore = new CursorStore(root);
  await cursorStore.save(serverUrl, deviceId, 7);

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/byok/messages') {
      const { messages } = JSON.parse(String(init?.body)) as { messages: Envelope[] };
      const hello = messages[0]?.type === 'conn.hello';
      if ((hello && scenario === 'handshake-route-failure') || (!hello && scenario === 'upload-route-failure')) {
        return new Response('', { status: 503 });
      }
      return Response.json({ accepted: messages.length, capabilities: ['result-document'] });
    }
    expect(url.pathname).toBe('/byok/events');
    expect(url.searchParams.get('cursor')).toBe('7');
    if (scenario === 'poll-failure') return new Response('', { status: 503 });
    return Response.json({ events: [], cursor: 7, capabilities: ['result-document'] });
  });
  vi.stubGlobal('fetch', fetch);
  const post = vi.spyOn(LongPollClient.prototype, 'postBatch');
  const settlements: OutboundSettlement[] = [];
  const onCrashed = vi.fn();
  const onHalted = vi.fn();
  connection = new ConnectionManager({
    serverUrl, deviceId, productId: 'observer-test', capabilities: [], runtimes: [], auth, cursorStore,
    onEnvelope: () => {}, onOperationalOutcome, onCrashed, onHalted,
    onOutboundSettled: async batch => {
      const hello = batch[0]?.envelope.type === 'conn.hello';
      if ((hello && scenario === 'handshake-settlement-failure') || (!hello && scenario === 'upload-settlement-failure')) {
        throw new Error('fixture settlement persistence failed');
      }
      settlements.push(...batch);
    },
    longPollRetryDelayMs: 5, longPollIdleDelayMs: 5,
  });
  return { manager: connection, onCrashed, onHalted, post, fetch, settlements, cursorStore };
}

describe('ConnectionManager operational observer exception boundary (#384)', () => {
  it.each([
    ['handshake-route-failure', 'failure', 'reconnect'],
    ['handshake-settlement-failure', 'failure', 'reconnect'],
    ['poll-success', 'success', 'reconnect'],
    ['poll-failure', 'failure', 'reconnect'],
    ['upload-success', 'success', 'upload'],
    ['upload-route-failure', 'failure', 'upload'],
    ['upload-settlement-failure', 'failure', 'upload'],
  ] as const)('%s: a throwing observer crashes once, without an unhandled rejection or retry', async (scenario, outcome, source) => {
    const failure = new Error(`${scenario} observer threw`);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const observer = vi.fn((_: 'success' | 'failure', channel: 'reconnect' | 'upload') => {
      if (channel === source) throw failure;
    });
    try {
      const { manager, onCrashed, onHalted, post, fetch, settlements, cursorStore } = await setup(scenario, observer);
      await manager.start();
      const envelope = createEnvelope('task.started', {}, { taskId: 'observer-task' });
      if (source === 'upload') {
        await vi.waitFor(() => expect(manager.isOpen()).toBe(true));
        manager.send(envelope);
      }
      await vi.waitFor(() => {
        expect(unhandled, 'operational observer throws must not escape detached poll/drain promises').toEqual([]);
        expect(onCrashed).toHaveBeenCalledExactlyOnceWith(failure);
      });
      expect(observer.mock.calls.filter(([, channel]) => channel === source)).toEqual([[outcome, source]]);
      expect(onHalted).not.toHaveBeenCalled();
      expect(manager.isOpen()).toBe(false);
      expect(manager.getServerCapabilities()).toEqual([]);
      expect(await cursorStore.load(serverUrl, deviceId)).toBe(7);

      const retained = source === 'upload' && outcome === 'failure';
      expect(manager.outboxLength()).toBe(retained ? 1 : 0);
      const businessPosts = post.mock.calls.filter(([batch]) => batch[0]?.type !== 'conn.hello');
      expect(businessPosts).toHaveLength(source === 'upload' ? 1 : 0);
      if (source === 'upload') expect(businessPosts[0]![0][0]).toBe(envelope);
      expect(settlements.filter(item => item.envelope.type !== 'conn.hello')).toEqual(
        scenario === 'upload-success' ? [{ envelope, outcome: 'accepted' }] : [],
      );
      const requestsAtCrash = fetch.mock.calls.length;
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(fetch).toHaveBeenCalledTimes(requestsAtCrash);
      expect(onCrashed).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('non-throwing observers preserve hello-first posting, awaited settlement and cursor state', async () => {
    const observer = vi.fn();
    const { manager, post, settlements, cursorStore, onCrashed } = await setup('upload-success', observer);
    const envelope = createEnvelope('task.started', {}, { taskId: 'observer-task' });
    manager.send(envelope);
    await manager.start();
    await vi.waitFor(() => expect(settlements.some(item => item.envelope === envelope)).toBe(true));
    expect(post.mock.calls.map(([batch]) => batch.map(item => item.type))).toEqual([['conn.hello'], ['task.started']]);
    expect(settlements.map(item => item.envelope.type)).toEqual(['conn.hello', 'task.started']);
    expect(observer).toHaveBeenCalledWith('success', 'upload');
    expect(manager.outboxLength()).toBe(0);
    expect(await cursorStore.load(serverUrl, deviceId)).toBe(7);
    expect(onCrashed).not.toHaveBeenCalled();
    expect(manager.isOpen()).toBe(true);
  });
});
