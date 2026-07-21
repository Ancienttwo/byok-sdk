import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

/**
 * M4 Phase 4 (part B.3, observability): `TaskRunner.getQueueWatermarks()` —
 * the per-active-task queue-depth proxy backing the control socket's
 * `status.queueWatermarks` field (`control-protocol.ts`'s
 * `TaskQueueWatermark`). Mirrors `task-runner-approval.test.ts`/
 * `task-runner-cancel-race.test.ts`'s convention of driving `TaskRunner`
 * directly (no full daemon/control socket) for a focused unit test.
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
): Promise<{ runner: TaskRunner; approvalRegistry: ApprovalRegistry }> {
  const approvalRegistry = new ApprovalRegistry();
  const deps: TaskRunnerDeps = {
    adapters: [adapter],
    workspaceRoot: await tmpDir('byok-taskrunner-watermarks-workspace-'),
    deviceId: 'device-1',
    send: (envelope) => {
      sent.push(envelope);
    },
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-taskrunner-watermarks-store-')),
    approvalRegistry,
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    approvalTimeoutMs: 60_000,
  };
  return { runner: new TaskRunner(deps), approvalRegistry };
}

async function offerAndActivate(runner: TaskRunner, taskId: string): Promise<void> {
  await runner.handleEnvelope(
    createEnvelope('task.offer', { instruction: 'do work', policy: { mode: 'confirm' } }, { taskId, seq: 1 }),
  );
}

describe('TaskRunner.getQueueWatermarks', () => {
  it('is empty when there are no active tasks', async () => {
    const adapter = new StubRuntimeAdapter();
    const { runner } = await makeRunner(adapter, []);
    expect(runner.getQueueWatermarks()).toEqual([]);
  });

  it('starts at zero for a freshly-activated task with no progress and no pending approvals', async () => {
    const adapter = new StubRuntimeAdapter();
    const { runner } = await makeRunner(adapter, []);
    const taskId = 'task-fresh-1';
    await offerAndActivate(runner, taskId);

    expect(runner.getQueueWatermarks()).toEqual([{ taskId, progressBatcherPending: 0, pendingApprovals: 0 }]);
  });

  it('progressBatcherPending reflects events buffered but not yet flushed as task.progress', async () => {
    const adapter = new StubRuntimeAdapter();
    const { runner } = await makeRunner(adapter, []);
    const taskId = 'task-progress-1';
    await offerAndActivate(runner, taskId);

    const session = adapter.sessions[0]!;
    session.emit({ type: 'progress', text: 'a' });
    session.emit({ type: 'progress', text: 'b' });

    // pump() reads the stub session's events asynchronously — poll until
    // both have actually flowed through into the batcher.
    await vi.waitFor(() => {
      const watermark = runner.getQueueWatermarks().find((w) => w.taskId === taskId);
      expect(watermark?.progressBatcherPending).toBe(2);
    });
  });

  it('pendingApprovals counts the one dispatched approval plus anything queued behind it, and drops back down as each resolves', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const { runner, approvalRegistry } = await makeRunner(adapter, sent);
    const taskId = 'task-approvals-1';
    await offerAndActivate(runner, taskId);

    // Two concurrent requestApproval calls for the SAME task (M4 Phase 4
    // fold-in): the first dispatches, the second queues — both count.
    const outcome1 = runner.requestApproval(taskId, 'first');
    const outcome2 = runner.requestApproval(taskId, 'second');

    let watermark = runner.getQueueWatermarks().find((w) => w.taskId === taskId);
    expect(watermark?.pendingApprovals).toBe(2);

    approvalRegistry.resolve(approvalRegistry.list()[0]!.approvalId, 'approve');
    await outcome1;

    // The second is now dispatched (still just the one in flight).
    watermark = runner.getQueueWatermarks().find((w) => w.taskId === taskId);
    expect(watermark?.pendingApprovals).toBe(1);

    approvalRegistry.resolve(approvalRegistry.list()[0]!.approvalId, 'reject');
    await outcome2;

    watermark = runner.getQueueWatermarks().find((w) => w.taskId === taskId);
    expect(watermark?.pendingApprovals).toBe(0);
  });

  it('drops the task entirely once it finishes', async () => {
    const adapter = new StubRuntimeAdapter();
    const { runner } = await makeRunner(adapter, []);
    const taskId = 'task-finish-1';
    await offerAndActivate(runner, taskId);
    expect(runner.getQueueWatermarks()).toHaveLength(1);

    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(runner.getQueueWatermarks()).toEqual([]));
  });
});
