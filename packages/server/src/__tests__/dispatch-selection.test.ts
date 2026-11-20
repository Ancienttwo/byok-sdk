import type { Server as HttpServer } from 'node:http';
import type { ExecutionTarget } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cloudModule from '@byok-sdk/cloud';
import * as storeModule from '../stores';
import { createByokServer, type ByokServer, type DispatchInput } from '../index';
import {
  connectFakeDaemonLongPoll,
  nextEnvelope,
  startServer,
  stopServer,
  type FakeLongPollDaemon,
  TEST_AGENT_DISPATCH,
} from './test-support';

const PRODUCT_ID = 'acme';
/** Short enough that a poll expecting nothing answers in ~200ms instead of ~50s. */
const SHORT_HOLD_MS = 200;
const SELECTION = { lane: 'harness', harnessId: 'pi', selection: { mode: 'byok-profile', modelId: 'gpt-5.2', providerProfile: {
  profileRef: 'local-openai', profileRevision: '1', profileHash: `sha256:${'a'.repeat(64)}`, requiredCapabilities: [],
} } } satisfies ExecutionTarget;
const POLICY = {
  policyRevision: '1', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
} as const;
const TENANT = storeModule.serverTenantId(PRODUCT_ID);

describe('dispatch target authority', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    await byok?.close();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
    vi.restoreAllMocks();
  });

  async function start() {
    const cloudFactory = vi.spyOn(cloudModule, 'createByokCloud');
    const storeFactory = vi.spyOn(storeModule, 'composeFacadeStores');
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    const started = await startServer(instance);
    server = started.server;
    byok = instance;
    return { byok: instance, baseUrl: started.baseUrl,
      kernel: cloudFactory.mock.results[0]!.value as cloudModule.ByokCloud,
      stores: storeFactory.mock.results[0]!.value as storeModule.FacadeStoreComposition };
  }

  async function connect(
    started: { byok: ByokServer; baseUrl: string },
    capabilities: string[],
  ): Promise<FakeLongPollDaemon> {
    return connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID, capabilities: ['agent-home-contract', ...capabilities] });
  }

  it('preserves the selected target without deriving runtime in the mailbox or recorded offer', async () => {
    const started = await start();
    const daemon = await connect(started, ['dispatch-selection']);

    const handle = await started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'use exact target', target: SELECTION });
    const offer = await nextEnvelope(daemon);

    expect(offer.type).toBe('task.offer');
    if (offer.type !== 'task.offer') throw new Error('unreachable');
    expect(offer.task_id).toBe(handle.taskId);
    expect(offer.payload).not.toHaveProperty('runtime');
    expect(offer.payload.target).toEqual(SELECTION);
    expect((await started.byok.tasks.offer(handle.taskId))?.payload).toEqual(offer.payload);
    const direct = await started.kernel.enqueueAgentOffer(TENANT, daemon.deviceId, {
      taskId: 'direct-selection', payload: { instruction: 'use exact target', agentRef: TEST_AGENT_DISPATCH.agentRef,
        session: { mode: 'resume', sessionRef: TEST_AGENT_DISPATCH.sessionRef }, target: SELECTION },
    });
    expect(JSON.stringify(offer.payload)).toBe(JSON.stringify(direct.envelope.payload));
  });

  it('runtime-validates a JavaScript caller selection before any task is created', async () => {
    const started = await start();
    const daemon = await connect(started, ['dispatch-selection']);

    await expect(
      started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId,
        instruction: 'malformed target',
        target: {
          lane: 'harness',
          harnessId: 'pi',
          selection: { mode: 'subscription', modelId: 'gpt-5.2' },
        } as never,
      }),
    ).rejects.toThrow();
  });

  it('refuses to send an unsupported selection to a registered executor', async () => {
    const started = await start();
    const daemon = await connect(started, []);

    await expect(
      started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId,
        instruction: 'must not degrade to runtime-only dispatch',
        target: {
          lane: 'harness',
          harnessId: 'codex',
          selection: { mode: 'adapter-model', modelId: 'gpt-5.6-sol' },
        },
      }),
    ).rejects.toMatchObject({ name: 'ByokCloudError', code: 'agent_capability_missing' });
    expect((await started.byok.tasks.list()).tasks).toHaveLength(0);
  });

  it.each(['dispatch', 'egress dispatch', 'submit'] as const)('%s returns the kernel error class and code/path', async (lane) => {
    const started = await start();
    const daemon = await connect(started, []);
    const cases = [
      { fields: { homeAccess: 'memory-reader', agentMemory: 'read-write' }, path: 'agentMemory' },
      { fields: { homeAccess: 'memory-reader', agentMemory: 'read-write-if-admitted' }, path: 'agentMemory' },
      { fields: { target: { ...SELECTION, harnessId: 'unadvertised' } }, code: 'agent_capability_missing' },
      { fields: { requiredToolsets: ['crm.readonly'] }, code: 'agent_capability_missing' },
      ...(lane === 'submit'
        ? [{ fields: { sealing: {} }, code: 'coordination_input_invalid' }, { fields: { sealed: {} }, code: 'coordination_input_invalid' }]
        : [{ fields: { session: { mode: 'resume', sessionRef: undefined } }, code: 'coordination_input_invalid' },
          { fields: { session: { mode: 'resume', sessionRef: '' } }, code: 'coordination_input_invalid' }]),
    ];
    for (const [index, test] of cases.entries()) {
      const taskId = `parity-${index}`;
      const payload = { instruction: 'same admission', agentRef: TEST_AGENT_DISPATCH.agentRef,
        session: lane === 'submit' ? { mode: 'fresh' } : { mode: 'resume', sessionRef: TEST_AGENT_DISPATCH.sessionRef },
        ...(lane === 'dispatch' ? { target: { lane: 'auto' } } : { egressPolicy: POLICY, target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } }, terminalProjection: { mode: 'none' } }),
        ...test.fields };
      const input = { taskId, deviceId: daemon.deviceId, payload };
      const { session, ...fields } = payload;
      const embedded = lane === 'submit' ? started.byok.executions.submit(input as never)
        : started.byok.dispatch({ taskId, deviceId: daemon.deviceId, sessionRef: session.sessionRef, ...fields } as DispatchInput);
      const direct = lane === 'submit' ? started.kernel.submitAgentExecution(TENANT, input as never)
        : lane === 'dispatch' ? started.kernel.enqueueAgentOffer(TENANT, daemon.deviceId, input as never)
          : started.kernel.enqueueAgentEgressOffer(TENANT, daemon.deviceId, input as never);
      const [actual, expected] = await Promise.all([embedded, direct].map(call => call.catch(error => error)));
      expect(actual.constructor).toBe(expected.constructor);
      const shape = 'path' in test
        ? { name: 'ZodError', issues: [{ path: [...(lane === 'submit' ? ['payload'] : []), test.path] }] }
        : { name: 'ByokCloudError', code: test.code };
      expect(actual).toMatchObject(shape);
      expect(expected).toMatchObject(shape);
      expect(await started.byok.tasks.attempt(taskId)).toBeUndefined();
      expect(await started.byok.tasks.offer(taskId)).toBeUndefined();
    }
  });

  it.each([null, undefined])('submits %s to the kernel without a facade TypeError', async (input) => {
    const started = await start();
    const [actual, expected] = await Promise.all([
      started.byok.executions.submit(input as never), started.kernel.submitAgentExecution(TENANT, input as never),
    ].map(call => call.catch(error => error)));
    expect(actual.constructor).toBe(expected.constructor);
    expect(actual).toMatchObject({ name: 'ZodError', issues: [{ code: 'invalid_type', path: [] }] });
    expect(actual.issues).toEqual(expected.issues);
    expect((await started.byok.tasks.list()).tasks).toEqual([]);
  });

  it.each([
    { taskId: '' }, { taskId: 42 }, { deviceId: '' }, { deviceId: undefined },
    { agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: 'turn' } },
    { messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 } },
  ])('types facade-only input refusal: %j', async (fields) => {
    const started = await start();
    await expect(started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: 'unused', instruction: 'invalid', ...fields } as never))
      .rejects.toMatchObject({ name: 'ByokCloudError', code: 'coordination_input_invalid' });
    expect((await started.byok.tasks.list()).tasks).toEqual([]);
  });

  it.each(['dispatch', 'submit'] as const)('keeps taskId exclusion typed while %s is in flight', async (lane) => {
    const started = await start();
    const daemon = await connect(started, ['agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session']);
    const taskId = 'in-flight';
    const dispatch = { ...TEST_AGENT_DISPATCH, taskId, deviceId: daemon.deviceId, instruction: 'resume' };
    const execution = { taskId, deviceId: daemon.deviceId, payload: { instruction: 'fresh', agentRef: TEST_AGENT_DISPATCH.agentRef,
      session: { mode: 'fresh' as const }, target: { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } } as const, egressPolicy: POLICY, terminalProjection: { mode: 'none' as const } } };
    let release!: () => void;
    let entered!: () => void;
    const pendingAppend = new Promise<void>(resolve => { release = resolve; });
    const appending = new Promise<void>(resolve => { entered = resolve; });
    const append = started.stores.core.mailbox.append.bind(started.stores.core.mailbox);
    vi.spyOn(started.stores.core.mailbox, 'append').mockImplementationOnce(async (...args) => {
      entered();
      await pendingAppend;
      return append(...args);
    });
    const first = lane === 'dispatch' ? started.byok.dispatch(dispatch) : started.byok.executions.submit(execution);
    await appending;
    try {
      await expect(started.byok.dispatch(dispatch)).rejects.toMatchObject({ name: 'ByokCloudError', code: 'coordination_input_invalid' });
      await expect(started.byok.executions.submit(execution)).rejects.toMatchObject({ name: 'ByokCloudError', code: 'coordination_input_invalid' });
    } finally {
      release();
      await first;
    }
    expect(await started.byok.tasks.offer(taskId)).toMatchObject({ delivered: true });
  });

  it('retries a recorded offer without re-reading device capabilities after append refusal', async () => {
    const started = await start();
    const daemon = await connect(started, ['dispatch-selection', 'toolset-selection']);
    const input = { ...TEST_AGENT_DISPATCH, taskId: 'append-retry', deviceId: daemon.deviceId,
      instruction: 'retry exact bytes', target: SELECTION, requiredToolsets: ['crm.readonly'] };
    const append = vi.spyOn(started.stores.core.mailbox, 'append').mockRejectedValueOnce(new Error('append fault'));
    await expect(started.byok.dispatch(input)).rejects.toMatchObject({ code: 'task_offer_append_refused' });
    const recorded = await started.byok.tasks.offer(input.taskId);
    expect(recorded).toMatchObject({ delivered: false });
    expect(recorded?.payload).not.toHaveProperty('runtime');
    const deviceRead = vi.spyOn(started.stores.cloud.devices, 'get').mockImplementation(async () => {
      throw new Error('replay must not read the device');
    });
    await expect(started.byok.dispatch(input)).resolves.toMatchObject({ taskId: input.taskId });
    expect(deviceRead).not.toHaveBeenCalled();
    deviceRead.mockRestore();
    expect(append).toHaveBeenCalledTimes(2);
    const offer = await nextEnvelope(daemon);
    expect(offer.payload).toEqual(recorded?.payload);
    expect(await started.byok.tasks.offer(input.taskId)).toMatchObject({ delivered: true, payload: recorded?.payload });
  });
});
