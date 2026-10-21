import type { Server as HttpServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { AGENT_MEMORY_INTENT_CAPABILITY } from '@byok-sdk/protocol';
import { createByokServer, type ByokServer } from '../index';
import { connectFakeDaemonLongPoll, startServer, stopServer } from './test-support';

const productId = 'embedded-memory-intent';
const notice = { intentId: '00000000-0000-4000-8000-000000000001', agentRef: { agentId: 'main', profileRevision: '1' } };
let byok: ByokServer | undefined;
let http: HttpServer | undefined;
afterEach(async () => { await byok?.close(); if (http) await stopServer(http); byok = undefined; http = undefined; });

async function start(capabilities = ['agent-home-contract', AGENT_MEMORY_INTENT_CAPABILITY]) {
  byok = createByokServer({ productId, longPollHoldMs: 20 });
  const started = await startServer(byok); http = started.server;
  const daemon = await connectFakeDaemonLongPoll(started.baseUrl, byok, { productId, capabilities });
  return { server: byok, daemon };
}

it('enqueues an exact content-free memory notice through the embedded device mailbox and deduplicates it', async () => {
  const { server, daemon } = await start();
  await expect(server.enqueueAgentMemoryIntentNotice(daemon.deviceId, { ...notice, content: 'must not enter the mailbox' } as typeof notice))
    .rejects.toThrow();
  expect((await daemon.next()).filter(row => row.type === 'agent.memory.intent.available')).toEqual([]);
  const first = await server.enqueueAgentMemoryIntentNotice(daemon.deviceId, notice);
  const repeated = await server.enqueueAgentMemoryIntentNotice(daemon.deviceId, notice);
  expect(repeated).toEqual(first);
  expect(first.envelope).toMatchObject({ type: 'agent.memory.intent.available', payload: notice });
  expect(first.envelope.task_id).toBeUndefined();
  expect((await daemon.next()).filter(row => row.type === 'agent.memory.intent.available')).toEqual([first.envelope]);
  expect((await server.tasks.list()).tasks).toHaveLength(0);
  await expect(server.enqueueAgentMemoryIntentNotice(daemon.deviceId, { ...notice, agentRef: { ...notice.agentRef, profileRevision: '2' } }))
    .rejects.toThrow('does not carry Agent memory intent notice');
});

it('preserves capability admission', async () => {
  const { server, daemon } = await start(['agent-home-contract']);
  await expect(server.enqueueAgentMemoryIntentNotice(daemon.deviceId, notice)).rejects.toThrow(AGENT_MEMORY_INTENT_CAPABILITY);
  expect((await daemon.next()).filter(row => row.type === 'agent.memory.intent.available')).toEqual([]);
});

it('refuses a revoked device instead of allocating a memory notice', async () => {
  const { server, daemon } = await start();
  await server.devices.revoke(daemon.deviceId);
  await expect(server.enqueueAgentMemoryIntentNotice(daemon.deviceId, notice)).rejects.toThrow();
});
