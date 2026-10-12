import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { TestServer } from './fixtures/test-server';

describe('TestServer message response holds', () => {
  let server: TestServer;
  let accessToken: string;

  beforeEach(async () => {
    server = await TestServer.start();
    const { publicKey } = generateKeyPairSync('ed25519');
    const response = await fetch(`${server.url}/byok/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairingCode: 'fixture-message-hold', deviceName: 'fixture', machineId: 'fixture',
        devicePublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      }),
    });
    expect(response.status).toBe(200);
    accessToken = ((await response.json()) as { accessToken: string }).accessToken;
  });

  afterEach(async () => { await server.close(); });

  function send(taskId: string): Promise<{ accepted: number }> {
    return fetch(`${server.url}/byok/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ messages: [createEnvelope('task.fail', { reason: 'interrupted' }, { taskId })] }),
    }).then(async (response) => {
      expect(response.status).toBe(200);
      return await response.json() as { accepted: number };
    });
  }

  it('holds only the matching response and records its envelope before release', async () => {
    const release = server.holdNextMessagesResponse((event) => event.task_id === 'held');
    let accepted = false;
    const response = send('held').then((body) => { accepted = true; return body; });
    try {
      await server.waitFor((event) => event.task_id === 'held');
      expect(await send('unmatched')).toEqual({ accepted: 1 });
      expect(accepted).toBe(false);
      release();
      expect(await response).toEqual({ accepted: 1 });
      expect(await send('held')).toEqual({ accepted: 1 });
    } finally {
      release();
      await response;
    }
  });

  it('close releases every response already held in a handler', async () => {
    const releases: Array<() => void> = [];
    const responses: Array<Promise<{ accepted: number }>> = [];
    let closing: Promise<void> | undefined;
    try {
      for (const taskId of ['held-1', 'held-2']) {
        releases.push(server.holdNextMessagesResponse((event) => event.task_id === taskId));
        responses.push(send(taskId));
        await server.waitFor((event) => event.task_id === taskId);
      }
      let closed = false;
      closing = server.close().then(() => { closed = true; });
      await vi.waitFor(() => expect(closed).toBe(true));
      expect(await Promise.all(responses)).toEqual([{ accepted: 1 }, { accepted: 1 }]);
    } finally {
      for (const release of releases) release();
      await Promise.all(responses);
      await closing;
    }
  });
});
