import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createByokServer, type ByokServer, type TaskHandle } from '../index';
import {
  connectFakeDaemonLongPoll,
  startServer,
  stopServer,
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

/**
 * Running -> AwaitApproval over the long-poll send path.
 *
 * `approvalId` is optional: the timeline's request source/revision, rather
 * than a synthesized approval id, pins the exact pending request an activity
 * may resolve.
 */
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
 * M4 Phase 3 hardening: a task the daemon resolved entirely LOCALLY (M4 Phase
 * 3's `approvals.resolve` control-socket path, `packages/client`) never sends a
 * wire `task.approve`/`task.reject`, so the server's own read model still shows
 * `AwaitApproval` when the daemon's next `task.progress`/`task.artifact`/
 * `task.complete` arrives. That traffic must implicitly resume the task
 * (recording the resolution on the same durable approval timeline every other
 * resolution is recorded on) and process the message normally, exactly as if a
 * real wire `task.approve` had arrived first.
 */
describe('M4 Phase 3: implicit approval resume (daemon traffic while the read model still says AwaitApproval)', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    byok?.stop();
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

  it('(a) task.progress arriving while AwaitApproval implicitly resumes to Running, applies the progress, and emits task.approval_resolved_implicit — NOT force-failed', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(daemon, handle);
    await moveToAwaitApproval(daemon, handle, 'appr-implicit-a');

    await daemon.send(
      createEnvelope(
        'task.progress',
        { seq: 1, events: [{ type: 'progress', text: 'still working' }] },
        { taskId: handle.taskId },
      ),
    );

    const implicitEvent = await waitForServerEvent(
      instance,
      (e) => e.kind === 'task.approval_resolved_implicit' && e.taskId === handle.taskId,
    );
    expect(implicitEvent).toBeDefined();

    const agentEvent = await waitForTaskEvent(handle, (e) => e.kind === 'agent');
    expect(agentEvent).toMatchObject({ kind: 'agent', event: { type: 'progress', text: 'still working' } });

    // The whole point: this must be Running, never Failed.
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');
  });

  it('(b) task.complete arriving directly while AwaitApproval completes normally — NOT force-failed', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(daemon, handle);
    await moveToAwaitApproval(daemon, handle, 'appr-implicit-b');

    await daemon.send(
      createEnvelope('task.complete', { summary: 'done after local approval', sessionRef: 'sess-1' }, { taskId: handle.taskId }),
    );

    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Complete');

    const snapshot = await instance.tasks.get(handle.taskId);
    expect(snapshot?.state).toBe('Complete');
    expect(snapshot?.result?.state === 'Complete' ? snapshot.result.summary : undefined).toBe('done after local approval');
    expect(snapshot?.result?.state === 'Complete' ? snapshot.result.sessionRef : undefined).toBe('sess-1');
  });

  it('(c) a second task.await_approval after an implicit resume transitions cleanly back to AwaitApproval', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ instruction: 'needs two human oks' });
    await claimAndStart(daemon, handle);
    await moveToAwaitApproval(daemon, handle, 'appr-implicit-c1', 'first approval needed');

    // Implicit resume, as (a) proves in isolation — synchronize on the
    // implicit-resolve SERVER event (unique to this one resume), not a bare
    // "state === Running" task-event predicate: this task already passed
    // through Running once (claimAndStart's own Claimed -> Running), and
    // waitForTaskEvent always replays from the start of the task's whole
    // history, so re-waiting on the same predicate would just re-match that
    // EARLIER event instead of waiting for this one.
    await daemon.send(
      createEnvelope(
        'task.progress',
        { seq: 1, events: [{ type: 'progress', text: 'continued after local approval' }] },
        { taskId: handle.taskId },
      ),
    );
    await waitForServerEvent(instance, (e) => e.kind === 'task.approval_resolved_implicit' && e.taskId === handle.taskId);
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');

    // A genuinely NEW await_approval for the same task, after the implicit
    // resume, must still work cleanly.
    await daemon.send(
      createEnvelope('task.await_approval', { summary: 'second approval needed', approvalId: 'appr-implicit-c2' }, { taskId: handle.taskId }),
    );
    await waitForTaskEvent(handle, (e) => e.kind === 'await_approval' && e.summary === 'second approval needed');

    expect((await instance.tasks.get(handle.taskId))?.state).toBe('AwaitApproval');
  });

  it('(d) existing behavior preserved: task.progress on an already-terminal task is still dropped, not force-failed and not implicitly resumed', async () => {
    const { byok: instance, daemon } = await start();

    const handle1 = await instance.dispatch({ instruction: 'task one' });
    await claimAndStart(daemon, handle1);
    await handle1.cancel('server decided');
    expect((await instance.tasks.get(handle1.taskId))?.state).toBe('Cancelled');

    // `POST /byok/messages` applies its envelopes synchronously inside the
    // request, so this awaited send is itself the barrier — no marker task and
    // no sleep are needed to prove the stale message already ran.
    await daemon.send(createEnvelope('task.progress', { seq: 1, events: [] }, { taskId: handle1.taskId }));

    expect((await instance.tasks.get(handle1.taskId))?.state).toBe('Cancelled'); // unchanged, not resumed/re-failed
  });

  it('(a-legacy) task.progress arriving while AwaitApproval with NO reported approvalId still implicitly resumes to Running', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ instruction: 'legacy daemon, no approvalId' });
    await claimAndStart(daemon, handle);
    await daemon.send(createEnvelope('task.await_approval', { summary: 'needs a human ok' }, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'AwaitApproval');

    await daemon.send(
      createEnvelope('task.progress', { seq: 1, events: [{ type: 'progress', text: 'still working' }] }, { taskId: handle.taskId }),
    );

    await waitForServerEvent(instance, (e) => e.kind === 'task.approval_resolved_implicit' && e.taskId === handle.taskId);
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');
  });
});
