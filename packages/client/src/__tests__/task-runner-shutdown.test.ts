import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope } from '@byok/protocol';
import type { BlobResolver } from '../daemon/blob-client';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

/**
 * M4 Phase 2 (daemon control socket `shutdown` RPC): `TaskRunner.
 * stopAcceptingOffers`/`shutdownActiveTasks` in isolation, driven directly
 * (not through a full daemon/control socket) — mirrors
 * `task-runner-cancel-race.test.ts`'s own convention for exercising
 * `TaskRunner` on its own.
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

async function makeRunner(adapter: StubRuntimeAdapter, sent: Envelope[]): Promise<TaskRunner> {
  const deps: TaskRunnerDeps = {
    adapters: [adapter],
    workspaceRoot: await tmpDir('byok-taskrunner-shutdown-workspace-'),
    deviceId: 'device-1',
    send: (envelope) => {
      sent.push(envelope);
    },
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-taskrunner-shutdown-store-')),
  };
  return new TaskRunner(deps);
}

describe('TaskRunner.stopAcceptingOffers', () => {
  it('declines (never claims) a task.offer arriving after it is called', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);

    runner.stopAcceptingOffers();
    await runner.handleEnvelope(
      createEnvelope('task.offer', { instruction: 'too late', policy: { mode: 'auto' } }, { taskId: 'task-late', seq: 1 }),
    );

    expect(adapter.startCalls).toHaveLength(0);
    expect(sent.some((e) => e.type === 'task.claim')).toBe(false);
    const decline = sent.find((e) => e.type === 'task.decline');
    expect(decline).toBeDefined();
    expect((decline?.payload as { reason: string }).reason).toMatch(/shutting down/i);
  });

  it('is idempotent — calling it twice has no additional effect', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);

    runner.stopAcceptingOffers();
    runner.stopAcceptingOffers();
    await runner.handleEnvelope(
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-1', seq: 1 }),
    );
    expect(sent.filter((e) => e.type === 'task.decline')).toHaveLength(1);
  });

  it('does not affect an offer already claimed before it was called', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);

    await runner.handleEnvelope(
      createEnvelope('task.offer', { instruction: 'already running', policy: { mode: 'auto' } }, { taskId: 'task-early', seq: 1 }),
    );
    expect(runner.activeTaskCount).toBe(1);

    runner.stopAcceptingOffers();
    expect(runner.activeTaskCount).toBe(1); // unaffected — stopAcceptingOffers only gates FUTURE offers
  });
});

describe('TaskRunner.shutdownActiveTasks', () => {
  it('best-effort interrupts the session and reports task.fail (not task.cancelled) with the given reason, retryable', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);

    await runner.handleEnvelope(
      createEnvelope('task.offer', { instruction: 'do work', policy: { mode: 'auto' } }, { taskId: 'task-1', seq: 1 }),
    );
    expect(runner.activeTaskCount).toBe(1);
    const session = adapter.sessions[0];
    expect(session).toBeDefined();

    await runner.shutdownActiveTasks('control socket shutdown (unpair)');

    expect(session?.interruptCalled).toBe(true);
    expect(runner.activeTaskCount).toBe(0);
    const fail = sent.find((e) => e.type === 'task.fail' && e.task_id === 'task-1');
    expect(fail).toBeDefined();
    expect(fail?.payload).toMatchObject({ retryable: true });
    expect((fail?.payload as { reason: string }).reason).toContain('control socket shutdown (unpair)');
    expect(sent.some((e) => e.type === 'task.cancelled')).toBe(false);
  });

  it('still reports task.fail even when session.interrupt() itself throws', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);

    await runner.handleEnvelope(
      createEnvelope('task.offer', { instruction: 'do work', policy: { mode: 'auto' } }, { taskId: 'task-1', seq: 1 }),
    );
    const session = adapter.sessions[0];
    expect(session).toBeDefined();
    session!.interrupt = async () => {
      throw new Error('interrupt boom');
    };

    await expect(runner.shutdownActiveTasks('operator')).resolves.toBeUndefined();
    expect(sent.some((e) => e.type === 'task.fail' && e.task_id === 'task-1')).toBe(true);
  });

  it('handles multiple concurrently-active tasks', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);

    await runner.handleEnvelope(
      createEnvelope('task.offer', { instruction: 'a', policy: { mode: 'auto' } }, { taskId: 'task-a', seq: 1 }),
    );
    await runner.handleEnvelope(
      createEnvelope('task.offer', { instruction: 'b', policy: { mode: 'auto' } }, { taskId: 'task-b', seq: 2 }),
    );
    expect(runner.activeTaskCount).toBe(2);

    await runner.shutdownActiveTasks('operator');

    expect(runner.activeTaskCount).toBe(0);
    expect(sent.some((e) => e.type === 'task.fail' && e.task_id === 'task-a')).toBe(true);
    expect(sent.some((e) => e.type === 'task.fail' && e.task_id === 'task-b')).toBe(true);
  });

  it('is a no-op when there are no active tasks', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);

    await expect(runner.shutdownActiveTasks('operator')).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});
