import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SKILL_SELECTION_CAPABILITY } from '@byok-sdk/protocol';
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
const SHORT_HOLD_MS = 200;
const EGRESS_POLICY = {
  policyRevision: 'policy-r1',
  activity: { delivery: 'latest-value' as const, maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
  transfers: { workspace: 'disabled' as const, transcript: 'disabled' as const, artifact: 'disabled' as const },
};

describe('logical skill dispatch', () => {
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

  it('sends requiredSkills on plain and egress Agent offers and persists only logical ids', async () => {
    const started = await start();
    const daemon = await connect(started, {
      capabilities: ['agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', SKILL_SELECTION_CAPABILITY],
      runtimes: [
        {
          id: 'pi',
          capabilities: { skills: true, selectionModes: ['device-default'], effort: false },
        },
      ],
    });

    await started.byok.dispatch({
      ...TEST_AGENT_DISPATCH,
      deviceId: daemon.deviceId,
      instruction: 'review pull request',
      target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } },
      requiredSkills: ['review', 'deploy.checklist'],
    });
    const plainOffer = await nextEnvelope(daemon);
    expect(plainOffer.type).toBe('task.offer');
    if (plainOffer.type !== 'task.offer') throw new Error('unreachable');
    expect(plainOffer.payload.requiredSkills).toEqual(['review', 'deploy.checklist']);
    expect(JSON.stringify(plainOffer)).not.toMatch(/path|pack|content|secret/i);

    await started.byok.dispatch({
      ...TEST_AGENT_DISPATCH,
      deviceId: daemon.deviceId,
      instruction: 'review with egress',
      target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } },
      egressPolicy: EGRESS_POLICY,
      requiredSkills: ['review'],
    });
    const egressOffer = await nextEnvelope(daemon);
    expect(egressOffer.type).toBe('task.offer');
    if (egressOffer.type !== 'task.offer') throw new Error('unreachable');
    expect(egressOffer.payload.requiredSkills).toEqual(['review']);
  });

  it('queues declared skills without requiring an advertised inventory as admission authority', async () => {
    const started = await start();
    const daemon = await connect(started, { capabilities: ['agent-home-contract', SKILL_SELECTION_CAPABILITY] });
    const handle = await started.byok.dispatch({
      ...TEST_AGENT_DISPATCH,
      deviceId: daemon.deviceId,
      instruction: 'resolve skills when claimed',
      requiredSkills: ['review'],
    });
    expect(await nextEnvelope(daemon)).toMatchObject({
      type: 'task.offer',
      payload: { requiredSkills: ['review'] },
    });
    expect((await started.byok.tasks.get(handle.taskId))?.state).toBe('Offered');
  });

  it('rejects before task creation when the device did not advertise skill-selection', async () => {
    const started = await start();
    const daemon = await connect(started, { capabilities: ['agent-home-contract'] });

    await expect(
      started.byok.dispatch({
        ...TEST_AGENT_DISPATCH,
        deviceId: daemon.deviceId,
        instruction: 'must use review skill',
        requiredSkills: ['review'],
      }),
    ).rejects.toMatchObject({ name: 'ByokCloudError', code: 'agent_capability_missing' });
    expect((await started.byok.tasks.list()).tasks).toHaveLength(0);
  });

  it('runtime-validates malformed, empty, duplicate, and oversized skill ids before task creation', async () => {
    const started = await start();
    const daemon = await connect(started, { capabilities: ['agent-home-contract', SKILL_SELECTION_CAPABILITY] });

    await expect(
      started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'x', requiredSkills: [] }),
    ).rejects.toThrow();
    await expect(
      started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'x', requiredSkills: ['Review'] as never }),
    ).rejects.toThrow();
    await expect(
      started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'x', requiredSkills: ['review', 'review'] }),
    ).rejects.toThrow();
    await expect(
      started.byok.dispatch({
        ...TEST_AGENT_DISPATCH,
        deviceId: daemon.deviceId,
        instruction: 'x',
        requiredSkills: Array.from({ length: 17 }, (_, index) => `skill-${index}`),
      }),
    ).rejects.toThrow();
    expect((await started.byok.tasks.list()).tasks).toHaveLength(0);
  });
});
