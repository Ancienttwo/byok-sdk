import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope, type RuntimeId } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

const dirs: Array<{ dir: string; store: SessionWorkspaceStore }> = [];
afterEach(async () => {
  for (const { dir, store } of dirs.splice(0)) {
    await store.get('cleanup-barrier'); // queued record() writes must finish before deleting their directory
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('TaskRunner metering at the cancellation boundary', () => {
  it.each(['claude', 'codex', 'pi'] as const)('%s retains usage delivered by interrupt without leaking trailing output or errors', async (runtime: RuntimeId) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-cancel-usage-'));
    const store = new SessionWorkspaceStore(path.join(dir, 'sessions'));
    dirs.push({ dir, store });
    const adapter = new StubRuntimeAdapter(runtime);
    const sent: Envelope[] = [];
    const runner = new TaskRunner({
      adapters: [adapter], workspaceRoot: path.join(dir, 'workspace'),
      deviceId: 'cancel-usage-device', send: event => { sent.push(event); },
      blobClient: {
        resolveInstruction: async () => { throw new Error('unexpected blob resolution'); },
        uploadArtifact: async () => { throw new Error('unexpected upload'); },
      },
      sessionWorkspaces: store,
      approvalRegistry: new ApprovalRegistry(), storeDir: dir, productId: 'cancel-usage',
      localAgentRelease: Object.freeze({ version: '0.24.0-rc.1' }),
      shutdownInterruptTimeoutMs: 20,
    });
    await runner.handleEnvelope(createEnvelope('task.offer', {
      instruction: 'cancel while metering settles', runtime, policy: { mode: 'auto' },
    }, { taskId: 'metered-task', seq: 1 }));
    const session = adapter.sessions[0]!;
    // Trace recorded inside the real interrupt boundary, before its receipt:
    // a tool closes first; the provider usage arrives afterward.
    const trace: string[] = [];
    session.interrupt = async () => {
      trace.push('interrupt');
      session.emit({ type: 'tool_result', tool: 'bash', toolCallId: 'pending-tool', output: 'interrupted' });
      session.emit({ type: 'usage', inputTokens: 123, outputTokens: 17 });
      session.emit({ type: 'usage', contextSource: 'estimate', contextTokens: 999 });
      session.emit({ type: 'error', message: 'late cancellation diagnostic' });
      session.emit({ type: 'turn_end' });
    };
    const close = session.close.bind(session);
    session.close = async () => { trace.push('close'); await close(); };
    try {
      await Promise.all([1, 2].map(seq => runner.handleEnvelope(createEnvelope('task.cancel', {
        reason: 'operator',
      }, { taskId: 'metered-task', seq }))));
      await runner.handleEnvelope(createEnvelope('task.cancel', {}, { taskId: 'metered-task', seq: 3 }));
      const terminal = sent.filter(event => ['task.complete', 'task.fail', 'task.cancelled'].includes(event.type));
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ type: 'task.cancelled', payload: {
        usage: { runtime, promptTokens: 123, completionTokens: 17 },
      } });
      expect(sent.filter(event => event.type === 'task.progress')).toHaveLength(0);
      expect(trace).toEqual(['interrupt', 'close']);
      expect(runner.activeTaskCount).toBe(0);
    } finally { await runner.shutdownActiveTasks('test cleanup'); }
  });
});
