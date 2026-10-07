import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
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
  it.each((['claude', 'codex', 'pi'] as const).flatMap(runtime =>
    (['idle', 'spill'] as const).map(stage => ({ runtime, stage }))))('$runtime retains interrupt usage at $stage without trailing output or errors', async ({ runtime, stage }) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-cancel-usage-'));
    const store = new SessionWorkspaceStore(path.join(dir, 'sessions'));
    dirs.push({ dir, store });
    const adapter = new StubRuntimeAdapter(runtime);
    const diagnostic = vi.spyOn(console, 'error');
    const sent: Envelope[] = [];
    let enteredUpload!: () => void;
    const uploading = new Promise<void>(resolve => { enteredUpload = resolve; });
    const runner = new TaskRunner({
      adapters: [adapter], workspaceRoot: path.join(dir, 'workspace'),
      deviceId: 'cancel-usage-device', send: event => { sent.push(event); },
      blobClient: {
        resolveInstruction: async () => { throw new Error('unexpected blob resolution'); },
        uploadArtifact: async (_content, _type, options) => {
          if (stage !== 'spill' || options?.signal === undefined) throw new Error('unexpected upload');
          enteredUpload();
          return new Promise<never>((_, reject) => options.signal!.addEventListener('abort', () => reject(new Error('cancelled spill upload')), { once: true }));
        },
      },
      sessionWorkspaces: store,
      approvalRegistry: new ApprovalRegistry(), storeDir: dir, productId: 'cancel-usage',
      localAgentRelease: Object.freeze({ version: '0.24.0-rc.1' }),
      shutdownInterruptTimeoutMs: 20,
      maxInlineEventBytes: 4096,
    });
    await runner.handleEnvelope(createEnvelope('task.offer', {
      instruction: 'cancel while metering settles', runtime,
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
      if (stage === 'spill') {
        session.emit({ type: 'tool_result', tool: 'bash', toolCallId: 'large-output', output: 'x'.repeat(16000) });
        await uploading;
      }
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
      expect(diagnostic).not.toHaveBeenCalled();
      expect(runner.activeTaskCount).toBe(0);
    } finally { await runner.shutdownActiveTasks('test cleanup'); diagnostic.mockRestore(); }
  });
});
