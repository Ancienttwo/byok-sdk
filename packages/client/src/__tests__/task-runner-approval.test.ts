import type { RuntimeTaskInput } from '../types';
import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
import { testScratchOwner } from "./fixtures/execution-scratch";
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  MAX_PENDING_APPROVALS_PER_TASK,
  TaskRunner,
  type TaskRunnerDeps,
} from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';
import { FRESH_OFFER, freshOfferEgressDeps } from './fixtures/fresh-offer';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';

/**
 * M4 Phase 3: `TaskRunner.requestApproval` in isolation — the daemon-side
 * half of the out-of-band approval channel (`types.ts`'s `ApprovalChannel`,
 * `control-protocol.ts`'s `approvals.request`). Mirrors
 * `task-runner-cancel-race.test.ts`'s own convention for driving `TaskRunner`
 * directly via `handleEnvelope`, without a full daemon/control socket.
 * `confirm-mode-approval-e2e.test.ts` covers the same feature through the
 * real control socket end to end, including the wire task.approve/task.reject
 * vs. local `approvals.resolve` dual-entry convergence.
 */

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
  overrides: Partial<Pick<TaskRunnerDeps, 'approvalTimeoutMs' | 'approvalRegistry' | 'onApprovalDispatched' | 'awaitTerminalCommit'>> = {},
  home = testAgentHomeDeps(),
): Promise<{ runner: TaskRunner; approvalRegistry: ApprovalRegistry }> {
  const approvalRegistry = overrides.approvalRegistry ?? new ApprovalRegistry();
  const deps: TaskRunnerDeps = { advertisedCapabilities: advertiseEveryDeviceFlag, ...freshOfferEgressDeps(), getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [adapter],
    ...home,
    deviceId: 'device-1',
    send: (envelope) => {
      sent.push(envelope);
    },
    blobClient: unusedBlobClient,
    approvalRegistry,
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    approvalTimeoutMs: overrides.approvalTimeoutMs,
    onApprovalDispatched: overrides.onApprovalDispatched,
    awaitTerminalCommit: overrides.awaitTerminalCommit,
  };
  return { runner: new TaskRunner(deps), approvalRegistry };
}

async function offerAndActivate(runner: TaskRunner, taskId: string): Promise<void> {
  await runner.handleEnvelope(
    createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER,  instruction: 'do work' }, { taskId, seq: 1 }),
  );
}

describe('TaskRunner.requestApproval', () => {
  it('an unknown/inactive taskId fails closed immediately — no registry entry, no task.await_approval sent', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent);

    const outcome = await runner.requestApproval('no-such-task', 'Bash: rm -rf /');
    expect(outcome).toEqual({ approved: false, reason: 'task is not currently active on this device' });
    expect(approvalRegistry.list()).toEqual([]);
    expect(sent.some((e) => e.type === 'task.await_approval')).toBe(false);
  });

  it('sends task.await_approval with the summary and resolves approved:true once the registry entry is approved', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent);
    const taskId = 'task-approve-1';
    await offerAndActivate(runner, taskId);

    const outcomePromise = runner.requestApproval(taskId, 'Bash: echo hi');

    const awaitApprovalEnvelope = sent.find((e) => e.type === 'task.await_approval');
    expect(awaitApprovalEnvelope).toBeDefined();
    if (awaitApprovalEnvelope?.type !== 'task.await_approval' || awaitApprovalEnvelope.payload.sealed !== undefined) throw new Error('unreachable');
    expect(awaitApprovalEnvelope.payload.summary).toBe('Bash: echo hi');
    expect(awaitApprovalEnvelope.task_id).toBe(taskId);

    const pending = approvalRegistry.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.taskId).toBe(taskId);
    expect(pending[0]?.summary).toBe('Bash: echo hi');

    approvalRegistry.resolve(pending[0]!.approvalId, 'approve');
    await expect(outcomePromise).resolves.toEqual({ approved: true, reason: undefined });
    // Resolved entry is consumed — nothing left pending.
    expect(approvalRegistry.list()).toEqual([]);
  });

  it('finding F4: calls onApprovalDispatched with {taskId, approvalId} BEFORE sending task.await_approval, with the exact approvalId the registry ends up holding', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const dispatched: Array<{ taskId: string; approvalId: string }> = [];
    // Asserted from INSIDE the hook (not just after `requestApproval`
    // returns): proves ordering, not just eventual presence — the hook must
    // fire before `task.await_approval` is pushed onto `sent`, since
    // `DaemonObserver.noteApprovalDispatched` (create-daemon.ts's wiring)
    // must have already stashed the id by the time the observer's own
    // `task.await_approval` handling (triggered by that same synchronous
    // `deps.send`) runs.
    let sentCountAtDispatchTime = -1;
    const { runner, approvalRegistry } = await makeRunner(adapter, sent, {
      onApprovalDispatched: (taskId, approvalId) => {
        dispatched.push({ taskId, approvalId });
        sentCountAtDispatchTime = sent.filter((e) => e.type === 'task.await_approval').length;
      },
    });
    const taskId = 'task-approval-dispatched-1';
    await offerAndActivate(runner, taskId);

    void runner.requestApproval(taskId, 'Bash: echo hi');

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.taskId).toBe(taskId);
    expect(sentCountAtDispatchTime).toBe(0); // fired BEFORE task.await_approval was sent

    const pending = approvalRegistry.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.approvalId).toBe(dispatched[0]?.approvalId); // exact same id the registry actually holds
  });

  it('resolves approved:false with the reason once the registry entry is rejected', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent);
    const taskId = 'task-reject-1';
    await offerAndActivate(runner, taskId);

    const outcomePromise = runner.requestApproval(taskId, 'Write: /etc/passwd');
    const pending = approvalRegistry.list();
    approvalRegistry.resolve(pending[0]!.approvalId, 'reject', 'absolutely not');

    await expect(outcomePromise).resolves.toEqual({ approved: false, reason: 'absolutely not' });
  });

  it('force-resolves as a fail-closed rejection once approvalTimeoutMs elapses with no decision', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent, { approvalTimeoutMs: 20 });
    const taskId = 'task-timeout-1';
    await offerAndActivate(runner, taskId);

    const outcome = await runner.requestApproval(taskId, 'Bash: sleep forever');
    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toMatch(/timed out/);
    expect(approvalRegistry.list()).toEqual([]); // the timeout consumed the entry
  });

  it('defaults to DEFAULT_APPROVAL_TIMEOUT_MS (10 minutes) when approvalTimeoutMs is not overridden', async () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBe(10 * 60_000);
  });

  it('a decision that arrives just before the timeout wins cleanly — the timer never force-resolves an already-settled entry', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent, { approvalTimeoutMs: 50 });
    const taskId = 'task-race-1';
    await offerAndActivate(runner, taskId);

    const outcomePromise = runner.requestApproval(taskId, 'Bash: echo hi');
    const pending = approvalRegistry.list();
    approvalRegistry.resolve(pending[0]!.approvalId, 'approve');

    await expect(outcomePromise).resolves.toEqual({ approved: true, reason: undefined });
    // Wait past the (short) timeout window to prove it never fires a second,
    // stray resolution and no error is thrown anywhere in the process.
    await new Promise((resolve) => setTimeout(resolve, 80));
  });

  it('two concurrent approval requests for two different active tasks resolve independently', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent);
    await offerAndActivate(runner, 'task-a');
    await offerAndActivate(runner, 'task-b');

    const outcomeA = runner.requestApproval('task-a', 'Bash: A');
    const outcomeB = runner.requestApproval('task-b', 'Bash: B');

    const pending = approvalRegistry.list();
    expect(pending).toHaveLength(2);
    const forA = pending.find((p) => p.taskId === 'task-a')!;
    const forB = pending.find((p) => p.taskId === 'task-b')!;

    approvalRegistry.resolve(forB.approvalId, 'reject', 'no B');
    approvalRegistry.resolve(forA.approvalId, 'approve');

    await expect(outcomeA).resolves.toEqual({ approved: true, reason: undefined });
    await expect(outcomeB).resolves.toEqual({ approved: false, reason: 'no B' });
  });

  /**
   * M4 Phase 4 (fold-in from the P3 gate): claude's parallel tool use can
   * call `requestApproval` more than once for the SAME task before the
   * first call resolves. Pre-fix, the second call's `pendingApprovalId`
   * silently overwrote the first's, so only the latest was ever
   * wire-resolvable and the first died by timeout. These two tests exercise
   * the serialized-queue fix directly against `TaskRunner`, mirroring every
   * other test in this file's convention of driving `requestApproval` and
   * inspecting `approvalRegistry`/`sent` rather than going through a real
   * control socket.
   */
  describe('concurrent requestApproval calls for the SAME task (M4 Phase 4 fold-in)', () => {
    it('serializes: only the first is dispatched immediately; the second queues with its own approvalId and its own task.await_approval, dispatched once the first resolves', async () => {
      const adapter = new StubRuntimeAdapter();
      const sent: Envelope[] = [];
      const { runner, approvalRegistry } = await makeRunner(adapter, sent);
      const taskId = 'task-parallel-1';
      await offerAndActivate(runner, taskId);

      const outcome1 = runner.requestApproval(taskId, 'Bash: first');
      const outcome2 = runner.requestApproval(taskId, 'Bash: second');

      // Only the first is actually dispatched right now — registered, and
      // its own task.await_approval sent. The second is queued: no second
      // registry entry, no second frame, yet.
      let pending = approvalRegistry.list();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.summary).toBe('Bash: first');
      expect(sent.filter((e) => e.type === 'task.await_approval')).toHaveLength(1);

      const firstApprovalId = pending[0]!.approvalId;
      approvalRegistry.resolve(firstApprovalId, 'approve');
      await expect(outcome1).resolves.toEqual({ approved: true, reason: undefined });

      // The second is now dispatched: its own registry entry (distinct
      // approvalId) and its own task.await_approval frame — the embedder
      // sees both frames across the two dispatches, one at a time.
      pending = approvalRegistry.list();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.summary).toBe('Bash: second');
      const secondApprovalId = pending[0]!.approvalId;
      expect(secondApprovalId).not.toBe(firstApprovalId);
      expect(sent.filter((e) => e.type === 'task.await_approval')).toHaveLength(2);

      approvalRegistry.resolve(secondApprovalId, 'reject', 'no second');
      await expect(outcome2).resolves.toEqual({ approved: false, reason: 'no second' });
    });

    it('bounds the per-task queue: overflow beyond MAX_PENDING_APPROVALS_PER_TASK is rejected fail-closed immediately, without registering or sending anything', async () => {
      const adapter = new StubRuntimeAdapter();
      const sent: Envelope[] = [];
      const { runner, approvalRegistry } = await makeRunner(adapter, sent);
      const taskId = 'task-overflow-1';
      await offerAndActivate(runner, taskId);

      // First dispatches immediately; the next MAX_PENDING_APPROVALS_PER_TASK
      // all queue, filling the queue exactly to its cap.
      const first = runner.requestApproval(taskId, 'first');
      const queued = Array.from({ length: MAX_PENDING_APPROVALS_PER_TASK }, (_, i) =>
        runner.requestApproval(taskId, `queued-${i}`),
      );

      // One more must be rejected fail-closed immediately — not queued.
      const overflow = await runner.requestApproval(taskId, 'overflow');
      expect(overflow.approved).toBe(false);
      expect(overflow.reason).toMatch(/too many approval requests already queued/);

      // Only the first was ever actually registered/sent at this point.
      expect(approvalRegistry.list()).toHaveLength(1);
      expect(sent.filter((e) => e.type === 'task.await_approval')).toHaveLength(1);

      // Drain the first + every queued request so nothing is left dangling —
      // one dispatched at a time, so this is `first` PLUS all
      // MAX_PENDING_APPROVALS_PER_TASK queued ones (17 total resolutions).
      for (let i = 0; i < MAX_PENDING_APPROVALS_PER_TASK + 1; i++) {
        const pending = approvalRegistry.list();
        expect(pending).toHaveLength(1);
        approvalRegistry.resolve(pending[0]!.approvalId, 'approve');
      }
      await first;
      await Promise.all(queued);
    });

    /**
     * Gatekeeper LOW advisory: a task can finish (complete/fail/cancel)
     * while one approval is DISPATCHED and more are QUEUED behind it.
     * `TaskRunner.finish` must reject every queued one immediately,
     * fail-closed — never dispatch them (no `task.await_approval`, no
     * fresh timeout window for a task that no longer exists) — and must
     * also resolve the DISPATCHED one so no registry entry or timer
     * lingers for a finished task.
     */
    it("finish() (gatekeeper LOW advisory): a task finishing with a dispatched approval AND queued ones behind it rejects everything immediately — no await_approval for the queued ones, registry ends up empty", async () => {
      const adapter = new StubRuntimeAdapter();
      const sent: Envelope[] = [];
      const { runner, approvalRegistry } = await makeRunner(adapter, sent);
      const taskId = 'task-finish-queue-1';
      await offerAndActivate(runner, taskId);

      const dispatched = runner.requestApproval(taskId, 'dispatched');
      const queued1 = runner.requestApproval(taskId, 'queued-1');
      const queued2 = runner.requestApproval(taskId, 'queued-2');

      // Sanity: only the first is actually dispatched right now.
      expect(approvalRegistry.list()).toHaveLength(1);
      expect(sent.filter((e) => e.type === 'task.await_approval')).toHaveLength(1);

      // Finish the task via a normal turn_end (session emits it, pump()
      // sends task.complete and calls finish()).
      adapter.sessions[0]!.emit({ type: 'turn_end' });

      const [dispatchedOutcome, queued1Outcome, queued2Outcome] = await Promise.all([dispatched, queued1, queued2]);

      expect(dispatchedOutcome.approved).toBe(false);
      expect(queued1Outcome.approved).toBe(false);
      expect(queued2Outcome.approved).toBe(false);
      expect(queued1Outcome.reason).toMatch(/finished before this queued approval request could be dispatched/);
      expect(queued2Outcome.reason).toMatch(/finished before this queued approval request could be dispatched/);

      // No NEW task.await_approval frames were ever sent for the queued
      // ones (still exactly the one from the original dispatch).
      expect(sent.filter((e) => e.type === 'task.await_approval')).toHaveLength(1);

      // The registry itself is left empty — the dispatched one was
      // resolved too, not just the queue.
      expect(approvalRegistry.list()).toEqual([]);
    });
  });

  it('hands the approval channel only to an adapter that declares approvalInteractive', async () => {
    const interactive = new StubRuntimeAdapter();
    const { runner: interactiveRunner } = await makeRunner(interactive, []);
    await offerAndActivate(interactiveRunner, 'task-channel-interactive');
    expect(interactive.startCalls[0]?.ctx.approvalChannel).toEqual({ request: expect.any(Function) });

    const silent = new StubRuntimeAdapter(undefined, undefined, { steer: true, resume: true, approvalInteractive: false, mcpToolsets: true });
    const { runner: silentRunner } = await makeRunner(silent, []);
    await offerAndActivate(silentRunner, 'task-channel-silent');
    expect(silent.startCalls).toHaveLength(1);
    expect(silent.startCalls[0]?.ctx).not.toHaveProperty('approvalChannel');
  });

  it('an approval requested while start() is in flight waits for activation, then is presented and decided', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent);
    const taskId = 'task-early-approval';
    const release = adapter.blockStart();
    const offering = offerAndActivate(runner, taskId);
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));

    let settled = false;
    const early = adapter.startCalls[0]!.ctx.approvalChannel!.request('Bash: early').then((outcome) => { settled = true; return outcome; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(sent.some((e) => e.type === 'task.await_approval')).toBe(false);

    release();
    await offering;
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'task.await_approval' && e.task_id === taskId)).toBe(true));
    approvalRegistry.resolve(approvalRegistry.list()[0]!.approvalId, 'approve');
    await expect(early).resolves.toEqual({ approved: true, reason: undefined });
  });

  it('an approval requested while start() is in flight is refused when the task never becomes active', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent);
    const taskId = 'task-early-approval-cancelled';
    const release = adapter.blockStart();
    const offering = offerAndActivate(runner, taskId);
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));

    const early = adapter.startCalls[0]!.ctx.approvalChannel!.request('Bash: early');
    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'stop' }, { taskId, seq: 2 }));
    release();
    await offering;
    await expect(early).resolves.toMatchObject({ approved: false });
    expect(approvalRegistry.list()).toEqual([]);
  });

  it.each([false, true])('refuses startup approval after cancellation when terminal commit fails = %s', async (failCommit) => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const home = testAgentHomeDeps();
    let entered!: () => void;
    let release!: () => void;
    const handoffEntered = new Promise<void>((resolve) => { entered = resolve; });
    const releaseHandoff = new Promise<void>((resolve) => { release = resolve; });
    const originalRecord = home.agentSessionHandoffs.record.bind(home.agentSessionHandoffs);
    const handoff = vi.spyOn(home.agentSessionHandoffs, 'record').mockImplementation(async (input) => {
      entered();
      await releaseHandoff;
      return originalRecord(input);
    });
    let rejectCommit = failCommit;
    const { runner, approvalRegistry } = await makeRunner(adapter, sent, {
      awaitTerminalCommit: async () => {
        if (rejectCommit) throw new Error('terminal commit unavailable');
      },
    }, home);
    const taskId = 'cancelled-startup-approval';
    const offering = offerAndActivate(runner, taskId);
    let early: Promise<{ approved: boolean; reason?: string }> | undefined;
    try {
      await handoffEntered;
      expect(adapter.sessions).toHaveLength(1);
      early = adapter.startCalls[0]!.ctx.approvalChannel!.request('early approval');
      await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'cancel during activation' }, { taskId, seq: 2 }));
      release();
      await offering;

      expect(sent.some((e) => e.type === 'task.cancelled')).toBe(true);
      expect(sent.some((e) => e.type === 'task.started')).toBe(false);
      expect(adapter.sessions[0]!.closeCalled).toBe(true);
      expect(runner.activeTaskCount).toBe(failCommit ? 1 : 0);
      expect(sent.some((e) => e.type === 'task.await_approval')).toBe(false);
      await expect(early).resolves.toMatchObject({ approved: false });
      await expect(runner.requestApproval(taskId, 'late approval')).resolves.toMatchObject({ approved: false });
      expect(approvalRegistry.list()).toEqual([]);
      expect(sent.some((e) => e.type === 'task.await_approval')).toBe(false);
    } finally {
      release();
      await offering.catch(() => {});
      for (const pending of approvalRegistry.list()) approvalRegistry.resolve(pending.approvalId, 'reject', 'test cleanup');
      rejectCommit = false;
      await runner.shutdownActiveTasks('test cleanup');
      await early;
      handoff.mockRestore();
    }
  });

  /**
   * A decision names one approval. A wire `task.approve` for A resolves A in
   * the registry, whose callback dispatches the queued B — B must stay
   * registered and undecided until someone decides it.
   */
  describe('a wire decision resolves exactly the approval it names', () => {
    it('B stays registered and unresolved after the wire approve resolving A completes; B later resolves independently with its own decision', async () => {
      const adapter = new StubRuntimeAdapter();
      const sent: Envelope[] = [];
      const { runner, approvalRegistry } = await makeRunner(adapter, sent);
      const taskId = 'task-critical-wire-race-1';
      await offerAndActivate(runner, taskId);
      const session = adapter.sessions[0]!;

      // A: dispatched immediately (first requestApproval call for this
      // task) — registered, its own task.await_approval sent,
      // active.pendingApprovalId set to A's id.
      const outcomeA = session.requestApproval('first (A)');
      const awaitA = sent.find((e) => e.type === 'task.await_approval');
      expect(awaitA).toBeDefined();
      if (awaitA?.type !== 'task.await_approval') throw new Error('unreachable');
      const approvalIdA = awaitA.payload.approvalId;
      expect(approvalIdA).toEqual(expect.any(String));

      // B: a second, concurrent requestApproval call for the SAME task while
      // A is still pending — queues (FIFO) rather than dispatching yet (no
      // approvalId, no registry entry, no task.await_approval for it so far).
      let bSettled = false;
      let bResult: { approved: boolean; reason?: string } | undefined;
      const outcomeB = runner.requestApproval(taskId, 'second (B)');
      void outcomeB.then((result) => {
        bSettled = true;
        bResult = result;
      });

      // Exactly one dispatched (A) + one queued (B) = 2; only A is
      // actually registered so far.
      const watermarkBefore = runner.getQueueWatermarks().find((w) => w.taskId === taskId);
      expect(watermarkBefore?.pendingApprovals).toBe(2);
      expect(approvalRegistry.list()).toHaveLength(1);
      expect(approvalRegistry.list()[0]?.approvalId).toBe(approvalIdA);

      // The server-side wire task.approve targeting A arrives. Resolving A
      // dispatches B and reassigns active.pendingApprovalId to B's id, all
      // inside this one call.
      await runner.handleEnvelope(createEnvelope('task.approve', { approvalId: approvalIdA }, { taskId, seq: 1 }));

      // Flush any pending microtasks so a wrongly-resolved B's `.then` above
      // would already have fired by now.
      await Promise.resolve();
      await Promise.resolve();

      // A resolved correctly, to the session that requested it.
      await outcomeA;
      expect(session.approvalResults).toEqual([{ approved: true }]);

      // B was dispatched in turn (its own task.await_approval frame, its own
      // distinct id) as part of A's own resolution — but must still be
      // REGISTERED AND UNRESOLVED.
      expect(sent.filter((e) => e.type === 'task.await_approval')).toHaveLength(2);
      const pendingAfter = approvalRegistry.list();
      expect(pendingAfter).toHaveLength(1);
      expect(pendingAfter[0]?.summary).toBe('second (B)');
      const approvalIdB = pendingAfter[0]!.approvalId;
      expect(approvalIdB).not.toBe(approvalIdA);
      const watermarkAfter = runner.getQueueWatermarks().find((w) => w.taskId === taskId);
      expect(watermarkAfter?.pendingApprovals).toBe(1); // B dispatched, nothing queued behind it

      // B's own promise must NOT have settled — nobody has decided it yet.
      expect(bSettled).toBe(false);
      expect(bResult).toBeUndefined();

      // B can still be resolved independently, with its OWN decision —
      // proving it was never silently consumed by A's approve.
      approvalRegistry.resolve(approvalIdB, 'reject', 'B declined independently');
      await expect(outcomeB).resolves.toEqual({ approved: false, reason: 'B declined independently' });
      expect(bResult).toEqual({ approved: false, reason: 'B declined independently' });
      expect(approvalRegistry.list()).toEqual([]);
    });
  });

  /**
   * The session that asked through its `approvalChannel` learns the decision
   * from the registry, so it receives it exactly once however the approval
   * was resolved: locally (the control-socket CLI), by a wire decision, or by
   * the fail-closed timeout.
   */
  describe('the requesting session receives the decision exactly once, whatever resolved it', () => {
    it('(a) a LOCAL resolve (e.g. the control-socket CLI) reaches the session exactly once with the decision', async () => {
      const adapter = new StubRuntimeAdapter();
      const sent: Envelope[] = [];
      const { runner, approvalRegistry } = await makeRunner(adapter, sent);
      const taskId = 'task-c1-local-1';
      await offerAndActivate(runner, taskId);
      const session = adapter.sessions[0]!;

      void session.requestApproval('Bash: rm -rf /tmp/x');

      const pending = await vi.waitFor(() => {
        const list = approvalRegistry.list();
        expect(list).toHaveLength(1);
        return list;
      });

      // The control socket's LOCAL `approvals.resolve` RPC resolves the
      // registry entry directly (origin defaults to 'local').
      approvalRegistry.resolve(pending[0]!.approvalId, 'approve');

      await vi.waitFor(() => {
        expect(session.approvalResults).toEqual([{ approved: true }]);
      });
    });

    it('(b) a WIRE approve of the same shape reaches the session exactly once', async () => {
      const adapter = new StubRuntimeAdapter();
      const sent: Envelope[] = [];
      const { runner, approvalRegistry } = await makeRunner(adapter, sent);
      const taskId = 'task-c1-wire-1';
      await offerAndActivate(runner, taskId);
      const session = adapter.sessions[0]!;

      void session.requestApproval('Bash: rm -rf /tmp/x');

      const pending = await vi.waitFor(() => {
        const list = approvalRegistry.list();
        expect(list).toHaveLength(1);
        return list;
      });
      const approvalId = pending[0]!.approvalId;

      await runner.handleEnvelope(createEnvelope('task.approve', { approvalId }, { taskId, seq: 1 }));

      // Flush every pending microtask AND a full macrotask turn so a second
      // delivery would already have landed by the time we assert.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(session.approvalResults).toEqual([{ approved: true }]);
    });

    it('(c) timeout expiry reaches the session with the deny', async () => {
      const adapter = new StubRuntimeAdapter();
      const sent: Envelope[] = [];
      const { runner, approvalRegistry } = await makeRunner(adapter, sent, { approvalTimeoutMs: 20 });
      const taskId = 'task-c1-timeout-1';
      await offerAndActivate(runner, taskId);
      const session = adapter.sessions[0]!;

      void session.requestApproval('Bash: sleep forever');

      // With a 20ms timeout, dispatch and force-resolution can both happen
      // before `vi.waitFor`'s own first poll, so this waits directly for the
      // one observable outcome that exists only once both have run.
      await vi.waitFor(() => {
        expect(session.approvalResults).toHaveLength(1);
      });
      expect(session.approvalResults[0]?.approved).toBe(false);
      expect(session.approvalResults[0]?.reason).toMatch(/timed out/);
      expect(approvalRegistry.list()).toEqual([]); // the timeout consumed the entry
    });
  });

  /**
   * `ApprovalRegistry.resolve` deletes the pending entry BEFORE invoking its
   * registered `onResolve` callback, so a genuine bug in that callback —
   * here, `dispatchApproval` dispatching the next QUEUED approval, whose own
   * `onApprovalDispatched` call is made to throw — must reach the decision's
   * caller rather than vanish.
   */
  describe('a decision does not swallow a genuine onResolve failure', () => {
    it('a registry whose onResolve throws (dispatching the next queued approval) → the error reaches the handleApprove error path, not swallowed', async () => {
      const adapter = new StubRuntimeAdapter();
      const sent: Envelope[] = [];
      let dispatchCount = 0;
      const { runner, approvalRegistry } = await makeRunner(adapter, sent, {
        onApprovalDispatched: () => {
          dispatchCount += 1;
          // The FIRST dispatch (A, below) must succeed normally — only the
          // SECOND (B, dispatched from inside A's own onResolve callback,
          // via dispatchNextQueuedApproval) fails, reproducing a genuine bug
          // in that callback.
          if (dispatchCount === 2) {
            throw new Error('boom: dispatch callback failure');
          }
        },
      });
      const taskId = 'task-c3-1';
      await offerAndActivate(runner, taskId);

      const outcomeA = runner.requestApproval(taskId, 'first (A)');
      const outcomeB = runner.requestApproval(taskId, 'second (B)'); // queues behind A
      void outcomeA.catch(() => {});
      void outcomeB.catch(() => {});

      const pending = approvalRegistry.list();
      expect(pending).toHaveLength(1); // only A is actually dispatched so far
      const approvalIdA = pending[0]!.approvalId;

      // Wire approve of A -> handleApprove -> approvalRegistry.resolve(A,
      // 'approve', undefined, 'wire') -> A's onResolve ->
      // dispatchNextQueuedApproval -> dispatchApproval(active, 'second (B)')
      // -> onApprovalDispatched(B) THROWS — propagating back up through
      // handleApprove (no try/catch around this call) -> handleEnvelope.
      await expect(
        runner.handleEnvelope(createEnvelope('task.approve', { approvalId: approvalIdA }, { taskId, seq: 1 })),
      ).rejects.toThrow('boom: dispatch callback failure');

      expect(dispatchCount).toBe(2);
    });
  });
});
