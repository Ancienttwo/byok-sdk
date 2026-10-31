// #1099 S5: production wiring proof for the approval path.
//
// The behavioral oracles stay `task-runner-approval`,
// `task-runner-approval-resolved`, `task-runner-queue-watermarks`,
// `task-runner-tool-authorization`, `confirm-mode-approval-e2e` and
// `daemon-task-loop`. This file adds the seam those cannot see: the reducer
// host owns `TaskStateV1.approval` (pending + FIFO queue), every resolution
// reaches it as an `approval.decided`, and an approval event can never jump a
// queued barrier completion (#1218).
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { ApprovalRegistry } from '../daemon/approvals';
import { hostFor, forgetHost, type TaskRunnerHost } from '../daemon/task-runner/host';
import { createOfferFacts, type ReducerEvent, type ReducerEventType } from '../daemon/task-runner/state';
import { requestApproval as requestTaskApproval } from '../daemon/task-runner/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { FRESH_OFFER, freshOfferRunnerDeps } from './fixtures/fresh-offer';
import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
import { testScratchOwner } from './fixtures/execution-scratch';
import { testIngressBudget } from './fixtures/activity-ingress';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => { throw new Error('not used in this test'); },
  uploadArtifact: async () => { throw new Error('not used in this test'); },
};

function makeRunner(
  adapter: StubRuntimeAdapter,
  sent: Envelope[],
  overrides: Partial<TaskRunnerDeps> = {},
): { runner: TaskRunner; approvalRegistry: ApprovalRegistry } {
  const approvalRegistry = new ApprovalRegistry();
  const deps: TaskRunnerDeps = {
    ...freshOfferRunnerDeps(),
    getIngressBudget: testIngressBudget,
    scratchRoot: testScratchOwner(),
    adapters: [adapter],
    ...testAgentHomeDeps(),
    deviceId: 'device-1',
    send: envelope => { sent.push(envelope); },
    blobClient: unusedBlobClient,
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    approvalRegistry,
    ...overrides,
  };
  return { runner: new TaskRunner(deps), approvalRegistry };
}

function offerEnvelope(taskId: string, seq = 1): Envelope {
  return createEnvelope(
    'task.offer',
    { agentRef: freshTestAgentRef(), instruction: 's5 approval', ...FRESH_OFFER },
    { taskId, seq },
  );
}

function wireTypes(sent: Envelope[], taskId: string): string[] {
  return sent.filter(envelope => envelope.task_id === taskId).map(envelope => envelope.type);
}

function awaitApprovals(sent: Envelope[]): Array<Extract<Envelope, { type: 'task.await_approval' }>> {
  return sent.filter((envelope): envelope is Extract<Envelope, { type: 'task.await_approval' }> =>
    envelope.type === 'task.await_approval');
}

describe('TaskRunner approval host wiring (S5)', () => {
  it('A1 records the dispatched approval, and the wire decision reduces A5 back to running', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner } = makeRunner(adapter, sent);
    const taskId = 'task-s5-approve';
    await runner.handleEnvelope(offerEnvelope(taskId));

    const outcome = runner.requestApproval(taskId, 'Bash: echo hi');
    const dispatched = awaitApprovals(sent);
    expect(dispatched).toHaveLength(1);
    const approvalId = dispatched[0]!.payload.approvalId;
    if (dispatched[0]!.payload.sealed !== undefined) throw new Error('unreachable');
    expect(dispatched[0]!.payload.summary).toBe('Bash: echo hi');

    const pendingState = hostFor(runner).current(taskId);
    expect(pendingState?.phase).toBe('awaiting_approval');
    expect(pendingState?.approval.pending).toMatchObject({ approvalId, kind: 'task-terminal' });
    expect(pendingState?.approval.queue).toEqual([]);

    await runner.handleEnvelope(createEnvelope('task.approve', { approvalId }, { taskId, seq: 2 }));
    await expect(outcome).resolves.toEqual({ approved: true, reason: undefined });

    const resumed = hostFor(runner).current(taskId);
    expect(resumed?.phase).toBe('running');
    expect(resumed?.approval.pending).toBeUndefined();
    // Wire decisions are never echoed back as task.approval_resolved.
    expect(wireTypes(sent, taskId)).not.toContain('task.approval_resolved');
    forgetHost(runner);
  });

  it('an approval requested while start() is pending waits for activation and is recorded only afterwards', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner } = makeRunner(adapter, sent);
    const taskId = 'task-s5-early';
    const releaseStart = adapter.blockStart();
    const offering = runner.handleEnvelope(offerEnvelope(taskId));
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));

    const early = adapter.startCalls[0]!.ctx.approvalChannel!.request('Bash: early');
    await new Promise(resolve => setTimeout(resolve, 20));
    // Still claimed: nothing may be dispatched, registered or recorded yet.
    expect(hostFor(runner).current(taskId)?.phase).toBe('claimed');
    expect(hostFor(runner).current(taskId)?.approval.pending).toBeUndefined();
    expect(awaitApprovals(sent)).toHaveLength(0);

    releaseStart();
    await offering;
    await vi.waitFor(() => expect(awaitApprovals(sent)).toHaveLength(1));
    expect(hostFor(runner).current(taskId)?.phase).toBe('awaiting_approval');
    expect(hostFor(runner).current(taskId)?.approval.pending?.approvalId)
      .toBe(awaitApprovals(sent)[0]!.payload.approvalId);

    await runner.handleEnvelope(createEnvelope('task.approve', {
      approvalId: awaitApprovals(sent)[0]!.payload.approvalId,
    }, { taskId, seq: 2 }));
    await expect(early).resolves.toEqual({ approved: true, reason: undefined });
    forgetHost(runner);
  });

  it('a tool-authorization deny reduces A6, reports the local decision and keeps the turn running', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = makeRunner(adapter, sent);
    const taskId = 'task-s5-tool-deny';
    await runner.handleEnvelope(offerEnvelope(taskId));

    const outcome = requestTaskApproval.call(runner, taskId, 'Bash: rm -rf /', undefined, 'tool-authorization');
    const approvalId = awaitApprovals(sent)[0]!.payload.approvalId;
    approvalRegistry.resolve(approvalId, 'reject', 'operator said no', 'control');
    await expect(outcome).resolves.toEqual({ approved: false, reason: 'operator said no' });

    const current = hostFor(runner).current(taskId);
    expect(current?.phase).toBe('running');
    expect(current?.terminal).toBeUndefined();
    expect(current?.approval.pending).toBeUndefined();
    expect(wireTypes(sent, taskId)).not.toContain('task.fail');
    const resolved = sent.find(envelope => envelope.type === 'task.approval_resolved');
    expect(resolved?.type === 'task.approval_resolved' && resolved.payload).toMatchObject({
      approvalId, decision: 'reject', resolvedBy: 'local',
    });
    forgetHost(runner);
  });

  it('a task-terminal deny reduces A7: the failed terminal is selected once and the task fails once', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner } = makeRunner(adapter, sent);
    const taskId = 'task-s5-terminal-deny';
    await runner.handleEnvelope(offerEnvelope(taskId));

    const outcome = runner.requestApproval(taskId, 'Continue?');
    const approvalId = awaitApprovals(sent)[0]!.payload.approvalId;
    await runner.handleEnvelope(createEnvelope('task.reject', { reason: 'no continuation', approvalId }, { taskId, seq: 2 }));
    await expect(outcome).resolves.toEqual({ approved: false, reason: 'no continuation' });

    await vi.waitFor(() => expect(wireTypes(sent, taskId)).toContain('task.fail'));
    expect(wireTypes(sent, taskId).filter(type => type === 'task.fail')).toEqual(['task.fail']);
    const archived = hostFor(runner).archivedTask(taskId);
    expect(archived?.terminal).toMatchObject({ kind: 'failed', reason: 'no continuation', retryable: false });
    expect(archived?.approval.pending).toBeUndefined();
    expect(wireTypes(sent, taskId).filter(type => type === 'task.await_approval')).toHaveLength(1);
    forgetHost(runner);
  });

  it('expiry reduces A7 as a fail-closed decision and reports approval_resolved', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner } = makeRunner(adapter, sent, { approvalTimeoutMs: 20 });
    const taskId = 'task-s5-expiry';
    await runner.handleEnvelope(offerEnvelope(taskId));

    const outcome = await runner.requestApproval(taskId, 'Bash: sleep forever');
    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toMatch(/timed out/);
    const current = hostFor(runner).current(taskId);
    expect(current?.approval.pending).toBeUndefined();
    expect(current?.terminal).toMatchObject({ kind: 'failed' });
    const resolved = sent.find(envelope => envelope.type === 'task.approval_resolved');
    expect(resolved?.type === 'task.approval_resolved' && resolved.payload.decision).toBe('reject');
    forgetHost(runner);
  });

  it('redelivery of an already-resolved decision only audits (A11) and never re-sends', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const stale: Array<{ taskId: string; decision: string; reason?: string }> = [];
    const { runner } = makeRunner(adapter, sent, {
      onStaleApprovalDecision: (taskId, decision, reason) => {
        stale.push({ taskId, decision, ...(reason === undefined ? {} : { reason }) });
      },
    });
    const taskId = 'task-s5-redelivery';
    await runner.handleEnvelope(offerEnvelope(taskId));

    const outcome = runner.requestApproval(taskId, 'Continue?');
    const approvalId = awaitApprovals(sent)[0]!.payload.approvalId;
    await runner.handleEnvelope(createEnvelope('task.approve', { approvalId }, { taskId, seq: 2 }));
    await expect(outcome).resolves.toEqual({ approved: true, reason: undefined });

    // Redelivered as if the server retried the same frame.
    await runner.handleEnvelope(createEnvelope('task.approve', { approvalId }, { taskId, seq: 3 }));
    expect(stale).toHaveLength(1);
    expect(stale[0]!.reason).toContain('does not match the currently pending approval (none pending)');
    expect(wireTypes(sent, taskId).filter(type => type === 'task.await_approval')).toHaveLength(1);
    expect(wireTypes(sent, taskId)).not.toContain('task.approval_resolved');
    expect(hostFor(runner).current(taskId)?.approval.pending).toBeUndefined();
    forgetHost(runner);
  });

  it('cancel while an approval is pending settles the caller fail-closed and selects the cancelled terminal', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = makeRunner(adapter, sent);
    const taskId = 'task-s5-cancel-race';
    await runner.handleEnvelope(offerEnvelope(taskId));

    const outcome = runner.requestApproval(taskId, 'Continue?');
    const queued = runner.requestApproval(taskId, 'Second?');
    expect(awaitApprovals(sent)).toHaveLength(1);
    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'stop now' }, { taskId, seq: 2 }));

    const [settled, queuedOutcome] = await Promise.all([outcome, queued]);
    expect(settled.approved).toBe(false);
    expect(settled.reason).toContain('finished');
    expect(queuedOutcome.approved).toBe(false);
    // The queue is drained BEFORE the pending entry: if A10 ran first, its
    // dispatch.next would send a second task.await_approval for the queued
    // request instead of settling it.
    expect(queuedOutcome.reason).toContain('finished before this queued approval request could be dispatched');
    expect(awaitApprovals(sent)).toHaveLength(1);
    expect(wireTypes(sent, taskId).filter(type => type === 'task.cancelled')).toEqual(['task.cancelled']);
    expect(wireTypes(sent, taskId)).not.toContain('task.fail');
    expect(approvalRegistry.list()).toEqual([]);
    // S5 owns the approval half of this race: the pending entry is cleared
    // and never re-dispatched. Selecting the cancelled terminal for an
    // already-running task is the lifecycle slice's transition (S6).
    expect(hostFor(runner).archivedTask(taskId)?.approval.pending).toBeUndefined();
    forgetHost(runner);
  });
});

/* ------------------------- host-level FIFO (#1218) ------------------------- */

function event(type: ReducerEventType, overrides: Omit<Partial<ReducerEvent>, 'type'> = {}): ReducerEvent {
  return { type, taskId: 't1', atMs: 100, ...overrides };
}

/** Brings a synthetic host task to `running` so approval rows are eligible. */
function bringToRunning(host: TaskRunnerHost): void {
  host.beginOffer('t1');
  host.dispatchSync(event('offer.received', { offer: createOfferFacts() }));
  host.dispatchSync(event('admission.begin'));
  host.dispatchSync(event('admission.stage', { stage: 'home' }));
  host.dispatchSync(event('admission.stage', { stage: 'limits' }));
  host.dispatchSync(event('admission.claimable'));
  host.registerHandler('send.claim', () => undefined);
  host.dispatchSync(event('claim.journaled'));
  const execution = { sessionRef: 'session-1', runtimeId: 'pi', harnessId: 'pi', home: '/home', cwd: '/work', leaseId: 'lease-1', startedAtMs: 1 };
  host.dispatchSync(event('runtime.session_bound'));
  host.dispatchSync(event('runtime.started', { execution }));
}

describe('TaskRunnerHost: approval FIFO ordering (#1218)', () => {
  it('an approval event cannot jump a queued barrier completion', async () => {
    const runner = {} as TaskRunner;
    const host = hostFor(runner);
    bringToRunning(host);
    expect(host.current('t1')?.phase).toBe('running');

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    host.registerHandler('steer.session', async () => {
      await gate;
      // The barrier completes with an approval event; it must land at the
      // mailbox TAIL, behind everything already queued.
      return { completion: { type: 'approval.requested', approvalId: 'a-late', requestId: 'r-late', kind: 'task-terminal' } };
    });

    const steered = host.dispatch(event('steer.received'));
    const queuedApproval = host.dispatch(event('approval.requested', {
      approvalId: 'a-first', requestId: 'r-first', kind: 'task-terminal',
    }));
    // The barrier owns the mailbox: neither the approval nor its effects ran.
    expect(host.current('t1')?.approval.pending).toBeUndefined();
    expect(host.current('t1')?.approval.queue).toEqual([]);

    release();
    await Promise.all([steered, queuedApproval]);

    // The queued approval reduced first (A1), then the barrier completion
    // queued behind it (A2) — never the other way around.
    expect(host.current('t1')?.approval.pending?.requestId).toBe('r-first');
    expect(host.current('t1')?.approval.queue.map(entry => entry.requestId)).toEqual(['r-late']);
    forgetHost(runner);
  });
});
