import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { RuntimeExecutionFailure } from '../runtime-failure';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

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
  withRelease = true,
): Promise<TaskRunner> {
  const release = Object.freeze({ version: '0.6.0' });
  const deps: TaskRunnerDeps = {
    adapters: [adapter],
    workspaceRoot: await tmpDir('byok-terminal-usage-workspace-'),
    deviceId: 'device-terminal-usage',
    send: (envelope) => sent.push(envelope),
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-terminal-usage-store-')),
    approvalRegistry: new ApprovalRegistry(),
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    ...(withRelease ? { localAgentRelease: release } : {}),
  };
  return new TaskRunner(deps);
}

async function startTask(runner: TaskRunner, taskId: string, runtime: 'pi' | 'claude' | 'codex'): Promise<void> {
  await runner.handleEnvelope(
    createEnvelope(
      'task.offer',
      {
        instruction: 'observe terminal usage',
        policy: { mode: 'auto' },
        runtime,
        // This requested selection must NOT become provider/model terminal
        // telemetry. The adapter did not observe either fact.
        dispatchSelection: runtime === 'codex'
          ? { lane: 'subscription', runtimeId: 'codex', providerId: null, modelId: 'gpt-5' }
          : undefined,
      },
      { taskId, seq: 1 },
    ),
  );
}

function terminal(sent: Envelope[], taskId: string, type: 'task.complete' | 'task.fail' | 'task.cancelled') {
  const envelope = sent.find((candidate) => candidate.task_id === taskId && candidate.type === type);
  if (!envelope || envelope.type !== type) throw new Error(`missing ${type} terminal for ${taskId}`);
  return envelope;
}

describe('TaskRunner terminal inference usage projection', () => {
  it('projects the last Codex usage observation into task.complete without echoing requested provider/model', async () => {
    const adapter = new StubRuntimeAdapter('codex');
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    const taskId = 'terminal-complete-last-observed';
    await startTask(runner, taskId, 'codex');
    const session = adapter.sessions[0]!;

    session.emit({ type: 'usage', inputTokens: 100, outputTokens: 20 });
    session.emit({ type: 'usage', inputTokens: 0, outputTokens: 5 });
    session.emit({ type: 'turn_end' });

    await vi.waitFor(() => expect(sent.some((item) => item.type === 'task.complete' && item.task_id === taskId)).toBe(true));
    const completed = terminal(sent, taskId, 'task.complete');
    expect(completed.payload.usage).toMatchObject({
      runtime: 'codex',
      promptTokens: 0,
      completionTokens: 5,
      clientVersion: '0.6.0',
    });
    expect(completed.payload.usage?.reportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/);
    expect(completed.payload.usage?.durationMs).toEqual(expect.any(Number));
    expect(completed.payload.usage && Object.hasOwn(completed.payload.usage, 'provider')).toBe(false);
    expect(completed.payload.usage && Object.hasOwn(completed.payload.usage, 'model')).toBe(false);
  });

  it('preserves a final Claude observation on task.fail', async () => {
    const adapter = new StubRuntimeAdapter('claude');
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    const taskId = 'terminal-fail-observed';
    await startTask(runner, taskId, 'claude');
    const session = adapter.sessions[0]!;

    session.emit({ type: 'usage', inputTokens: 42 });
    session.fail(new RuntimeExecutionFailure({
      phase: 'run', category: 'semantic', retry: 'non-retryable', reason: 'runtime ended with failure',
    }));

    await vi.waitFor(() => expect(sent.some((item) => item.type === 'task.fail' && item.task_id === taskId)).toBe(true));
    const failed = terminal(sent, taskId, 'task.fail');
    expect(failed.payload.usage).toMatchObject({ runtime: 'claude', promptTokens: 42, clientVersion: '0.6.0' });
    expect(failed.payload.usage && Object.hasOwn(failed.payload.usage, 'completionTokens')).toBe(false);
  });

  it('omits usage for a cancelled Pi task without a native usage observation', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    const taskId = 'terminal-cancelled-pi';
    await startTask(runner, taskId, 'pi');

    await runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'operator requested' }, { taskId, seq: 2 }));
    const cancelled = terminal(sent, taskId, 'task.cancelled');
    expect(cancelled.payload.usage).toBeUndefined();
  });

  it('keeps terminal usage omitted when no immutable release identity was composed', async () => {
    const adapter = new StubRuntimeAdapter('codex');
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent, false);
    const taskId = 'terminal-legacy-omission';
    await startTask(runner, taskId, 'codex');
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    await vi.waitFor(() => expect(sent.some((item) => item.type === 'task.complete' && item.task_id === taskId)).toBe(true));
    const completed = terminal(sent, taskId, 'task.complete');
    expect(Object.hasOwn(completed.payload, 'usage')).toBe(false);
  });

  it('uses create-daemon’s U4a-frozen localAgentRelease.version, not a second identity source', async () => {
    const server = await TestServer.start();
    let daemon: Daemon | undefined;
    try {
      const adapter = new StubRuntimeAdapter('codex');
      daemon = createDaemonWithAdapters(
        {
          localAgentRelease: { version: '0.6.0' },
          productName: 'Terminal usage composition test',
          productId: 'terminal-usage-composition-test',
          serverUrl: server.url,
          workspaceRoot: await tmpDir('byok-terminal-usage-daemon-workspace-'),
          storeDir: await tmpDir('byok-terminal-usage-daemon-store-'),
        },
        [adapter],
      );
      await daemon.pair('pairing-code');
      await daemon.start();
      const taskId = 'terminal-composition-release-identity';
      server.send(createEnvelope(
        'task.offer',
        { instruction: 'finish', policy: { mode: 'auto' }, runtime: 'codex' },
        { taskId, seq: server.nextSeq() },
      ));
      await server.waitFor((event) => event.type === 'task.started' && event.task_id === taskId);
      adapter.sessions[0]!.emit({ type: 'usage', inputTokens: 7, outputTokens: 3 });
      adapter.sessions[0]!.emit({ type: 'turn_end' });
      const completed = await server.waitFor((event) => event.type === 'task.complete' && event.task_id === taskId);
      expect(completed.type).toBe('task.complete');
      if (completed.type !== 'task.complete') throw new Error('expected task.complete');
      expect(completed.payload.usage).toMatchObject({ runtime: 'codex', clientVersion: '0.6.0' });
    } finally {
      await daemon?.stop();
      await server.close();
    }
  });
});
