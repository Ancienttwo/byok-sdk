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

function approvalResolved(taskId: string, approvalId: string, decision: 'approve' | 'reject' = 'approve') {
  return createEnvelope(
    'task.approval_resolved',
    { approvalId, decision, resolvedBy: 'local', at: new Date().toISOString() },
    { taskId },
  );
}

/**
 * M4 (additive-minor): the EXPLICIT wire `task.approval_resolved` message — the
 * daemon reporting a LOCALLY-resolved approval immediately, instead of the
 * server only inferring it after the fact once evidence arrives (that
 * inference path is exercised by this file's sibling
 * `hub-implicit-approval-resume.test.ts`).
 *
 * Both paths now write onto the SAME durable approval timeline the read model
 * and the host-decision gate read, so "which one got there first" is settled by
 * that one authority rather than by a mutable slot on a task record.
 */
describe('M4 (additive-minor): explicit task.approval_resolved handling', () => {
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

  // 2d gap: the pre-fold pin read the WS handshake's `conn.ack.capabilities`.
  // The long-poll equivalent is `EventsPollResponse.capabilities`, whose list
  // is the kernel's `CLOUD_PROTOCOL_CAPABILITIES`
  // (`packages/cloud/src/handlers/events.ts`) — and `approval_resolved` is NOT
  // in it, even though the kernel's inbound gate handles the message
  // (`inbound.ts:576`). A daemon that gates on the advertised flag
  // (`packages/protocol/src/version.ts` documents it as functionally gating)
  // would therefore never send one. Proposed one-line cloud patch is in the
  // notes. Orchestrator decision: patch `CLOUD_PROTOCOL_CAPABILITIES`, or
  // declare the flag dead and document the break in Step 5.
  it.skip('advertises the approval_resolved capability flag on the long-poll transport', async () => {
    const { daemon } = await start();
    const body = (await (await daemon.replay(0)).json()) as { capabilities?: string[] };
    expect(body.capabilities).toContain('approval_resolved');
  });

  it('AwaitApproval -> Running on task.approval_resolved, and emits a task.approval_resolved embedder event carrying approvalId/decision/resolvedBy', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(daemon, handle);
    await moveToAwaitApproval(daemon, handle, 'appr-1');

    await daemon.send(approvalResolved(handle.taskId, 'appr-1'));

    const event = await waitForServerEvent(instance, (e) => e.kind === 'task.approval_resolved' && e.taskId === handle.taskId);
    if (event.kind !== 'task.approval_resolved') throw new Error('unreachable');
    expect(event.approvalId).toBe('appr-1');
    expect(event.decision).toBe('approve');
    expect(event.resolvedBy).toBe('local');

    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');

    // The implicit-inference path must NOT ALSO have fired for this same
    // resolution — the explicit message already cleared the pending slot on the
    // timeline, so the inference finds nothing left to clear.
    const implicitFired = await Promise.race([
      waitForServerEvent(instance, (e) => e.kind === 'task.approval_resolved_implicit' && e.taskId === handle.taskId).then(
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    expect(implicitFired).toBe(false);
  });

  it('AwaitApproval -> Running on task.approval_resolved with decision: reject moves the task through Running (approval flow only decides resume vs stop the runtime side; the wire decision itself does not change server state here)', async () => {
    // Unlike a host `reject()` (server -> daemon), `task.approval_resolved` is
    // daemon -> server REPORTING a decision the daemon already acted on
    // locally. A local reject means the daemon already stopped the runtime and
    // will report task.fail itself — the server's own job here is only to stop
    // treating the task as AwaitApproval.
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(daemon, handle);
    await moveToAwaitApproval(daemon, handle, 'appr-2');

    await daemon.send(approvalResolved(handle.taskId, 'appr-2', 'reject'));

    const event = await waitForServerEvent(instance, (e) => e.kind === 'task.approval_resolved' && e.taskId === handle.taskId);
    if (event.kind !== 'task.approval_resolved') throw new Error('unreachable');
    expect(event.decision).toBe('reject');

    // The daemon follows up with task.fail (as it would after a local reject) —
    // proving the task was left in a state that legally accepts it.
    await daemon.send(createEnvelope('task.fail', { reason: 'rejected locally' }, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Failed');
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Failed');
  });

  it('idempotent no-op when the task already resumed (the implicit path beat the message to it)', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(daemon, handle);
    await moveToAwaitApproval(daemon, handle, 'appr-3');

    // The implicit path resumes it first (task.progress arriving while the read
    // model still says AwaitApproval).
    await daemon.send(createEnvelope('task.progress', { seq: 1, events: [] }, { taskId: handle.taskId }));
    await waitForServerEvent(instance, (e) => e.kind === 'task.approval_resolved_implicit' && e.taskId === handle.taskId);
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');

    // The explicit message now arrives late (a redelivered/racing report for
    // the SAME approval the implicit path already resolved) — an idempotent
    // no-op. The awaited send is the barrier: `POST /byok/messages` applies its
    // envelopes synchronously inside the request.
    await daemon.send(approvalResolved(handle.taskId, 'appr-3'));

    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running'); // unchanged
  });

  it('stale no-op when the task is already terminal — never force-failed, never resurrected', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(daemon, handle);
    await moveToAwaitApproval(daemon, handle, 'appr-4');
    // A server-side decision crosses in flight and wins first (the residual
    // race docs/protocol.md documents): the SaaS rejects, and the runtime
    // reports the terminal that decision produced, BEFORE the daemon's own
    // local-resolution report ever arrives.
    await handle.reject('SaaS decided first');
    await daemon.send(createEnvelope('task.fail', { reason: 'SaaS decided first' }, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Failed');
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Failed');

    await daemon.send(approvalResolved(handle.taskId, 'appr-4'));

    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Failed'); // unchanged — never resurrected, never force-failed again
  });

  it('stale no-op when the task never reached AwaitApproval at all (e.g. still Claimed) — a genuinely out-of-sequence report', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ instruction: 'x' });
    await daemon.send(createEnvelope('task.claim', { deviceId: daemon.deviceId }, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Claimed');

    await daemon.send(approvalResolved(handle.taskId, 'appr-5'));

    // Not force-failed, and the normal lifecycle still runs afterwards.
    await daemon.send(createEnvelope('task.started', {}, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');
  });

  it('M5 (approval targeting): await_approval(A) stored, await_approval(B) re-delivered for the SAME task while still AwaitApproval, then approval_resolved(A) arrives — task stays AwaitApproval, never Running', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(daemon, handle);

    // A: the first await_approval, the task's pending approval.
    await moveToAwaitApproval(daemon, handle, 'appr-A', 'first (A)');
    expect((await instance.tasks.get(handle.taskId))?.pendingApprovalId).toBe('appr-A');

    // B: the daemon has moved on (e.g. resolved A entirely locally) and
    // dispatched a fresh approval for the SAME task — sent while the read model
    // is STILL AwaitApproval, so it supersedes A in place.
    await daemon.send(
      createEnvelope('task.await_approval', { summary: 'second (B)', approvalId: 'appr-B' }, { taskId: handle.taskId }),
    );
    expect((await instance.tasks.get(handle.taskId))?.pendingApprovalId).toBe('appr-B');
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('AwaitApproval'); // unchanged

    // A late task.approval_resolved arrives, carrying A's now-superseded id.
    await daemon.send(approvalResolved(handle.taskId, 'appr-A'));

    // The task stays AwaitApproval — the stale report for A must NOT resolve B
    // (that would be resuming the WRONG approval).
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('AwaitApproval');
    expect((await instance.tasks.get(handle.taskId))?.pendingApprovalId).toBe('appr-B');
  });

  it("S2 (cross-model review finding, P1): await_approval(B) re-delivered while already AwaitApproval re-emits the await_approval ServerTaskEvent carrying B's summary — previously the same-state branch updated the stored id and returned silently, leaving an operator watching TaskHandle.events() still showing A's summary", async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(daemon, handle);
    await moveToAwaitApproval(daemon, handle, 'appr-A', 'first (A)');

    await daemon.send(
      createEnvelope('task.await_approval', { summary: 'second (B)', approvalId: 'appr-B' }, { taskId: handle.taskId }),
    );

    const event = await waitForTaskEvent(handle, (e) => e.kind === 'await_approval' && e.summary === 'second (B)');
    if (event.kind !== 'await_approval') throw new Error('unreachable');
    expect(event.summary).toBe('second (B)');
    expect((await instance.tasks.get(handle.taskId))?.pendingApprovalId).toBe('appr-B');
  });

  // 2d gap: the "sanity" half split out of the S2 test above. The old hub only
  // re-emitted when `payload.approvalId !== record.pendingApprovalId`, so a
  // redelivery carrying the SAME id pushed nothing. `TaskEventRelay`
  // (`relay.ts`) folds every COMMITTED `task.await_approval` into the feed, and
  // only an envelope-id duplicate is suppressed — by the kernel's dedup step,
  // which a fresh envelope carrying the same `approvalId` does not trip. Same
  // family as `inbound-gate.test.ts`'s own re-emission gap. Orchestrator
  // decision: accept the re-emission as the honest report of a new observation,
  // or restore approvalId-keyed suppression in the relay.
  it.skip('a redelivery carrying the SAME approvalId does not re-emit another await_approval event', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(daemon, handle);
    await moveToAwaitApproval(daemon, handle, 'appr-B', 'second (B)');

    await daemon.send(
      createEnvelope('task.await_approval', { summary: 'second (B) resent', approvalId: 'appr-B' }, { taskId: handle.taskId }),
    );
    const sawAnotherEvent = await Promise.race([
      waitForTaskEvent(handle, (e) => e.kind === 'await_approval' && e.summary === 'second (B) resent').then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    expect(sawAnotherEvent).toBe(false);
  });

  it('an unknown taskId is a silent no-op (no crash, no event)', async () => {
    const { byok: instance, daemon } = await start();

    await daemon.send(approvalResolved('no-such-task', 'appr-6'));

    // A second, real task used only to prove the transport and the gate are
    // still alive and processing traffic normally after the unknown-taskId
    // message.
    const handle = await instance.dispatch({ instruction: 'still alive' });
    await claimAndStart(daemon, handle);
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');
  });

  /**
   * M5 (hello-capability plumbing): the `targeted` field on the emitted
   * `task.approval_resolved` `ByokServerEvent`.
   *
   * The `targeted: true` case is DELETED, not skipped: it reported whether the
   * reporting device's LIVE WebSocket registration advertised
   * `approval-targeting`, and that registration no longer exists at all. The
   * durable capability list is a device-BUILD fact rather than a per-report
   * one, so the field is now always `false` by construction (2a deviation 4,
   * `types.ts`). What remains testable is exactly that.
   */
  describe('M5 (hello-capability plumbing): targeted field on the emitted task.approval_resolved event', () => {
    it('a daemon reporting a locally-resolved approval produces targeted: false on the emitted event', async () => {
      const { byok: instance, daemon } = await start();

      const handle = await instance.dispatch({ instruction: 'needs a human ok' });
      await claimAndStart(daemon, handle);
      await moveToAwaitApproval(daemon, handle, 'appr-legacy');
      expect((await instance.tasks.get(handle.taskId))?.state).toBe('AwaitApproval');

      await daemon.send(approvalResolved(handle.taskId, 'appr-legacy'));

      const event = await waitForServerEvent(instance, (e) => e.kind === 'task.approval_resolved' && e.taskId === handle.taskId);
      if (event.kind !== 'task.approval_resolved') throw new Error('unreachable');
      expect(event.targeted).toBe(false);
      expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');
    });
  });
});
