import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { dispatchResumedAgentTask, startRealServer, waitForTaskEvent, type RealServerHandle } from './fixtures/real-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Finding P2 (Codex P1 / gatekeeper M2): while `stalledAtSeq` is set,
 * `dedupWatermark()` collapses to the frozen durable cursor, so every
 * long-poll cycle re-pulls the WHOLE post-cursor backlog from the real
 * server — not just the stalled envelope. Three compounding bugs this
 * exercises against the REAL `@byok-sdk/server` (the lightweight `TestServer`
 * stub doesn't implement cursor-based redelivery on repeat polls at all, so
 * it can't reproduce any of this):
 *
 * (a) the long-poll loop's idle delay only applied to EMPTY batches, so a
 *     persistently-throwing handler (`task.steer`, the one S->D handler with
 *     no try/catch around its session call) spun at RTT — no backoff at all.
 * (b) `deliver()` re-enqueued a redelivered seq into `processingChain` on
 *     EVERY cycle with no in-flight/already-processed tracking, so anything
 *     above the frozen watermark (not just the stalled seq itself) got
 *     re-appended repeatedly — including a still-in-flight `task.offer`,
 *     whose redelivery (once its first `adapter.start()` finally resolves
 *     and the chain unwinds through the piled-up duplicates) started a
 *     SECOND adapter session, orphaning the first.
 * (c) even the stalled seq's own eventual success could be immediately
 *     followed by a duplicate re-run if another redelivery of the same seq
 *     had piled up behind it while the successful attempt was still
 *     resolving.
 *
 * Fix: (a) apply `retryDelayMs` to a stalled cycle that made no cursor
 * progress, not just to empty batches; (b) track in-flight/processed seqs in
 * `ConnectionManager` and skip re-enqueuing either; (c) guard
 * `TaskRunner.handleOffer` on `this.tasks.has(taskId)` / a finished-task
 * memory so a redelivered offer for an already-active/finished task is a
 * no-op.
 */
describe('long-poll stalled-cursor backlog re-pull: backoff + dedup (finding P2, real @byok-sdk/server)', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    await daemon?.stop();
    await real.close();
  });

  // Step 4 regression: a failed handler leaves the kernel ack behind, so
  // re-reads happen and must use the configured retry cadence.
  it('a persistently-throwing steer handler retries at a bounded, delay-spaced rate instead of a tight RTT-bound loop', async () => {
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 150 });

    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter();
    const retryDelayMs = 100;

    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, storeDir, agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY } },
      [adapter],
      {
        longPoll: { retryDelayMs, idleDelayMs: 20 },
      },
    );

    const pairing = await real.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();
    await vi.waitFor(async () => {
      expect((await real.byok.machines.list()).find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    const { handle, session } = await dispatchResumedAgentTask(real, adapter, { deviceId: record.deviceId, instruction: 'run over long-poll' });
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');

    session.steerErrorPersistent = new Error('persistently failing steer handler');
    await handle.steer('keep retrying');

    await vi.waitFor(() => expect(session.steerAttempts).toBeGreaterThanOrEqual(1));
    const t0 = Date.now();
    const attemptsAtT0 = session.steerAttempts;
    const extraAttemptsToObserve = 4;

    await vi.waitFor(() => expect(session.steerAttempts).toBeGreaterThanOrEqual(attemptsAtT0 + extraAttemptsToObserve), {
      timeout: 5000,
    });
    const elapsedMs = Date.now() - t0;

    session.steerErrorPersistent = undefined; // let it recover for clean teardown

    // A tight RTT-bound loop (pre-fix) completes several extra attempts
    // against a local server in a handful of milliseconds; a properly
    // delay-spaced retry (post-fix) takes at least on the order of
    // extraAttemptsToObserve * retryDelayMs. A generous 50% tolerance keeps
    // this robust to scheduling jitter while still cleanly separating the
    // two behaviors.
    expect(elapsedMs).toBeGreaterThanOrEqual(extraAttemptsToObserve * retryDelayMs * 0.5);
  }, 15000);

  // The response counter below proves the same offer is actually re-read
  // while its first handler is in flight, so the dedup assertion is non-vacuous.
  it('a task.offer redelivered while its adapter.start() is still in flight (stalled behind an unrelated failing seq) never starts a second adapter session', async () => {
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 150 });

    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter();
    const retryDelayMs = 30;
    const nativeFetch = globalThis.fetch;
    let taskBId: string | undefined;
    let taskBOfferReads = 0;
    vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await nativeFetch(input, init);
      const url = input instanceof Request ? input.url : String(input);
      if (taskBId !== undefined && url.includes('/byok/events') && response.ok) {
        const body = await response.clone().json() as { events?: Array<{ type?: string; task_id?: string }> };
        taskBOfferReads += body.events?.filter((event) => event.type === 'task.offer' && event.task_id === taskBId).length ?? 0;
      }
      return response;
    }) as typeof fetch);

    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, storeDir, agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY } },
      [adapter],
      {
        longPoll: { retryDelayMs, idleDelayMs: 20 },
      },
    );

    const pairing = await real.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();
    await vi.waitFor(async () => {
      expect((await real.byok.machines.list()).find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    // Task A: stalls the cursor via a persistently-failing steer, so every
    // subsequent long-poll cycle re-pulls the whole post-cursor backlog.
    const { handle: handleA, session: sessionA } = await dispatchResumedAgentTask(real, adapter, { deviceId: record.deviceId, instruction: 'task A (stalls the cursor)' });
    await waitForTaskEvent(handleA, (e) => e.kind === 'state' && e.state === 'Running');
    const startsThroughA = adapter.startCalls.length;
    sessionA.steerErrorPersistent = new Error('keep task A stalled');
    await handleA.steer('stall it');
    await vi.waitFor(() => expect(sessionA.steerAttempts).toBeGreaterThanOrEqual(1));

    // Task B: dispatched while A is stalled, so its own offer (a higher seq
    // than the frozen cursor) rides along on every re-pull too. Block its
    // adapter.start() so the first attempt is genuinely still in flight
    // while further redeliveries of the SAME offer arrive. The shared
    // `adapter` already carries task A's seed and task A's own startCalls at
    // this point, so task B's first (and, post-fix, only) attempt adds one
    // — that's the count to synchronize on. Task B is a fresh execution: it
    // needs no handle.
    const releaseB = adapter.blockStart();
    const taskB = 'task-b-redelivered';
    taskBId = taskB;
    await real.byok.executions.submit({
      taskId: taskB,
      deviceId: record.deviceId,
      payload: {
        instruction: 'task B (redelivered while in flight)',
        runtime: 'pi',
        agentRef: { agentId: 'agent-task-b', profileRevision: 'rev-1' },
        session: { mode: 'fresh' },
        egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
        terminalProjection: { mode: 'none' },
      },
    });
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(startsThroughA + 1));

    // Let several stalled re-poll cycles land while B's start() is blocked —
    // long enough for a pre-fix build to have piled up multiple queued
    // duplicate deliveries of B's own offer behind the first. A slow runner
    // may need longer than the window for the second read to arrive.
    await Promise.all([
      new Promise((resolve) => setTimeout(resolve, 10 * retryDelayMs)),
      vi.waitFor(() => expect(taskBOfferReads).toBeGreaterThanOrEqual(2), { timeout: 5_000 }),
    ]);
    expect(taskBOfferReads).toBeGreaterThanOrEqual(2);

    releaseB();
    sessionA.steerErrorPersistent = undefined; // let A recover too, for clean teardown

    await vi.waitFor(async () => expect((await real.byok.tasks.get(taskB))?.state).toBe('Running'), { timeout: 5_000, interval: 20 });
    // Give any (buggy, pre-fix) queued duplicate handleOffer calls a chance
    // to actually run through the now-unblocked adapter.start() gate before
    // asserting the count is done growing.
    await new Promise((resolve) => setTimeout(resolve, 5 * retryDelayMs));

    // Exactly one start for task B — never a second (duplicate) call from a
    // redelivered offer racing in behind the first.
    expect(adapter.startCalls).toHaveLength(startsThroughA + 1);
    expect(adapter.sessions).toHaveLength(startsThroughA + 1);

    // Task B's (the last, and only its own) session is not orphaned — it
    // still drives task B to Complete normally.
    const sessionB = adapter.sessions[startsThroughA]!;
    sessionB.emit({ type: 'progress', text: 'B finished cleanly' });
    sessionB.emit({ type: 'turn_end' });
    const resultB = await vi.waitFor(async () => {
      const result = (await real.byok.tasks.get(taskB))?.result;
      if (result === undefined) throw new Error('task B has no result yet');
      return result;
    }, { timeout: 5_000, interval: 20 });
    expect(resultB.state).toBe('Complete');
    expect(resultB.summary).toBe('B finished cleanly');
  }, 15000);

  // Step 4 regression: repeated reads during a successful retry must not
  // append the same seq to the handler FIFO twice.
  it('a stalled seq that succeeds on retry executes exactly once, even if another redelivery of it piles up while the retry is still resolving', async () => {
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 150 });

    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter();
    const retryDelayMs = 30;

    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, storeDir, agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY } },
      [adapter],
      {
        longPoll: { retryDelayMs, idleDelayMs: 20 },
      },
    );

    const pairing = await real.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();
    await vi.waitFor(async () => {
      expect((await real.byok.machines.list()).find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    const { handle, session } = await dispatchResumedAgentTask(real, adapter, { deviceId: record.deviceId, instruction: 'run over long-poll' });
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');

    // First attempt throws once (stalls the cursor); the retry would
    // succeed, but is held open (blockSteer) so a test can deterministically
    // land another redelivery of the exact same seq behind it while it's
    // still resolving — the narrowest reproduction of the double-execution
    // bug, rather than hoping real timing races it in.
    session.steerError = new Error('one-shot failure to trigger the stall');
    const releaseSteer = session.blockSteer();

    await handle.steer('go');
    await vi.waitFor(() => expect(session.steerAttempts).toBeGreaterThanOrEqual(1)); // the throwing attempt
    await vi.waitFor(() => expect(session.steerAttempts).toBeGreaterThanOrEqual(2)); // the retry, now blocked in the gate

    // Let more stalled re-poll cycles land while the retry is blocked.
    await new Promise((resolve) => setTimeout(resolve, 8 * retryDelayMs));

    releaseSteer();

    // Let any (buggy, pre-fix) queued duplicate re-run through before checking.
    await new Promise((resolve) => setTimeout(resolve, 5 * retryDelayMs));
    await vi.waitFor(() => expect(session.steerCalls.length).toBeGreaterThanOrEqual(1));

    expect(session.steerCalls).toEqual(['go']);

    session.emit({ type: 'progress', text: 'done' });
    session.emit({ type: 'turn_end' });
    const result = await handle.result();
    expect(result.state).toBe('Complete');
  }, 15000);
});
