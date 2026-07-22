import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type AgentEvent, type Envelope, type TaskOfferPayload } from '@byok/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  MAX_PENDING_APPROVALS_PER_TASK,
  TaskRunner,
  type TaskRunnerDeps,
} from '../daemon/task-runner';
import type { ApprovalChannel, RuntimeAdapter, RuntimeCapabilities, RuntimeDetectResult, Session, TaskContext } from '../types';
import { AsyncQueue } from '../util/async-queue';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

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
  overrides: Partial<Pick<TaskRunnerDeps, 'approvalTimeoutMs' | 'approvalRegistry' | 'onApprovalDispatched'>> = {},
): Promise<{ runner: TaskRunner; approvalRegistry: ApprovalRegistry }> {
  const approvalRegistry = overrides.approvalRegistry ?? new ApprovalRegistry();
  const deps: TaskRunnerDeps = {
    adapters: [adapter],
    workspaceRoot: await tmpDir('byok-taskrunner-approval-workspace-'),
    deviceId: 'device-1',
    send: (envelope) => {
      sent.push(envelope);
    },
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-taskrunner-approval-store-')),
    approvalRegistry,
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    approvalTimeoutMs: overrides.approvalTimeoutMs,
    onApprovalDispatched: overrides.onApprovalDispatched,
  };
  return { runner: new TaskRunner(deps), approvalRegistry };
}

async function offerAndActivate(runner: TaskRunner, taskId: string): Promise<void> {
  await runner.handleEnvelope(
    createEnvelope('task.offer', { instruction: 'do work', policy: { mode: 'confirm' } }, { taskId, seq: 1 }),
  );
}

/**
 * CRITICAL regression fixture (`clearPendingApproval`'s own doc comment,
 * `task-runner.ts`): a `Session` double whose `resolveApproval()` genuinely
 * routes through `TaskContext.approvalChannel.resolve` — the same shape
 * `confirm-mode-approval-e2e.test.ts`'s own `ApprovalAwareSession` uses to
 * mirror exactly what the REAL claude adapter's `ClaudeSession
 * .resolveApproval` does (`adapters/claude/claude-adapter.ts`: `await this
 * .approvalChannel.resolve(approved, reason)`, nothing else).
 *
 * Deliberately NOT `StubSession` (`fixtures/stub-adapter.ts`): that double
 * just records the `resolveApproval()` call locally and never touches
 * `deps.approvalRegistry` at all, so it cannot reproduce the bug below — the
 * whole race lives INSIDE the synchronous `approvalChannel.resolve ->
 * approvalRegistry.resolve -> onResolve -> dispatchNextQueuedApproval` chain
 * a channel-routing session's own `resolveApproval()` call triggers, which
 * only THIS shape of session actually exercises.
 */
class ChannelRoutingSession implements Session {
  private readonly queue = new AsyncQueue<AgentEvent>();
  readonly resolveApprovalCalls: Array<{ approved: boolean; reason?: string }> = [];

  constructor(
    public readonly sessionRef: string,
    private readonly approvalChannel: ApprovalChannel | undefined,
  ) {}

  get events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    this.queue.end();
  }
  async resolveApproval(approved: boolean, reason?: string): Promise<void> {
    this.resolveApprovalCalls.push(reason === undefined ? { approved } : { approved, reason });
    if (!this.approvalChannel) throw new Error('no approval channel wired up for this test session');
    await this.approvalChannel.resolve(approved, reason);
  }
}

class ChannelRoutingAdapter implements RuntimeAdapter {
  readonly id = 'channel-routing-stub';
  readonly sessions: ChannelRoutingSession[] = [];

  async detect(): Promise<RuntimeDetectResult> {
    return { present: true, version: '0.0.0' };
  }
  capabilities(): RuntimeCapabilities {
    return { steer: false, resume: true, permissionModes: ['confirm'] };
  }
  async start(task: TaskOfferPayload, ctx: TaskContext): Promise<Session> {
    const session = new ChannelRoutingSession(
      task.sessionRef ?? `channel-session-${this.sessions.length + 1}`,
      ctx.approvalChannel,
    );
    this.sessions.push(session);
    return session;
  }
}

/** Same shape as `makeRunner` above, scoped to `ChannelRoutingAdapter` — kept separate rather than widening the shared helper's parameter type, since only this one regression test needs a channel-routing session. */
async function makeChannelRunner(
  adapter: ChannelRoutingAdapter,
  sent: Envelope[],
): Promise<{ runner: TaskRunner; approvalRegistry: ApprovalRegistry }> {
  const approvalRegistry = new ApprovalRegistry();
  const deps: TaskRunnerDeps = {
    adapters: [adapter],
    workspaceRoot: await tmpDir('byok-taskrunner-approval-channel-workspace-'),
    deviceId: 'device-1',
    send: (envelope) => {
      sent.push(envelope);
    },
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-taskrunner-approval-channel-store-')),
    approvalRegistry,
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
  };
  return { runner: new TaskRunner(deps), approvalRegistry };
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
    if (awaitApprovalEnvelope?.type !== 'task.await_approval') throw new Error('unreachable');
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
    // stray resolution — resolveApprovalCalls on the session stays untouched
    // and no error is thrown anywhere in the process.
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

  /**
   * Acceptance finding 1 (MEDIUM): `TaskRunner.pump()`'s dormant
   * `needs_approval` branch used to stamp `active.pendingApprovalId`
   * directly, bypassing `ApprovalRegistry` entirely — no registry entry, and
   * nothing to ever clear it. For a hypothetical adapter mixing this
   * stream-based path with the out-of-band `approvalChannel` (channel) path
   * on the SAME task, that meant: the dormant event could clobber an
   * already-dispatched channel approval's id (so a later, correctly-targeted
   * wire decision for the channel approval would look stale and be
   * dropped); a resolved dormant approval left a stale id blocking every
   * later `requestApproval` call for the task until it finished; and a wire
   * decision routed through `ctx.approvalChannel.resolve()` for a dormant,
   * never-registered id threw `ApprovalNotFoundError`, which
   * `handleApprove`/`handleReject` don't treat as benign staleness —
   * failing the task outright.
   *
   * This test drives exactly that interleaving. Verified to FAIL against the
   * pre-fix code: temporarily reverting `pump()`'s `needs_approval` branch
   * to its old direct-stamp form (and dropping the `clearPendingApproval`
   * calls in `handleApprove`/`handleReject`) reproduces the clobber —
   * `pendingApprovals` never reaches 2 (the dormant event overwrites
   * `pendingApprovalId` instead of queuing), and the channel `task.approve`
   * below is treated as a stale mismatch (dropped, `resolveApprovalCalls`
   * stays empty, `channelOutcome` never resolves and the test fails on
   * vitest's own per-test timeout).
   */
  describe('mixed-path regression (acceptance finding 1): dormant needs_approval interleaved with a channel-dispatched approval', () => {
    it('a dormant stream event does not clobber an already-dispatched channel approval — the channel decision still resolves via its exact id, and the dormant one is queued behind it (not lost) and dispatched in turn', async () => {
      const adapter = new StubRuntimeAdapter();
      const sent: Envelope[] = [];
      const { runner, approvalRegistry } = await makeRunner(adapter, sent);
      const taskId = 'task-mixed-path-1';
      await offerAndActivate(runner, taskId);
      const session = adapter.sessions[0]!;

      // Channel path (e.g. an MCP-triggered approval): dispatches
      // immediately — registered, its own task.await_approval sent,
      // active.pendingApprovalId set to its id.
      const channelOutcome = runner.requestApproval(taskId, 'channel: Bash rm -rf /tmp/x');
      const channelEnvelope = sent.find((e) => e.type === 'task.await_approval');
      expect(channelEnvelope).toBeDefined();
      if (channelEnvelope?.type !== 'task.await_approval') throw new Error('unreachable');
      const channelApprovalId = channelEnvelope.payload.approvalId;
      expect(channelApprovalId).toEqual(expect.any(String));

      // Stream path: a hypothetical adapter surfacing this on its own event
      // stream for the SAME task WHILE the channel approval above is still
      // dispatched — the interleaving the finding calls out.
      session.emit({ type: 'needs_approval', summary: 'dormant: Write /etc/hosts' });

      // Must queue behind the channel approval rather than clobber it: one
      // dispatched (the channel one) + one queued (the dormant one) = 2.
      // `getQueueWatermarks()` is the intentional public introspection for
      // this — pre-fix this never reaches 2 (the dormant branch overwrites
      // `pendingApprovalId` in place instead of queuing, so this stays at 1
      // forever and `vi.waitFor` below times out).
      await vi.waitFor(() => {
        const watermark = runner.getQueueWatermarks().find((w) => w.taskId === taskId);
        expect(watermark?.pendingApprovals).toBe(2);
      });
      // Still exactly one registry entry — the dormant one hasn't been
      // dispatched yet, only queued.
      expect(approvalRegistry.list()).toHaveLength(1);
      expect(approvalRegistry.list()[0]?.summary).toBe('channel: Bash rm -rf /tmp/x');

      // Resolve the CHANNEL approval via its exact, real id. Pre-fix, the
      // dormant event above clobbered `active.pendingApprovalId`, so this
      // exact-match check would see a mismatch (stale), drop the decision,
      // and `channelOutcome` would never resolve.
      await runner.handleEnvelope(createEnvelope('task.approve', { approvalId: channelApprovalId }, { taskId, seq: 1 }));
      expect(session.resolveApprovalCalls).toEqual([{ approved: true }]);
      await expect(channelOutcome).resolves.toEqual({ approved: true, reason: undefined });

      // The dormant one is now dispatched in turn — its own registry entry
      // and its own task.await_approval frame — proving it shares the SAME
      // registry-based lifecycle rather than being silently lost or stuck.
      expect(sent.filter((e) => e.type === 'task.await_approval')).toHaveLength(2);
      const pendingAfter = approvalRegistry.list();
      expect(pendingAfter).toHaveLength(1);
      expect(pendingAfter[0]?.summary).toBe('dormant: Write /etc/hosts');
      const dormantApprovalId = pendingAfter[0]!.approvalId;
      expect(dormantApprovalId).not.toBe(channelApprovalId);

      // And it resolves normally too — nothing left dangling.
      approvalRegistry.resolve(dormantApprovalId, 'approve');
      expect(approvalRegistry.list()).toEqual([]);
    });
  });

  /**
   * CRITICAL (acceptance follow-up): reproduces the exact race flagged in
   * `clearPendingApproval`'s own doc comment (`task-runner.ts`). For a
   * channel-routing session, `handleApprove`'s `await active.session
   * .resolveApproval(true)` synchronously drives `ctx.approvalChannel
   * .resolve` -> `approvalRegistry.resolve(A, 'wire')` -> A's own
   * `onResolve` (`dispatchApproval`) -> `dispatchNextQueuedApproval` — which
   * dispatches the next QUEUED approval (B) and reassigns
   * `active.pendingApprovalId = B`, all strictly BEFORE that `await` in
   * `handleApprove` ever settles. Reading `active.pendingApprovalId` only
   * AFTER the await (the pre-fix form) resolves B instead of A: a queued,
   * never-human-decided approval comes back `{ approved: true }` (A's
   * decision) purely because it happened to be next in line — and since
   * this always resolves with origin `'wire'`, the server is never even
   * told about B via `task.approval_resolved` either.
   *
   * Deliberately uses `ChannelRoutingSession` above, not `StubSession` — see
   * that class's own doc comment for why the stream-style stub cannot
   * trigger this race at all.
   *
   * Verified to FAIL against the pre-fix code: temporarily reverting
   * `clearPendingApproval` to read `active.pendingApprovalId` directly
   * (dropping the `resolvedId` capture in `handleApprove`/`handleReject`)
   * reproduces the clobber — `approvalRegistry.list()` after the wire
   * approve comes back empty instead of holding B, and `bSettled` flips
   * `true` (with `{ approved: true }`, A's decision) before B was ever
   * actually decided by anyone.
   */
  describe('CRITICAL regression: wire task.approve targeting a channel-resolved approval (A) must not silently resolve a different, queued approval (B)', () => {
    it('B stays registered and unresolved after the wire approve resolving A completes; B later resolves independently with its own decision', async () => {
      const adapter = new ChannelRoutingAdapter();
      const sent: Envelope[] = [];
      const { runner, approvalRegistry } = await makeChannelRunner(adapter, sent);
      const taskId = 'task-critical-wire-race-1';
      await offerAndActivate(runner, taskId);
      const session = adapter.sessions[0]!;

      // A: dispatched immediately (first requestApproval call for this
      // task) — registered, its own task.await_approval sent,
      // active.pendingApprovalId set to A's id.
      const outcomeA = runner.requestApproval(taskId, 'first (A)');
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

      // Sanity, mirroring the mixed-path regression test above: exactly one
      // dispatched (A) + one queued (B) = 2; only A is actually registered
      // so far.
      const watermarkBefore = runner.getQueueWatermarks().find((w) => w.taskId === taskId);
      expect(watermarkBefore?.pendingApprovals).toBe(2);
      expect(approvalRegistry.list()).toHaveLength(1);
      expect(approvalRegistry.list()[0]?.approvalId).toBe(approvalIdA);

      // The server-side wire task.approve targeting A arrives. This drives
      // handleApprove -> session.resolveApproval(true) ->
      // ctx.approvalChannel.resolve -> approvalRegistry.resolve(A, 'wire'),
      // which — still inside this ONE call — dispatches B and reassigns
      // active.pendingApprovalId to B's id BEFORE handleApprove's own
      // clearPendingApproval call ever runs.
      await runner.handleEnvelope(createEnvelope('task.approve', { approvalId: approvalIdA }, { taskId, seq: 1 }));

      // Flush any pending microtasks so a wrongly-resolved B's `.then` above
      // would already have fired by now if the bug were present.
      await Promise.resolve();
      await Promise.resolve();

      // A resolved correctly via the channel.
      expect(session.resolveApprovalCalls).toEqual([{ approved: true }]);
      await expect(outcomeA).resolves.toEqual({ approved: true, reason: undefined });

      // B was dispatched in turn (its own task.await_approval frame, its own
      // distinct id) as part of A's own resolution chain — but must still be
      // REGISTERED AND UNRESOLVED: the bug resolved it right back out with
      // A's decision instead.
      expect(sent.filter((e) => e.type === 'task.await_approval')).toHaveLength(2);
      const pendingAfter = approvalRegistry.list();
      expect(pendingAfter).toHaveLength(1);
      expect(pendingAfter[0]?.summary).toBe('second (B)');
      const approvalIdB = pendingAfter[0]!.approvalId;
      expect(approvalIdB).not.toBe(approvalIdA);
      const watermarkAfter = runner.getQueueWatermarks().find((w) => w.taskId === taskId);
      expect(watermarkAfter?.pendingApprovals).toBe(1); // B dispatched, nothing queued behind it

      // B's own MCP-side promise (the caller's requestApproval promise) must
      // NOT have settled — nobody has decided it yet.
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
   * C1 (cross-model review, P1): the fix above (reusing `requestApproval`
   * for the dormant `needs_approval` branch) closed the registry-bypass but
   * left `requestApproval`'s own returned promise `void`d — discarded, with
   * no continuation at all. The WIRE path (`handleApprove`/`handleReject`)
   * never needed that continuation: those methods already call
   * `active.session.resolveApproval()` themselves, directly, before ever
   * touching the registry. But a decision that resolves the SAME registry
   * entry any OTHER way — a LOCAL control-socket `approvals.resolve`, this
   * request's own `dispatchApproval` timeout, or a bounded-eviction
   * fallback — never goes through `handleApprove`/`handleReject` at all, so
   * nothing ever told the (stream-based) session to resume: it stayed
   * paused forever even though the daemon (and, for a 'local' origin, the
   * server too) already considered the approval decided.
   *
   * `StubSession.resolveApproval` (`fixtures/stub-adapter.ts`) is exactly
   * the right double for these three: it just records the call and never
   * touches `ctx.approvalChannel`/the registry itself (unlike
   * `ChannelRoutingSession` above), so any call recorded in
   * `resolveApprovalCalls` can only have come from the NEW continuation
   * this finding adds.
   */
  describe('C1 (cross-model review): stream-originated needs_approval resumes the session regardless of resolution origin', () => {
    it('(a) a LOCAL resolve (e.g. the control-socket CLI) still resumes the session — resolveApproval called exactly once with the decision', async () => {
      const adapter = new StubRuntimeAdapter();
      const sent: Envelope[] = [];
      const { runner, approvalRegistry } = await makeRunner(adapter, sent);
      const taskId = 'task-c1-local-1';
      await offerAndActivate(runner, taskId);
      const session = adapter.sessions[0]!;

      // Stream-originated: the adapter emits `needs_approval` on its own
      // event stream (pump()'s dormant branch), not via the out-of-band
      // approvalChannel.
      session.emit({ type: 'needs_approval', summary: 'Bash: rm -rf /tmp/x' });

      const pending = await vi.waitFor(() => {
        const list = approvalRegistry.list();
        expect(list).toHaveLength(1);
        return list;
      });

      // Simulate the control socket's LOCAL `approvals.resolve` RPC: it
      // resolves the registry entry directly, never through
      // handleApprove/handleReject — the same "local" resolution shape
      // every other test in this file drives via `approvalRegistry.resolve`
      // with no explicit origin (defaults to 'local' — see
      // `ApprovalRegistry.resolve`'s own doc comment).
      approvalRegistry.resolve(pending[0]!.approvalId, 'approve');

      await vi.waitFor(() => {
        expect(session.resolveApprovalCalls).toEqual([{ approved: true }]);
      });
    });

    it('(b) a WIRE approve of the same shape resumes the session exactly once — no double call from the requestApproval continuation', async () => {
      const adapter = new StubRuntimeAdapter();
      const sent: Envelope[] = [];
      const { runner, approvalRegistry } = await makeRunner(adapter, sent);
      const taskId = 'task-c1-wire-1';
      await offerAndActivate(runner, taskId);
      const session = adapter.sessions[0]!;

      session.emit({ type: 'needs_approval', summary: 'Bash: rm -rf /tmp/x' });

      const pending = await vi.waitFor(() => {
        const list = approvalRegistry.list();
        expect(list).toHaveLength(1);
        return list;
      });
      const approvalId = pending[0]!.approvalId;

      await runner.handleEnvelope(createEnvelope('task.approve', { approvalId }, { taskId, seq: 1 }));

      // handleApprove already called session.resolveApproval(true) directly
      // (the origin here is 'wire'). Flush every pending microtask AND a
      // full macrotask turn so a wrongly-firing continuation — the bug this
      // test guards against — would already have made its own, SECOND call
      // by the time we assert.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(session.resolveApprovalCalls).toEqual([{ approved: true }]);
    });

    it('(c) timeout expiry resumes the session with the deny', async () => {
      const adapter = new StubRuntimeAdapter();
      const sent: Envelope[] = [];
      const { runner, approvalRegistry } = await makeRunner(adapter, sent, { approvalTimeoutMs: 20 });
      const taskId = 'task-c1-timeout-1';
      await offerAndActivate(runner, taskId);
      const session = adapter.sessions[0]!;

      session.emit({ type: 'needs_approval', summary: 'Bash: sleep forever' });

      // Deliberately not asserting on `approvalRegistry.list()` mid-flight
      // here (unlike (a)/(b) above): with a 20ms timeout, dispatch and
      // force-resolution can both happen before `vi.waitFor`'s own first
      // poll — exactly like the pre-existing "force-resolves..." test above
      // (which only ever awaits the FINAL settled state), this waits
      // directly for the one observable outcome that can only exist once
      // dispatch, timeout, AND the C1 continuation have all already run.
      await vi.waitFor(() => {
        expect(session.resolveApprovalCalls).toHaveLength(1);
      });
      expect(session.resolveApprovalCalls[0]?.approved).toBe(false);
      expect(session.resolveApprovalCalls[0]?.reason).toMatch(/timed out/);
      expect(approvalRegistry.list()).toEqual([]); // the timeout consumed the entry
    });
  });

  /**
   * C3 (cross-model review, P2): `clearPendingApproval`'s catch used to
   * swallow EVERY error, not just the benign already-resolved race
   * (`ApprovalNotFoundError`) it documents. `ApprovalRegistry.resolve`
   * deletes the pending entry BEFORE invoking its registered `onResolve`
   * callback, so a genuine bug in that callback — here, `dispatchApproval`
   * dispatching the next QUEUED approval via `dispatchNextQueuedApproval`,
   * whose own `onApprovalDispatched` call is made to throw — used to vanish
   * silently instead of reaching anything.
   */
  describe('C3 (cross-model review): clearPendingApproval no longer swallows a genuine onResolve failure', () => {
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
          // in that callback rather than a benign already-resolved race.
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

      // Wire approve of A -> handleApprove -> session.resolveApproval(true)
      // (StubSession: a no-op recording call) -> clearPendingApproval(A,
      // 'approve') -> approvalRegistry.resolve(A, 'approve', undefined,
      // 'wire') -> A's onResolve -> dispatchNextQueuedApproval(active) ->
      // dispatchApproval(active, 'second (B)') -> onApprovalDispatched(B)
      // THROWS (dispatchCount === 2) — propagating back up through
      // dispatchNextQueuedApproval -> A's onResolve ->
      // ApprovalRegistry.resolve -> clearPendingApproval (NOT an
      // ApprovalNotFoundError, so re-thrown per the C3 fix) -> handleApprove
      // (no try/catch around this call) -> handleEnvelope.
      await expect(
        runner.handleEnvelope(createEnvelope('task.approve', { approvalId: approvalIdA }, { taskId, seq: 1 })),
      ).rejects.toThrow('boom: dispatch callback failure');

      expect(dispatchCount).toBe(2);
    });
  });
});
