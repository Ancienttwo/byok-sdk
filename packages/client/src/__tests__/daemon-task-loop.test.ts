import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { PolicyUnsupportedError } from '../types';
import { TestServer } from './fixtures/test-server';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('daemon task loop (stub adapter + in-process WS server)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    await server.close();
  });

  async function setupDaemon(
    adapter: StubRuntimeAdapter,
    configOverrides: Partial<Parameters<typeof createDaemonWithAdapters>[0]> = {},
  ): Promise<Daemon> {
    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-');
    daemon = createDaemonWithAdapters(
      {
        productName: 'Test Product',
        productId: 'test-product',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        ...configOverrides,
      },
      [adapter],
    );
    await daemon.pair('pairing-code');
    await daemon.start();
    return daemon;
  }

  it('runs offer -> claim -> progress -> complete', async () => {
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter);

    server.send(
      createEnvelope(
        'task.offer',
        { taskId: 'task-1', instruction: 'do the thing', policy: { mode: 'auto' } },
        { taskId: 'task-1' },
      ),
    );

    const claim = await server.waitFor((e) => e.type === 'task.claim');
    expect(claim.payload).toMatchObject({ taskId: 'task-1', deviceId: 'device-1' });

    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const [session] = adapter.sessions;
    expect(session).toBeDefined();
    expect(adapter.startCalls[0]?.ctx.workspaceDir).toContain('task-1');

    session?.emit({ type: 'progress', text: 'working...' });
    session?.emit({ type: 'turn_end' });

    const progress = await server.waitFor((e) => e.type === 'task.progress');
    // The final batch includes the terminal `turn_end` event itself (full
    // AgentEvent history is preserved in progress, not just implied by the
    // separate task.complete that follows).
    expect(progress.payload).toMatchObject({
      seq: 1,
      events: [{ type: 'progress', text: 'working...' }, { type: 'turn_end' }],
    });
    expect(progress.task_id).toBe('task-1');

    const complete = await server.waitFor((e) => e.type === 'task.complete');
    expect(complete.payload).toMatchObject({ summary: 'working...', sessionRef: session?.sessionRef });
    expect(session?.closeCalled).toBe(true);

    expect(daemon?.status().activeTaskCount).toBe(0);
  });

  it('cancel mid-task calls interrupt and reports task.fail(reason: cancelled, retryable: false)', async () => {
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter);

    server.send(
      createEnvelope(
        'task.offer',
        { taskId: 'task-2', instruction: 'long running thing', policy: { mode: 'auto' } },
        { taskId: 'task-2' },
      ),
    );
    await server.waitFor((e) => e.type === 'task.claim');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const [session] = adapter.sessions;

    server.send(createEnvelope('task.cancel', {}, { taskId: 'task-2' }));

    const fail = await server.waitFor((e) => e.type === 'task.fail');
    expect(fail.payload).toMatchObject({ reason: 'cancelled', retryable: false });
    expect(session?.interruptCalled).toBe(true);
    expect(session?.closeCalled).toBe(true);
  });

  it('rejects (claims then fails, non-retryable) a task whose policy exceeds the device ceiling', async () => {
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter, { permissionDefaults: { mode: 'readonly' } });

    server.send(
      createEnvelope(
        'task.offer',
        { taskId: 'task-3', instruction: 'do something risky', policy: { mode: 'auto' } },
        { taskId: 'task-3' },
      ),
    );

    const claim = await server.waitFor((e) => e.type === 'task.claim');
    expect(claim.payload).toMatchObject({ taskId: 'task-3' });

    const fail = await server.waitFor((e) => e.type === 'task.fail');
    expect(fail.payload).toMatchObject({ retryable: false });
    expect((fail.payload as { reason: string }).reason).toMatch(/exceeds/i);

    // Never actually started the adapter for a rejected task.
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('rejects (claims then fails, retryable) an offer naming an unavailable runtime', async () => {
    // `runtime` is constrained by the frozen protocol to 'pi'|'claude'|'codex'
    // (RuntimeIdSchema), so the stub must claim one of those ids to exercise
    // "runtime known but not detected as present" through a real TaskOfferPayload.
    const adapter = new StubRuntimeAdapter('pi', { present: false });
    await setupDaemon(adapter);

    server.send(
      createEnvelope(
        'task.offer',
        { taskId: 'task-4', instruction: 'x', policy: { mode: 'auto' }, runtime: 'pi' },
        { taskId: 'task-4' },
      ),
    );

    await server.waitFor((e) => e.type === 'task.claim');
    const fail = await server.waitFor((e) => e.type === 'task.fail');
    expect(fail.payload).toMatchObject({ retryable: true });
  });

  it('a PolicyUnsupportedError from adapter.start() is reported non-retryable; other start() errors are retryable', async () => {
    const unsupportedAdapter = new StubRuntimeAdapter('pi');
    unsupportedAdapter.startError = new PolicyUnsupportedError('pi cannot express this policy');
    await setupDaemon(unsupportedAdapter);

    server.send(
      createEnvelope('task.offer', { taskId: 'task-6', instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-6' }),
    );
    await server.waitFor((e) => e.type === 'task.claim');
    const fail = await server.waitFor((e) => e.type === 'task.fail');
    expect(fail.payload).toMatchObject({ retryable: false });
    expect((fail.payload as { reason: string }).reason).toContain('pi cannot express this policy');
  });

  it('a generic (non-PolicyUnsupportedError) start() failure is reported retryable', async () => {
    const flakyAdapter = new StubRuntimeAdapter('pi');
    flakyAdapter.startError = new Error('spawn ENOENT');
    await setupDaemon(flakyAdapter);

    server.send(
      createEnvelope('task.offer', { taskId: 'task-7', instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-7' }),
    );
    await server.waitFor((e) => e.type === 'task.claim');
    const fail = await server.waitFor((e) => e.type === 'task.fail');
    expect(fail.payload).toMatchObject({ retryable: true });
  });

  it('steer forwards text to the running session', async () => {
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter);

    server.send(
      createEnvelope('task.offer', { taskId: 'task-5', instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-5' }),
    );
    await server.waitFor((e) => e.type === 'task.claim');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));

    server.send(createEnvelope('task.steer', { text: 'focus on tests' }, { taskId: 'task-5' }));
    await vi.waitFor(() => expect(adapter.sessions[0]?.steerCalls).toEqual(['focus on tests']));
  });
});
