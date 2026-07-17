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
 * Wave 2 integration test #3: a `POST /byok/messages` whose response is
 * lost/fails exactly once must be safely retried with the SAME batch (same
 * envelope `id`s — `ConnectionManager.drainOutbox` never rebuilds an
 * envelope on resend, finding F1) so the server's per-(deviceId,id) dedup
 * (Wave 1's `ConnectionHub.handleInbound`) makes the resend a no-op replay,
 * not a second application — exactly-once processing despite an
 * at-least-once send.
 *
 * Targets the `task.await_approval` POST specifically (rather than just
 * "the first POST ever"): this is the riskiest point to get wrong — if a
 * retry ever rebuilt the envelope (a fresh `id`), the server's dedup window
 * would not recognize the resend, and depending on timing could apply a
 * `task.await_approval` "twice" (idempotent no-op per §9's own guard in
 * `onAwaitApproval`, but only IF the id matches its own first delivery) or
 * otherwise let the task limp into an inconsistent state instead of a clean
 * `AwaitApproval -> Running -> Complete` progression.
 *
 * Run against the REAL `@byok/server`, forced long-poll-only
 * (`startRealServerWithoutWebSocket`) so every daemon->server envelope
 * genuinely travels over `POST /byok/messages`. The "lost response" is
 * simulated by monkey-patching `globalThis.fetch` to fail exactly the first
 * POST whose body contains a `task.await_approval` envelope, then
 * delegating to the real fetch for everything else (including the retry).
 */
describe('a lost/failed long-poll POST is retried with the identical batch, exactly-once server-side (Design B, real @byok/server, long-poll only)', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;
  let originalFetch: typeof globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await daemon?.stop();
    await real.close();
  });

  it('the retried POST carries the same envelope ids as the failed attempt, and the task reaches Complete via a clean AwaitApproval, not Failed', async () => {
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
    expect(daemon.status().degraded).toBe(true);
    await vi.waitFor(() => {
      expect(real.byok.machines.list().find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    // Intercept fetch: fail exactly the first POST to /byok/messages whose
    // body contains a task.await_approval envelope (network-level failure —
    // "response lost"), record every attempt's envelope ids, then restore
    // normal behavior (including for the retry).
    originalFetch = globalThis.fetch;
    let failedOnce = false;
    const attemptsByIds: string[][] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const isMessagesPost = url.includes('/byok/messages') && typeof init?.body === 'string';
      if (isMessagesPost && init?.body && (init.body as string).includes('task.await_approval')) {
        const body = JSON.parse(init.body as string) as { messages: Array<{ id: string }> };
        attemptsByIds.push(body.messages.map((m) => m.id));
        if (!failedOnce) {
          failedOnce = true;
          throw new TypeError('simulated network failure — response lost');
        }
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;

    const handle = await real.byok.dispatch({ instruction: 'needs a human to say go', policy: { mode: 'confirm' } });

    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0]!;

    session.emit({ type: 'needs_approval', summary: 'about to do the risky thing' });

    // Must still reach AwaitApproval despite the first POST attempt failing
    // — proving the retry landed and was accepted, not silently dropped or
    // force-failed via an illegal-transition/duplicate-id mismatch.
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'AwaitApproval');
    expect(real.byok.tasks.get(handle.taskId)?.state).toBe('AwaitApproval'); // NOT Failed

    // Exactly one failed attempt, and the retry resent the IDENTICAL batch
    // (same ids, same length) — never rebuilt via a fresh createEnvelope
    // call (finding F1).
    await vi.waitFor(() => expect(attemptsByIds.length).toBeGreaterThanOrEqual(2));
    expect(attemptsByIds[1]).toEqual(attemptsByIds[0]);

    // Restore normal fetch before the rest of the lifecycle, so approve/
    // progress/complete aren't affected by the interception any further.
    globalThis.fetch = originalFetch;

    await handle.approve();
    await vi.waitFor(() => expect(session.resolveApprovalCalls).toEqual([{ approved: true }]), { timeout: 5000 });

    session.emit({ type: 'progress', text: 'finishing up' });
    session.emit({ type: 'turn_end' });

    const result = await handle.result();
    expect(result.state).toBe('Complete');
    // No double progress: the summary reflects the single 'finishing up'
    // progress event exactly once, not duplicated by a retried resend.
    expect(result.summary).toBe('finishing up');
  }, 15000);
});
