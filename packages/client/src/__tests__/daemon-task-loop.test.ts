import type { RuntimeTaskInput } from '../types';
import { echoedTestAgentRef, freshTestAgentRef, testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { RuntimeExecutionFailure, RUNTIME_ADAPTER_CONTRACT_VIOLATION_REASON } from '../runtime-failure';
import { TestServer } from './fixtures/test-server';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { resumeSession } from './fixtures/fresh-offer';

// A sessionless v3 Agent offer is a fresh one in v4, and a fresh offer carries the egress policy.
const FRESH_OFFER = { session: { mode: 'fresh' as const }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY };

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('daemon task loop (stub adapter + in-process HTTP server)', () => {
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
    const storeDir = await tmpDir('byok-client-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
        productId: 'test-product',
        serverUrl: server.url,
        agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
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

    // A resume offer without an egress policy reaches the Host event by event;
    // a fresh offer's latest-value lane would coalesce the batch below. The
    // session it resumes comes from a first, fresh task.
    const agentRef = freshTestAgentRef();
    server.send(createEnvelope('task.offer', { agentRef, ...FRESH_OFFER, instruction: 'start the session' }, { taskId: 'task-seed', seq: server.nextSeq() }));
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-seed');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const seed = adapter.sessions[0]!;
    seed.emit({ type: 'turn_end' });
    await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-seed');

    server.send(
      createEnvelope(
        'task.offer',
        { agentRef, ...resumeSession(seed.sessionRef), instruction: 'do the thing' },
        { taskId: 'task-1', seq: server.nextSeq() },
      ),
    );

    const claim = await server.waitFor((e) => e.type === 'task.claim' && e.task_id === 'task-1');
    expect(claim.payload).toMatchObject({ deviceId: 'device-1' });
    expect('taskId' in claim.payload).toBe(false);
    expect(claim.payload).toMatchObject({ runtime: 'pi' });

    // M1 gap #2: `task.claim` no longer implies `Running` — `task.started`
    // is the explicit, separate signal the adapter session actually started.
    const started = await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-1');
    expect(started.task_id).toBe('task-1');

    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(2));
    const session = adapter.sessions[1];
    expect(session).toBeDefined();
    // An Agent offer runs in its Agent home, <hostStorageRoot>/agents/<agentId>.
    const workspaceDir = adapter.startCalls[1]!.ctx.workspaceDir;
    expect(path.basename(workspaceDir)).toMatch(/^test-agent-\d+$/);
    expect(path.basename(path.dirname(workspaceDir))).toBe('agents');

    session?.emit({ type: 'progress', text: 'working...' });
    session?.emit({ type: 'turn_end' });

    const progress = await server.waitFor((e) => e.type === 'task.progress' && e.task_id === 'task-1');
    // The final batch includes the terminal `turn_end` event itself (full
    // AgentEvent history is preserved in progress, not just implied by the
    // separate task.complete that follows).
    expect(progress.payload).toMatchObject({
      seq: 1,
      events: [{ type: 'progress', text: 'working...' }, { type: 'turn_end' }],
    });
    expect(progress.task_id).toBe('task-1');

    const complete = await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-1');
    expect(complete.payload).toMatchObject({ summary: 'working...', sessionRef: session?.sessionRef });
    expect(session?.closeCalled).toBe(true);

    await vi.waitFor(() => expect(daemon?.status().activeTaskCount).toBe(0));
  });

  it('cancel mid-task calls interrupt and reports the explicit task.cancelled message (M1 gap #6)', async () => {
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter);

    server.send(
      createEnvelope(
        'task.offer',
        { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'long running thing' },
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

  /**
   * The batch interval is min(progressBatch.flushIntervalMs, the egress
   * policy's activity.maxCoalesceMs), and a fresh offer must carry the
   * daemon's exact policy. A case that needs a longer interval sets both.
   */
  function batchingFor(intervalMs: number) {
    const egressPolicy = { ...DEFAULT_AGENT_EGRESS_POLICY, activity: { ...DEFAULT_AGENT_EGRESS_POLICY.activity, maxCoalesceMs: intervalMs } };
    return {
      config: { progressBatch: { flushIntervalMs: intervalMs }, agentEgress: { policy: egressPolicy } },
      offer: { ...FRESH_OFFER, egressPolicy },
    };
  }

  it('cancel does not flush/send buffered-but-unsent progress (unobservable server-side anyway — M1-4 e2e finding)', async () => {
    const adapter = new StubRuntimeAdapter();
    // Keep the batching deadline well outside the long-poll delivery window so
    // the test controls the intended precondition instead of racing the
    // transport scheduler.
    const batching = batchingFor(5_000);
    await setupDaemon(adapter, batching.config);

    server.send(
      createEnvelope(
        'task.offer',
        { agentRef: freshTestAgentRef(), ...batching.offer, instruction: 'buffer some progress then cancel' },
        { taskId: 'task-cancel-buffered', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const [session] = adapter.sessions;

    // Buffered but not yet sent when the cancel arrives.
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

  it('the batch timer never sends buffered progress while a cancel is tearing the task down (#1055)', async () => {
    const adapter = new StubRuntimeAdapter();
    const batching = batchingFor(2_000);
    await setupDaemon(adapter, batching.config);

    server.send(
      createEnvelope(
        'task.offer',
        { agentRef: freshTestAgentRef(), ...batching.offer, instruction: 'buffer, cancel, then outlast the batch deadline' },
        { taskId: 'task-cancel-teardown', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-cancel-teardown');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0]!;
    // Hold the cancel inside interrupt() past the batch deadline, so the
    // timer comes due while the daemon is already tearing the task down.
    let releaseInterrupt!: () => void;
    const interruptHeld = new Promise<void>((resolve) => { releaseInterrupt = resolve; });
    session.interrupt = async () => {
      session.interruptCalled = true;
      await interruptHeld;
    };

    const bufferedAt = Date.now();
    session.emit({ type: 'progress', text: 'partial work before cancel' });
    server.send(
      createEnvelope('task.cancel', { reason: 'cancel during teardown' }, { taskId: 'task-cancel-teardown', seq: server.nextSeq() }),
    );
    await vi.waitFor(() => expect(session.interruptCalled).toBe(true), { timeout: 1_500 });
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, bufferedAt + 2_500 - Date.now())));
    releaseInterrupt();

    const cancelled = await server.waitFor((e) => e.type === 'task.cancelled' && e.task_id === 'task-cancel-teardown');
    expect(cancelled.payload).toMatchObject({ reason: 'cancel during teardown' });
    expect(server.received.some((e) => e.type === 'task.progress' && e.task_id === 'task-cancel-teardown')).toBe(false);
  });

  it('progress buffered before turn_end still reaches the server ahead of task.complete (#1055)', async () => {
    const adapter = new StubRuntimeAdapter();
    // No timer flush can happen within this case: only the turn_end flush
    // can send the batch.
    const batching = batchingFor(5_000);
    await setupDaemon(adapter, batching.config);

    // A resume offer reaches the Host event by event; a fresh offer's
    // latest-value lane would coalesce the batch. The resumed session comes
    // from a first, fresh task.
    const agentRef = freshTestAgentRef();
    server.send(createEnvelope('task.offer', { agentRef, ...batching.offer, instruction: 'start the session' }, { taskId: 'task-complete-seed', seq: server.nextSeq() }));
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-complete-seed');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const seed = adapter.sessions[0]!;
    seed.emit({ type: 'turn_end' });
    await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-complete-seed');

    server.send(
      createEnvelope(
        'task.offer',
        { agentRef, ...resumeSession(seed.sessionRef), instruction: 'buffer progress then finish' },
        { taskId: 'task-complete-buffered', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-complete-buffered');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(2));
    const session = adapter.sessions[1]!;

    session.emit({ type: 'progress', text: 'final words' });
    session.emit({ type: 'turn_end' });
    await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-complete-buffered');

    const ours = server.received.filter((e) => e.task_id === 'task-complete-buffered');
    const progressAt = ours.findIndex((e) => e.type === 'task.progress');
    expect(progressAt).toBeGreaterThanOrEqual(0);
    expect(progressAt).toBeLessThan(ours.findIndex((e) => e.type === 'task.complete'));
    const events = ours.filter((e) => e.type === 'task.progress').flatMap((e) => (e.payload as { events: Array<{ type: string }> }).events);
    expect(events.map((e) => e.type)).toEqual(['progress', 'turn_end']);
  });

  it('a turn_end racing a concurrent cancel does not resurrect the task with a stray task.complete/task.progress (M1-4 e2e finding)', async () => {
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter);

    server.send(
      createEnvelope(
        'task.offer',
        { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'race me' },
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

  it('declines (never claims) an offer naming an unavailable runtime (M1 gap #5)', async () => {
    // `runtime` is constrained by the frozen protocol to 'pi'|'claude'|'codex'
    // (RuntimeIdSchema), so the stub must claim one of those ids to exercise
    // "runtime known but not detected as present" through a real RuntimeTaskInput.
    const adapter = new StubRuntimeAdapter('pi', { kind: 'not-found' });
    await setupDaemon(adapter);

    server.send(
      createEnvelope(
        'task.offer',
        { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'x', runtime: 'pi' },
        { taskId: 'task-4', seq: server.nextSeq() },
      ),
    );

    const decline = await server.waitFor((e) => e.type === 'task.decline');
    expect(decline.payload).toMatchObject({ retryable: true });
    expect(server.received.some((e) => e.type === 'task.claim' && e.task_id === 'task-4')).toBe(false);
  });

  it('a typed authority failure from adapter.start() is reported non-retryable', async () => {
    const unsupportedAdapter = new StubRuntimeAdapter('pi');
    unsupportedAdapter.startError = new RuntimeExecutionFailure({
      phase: 'start',
      category: 'authority',
      retry: 'non-retryable',
      reason: 'pi cannot express this policy',
    });
    await setupDaemon(unsupportedAdapter);

    server.send(
      createEnvelope(
        'task.offer',
        { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'x' },
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

  it('an untyped start() failure fails closed as a non-retryable adapter-contract violation', async () => {
    const flakyAdapter = new StubRuntimeAdapter('pi');
    flakyAdapter.startError = new Error('spawn ENOENT');
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await setupDaemon(flakyAdapter);

    server.send(
      createEnvelope(
        'task.offer',
        { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'x' },
        { taskId: 'task-7', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.claim');
    const fail = await server.waitFor((e) => e.type === 'task.fail');
    expect(fail.payload).toEqual({ agentRef: echoedTestAgentRef,
      reason: RUNTIME_ADAPTER_CONTRACT_VIOLATION_REASON.start,
      retryable: false,
    });
    expect(diagnostic).toHaveBeenCalledOnce();
    diagnostic.mockRestore();
  });

  it('steer forwards text to the running session', async () => {
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter);

    server.send(
      createEnvelope(
        'task.offer',
        { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'x' },
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

  describe('task.claim reports the actually-selected runtime (M5, requested vs. claimed)', () => {
    it('an explicit-runtime offer: task.claim carries that same runtime as the actual pick', async () => {
      const adapter = new StubRuntimeAdapter('pi');
      await setupDaemon(adapter);

      server.send(
        createEnvelope(
          'task.offer',
          { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'x', runtime: 'pi' },
          { taskId: 'task-runtime-explicit', seq: server.nextSeq() },
        ),
      );

      const claim = await server.waitFor((e) => e.type === 'task.claim');
      expect(claim.payload).toMatchObject({ deviceId: 'device-1', runtime: 'pi' });
    });

    it('an offer naming NO runtime: task.claim still carries the auto-selected adapter this device actually picked, not merely an absence (single-candidate case; see task-runner-runtime-selection.test.ts for multi-candidate order)', async () => {
      const adapter = new StubRuntimeAdapter('claude');
      await setupDaemon(adapter);

      server.send(
        createEnvelope(
          'task.offer',
          { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'x' }, // no `runtime` — daemon auto-selects
          { taskId: 'task-runtime-auto', seq: server.nextSeq() },
        ),
      );

      const claim = await server.waitFor((e) => e.type === 'task.claim');
      // This is the exact gap the feature closes: before, the server never
      // learned which runtime an auto-selected task actually ran on.
      expect(claim.payload).toMatchObject({ deviceId: 'device-1', runtime: 'claude' });
    });
  });

  describe('approval resume (protocol §5)', () => {
    async function offerAndAwaitApproval(taskId: string): Promise<{ adapter: StubRuntimeAdapter; approvalId: string }> {
      const adapter = new StubRuntimeAdapter();
      await setupDaemon(adapter);

      server.send(
        createEnvelope(
          'task.offer',
          { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'needs a human' },
          { taskId, seq: server.nextSeq() },
        ),
      );
      await server.waitFor((e) => e.type === 'task.started');
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));

      adapter.sessions[0]?.emit({ type: 'progress', text: 'about to do something sensitive' });
      void adapter.sessions[0]!.requestApproval('about to do something sensitive');
      const awaitApproval = await server.waitFor((e) => e.type === 'task.await_approval' && e.task_id === taskId);
      expect(awaitApproval.payload).toMatchObject({ summary: 'about to do something sensitive' });
      // M5 (approval targeting): every dispatched approval carries its own id.
      if (awaitApproval.type !== 'task.await_approval') throw new Error('unreachable');
      const approvalId = awaitApproval.payload.approvalId;
      expect(approvalId).toEqual(expect.any(String));

      return { adapter, approvalId: approvalId! };
    }

    it('task.approve resolves approval(true) and progress resumes to completion', async () => {
      const { adapter, approvalId } = await offerAndAwaitApproval('task-approve-1');
      const session = adapter.sessions[0];

      server.send(createEnvelope('task.approve', { approvalId }, { taskId: 'task-approve-1', seq: server.nextSeq() }));
      await vi.waitFor(() => expect(session?.approvalResults).toEqual([{ approved: true }]));

      // Proof progress resumes: the session keeps producing events and the
      // task still runs to completion exactly as if it had never paused.
      session?.emit({ type: 'progress', text: 'resuming now' });
      session?.emit({ type: 'turn_end' });

      const complete = await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-approve-1');
      expect(complete.payload).toMatchObject({ summary: 'about to do something sensitiveresuming now' });
      expect(session?.closeCalled).toBe(true);
    });

    it('task.reject resolves approval(false, reason) and stops the session, reporting task.fail', async () => {
      const { adapter, approvalId } = await offerAndAwaitApproval('task-reject-1');
      const session = adapter.sessions[0];

      server.send(
        createEnvelope('task.reject', { reason: 'not authorized', approvalId }, { taskId: 'task-reject-1', seq: server.nextSeq() }),
      );

      const fail = await server.waitFor((e) => e.type === 'task.fail' && e.task_id === 'task-reject-1');
      expect(fail.payload).toMatchObject({ reason: 'not authorized', retryable: false });
      await vi.waitFor(() => expect(session?.approvalResults).toEqual([{ approved: false, reason: 'not authorized' }]));
      expect(session?.interruptCalled).toBe(true);
      expect(session?.closeCalled).toBe(true);
    });

    it('M5 (approval targeting): a task.approve carrying a WRONG approvalId for this pump()-dispatched approval is an audit-only no-op — the session is untouched and no task.fail is sent', async () => {
      const { adapter, approvalId } = await offerAndAwaitApproval('task-approve-stale-1');
      const session = adapter.sessions[0];

      const staleDecisions: Array<{ decision: string; reason?: string }> = [];
      daemon?.subscribe((e) => {
        if (e.kind === 'stale-approval-decision') staleDecisions.push({ decision: e.decision, reason: e.reason });
      });

      expect(approvalId).not.toBe('a-completely-different-id');
      server.send(
        createEnvelope('task.approve', { approvalId: 'a-completely-different-id' }, { taskId: 'task-approve-stale-1', seq: server.nextSeq() }),
      );

      await vi.waitFor(() => expect(staleDecisions).toHaveLength(1));
      expect(staleDecisions[0]?.decision).toBe('approve');

      // The session was never told to resolve anything, and the task was
      // never failed — it stays paused, still resolvable by the CORRECT id.
      expect(session?.approvalResults).toEqual([]);
      expect(server.received.some((e) => e.type === 'task.fail' && e.task_id === 'task-approve-stale-1')).toBe(false);

      // The matching decision still works afterward — proving the task is
      // genuinely still alive/pending, not silently corrupted.
      server.send(createEnvelope('task.approve', { approvalId }, { taskId: 'task-approve-stale-1', seq: server.nextSeq() }));
      await vi.waitFor(() => expect(session?.approvalResults).toEqual([{ approved: true }]));
    });
  });
});
