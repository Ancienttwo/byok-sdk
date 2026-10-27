import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createByokServer, type ByokServer } from '../index';
import { connectFakeDaemonLongPoll, expectNoMoreEnvelopes, nextEnvelope, startServer, stopServer } from './test-support';

const PRODUCT_ID = 'agent-only-dispatch-test';
/** Short enough that a poll expecting nothing answers in ~200ms instead of ~50s. */
const SHORT_HOLD_MS = 200;

describe('wire v4: every dispatch is Agent-bound', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    await byok?.close();
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

  it('rejects a dispatch without an AgentRef before task store/mailbox mutation', async () => {
    const started = await start();
    const device = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract'],
    });

    // Wire v4 has no runtime-only offer; the type forbids this call, and the
    // runtime refuses it for an untyped caller.
    await expect(
      started.byok.dispatch({ deviceId: device.deviceId, instruction: 'legacy', sessionRef: 'sess-1' } as never),
    ).rejects.toThrow();
    expect((await started.byok.tasks.list()).tasks).toEqual([]);
    await expectNoMoreEnvelopes(device);
  });

  it('admits explicitly targeted Agent offers', async () => {
    const started = await start();
    const strict = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: ['agent-home-contract'],
    });
    const agent = await started.byok.dispatch({
      deviceId: strict.deviceId,
      instruction: 'Agent work',
      agentRef: { agentId: 'agent-1', profileRevision: 'r1' },
      sessionRef: 'sess-resume-1',
    });
    expect((await started.byok.tasks.get(agent.taskId))?.deviceId).toBe(strict.deviceId);
    await expect(nextEnvelope(strict)).resolves.toMatchObject({ type: 'task.offer' });
  });
});
