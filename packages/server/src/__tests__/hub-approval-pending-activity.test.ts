import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createByokServer, type ByokServer, type TaskHandle } from '../index';
import {
  connectFakeDaemonLongPoll,
  sendOne,
  startServer,
  stopServer,
  TEST_AGENT_DISPATCH,
  TEST_AGENT_REF,
  waitForServerEvent,
  waitForTaskEvent,
  type FakeLongPollDaemon,
} from './test-support';

const PRODUCT_ID = 'acme';
/** Short injected hold so a long-poll in these tests never waits out the real ~50s default. */
const SHORT_HOLD_MS = 150;

/** Offered -> Claimed -> Running over the long-poll send path. */
async function claimAndStart(daemon: FakeLongPollDaemon, handle: TaskHandle): Promise<void> {
  await daemon.send(createEnvelope('task.claim', { deviceId: daemon.deviceId }, { taskId: handle.taskId }));
  await daemon.send(createEnvelope('task.started', {}, { taskId: handle.taskId }));
  await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
}

/** Running -> AwaitApproval over the long-poll send path. */
async function moveToAwaitApproval(
  daemon: FakeLongPollDaemon,
  handle: TaskHandle,
  approvalId: string,
  summary = 'needs a human ok',
): Promise<void> {
  await daemon.send(createEnvelope('task.await_approval', { summary, approvalId }, { taskId: handle.taskId }));
  await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'AwaitApproval');
}

/**
 * Wire v4: the daemon reports every approval it resolves locally with
 * `task.approval_resolved`, and that report is the server's only source for
 * one. Later task activity never resolves a pending approval.
 */
describe('a pending approval is resolved only by a decision or a daemon report, never by later task activity', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    await byok?.close();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  async function start(): Promise<{ byok: ByokServer; daemon: FakeLongPollDaemon }> {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, instance, { productId: PRODUCT_ID });
    return { byok: instance, daemon };
  }

  it('(a) task.progress and task.artifact while AwaitApproval are applied, but the approval stays pending', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ deviceId: daemon.deviceId, instruction: 'needs a human ok', ...TEST_AGENT_DISPATCH });
    await claimAndStart(daemon, handle);
    await moveToAwaitApproval(daemon, handle, 'appr-pending-a');

    await daemon.send(
      createEnvelope(
        'task.progress',
        { seq: 1, events: [{ type: 'progress', text: 'still working' }] },
        { taskId: handle.taskId },
      ),
    );
    await daemon.send(
      createEnvelope('task.artifact', { name: 'notes.txt', contentType: 'text/plain', inline: 'aGk=' }, { taskId: handle.taskId }),
    );

    const agentEvent = await waitForTaskEvent(handle, (e) => e.kind === 'agent');
    expect(agentEvent).toMatchObject({ kind: 'agent', event: { type: 'progress', text: 'still working' } });
    await waitForTaskEvent(handle, (e) => e.kind === 'artifact');

    // A resolution would clear the pending slot on the approval timeline.
    const snapshot = await instance.tasks.get(handle.taskId);
    expect(snapshot?.state).toBe('AwaitApproval');
    expect(snapshot?.pendingApprovalId).toBe('appr-pending-a');
  });

  it('(b) task.complete arriving directly while AwaitApproval completes normally — NOT force-failed', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ deviceId: daemon.deviceId, instruction: 'needs a human ok', ...TEST_AGENT_DISPATCH });
    await claimAndStart(daemon, handle);
    await moveToAwaitApproval(daemon, handle, 'appr-pending-b');

    await daemon.send(
      createEnvelope('task.complete', { agentRef: TEST_AGENT_REF, summary: 'done after local approval', sessionRef: 'sess-1' }, { taskId: handle.taskId }),
    );

    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Complete');

    const snapshot = await instance.tasks.get(handle.taskId);
    expect(snapshot?.state).toBe('Complete');
    expect(snapshot?.result?.state === 'Complete' ? snapshot.result.summary : undefined).toBe('done after local approval');
    expect(snapshot?.result?.state === 'Complete' ? snapshot.result.sessionRef : undefined).toBe('sess-1');
  });

  it('(c) after the daemon reports the local resolution, a second task.await_approval transitions cleanly back to AwaitApproval', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ deviceId: daemon.deviceId, instruction: 'needs two human oks', ...TEST_AGENT_DISPATCH });
    await claimAndStart(daemon, handle);
    await moveToAwaitApproval(daemon, handle, 'appr-pending-c1', 'first approval needed');

    await daemon.send(
      createEnvelope(
        'task.approval_resolved',
        { approvalId: 'appr-pending-c1', decision: 'approve', resolvedBy: 'local', at: new Date().toISOString() },
        { taskId: handle.taskId },
      ),
    );
    await waitForServerEvent(instance, (e) => e.kind === 'task.approval_resolved' && e.taskId === handle.taskId);
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');

    await daemon.send(
      createEnvelope('task.await_approval', { summary: 'second approval needed', approvalId: 'appr-pending-c2' }, { taskId: handle.taskId }),
    );
    await waitForTaskEvent(handle, (e) => e.kind === 'await_approval' && e.summary === 'second approval needed');

    const snapshot = await instance.tasks.get(handle.taskId);
    expect(snapshot?.state).toBe('AwaitApproval');
    expect(snapshot?.pendingApprovalId).toBe('appr-pending-c2');
  });

  it('(d) task.progress on an already-terminal task is still dropped, not force-failed and not resumed', async () => {
    const { byok: instance, daemon } = await start();

    const handle1 = await instance.dispatch({ deviceId: daemon.deviceId, instruction: 'task one', ...TEST_AGENT_DISPATCH });
    await claimAndStart(daemon, handle1);
    await handle1.cancel('server decided');
    expect((await instance.tasks.get(handle1.taskId))?.state).toBe('Cancelled');

    // `POST /byok/messages` applies its envelopes synchronously inside the
    // request, so this awaited send is itself the barrier — no marker task and
    // no sleep are needed to prove the stale message already ran.
    await daemon.send(createEnvelope('task.progress', { seq: 1, events: [] }, { taskId: handle1.taskId }));

    expect((await instance.tasks.get(handle1.taskId))?.state).toBe('Cancelled'); // unchanged, not resumed/re-failed
  });

  it('(e) a task.await_approval without approvalId is refused at the wire, so no unnamed approval can be pending', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ deviceId: daemon.deviceId, instruction: 'no approval id', ...TEST_AGENT_DISPATCH });
    await claimAndStart(daemon, handle);
    const response = await sendOne(daemon, {
      ...createEnvelope('task.await_approval', { summary: 'needs a human ok', approvalId: 'x' }, { taskId: handle.taskId }),
      payload: { summary: 'needs a human ok' },
    } as never);
    expect(response.body).not.toMatchObject({ accepted: 1 });
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');
  });
});
