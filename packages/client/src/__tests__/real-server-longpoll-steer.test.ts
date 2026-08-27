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
 * S0/H-010 — the positive long-poll steer path, end to end against the REAL
 * `@byok-sdk/server`, over a transport that has no WebSocket at all.
 *
 * This is the regression the D-4 amendment exists for, and the one test that
 * would have caught the original design before it shipped. S0's steer gate
 * fails closed unless the server holds a claim-time capability snapshot saying
 * `steer: true`. That snapshot was first sourced from
 * `conn.hello.runtimes[].capabilities`. At D-4 that snapshot existed only on
 * WS, which disabled the long-poll deployment surface. Long-poll now also
 * publishes `conn.hello`, but the task-level authority remains
 * `task.claim.capabilities`: it identifies the adapter that actually claimed
 * this task and every transport sends it.
 *
 * Deliberately end-to-end rather than a hub unit test: the whole point is that
 * the capability survives the REAL long-poll round trip — adapter
 * `capabilities()` -> `task.claim.capabilities` -> `POST /byok/messages` ->
 * `onClaim` snapshot -> gate -> `GET /byok/events` -> the daemon's own
 * `task.steer` handler -> `session.steer`. A test that reached into the hub
 * would have passed against the broken design too. The server-side structural
 * guard (`packages/server`'s `steer-runtime-capability-gate.test.ts`, the
 * "connection-advertised capabilities cannot feed the steer gate" block)
 * covers the same invariant from the other side.
 */
describe('S0/H-010: task.steer over a pure long-poll transport (no WebSocket, real @byok-sdk/server)', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await real.close();
  });

  it('a steer-capable adapter claiming over long-poll is steerable: the capability rides task.claim and the steer reaches the session', async () => {
    real = await startRealServerWithoutWebSocket({ productId: 'test-product', longPollHoldMs: 150 });

    const workspaceRoot = await tmpDir('byok-e2e-workspace-');
    const storeDir = await tmpDir('byok-e2e-store-');
    // Default stub capabilities include `steer: true` — an honest self-report
    // from an adapter that really does implement `Session.steer`.
    const adapter = new StubRuntimeAdapter();
    expect(adapter.descriptor.capabilities.steer).toBe(true);

    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [adapter],
      {
        backoff: { baseMs: 20, maxMs: 50, factor: 2 },
        longPoll: { wsFailureThreshold: 1, wsRetryIntervalMs: 60_000, retryDelayMs: 20, idleDelayMs: 20 },
      },
    );

    const pairing = real.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();

    await vi.waitFor(() => {
      expect(real.byok.machines.list().find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    const handle = await real.byok.dispatch({ instruction: 'run over long-poll', policy: { mode: 'auto' } });
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0]!;

    // The claim really did carry the adapter's self-report across the long-poll
    // round trip — and it is the adapter's own value, not a server-side guess:
    // `runtime` is undefined here (a custom adapter id has no `RuntimeId` to
    // name it), so there was nothing for the server to infer a default from.
    const snapshot = real.byok.tasks.get(handle.taskId);
    expect(snapshot?.claimedRuntime).toBeUndefined();
    expect(snapshot?.claimedRuntimeCapabilities).toEqual({
      steer: true,
      resume: true,
      approvalInteractive: true,
      mcpToolsets: true,
      permissionModes: adapter.descriptor.capabilities.permissionModes,
    });

    // The gate opens: no SteerRejectedError, and the envelope survives the
    // long-poll delivery all the way into the session.
    await expect(handle.steer('keep going')).resolves.toBeUndefined();

    await vi.waitFor(() => expect(session.steerCalls).toEqual(['keep going']));
    expect(session.steerAttempts).toBe(1);

    // A steer that landed must not also stall the cursor: give the long-poll
    // loop several more cycles and confirm the envelope was acked, not redelivered.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(session.steerCalls).toEqual(['keep going']);

    session.emit({ type: 'turn_end' });
    const result = await handle.result();
    expect(result.state).toBe('Complete');
  }, 15000);

  it('the same long-poll daemon with a NON-steerable adapter is refused server-side, and no task.steer is ever delivered', async () => {
    // The fail-closed half, over the same transport: nothing about long-poll
    // makes the gate permissive — it reads the same claim-carried self-report
    // and refuses when that report says `steer: false`.
    real = await startRealServerWithoutWebSocket({ productId: 'test-product', longPollHoldMs: 150 });

    const workspaceRoot = await tmpDir('byok-e2e-workspace-');
    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter('stub', { present: true, version: '0.0.0' }, {
      steer: false,
      resume: true,
      approvalInteractive: false,
      permissionModes: ['auto', 'readonly'],
    });

    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [adapter],
      {
        backoff: { baseMs: 20, maxMs: 50, factor: 2 },
        longPoll: { wsFailureThreshold: 1, wsRetryIntervalMs: 60_000, retryDelayMs: 20, idleDelayMs: 20 },
      },
    );

    const pairing = real.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();

    await vi.waitFor(() => {
      expect(real.byok.machines.list().find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    const handle = await real.byok.dispatch({ instruction: 'run over long-poll', policy: { mode: 'auto' } });
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0]!;

    expect(real.byok.tasks.get(handle.taskId)?.claimedRuntimeCapabilities?.steer).toBe(false);

    const err = await handle.steer('please stop').catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('steer_unsupported_runtime');

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(session.steerAttempts).toBe(0);

    session.emit({ type: 'turn_end' });
    const result = await handle.result();
    expect(result.state).toBe('Complete');
  }, 15000);
});
