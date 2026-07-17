import type { Server as HttpServer } from 'node:http';
import { createEnvelope } from '@byok/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createByokServer } from '../index';
import type { TaskHandle } from '../types';
import { connectFakeDaemon, nextEnvelope, send, startServer, stopServer, waitForTaskEvent } from './test-support';

const PRODUCT_ID = 'acme';
/**
 * A short injected `taskLeaseMs` for these tests. Real timers (not fake) are
 * used throughout, mirroring the small real waits already established
 * elsewhere in this suite (e.g. `integration.test.ts`'s redelivery test) —
 * fake timers don't mix well with the real WS/HTTP sockets these tests also
 * need, since the reaper's own sweep interval, the fake daemon's socket
 * events, and `handle.result()`'s async queue would all need to be
 * hand-synchronized against a manually-advanced clock. `ConnectionHub`'s
 * sweep-tick resolution self-scales to `min(taskLeaseMs, 30_000)`, so a
 * short lease like this one is swept at its own granularity, not the
 * production 30s default.
 */
const SHORT_LEASE_MS = 200;

/** Claim + start a dispatched task over `ws` (Offered -> Claimed -> Running) and wait for the Running event. */
async function claimAndStart(ws: WebSocket, deviceId: string, handle: TaskHandle): Promise<void> {
  send(ws, createEnvelope('task.claim', { deviceId }, { taskId: handle.taskId }));
  send(ws, createEnvelope('task.started', {}, { taskId: handle.taskId }));
  await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Task lease / stalled reaper (M2, Decision: `Failed(retryable:true,
 * reason:'lease-expired')` on dark-device timeout — no new task state, no
 * new wire message). See `ConnectionHub`'s "task-lease reaper" doc comment
 * in `hub.ts` for the full design this exercises.
 */
describe('task lease reaper (M2): Claimed/Running/AwaitApproval -> Failed(retryable:true, reason:lease-expired) on dark-device timeout', () => {
  let server: HttpServer | undefined;
  let ws: WebSocket | undefined;

  afterEach(async () => {
    ws?.terminate();
    if (server) await stopServer(server);
    server = undefined;
    ws = undefined;
  });

  it('reaps a Running task once its device goes dark (disconnects) and stays silent past taskLeaseMs', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID, taskLeaseMs: SHORT_LEASE_MS });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'never finishes' });
    await nextEnvelope(ws); // offer
    await claimAndStart(ws, daemon.deviceId, handle);

    // The device goes permanently dark: terminate and never reconnect.
    ws.terminate();
    ws = undefined;

    // handle.result() only resolves once something drives the task
    // terminal — here, nothing but the reaper's own background sweep can do
    // that, so this resolving at all proves the reaper fired.
    const result = await handle.result();
    expect(result).toEqual({ state: 'Failed', reason: 'lease-expired', retryable: true });
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Failed');

    // The embedder sees the normal terminal event through the same feed as
    // any other fail — not a bespoke shape.
    const events = [];
    for await (const event of handle.events()) events.push(event);
    expect(events.at(-1)).toEqual({ kind: 'state', state: 'Failed', at: expect.any(String) });
  });

  it('does not reap while task.progress keeps arriving past the nominal TTL window (activity resets the per-task lease)', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID, taskLeaseMs: SHORT_LEASE_MS });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'long running task' });
    await nextEnvelope(ws); // offer
    await claimAndStart(ws, daemon.deviceId, handle);

    // Keep sending progress at an interval comfortably inside the lease
    // window, for a total duration well past it — each one must reset the
    // per-task clock, so the task should never go dark-and-silent for a
    // full taskLeaseMs even though wall-clock time run well exceeds it.
    const tickMs = Math.floor(SHORT_LEASE_MS / 4);
    const totalTicks = 10; // 10 * tickMs ~= 2.5x SHORT_LEASE_MS
    for (let i = 0; i < totalTicks; i++) {
      await sleep(tickMs);
      send(
        ws,
        createEnvelope(
          'task.progress',
          { seq: i + 1, events: [{ type: 'progress', text: `tick-${i}` }] },
          { taskId: handle.taskId },
        ),
      );
    }
    await waitForTaskEvent(handle, (e) => e.kind === 'agent' && e.event.type === 'progress' && e.event.text === 'tick-9');

    // Give the reaper's own sweep at least one more chance to run after the
    // last activity before asserting — proves the task is genuinely
    // protected, not merely "hasn't been checked yet".
    await sleep(SHORT_LEASE_MS);

    expect(byok.tasks.get(handle.taskId)?.state).toBe('Running');
  });

  it('does not reap a connected-but-idle device merely because the TTL window elapsed — dark (disconnected) is required, not mere idleness', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID, taskLeaseMs: SHORT_LEASE_MS });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    ws = daemon.ws;

    const handle = await byok.dispatch({ instruction: 'a normal slow turn' });
    await nextEnvelope(ws); // offer
    await claimAndStart(ws, daemon.deviceId, handle);

    // No further task.* activity at all — but the device's WS connection
    // stays open (no terminate/disconnect). Wait comfortably past several
    // TTL windows: condition (b) (device dark) must never hold here, so the
    // task must survive regardless of how long (c) alone would allow.
    await sleep(SHORT_LEASE_MS * 5);

    expect(byok.tasks.get(handle.taskId)?.state).toBe('Running');
  });

  it('the reaper sweep timer is cleaned up on server stop (no lingering handle)', () => {
    vi.useFakeTimers();
    try {
      // No HTTP/WS is started for this test — createByokServer() alone
      // already starts the reaper's own setInterval (in ConnectionHub's
      // constructor), and nothing else in server construction schedules a
      // timer, so this is an isolated, deterministic count.
      const byok = createByokServer({ productId: PRODUCT_ID, taskLeaseMs: SHORT_LEASE_MS });
      expect(vi.getTimerCount()).toBe(1);

      byok.stop();
      expect(vi.getTimerCount()).toBe(0);

      // Calling stop() again must be a safe no-op, not a throw.
      expect(() => byok.stop()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
