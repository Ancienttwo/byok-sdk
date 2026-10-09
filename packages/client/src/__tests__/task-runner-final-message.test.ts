import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type ResultDocumentTask, type TaskRunnerDeps } from '../daemon/task-runner';
import { freezeRuntimeAdapterDescriptor } from '../types';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

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

/** A stub whose descriptor declares whole-message `progress` events, as the Codex adapter does. */
function wholeMessageAdapter(): StubRuntimeAdapter {
  const adapter = new StubRuntimeAdapter('codex');
  Object.defineProperty(adapter, 'descriptor', {
    value: freezeRuntimeAdapterDescriptor({ ...adapter.descriptor, progressEventsAreMessages: true }),
  });
  return adapter;
}

async function makeRunner(
  adapter: StubRuntimeAdapter,
  sent: Envelope[],
  extra: Partial<TaskRunnerDeps> = {},
): Promise<TaskRunner> {
  return new TaskRunner({
    adapters: [adapter],
    workspaceRoot: await tmpDir('byok-final-message-workspace-'),
    deviceId: 'device-final-message',
    send: (envelope) => sent.push(envelope),
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-final-message-store-')),
    approvalRegistry: new ApprovalRegistry(),
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    ...extra,
  });
}

async function startTask(runner: TaskRunner, taskId: string, runtime: 'pi' | 'codex'): Promise<void> {
  await runner.handleEnvelope(
    createEnvelope('task.offer', { instruction: 'reply with exactly: CONSOLIDATED', runtime }, { taskId, seq: 1 }),
  );
}

async function completion(sent: Envelope[], taskId: string) {
  await vi.waitFor(() => expect(sent.some((item) => item.type === 'task.complete' && item.task_id === taskId)).toBe(true));
  const envelope = sent.find((item) => item.type === 'task.complete' && item.task_id === taskId);
  if (envelope?.type !== 'task.complete') throw new Error(`missing task.complete for ${taskId}`);
  return envelope.payload;
}

describe('TaskRunner task.complete.finalMessage (#322)', () => {
  it('the bundled Codex adapter declares whole-message progress events', () => {
    expect(new CodexAdapter().descriptor.progressEventsAreMessages).toBe(true);
  });

  it('separates the last whole message from commentary that came before it without a tool call', async () => {
    const adapter = wholeMessageAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    await startTask(runner, 'codex-commentary', 'codex');
    const session = adapter.sessions[0]!;

    session.emit({ type: 'progress', text: 'I will consolidate memory.' });
    session.emit({ type: 'progress', text: 'CONSOLIDATED' });
    session.emit({ type: 'progress', text: '\n' });
    session.emit({ type: 'usage', inputTokens: 10, outputTokens: 2 });
    session.emit({ type: 'turn_end' });

    const payload = await completion(sent, 'codex-commentary');
    expect(payload.summary).toBe('I will consolidate memory.CONSOLIDATED\n');
    // A trailing blank message does not erase the answer before it.
    expect(payload.finalMessage).toBe('CONSOLIDATED\n');
  });

  it('joins streaming deltas after the last tool interaction for a delta adapter', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    await startTask(runner, 'pi-deltas', 'pi');
    const session = adapter.sessions[0]!;

    session.emit({ type: 'progress', text: 'Let me read MEMORY.md first.' });
    session.emit({ type: 'tool_use', tool: 'read', input: { path: 'MEMORY.md' }, toolCallId: 'call-1' });
    session.emit({ type: 'tool_result', tool: 'read', output: 'notes', toolCallId: 'call-1' });
    session.emit({ type: 'progress', text: 'CONSOLI' });
    session.emit({ type: 'progress', text: 'DATED' });
    session.emit({ type: 'usage', inputTokens: 10, outputTokens: 2 });
    session.emit({ type: 'turn_end' });

    const payload = await completion(sent, 'pi-deltas');
    expect(payload.summary).toBe('Let me read MEMORY.md first.CONSOLIDATED');
    expect(payload.finalMessage).toBe('CONSOLIDATED');
  });

  it('omits finalMessage when the run ends on a tool interaction with no closing text', async () => {
    const adapter = wholeMessageAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    await startTask(runner, 'ends-on-tool', 'codex');
    const session = adapter.sessions[0]!;

    session.emit({ type: 'progress', text: 'Writing the note.' });
    session.emit({ type: 'tool_use', tool: 'file_change', input: {}, toolCallId: 'call-1' });
    session.emit({ type: 'tool_result', tool: 'file_change', output: {}, toolCallId: 'call-1' });
    session.emit({ type: 'turn_end' });

    const payload = await completion(sent, 'ends-on-tool');
    expect(payload.summary).toBe('Writing the note.');
    expect(Object.hasOwn(payload, 'finalMessage')).toBe(false);
  });

  it('omits finalMessage when every whole message is blank', async () => {
    const adapter = wholeMessageAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    await startTask(runner, 'all-blank', 'codex');
    const session = adapter.sessions[0]!;

    session.emit({ type: 'progress', text: ' ' });
    session.emit({ type: 'progress', text: '\n' });
    session.emit({ type: 'turn_end' });

    const payload = await completion(sent, 'all-blank');
    expect(payload.summary).toBe(' \n');
    expect(Object.hasOwn(payload, 'finalMessage')).toBe(false);
  });

  it('passes the same closing reply to the result-document extractor', async () => {
    const adapter = wholeMessageAdapter();
    const sent: Envelope[] = [];
    const seen: Array<{ finalOutput: string; task: ResultDocumentTask }> = [];
    const runner = await makeRunner(adapter, sent, {
      resultDocument: {
        extract: (finalOutput, task) => {
          seen.push({ finalOutput, task });
          return undefined;
        },
      },
    });
    await startTask(runner, 'extractor-input', 'codex');
    const session = adapter.sessions[0]!;

    session.emit({ type: 'progress', text: 'I will consolidate memory.' });
    session.emit({ type: 'progress', text: 'CONSOLIDATED' });
    session.emit({ type: 'turn_end' });

    const payload = await completion(sent, 'extractor-input');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.finalOutput).toBe('I will consolidate memory.CONSOLIDATED');
    expect(seen[0]!.task.finalMessage).toBe('CONSOLIDATED');
    expect(payload.finalMessage).toBe(seen[0]!.task.finalMessage);
  });
});
