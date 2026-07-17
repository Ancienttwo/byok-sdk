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

  it('runs offer -> claim -> started -> progress -> complete', async () => {
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter);

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'do the thing', policy: { mode: 'auto' } },
        { taskId: 'task-1', seq: server.nextSeq() },
      ),
    );

    const claim = await server.waitFor((e) => e.type === 'task.claim');
    expect(claim.payload).toMatchObject({ deviceId: 'device-1' });
    expect('taskId' in claim.payload).toBe(false);

    // M1 gap #2: `task.claim` no longer implies `Running` — `task.started`
    // is the explicit, separate signal the adapter session actually started.
    const started = await server.waitFor((e) => e.type === 'task.started');
    expect(started.task_id).toBe('task-1');

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

  it('cancel mid-task calls interrupt and reports the explicit task.cancelled message (M1 gap #6)', async () => {
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter);

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'long running thing', policy: { mode: 'auto' } },
        { taskId: 'task-2', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.claim');
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const [session] = adapter.sessions;

    server.send(
      createEnvelope('task.cancel', { reason: 'user stopped it' }, { taskId: 'task-2', seq: server.nextSeq() }),
    );

    const cancelled = await server.waitFor((e) => e.type === 'task.cancelled');
    expect(cancelled.payload).toMatchObject({ reason: 'user stopped it' });
    expect(session?.interruptCalled).toBe(true);
    expect(session?.closeCalled).toBe(true);

    // Superseded M0 convention — must never appear on the wire anymore.
    expect(server.received.some((e) => e.type === 'task.fail' && e.task_id === 'task-2')).toBe(false);
  });

  it('cancel does not flush/send buffered-but-unsent progress (unobservable server-side anyway — M1-4 e2e finding)', async () => {
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter);

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'buffer some progress then cancel', policy: { mode: 'auto' } },
        { taskId: 'task-cancel-buffered', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const [session] = adapter.sessions;

    // Buffered but (per the batcher's own 250ms-or-10-events flush policy)
    // not yet sent when the cancel arrives.
    session?.emit({ type: 'progress', text: 'partial work before cancel' });
    server.send(
      createEnvelope('task.cancel', { reason: 'cancel while buffered' }, { taskId: 'task-cancel-buffered', seq: server.nextSeq() }),
    );

    const cancelled = await server.waitFor((e) => e.type === 'task.cancelled' && e.task_id === 'task-cancel-buffered');
    expect(cancelled.payload).toMatchObject({ reason: 'cancel while buffered' });

    // §4: the server already moved this task to Cancelled (and closed its
    // event queue) before task.cancel even reached the daemon, so the
    // buffered progress can never reach an embedder — sending it would only
    // be logged server-side as a dropped/illegal-transition task.progress.
    expect(server.received.some((e) => e.type === 'task.progress' && e.task_id === 'task-cancel-buffered')).toBe(false);
  });

  it('a turn_end racing a concurrent cancel does not resurrect the task with a stray task.complete/task.progress (M1-4 e2e finding)', async () => {
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter);

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'race me', policy: { mode: 'auto' } },
        { taskId: 'task-race', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0]!;

    // Widen finish()'s tasks.delete() -> await session.close() window so we
    // can deterministically land an event in it, instead of depending on
    // real interprocess timing (see the fixture's doc comment). This
    // reproduces exactly what a real runtime adapter's interrupt() handling
    // can do: settle with a trailing turn_end shortly after handleCancel()
    // already reported task.cancelled.
    const releaseClose = session.blockClose();
    server.send(createEnvelope('task.cancel', { reason: 'race test' }, { taskId: 'task-race', seq: server.nextSeq() }));
    await vi.waitFor(() => expect(session.interruptCalled).toBe(true));
    const cancelled = await server.waitFor((e) => e.type === 'task.cancelled' && e.task_id === 'task-race');
    expect(cancelled.payload).toMatchObject({ reason: 'race test' });

    session.emit({ type: 'turn_end' }); // the stray, superseded event
    releaseClose();
    await vi.waitFor(() => expect(session.closeCalled).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50)); // let any stray pump() continuation run

    expect(server.received.some((e) => e.type === 'task.complete' && e.task_id === 'task-race')).toBe(false);
    expect(
      server.received.some(
        (e) => e.type === 'task.progress' && e.task_id === 'task-race' && JSON.stringify(e.payload).includes('turn_end'),
      ),
    ).toBe(false);
  });

  it('declines (never claims) a task whose policy exceeds the device ceiling (M1 gap #5)', async () => {
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter, { permissionDefaults: { mode: 'readonly' } });

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'do something risky', policy: { mode: 'auto' } },
        { taskId: 'task-3', seq: server.nextSeq() },
      ),
    );

    const decline = await server.waitFor((e) => e.type === 'task.decline');
    expect(decline.payload).toMatchObject({ retryable: false });
    expect((decline.payload as { reason: string }).reason).toMatch(/exceeds/i);

    // Never claims a pre-claim rejection anymore — no more claim-then-fail.
    expect(server.received.some((e) => e.type === 'task.claim' && e.task_id === 'task-3')).toBe(false);
    expect(server.received.some((e) => e.type === 'task.fail' && e.task_id === 'task-3')).toBe(false);
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('declines (never claims) an offer naming an unavailable runtime (M1 gap #5)', async () => {
    // `runtime` is constrained by the frozen protocol to 'pi'|'claude'|'codex'
    // (RuntimeIdSchema), so the stub must claim one of those ids to exercise
    // "runtime known but not detected as present" through a real TaskOfferPayload.
    const adapter = new StubRuntimeAdapter('pi', { present: false });
    await setupDaemon(adapter);

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'x', policy: { mode: 'auto' }, runtime: 'pi' },
        { taskId: 'task-4', seq: server.nextSeq() },
      ),
    );

    const decline = await server.waitFor((e) => e.type === 'task.decline');
    expect(decline.payload).toMatchObject({ retryable: true });
    expect(server.received.some((e) => e.type === 'task.claim' && e.task_id === 'task-4')).toBe(false);
  });

  it('a PolicyUnsupportedError from adapter.start() is reported non-retryable; other start() errors are retryable', async () => {
    const unsupportedAdapter = new StubRuntimeAdapter('pi');
    unsupportedAdapter.startError = new PolicyUnsupportedError('pi cannot express this policy');
    await setupDaemon(unsupportedAdapter);

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'x', policy: { mode: 'auto' } },
        { taskId: 'task-6', seq: server.nextSeq() },
      ),
    );
    // Adapter start() failures happen post-claim (this device did commit to
    // the task; it just failed while preparing the session).
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
      createEnvelope(
        'task.offer',
        { instruction: 'x', policy: { mode: 'auto' } },
        { taskId: 'task-7', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.claim');
    const fail = await server.waitFor((e) => e.type === 'task.fail');
    expect(fail.payload).toMatchObject({ retryable: true });
  });

  it('steer forwards text to the running session', async () => {
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter);

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'x', policy: { mode: 'auto' } },
        { taskId: 'task-5', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.claim');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));

    server.send(
      createEnvelope('task.steer', { text: 'focus on tests' }, { taskId: 'task-5', seq: server.nextSeq() }),
    );
    await vi.waitFor(() => expect(adapter.sessions[0]?.steerCalls).toEqual(['focus on tests']));
  });

  describe('approval resume (protocol §5)', () => {
    async function offerAndAwaitApproval(taskId: string): Promise<{ adapter: StubRuntimeAdapter }> {
      const adapter = new StubRuntimeAdapter();
      await setupDaemon(adapter);

      server.send(
        createEnvelope(
          'task.offer',
          { instruction: 'needs a human', policy: { mode: 'auto' } },
          { taskId, seq: server.nextSeq() },
        ),
      );
      await server.waitFor((e) => e.type === 'task.started');
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));

      adapter.sessions[0]?.emit({ type: 'progress', text: 'about to do something sensitive' });
      adapter.sessions[0]?.emit({ type: 'needs_approval', summary: 'about to do something sensitive' });
      const awaitApproval = await server.waitFor((e) => e.type === 'task.await_approval' && e.task_id === taskId);
      expect(awaitApproval.payload).toMatchObject({ summary: 'about to do something sensitive' });

      return { adapter };
    }

    it('task.approve resolves approval(true) and progress resumes to completion', async () => {
      const { adapter } = await offerAndAwaitApproval('task-approve-1');
      const session = adapter.sessions[0];

      server.send(createEnvelope('task.approve', {}, { taskId: 'task-approve-1', seq: server.nextSeq() }));
      await vi.waitFor(() => expect(session?.resolveApprovalCalls).toEqual([{ approved: true }]));

      // Proof progress resumes: the session keeps producing events and the
      // task still runs to completion exactly as if it had never paused.
      session?.emit({ type: 'progress', text: 'resuming now' });
      session?.emit({ type: 'turn_end' });

      const complete = await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-approve-1');
      expect(complete.payload).toMatchObject({ summary: 'about to do something sensitiveresuming now' });
      expect(session?.closeCalled).toBe(true);
    });

    it('task.reject resolves approval(false, reason) and stops the session, reporting task.fail', async () => {
      const { adapter } = await offerAndAwaitApproval('task-reject-1');
      const session = adapter.sessions[0];

      server.send(
        createEnvelope('task.reject', { reason: 'not authorized' }, { taskId: 'task-reject-1', seq: server.nextSeq() }),
      );

      const fail = await server.waitFor((e) => e.type === 'task.fail' && e.task_id === 'task-reject-1');
      expect(fail.payload).toMatchObject({ reason: 'not authorized', retryable: false });
      expect(session?.resolveApprovalCalls).toEqual([{ approved: false, reason: 'not authorized' }]);
      expect(session?.interruptCalled).toBe(true);
      expect(session?.closeCalled).toBe(true);
    });
  });
});
