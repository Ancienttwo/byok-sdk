import type { RuntimeTaskInput } from '../types';
import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
import { testScratchOwner } from "./fixtures/execution-scratch";
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import type { RuntimeAdapter } from '../types';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';
import { AgentEgressController } from '../daemon/agent-egress-controller';

// A sessionless v3 Agent offer is a fresh one in v4, and a fresh offer carries the egress policy.
const FRESH_OFFER = { session: { mode: 'fresh' as const }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY };

/**
 * M4 (additive-minor, `task.approval_resolved` — see `messages.ts`'s doc
 * comment on `TaskApprovalResolvedPayloadSchema` and `task-runner.ts`'s
 * `sendApprovalResolved` for the full rationale): the daemon-side send
 * decision in isolation, mirroring `task-runner-approval.test.ts`'s own
 * convention of driving `TaskRunner` directly (no control socket, no real
 * connection) via `requestApproval`/`handleEnvelope` and a plain `sent`
 * array — `getServerCapabilities` is just a stub function here, exactly like
 * every other `TaskRunnerDeps` field this file's sibling stubs.
 *
 * A full end-to-end pass (real daemon, real `@byok-sdk/server`, real capability
 * negotiation over a real handshake, real local-CLI-equivalent resolve) is
 * `real-server-approval-resolved-e2e.test.ts`.
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
  adapter: RuntimeAdapter,
  sent: Envelope[],
  overrides: Partial<Pick<TaskRunnerDeps, 'approvalTimeoutMs' | 'approvalRegistry' | 'getServerCapabilities'>> = {},
): Promise<{ runner: TaskRunner; approvalRegistry: ApprovalRegistry }> {
  const approvalRegistry = overrides.approvalRegistry ?? new ApprovalRegistry();
  const deps: TaskRunnerDeps = { getIngressBudget: testIngressBudget, advertisedCapabilities: advertiseEveryDeviceFlag, agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY, agentEgress: new AgentEgressController({ policy: DEFAULT_AGENT_EGRESS_POLICY }), scratchRoot: testScratchOwner(),
    adapters: [adapter],
    ...testAgentHomeDeps(),
    deviceId: 'device-1',
    send: (envelope) => {
      sent.push(envelope);
    },
    blobClient: unusedBlobClient,
    approvalRegistry,
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    approvalTimeoutMs: overrides.approvalTimeoutMs,
    getServerCapabilities: overrides.getServerCapabilities,
  };
  return { runner: new TaskRunner(deps), approvalRegistry };
}

async function offerAndActivate(runner: TaskRunner, taskId: string): Promise<void> {
  await runner.handleEnvelope(
    createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'do gated work' }, { taskId, seq: 1 }),
  );
}

function findApprovalResolved(sent: Envelope[]) {
  const envelope = sent.find((e) => e.type === 'task.approval_resolved');
  if (envelope?.type !== 'task.approval_resolved') return undefined;
  return envelope;
}

describe('TaskRunner: task.approval_resolved send decision', () => {
  it('local approve (approvalRegistry.resolve directly, simulating the control-socket approvals.resolve RPC) sends task.approval_resolved with the right payload', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent);
    const taskId = 'task-local-approve-1';
    await offerAndActivate(runner, taskId);

    const outcomePromise = runner.requestApproval(taskId, 'Bash: echo hi');
    const pending = approvalRegistry.list();
    const approvalId = pending[0]!.approvalId;
    // No `origin` arg — mirrors what create-daemon.ts's real
    // 'approvals.resolve' control-socket handler passes, defaulting to 'local'.
    approvalRegistry.resolve(approvalId, 'approve');
    await expect(outcomePromise).resolves.toEqual({ approved: true, reason: undefined });

    const resolved = findApprovalResolved(sent);
    expect(resolved).toBeDefined();
    if (resolved === undefined) throw new Error('unreachable');
    expect(resolved.task_id).toBe(taskId);
    expect(resolved.payload).toEqual({
      approvalId,
      decision: 'approve',
      resolvedBy: 'local',
      at: resolved.payload.at,
    });
    expect(() => new Date(resolved.payload.at).toISOString()).not.toThrow();
  });

  it('local reject sends task.approval_resolved with decision: reject', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent);
    const taskId = 'task-local-reject-1';
    await offerAndActivate(runner, taskId);

    const outcomePromise = runner.requestApproval(taskId, 'Bash: rm -rf /');
    const pending = approvalRegistry.list();
    approvalRegistry.resolve(pending[0]!.approvalId, 'reject', 'operator declined via CLI');
    await outcomePromise;

    const resolved = findApprovalResolved(sent);
    expect(resolved?.payload.decision).toBe('reject');
    expect(resolved?.payload.resolvedBy).toBe('local');
  });

  it('wire-resolved (server-sent task.approve, resolved in the registry as wire) does NOT send task.approval_resolved', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent);
    const taskId = 'task-wire-1';
    await offerAndActivate(runner, taskId);
    const session = adapter.sessions[0]!;

    // The session asks through its approval channel; the server's own wire
    // task.approve then resolves that registry entry with origin 'wire'.
    const outcomePromise = session.requestApproval('Bash: echo hi');
    const approvalId = approvalRegistry.list()[0]!.approvalId;
    await runner.handleEnvelope(createEnvelope('task.approve', { approvalId }, { taskId, seq: 0 }));
    await outcomePromise;

    expect(session.approvalResults).toEqual([{ approved: true }]);
    expect(sent.some((e) => e.type === 'task.approval_resolved')).toBe(false);
  });

  it('wire-resolved reject also does NOT send task.approval_resolved', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent);
    const taskId = 'task-wire-2';
    await offerAndActivate(runner, taskId);

    const outcomePromise = adapter.sessions[0]!.requestApproval('Write: /etc/shadow');
    const approvalId = approvalRegistry.list()[0]!.approvalId;
    await runner.handleEnvelope(createEnvelope('task.reject', { reason: 'server said no', approvalId }, { taskId, seq: 0 }));
    await outcomePromise;

    expect(sent.some((e) => e.type === 'task.approval_resolved')).toBe(false);
  });

  it('an unanswered approval that force-resolves via timeout is itself a local resolution: sends task.approval_resolved with decision: reject', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner } = await makeRunner(adapter, sent, {
      approvalTimeoutMs: 20,
    });
    const taskId = 'task-timeout-1';
    await offerAndActivate(runner, taskId);

    const outcome = await runner.requestApproval(taskId, 'Bash: sleep forever');
    expect(outcome.approved).toBe(false);

    const resolved = findApprovalResolved(sent);
    expect(resolved).toBeDefined();
    expect(resolved?.payload.decision).toBe('reject');
    expect(resolved?.payload.resolvedBy).toBe('local');
  });

  it.each([
    ['getServerCapabilities not supplied', undefined],
    ['a server list without any approval flag', () => ['steer', 'blob-upload']],
  ] as const)('a local resolution sends task.approval_resolved whatever the server advertises (%s): it is wire v4 baseline', async (_label, getServerCapabilities) => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent, getServerCapabilities === undefined ? {} : { getServerCapabilities });
    const taskId = 'task-any-server-1';
    await offerAndActivate(runner, taskId);

    const outcomePromise = runner.requestApproval(taskId, 'Bash: echo hi');
    const pending = approvalRegistry.list();
    approvalRegistry.resolve(pending[0]!.approvalId, 'approve');
    await outcomePromise;

    expect(findApprovalResolved(sent)?.payload).toMatchObject({ approvalId: pending[0]!.approvalId, decision: 'approve', resolvedBy: 'local' });
  });

  it('ordering: task.approval_resolved is queued before any progress the resumed session goes on to produce', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent);
    const taskId = 'task-ordering-1';
    await offerAndActivate(runner, taskId);

    const outcomePromise = runner.requestApproval(taskId, 'Bash: echo hi');
    const pending = approvalRegistry.list();
    approvalRegistry.resolve(pending[0]!.approvalId, 'approve');
    await outcomePromise;

    // The resumed session immediately produces more progress and completes —
    // simulating the runtime turn continuing right after being unblocked.
    adapter.sessions[0]!.emit({ type: 'progress', text: 'resuming after local approval' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(sent.some((e) => e.type === 'task.complete')).toBe(true));

    const resolvedIndex = sent.findIndex((e) => e.type === 'task.approval_resolved');
    const completeIndex = sent.findIndex((e) => e.type === 'task.complete');
    expect(resolvedIndex).toBeGreaterThanOrEqual(0);
    expect(completeIndex).toBeGreaterThan(resolvedIndex);
  });
});
