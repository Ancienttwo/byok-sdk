// #1099 S4: production wiring proof for claim/start/cancel.
//
// The behavioral oracles stay `task-runner-cancel-race`,
// `task-runner-cancel-native`, `task-runner-offer-scratch`,
// `task-runner-shutdown-startup`, `handle-offer-characterization` and
// `daemon-task-loop`. This file adds the seam those cannot see: the reducer
// host recorded the same claim/start/cancel transitions the wire saw, and a
// cancel reduced while start is suspended makes C6 win over C5 (#1218).
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { ApprovalRegistry } from '../daemon/approvals';
import { hostFor, forgetHost } from '../daemon/task-runner/host';
import type { BlobResolver } from '../daemon/blob-client';
import type { RuntimeAdapterPrepareInput, RuntimeAdapterPrepareResult } from '../types';
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
  sent: Envelope[],
  overrides: Partial<TaskRunnerDeps> = {},
): { runner: TaskRunner; deps: TaskRunnerDeps } {
  const deps: TaskRunnerDeps = {
    ...freshOfferRunnerDeps(),
    getIngressBudget: testIngressBudget,
    scratchRoot: testScratchOwner(),
    adapters: [new StubRuntimeAdapter()],
    ...testAgentHomeDeps(),
    deviceId: 'device-1',
    send: envelope => { sent.push(envelope); },
    blobClient: unusedBlobClient,
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    approvalRegistry: new ApprovalRegistry(),
    ...overrides,
  };
  return { runner: new TaskRunner(deps), deps };
}

function offerEnvelope(taskId: string, seq = 1): Envelope {
  return createEnvelope(
    'task.offer',
    { agentRef: freshTestAgentRef(), instruction: 's4 claim/start', ...FRESH_OFFER },
    { taskId, seq },
  );
}

function wireTypes(sent: Envelope[], taskId: string): string[] {
  return sent.filter(envelope => envelope.task_id === taskId).map(envelope => envelope.type);
}

/** A start that waits for the test and then throws, so a cancel can race it. */
class GatedFailingAdapter extends StubRuntimeAdapter {
  private enter!: () => void;
  private releaseGate!: () => void;
  readonly entered = new Promise<void>(resolve => { this.enter = resolve; });
  private readonly gate = new Promise<void>(resolve => { this.releaseGate = resolve; });

  release(): void { this.releaseGate(); }

  override async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const base = await super.prepare(input);
    if (base.kind !== 'prepared') return base;
    return {
      ...base,
      operation: {
        ...base.operation,
        start: async () => {
          this.enter();
          await this.gate;
          throw new Error('fixture start failure');
        },
      },
    };
  }
}

describe('TaskRunner claim/start/cancel host wiring (S4)', () => {
  it('reduces a cancel while start is suspended and lets C6 win over C5', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner } = makeRunner(sent, { adapters: [adapter] });
    const taskId = 'task-s4-cancel-during-start';
    const releaseStart = adapter.blockStart();

    const offer = runner.handleEnvelope(offerEnvelope(taskId));
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));
    // Claimed, but start has not resolved: no session/execution yet.
    expect(hostFor(runner).current(taskId)?.phase).toBe('claimed');
    expect(hostFor(runner).current(taskId)?.claim.sent).toBe(true);
    expect(hostFor(runner).current(taskId)?.execution).toBeUndefined();

    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'stop during start' }, { taskId, seq: 2 }));
    // The cancel reduced before the start barrier completed (strict FIFO).
    expect(hostFor(runner).current(taskId)?.cancel.requested).toBe(true);

    releaseStart();
    await offer;

    expect(wireTypes(sent, taskId).filter(type => type === 'task.claim')).toEqual(['task.claim']);
    expect(wireTypes(sent, taskId)).not.toContain('task.started');
    expect(wireTypes(sent, taskId).filter(type => type === 'task.cancelled')).toEqual(['task.cancelled']);
    const archived = hostFor(runner).archivedTask(taskId);
    expect(archived?.phase).toBe('terminalizing');
    expect(archived?.terminal?.kind).toBe('cancelled');
    expect(archived?.terminal?.reason).toBe('stop during start');
    expect(archived?.cancel.requested).toBe(true);
    expect(runner.activeTaskCount).toBe(0);
    forgetHost(runner);
  });

  it('declines a cancel reduced while the claim journal is in flight and never sends task.claim', async () => {
    const sent: Envelope[] = [];
    let enterJournal!: () => void;
    const journalEntered = new Promise<void>(resolve => { enterJournal = resolve; });
    let releaseJournal!: () => void;
    const journalGate = new Promise<void>(resolve => { releaseJournal = resolve; });
    const { runner } = makeRunner(sent, {
      beforeClaim: async () => { enterJournal(); await journalGate; },
    });
    const taskId = 'task-s4-cancel-during-journal';
    const offer = runner.handleEnvelope(offerEnvelope(taskId));
    await journalEntered;
    expect(hostFor(runner).current(taskId)?.phase).toBe('claiming');

    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'stop before claim' }, { taskId, seq: 2 }));
    // X2a: the claim is not committed, so the cancel declines immediately.
    const declined = hostFor(runner).current(taskId);
    expect(declined?.phase).toBe('declined');
    expect(declined?.claim.sent).toBe(false);

    releaseJournal();
    await offer;

    const decline = sent.find(envelope => envelope.type === 'task.decline' && envelope.task_id === taskId);
    expect(decline?.payload).toMatchObject({ reason: 'cancelled before claim', retryable: false });
    expect(wireTypes(sent, taskId)).not.toContain('task.claim');
    expect(wireTypes(sent, taskId)).not.toContain('task.started');
    const archived = hostFor(runner).archivedTask(taskId);
    expect(archived?.phase).toBe('declined');
    expect(archived?.terminal?.kind).toBe('declined');
    expect(runner.activeTaskCount).toBe(0);
    forgetHost(runner);
  });

  it('records claim.sent, session_bound and running before task.started is visible as running', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner } = makeRunner(sent, { adapters: [adapter] });
    const taskId = 'task-s4-claim-started';
    await runner.handleEnvelope(offerEnvelope(taskId));

    const types = wireTypes(sent, taskId);
    expect(types.indexOf('task.claim')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('task.started')).toBeGreaterThan(types.indexOf('task.claim'));
    const current = hostFor(runner).current(taskId);
    expect(current?.phase).toBe('running');
    expect(current?.claim).toEqual({ journaled: true, sent: true });
    expect(current?.execution?.sessionRef).toBe(adapter.sessions[0]?.sessionRef);
    expect(current?.startup.owner).toBe('active');
    expect(current?.teardown.batcher).toBe('running');

    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(wireTypes(sent, taskId)).toContain('task.complete'));
    forgetHost(runner);
  });

  it('start failure with a pending cancel sends task.cancelled, never task.fail', async () => {
    const adapter = new GatedFailingAdapter();
    const sent: Envelope[] = [];
    const { runner } = makeRunner(sent, { adapters: [adapter] });
    const taskId = 'task-s4-failed-start-cancel';
    const offer = runner.handleEnvelope(offerEnvelope(taskId));
    await adapter.entered;

    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'cancel the failing start' }, { taskId, seq: 2 }));
    adapter.release();
    await offer;

    expect(wireTypes(sent, taskId)).not.toContain('task.started');
    expect(wireTypes(sent, taskId)).not.toContain('task.fail');
    expect(wireTypes(sent, taskId).filter(type => type === 'task.cancelled')).toEqual(['task.cancelled']);
    const archived = hostFor(runner).archivedTask(taskId);
    expect(archived?.phase).toBe('terminalizing');
    expect(archived?.terminal?.kind).toBe('cancelled');
    expect(archived?.terminal?.reason).toBe('cancel the failing start');
    // The abort already owned the late start, so startup ownership stays
    // retained exactly like the legacy cancel-vs-start path; stopping retries
    // here keeps the fixture's 1s timer out of the next test.
    runner.stopAcceptingOffers();
    forgetHost(runner);
  });

  it('records a claim journal failure as C9 and never claims', async () => {
    const sent: Envelope[] = [];
    const { runner } = makeRunner(sent, {
      beforeClaim: async () => { throw new Error('fixture journal failure'); },
    });
    const taskId = 'task-s4-journal-failed';
    await runner.handleEnvelope(offerEnvelope(taskId));

    const decline = sent.find(envelope => envelope.type === 'task.decline' && envelope.task_id === taskId);
    expect(decline?.payload).toMatchObject({
      reason: 'claim journal unavailable: fixture journal failure',
      retryable: true,
    });
    expect(wireTypes(sent, taskId)).not.toContain('task.claim');
    const archived = hostFor(runner).archivedTask(taskId);
    expect(archived?.phase).toBe('declined');
    expect(archived?.terminal?.kind).toBe('declined');
    expect(archived?.terminal?.retryable).toBe(true);
    forgetHost(runner);
  });

  it('records a start failure without a cancel as C7 and fails the claimed task', async () => {
    const adapter = new StubRuntimeAdapter();
    adapter.startError = new Error('fixture start boom');
    const sent: Envelope[] = [];
    const { runner } = makeRunner(sent, { adapters: [adapter] });
    const taskId = 'task-s4-start-failed';
    await runner.handleEnvelope(offerEnvelope(taskId));

    expect(wireTypes(sent, taskId).filter(type => type === 'task.fail')).toEqual(['task.fail']);
    expect(wireTypes(sent, taskId)).not.toContain('task.started');
    expect(wireTypes(sent, taskId)).not.toContain('task.cancelled');
    const archived = hostFor(runner).archivedTask(taskId);
    expect(archived?.phase).toBe('terminalizing');
    expect(archived?.terminal?.kind).toBe('failed');
    expect(archived?.terminal?.retryable).toBe(false);
    forgetHost(runner);
  });

  it('records an activation failure as C8 and fails the claimed task', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, deps } = makeRunner(sent, { adapters: [adapter] });
    vi.spyOn(deps.agentSessionHandoffs!, 'record').mockRejectedValueOnce(new Error('fixture handoff failure'));
    const taskId = 'task-s4-activation-failed';
    await runner.handleEnvelope(offerEnvelope(taskId));

    expect(wireTypes(sent, taskId).filter(type => type === 'task.fail')).toEqual(['task.fail']);
    expect(wireTypes(sent, taskId)).not.toContain('task.started');
    const archived = hostFor(runner).archivedTask(taskId);
    expect(archived?.terminal?.kind).toBe('failed');
    expect(archived?.terminal?.retryable).toBe(false);
    expect(archived?.terminal?.reason).toContain('Agent session handoff could not be durably written before start');
    forgetHost(runner);
  });
});
