import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createByokServer, type ByokServer } from '../index';
import {
  connectFakeDaemonLongPoll,
  nextEnvelope,
  startServer,
  stopServer,
  type FakeLongPollDaemon,
} from './test-support';

const PRODUCT_ID = 'acme';
/** Short enough that a poll expecting nothing answers in ~200ms instead of ~50s. */
const SHORT_HOLD_MS = 200;

describe('dispatchSelection authority', () => {
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

  async function connect(
    started: { byok: ByokServer; baseUrl: string },
    capabilities: string[],
  ): Promise<FakeLongPollDaemon> {
    return connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID, capabilities });
  }

  it('derives the requested runtime and carries the exact BYOK selection in task.offer', async () => {
    const started = await start();
    const daemon = await connect(started, ['dispatch-selection']);

    const dispatchSelection = {
      lane: 'byok' as const,
      runtimeId: 'pi' as const,
      providerId: 'openai',
      modelId: 'gpt-5.2',
    };
    const handle = await started.byok.dispatch({ instruction: 'use exact target', dispatchSelection });
    const offer = await nextEnvelope(daemon);

    expect(offer.type).toBe('task.offer');
    if (offer.type !== 'task.offer') throw new Error('unreachable');
    expect(offer.task_id).toBe(handle.taskId);
    expect(offer.payload.runtime).toBe('pi');
    expect(offer.payload.dispatchSelection).toEqual(dispatchSelection);
  });

  it('rejects a contradictory legacy runtime before creating or offering a task', async () => {
    const started = await start();
    await connect(started, ['dispatch-selection']);

    await expect(
      started.byok.dispatch({
        instruction: 'contradictory target',
        runtime: 'claude',
        dispatchSelection: {
          lane: 'byok',
          runtimeId: 'pi',
          providerId: 'openai',
          modelId: 'gpt-5.2',
        },
      }),
    ).rejects.toThrow(/does not match dispatchSelection\.runtimeId pi/);
  });

  it('runtime-validates a JavaScript caller selection before any task is created', async () => {
    const started = await start();
    await connect(started, ['dispatch-selection']);

    await expect(
      started.byok.dispatch({
        instruction: 'malformed target',
        dispatchSelection: {
          lane: 'subscription',
          runtimeId: 'pi',
          providerId: null,
          modelId: 'gpt-5.2',
        } as never,
      }),
    ).rejects.toThrow();
  });

  it('refuses to send a selection to an older v1 daemon that would strip the additive field', async () => {
    const started = await start();
    await connect(started, []);

    await expect(
      started.byok.dispatch({
        instruction: 'must not degrade to runtime-only dispatch',
        dispatchSelection: {
          lane: 'subscription',
          runtimeId: 'codex',
          providerId: null,
          modelId: 'gpt-5.6-sol',
        },
      }),
    ).rejects.toThrow(/did not advertise dispatch-selection capability/);
    expect((await started.byok.tasks.list()).tasks).toHaveLength(0);
  });
});
