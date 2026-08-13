import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { RuntimeExecutionFailure, RUNTIME_ADAPTER_CONTRACT_VIOLATION_REASON } from '../runtime-failure';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

async function temporaryDirectory(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('TaskRunner typed runtime failure projection', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    await server.close();
  });

  async function start(adapter: StubRuntimeAdapter): Promise<void> {
    daemon = createDaemonWithAdapters(
      {
        productName: 'Runtime failure test',
        productId: 'runtime-failure-test',
        serverUrl: server.url,
        workspaceRoot: await temporaryDirectory('byok-runtime-failure-workspace-'),
        storeDir: await temporaryDirectory('byok-runtime-failure-store-'),
      },
      [adapter],
    );
    await daemon.pair('pairing-code');
    await daemon.start();
  }

  async function offer(taskId: string): Promise<void> {
    server.send(createEnvelope('task.offer', { instruction: 'run', policy: { mode: 'auto' } }, { taskId, seq: server.nextSeq() }));
    await server.waitFor((event) => event.type === 'task.claim' && event.task_id === taskId);
  }

  it('projects typed start infrastructure loss as retryable', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    adapter.startError = new RuntimeExecutionFailure({
      phase: 'start',
      category: 'infrastructure',
      retry: 'retryable',
      reason: 'runtime process could not be spawned',
    });
    await start(adapter);
    await offer('typed-start-infrastructure');
    const failed = await server.waitFor((event) => event.type === 'task.fail' && event.task_id === 'typed-start-infrastructure');
    expect(failed.payload).toEqual({ reason: 'runtime process could not be spawned', retryable: true });
  });

  it('projects typed run semantic failure as non-retryable after forwarding diagnostics', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    await start(adapter);
    await offer('typed-run-semantic');
    await server.waitFor((event) => event.type === 'task.started' && event.task_id === 'typed-run-semantic');
    expect(adapter.sessions).toHaveLength(1);
    adapter.sessions[0]!.emit({ type: 'error', message: 'provider diagnostic' });
    adapter.sessions[0]!.fail(new RuntimeExecutionFailure({
      phase: 'run',
      category: 'semantic',
      retry: 'non-retryable',
      reason: 'runtime reported terminal task failure',
    }));

    const failed = await server.waitFor((event) => event.type === 'task.fail' && event.task_id === 'typed-run-semantic');
    expect(failed.payload).toEqual({ reason: 'runtime reported terminal task failure', retryable: false });
    const progress = await server.waitFor((event) => event.type === 'task.progress' && event.task_id === 'typed-run-semantic');
    expect(progress.payload).toMatchObject({ events: [{ type: 'error', message: 'provider diagnostic' }] });
  });

  it('publishes exactly one terminal when a typed failure is followed by queue close and a late success frame', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    await start(adapter);
    await offer('typed-run-race');
    await server.waitFor((event) => event.type === 'task.started' && event.task_id === 'typed-run-race');
    expect(adapter.sessions).toHaveLength(1);
    const session = adapter.sessions[0]!;
    session.fail(new RuntimeExecutionFailure({
      phase: 'run',
      category: 'authority',
      retry: 'non-retryable',
      reason: 'authoritative terminal mismatch',
    }));
    session.endAbruptly();
    session.emit({ type: 'turn_end' });

    await server.waitFor((event) => event.type === 'task.fail' && event.task_id === 'typed-run-race');
    expect(server.received.filter((event) => event.task_id === 'typed-run-race' && (
      event.type === 'task.fail' || event.type === 'task.complete' || event.type === 'task.cancelled'
    ))).toHaveLength(1);
  });

  it('rejects an untyped run throw as a stable non-retryable adapter-contract violation', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await start(adapter);
    await offer('untyped-run');
    await server.waitFor((event) => event.type === 'task.started' && event.task_id === 'untyped-run');
    expect(adapter.sessions).toHaveLength(1);
    adapter.sessions[0]!.fail(new Error('temporary timeout please retry'));

    const failed = await server.waitFor((event) => event.type === 'task.fail' && event.task_id === 'untyped-run');
    expect(failed.payload).toEqual({
      reason: RUNTIME_ADAPTER_CONTRACT_VIOLATION_REASON.run,
      retryable: false,
    });
    expect(JSON.stringify(failed.payload)).not.toContain('temporary timeout');
    expect(diagnostic).toHaveBeenCalledOnce();
    diagnostic.mockRestore();
  });

  it('rejects clean stream completion without terminal authority as a non-retryable contract violation', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await start(adapter);
    await offer('clean-end-without-success');
    await server.waitFor((event) => event.type === 'task.started' && event.task_id === 'clean-end-without-success');
    expect(adapter.sessions).toHaveLength(1);
    adapter.sessions[0]!.endAbruptly();

    const failed = await server.waitFor((event) => event.type === 'task.fail' && event.task_id === 'clean-end-without-success');
    expect(failed.payload).toEqual({
      reason: RUNTIME_ADAPTER_CONTRACT_VIOLATION_REASON.run,
      retryable: false,
    });
    expect(diagnostic).toHaveBeenCalledOnce();
    diagnostic.mockRestore();
  });
});
