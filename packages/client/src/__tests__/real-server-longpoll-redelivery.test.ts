import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { CursorStore } from '../daemon/cursor-store';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { startRealServerWithoutWebSocket, waitForTaskEvent, type RealServerHandle } from './fixtures/real-server';

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
 * against the REAL `@byok/server` + a REAL client daemon forced into
 * long-poll-only mode (`startRealServerWithoutWebSocket`) — proving the two
 * transports now share the identical deliver()/process()/advanceCursor path
 * documented in `connection-manager.ts`, not just that the WS-specific unit
 * test still passes.
 *
 * `task.steer` is the forcing function for "a handler genuinely throws":
 * `TaskRunner.handleSteer` is the one S->D handler with no try/catch around
 * its session call (cancel/approve/reject all swallow a failing session
 * call and report a terminal message instead) — see `StubSession.steerError`'s
 * own doc comment.
 */
describe('long-poll cursor is not advanced before the handler succeeds (Design A, real @byok/server, long-poll only)', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await real.close();
  });

  it('a polled task.steer whose handler throws leaves the persisted cursor unadvanced; a re-poll redelivers it and only then advances', async () => {
    real = await startRealServerWithoutWebSocket({ productId: 'test-product', longPollHoldMs: 200 });

    const workspaceRoot = await tmpDir('byok-e2e-workspace-');
    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [adapter],
      {
        backoff: { baseMs: 20, maxMs: 50, factor: 2 },
        longPoll: { wsFailureThreshold: 1, wsRetryIntervalMs: 60_000, retryDelayMs: 20, idleDelayMs: 20 },
      },
    );

    const pairing = real.byok.pairing.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();

    // WS never connects — settled via long-poll fallback, matching finding
    // F6's own test (`real-server-longpoll-only.test.ts`).
    expect(daemon.status().connected).toBe(false);
    expect(daemon.status().degraded).toBe(true);
    await vi.waitFor(() => {
      expect(real.byok.machines.list().find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
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
      expect(baseline).toBeTypeOf('number');
    });

    // Force the NEXT steer to throw — a genuine, uncaught handler failure
    // propagating from `StubSession.steer` up through
    // `TaskRunner.handleSteer` -> `handleEnvelope` -> `ConnectionManager.process`.
    session.steerError = new Error('simulated transient steer failure');

    await handle.steer('first attempt');

    // `steerError` is cleared by `steer()` itself the moment it's invoked
    // (whether it throws or not — see `StubSession`'s own doc comment), so
    // waiting for it to clear is proof the failing attempt actually ran.
    await vi.waitFor(() => expect(session.steerError).toBeUndefined());
    expect(session.steerCalls).toHaveLength(0); // it threw before recording the call

    // The persisted cursor must NOT have passed the steer's envelope — still
    // exactly at the pre-steer baseline (the offer's own seq).
    await vi.waitFor(async () => {
      const persisted = await cursorStore.load(real.url, record.deviceId);
      expect(persisted).toBe(baseline);
    });

    // A re-poll must redeliver the SAME task.steer (its task is still
    // Running, non-terminal, and its seq is still > the reported cursor) —
    // this time it succeeds (steerError was already cleared above).
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
});
