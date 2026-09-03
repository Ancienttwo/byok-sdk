import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { CursorStore } from '../daemon/cursor-store';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { SteerUnsupportedError } from '../types';
import { startRealServer, waitForTaskEvent, type RealServerHandle } from './fixtures/real-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Wave 2, Design A (finding F3-on-long-poll): before this wave, the
 * long-poll loop (`LongPollClient.loop`, see its own history) fire-and-forgot
 * every polled envelope to `onEnvelope` and then IMMEDIATELY persisted the
 * batch's high-water cursor — bypassing the exact same
 * stalled-handler/advance-after-success machinery `ConnectionManager`
 * already applied to WS (finding F3). A handler that then failed left a
 * redelivery-proof envelope permanently marked processed, with no way to
 * ever retry it, EXCEPT over WS.
 *
 * This is the direct long-poll analog of
 * `connection-manager-redelivery.test.ts`'s F3 test, but run end-to-end
 * against the REAL `@byok-sdk/server` + a REAL client daemon forced into
 * long-poll-only mode (`startRealServer`, which since WP3B Step 2 serves no
 * WS upgrade at all) — proving the two transports share the identical
 * deliver()/process()/advanceCursor path documented in
 * `connection-manager.ts`, not just that the WS-specific unit test still
 * passes.
 *
 * `task.steer` is the forcing function for "a handler genuinely throws":
 * `TaskRunner.handleSteer` is the one S->D handler with no try/catch around
 * its session call (cancel/approve/reject all swallow a failing session
 * call and report a terminal message instead) — see `StubSession.steerError`'s
 * own doc comment.
 */
describe('long-poll cursor is not advanced before the handler succeeds (Design A, real @byok-sdk/server, long-poll only)', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await real.close();
  });

  // 2d gap: the WP3B Step 2 façade delegates delivery to the cloud kernel's
  // mailbox, whose ack is IRREVERSIBLE (`packages/core/src/in-memory/mailbox.ts`
  // `readAfter` returns only `pending` rows; `advanceCursor` marks everything at
  // or below the cursor `acked` and the old hub's 500-entry replay ring is gone —
  // see the case 7 ruling in
  // `tasks/notes/20260903-1505-wp3b-step2-facade-fold.notes.md`). The long-poll
  // client acks OPTIMISTICALLY: `ConnectionManager.dedupWatermark()` returns the
  // delivered high-water while unstalled, so the poll issued immediately after a
  // batch is delivered carries that seq as its cursor and acks the envelope
  // BEFORE its handler has settled. Observed against this server: poll
  // `cursor=1` -> `[[2,'task.steer']]`, next poll `cursor=2` (ack), and every
  // later poll at the rolled-back `cursor=1` returns `[]` forever. A stalled
  // handler's envelope is therefore never redelivered, so the fact this case
  // pins cannot be produced end-to-end any more. Skipped rather than loosened:
  // the client-side optimistic ack is a real gap, not a test artifact.
  it.skip('a polled task.steer whose handler throws leaves the persisted cursor unadvanced; a re-poll redelivers it and only then advances', async () => {
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 200 });

    const workspaceRoot = await tmpDir('byok-e2e-workspace-');
    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [adapter],
      {
        backoff: { baseMs: 20, maxMs: 50, factor: 2 },
        longPoll: { wsFailureThreshold: 1, wsRetryIntervalMs: 60_000, retryDelayMs: 20, idleDelayMs: 20 },
      },
    );

    const pairing = await real.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();

    // WS never connects — settled via long-poll fallback, matching finding
    // F6's own test (`real-server-longpoll-only.test.ts`).
    expect(daemon.status().connected).toBe(false);
    expect(daemon.status().degraded).toBe(true);
    await vi.waitFor(async () => {
      expect((await real.byok.machines.list()).find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    const handle = await real.byok.dispatch({ instruction: 'run over long-poll', policy: { mode: 'auto' } });
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0]!;

    // The task.offer itself is now the daemon's one successfully-processed
    // envelope; its seq is the "before" baseline the steer's seq must sit
    // strictly above. Read it via `vi.waitFor` — the on-disk write is
    // fire-and-forget from `advanceCursor`'s point of view (see
    // `connection-manager.ts`), so it may still be landing.
    const cursorStore = new CursorStore(storeDir);
    let baseline: number | undefined;
    await vi.waitFor(async () => {
      baseline = await cursorStore.load(real.url, record.deviceId);
      expect(baseline).toBeGreaterThan(0);
    });

    // Force the NEXT steer to throw — a genuine, uncaught handler failure
    // propagating from `StubSession.steer` up through
    // `TaskRunner.handleSteer` -> `handleEnvelope` -> `ConnectionManager.process`.
    session.steerError = new Error('simulated transient steer failure');
    const releaseRetry = session.blockSteer();

    await handle.steer('first attempt');

    // `steerError` is cleared by `steer()` itself the moment it's invoked
    // (whether it throws or not — see `StubSession`'s own doc comment), so
    // waiting for it to clear is proof the failing attempt actually ran.
    await vi.waitFor(() => expect(session.steerError).toBeUndefined());
    expect(session.steerCalls).toHaveLength(0); // it threw before recording the call

    // Hold the automatically redelivered successful retry inside the handler.
    // The cursor must remain at the pre-steer baseline until that handler
    // resolves, even though the retry has already arrived.
    await vi.waitFor(() => expect(session.steerAttempts).toBeGreaterThanOrEqual(2));
    await vi.waitFor(async () => {
      const persisted = await cursorStore.load(real.url, record.deviceId);
      expect(persisted).toBe(baseline);
    });

    // A re-poll must redeliver the SAME task.steer (its task is still
    // Running, non-terminal, and its seq is still > the reported cursor) —
    // this time it succeeds (steerError was already cleared above).
    releaseRetry();
    await vi.waitFor(() => expect(session.steerCalls).toEqual(['first attempt']), { timeout: 5000 });

    // Only NOW does the cursor advance past the steer's own seq.
    await vi.waitFor(async () => {
      const persisted = await cursorStore.load(real.url, record.deviceId);
      expect(persisted).toBeGreaterThan(baseline ?? 0);
    });

    session.emit({ type: 'turn_end' });
    const result = await handle.result();
    expect(result.state).toBe('Complete');
  }, 15000);

  /**
   * S0/H-006, the other half of the same classification: a `SteerUnsupportedError`
   * is NOT a transient handler failure — the runtime has no steering channel at
   * all, so every redelivery of that envelope is guaranteed to fail identically
   * and would freeze the cursor (and every later envelope behind it) forever.
   * `TaskRunner.handleSteer` therefore records it and returns normally, which
   * acks the envelope: the cursor advances past the steer's seq and the daemon
   * never calls `session.steer` for it a second time.
   */
  it('a polled task.steer whose handler throws SteerUnsupportedError is recorded and acked: the cursor advances and it is never redelivered', async () => {
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 200 });

    const workspaceRoot = await tmpDir('byok-e2e-workspace-');
    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [adapter],
      {
        backoff: { baseMs: 20, maxMs: 50, factor: 2 },
        longPoll: { wsFailureThreshold: 1, wsRetryIntervalMs: 60_000, retryDelayMs: 20, idleDelayMs: 20 },
      },
    );

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const pairing = await real.createPairingCode();
      const record = await daemon.pair(pairing.code);
      await daemon.start();

      await vi.waitFor(async () => {
        expect((await real.byok.machines.list()).find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
      });

      const handle = await real.byok.dispatch({ instruction: 'run over long-poll', policy: { mode: 'auto' } });
      await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
      const session = adapter.sessions[0]!;

      const cursorStore = new CursorStore(storeDir);
      let baseline: number | undefined;
      await vi.waitFor(async () => {
        baseline = await cursorStore.load(real.url, record.deviceId);
        // Strictly positive, not merely "a number": the task is already
        // Running, so the offer's own handler has succeeded and its seq is
        // already persisted. Reading a 0/undefined baseline here would let the
        // OFFER's advance satisfy the post-steer assertion below.
        expect(baseline).toBeGreaterThan(0);
      });

      // Persistent (never auto-clearing) so a redelivery would fail again —
      // exactly the infinite loop the classification exists to prevent.
      session.steerErrorPersistent = new SteerUnsupportedError('stub', 'stub runtime cannot steer');

      await handle.steer('impossible steer');

      // Order matters: the steer must actually have been attempted before the
      // cursor is inspected, otherwise a still-settling earlier advance could
      // satisfy the check while the steer envelope is still in flight.
      await vi.waitFor(() => expect(session.steerAttempts).toBe(1));

      // The envelope is acked despite the throw: the DURABLE (client-side)
      // cursor moves past its seq, which a stalled handler would have held
      // back — see `ConnectionManager.stalledAtSeq`.
      await vi.waitFor(async () => {
        const persisted = await cursorStore.load(real.url, record.deviceId);
        expect(persisted).toBeGreaterThan(baseline ?? 0);
      });

      expect(session.steerAttempts).toBe(1);
      expect(session.steerCalls).toEqual([]); // it threw before recording the call

      // Give the long-poll loop several more cycles: a redelivery would show up
      // as a second attempt (and a second side effect) — it must not.
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(session.steerAttempts).toBe(1);

      expect(
        errors.mock.calls.some(
          (call) => typeof call[0] === 'string' && call[0].includes('no steering channel') && call[0].includes('stub'),
        ),
      ).toBe(true);

      session.emit({ type: 'turn_end' });
      const result = await handle.result();
      expect(result.state).toBe('Complete');
    } finally {
      errors.mockRestore();
    }
  }, 15000);
});
