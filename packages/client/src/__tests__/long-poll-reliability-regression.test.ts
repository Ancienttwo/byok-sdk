import { freshTestAgentRef } from './fixtures/test-agent';
import { createTestDeviceStore } from './fixtures/device-credentials';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager } from '../daemon/connection-manager';
import type { CursorStore } from '../daemon/cursor-store';
import { LongPollClient, type CorrelatedOutcome } from '../daemon/long-poll-transport';
import { seedDeviceEnrollment } from './fixtures/device-enrollment';
import { TestServer } from './fixtures/test-server';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForOpen } from './fixtures/lifecycle-barrier';
import { TEST_ACTIVITY_INGRESS } from './fixtures/activity-ingress';

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
  return createEnvelope('task.offer_for_agent', { agentRef: freshTestAgentRef(),  instruction: taskId }, { taskId, seq });
}

async function seededAuth(): Promise<AuthManager> {
  const storeDir = await tmpDir('byok-long-poll-reliability-auth-');
  const store = createTestDeviceStore(storeDir);
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
  let settlements: import('../daemon/connection-manager').OutboundSettlement[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await connection?.stop().catch(() => undefined);
    connection = undefined;
    await server?.close();
    server = undefined;
  });

  async function startConnection(cursorStore: CursorStore): Promise<{ deviceId: string; pollCursors: Array<string | null> }> {
    settlements = [];
    server = await TestServer.start();
    const storeDir = await tmpDir('byok-long-poll-reliability-connection-');
    const auth = new AuthManager({ serverUrl: server.url, store: createTestDeviceStore(storeDir) });
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
      onOutboundSettled: async (batch) => { settlements.push(...batch); },
      longPollRetryDelayMs: 15,
      longPollIdleDelayMs: 15,
    });
    await connection.start();
    await waitForOpen(connection);
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
    await vi.waitFor(() => expect(saves).toEqual([0, 1]));
    server!.pushLongPollEvent(offer('cursor-save-second', 2));
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

  it('#136 validates counts against correlated outcomes, retries unreadable bodies, and settles poison envelopes by their own outcome', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const auth = await seededAuth();
    const accepted = createEnvelope('task.claim', { deviceId: 'device-reliability' }, { taskId: 'accepted-task' });
    const rejected = createEnvelope('task.started', {}, { taskId: 'rejected-task' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const settled = {
      accepted: 1,
      rejected: 1,
      outcomes: [{ id: accepted.id, outcome: 'accepted' }, { id: rejected.id, outcome: 'rejected', reason: 'state_conflict' }],
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(settled), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const client = new LongPollClient({ serverUrl: 'http://example.invalid', auth, getCursor: () => 0, onEnvelope: () => {} });
    await expect(client.postBatch([accepted, rejected])).resolves.toEqual(settled);

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('body read failed'); } } as unknown as Response);
    await expect(client.postBatch([accepted])).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ accepted: 1, outcomes: [{ id: accepted.id, outcome: 'accepted' }] }), { status: 200 }));
    await expect(client.postBatch([accepted, rejected])).resolves.toBeUndefined();

    vi.unstubAllGlobals();
    const cursorStore = { load: async () => undefined, save: async () => undefined } as unknown as CursorStore;
    const poisonFirst = createEnvelope('task.started', {}, { taskId: 'poison-first' });
    const poisonSecond = createEnvelope('task.started', {}, { taskId: 'poison-second' });
    const acceptedBeforePoison = createEnvelope('task.claim', { deviceId: 'device-reliability' }, { taskId: 'accepted-before-poison' });
    const laterValid = createEnvelope('task.claim', { deviceId: 'device-reliability' }, { taskId: 'later-valid' });
    const poisonIds = new Set([poisonFirst.id, poisonSecond.id]);
    const businessExecutions: string[] = [];
    const businessDedup = new Set<string>();
    let releaseHello!: () => void;
    const heldHello = new Promise<void>((resolve) => {
      releaseHello = resolve;
    });
    let holdInitialHello = true;
    let dropFirstMixedResponse = true;
    const postBatch = vi.spyOn(LongPollClient.prototype, 'postBatch').mockImplementation(async (batch) => {
      if (holdInitialHello) {
        holdInitialHello = false;
        await heldHello;
        return { accepted: 1, outcomes: [{ id: batch[0]!.id, outcome: 'accepted' as const }], ingress: TEST_ACTIVITY_INGRESS };
      }

      let acceptedCount = 0;
      let rejectedCount = 0;
      const outcomes: CorrelatedOutcome[] = [];
      for (const envelope of batch) {
        if (poisonIds.has(envelope.id)) {
          rejectedCount += 1;
          outcomes.push({ id: envelope.id, outcome: 'rejected', reason: 'not_permitted' });
          continue;
        }
        acceptedCount += 1;
        outcomes.push({ id: envelope.id, outcome: 'accepted' });
        // The reconnect after the dropped response re-sends `conn.hello`
        // (#391); it is admission, not a business effect.
        if (envelope.type !== 'conn.hello' && !businessDedup.has(envelope.id)) {
          businessDedup.add(envelope.id);
          businessExecutions.push(envelope.id);
        }
      }

      if (dropFirstMixedResponse && batch.length === 4) {
        dropFirstMixedResponse = false;
        return undefined;
      }
      const handshake = batch.some((envelope) => envelope.type === 'conn.hello');
      return {
        accepted: acceptedCount,
        outcomes,
        ...(rejectedCount > 0 ? { rejected: rejectedCount } : {}),
        ...(handshake ? { ingress: TEST_ACTIVITY_INGRESS } : {}),
      };
    });
    const starting = startConnection(cursorStore);
    await vi.waitFor(() => expect(postBatch).toHaveBeenCalledTimes(1));
    connection!.send(poisonFirst);
    connection!.send(poisonSecond);
    connection!.send(acceptedBeforePoison);
    connection!.send(laterValid);
    releaseHello();
    await starting;

    await vi.waitFor(() => expect(settlements.filter((item) => item.outcome === 'rejected')).toEqual([
      { envelope: poisonFirst, outcome: 'rejected', reason: 'not_permitted' },
      { envelope: poisonSecond, outcome: 'rejected', reason: 'not_permitted' },
    ]), { timeout: 600 });
    await vi.waitFor(() => expect(connection!.outboxLength()).toBe(0));
    expect(postBatch.mock.calls.map(([batch]) => batch.map((envelope) => envelope.id))).toEqual([
      expect.any(Array),
      [poisonFirst.id, poisonSecond.id, acceptedBeforePoison.id, laterValid.id],
      // #391: the unreadable response ends the session; the reconnect's own
      // handshake hello goes first, then the identical batch is retried.
      expect.any(Array),
      [poisonFirst.id, poisonSecond.id, acceptedBeforePoison.id, laterValid.id],
    ]);
    // Both handshakes, the start's and the reconnect's, are a lone conn.hello.
    expect(postBatch.mock.calls[0]![0].map((envelope) => envelope.type)).toEqual(['conn.hello']);
    expect(postBatch.mock.calls[2]![0].map((envelope) => envelope.type)).toEqual(['conn.hello']);
    // The first mixed response is deliberately unreadable after the server's
    // business effects. Its identical retry is deduped and settles every
    // envelope by its own outcome, so each valid business envelope executes
    // once and nothing is re-posted to isolate the rejected ones.
    expect(businessExecutions).toEqual([acceptedBeforePoison.id, laterValid.id]);
  });

  it.each([
    ['negative response cursor', { events: [], cursor: -1 }],
    ['unsafe response cursor', { events: [], cursor: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative unknown task seq', { events: [{ type: 'task.future', seq: -1 }], cursor: 0 }],
    ['future unknown task seq', { events: [{ type: 'task.future', seq: 2 }], cursor: 1 }],
    ['gap-crossing unknown task seq', { events: [{ type: 'task.future', seq: 2 }], cursor: 2 }],
    ['decreasing task page order', {
      events: [
        { v: 2, id: '10000000-0000-4000-8000-000000000135', ts: new Date().toISOString(), type: 'task.offer_for_agent', task_id: 'known', seq: 1, payload: { instruction: 'known' } },
        { type: 'task.future', seq: 1 },
      ],
      cursor: 1,
    }],
  ])('#137 rejects an invalid trusted page: %s', async (_label, body) => {
    const auth = await seededAuth();
    // Each page carries the required advertisements, so it fails for its labelled reason.
    const fetchMock = vi.fn().mockImplementation(() => new Response(JSON.stringify({ ...body, capabilities: [], ingress: TEST_ACTIVITY_INGRESS }), { status: 200 }));
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
      onValidationFailedSeq: skipped,
      onServerCapabilities: capabilities,
      // #391: a failed poll ends this loop generation; the reconnect loop
      // (here, this stand-in) starts the next one from the durable cursor.
      onLoopFailure: () => {
        client.stop();
        setTimeout(() => client.start(), 15);
      },
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

  it('unknown executable work keeps the durable cursor unchanged', async () => {
    const auth = await seededAuth();
    const body = { events: [{ type: 'task.future', seq: 1 }], cursor: 1, capabilities: [], ingress: TEST_ACTIVITY_INGRESS };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    let cursor = 0;
    const skipped = vi.fn();
    const client = new LongPollClient({
      serverUrl: 'http://example.invalid',
      auth,
      getCursor: () => cursor,
      onEnvelope: () => {},
      onValidationFailedSeq: skipped,
      // #391: a failed poll ends this loop generation; the reconnect loop
      // (here, this stand-in) starts the next one from the durable cursor.
      onLoopFailure: () => {
        client.stop();
        setTimeout(() => client.start(), 15);
      },
      retryDelayMs: 15,
    });
    client.start();
    await vi.waitFor(() => expect(skipped).toHaveBeenCalledWith(1));
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(cursor).toBe(0);
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('cursor')).toBe('0');
    client.stop();
  });
});
