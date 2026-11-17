import { createTestDeviceStore } from './fixtures/device-credentials';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, PROTOCOL_VERSION, type Envelope } from '@byok-sdk/protocol';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager, type OutboundSettlement } from '../daemon/connection-manager';
import { LongPollClient, LongPollRouteError, type CorrelatedOutcome } from '../daemon/long-poll-transport';
import { seedAuthHoldingToken } from './fixtures/device-enrollment';
import { TEST_ACTIVITY_INGRESS } from './fixtures/activity-ingress';

const dirs: string[] = [];
let connection: ConnectionManager | undefined;
afterEach(async () => {
  await connection?.stop(); connection = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function auth(): Promise<AuthManager> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-settlement-')); dirs.push(dir);
  const store = createTestDeviceStore(dir);
  return seedAuthHoldingToken(store, 'http://example.invalid', { deviceId: 'settlement-device', tenantId: 'settlement-tenant' });
}

async function open(onOutboundSettled: (batch: readonly OutboundSettlement[]) => Promise<void>, queued: readonly Envelope[] = []): Promise<ConnectionManager> {
  vi.spyOn(LongPollClient.prototype, 'start').mockImplementation(() => {});
  vi.spyOn(LongPollClient.prototype, 'stop').mockImplementation(() => {});
  connection = new ConnectionManager({ serverUrl: 'http://example.invalid', deviceId: 'settlement-device', productId: 'test',
    capabilities: [], runtimes: [], auth: await auth(), cursorStore: { load: async () => undefined, save: async () => {} } as never,
    onEnvelope: () => {}, onOutboundSettled, longPollRetryDelayMs: 1,
  });
  for (const envelope of queued) connection.send(envelope);
  await connection.start();
  await vi.waitFor(() => expect(connection!.isOpen()).toBe(true));
  return connection;
}

function helloEnvelope(): Envelope {
  return createEnvelope('conn.hello', {
    deviceId: 'settlement-device', productId: 'test', protocolVersions: [PROTOCOL_VERSION], capabilities: [], runtimes: [],
  });
}

/** The v3 answer to an accepted lone `conn.hello`. */
function helloAccepted(hello: Envelope) {
  return { accepted: 1, outcomes: [{ id: hello.id, outcome: 'accepted' as const }], ingress: TEST_ACTIVITY_INGRESS };
}

function outcomes(batch: readonly Envelope[]): CorrelatedOutcome[] {
  return batch.map((envelope, index) => index < 2
    ? { id: envelope.id, outcome: 'rejected', reason: 'limit_exceeded' }
    : { id: envelope.id, outcome: 'accepted' });
}

describe('outbound settlement contract #397', () => {
  it('settles a four-envelope mixed batch with one business POST, waiting before retire', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const settled: OutboundSettlement[] = [];
    const post = vi.spyOn(LongPollClient.prototype, 'postBatch').mockImplementation(async (batch) =>
      batch[0]?.type === 'conn.hello' ? helloAccepted(batch[0]) : { accepted: 2, rejected: 2, outcomes: outcomes(batch) });
    const batch = Array.from({ length: 4 }, (_, index) => createEnvelope('task.started', {}, { taskId: `task-${index}` }));
    const connection = await open(async (batch) => {
      if (batch[0]?.envelope.type !== 'conn.hello') { await gate; settled.push(...batch); }
    }, batch);
    await vi.waitFor(() => expect(post.mock.calls.filter(([messages]) => messages[0]?.type !== 'conn.hello')).toHaveLength(1));
    expect(connection.outboxLength()).toBe(4);
    expect(settled).toEqual([]);
    release();
    await vi.waitFor(() => expect(connection.outboxLength()).toBe(0));
    expect(settled.map((item) => [item.envelope.id, item.outcome, item.outcome === 'rejected' ? item.reason : undefined])).toEqual(batch.map((envelope, index) =>
      [envelope.id, index < 2 ? 'rejected' : 'accepted', index < 2 ? 'limit_exceeded' : undefined]));
    expect(post.mock.calls.filter(([messages]) => messages[0]?.type !== 'conn.hello')).toHaveLength(1);
  });

  it('retains identical envelope bytes when the awaited local settlement fails', async () => {
    const business: readonly Envelope[][] = [] as Envelope[][];
    const post = vi.spyOn(LongPollClient.prototype, 'postBatch').mockImplementation(async (batch) => {
      if (batch[0]?.type === 'conn.hello') return helloAccepted(batch[0]);
      (business as Envelope[][]).push([...batch]);
      return { accepted: 1, outcomes: [{ id: batch[0]!.id, outcome: business.length === 1 ? 'accepted' : 'duplicate' }] };
    });
    let fail = true;
    const settled: OutboundSettlement[] = [];
    const connection = await open(async (batch) => {
      if (batch[0]?.envelope.type === 'conn.hello') return;
      if (fail) { fail = false; throw new Error('injected fsync failure'); }
      settled.push(...batch);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const envelope = createEnvelope('task.complete', { summary: 'exact bytes', sessionRef: 'session', executor: { kind: 'runtime', runtimeId: 'pi' } }, { taskId: 'task' });
    connection.send(envelope);
    await vi.waitFor(() => expect(connection.outboxLength()).toBe(0));
    expect(business).toHaveLength(2);
    expect(business[0]![0]).toBe(envelope); expect(business[1]![0]).toBe(envelope);
    expect(settled).toEqual([{ envelope, outcome: 'duplicate' }]);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('settles a type the session answered type_unsupported locally until a new hello opens the next session', async () => {
    const hellos: Envelope[] = [];
    const business: Envelope[][] = [];
    let failClaim = true;
    vi.spyOn(LongPollClient.prototype, 'postBatch').mockImplementation(async (batch) => {
      if (batch[0]?.type === 'conn.hello') { hellos.push(batch[0]); return helloAccepted(batch[0]); }
      business.push([...batch]);
      // The claim's route failure breaks the first session.
      if (batch[0]?.type === 'task.claim' && failClaim) { failClaim = false; return undefined; }
      const refused = (envelope: Envelope) => envelope.type === 'task.started' && hellos.length === 1;
      return {
        accepted: batch.filter((envelope) => !refused(envelope)).length,
        rejected: batch.filter(refused).length,
        outcomes: batch.map((envelope): CorrelatedOutcome => refused(envelope)
          ? { id: envelope.id, outcome: 'rejected', reason: 'type_unsupported' }
          : { id: envelope.id, outcome: 'accepted' }),
      };
    });
    const settled: OutboundSettlement[] = [];
    const connection = await open(async (batch) => { settled.push(...batch.filter((item) => item.envelope.type !== 'conn.hello')); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = createEnvelope('task.started', {}, { taskId: 'task-1' });
    const second = createEnvelope('task.started', {}, { taskId: 'task-2' });
    const claim = createEnvelope('task.claim', { deviceId: 'settlement-device', executor: { kind: 'runtime', runtimeId: 'pi' } }, { taskId: 'task-3' });
    const third = createEnvelope('task.started', {}, { taskId: 'task-3' });

    connection.send(first);
    await vi.waitFor(() => expect(settled).toHaveLength(1));
    connection.send(second);
    await vi.waitFor(() => expect(settled).toHaveLength(2));
    expect(business).toEqual([[first]]);

    connection.send(claim);
    await vi.waitFor(() => expect(settled).toHaveLength(3));
    expect(hellos).toHaveLength(2);
    connection.send(third);
    await vi.waitFor(() => expect(settled).toHaveLength(4));

    expect(business).toEqual([[first], [claim], [claim], [third]]);
    expect(settled).toEqual([
      { envelope: first, outcome: 'rejected', reason: 'type_unsupported' },
      { envelope: second, outcome: 'rejected', reason: 'type_unsupported' },
      { envelope: claim, outcome: 'accepted' },
      { envelope: third, outcome: 'accepted' },
    ]);
  });

  it.each([
    ['HTTP 400', () => new Response('messages must be an array of envelopes with UUID ids', { status: 400 }), { reason: 'protocol_negotiation_failed', httpStatus: 400 }],
    ['HTTP 404', () => new Response('', { status: 404 }), { reason: 'protocol_negotiation_failed', httpStatus: 404 }],
    ['a rejected protocol_version_unsupported', (id: string) => Response.json({ accepted: 0, rejected: 1, outcomes: [{ id, outcome: 'rejected', reason: 'protocol_version_unsupported' }] }), { reason: 'protocol_negotiation_failed', httpStatus: 200 }],
    ['a rejection for another reason', (id: string) => Response.json({ accepted: 0, rejected: 1, outcomes: [{ id, outcome: 'rejected', reason: 'not_permitted' }] }), { reason: 'handshake_rejected' }],
  ] as const)('halts on %s to the lone hello', async (_label, answer, halt) => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const { messages } = JSON.parse(String(init?.body)) as { messages: Envelope[] };
      return answer(messages[0]!.id);
    });
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(LongPollClient.prototype, 'start').mockImplementation(() => {});
    const onHalted = vi.fn();
    connection = new ConnectionManager({ serverUrl: 'http://example.invalid', deviceId: 'settlement-device', productId: 'test',
      capabilities: [], runtimes: [], auth: await auth(), cursorStore: { load: async () => undefined, save: async () => {} } as never,
      onEnvelope: () => {}, onHalted, longPollRetryDelayMs: 1,
    });
    await connection.start();
    await vi.waitFor(() => expect(onHalted).toHaveBeenCalledExactlyOnceWith(halt));
    expect(connection.getHaltReason()).toBe(halt.reason);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a hello answered HTTP 409 instead of halting', async () => {
    const hello = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const { messages } = JSON.parse(String(init?.body)) as { messages: Envelope[] };
      return hello.mock.calls.length === 1 ? new Response('storage_entitlement_missing', { status: 409 }) : Response.json(helloAccepted(messages[0]!));
    });
    vi.stubGlobal('fetch', hello);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(LongPollClient.prototype, 'start').mockImplementation(() => {});
    const onHalted = vi.fn();
    connection = new ConnectionManager({ serverUrl: 'http://example.invalid', deviceId: 'settlement-device', productId: 'test',
      capabilities: [], runtimes: [], auth: await auth(), cursorStore: { load: async () => undefined, save: async () => {} } as never,
      onEnvelope: () => {}, onHalted, longPollRetryDelayMs: 1,
    });
    await connection.start();
    await vi.waitFor(() => expect(connection!.isOpen()).toBe(true));
    expect(hello).toHaveBeenCalledTimes(2);
    expect(onHalted).not.toHaveBeenCalled();
  });

  it('validates outcomes against ids, enums and counts, while tolerating unknown reasons', async () => {
    const client = new LongPollClient({ serverUrl: 'http://example.invalid', auth: await auth(), getCursor: () => 0, onEnvelope: () => {} });
    const envelope = createEnvelope('task.started', {}, { taskId: 'task' });
    const response = vi.fn(); vi.stubGlobal('fetch', response);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cases = [
      { accepted: 1, outcomes: [] },
      { accepted: 1, outcomes: [{ id: crypto.randomUUID(), outcome: 'accepted' }] },
      { accepted: 1, outcomes: [{ id: envelope.id, outcome: 'future' }] },
      { accepted: 1, outcomes: [{ id: envelope.id, outcome: 'rejected' }] },
      { accepted: 1, outcomes: [{ id: envelope.id, outcome: 'accepted', reason: 'not_permitted' }] },
    ];
    for (const body of cases) {
      response.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
      expect(await client.postBatch([envelope])).toBeUndefined();
    }
    response.mockResolvedValueOnce(new Response(JSON.stringify({ accepted: 0, rejected: 1, outcomes: [{ id: envelope.id, outcome: 'rejected', reason: 'future_observation' }] }), { status: 200 }));
    expect(await client.postBatch([envelope])).toEqual({ accepted: 0, rejected: 1, outcomes: [{ id: envelope.id, outcome: 'rejected', reason: 'unknown' }] });
  });

  it.each([
    ['a counts-only answer without outcomes', 'business', (_id: string) => ({ accepted: 1 }), /outcomes/],
    ['a counts-only rejection without outcomes', 'business', (_id: string) => ({ accepted: 0, rejected: 1 }), /outcomes/],
    ['a rejected outcome without its reason', 'business', (id: string) => ({ accepted: 0, rejected: 1, outcomes: [{ id, outcome: 'rejected' }] }), /lacks its reason/],
    ['an accepted conn.hello without ingress', 'hello', (id: string) => ({ accepted: 1, outcomes: [{ id, outcome: 'accepted' }] }), /ingress/],
    ['a deduplicated conn.hello without ingress', 'hello', (id: string) => ({ accepted: 1, outcomes: [{ id, outcome: 'duplicate' }] }), /ingress/],
  ] as const)('rejects %s through the route-failure path (wire v3)', async (_label, kind, body, cause) => {
    const client = new LongPollClient({ serverUrl: 'http://example.invalid', auth: await auth(), getCursor: () => 0, onEnvelope: () => {} });
    const envelope = kind === 'hello'
      ? helloEnvelope()
      : createEnvelope('task.started', {}, { taskId: 'task' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body(envelope.id)), { status: 200 })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await client.postBatch([envelope])).toBeUndefined();
    const failure = warn.mock.calls.map(([, error]) => error).find((error) => error instanceof LongPollRouteError) as LongPollRouteError | undefined;
    expect(failure?.status).toBe(200);
    expect(String((failure?.cause as Error | undefined)?.message ?? failure?.cause)).toMatch(cause);
  });

  it('has no activity ingress before the accepted handshake and adopts the handshake advertisement', async () => {
    const advertised = { activityMaxEvents: 7, activityMaxBytes: 4096 };
    vi.spyOn(LongPollClient.prototype, 'postBatch').mockImplementation(async (batch) => ({ ...helloAccepted(batch[0]!), ingress: advertised }));
    vi.spyOn(LongPollClient.prototype, 'start').mockImplementation(() => {});
    vi.spyOn(LongPollClient.prototype, 'stop').mockImplementation(() => {});
    connection = new ConnectionManager({ serverUrl: 'http://example.invalid', deviceId: 'settlement-device', productId: 'test',
      capabilities: [], runtimes: [], auth: await auth(), cursorStore: { load: async () => undefined, save: async () => {} } as never,
      onEnvelope: () => {}, longPollRetryDelayMs: 1,
    });
    expect(() => connection!.getIngressBudget()).toThrow(/no activity ingress has been advertised/);
    await connection.start();
    await vi.waitFor(() => expect(connection!.isOpen()).toBe(true));
    expect(connection.getIngressBudget()).toEqual(advertised);
  });

  it('accepts a handshake answer that carries ingress and a rejected hello answer that carries none', async () => {
    const client = new LongPollClient({ serverUrl: 'http://example.invalid', auth: await auth(), getCursor: () => 0, onEnvelope: () => {} });
    const hello = helloEnvelope();
    const response = vi.fn(); vi.stubGlobal('fetch', response);
    response.mockResolvedValueOnce(new Response(JSON.stringify(helloAccepted(hello)), { status: 200 }));
    expect(await client.postBatch([hello])).toEqual(helloAccepted(hello));
    const refused = { accepted: 0, rejected: 1, outcomes: [{ id: hello.id, outcome: 'rejected', reason: 'unsupported' }] };
    response.mockResolvedValueOnce(new Response(JSON.stringify(refused), { status: 200 }));
    expect(await client.postBatch([hello])).toEqual(refused);
  });
});
