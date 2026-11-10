import type { Server as HttpServer } from 'node:http';
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
const SELECTION = { lane: 'byok', runtimeId: 'pi', providerId: 'openai', modelId: 'gpt-5.2' } as const;
const POLICY = {
  policyRevision: '1', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
} as const;
const TENANT = storeModule.serverTenantId(PRODUCT_ID);

describe('dispatchSelection authority', () => {
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

    const dispatchSelection = {
      lane: 'byok' as const,
      runtimeId: 'pi' as const,
      providerId: 'openai',
      modelId: 'gpt-5.2',
    };
    const handle = await started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'use exact target', dispatchSelection });
    const offer = await nextEnvelope(daemon);

    expect(offer.type).toBe('task.offer');
    if (offer.type !== 'task.offer') throw new Error('unreachable');
    expect(offer.task_id).toBe(handle.taskId);
    expect(offer.payload).not.toHaveProperty('runtime');
    expect(offer.payload.dispatchSelection).toEqual(dispatchSelection);
    expect((await started.byok.tasks.offer(handle.taskId))?.payload).toEqual(offer.payload);
    const direct = await started.kernel.enqueueAgentOffer(TENANT, daemon.deviceId, {
      taskId: 'direct-selection', payload: { instruction: 'use exact target', agentRef: TEST_AGENT_DISPATCH.agentRef,
        session: { mode: 'resume', sessionRef: TEST_AGENT_DISPATCH.sessionRef }, dispatchSelection },
    });
    expect(JSON.stringify(offer.payload)).toBe(JSON.stringify(direct.envelope.payload));
  });

  it('rejects a contradictory legacy runtime before creating or offering a task', async () => {
    const started = await start();
    const daemon = await connect(started, ['dispatch-selection']);

    await expect(
      started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId,
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
    const daemon = await connect(started, ['dispatch-selection']);

    await expect(
      started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId,
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
    const daemon = await connect(started, []);

    await expect(
      started.byok.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId,
        instruction: 'must not degrade to runtime-only dispatch',
        dispatchSelection: {
          lane: 'subscription',
          runtimeId: 'codex',
          providerId: null,
          modelId: 'gpt-5.6-sol',
        },
      }),
    ).rejects.toMatchObject({ name: 'ByokCloudError', code: 'agent_capability_missing' });
    expect((await started.byok.tasks.list()).tasks).toHaveLength(0);
  });

  it.each(['dispatch', 'egress dispatch', 'submit'] as const)('%s returns the kernel error class and code/path', async (lane) => {
    const started = await start();
    const daemon = await connect(started, []);
    const cases = [
      { fields: { runtime: 'claude', dispatchSelection: SELECTION }, path: 'runtime' },
      { fields: { homeAccess: 'memory-reader', agentMemory: 'read-write' }, path: 'agentMemory' },
      { fields: { homeAccess: 'memory-reader', agentMemory: 'read-write-if-admitted' }, path: 'agentMemory' },
      { fields: { dispatchSelection: SELECTION }, code: 'agent_capability_missing' },
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
        ...(lane === 'dispatch' ? {} : { egressPolicy: POLICY, runtime: 'pi', terminalProjection: { mode: 'none' } }),
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
      session: { mode: 'fresh' as const }, runtime: 'pi' as const, egressPolicy: POLICY, terminalProjection: { mode: 'none' as const } } };
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
      instruction: 'retry exact bytes', dispatchSelection: SELECTION, requiredToolsets: ['crm.readonly'] };
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
