// #1099 S3: production wiring proof for the offer/admission reducer.
//
// The existing `handle-offer-characterization` suite remains the behavioral
// oracle. This file only adds the seam the oracle cannot see: the per-runner
// host recorded the same decline/claim boundary the wire saw.
import { describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { ApprovalRegistry } from '../daemon/approvals';
import { hostFor, forgetHost } from '../daemon/task-runner/host';
import { FRESH_OFFER, freshOfferRunnerDeps } from './fixtures/fresh-offer';
import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
import { testScratchOwner } from './fixtures/execution-scratch';
import { testIngressBudget } from './fixtures/activity-ingress';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import type { BlobResolver } from '../daemon/blob-client';

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => { throw new Error('not used in this test'); },
  uploadArtifact: async () => { throw new Error('not used in this test'); },
};

function makeRunner(sent: Envelope[], overrides: Partial<TaskRunnerDeps> = {}): TaskRunner {
  return new TaskRunner({
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
  });
}

async function offer(runner: TaskRunner, taskId: string, payload: Record<string, unknown> = {}): Promise<void> {
  await runner.handleEnvelope(createEnvelope(
    'task.offer',
    { agentRef: freshTestAgentRef(), instruction: 'x', ...FRESH_OFFER, ...payload },
    { taskId, seq: 1 },
  ));
}

describe('TaskRunner offer/admission host wiring (S3)', () => {
  it('records a limits decline and sends exactly one task.decline', async () => {
    const sent: Envelope[] = [];
    const runner = makeRunner(sent);
    const taskId = 'task-s3-limits-1';
    await offer(runner, taskId, { limits: { maxTokens: 4000 } });

    const declines = sent.filter(envelope => envelope.type === 'task.decline');
    expect(declines).toHaveLength(1);
    const payload = declines[0]!.payload as { reason: string; retryable: boolean };
    expect(payload.retryable).toBe(true);

    const archived = hostFor(runner).archivedTask(taskId);
    expect(archived?.phase).toBe('declined');
    expect(archived?.admission.stage).toBe('limits');
    expect(archived?.terminal?.reason).toBe(payload.reason);
    expect(archived?.terminal?.retryable).toBe(true);
    expect(hostFor(runner).current(taskId)).toBeUndefined();
    expect(sent.some(envelope => envelope.type === 'task.claim')).toBe(false);
    forgetHost(runner);
  });

  it('declines a cancel-before-offer at checkpoint 1 through the reducer', async () => {
    const sent: Envelope[] = [];
    const runner = makeRunner(sent);
    const taskId = 'task-s3-cancel-before-offer';
    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'stop' }, { taskId, seq: 1 }));
    await offer(runner, taskId);

    const decline = sent.find(envelope => envelope.type === 'task.decline');
    expect(decline).toBeDefined();
    expect((decline!.payload as { reason: string }).reason).toBe('cancelled before claim: stop');
    expect(sent.some(envelope => envelope.type === 'task.claim')).toBe(false);

    const archived = hostFor(runner).archivedTask(taskId);
    expect(archived?.phase).toBe('declined');
    expect(archived?.terminal?.reason).toBe('cancelled before claim: stop');
    forgetHost(runner);
  });

  it('records an offer-shape decline from readOfferRequest', async () => {
    const sent: Envelope[] = [];
    // No agent egress policy on this runner: the fresh offer's egress policy is refused.
    const runner = makeRunner(sent, { agentEgressPolicy: undefined });
    const taskId = 'task-s3-egress-1';
    await offer(runner, taskId);

    const decline = sent.find(envelope => envelope.type === 'task.decline');
    expect(decline).toBeDefined();
    const archived = hostFor(runner).archivedTask(taskId);
    expect(archived?.phase).toBe('declined');
    expect(archived?.terminal?.reason).toBe('Agent egress offer policy is not exactly enabled by this daemon');
    expect(hostFor(runner).current(taskId)).toBeUndefined();
    forgetHost(runner);
  });

  it('advances through claim/start and leaves the task running in the reducer (S4 boundary)', async () => {
    const sent: Envelope[] = [];
    const runner = makeRunner(sent);
    const taskId = 'task-s4-started-1';
    await offer(runner, taskId);

    expect(sent.some(envelope => envelope.type === 'task.claim')).toBe(true);
    expect(sent.some(envelope => envelope.type === 'task.started')).toBe(true);
    const current = hostFor(runner).current(taskId);
    expect(current?.phase).toBe('running');
    expect(current?.claim.journaled).toBe(true);
    expect(current?.claim.sent).toBe(true);
    expect(current?.execution?.sessionRef).toBe('stub-session-1');
    expect(current?.startup.owner).toBe('active');
    forgetHost(runner);
  });
});
