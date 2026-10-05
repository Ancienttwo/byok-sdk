import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

describe('TaskRunner shutdown admission/start ownership barrier', () => {
  it('cannot report successful shutdown before a claimed startup owner has been registered', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-shutdown-start-'));
    const sent: Envelope[] = [];
    const adapter = new StubRuntimeAdapter();
    const release = adapter.blockStart();
    const runner = new TaskRunner({
      adapters: [adapter], deviceId: 'shutdown-device', workspaceRoot: path.join(dir, 'workspace'),
      send: event => { sent.push(event); },
      blobClient: {
        resolveInstruction: async () => { throw new Error('unexpected blob resolution'); },
        uploadArtifact: async () => { throw new Error('unexpected upload'); },
      },
      sessionWorkspaces: new SessionWorkspaceStore(path.join(dir, 'sessions')),
      approvalRegistry: new ApprovalRegistry(), storeDir: dir, productId: 'shutdown-start',
    });
    const offered = runner.handleEnvelope(createEnvelope('task.offer', {
      instruction: 'blocked startup', policy: { mode: 'auto' },
    }, { taskId: 'starting-task', seq: 1 }));
    try {
      await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));
      runner.stopAcceptingOffers();
      const shutdown = runner.shutdownActiveTasks('operator');
      // This runtime deliberately has not returned a receipt yet. Shutdown
      // must surface that retained ownership, never succeed with a live start.
      await expect(shutdown).rejects.toMatchObject({ name: 'RuntimeDisposalFailure' });
      await offered;
      expect(runner.activeTaskCount).toBe(1);
      expect(sent.filter(event => event.type === 'task.fail')).toHaveLength(1);
      expect(sent.find(event => event.type === 'task.fail')?.payload).toMatchObject({ retryable: true });
    } finally {
      release(); await offered;
      await new Promise<void>(resolve => setImmediate(resolve));
      await runner.shutdownActiveTasks('retry after startup receipt');
      expect(adapter.sessions[0]?.closeCalled).toBe(true);
      expect(runner.activeTaskCount).toBe(0);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
