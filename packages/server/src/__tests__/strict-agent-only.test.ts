import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createByokServer, type ByokServer } from '../index';
import { connectFakeDaemonLongPoll, nextEnvelope, startServer, stopServer } from './test-support';

const PRODUCT_ID = 'strict-agent-only-test';
/** Short enough that a poll expecting nothing answers in ~200ms instead of ~50s. */
const SHORT_HOLD_MS = 200;

describe('strict-agent-only producer scheduling defence', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    byok?.stop();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  async function start(): Promise<{ byok: ByokServer; baseUrl: string }> {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    const started = await startServer(instance);
    server = started.server;
    byok = instance;
    return { byok: instance, baseUrl: started.baseUrl };
  }

  it('rejects an explicit legacy dispatch before task store/mailbox mutation', async () => {
    const started = await start();
    const strict = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['strict-agent-only', 'agent-home-contract'],
    });

    await expect(started.byok.dispatch({ deviceId: strict.deviceId, instruction: 'legacy' })).rejects.toThrow(
      /strict-agent-only/i,
    );
    expect((await started.byok.tasks.list()).tasks).toEqual([]);
  });

  it('skips strict devices in implicit legacy selection but admits Agent offers to them', async () => {
    const started = await start();
    const strict = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['strict-agent-only', 'agent-home-contract'],
    });
    const regular = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      deviceName: 'regular-laptop',
      capabilities: [],
    });

    const legacy = await started.byok.dispatch({ instruction: 'implicit legacy' });
    expect((await started.byok.tasks.get(legacy.taskId))?.deviceId).toBe(regular.deviceId);
    await expect(nextEnvelope(regular)).resolves.toMatchObject({ type: 'task.offer' });

    const agent = await started.byok.dispatch({
      deviceId: strict.deviceId,
      instruction: 'Agent work',
      agentRef: { agentId: 'agent-1', profileRevision: 'r1' },
    });
    expect((await started.byok.tasks.get(agent.taskId))?.deviceId).toBe(strict.deviceId);
    await expect(nextEnvelope(strict)).resolves.toMatchObject({ type: 'task.offer_for_agent' });
  });
});
