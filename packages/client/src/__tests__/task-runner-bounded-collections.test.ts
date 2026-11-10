import { FRESH_OFFER, freshOfferRunnerDeps } from './fixtures/fresh-offer';
import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
import { testScratchOwner } from "./fixtures/execution-scratch";
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import type { BlobResolver } from '../daemon/blob-client';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { createOfferFacts, MAX_TRACKED_TASK_IDS } from '../daemon/task-runner/state';
import { hostFor } from '../daemon/task-runner/host';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => {
    throw new Error('not used in this test');
  },
  uploadArtifact: async () => {
    throw new Error('not used in this test');
  },
};

async function makeRunner(adapter: StubRuntimeAdapter, sent: Envelope[]): Promise<TaskRunner> {
  const deps: TaskRunnerDeps = { getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(), ...freshOfferRunnerDeps(),
    adapters: [adapter],
    ...testAgentHomeDeps(),
    deviceId: 'device-1',
    send: (envelope) => {
      sent.push(envelope);
    },
    blobClient: unusedBlobClient,
    approvalRegistry: new ApprovalRegistry(),
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
  };
  return new TaskRunner(deps);
}

/**
 * M3-B (bounded-list/map pruning): reducer `finished` and `pendingCancelled`
 * used to gain one entry per finished/cancelled task forever — harmless for
 * a short CLI invocation, a slow memory leak for the long-lived background
 * daemon M3 turns this into. These tests exercise reducer dispatch to prove
 * growth is capped without needing to drive
 * thousands of full offer->start->turn_end->complete cycles through the
 * stub adapter, and separately prove — through the real `handleEnvelope`
 * path — that bounding never discards an entry either collection's own
 * correctness invariant (redelivery idempotency / the F4 cancel race) still
 * needs.
 */
describe('TaskRunner: bounded finished/pendingCancelled (M3-B)', () => {
  it('finished stays capped at MAX_TRACKED_TASK_IDS after far more finished tasks than the cap, keeping the most recent', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    const host = hostFor(runner);

    const total = MAX_TRACKED_TASK_IDS * 3; // N >> cap
    for (let i = 0; i < total; i++) {
      const taskId = `finished-${i}`;
      host.dispatchSync({ type: 'offer.received', taskId, atMs: 0, offer: createOfferFacts() });
      host.dispatchSync({ type: 'finish.completed', taskId, atMs: 0 });
    }

    const finished = host.runnerSnapshot().finished;
    expect(finished).toHaveLength(MAX_TRACKED_TASK_IDS);
    expect(finished).not.toContain('finished-0');
    expect(finished).not.toContain(`finished-${total - MAX_TRACKED_TASK_IDS - 1}`);
    expect(finished).toEqual(Array.from({ length: MAX_TRACKED_TASK_IDS },
      (_, i) => `finished-${total - MAX_TRACKED_TASK_IDS + i}`));
  });

  it('pendingCancelled stays capped at MAX_TRACKED_TASK_IDS after far more pending cancels than the cap, keeping the most recent', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    const host = hostFor(runner);

    const total = MAX_TRACKED_TASK_IDS * 3; // N >> cap
    for (let i = 0; i < total; i++) {
      host.dispatchSync({ type: 'cancel.received', taskId: `cancelled-${i}`, atMs: i, source: 'wire', reason: `reason-${i}` });
    }

    const pending = host.runnerSnapshot().pendingCancelled;
    expect(pending).toHaveLength(MAX_TRACKED_TASK_IDS);
    expect(pending.some(entry => entry.taskId === 'cancelled-0')).toBe(false);
    expect(pending.some(entry => entry.taskId === `cancelled-${total - MAX_TRACKED_TASK_IDS - 1}`)).toBe(false);
    expect(pending.some(entry => entry.taskId === `cancelled-${total - MAX_TRACKED_TASK_IDS}`)).toBe(true);
    expect(pending.at(-1)?.reason).toBe(`reason-${total - 1}`);
  });

  it('a just-finished task keeps redelivery idempotency even after the cap is already full of older finished tasks', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    const host = hostFor(runner);

    // Fill to exactly the cap with older (synthetic) finished tasks first —
    // the collection is already "full" before the real task below finishes.
    for (let i = 0; i < MAX_TRACKED_TASK_IDS; i++) {
      const taskId = `old-${i}`;
      host.dispatchSync({ type: 'offer.received', taskId, atMs: 0, offer: createOfferFacts() });
      host.dispatchSync({ type: 'finish.completed', taskId, atMs: 0 });
    }
    expect(host.runnerSnapshot().finished).toHaveLength(MAX_TRACKED_TASK_IDS);

    const taskId = 'task-recent';
    const offer = createEnvelope(
      'task.offer',
      { agentRef: freshTestAgentRef(),  instruction: 'finish me', ...FRESH_OFFER },
      { taskId, seq: 1 },
    );
    await runner.handleEnvelope(offer);
    expect(adapter.sessions).toHaveLength(1);

    adapter.sessions[0]?.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'task.complete' && e.task_id === taskId)).toBe(true));

    // Finishing this real task pushed the collection one over cap, evicting
    // exactly the single oldest synthetic entry ('old-0') — the just-finished
    // taskId is guaranteed to be the newest insert, so it survives.
    expect(host.runnerSnapshot().finished).toHaveLength(MAX_TRACKED_TASK_IDS);
    expect(host.runnerSnapshot().finished).not.toContain('old-0');
    expect(host.runnerSnapshot().finished).toContain(taskId);

    // A redelivered offer for this exact (recently-finished) taskId must
    // still be a no-op: never a second adapter.start() call, never a second
    // task.claim/task.complete.
    const redelivered = createEnvelope(
      'task.offer',
      { agentRef: freshTestAgentRef(),  instruction: 'finish me', ...FRESH_OFFER },
      { taskId, seq: 2 },
    );
    const sentBeforeRedelivery = sent.length;
    await runner.handleEnvelope(redelivered);

    expect(sent).toHaveLength(sentBeforeRedelivery);
    expect(adapter.startCalls).toHaveLength(1);
    expect(sent.filter((e) => e.type === 'task.claim' && e.task_id === taskId)).toHaveLength(1);
    expect(sent.filter((e) => e.type === 'task.complete' && e.task_id === taskId)).toHaveLength(1);
  });

  it.each(['C7 start failure', 'C8 handoff write failure'])(
    '%s keeps redelivery idempotent after startup ownership is released',
    async (failure) => {
      const adapter = new StubRuntimeAdapter();
      const sent: Envelope[] = [];
      const runner = await makeRunner(adapter, sent);
      if (failure === 'C7 start failure') {
        adapter.startError = new Error('spawn failed');
      } else {
        vi.spyOn(AgentSessionHandoffStore.prototype, 'record')
          .mockRejectedValueOnce(new Error('handoff write failed'));
      }
      try {
        const taskId = 'task-pre-active-failure';
        const payload = { agentRef: freshTestAgentRef(), instruction: 'fail before active', ...FRESH_OFFER };
        await runner.handleEnvelope(createEnvelope('task.offer', payload, { taskId, seq: 1 }));
        expect(sent.filter((e) => e.type === 'task.fail' && e.task_id === taskId)).toHaveLength(1);
        expect(sent.filter((e) => e.task_id === taskId).map((e) => e.type))
          .toEqual(['task.claim', 'task.fail']);
        await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));

        const sentBeforeRedelivery = sent.length;
        await runner.handleEnvelope(createEnvelope('task.offer', payload, { taskId, seq: 2 }));
        expect(sent.filter((e) => e.type === 'task.claim' && e.task_id === taskId)).toHaveLength(1);
        expect(sent).toHaveLength(sentBeforeRedelivery);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it('a cancel arriving during the in-flight offer-processing window still tears the session down even after pendingCancelled is already full of older entries (finding F4 under M3-B cap pressure)', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    const host = hostFor(runner);

    // Fill to exactly the cap with older, never-consumed pending cancels —
    // exactly the "leak" shape M3-B closes (see pendingCancelled's own doc
    // comment: a cancel for a taskId nobody ever claims is never consumed).
    // The map is already "full" before the real race below.
    for (let i = 0; i < MAX_TRACKED_TASK_IDS; i++) {
      host.dispatchSync({ type: 'cancel.received', taskId: `old-cancel-${i}`, atMs: i, source: 'wire', reason: 'never consumed' });
    }
    expect(host.runnerSnapshot().pendingCancelled).toHaveLength(MAX_TRACKED_TASK_IDS);

    const releaseStart = adapter.blockStart();
    const taskId = 'task-race-window-bounded';
    const offerEnvelope = createEnvelope(
      'task.offer',
      { agentRef: freshTestAgentRef(),  instruction: 'race the cancel under a full map', ...FRESH_OFFER },
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

    // The active offer's cancel lives on its task, independently of the full list.
    const cancelPromise = runner.handleEnvelope(cancelEnvelope);

    releaseStart(); // let adapter.start() finally resolve
    await Promise.all([offerPromise, cancelPromise]);

    expect(sent.some((e) => e.type === 'task.cancelled' && e.task_id === taskId)).toBe(true);
    expect(sent.some((e) => e.type === 'task.started' && e.task_id === taskId)).toBe(false);
    expect(adapter.sessions).toHaveLength(1);
    await vi.waitFor(() => expect(adapter.sessions[0]?.closeCalled).toBe(true), { timeout: 3_000 });
    expect(adapter.sessions[0]?.interruptCalled).toBe(true);
    expect(adapter.sessions[0]?.closeCalled).toBe(true);
    expect(runner.activeTaskCount).toBe(0);

    // The task's cancellation did not consume an unrelated pending entry.
    expect(host.runnerSnapshot().pendingCancelled.some(entry => entry.taskId === taskId)).toBe(false);
    expect(host.runnerSnapshot().pendingCancelled).toHaveLength(MAX_TRACKED_TASK_IDS);
  });

  it('finding #5 (Codex counterexample): an in-flight pendingCancelled marker survives MAX_TRACKED_TASK_IDS unrelated cancels inserted AFTER it, so the cancel is still honored once the blocked offer resolves', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    const host = hostFor(runner);

    // Block task A in adapter.start() — A's own handleOffer() is now
    // in-flight (this.tasks has no entry for it yet; the offer hasn't
    // resolved).
    const releaseStart = adapter.blockStart();
    const taskId = 'task-A-in-flight';
    const offerEnvelope = createEnvelope(
      'task.offer',
      { agentRef: freshTestAgentRef(),  instruction: 'block me in adapter.start', ...FRESH_OFFER },
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
    expect(host.current(taskId)?.cancel.requested).toBe(true);

    // Unrelated cancels fill the bounded runner list; A's cancellation is
    // stored on its own task and cannot be evicted by that churn.
    for (let i = 0; i < MAX_TRACKED_TASK_IDS; i++) {
      await runner.handleEnvelope(
        createEnvelope('task.cancel', { reason: 'unrelated churn' }, { taskId: `unrelated-${i}`, seq: 3 + i }),
      );
    }
    expect(host.runnerSnapshot().pendingCancelled).toHaveLength(MAX_TRACKED_TASK_IDS); // capped...
    // Cancellation may already be sealed while the late runtime remains owned.
    expect(sent.some(e => e.type === 'task.cancelled' && e.task_id === taskId) || host.current(taskId)?.cancel.requested === true).toBe(true);

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
    await vi.waitFor(() => expect(adapter.sessions[0]?.closeCalled).toBe(true), { timeout: 3_000 });
    expect(adapter.sessions[0]?.interruptCalled).toBe(true);
    expect(adapter.sessions[0]?.closeCalled).toBe(true);
    // Process close precedes the SDK scratch cleanup receipt. Keep ownership
    // visible until both complete; cancellation still never publishes started.
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0), { timeout: 3_000 });
    expect(host.runnerSnapshot().pendingCancelled.some(entry => entry.taskId === taskId)).toBe(false);

    const sentBeforeRedelivery = sent.length;
    await runner.handleEnvelope(createEnvelope('task.offer', offerEnvelope.payload, {
      taskId, seq: MAX_TRACKED_TASK_IDS + 3,
    }));
    expect(sent).toHaveLength(sentBeforeRedelivery);
    expect(adapter.startCalls).toHaveLength(1);
    expect(sent.filter(e => e.type === 'task.claim' && e.task_id === taskId)).toHaveLength(1);
    expect(sent.filter(e => e.type === 'task.cancelled' && e.task_id === taskId)).toHaveLength(1);
  });
});
