import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { startRealServerWithoutWebSocket, waitForTaskEvent, type RealServerHandle } from './fixtures/real-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Finding P2 (Codex P1 / gatekeeper M2): while `stalledAtSeq` is set,
 * `dedupWatermark()` collapses to the frozen durable cursor, so every
 * long-poll cycle re-pulls the WHOLE post-cursor backlog from the real
 * server — not just the stalled envelope. Three compounding bugs this
 * exercises against the REAL `@byok/server` (the lightweight `TestServer`
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
describe('long-poll stalled-cursor backlog re-pull: backoff + dedup (finding P2, real @byok/server)', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await real.close();
  });

  it('a persistently-throwing steer handler retries at a bounded, delay-spaced rate instead of a tight RTT-bound loop', async () => {
    real = await startRealServerWithoutWebSocket({ productId: 'test-product', longPollHoldMs: 150 });

    const workspaceRoot = await tmpDir('byok-e2e-workspace-');
    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter();
    const retryDelayMs = 100;

    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [adapter],
      {
        backoff: { baseMs: 20, maxMs: 50, factor: 2 },
        longPoll: { wsFailureThreshold: 1, wsRetryIntervalMs: 60_000, retryDelayMs, idleDelayMs: 20 },
      },
    );

    const pairing = real.byok.pairing.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();
    await vi.waitFor(() => {
      expect(real.byok.machines.list().find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    const handle = await real.byok.dispatch({ instruction: 'run over long-poll', policy: { mode: 'auto' } });
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0]!;

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

  it('a task.offer redelivered while its adapter.start() is still in flight (stalled behind an unrelated failing seq) never starts a second adapter session', async () => {
    real = await startRealServerWithoutWebSocket({ productId: 'test-product', longPollHoldMs: 150 });

    const workspaceRoot = await tmpDir('byok-e2e-workspace-');
    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter();
    const retryDelayMs = 30;

    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [adapter],
      {
        backoff: { baseMs: 20, maxMs: 50, factor: 2 },
        longPoll: { wsFailureThreshold: 1, wsRetryIntervalMs: 60_000, retryDelayMs, idleDelayMs: 20 },
      },
    );

    const pairing = real.byok.pairing.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();
    await vi.waitFor(() => {
      expect(real.byok.machines.list().find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    // Task A: stalls the cursor via a persistently-failing steer, so every
    // subsequent long-poll cycle re-pulls the whole post-cursor backlog.
    const handleA = await real.byok.dispatch({ instruction: 'task A (stalls the cursor)', policy: { mode: 'auto' } });
    await waitForTaskEvent(handleA, (e) => e.kind === 'state' && e.state === 'Running');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const sessionA = adapter.sessions[0]!;
    sessionA.steerErrorPersistent = new Error('keep task A stalled');
    await handleA.steer('stall it');
    await vi.waitFor(() => expect(sessionA.steerAttempts).toBeGreaterThanOrEqual(1));

    // Task B: dispatched while A is stalled, so its own offer (a higher seq
    // than the frozen cursor) rides along on every re-pull too. Block its
    // adapter.start() so the first attempt is genuinely still in flight
    // while further redeliveries of the SAME offer arrive. The shared
    // `adapter` already carries task A's own startCall/session (1 each) at
    // this point, so task B's first (and, post-fix, only) attempt brings
    // the running total to 2 — that's the count to synchronize on, not 1.
    const releaseB = adapter.blockStart();
    const handleB = await real.byok.dispatch({ instruction: 'task B (redelivered while in flight)', policy: { mode: 'auto' } });
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(2));

    // Let several stalled re-poll cycles land while B's start() is blocked —
    // long enough for a pre-fix build to have piled up multiple queued
    // duplicate deliveries of B's own offer behind the first.
    await new Promise((resolve) => setTimeout(resolve, 10 * retryDelayMs));

    releaseB();
    sessionA.steerErrorPersistent = undefined; // let A recover too, for clean teardown

    await waitForTaskEvent(handleB, (e) => e.kind === 'state' && e.state === 'Running');
    // Give any (buggy, pre-fix) queued duplicate handleOffer calls a chance
    // to actually run through the now-unblocked adapter.start() gate before
    // asserting the count is done growing.
    await new Promise((resolve) => setTimeout(resolve, 5 * retryDelayMs));

    // Exactly 2 total: task A's own start, plus task B's — never a third
    // (duplicate) call from a redelivered offer racing in behind the first.
    expect(adapter.startCalls).toHaveLength(2);
    expect(adapter.sessions).toHaveLength(2);

    // Task B's (the second, and only its own) session is not orphaned — it
    // still drives task B to Complete normally.
    const sessionB = adapter.sessions[1]!;
    sessionB.emit({ type: 'progress', text: 'B finished cleanly' });
    sessionB.emit({ type: 'turn_end' });
    const resultB = await handleB.result();
    expect(resultB.state).toBe('Complete');
    expect(resultB.summary).toBe('B finished cleanly');
  }, 15000);

  it('a stalled seq that succeeds on retry executes exactly once, even if another redelivery of it piles up while the retry is still resolving', async () => {
    real = await startRealServerWithoutWebSocket({ productId: 'test-product', longPollHoldMs: 150 });

    const workspaceRoot = await tmpDir('byok-e2e-workspace-');
    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter();
    const retryDelayMs = 30;

    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [adapter],
      {
        backoff: { baseMs: 20, maxMs: 50, factor: 2 },
        longPoll: { wsFailureThreshold: 1, wsRetryIntervalMs: 60_000, retryDelayMs, idleDelayMs: 20 },
      },
    );

    const pairing = real.byok.pairing.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();
    await vi.waitFor(() => {
      expect(real.byok.machines.list().find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    const handle = await real.byok.dispatch({ instruction: 'run over long-poll', policy: { mode: 'auto' } });
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0]!;

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
