import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createByokServer, type ByokServer } from '../index';
import {
  connectFakeDaemonLongPoll,
  nextEnvelope,
  startServer,
  stopServer,
  type FakeLongPollDaemon,
  type FakeLongPollDaemonOptions,
  TEST_AGENT_DISPATCH,
} from './test-support';

const PRODUCT_ID = 'acme';
/** Short enough that a poll expecting nothing answers in ~200ms instead of ~50s. */
const SHORT_HOLD_MS = 200;

describe('logical MCP toolset dispatch', () => {
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

  async function connect(
    started: { byok: ByokServer; baseUrl: string },
    opts: Omit<FakeLongPollDaemonOptions, 'productId'>,
  ): Promise<FakeLongPollDaemon> {
    return connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID, ...opts });
  }

  it('sends requiredToolsets on the Agent offer and persists only logical ids', async () => {
    const started = await start();
    const daemon = await connect(started, {
      capabilities: ['agent-home-contract', 'toolset-selection'],
      configuredToolsets: ['crm.readonly', 'salesko'],
      runtimes: [
        {
          id: 'claude',
          capabilities: { mcpToolsets: true },
        },
      ],
    });

    await started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId,
      instruction: 'find qualified leads',
      runtime: 'claude',
      requiredToolsets: ['salesko'],
    });
    const offer = await nextEnvelope(daemon);

    expect(offer.type).toBe('task.offer_for_agent');
    if (offer.type !== 'task.offer_for_agent') throw new Error('unreachable');
    expect(offer.payload.requiredToolsets).toEqual(['salesko']);
    expect(JSON.stringify(offer)).not.toMatch(/command|args|secret/i);
  });

  it('queues declared toolsets without using an advertised inventory as admission authority', async () => {
    const started = await start();
    const daemon = await connect(started, { capabilities: ['agent-home-contract', 'toolset-selection'] });
    const handle = await started.byok.dispatch({
      ...TEST_AGENT_DISPATCH,
      deviceId: daemon.deviceId,
      instruction: 'validate local tools when claimed',
      requiredToolsets: ['salesko'],
    });
    expect(await nextEnvelope(daemon)).toMatchObject({
      type: 'task.offer_for_agent', payload: { requiredToolsets: ['salesko'] },
    });
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Offered');
  });

  it('rejects before task creation when the device did not advertise toolset-selection', async () => {
    const started = await start();
    const daemon = await connect(started, { capabilities: ['agent-home-contract'] });

    await expect(
      started.byok.dispatch({
        ...TEST_AGENT_DISPATCH,
        deviceId: daemon.deviceId,
        instruction: 'must use Salesko',
        requiredToolsets: ['salesko'],
      }),
    ).rejects.toThrow(/did not advertise toolset-selection/);
    expect((await started.byok.tasks.list()).tasks).toHaveLength(0);
  });

  it('runtime-validates malformed and duplicate ids before task creation', async () => {
    const started = await start();
    const daemon = await connect(started, { capabilities: ['agent-home-contract', 'toolset-selection'] });

    await expect(
      started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'x', requiredToolsets: ['Salesko'] as never }),
    ).rejects.toThrow();
    await expect(
      started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'x', requiredToolsets: ['salesko', 'salesko'] }),
    ).rejects.toThrow();
    expect((await started.byok.tasks.list()).tasks).toHaveLength(0);
  });
});
