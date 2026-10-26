import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
import { testScratchOwner } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { RuntimeDisposalFailure } from '../runtime-failure';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function makeRunner(overrides: Partial<Pick<TaskRunnerDeps, 'awaitTerminalCommit' | 'onRuntimeDisposalFailure'>> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-close-receipt-'));
  directories.push(directory);
  const adapter = new StubRuntimeAdapter();
  const sent: Envelope[] = [];
  const runner = new TaskRunner({ getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [adapter],
    ...testAgentHomeDeps(),
    deviceId: 'close-receipt-device',
    send: envelope => { sent.push(envelope); },
    blobClient: {
      resolveInstruction: async () => { throw new Error('unused'); },
      uploadArtifact: async () => { throw new Error('unused'); },
    },
    approvalRegistry: new ApprovalRegistry(),
    storeDir: directory,
    productId: 'close-receipt-product',
    ...overrides,
  });
  const taskId = 'close-receipt-task';
  await runner.handleEnvelope(createEnvelope('task.offer_for_agent', { agentRef: freshTestAgentRef(),  instruction: 'run' }, { taskId, seq: 1 }));
  const session = adapter.sessions[0]!;
  const terminals = () => sent.filter(event => ['task.complete', 'task.fail', 'task.cancelled'].includes(event.type));
  return { runner, session, taskId, terminals };
}

describe('TaskRunner active Session close receipt', () => {
  it('shares a pending completion receipt with cancel and shutdown, then waits for terminal commit', async () => {
    const closeStarted = deferred();
    const closeGate = deferred();
    const commitGate = deferred();
    const awaitTerminalCommit = vi.fn(() => commitGate.promise);
    const { runner, session, taskId, terminals } = await makeRunner({ awaitTerminalCommit });
    const originalClose = session.close.bind(session);
    let closeCalls = 0;
    session.close = async () => {
      closeCalls += 1;
      closeStarted.resolve();
      await closeGate.promise;
      await originalClose();
    };
    let cancel: Promise<void> | undefined;
    let shutdown: Promise<void> | undefined;
    try {
      session.emit({ type: 'turn_end' });
      await closeStarted.promise;
      cancel = runner.handleEnvelope(createEnvelope('task.cancel', { reason: 'operator' }, { taskId, seq: 2 }));
      shutdown = runner.shutdownActiveTasks('operator');
      expect(closeCalls).toBe(1);
      expect(runner.activeTaskCount).toBe(1);
      expect(awaitTerminalCommit).not.toHaveBeenCalled();
      expect(terminals().map(event => event.type)).toEqual(['task.complete']);

      closeGate.resolve();
      await vi.waitFor(() => expect(awaitTerminalCommit).toHaveBeenCalledTimes(1));
      expect(runner.activeTaskCount).toBe(1);
      commitGate.resolve();
      await Promise.all([cancel, shutdown]);
      expect(closeCalls).toBe(1);
      expect(runner.activeTaskCount).toBe(0);
      expect(terminals().map(event => event.type)).toEqual(['task.complete']);
    } finally {
      closeGate.resolve();
      commitGate.resolve();
      await Promise.all([cancel, shutdown]);
    }
  });

  it.each(['typed', 'untyped'] as const)('reports a %s synchronous close failure and retries the original completion', async kind => {
    const evidence: Array<{ taskId: string; stage: string; reason: string }> = [];
    const awaitTerminalCommit = vi.fn(async () => {});
    const { runner, session, taskId, terminals } = await makeRunner({
      awaitTerminalCommit,
      onRuntimeDisposalFailure: event => { evidence.push(event); },
    });
    const originalClose = session.close.bind(session);
    let closeCalls = 0;
    let allowClose = false;
    session.close = () => {
      closeCalls += 1;
      if (!allowClose) {
        if (kind === 'typed') throw new RuntimeDisposalFailure({ stage: 'cleanup', reason: 'receipt fixture failed' });
        throw new Error('receipt fixture failed');
      }
      return originalClose();
    };
    try {
      session.emit({ type: 'turn_end' });
      await vi.waitFor(() => expect(evidence).toHaveLength(1));
      expect(closeCalls).toBe(1);
      expect(evidence[0]).toMatchObject({ taskId, stage: kind === 'typed' ? 'cleanup' : 'quiescence' });
      expect(runner.activeTaskCount).toBe(1);
      expect(awaitTerminalCommit).not.toHaveBeenCalled();
      expect(terminals().map(event => event.type)).toEqual(['task.complete']);

      allowClose = true;
      await runner.retryTerminalFinalization(taskId);
      expect(closeCalls).toBe(2);
      expect(awaitTerminalCommit).toHaveBeenCalledTimes(1);
      expect(runner.activeTaskCount).toBe(0);
      expect(terminals().map(event => event.type)).toEqual(['task.complete']);
    } finally {
      allowClose = true;
      await runner.retryTerminalFinalization(taskId);
    }
  });
});
