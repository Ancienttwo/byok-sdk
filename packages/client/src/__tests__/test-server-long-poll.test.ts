import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { TestServer } from './fixtures/test-server';

describe('TestServer scripted long-poll redelivery', () => {
  let server: TestServer;
  let accessToken: string;

  beforeEach(async () => {
    server = await TestServer.start();
    const { publicKey } = generateKeyPairSync('ed25519');
    const response = await fetch(`${server.url}/byok/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairingCode: 'fixture-redelivery', deviceName: 'fixture', machineId: 'fixture',
        devicePublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      }),
    });
    expect(response.status).toBe(200);
    accessToken = ((await response.json()) as { accessToken: string }).accessToken;
  });

  afterEach(async () => { await server.close(); });

  async function poll(afterSeq: number): Promise<unknown[]> {
    const response = await fetch(`${server.url}/byok/events?cursor=1&afterSeq=${afterSeq}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { events: unknown[] }).events;
  }

  it('retains a queued retry across read-ahead until the client rewinds to its durable cursor', async () => {
    const retry = createEnvelope('task.offer', {
      instruction: 'retry after failed handling', policy: { mode: 'auto' },
    }, { taskId: 'retry', seq: 2 });
    server.pushLongPollEvent(retry);

    // Force the losing order from the gate: the navigation cursor has read seq2,
    // but only seq1 is durable. This empty read must not erase the queued retry.
    expect(await poll(2)).toEqual([]);
    expect(await poll(1)).toEqual([retry]);
    // TestServer still scripts each delivery; it does not implement ACK storage.
    expect(await poll(1)).toEqual([]);
  });

  it('preserves scripted order and raw protocol entries while retaining excluded sequences', async () => {
    const deferred = { seq: 2, type: 'future.deferred' };
    const raw = { type: 'future.without-seq' };
    const next = { seq: 3, type: 'future.next' };
    server.pushRawLongPollEvent(deferred);
    server.pushRawLongPollEvent(raw);
    server.pushRawLongPollEvent(next);
    expect(await poll(2)).toEqual([raw, next]);
    expect(await poll(1)).toEqual([deferred]);
    expect(await poll(0)).toEqual([]);
  });
});
