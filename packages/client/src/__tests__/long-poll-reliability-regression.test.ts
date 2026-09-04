import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager } from '../daemon/connection-manager';
import type { CursorStore } from '../daemon/cursor-store';
import { LongPollClient } from '../daemon/long-poll-transport';
import { DeviceStore } from '../daemon/store';
import { seedDeviceEnrollment } from './fixtures/device-enrollment';
import { TestServer } from './fixtures/test-server';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function offer(taskId: string, seq: number): Envelope {
  return createEnvelope('task.offer', { instruction: taskId, policy: { mode: 'auto' } }, { taskId, seq });
}

async function seededAuth(): Promise<AuthManager> {
  const storeDir = await tmpDir('byok-long-poll-reliability-auth-');
  const store = new DeviceStore(storeDir);
  await seedDeviceEnrollment(store, {
    deviceId: 'device-reliability',
    tenantId: 'tenant-reliability',
    accessToken: 'token-reliability',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    devicePrivateKeyPem: 'unused-in-test',
    devicePublicKey: 'unused-in-test',
  });
  const auth = new AuthManager({ serverUrl: 'http://example.invalid', store });
  await auth.loadExisting();
  return auth;
}

describe('long-poll reliability regressions (#135, #136, #137)', () => {
  let server: TestServer | undefined;
  let connection: ConnectionManager | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await connection?.stop().catch(() => undefined);
    connection = undefined;
    await server?.close();
    server = undefined;
  });

  async function startConnection(cursorStore: CursorStore): Promise<{ deviceId: string; pollCursors: Array<string | null> }> {
    server = await TestServer.start();
    const storeDir = await tmpDir('byok-long-poll-reliability-connection-');
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir) });
    const paired = await auth.pair('pairing-code');
    const nativeFetch = globalThis.fetch;
    const pollCursors: Array<string | null> = [];
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === '/byok/events') pollCursors.push(new URL(url).searchParams.get('cursor'));
      return nativeFetch(input, init);
    });

    connection = new ConnectionManager({
      serverUrl: server.url,
      deviceId: paired.deviceId,
      productId: 'reliability-test',
      capabilities: [],
      runtimes: [],
      auth,
      cursorStore,
      onEnvelope: () => {},
      longPollRetryDelayMs: 15,
      longPollIdleDelayMs: 15,
    });
    await connection.start();
    await connection.waitForConnection();
    return { deviceId: paired.deviceId, pollCursors };
  }

  it('#135 never acknowledges a rejected cursor save and surfaces the persistence error', async () => {
    const saves: number[] = [];
    const cursorStore = {
      load: async () => undefined,
      save: async (_serverUrl: string, _deviceId: string, seq: number) => {
        saves.push(seq);
        if (seq === 1) throw new Error('injected cursor save rejection');
      },
    } as unknown as CursorStore;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { pollCursors } = await startConnection(cursorStore);

    server!.pushLongPollEvent(offer('cursor-save-rejected', 1));
    await vi.waitFor(() => expect(saves).toEqual([0, 1]));
    await vi.waitFor(() => expect(errors).toHaveBeenCalled(), { timeout: 600 });
    await vi.waitFor(() => expect(pollCursors.length).toBeGreaterThanOrEqual(3));
    expect(pollCursors).not.toContain('1');
    await expect(connection!.stop()).rejects.toThrow('injected cursor save rejection');
  });

  it('#135 holds the wire cursor and stop behind a never-resolving cursor save', async () => {
    const heldSave = deferred();
    const saves: number[] = [];
    const cursorStore = {
      load: async () => undefined,
      save: async (_serverUrl: string, _deviceId: string, seq: number) => {
        saves.push(seq);
        if (seq === 1) await heldSave.promise;
      },
    } as unknown as CursorStore;
    const { pollCursors } = await startConnection(cursorStore);

    server!.pushLongPollEvent(offer('cursor-save-held', 1));
    await vi.waitFor(() => expect(saves).toEqual([0, 1]));
    await delay(50);
    const cursorsBeforeDurableSave = [...pollCursors];

    let stopped = false;
    const stopping = connection!.stop().then(() => {
      stopped = true;
    });
    await delay(30);
    const stopWasHeldBehindSave = !stopped;
    heldSave.resolve();
    await stopping;
    expect(cursorsBeforeDurableSave).not.toContain('1');
    expect(stopWasHeldBehindSave).toBe(true);
  });

  it('#135 serializes rapid cursor saves and exposes neither cursor before its own durable save', async () => {
    const first = deferred();
    const second = deferred();
    const saves: number[] = [];
    const cursorStore = {
      load: async () => undefined,
      save: async (_serverUrl: string, _deviceId: string, seq: number) => {
        saves.push(seq);
        if (seq === 1) await first.promise;
        if (seq === 2) await second.promise;
      },
    } as unknown as CursorStore;
    const { pollCursors } = await startConnection(cursorStore);

    server!.pushLongPollEvent(offer('cursor-save-first', 1));
    server!.pushLongPollEvent(offer('cursor-save-second', 2));
    await vi.waitFor(() => expect(saves).toEqual([0, 1]));
    await delay(40);
    const cursorsBeforeFirstDurableSave = [...pollCursors];

    first.resolve();
    await vi.waitFor(() => expect(saves).toEqual([0, 1, 2]));
    await delay(30);
    const cursorsBeforeSecondDurableSave = [...pollCursors];
    second.resolve();
    await connection!.stop();
    expect(cursorsBeforeFirstDurableSave).not.toContain('1');
    expect(cursorsBeforeFirstDurableSave).not.toContain('2');
    expect(cursorsBeforeSecondDurableSave).not.toContain('2');
  });

  it('#136 returns exact outcomes, retries unreadable 200 bodies, and quarantines a permanent rejection without blocking later sends', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const auth = await seededAuth();
    const accepted = createEnvelope('task.claim', { deviceId: 'device-reliability' }, { taskId: 'accepted-task' });
    const rejected = createEnvelope('task.started', {}, { taskId: 'rejected-task' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        outcomes: [
          { id: accepted.id, outcome: 'accepted' },
          { id: rejected.id, outcome: 'rejected', reason: 'inbound_rejected' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const client = new LongPollClient({ serverUrl: 'http://example.invalid', auth, getCursor: () => 0, onEnvelope: () => {} });
    await expect(client.postBatch([accepted, rejected])).resolves.toEqual({
      outcomes: [
        { id: accepted.id, outcome: 'accepted' },
        { id: rejected.id, outcome: 'rejected', reason: 'inbound_rejected' },
      ],
    });

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('body read failed'); } } as unknown as Response);
    await expect(client.postBatch([accepted])).resolves.toBeUndefined();

    vi.unstubAllGlobals();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cursorStore = { load: async () => undefined, save: async () => undefined } as unknown as CursorStore;
    let failUnreadableResponseOnce = false;
    const postBatch = vi.spyOn(LongPollClient.prototype, 'postBatch').mockImplementation(async (batch) => {
      if (failUnreadableResponseOnce) {
        failUnreadableResponseOnce = false;
        return undefined;
      }
      return {
        outcomes: batch.map((envelope) => envelope.task_id === 'permanently-rejected'
          ? { id: envelope.id, outcome: 'rejected' as const, reason: 'inbound_rejected' as const }
          : { id: envelope.id, outcome: 'accepted' as const }),
      } as never;
    });
    await startConnection(cursorStore);
    await vi.waitFor(() => expect(connection!.outboxLength()).toBe(0)); // the initial conn.hello
    postBatch.mockClear();
    failUnreadableResponseOnce = true;
    const permanentlyRejected = createEnvelope('task.started', {}, { taskId: 'permanently-rejected' });
    const laterValid = createEnvelope('task.started', {}, { taskId: 'later-valid' });
    connection!.send(permanentlyRejected);

    const rejectionView = connection as unknown as {
      rejectedOutbox: () => readonly { envelope: Envelope; reason: string }[];
    };
    await vi.waitFor(() => expect(rejectionView.rejectedOutbox()).toEqual([
      { envelope: permanentlyRejected, reason: 'inbound_rejected' },
    ]), { timeout: 600 });
    await vi.waitFor(() => expect(connection!.outboxLength()).toBe(0));
    expect(postBatch).toHaveBeenCalledTimes(2);
    // The unreadable 200 requeues and retries the same immutable envelope;
    // terminal quarantine then permits a later valid envelope to drain.
    expect(postBatch.mock.calls[0]?.[0]).toEqual([permanentlyRejected]);
    expect(postBatch.mock.calls[1]?.[0]).toEqual([permanentlyRejected]);
    postBatch.mockClear();
    connection!.send(laterValid);
    await vi.waitFor(() => expect(connection!.outboxLength()).toBe(0));
    expect(postBatch.mock.calls).toHaveLength(1);
    expect(postBatch.mock.calls[0]?.[0]).toEqual([laterValid]);
  });

  it.each([
    ['negative response cursor', { events: [], cursor: -1 }],
    ['unsafe response cursor', { events: [], cursor: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative unknown task seq', { events: [{ type: 'task.future', seq: -1 }], cursor: 0 }],
    ['future unknown task seq', { events: [{ type: 'task.future', seq: 2 }], cursor: 1 }],
    ['gap-crossing unknown task seq', { events: [{ type: 'task.future', seq: 2 }], cursor: 2 }],
    ['decreasing task page order', {
      events: [
        { v: 1, id: '10000000-0000-4000-8000-000000000135', ts: new Date().toISOString(), type: 'task.offer', task_id: 'known', seq: 1, payload: { instruction: 'known', policy: { mode: 'auto' } } },
        { type: 'task.future', seq: 1 },
      ],
      cursor: 1,
    }],
  ])('#137 rejects an invalid trusted page: %s', async (_label, body) => {
    const auth = await seededAuth();
    const fetchMock = vi.fn().mockImplementation(() => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    let cursor = 0;
    const skipped = vi.fn((seq: number) => {
      cursor = seq;
    });
    const capabilities = vi.fn();
    const client = new LongPollClient({
      serverUrl: 'http://example.invalid',
      auth,
      getCursor: () => cursor,
      onEnvelope: () => {},
      onSkippedSeq: skipped,
      onServerCapabilities: capabilities,
      retryDelayMs: 15,
    });
    client.start();
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 600 });
    expect(skipped).not.toHaveBeenCalled();
    expect(capabilities).not.toHaveBeenCalled();
    expect(cursor).toBe(0);
    for (const [input] of fetchMock.mock.calls) {
      expect(new URL(String(input)).searchParams.get('cursor')).toBe('0');
    }
    client.stop();
  });

  it('#137 preserves forward compatibility for a contiguous, in-page unknown task', async () => {
    const auth = await seededAuth();
    const body = { events: [{ type: 'task.future', seq: 1 }], cursor: 1 };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    let cursor = 0;
    const skipped = vi.fn((seq: number) => {
      cursor = seq;
    });
    const client = new LongPollClient({
      serverUrl: 'http://example.invalid',
      auth,
      getCursor: () => cursor,
      onEnvelope: () => {},
      onSkippedSeq: skipped,
      retryDelayMs: 15,
    });
    client.start();
    await vi.waitFor(() => expect(skipped).toHaveBeenCalledWith(1));
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(cursor).toBe(1);
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('cursor')).toBe('1');
    client.stop();
  });
});
