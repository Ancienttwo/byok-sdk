import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createByokServer, type ByokServer } from '../index';
import { connectFakeDaemonLongPoll, nextEnvelope, startServer, stopServer } from './test-support';

const PRODUCT_ID = 'acme';
const AGENT_REF = { agentId: 'memory-agent', profileRevision: 'profile-r1' } as const;

/** #614: reference-server dispatch threads `agentMemory` and the kernel gates it on `agent-memory-selection`. */
describe('reference-server per-task Agent memory dispatch (#614)', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    await byok?.close();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  async function start(): Promise<{ byok: ByokServer; baseUrl: string }> {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: 200 });
    const started = await startServer(instance);
    server = started.server;
    byok = instance;
    return { byok: instance, baseUrl: started.baseUrl };
  }

  it('refuses agentMemory without an AgentRef', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract', 'agent-memory-selection'],
    });
    await expect(started.byok.dispatch({
      deviceId: daemon.deviceId,
      instruction: 'legacy task',
      agentMemory: 'none',
    })).rejects.toThrow(/agentMemory requires an explicit AgentRef/);
  });

  it('refuses an agentMemory dispatch to a device without agent-memory-selection before creating the task', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract'],
    });
    await expect(started.byok.dispatch({
      deviceId: daemon.deviceId,
      taskId: 'memory-refused',
      instruction: 'plan only',
      agentRef: AGENT_REF,
      sessionRef: 'memory-session',
      agentMemory: 'none',
    })).rejects.toMatchObject({ code: 'agent_capability_missing' });
    expect(await started.byok.tasks.attempt('memory-refused')).toBeUndefined();
  });

  it('delivers agentMemory on the Agent offer to a device that advertises agent-memory-selection', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract', 'agent-memory-selection'],
    });
    await started.byok.dispatch({
      deviceId: daemon.deviceId,
      instruction: 'read memory',
      agentRef: AGENT_REF,
      sessionRef: 'memory-session',
      agentMemory: 'read',
    });
    const offered = await nextEnvelope(daemon);
    expect(offered.type).toBe('task.offer_for_agent');
    expect(offered.payload).toMatchObject({ agentRef: AGENT_REF, agentMemory: 'read' });
  });
});
