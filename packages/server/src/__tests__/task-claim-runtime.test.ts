import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createByokServer, type ByokServer } from '../index';
import {
  connectFakeDaemonLongPoll,
  sendOne,
  startServer,
  stopServer,
  waitForServerEvent,
  type FakeLongPollDaemon,
  TEST_AGENT_DISPATCH,
  TEST_AGENT_REF,
} from './test-support';

const PRODUCT_ID = 'acme';
/** Short enough that a poll expecting nothing answers in ~200ms instead of ~50s. */
const SHORT_HOLD_MS = 200;

/**
 * Claimed executor (wire v7, docs/protocol.md §3.1): `task.claim` carries
 * `executor` — what the daemon ACTUALLY runs the task with — snapshotted by the
 * cloud kernel's inbound gate at the `offered -> claimed` ownership CAS and
 * read back through `TaskSnapshot.claimedExecutor`.
 *
 * The pre-fold counterpart `TaskSnapshot.runtime` (the merely REQUESTED
 * runtime) is gone: it was dispatch INPUT the host already holds and the kernel
 * does not persist (ADR-028), so the "requested field stays untouched" half of
 * each case below has no field left to assert on. What survives — that the
 * claim's own report is recorded independently of what was requested — is
 * pinned by the two dispatch targets below, one naming a runtime and one
 * `auto`.
 */
describe('claimed executor: task.claim.executor -> TaskSnapshot.claimedExecutor', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    await byok?.close();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  async function startWithDaemon(): Promise<{ byok: ByokServer; daemon: FakeLongPollDaemon }> {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    const started = await startServer(instance);
    server = started.server;
    byok = instance;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, instance, { productId: PRODUCT_ID });
    return { byok: instance, daemon };
  }

  it('an offer dispatched with an auto target: task.claim.executor sets claimedExecutor', async () => {
    const { byok: instance, daemon } = await startWithDaemon();

    const handle = await instance.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'auto-select this' });

    const claim = await sendOne(
      daemon,
      createEnvelope('task.claim', { agentRef: TEST_AGENT_REF, deviceId: daemon.deviceId, executor: { id: 'pi' } }, { taskId: handle.taskId }),
    );
    expect(claim).toMatchObject({ status: 200, body: { accepted: 1 } });

    const snapshot = await instance.tasks.get(handle.taskId);
    expect(snapshot?.state).toBe('Claimed');
    expect(snapshot?.claimedExecutor).toEqual({ id: 'pi' });
  });

  it('an offer dispatched WITH a runtime target: task.claim.executor is recorded independently as claimedExecutor', async () => {
    const { byok: instance, daemon } = await startWithDaemon();

    const handle = await instance.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'explicit runtime', target: { lane: 'harness', harnessId: 'claude', selection: { mode: 'device-default' } } });

    const claim = await sendOne(
      daemon,
      createEnvelope('task.claim', { agentRef: TEST_AGENT_REF, deviceId: daemon.deviceId, executor: { id: 'claude' } }, { taskId: handle.taskId }),
    );
    expect(claim).toMatchObject({ status: 200, body: { accepted: 1 } });

    expect((await instance.tasks.get(handle.taskId))?.claimedExecutor).toEqual({ id: 'claude' });
  });

  it('the task.state ByokServerEvent fired on Offered -> Claimed carries claimedExecutor, mirroring the snapshot', async () => {
    const { byok: instance, daemon } = await startWithDaemon();

    const handle = await instance.dispatch({ ...TEST_AGENT_DISPATCH, deviceId: daemon.deviceId, instruction: 'observe the server event' });
    await sendOne(
      daemon,
      createEnvelope('task.claim', { agentRef: TEST_AGENT_REF, deviceId: daemon.deviceId, executor: { id: 'codex' } }, { taskId: handle.taskId }),
    );

    const event = await waitForServerEvent(
      instance,
      (e) => e.kind === 'task.state' && e.taskId === handle.taskId && e.state === 'Claimed',
    );
    if (event.kind !== 'task.state') throw new Error('unreachable');
    expect(event.claimedExecutor).toEqual({ id: 'codex' });
    expect(event.claimedExecutor).toEqual((await instance.tasks.get(handle.taskId))?.claimedExecutor);
  });
});
