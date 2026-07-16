import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { startRealServerWithDeferredWebSocket, waitForTaskEvent, type DeferredWebSocketServerHandle } from './fixtures/real-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Wave 2 integration test #4 (finding N4, Design B): envelopes queued while
 * long-polling must reach the server exactly once even when WS recovers
 * mid-flight — a transport switch must never strand anything sitting in the
 * outbound queue.
 *
 * Before this wave, `WsTransport` and `LongPollClient` each held their OWN
 * private outbox; a mode switch (`ConnectionManager.exitLongPoll`) never
 * moved anything from one to the other, so anything queued while
 * long-polling and not yet flushed was silently abandoned the moment WS took
 * over. `ConnectionManager` now owns the single shared outbox both
 * transports drain from (`drainOutbox`), re-invoked on `onAcked`,
 * `enterLongPoll`, and `exitLongPoll` — a switch just changes which
 * transport the NEXT drain iteration routes through.
 *
 * Forces the scenario deterministically against the REAL `@byok/server`:
 * start long-poll-only (`startRealServerWithDeferredWebSocket`, WS upgrade
 * not yet wired up — a genuine WS failure, not simulated), block EVERY
 * `POST /byok/messages` at the fetch layer so the daemon's outbound
 * `task.claim`/`task.started` sit retrying in `drainOutbox`'s backoff loop
 * (genuinely "mid-flight, not yet delivered"), then call
 * `enableWebSocket()` and let the daemon's periodic WS-recovery probe pick
 * it up — proving the stuck items drain over WS once it becomes the active
 * transport, without ever being duplicated or lost (dedup, Wave 1, is what
 * makes "exactly once" observable: if a resend of an ALREADY-delivered
 * envelope reached the server too, it would be silently absorbed as a
 * duplicate rather than corrupting task state).
 */
describe('outbound envelopes queued while long-polling are not stranded when WS recovers mid-flight (Design B, finding N4, real @byok/server)', () => {
  let real: DeferredWebSocketServerHandle;
  let daemon: Daemon | undefined;
  let originalFetch: typeof globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await daemon?.stop();
    await real.close();
  });

  it('every envelope queued while long-polling still reaches the server exactly once after WS recovers mid-drain', async () => {
    real = await startRealServerWithDeferredWebSocket({ productId: 'test-product', longPollHoldMs: 200 });

    const workspaceRoot = await tmpDir('byok-e2e-workspace-');
    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [adapter],
      {
        backoff: { baseMs: 20, maxMs: 50, factor: 2 },
        longPoll: { wsFailureThreshold: 1, wsRetryIntervalMs: 150, retryDelayMs: 30, idleDelayMs: 20 },
      },
    );

    const pairing = real.byok.pairing.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();

    // WS never connects yet (deferred) — settled via long-poll fallback.
    expect(daemon.status().connected).toBe(false);
    expect(daemon.status().degraded).toBe(true);
    await vi.waitFor(() => {
      expect(real.byok.machines.list().find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    // Block every outbound send while long-polling: the daemon's own
    // task.claim/task.started for the dispatch below will sit in
    // ConnectionManager's shared outbox, retrying against a POST that keeps
    // failing — i.e. genuinely "queued, mid-flight, not yet delivered".
    originalFetch = globalThis.fetch;
    let blockSends = true;
    let blockedAttempts = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (blockSends && url.includes('/byok/messages')) {
        blockedAttempts += 1;
        throw new TypeError('simulated network failure — send path down');
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;

    const handle = await real.byok.dispatch({ instruction: 'queued while degraded', policy: { mode: 'auto' } });

    // Prove we're genuinely mid-flight: at least one send attempt has
    // already failed against the blocked fetch, and the task has NOT yet
    // reached the server (still Offered, since task.claim never landed).
    await vi.waitFor(() => expect(blockedAttempts).toBeGreaterThan(0));
    expect(real.byok.tasks.get(handle.taskId)?.state).toBe('Offered');

    // Now let WS become available server-side. Deliberately KEEP the
    // long-poll send path blocked here — WS connects over a raw socket
    // upgrade, not `fetch`, so it's unaffected — this is what forces the
    // still-queued claim/started envelopes to drain over the newly-recovered
    // WS rather than winning a race against the long-poll retry loop finally
    // succeeding on its own. The daemon's periodic wsRetryIntervalMs probe
    // (150ms) picks up WS shortly; once acked, `drainOutbox` re-checks
    // `this.mode` and switches to routing through it.
    real.enableWebSocket();

    await vi.waitFor(() => expect(daemon?.status().degraded).toBe(false), { timeout: 5000 });
    expect(daemon.status().connected).toBe(true);

    // Only now unblock the send path — by this point `mode==='ws'`, so
    // nothing further routes through the (still-would-be-blocked) long-poll
    // POST path anyway; this just restores normal fetch behavior for
    // anything else the rest of the test/teardown needs.
    blockSends = false;

    // Every queued envelope reached the server exactly once: the task
    // progresses cleanly through Claimed -> Running (proving BOTH
    // task.claim and task.started arrived), with exactly one adapter
    // session/start call — no duplication from the earlier failed attempts.
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Claimed');
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
    expect(adapter.startCalls).toHaveLength(1);
    expect(adapter.sessions).toHaveLength(1);

    const session = adapter.sessions[0]!;
    session.emit({ type: 'progress', text: 'done after recovery' });
    session.emit({ type: 'turn_end' });

    const result = await handle.result();
    expect(result.state).toBe('Complete');
    expect(result.summary).toBe('done after recovery');
  }, 15000);
});
