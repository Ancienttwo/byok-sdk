import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { MAX_TRACKED_TASK_IDS, TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
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

async function makeRunner(adapter: StubRuntimeAdapter, sent: Envelope[]): Promise<TaskRunner> {
  const deps: TaskRunnerDeps = {
    adapters: [adapter],
    workspaceRoot: await tmpDir('byok-taskrunner-bounded-workspace-'),
    deviceId: 'device-1',
    send: (envelope) => {
      sent.push(envelope);
    },
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-taskrunner-bounded-store-')),
    approvalRegistry: new ApprovalRegistry(),
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
  };
  return new TaskRunner(deps);
}

/**
 * White-box view onto `TaskRunner`'s private M3-B bounded collections
 * (`finishedTaskIds`/`pendingCancelled`) and their bounded-insert helpers
 * (`addFinishedTaskId`/`setPendingCancelled`) — `private` is TypeScript-only
 * and erased at runtime, so this reaches straight past it instead of growing
 * `TaskRunner`'s real public surface just to make these internals testable.
 * Mirrors the same direct-field-access style `task-runner-cancel-race.test.ts`
 * uses for `activeTaskCount`, just for fields that don't have a public getter.
 */
interface TaskRunnerInternals {
  finishedTaskIds: Set<string>;
  pendingCancelled: Map<string, string | undefined>;
  addFinishedTaskId(taskId: string): void;
  setPendingCancelled(taskId: string, reason: string | undefined): void;
}

function internals(runner: TaskRunner): TaskRunnerInternals {
  return runner as unknown as TaskRunnerInternals;
}

/**
 * M3-B (bounded-set/map pruning): `finishedTaskIds` and `pendingCancelled`
 * used to gain one entry per finished/cancelled task forever — harmless for
 * a short CLI invocation, a slow memory leak for the long-lived background
 * daemon M3 turns this into. These tests exercise the bounded-insert helpers
 * directly (white-box) to prove growth is capped without needing to drive
 * thousands of full offer->start->turn_end->complete cycles through the
 * stub adapter, and separately prove — through the real `handleEnvelope`
 * path — that bounding never discards an entry either collection's own
 * correctness invariant (redelivery idempotency / the F4 cancel race) still
 * needs.
 */
describe('TaskRunner: bounded finishedTaskIds/pendingCancelled (M3-B)', () => {
  it('finishedTaskIds stays capped at MAX_TRACKED_TASK_IDS after far more finished tasks than the cap, keeping the most recent', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    const rn = internals(runner);

    const total = MAX_TRACKED_TASK_IDS * 3; // N >> cap
    for (let i = 0; i < total; i++) {
      rn.addFinishedTaskId(`finished-${i}`);
    }

    expect(rn.finishedTaskIds.size).toBe(MAX_TRACKED_TASK_IDS);
    // Oldest (first-inserted) entries are gone...
    expect(rn.finishedTaskIds.has('finished-0')).toBe(false);
    expect(rn.finishedTaskIds.has(`finished-${total - MAX_TRACKED_TASK_IDS - 1}`)).toBe(false);
    // ...exactly the most recent MAX_TRACKED_TASK_IDS survive.
    expect(rn.finishedTaskIds.has(`finished-${total - MAX_TRACKED_TASK_IDS}`)).toBe(true);
    expect(rn.finishedTaskIds.has(`finished-${total - 1}`)).toBe(true);
  });

  it('pendingCancelled stays capped at MAX_TRACKED_TASK_IDS after far more pending cancels than the cap, keeping the most recent', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    const rn = internals(runner);

    const total = MAX_TRACKED_TASK_IDS * 3; // N >> cap
    for (let i = 0; i < total; i++) {
      rn.setPendingCancelled(`cancelled-${i}`, `reason-${i}`);
    }

    expect(rn.pendingCancelled.size).toBe(MAX_TRACKED_TASK_IDS);
    expect(rn.pendingCancelled.has('cancelled-0')).toBe(false);
    expect(rn.pendingCancelled.has(`cancelled-${total - MAX_TRACKED_TASK_IDS - 1}`)).toBe(false);
    expect(rn.pendingCancelled.has(`cancelled-${total - MAX_TRACKED_TASK_IDS}`)).toBe(true);
    expect(rn.pendingCancelled.get(`cancelled-${total - 1}`)).toBe(`reason-${total - 1}`);
  });

  it('a just-finished task keeps redelivery idempotency even after the cap is already full of older finished tasks', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    const rn = internals(runner);

    // Fill to exactly the cap with older (synthetic) finished tasks first —
    // the collection is already "full" before the real task below finishes.
    for (let i = 0; i < MAX_TRACKED_TASK_IDS; i++) {
      rn.addFinishedTaskId(`old-${i}`);
    }
    expect(rn.finishedTaskIds.size).toBe(MAX_TRACKED_TASK_IDS);

    const taskId = 'task-recent';
    const offer = createEnvelope(
      'task.offer',
      { instruction: 'finish me', policy: { mode: 'auto' } },
      { taskId, seq: 1 },
    );
    await runner.handleEnvelope(offer);
    expect(adapter.sessions).toHaveLength(1);

    adapter.sessions[0]?.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'task.complete' && e.task_id === taskId)).toBe(true));

    // Finishing this real task pushed the collection one over cap, evicting
    // exactly the single oldest synthetic entry ('old-0') — the just-finished
    // taskId is guaranteed to be the newest insert, so it survives.
    expect(rn.finishedTaskIds.size).toBe(MAX_TRACKED_TASK_IDS);
    expect(rn.finishedTaskIds.has('old-0')).toBe(false);
    expect(rn.finishedTaskIds.has(taskId)).toBe(true);

    // A redelivered offer for this exact (recently-finished) taskId must
    // still be a no-op: never a second adapter.start() call, never a second
    // task.claim/task.complete.
    const redelivered = createEnvelope(
      'task.offer',
      { instruction: 'finish me', policy: { mode: 'auto' } },
      { taskId, seq: 2 },
    );
    await runner.handleEnvelope(redelivered);

    expect(adapter.startCalls).toHaveLength(1);
    expect(sent.filter((e) => e.type === 'task.claim' && e.task_id === taskId)).toHaveLength(1);
    expect(sent.filter((e) => e.type === 'task.complete' && e.task_id === taskId)).toHaveLength(1);
  });

  it('a cancel arriving during the in-flight offer-processing window still tears the session down even after pendingCancelled is already full of older entries (finding F4 under M3-B cap pressure)', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    const rn = internals(runner);

    // Fill to exactly the cap with older, never-consumed pending cancels —
    // exactly the "leak" shape M3-B closes (see pendingCancelled's own doc
    // comment: a cancel for a taskId nobody ever claims is never consumed).
    // The map is already "full" before the real race below.
    for (let i = 0; i < MAX_TRACKED_TASK_IDS; i++) {
      rn.setPendingCancelled(`old-cancel-${i}`, 'never consumed');
    }
    expect(rn.pendingCancelled.size).toBe(MAX_TRACKED_TASK_IDS);

    const releaseStart = adapter.blockStart();
    const taskId = 'task-race-window-bounded';
    const offerEnvelope = createEnvelope(
      'task.offer',
      { instruction: 'race the cancel under a full map', policy: { mode: 'auto' } },
      { taskId, seq: 1 },
    );
    const cancelEnvelope = createEnvelope(
      'task.cancel',
      { reason: 'cancel during start() under cap pressure' },
      { taskId, seq: 2 },
    );

    // Not awaited on purpose (mirrors task-runner-cancel-race.test.ts): the
    // offer's handler is left running (blocked inside adapter.start()) while
    // the cancel's handler starts concurrently.
    const offerPromise = runner.handleEnvelope(offerEnvelope);
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));
    expect(runner.activeTaskCount).toBe(0);

    // This insert pushes pendingCancelled one over cap, evicting the single
    // oldest synthetic entry ('old-cancel-0') — taskId itself, being the
    // newest entry, cannot be the one evicted by its own insertion.
    const cancelPromise = runner.handleEnvelope(cancelEnvelope);

    releaseStart(); // let adapter.start() finally resolve
    await Promise.all([offerPromise, cancelPromise]);

    expect(sent.some((e) => e.type === 'task.cancelled' && e.task_id === taskId)).toBe(true);
    expect(sent.some((e) => e.type === 'task.started' && e.task_id === taskId)).toBe(false);
    expect(adapter.sessions).toHaveLength(1);
    expect(adapter.sessions[0]?.interruptCalled).toBe(true);
    expect(adapter.sessions[0]?.closeCalled).toBe(true);
    expect(runner.activeTaskCount).toBe(0);

    // The entry this race needed was consumed (deleted) by handleOffer's
    // checkpoint 2, not evicted — it's gone because it was used, not because
    // the cap pushed it out from under the in-flight offer.
    expect(rn.pendingCancelled.has(taskId)).toBe(false);
    expect(rn.pendingCancelled.size).toBe(MAX_TRACKED_TASK_IDS - 1);
  });

  it('finding #5 (Codex counterexample): an in-flight pendingCancelled marker survives MAX_TRACKED_TASK_IDS unrelated cancels inserted AFTER it, so the cancel is still honored once the blocked offer resolves', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    const rn = internals(runner);

    // Block task A in adapter.start() — A's own handleOffer() is now
    // in-flight (this.tasks has no entry for it yet; the offer hasn't
    // resolved).
    const releaseStart = adapter.blockStart();
    const taskId = 'task-A-in-flight';
    const offerEnvelope = createEnvelope(
      'task.offer',
      { instruction: 'block me in adapter.start', policy: { mode: 'auto' } },
      { taskId, seq: 1 },
    );
    const offerPromise = runner.handleEnvelope(offerEnvelope);
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));
    expect(runner.activeTaskCount).toBe(0);

    // Deliver A's OWN cancel first, while A is still blocked in start() —
    // this is the entry that must survive.
    await runner.handleEnvelope(
      createEnvelope('task.cancel', { reason: 'cancel A while blocked' }, { taskId, seq: 2 }),
    );
    expect(rn.pendingCancelled.has(taskId)).toBe(true);

    // Now deliver MAX_TRACKED_TASK_IDS more cancels for completely unrelated
    // taskIds nobody ever offered (each is a no-op harmless entry per
    // `pendingCancelled`'s own doc comment) — exactly Codex's counterexample:
    // under naive "evict the single oldest entry" eviction, A's marker (the
    // very oldest, since it was inserted first) would be evicted purely
    // because of this unrelated churn, well before A's own offer ever
    // resolves.
    for (let i = 0; i < MAX_TRACKED_TASK_IDS; i++) {
      await runner.handleEnvelope(
        createEnvelope('task.cancel', { reason: 'unrelated churn' }, { taskId: `unrelated-${i}`, seq: 3 + i }),
      );
    }
    expect(rn.pendingCancelled.size).toBe(MAX_TRACKED_TASK_IDS); // capped...
    // ...but A's own marker specifically must have survived the churn.
    expect(rn.pendingCancelled.has(taskId)).toBe(true);

    releaseStart(); // let adapter.start() finally resolve
    await offerPromise;

    // The bug this test guards against: if A's marker had been evicted,
    // checkpoint 2 would find nothing, report task.started, and leave the
    // just-started session registered and running instead of tearing it
    // down. `adapter.start()` still resolves (it's a plain stub, not
    // cancellation-aware) and its session lands in `adapter.sessions` either
    // way — what proves the cancel was actually honored is that it was
    // immediately interrupted/closed and never registered as active,
    // exactly like `task-runner-cancel-race.test.ts`'s equivalent assertion.
    expect(sent.some((e) => e.type === 'task.started' && e.task_id === taskId)).toBe(false);
    expect(sent.some((e) => e.type === 'task.cancelled' && e.task_id === taskId)).toBe(true);
    expect(adapter.sessions).toHaveLength(1);
    expect(adapter.sessions[0]?.interruptCalled).toBe(true);
    expect(adapter.sessions[0]?.closeCalled).toBe(true);
    expect(runner.activeTaskCount).toBe(0);
    expect(rn.pendingCancelled.has(taskId)).toBe(false); // consumed by checkpoint 2, not evicted
  });
});
