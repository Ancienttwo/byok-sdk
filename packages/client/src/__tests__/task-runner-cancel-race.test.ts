import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => {
    throw new Error('not used in this test');
  },
  uploadArtifact: async () => {
    throw new Error('not used in this test');
  },
};

async function makeRunner(
  adapter: StubRuntimeAdapter,
  sent: Envelope[],
  overrides: Partial<Pick<TaskRunnerDeps, 'onRuntimeDisposalFailure'>> = {},
): Promise<TaskRunner> {
  const deps: TaskRunnerDeps = {
    ...overrides,
    adapters: [adapter],
    workspaceRoot: await tmpDir('byok-taskrunner-workspace-'),
    deviceId: 'device-1',
    send: (envelope) => {
      sent.push(envelope);
    },
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-taskrunner-store-')),
    approvalRegistry: new ApprovalRegistry(),
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
  };
  return new TaskRunner(deps);
}

/**
 * Finding F4 (cancel lost during the offer-processing window, a.k.a. the
 * ledger's "cancel/start 竞窗"): a `task.cancel` for a taskId whose
 * `task.offer` handler is still in flight (claimed, but not yet registered
 * as an `ActiveTask` — e.g. still awaiting `adapter.start()`) used to have
 * nowhere to land: `handleCancel`'s `this.tasks.get(taskId)` found nothing
 * and silently no-op'd, and the runtime session `handleOffer` was about to
 * register would then run unsupervised.
 *
 * These tests drive `TaskRunner.handleEnvelope` directly (not through a full
 * daemon + `ConnectionManager`) and deliberately do NOT await the offer's
 * handler before starting the cancel's — this reproduces the exact
 * concurrency shape the pre-M1-fix code allowed (`onEnvelope` was
 * fire-and-forget, so multiple envelope handlers really could run
 * concurrently). This is a deliberate choice, not an oversight: the
 * companion F3 fix now serializes envelope processing through one
 * per-connection FIFO in `ConnectionManager`, which as a side effect also
 * means these two envelopes can no longer physically interleave when
 * delivered through a real connection (the FIFO forces `handleOffer` to
 * fully settle before `handleCancel` is even invoked). `TaskRunner`'s own
 * `pendingCancelled` guard is still the correct fix to have — it is what
 * makes `TaskRunner` itself safe to call concurrently, independent of
 * whatever serialization guarantee happens to sit above it — and this is
 * the only way to exercise it directly.
 */
describe('TaskRunner: cancel arriving during the offer-processing window (finding F4)', () => {
  it('reserves cancellation before interrupt can end the event stream, so pump cannot publish a competing failure', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    const taskId = 'task-cancel-terminal-race';
    await runner.handleEnvelope(createEnvelope(
      'task.offer',
      { instruction: 'cancel me' },
      { taskId, seq: 1 },
    ));
    const session = adapter.sessions[0]!;
    session.interrupt = async () => {
      session.interruptCalled = true;
      session.endAbruptly();
      await Promise.resolve();
    };

    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'operator' }, { taskId, seq: 2 }));
    await Promise.resolve();

    expect(sent.filter((event) => ['task.complete', 'task.fail', 'task.cancelled'].includes(event.type)).map((event) => event.type)).toEqual(['task.cancelled']);
    expect(runner.activeTaskCount).toBe(0);
  });

  it('a cancel processed concurrently with a still-in-flight offer for the same taskId tears the session down instead of running a zombie turn', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);

    const releaseStart = adapter.blockStart();
    const taskId = 'task-race-window';
    const offerEnvelope = createEnvelope(
      'task.offer',
      { instruction: 'race the cancel' },
      { taskId, seq: 1 },
    );
    const cancelEnvelope = createEnvelope('task.cancel', { reason: 'cancel during start()' }, { taskId, seq: 2 });

    // Not awaited on purpose (see class doc): the offer's handler is left
    // running (blocked inside adapter.start()) while the cancel's handler
    // starts concurrently, exactly as fire-and-forget dispatch used to allow.
    const offerPromise = runner.handleEnvelope(offerEnvelope);
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));

    // Claimed (this device committed to the task) but nothing registered
    // yet — exactly the window the cancel used to vanish into.
    expect(runner.activeTaskCount).toBe(0);
    const cancelPromise = runner.handleEnvelope(cancelEnvelope);

    releaseStart(); // let adapter.start() finally resolve
    await Promise.all([offerPromise, cancelPromise]);

    expect(sent.some((e) => e.type === 'task.cancelled' && e.task_id === taskId)).toBe(true);
    // The session was torn down before ever being reported as running — no
    // zombie turn, no misleading Claimed->Running->Cancelled flicker either.
    expect(sent.some((e) => e.type === 'task.started' && e.task_id === taskId)).toBe(false);
    expect(sent.some((e) => e.type === 'task.claim' && e.task_id === taskId)).toBe(true);

    expect(adapter.sessions).toHaveLength(1);
    await vi.waitFor(() => expect(adapter.sessions[0]?.closeCalled).toBe(true), { timeout: 3_000 });
    expect(adapter.sessions[0]?.interruptCalled).toBe(true);
    expect(runner.activeTaskCount).toBe(0);
  });

  it('a cancel during a start that ignores the abort lets shutdown wait for the late session and close it', async () => {
    // The real Codex and Pi start() do not read the abort signal: they settle
    // only when their session opens. A shutdown that comes before that must
    // wait for the start to settle, then close the late session. It must not
    // report a disposal failure for a start that is still settling.
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const disposalFailures: unknown[] = [];
    const runner = await makeRunner(adapter, sent, { onRuntimeDisposalFailure: (event) => disposalFailures.push(event) });
    const releaseStart = adapter.blockStart();
    const taskId = 'task-cancel-pending-start';

    const offerPromise = runner.handleEnvelope(createEnvelope('task.offer', { instruction: 'slow start' }, { taskId, seq: 1 }));
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));
    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'cancel while starting' }, { taskId, seq: 2 }));
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'task.cancelled' && e.task_id === taskId)).toBe(true));

    runner.stopAcceptingOffers();
    let shutdownError: unknown;
    let shutdownSettled = false;
    const shutdown = runner.shutdownActiveTasks('daemon stop').then(
      () => { shutdownSettled = true; },
      (error: unknown) => { shutdownSettled = true; shutdownError = error; },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(shutdownSettled).toBe(false);

    releaseStart();
    await Promise.all([offerPromise, shutdown]);

    expect(shutdownError).toBeUndefined();
    expect(disposalFailures).toEqual([]);
    expect(adapter.sessions).toHaveLength(1);
    expect(adapter.sessions[0]?.closeCalled).toBe(true);
    expect(runner.activeTaskCount).toBe(0);
    expect(sent.filter((e) => e.task_id === taskId && ['task.started', 'task.fail', 'task.complete', 'task.cancelled'].includes(e.type))
      .map((e) => e.type)).toEqual(['task.cancelled']);
  });

  it('a cancel arriving before the matching offer is even looked at declines it instead of ever claiming (checkpoint 1)', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);

    const taskId = 'task-precancelled';
    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'cancelled early' }, { taskId, seq: 1 }));
    expect(runner.activeTaskCount).toBe(0);

    await runner.handleEnvelope(
      createEnvelope(
        'task.offer',
        { instruction: 'too late' },
        { taskId, seq: 2 },
      ),
    );

    expect(sent.some((e) => e.type === 'task.decline' && e.task_id === taskId)).toBe(true);
    expect(sent.some((e) => e.type === 'task.claim' && e.task_id === taskId)).toBe(false);
    expect(adapter.startCalls).toHaveLength(0);
    expect(runner.activeTaskCount).toBe(0);
  });
});
