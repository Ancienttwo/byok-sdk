import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createByokServer, type ByokServer } from '../index';
import { connectFakeDaemonLongPoll, nextEnvelope, startServer, stopServer } from './test-support';

const PRODUCT_ID = 'acme';
const AGENT_REF = { agentId: 'reader-agent', profileRevision: 'profile-r1' } as const;

/** #317: reference-server dispatch threads `homeAccess` and the kernel gates it on `agent-home-readers`. */
describe('reference-server memory-reader dispatch (#317)', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    byok?.stop();
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

  it('refuses homeAccess without an AgentRef', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract', 'agent-home-readers'],
    });
    await expect(started.byok.dispatch({
      deviceId: daemon.deviceId,
      instruction: 'legacy reader',
      homeAccess: 'memory-reader',
    })).rejects.toThrow(/homeAccess requires an explicit AgentRef/);
  });

  it('refuses a reader dispatch to a device without agent-home-readers before creating the task', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract'],
    });
    await expect(started.byok.dispatch({
      deviceId: daemon.deviceId,
      taskId: 'reader-refused',
      instruction: 'read memory',
      agentRef: AGENT_REF,
      homeAccess: 'memory-reader',
    })).rejects.toMatchObject({ code: 'agent_capability_missing' });
    expect(await started.byok.tasks.attempt('reader-refused')).toBeUndefined();
  });

  it('delivers homeAccess on the Agent offer to a device that advertises agent-home-readers', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract', 'agent-home-readers'],
    });
    await started.byok.dispatch({
      deviceId: daemon.deviceId,
      instruction: 'read memory',
      agentRef: AGENT_REF,
      homeAccess: 'memory-reader',
    });
    const offered = await nextEnvelope(daemon);
    expect(offered.type).toBe('task.offer_for_agent');
    expect(offered.payload).toMatchObject({ agentRef: AGENT_REF, homeAccess: 'memory-reader' });
  });
});
