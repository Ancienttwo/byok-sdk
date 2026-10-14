import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AuthManager } from '../daemon/auth-manager';
import { DeviceStore } from '../daemon/store';
import { ConnectionManager, type OutboundSettlement } from '../daemon/connection-manager';
import { LongPollClient } from '../daemon/long-poll-transport';
import { seedDeviceEnrollment } from './fixtures/device-enrollment';

const dirs: string[] = [];
let connection: ConnectionManager | undefined;
afterEach(async () => {
  await connection?.stop(); connection = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function auth(): Promise<AuthManager> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-settlement-')); dirs.push(dir);
  const store = new DeviceStore(dir);
  await seedDeviceEnrollment(store, {
    deviceId: 'settlement-device', tenantId: 'settlement-tenant', accessToken: 'test-token',
    expiresAt: new Date(Date.now() + 3600000).toISOString(), devicePrivateKeyPem: 'test', devicePublicKey: 'test',
  });
  const auth = new AuthManager({ serverUrl: 'http://example.invalid', store });
  await auth.loadExisting(); return auth;
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

function outcomes(batch: readonly Envelope[]) {
  return batch.map((envelope, index) => ({ id: envelope.id, outcome: index < 2 ? 'rejected' as const : 'accepted' as const,
    ...(index < 2 ? { reason: 'limit_exceeded' } : {}) }));
}

describe('outbound settlement contract #397', () => {
  it('settles a four-envelope mixed batch with one business POST, waiting before retire', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const settled: OutboundSettlement[] = [];
    const post = vi.spyOn(LongPollClient.prototype, 'postBatch').mockImplementation(async (batch) =>
      batch[0]?.type === 'conn.hello' ? { accepted: 1 } : { accepted: 2, rejected: 2, outcomes: outcomes(batch) });
    const batch = Array.from({ length: 4 }, (_, index) => createEnvelope('task.started', {}, { taskId: `task-${index}` }));
    const connection = await open(async (batch) => {
      if (batch[0]?.envelope.type !== 'conn.hello') { await gate; settled.push(...batch); }
    }, batch);
    await vi.waitFor(() => expect(post.mock.calls.filter(([messages]) => messages[0]?.type !== 'conn.hello')).toHaveLength(1));
    expect(connection.outboxLength()).toBe(4);
    expect(settled).toEqual([]);
    release();
    await vi.waitFor(() => expect(connection.outboxLength()).toBe(0));
    expect(settled.map(({ envelope, outcome, reason }) => [envelope.id, outcome, reason])).toEqual(batch.map((envelope, index) =>
      [envelope.id, index < 2 ? 'rejected' : 'accepted', index < 2 ? 'limit_exceeded' : undefined]));
    expect(post.mock.calls.filter(([messages]) => messages[0]?.type !== 'conn.hello')).toHaveLength(1);
  });

  it('retains identical envelope bytes when the awaited local settlement fails', async () => {
    const business: readonly Envelope[][] = [] as Envelope[][];
    const post = vi.spyOn(LongPollClient.prototype, 'postBatch').mockImplementation(async (batch) => {
      if (batch[0]?.type === 'conn.hello') return { accepted: 1 };
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
    const envelope = createEnvelope('task.complete', { summary: 'exact bytes', sessionRef: 'session' }, { taskId: 'task' });
    connection.send(envelope);
    await vi.waitFor(() => expect(connection.outboxLength()).toBe(0));
    expect(business).toHaveLength(2);
    expect(business[0]![0]).toBe(envelope); expect(business[1]![0]).toBe(envelope);
    expect(settled).toEqual([{ envelope, outcome: 'duplicate' }]);
    expect(post).toHaveBeenCalledTimes(3);
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
});
