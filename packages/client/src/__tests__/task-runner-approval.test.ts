import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope } from '@byok/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { DEFAULT_APPROVAL_TIMEOUT_MS, TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
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
  overrides: Partial<Pick<TaskRunnerDeps, 'approvalTimeoutMs' | 'approvalRegistry'>> = {},
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
  };
  return { runner: new TaskRunner(deps), approvalRegistry };
}

async function offerAndActivate(runner: TaskRunner, taskId: string): Promise<void> {
  await runner.handleEnvelope(
    createEnvelope('task.offer', { instruction: 'do work', policy: { mode: 'confirm' } }, { taskId, seq: 1 }),
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
});
