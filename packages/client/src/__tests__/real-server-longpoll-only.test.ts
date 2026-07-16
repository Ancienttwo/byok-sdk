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
 * Finding F6 (long-poll can receive but never send): a full task lifecycle
 * — offer, claim, started, progress, complete — carried entirely over
 * `GET /byok/events` (receive) + `POST /byok/messages` (send), with the WS
 * transport never once connecting. Run against the REAL `@byok/server`
 * (not the client's own `TestServer` stub) via
 * `startRealServerWithoutWebSocket`, which genuinely never wires up the WS
 * upgrade at all — a real WS failure, not a simulated one — so the
 * daemon's ordinary `wsFailureThreshold` fallback drives it into long-poll
 * mode exactly as it would against a real deployment with no reachable WS
 * endpoint.
 */
describe('a full task lifecycle over long-poll only, WS never connects (finding F6, real @byok/server)', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await real.close();
  });

  it('offer -> claim -> started -> progress -> complete all travel over GET /byok/events + POST /byok/messages', async () => {
    // A short longPollHoldMs keeps every GET /byok/events request (and thus
    // teardown) fast — the real default (~50s) is meant for production, not
    // a test that wants prompt polling cadence.
    real = await startRealServerWithoutWebSocket({ productId: 'test-product', longPollHoldMs: 200 });

    const workspaceRoot = await tmpDir('byok-e2e-workspace-');
    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [adapter],
      {
        // Fail over to long-poll after just 1 failed WS attempt so the test
        // doesn't wait through a full default backoff sequence — WS is
        // never going to succeed here regardless (no upgrade handler at all).
        backoff: { baseMs: 20, maxMs: 50, factor: 2 },
        longPoll: { wsFailureThreshold: 1, wsRetryIntervalMs: 60_000, retryDelayMs: 20, idleDelayMs: 20 },
      },
    );

    const pairing = real.byok.pairing.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();

    // WS never connects — the daemon settled via the long-poll fallback path.
    expect(daemon.status().connected).toBe(false);
    expect(daemon.status().degraded).toBe(true);

    // `daemon.start()` settles as soon as the daemon itself commits to
    // long-poll mode, which can be a tick before its first `GET
    // /byok/events` request actually lands at the server (the request is
    // fired-and-forget from `enterLongPoll()`) — the server only marks a
    // device "connected" once that first poll arrives (protocol §8's
    // "conn.hello semantics implicitly" via however the HTTP layer
    // establishes the per-device session). Wait for that explicitly rather
    // than racing `dispatch()` against it.
    await vi.waitFor(() => {
      expect(real.byok.machines.list().find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    const handle = await real.byok.dispatch({ instruction: 'do it over long-poll', policy: { mode: 'auto' } });

    // Claim/started: proves the offer was received over GET /byok/events and
    // the daemon's outbound reply reached the server over POST /byok/messages
    // (there is no other path for it to have arrived).
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Claimed');
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
    expect(daemon.status().connected).toBe(false); // still true throughout — WS never came up

    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0]!;
    session.emit({ type: 'progress', text: 'working over long-poll' });
    session.emit({ type: 'turn_end' });

    const result = await handle.result();
    expect(result.state).toBe('Complete');
    expect(result.summary).toBe('working over long-poll');

    expect(daemon.status().connected).toBe(false);
    expect(daemon.status().degraded).toBe(true);
  }, 15000);
});
