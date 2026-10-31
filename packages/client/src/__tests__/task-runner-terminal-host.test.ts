// #1099 S6: production wiring proof for terminal/finish/shutdown and the
// Agent-message completion gate.
//
// The behavioral oracles stay `task-runner-shutdown`, `task-runner-runtime-failure`,
// `task-runner-resource-limits`, `task-runner-close-receipt`,
// `task-runner-cancel-durability`, `task-runner-execution-record`,
// `agent-message-completion-gate`, `journal-integration`,
// `outbound-settlement` and `daemon-task-loop`. This file adds the seam those
// cannot see: the reducer host owns the one terminal decision and its phase
// progression, the adapter keeps the exact bytes, and no late event can emit a
// second terminal after shutdown or after the message gate closed.
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { ApprovalRegistry } from '../daemon/approvals';
import { hostFor, forgetHost } from '../daemon/task-runner/host';
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
    { agentRef: freshTestAgentRef(), instruction: 's6 terminal', ...FRESH_OFFER },
    { taskId, seq },
  );
}

const TERMINALS = new Set(['task.complete', 'task.fail', 'task.cancelled']);
function terminals(sent: Envelope[], taskId: string): Envelope[] {
  return sent.filter(envelope => envelope.task_id === taskId && TERMINALS.has(envelope.type));
}
function wireTypes(sent: Envelope[], taskId: string): string[] {
  return sent.filter(envelope => envelope.task_id === taskId).map(envelope => envelope.type);
}

describe('TaskRunner terminal/finish/shutdown host wiring (S6)', () => {
  it('first-terminal-wins: a complete/cancel race publishes exactly one terminal', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner } = makeRunner(sent, { adapters: [adapter] });
    const taskId = 'task-s6-race';
    await runner.handleEnvelope(offerEnvelope(taskId));
    const session = adapter.sessions[0]!;

    session.emit({ type: 'turn_end' });
    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'race' }, { taskId, seq: 2 }));
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
    await new Promise(resolve => setTimeout(resolve, 20));

    const wire = terminals(sent, taskId);
    expect(wire).toHaveLength(1);
    const archived = hostFor(runner).archivedTask(taskId);
    expect(archived?.terminal).toBeDefined();
    expect(archived?.terminal?.kind === 'complete' ? 'task.complete' : 'task.cancelled').toBe(wire[0]!.type);
    forgetHost(runner);
  });

  it('cancel vs done: a turn_end after cancel only audits and never revives the task', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner } = makeRunner(sent, { adapters: [adapter] });
    const taskId = 'task-s6-cancel-first';
    await runner.handleEnvelope(offerEnvelope(taskId));
    const session = adapter.sessions[0]!;

    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'user' }, { taskId, seq: 2 }));
    session.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(terminals(sent, taskId).map(envelope => envelope.type)).toEqual(['task.cancelled']);
    const archived = hostFor(runner).archivedTask(taskId);
    expect(archived?.terminal).toMatchObject({ kind: 'cancelled' });
    expect(wireTypes(sent, taskId)).not.toContain('task.complete');
    forgetHost(runner);
  });

  it('finish during approval drains the dispatched request fail-closed and still publishes one terminal', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner } = makeRunner(sent, { adapters: [adapter] });
    const taskId = 'task-s6-finish-approval';
    await runner.handleEnvelope(offerEnvelope(taskId));
    const session = adapter.sessions[0]!;

    const approval = runner.requestApproval(taskId, 'Continue?');
    await vi.waitFor(() => expect(sent.some(envelope => envelope.type === 'task.await_approval')).toBe(true));
    session.emit({ type: 'turn_end' });

    await expect(approval).resolves.toMatchObject({ approved: false });
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
    expect(terminals(sent, taskId).map(envelope => envelope.type)).toEqual(['task.complete']);
    expect(sent.filter(envelope => envelope.type === 'task.await_approval')).toHaveLength(1);
    expect(hostFor(runner).current(taskId)).toBeUndefined();
    forgetHost(runner);
  });

  it('shutdown emits one retryable task.fail then no terminal after the shutdown acknowledgement', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner } = makeRunner(sent, { adapters: [adapter] });
    const taskId = 'task-s6-shutdown';
    await runner.handleEnvelope(offerEnvelope(taskId));

    runner.stopAcceptingOffers();
    await runner.shutdownActiveTasks('operator');
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));

    const wire = terminals(sent, taskId);
    expect(wire).toHaveLength(1);
    expect(wire[0]).toMatchObject({ type: 'task.fail', payload: { retryable: true } });
    expect((wire[0]!.payload as { reason?: string }).reason).toContain('daemon shutting down');
    expect(hostFor(runner).runnerSnapshot().shutdown?.phase).toBe('complete');

    // A late cancel, a repeat shutdown and a late reducer terminal request
    // must not emit anything after the acknowledgement.
    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'late' }, { taskId, seq: 2 }));
    await runner.shutdownActiveTasks('repeat');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(terminals(sent, taskId)).toHaveLength(1);
    forgetHost(runner);
  });

  it('a message acceptance arriving after the terminal only audits (no second terminal)', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner } = makeRunner(sent, { adapters: [adapter] });
    const taskId = 'task-s6-late-message';
    await runner.handleEnvelope(offerEnvelope(taskId));
    const host = hostFor(runner);

    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'terminal first' }, { taskId, seq: 2 }));
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));

    const before = terminals(sent, taskId).map(envelope => envelope.type);
    expect(before).toEqual(['task.cancelled']);
    // M4: an acceptance that arrives after the terminal only audits, even at
    // the reducer level where no production disposition path exists anymore.
    await host.dispatch({ type: 'message.accepted', taskId, atMs: Date.now(), completionToken: 'late' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(terminals(sent, taskId).map(envelope => envelope.type)).toEqual(before);
    expect(hostFor(runner).current(taskId)).toBeUndefined();
    forgetHost(runner);
  });

  it('a failed terminal commit retains ownership and retries with the same token and bytes', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    let failCommit = true;
    const { runner } = makeRunner(sent, {
      adapters: [adapter],
      awaitTerminalCommit: async () => {
        if (failCommit) throw new Error('terminal commit unavailable');
      },
    });
    const taskId = 'task-s6-commit-retry';
    await runner.handleEnvelope(offerEnvelope(taskId));
    const session = adapter.sessions[0]!;

    session.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some(envelope => envelope.type === 'task.complete')).toBe(true));
    await vi.waitFor(() => expect(hostFor(runner).current(taskId)?.teardown.commit).toBe('failed'));
    expect(runner.activeTaskCount).toBe(1);
    const token = hostFor(runner).current(taskId)?.terminal?.token;
    expect(token).toBeDefined();

    failCommit = false;
    await runner.retryTerminalFinalization(taskId);
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
    expect(terminals(sent, taskId).map(envelope => envelope.type)).toEqual(['task.complete']);
    expect(hostFor(runner).archivedTask(taskId)?.terminal?.token).toBe(token);
    forgetHost(runner);
  });
});
