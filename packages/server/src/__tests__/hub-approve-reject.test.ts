import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { isCloudError } from '@byok-sdk/cloud';
import { createByokServer, StaleApprovalError, type ByokServer, type TaskHandle } from '../index';
import {
  connectFakeDaemonLongPoll,
  startServer,
  stopServer,
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

/** Types of everything the device has been handed since its last poll. */
async function drainTypes(daemon: FakeLongPollDaemon): Promise<string[]> {
  return (await daemon.next()).map((envelope: Envelope) => envelope.type);
}

/**
 * `TaskHandle.approve`/`reject` — the ONLY approval control surface an
 * embedder has (there is deliberately no bearer-authed HTTP route for it).
 * Both are thin calls onto the cloud kernel's `approveTask`/`rejectTask`, whose
 * gate reads the task's durable approval timeline; the host decision is then
 * recorded back on that same timeline, so the read model and the gate answer
 * from one authority.
 *
 * Every test below drives the published surface only — `createByokServer` ->
 * `dispatch()` -> `TaskHandle`, plus the long-poll transport for the daemon
 * half. The pre-fold file drove `ConnectionHub` directly for the M5/S4 blocks;
 * that class is gone, and the behaviours it exercised are re-expressed here.
 */
describe('TaskHandle.approve/reject (published API + typed errors)', () => {
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

  it('approve() on a task currently AwaitApproval moves it to Running and notifies the daemon over the wire', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(daemon, handle);
    await moveToAwaitApproval(daemon, handle, 'appr-1');

    await handle.approve();
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');
    expect(await drainTypes(daemon)).toEqual(['task.offer', 'task.approve']);
  });

  // 2d gap: the old `ConnectionHub.rejectTask` was authoritative over the TASK,
  // moving the record straight to `Failed` and writing the caller's reason as
  // the terminal result. The kernel's `rejectTask` resolves the APPROVAL and
  // enqueues a `task.reject` for the runtime; the attempt itself stays
  // `running` until the daemon reports its own terminal (`task.fail`), which is
  // what `hub-approval-resolved.test.ts`'s "local reject" case already
  // describes as the daemon's job. Orchestrator decision: accept the kernel's
  // split (host resolves the approval, runtime owns the terminal) and document
  // the break in Step 5, or have the façade force a terminal on reject.
  it.skip('reject (with a reason) on a task currently AwaitApproval moves it to Failed with that reason', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ instruction: 'needs a human ok' });
    await claimAndStart(daemon, handle);
    await moveToAwaitApproval(daemon, handle, 'appr-1');

    await handle.reject('looked risky');
    const snapshot = await instance.tasks.get(handle.taskId);
    expect(snapshot?.state).toBe('Failed');
    expect(snapshot?.result?.state === 'Failed' ? snapshot.result.reason : undefined).toBe('looked risky');
  });

  // 2d gap: three cases the pre-fold file expressed by constructing a
  // `ConnectionHub` and calling `approveTask('no-such-task')`/
  // `rejectTask('no-such-task')` directly — "unknown taskId throws
  // UnknownTaskError (404-equivalent)", its `rejectTask` twin, and
  // "UnknownTaskError carries taskId". There is no public way to name an
  // arbitrary taskId on this surface: a `TaskHandle` only ever comes from
  // `dispatch()`, so the task it names always exists. The kernel's own gate
  // does fail closed (`ByokCloudError('task_not_found')`,
  // `packages/cloud/src/cloud.ts`) and `packages/cloud`'s suite owns that pin.
  // Orchestrator decision: leave it to the cloud suite, or add a
  // taskId-addressed approval surface to `ByokServer`.
  it.skip('approve/reject on an unknown taskId fails closed with a typed error carrying the taskId', async () => {
    expect.fail('no public surface names an arbitrary taskId — see the 2d gap note above');
  });

  it('approve() on a task NOT currently AwaitApproval (e.g. still Running) fails closed with task_not_awaiting_approval, leaving state unchanged', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ instruction: 'still running' });
    await claimAndStart(daemon, handle);

    const refused = await handle.approve().catch((error: unknown) => error);
    expect(isCloudError(refused, 'task_not_awaiting_approval')).toBe(true);
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running'); // unchanged
  });

  it('reject() on a task not currently AwaitApproval fails closed with task_not_awaiting_approval', async () => {
    const { byok: instance, daemon } = await start();

    const handle = await instance.dispatch({ instruction: 'still running' });
    await claimAndStart(daemon, handle);

    const refused = await handle.reject('too late').catch((error: unknown) => error);
    expect(isCloudError(refused, 'task_not_awaiting_approval')).toBe(true);
    expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running'); // unchanged
  });

  /**
   * M5 (approval targeting, docs/protocol.md §5.3): `approve`/`reject` take an
   * optional `opts.approvalId` naming a SPECIFIC pending approval rather than
   * "whichever one is currently pending".
   */
  describe('M5 (approval targeting): approve/reject opts.approvalId', () => {
    it('approve({approvalId}) after that EXACT approval is already consumed (task now Running) fails closed with task_not_awaiting_approval — the pending-approval check runs before the approvalId check', async () => {
      const { byok: instance, daemon } = await start();

      const handle = await instance.dispatch({ instruction: 'needs a human ok' });
      await claimAndStart(daemon, handle);
      await moveToAwaitApproval(daemon, handle, 'appr-1');
      expect((await instance.tasks.get(handle.taskId))?.state).toBe('AwaitApproval');

      await handle.approve({ approvalId: 'appr-1' }); // targeted — consumes it, AwaitApproval -> Running.
      expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');

      const refused = await handle.approve({ approvalId: 'appr-1' }).catch((error: unknown) => error);
      expect(isCloudError(refused, 'task_not_awaiting_approval')).toBe(true);
    });

    it('approve({approvalId: A}) while a DIFFERENT approval (B) is now the recorded pending one throws StaleApprovalError, changes no state, and sends no wire message', async () => {
      const { byok: instance, daemon } = await start();

      const handle = await instance.dispatch({ instruction: 'needs a human ok' });
      await claimAndStart(daemon, handle);
      await moveToAwaitApproval(daemon, handle, 'appr-A', 'first (A)');
      // B supersedes A while the task is STILL AwaitApproval (a re-delivered /
      // updated id). The awaited send is the barrier: `POST /byok/messages`
      // applies its envelopes synchronously inside the request.
      await daemon.send(
        createEnvelope('task.await_approval', { summary: 'second (B)', approvalId: 'appr-B' }, { taskId: handle.taskId }),
      );
      expect((await instance.tasks.get(handle.taskId))?.pendingApprovalId).toBe('appr-B');

      const stale = await handle.approve({ approvalId: 'appr-A' }).catch((error: unknown) => error);
      expect(stale).toBeInstanceOf(StaleApprovalError);

      expect((await instance.tasks.get(handle.taskId))?.state).toBe('AwaitApproval'); // unchanged
      expect((await instance.tasks.get(handle.taskId))?.pendingApprovalId).toBe('appr-B'); // unchanged
      expect(await drainTypes(daemon)).toEqual(['task.offer']); // no task.approve was enqueued
    });

    it('reject(reason, {approvalId: A}) while a DIFFERENT approval (B) is now the recorded pending one throws StaleApprovalError, changes no state, and sends no wire message', async () => {
      const { byok: instance, daemon } = await start();

      const handle = await instance.dispatch({ instruction: 'needs a human ok' });
      await claimAndStart(daemon, handle);
      await moveToAwaitApproval(daemon, handle, 'appr-A', 'first (A)');
      await daemon.send(
        createEnvelope('task.await_approval', { summary: 'second (B)', approvalId: 'appr-B' }, { taskId: handle.taskId }),
      );
      expect((await instance.tasks.get(handle.taskId))?.pendingApprovalId).toBe('appr-B');

      const stale = await handle.reject('stale reject', { approvalId: 'appr-A' }).catch((error: unknown) => error);
      expect(stale).toBeInstanceOf(StaleApprovalError);

      expect((await instance.tasks.get(handle.taskId))?.state).toBe('AwaitApproval'); // unchanged
      expect((await instance.tasks.get(handle.taskId))?.pendingApprovalId).toBe('appr-B'); // unchanged
      expect(await drainTypes(daemon)).toEqual(['task.offer']); // no task.reject was enqueued
    });

    it('StaleApprovalError carries taskId/requestedApprovalId/currentApprovalId fields for programmatic handling', async () => {
      const { byok: instance, daemon } = await start();

      const handle = await instance.dispatch({ instruction: 'x' });
      await claimAndStart(daemon, handle);
      await moveToAwaitApproval(daemon, handle, 'appr-current');

      const stale = await handle.approve({ approvalId: 'appr-requested' }).catch((error: unknown) => error);
      expect(stale).toBeInstanceOf(StaleApprovalError);
      if (!(stale instanceof StaleApprovalError)) throw new Error('unreachable');
      expect(stale.taskId).toBe(handle.taskId);
      expect(stale.requestedApprovalId).toBe('appr-requested');
      expect(stale.currentApprovalId).toBe('appr-current');
    });

    /**
     * A full second cycle for the SAME task: leave `AwaitApproval` via a real
     * `approve`, come back to it with a fresh approval, and prove the OLD
     * cycle's id is genuinely dead rather than merely superseded in place.
     */
    it('composed second cycle: AwaitApproval(A) -> approve -> Running -> await_approval(B) -> AwaitApproval — pendingApprovalId is B; A is now stale (StaleApprovalError), B still works', async () => {
      const { byok: instance, daemon } = await start();

      const handle = await instance.dispatch({ instruction: 'needs two humans' });
      await claimAndStart(daemon, handle);

      // First cycle: AwaitApproval(A) -> approve -> Running.
      await moveToAwaitApproval(daemon, handle, 'appr-A', 'first (A)');
      expect((await instance.tasks.get(handle.taskId))?.pendingApprovalId).toBe('appr-A');

      await handle.approve({ approvalId: 'appr-A' });
      expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');
      // Sanity check before the second cycle even starts: resolving the
      // approval already clears the derived slot.
      expect((await instance.tasks.get(handle.taskId))?.pendingApprovalId).toBeUndefined();

      // Second cycle: a FRESH task.await_approval (B) re-enters AwaitApproval.
      await daemon.send(
        createEnvelope('task.await_approval', { summary: 'second (B)', approvalId: 'appr-B' }, { taskId: handle.taskId }),
      );
      expect((await instance.tasks.get(handle.taskId))?.state).toBe('AwaitApproval');
      // The exact bug this test guards against: without the first cycle's
      // resolution clearing the slot, this could still read a stale leftover
      // ('appr-A') instead of the new cycle's real id.
      expect((await instance.tasks.get(handle.taskId))?.pendingApprovalId).toBe('appr-B');

      // A's id belonged to a PREVIOUS, already fully-consumed AwaitApproval
      // cycle for this SAME task — it must be rejected as stale now, not
      // silently accepted just because it's a familiar id.
      const stale = await handle.approve({ approvalId: 'appr-A' }).catch((error: unknown) => error);
      expect(stale).toBeInstanceOf(StaleApprovalError);
      expect((await instance.tasks.get(handle.taskId))?.state).toBe('AwaitApproval'); // unchanged
      expect((await instance.tasks.get(handle.taskId))?.pendingApprovalId).toBe('appr-B'); // unchanged

      // B — the CURRENT cycle's real id — still works normally.
      await handle.approve({ approvalId: 'appr-B' });
      expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');
      // Exactly one `task.approve` per successful approval reached the device
      // (the stale attempt contributed none).
      expect(await drainTypes(daemon)).toEqual(['task.offer', 'task.approve', 'task.approve']);
    });

    it('compat: approve with NO opts still resolves whichever approval is currently pending — untargeted behavior is unchanged from pre-M5', async () => {
      const { byok: instance, daemon } = await start();

      const handle = await instance.dispatch({ instruction: 'x' });
      await claimAndStart(daemon, handle);
      await moveToAwaitApproval(daemon, handle, 'appr-untargeted');
      expect((await instance.tasks.get(handle.taskId))?.pendingApprovalId).toBe('appr-untargeted');

      await handle.approve(); // no opts at all — pre-M5 call shape.
      expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');
      // Resolving clears the derived slot regardless of whether this decision
      // was targeted.
      expect((await instance.tasks.get(handle.taskId))?.pendingApprovalId).toBeUndefined();
    });

    // The durable timeline preserves this as an explicit id-less resolution;
    // it never invents a native approval identity for the pre-M5 peer.
    it('compat: a legacy task.await_approval with NO approvalId stores nothing, and an untargeted approve still works normally', async () => {
      const { byok: instance, daemon } = await start();

      const handle = await instance.dispatch({ instruction: 'x' });
      await claimAndStart(daemon, handle);
      // A pre-M5 daemon's task.await_approval carries no approvalId at all.
      await daemon.send(createEnvelope('task.await_approval', { summary: 'legacy' }, { taskId: handle.taskId }));

      expect((await instance.tasks.get(handle.taskId))?.state).toBe('AwaitApproval');
      expect((await instance.tasks.get(handle.taskId))?.pendingApprovalId).toBeUndefined();

      await handle.approve(); // untargeted — nothing to compare against, proceeds exactly as before M5.
      expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');
    });
  });

  /**
   * S1 (cross-model review finding, P1): `TaskHandle.approve()`/`reject()` are
   * the only surface an embedder holding just the published API has, so the M5
   * targeting has to be reachable through them, and `StaleApprovalError` has to
   * be importable from the package's own entry point.
   */
  describe('S1: TaskHandle.approve/reject opts.approvalId (published API)', () => {
    it('approve({approvalId}) targets the CURRENT pending approval, read back off the publicly-exposed TaskSnapshot.pendingApprovalId, end to end through dispatch()', async () => {
      const { byok: instance, daemon } = await start();

      const handle = await instance.dispatch({ instruction: 'needs a human ok' });
      await claimAndStart(daemon, handle);
      await moveToAwaitApproval(daemon, handle, 'appr-A', 'first (A)');

      // Confirmatory (S1's second half): pendingApprovalId is already readable
      // through the existing public snapshot surface — an embedder builds its
      // targeted approve call off exactly this, no new surface needed.
      const pendingApprovalId = (await instance.tasks.get(handle.taskId))?.pendingApprovalId;
      expect(pendingApprovalId).toBe('appr-A');

      await handle.approve({ approvalId: pendingApprovalId });
      expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');
    });

    // 2d gap: same divergence as the outer `reject` case above — the kernel's
    // `rejectTask` resolves the approval and hands the runtime a `task.reject`;
    // it does not write a `Failed` terminal on the host's behalf.
    it.skip('reject(reason, {approvalId}) targets the CURRENT pending approval end to end through dispatch()', async () => {
      const { byok: instance, daemon } = await start();

      const handle = await instance.dispatch({ instruction: 'needs a human ok' });
      await claimAndStart(daemon, handle);
      await moveToAwaitApproval(daemon, handle, 'appr-A', 'first (A)');

      await handle.reject('looked risky', { approvalId: 'appr-A' });
      const snapshot = await instance.tasks.get(handle.taskId);
      expect(snapshot?.state).toBe('Failed');
      expect(snapshot?.result?.state === 'Failed' ? snapshot.result.reason : undefined).toBe('looked risky');
    });

    it("approve({approvalId}) against a STALE (superseded) approval throws StaleApprovalError — importable/catchable from the package's public entry point — leaving state unchanged; the CURRENT approval still works through the same handle", async () => {
      const { byok: instance, daemon } = await start();

      const handle = await instance.dispatch({ instruction: 'needs a human ok' });
      await claimAndStart(daemon, handle);
      await moveToAwaitApproval(daemon, handle, 'appr-A', 'first (A)');

      // B supersedes A while still AwaitApproval.
      await daemon.send(
        createEnvelope('task.await_approval', { summary: 'second (B)', approvalId: 'appr-B' }, { taskId: handle.taskId }),
      );
      expect((await instance.tasks.get(handle.taskId))?.pendingApprovalId).toBe('appr-B');

      const stale = await handle.approve({ approvalId: 'appr-A' }).catch((error: unknown) => error);
      expect(stale).toBeInstanceOf(StaleApprovalError);
      expect((await instance.tasks.get(handle.taskId))?.state).toBe('AwaitApproval'); // unchanged

      // B — the CURRENT approval — still works through the SAME published
      // TaskHandle.
      await handle.approve({ approvalId: 'appr-B' });
      expect((await instance.tasks.get(handle.taskId))?.state).toBe('Running');
    });
  });
});

// Deleted with `task-store.ts` (WP3B Step 2b): the S4 describe
// ("TaskStore.setPendingApprovalId is optional — a legacy store without it
// must not crash") drove a hand-written `LegacyTaskStore` through
// `ConnectionHub`. `TaskStore` is no longer a public interface and there is no
// embedder-supplied task store to be backward-compatible with (ADR-028): the
// kernel owns the one `TaskAttemptStore`, and `pendingApprovalId` is derived
// from the durable approval timeline rather than written into a record. See
// the notes' 2b conformance skim, class (A).
