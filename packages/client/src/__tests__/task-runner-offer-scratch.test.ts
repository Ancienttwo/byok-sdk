import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
import { testScratchOwner } from './fixtures/execution-scratch';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type AgentRef, type Envelope } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import type { RuntimeAdapterPrepareInput, RuntimeAdapterPrepareResult } from '../types';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';
import { AgentEgressController } from '../daemon/agent-egress-controller';

// A sessionless v3 Agent offer is a fresh one in v4, and a fresh offer carries the egress policy.
const FRESH_OFFER = { session: { mode: 'fresh' as const }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY };

// Ported from the removed git-workspace-task-runner.test.ts (#925): neither
// behaviour depends on Git workspace mode.

const blobClient: BlobResolver = {
  resolveInstruction: async (ref) => `blob:${ref}`,
  uploadArtifact: async () => ({ blobId: 'blob', contentHash: `sha256:${'0'.repeat(64)}`, contentType: 'text/plain', size: 1 }),
};

function makeDeps(sent: Envelope[], adapter: StubRuntimeAdapter): TaskRunnerDeps {
  return {
    getIngressBudget: testIngressBudget, advertisedCapabilities: advertiseEveryDeviceFlag, agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY, agentEgress: new AgentEgressController({ policy: DEFAULT_AGENT_EGRESS_POLICY }), scratchRoot: testScratchOwner(),
    adapters: [adapter],
    ...testAgentHomeDeps(),
    deviceId: 'device',
    send: (e) => sent.push(e),
    blobClient,
    approvalRegistry: new ApprovalRegistry(),
    storeDir: 'unused-store-dir',
    productId: 'product',
  };
}

function offer(taskId: string, agentRef: AgentRef): Envelope {
  return createEnvelope('task.offer', { ...FRESH_OFFER, agentRef, instruction: 'do work' }, { taskId, seq: 1 });
}

function terminal(sent: Envelope[], taskId: string): Envelope[] {
  return sent.filter((e) => e.task_id === taskId && ['task.complete', 'task.fail', 'task.cancelled'].includes(e.type));
}

/** A stub whose prepared operation takes an execution scratch for a runtime launch. */
class LaunchingAdapter extends StubRuntimeAdapter {
  override async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const base = await super.prepare(input);
    if (base.kind !== 'prepared') return base;
    return {
      ...base,
      operation: {
        ...base.operation,
        resolveRuntimeLaunch: async ({ cwd, scratch }) => ({
          scratch, kind: 'pi-rpc', command: 'unused', fixedArgs: [], cwd, env: {}, sessionCwd: cwd,
          credentialSource: 'pi-auth-store', release: async () => {},
        }),
      },
    };
  }
}

describe('TaskRunner offer scratch ownership', () => {
  it('clears the in-flight offer when an offer cleanup step throws, so a redelivery is admitted', async () => {
    const sent: Envelope[] = [];
    const adapter = new LaunchingAdapter();
    const deps = makeDeps(sent, adapter);
    const createScratch = deps.scratchRoot.create.bind(deps.scratchRoot);
    let failCleanup = true;
    vi.spyOn(deps.scratchRoot, 'create').mockImplementation(async () => {
      const scratch = await createScratch();
      return { ...scratch, release: async () => { if (failCleanup) { failCleanup = false; throw new Error('fixture projection cleanup failure'); } await scratch.release(); } };
    });
    let claimFails = true;
    deps.beforeClaim = async () => {
      if (claimFails) { claimFails = false; throw new Error('fixture commitment failure'); }
    };
    const runner = new TaskRunner(deps);
    const agentRef = freshTestAgentRef();

    await expect(runner.handleEnvelope(offer('cleanup-throws', agentRef))).rejects.toThrow('fixture projection cleanup failure');
    expect(sent.some((e) => e.type === 'task.claim')).toBe(false);

    await runner.handleEnvelope(offer('cleanup-throws', agentRef));
    expect(sent.filter((e) => e.type === 'task.claim' && e.task_id === 'cleanup-throws')).toHaveLength(1);
    expect(adapter.startCalls).toHaveLength(1);
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(terminal(sent, 'cleanup-throws').map((e) => e.type)).toEqual(['task.complete']));
  });

  it('retains scratch while a startup owner still owns the child and releases it after disposal', async () => {
    // The projection holds env or IPC references, not the key itself.
    // Removing it does not revoke a credential, so its timing stays as is.
    const sent: Envelope[] = [];
    const adapter = new LaunchingAdapter();
    const scratchReleases = vi.fn();
    const releaseStart = adapter.blockStart();
    const deps = makeDeps(sent, adapter);
    const createScratch = deps.scratchRoot.create.bind(deps.scratchRoot);
    vi.spyOn(deps.scratchRoot, 'create').mockImplementation(async () => {
      const scratch = await createScratch();
      return { ...scratch, release: async () => { scratchReleases(); await scratch.release(); } };
    });
    const runner = new TaskRunner(deps);
    const started = runner.handleEnvelope(offer('retained-projection', freshTestAgentRef()));
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));
    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'stop' }, { taskId: 'retained-projection', seq: 2 }));
    await started;

    expect(terminal(sent, 'retained-projection').map((e) => e.type)).toEqual(['task.cancelled']);
    expect(scratchReleases).not.toHaveBeenCalled();

    runner.stopAcceptingOffers();
    releaseStart();
    await runner.shutdownActiveTasks('late start returned');
    expect(adapter.sessions[0]?.closeCalled).toBe(true);
    expect(scratchReleases).toHaveBeenCalled();
  });
});
