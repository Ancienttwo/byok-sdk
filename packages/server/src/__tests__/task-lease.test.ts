import type { Server as HttpServer } from 'node:http';
import { createEnvelope } from '@byok/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { DeviceRegistry } from '../auth';
import { ConnectionHub } from '../hub';
import { createByokServer } from '../index';
import { InMemoryTaskStore } from '../task-store';
import type { TaskHandle } from '../types';
import { connectFakeDaemon, nextEnvelope, send, startServer, stopServer, waitForTaskEvent } from './test-support';

/**
 * A `ConnectionHub`'s `taskActivity` map is a private implementation detail
 * (TS `private` is compile-time-only) — reaching into it directly is the
 * only way to observe {@link ConnectionHub}'s per-task activity bookkeeping
 * from outside, since `createByokServer`'s public `ByokServer` surface
 * doesn't expose the hub. Used only by the "activity map" tests below.
 */
function taskActivityMap(hub: ConnectionHub): Map<string, number> {
  return (hub as unknown as { taskActivity: Map<string, number> }).taskActivity;
}

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

  it('does not reap immediately on disconnect merely because task activity was already stale while connected — the dark clock restarts from disconnect, not from stale pre-disconnect activity (regression: this would reintroduce the M0 disconnect-alone-fails-the-task bug)', async () => {
    // Drives `ConnectionHub` directly instead of the real WS/HTTP harness
    // the other tests in this file use — mirrors `heartbeat.test.ts`'s own
    // fake-socket approach — so `vi.useFakeTimers()` can precisely position
    // the disconnect relative to the reaper's sweep tick. The real-WS
    // harness can't give that precision (see this file's header comment on
    // why fake timers don't mix with real sockets); a real-timer version of
    // this test would be unavoidably racy against the sweep's own tick
    // phase.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let hub: ConnectionHub | undefined;
    try {
      const taskStore = new InMemoryTaskStore();
      hub = new ConnectionHub(taskStore, new DeviceRegistry(), SHORT_LEASE_MS);
      const deviceId = 'device-idle-then-dark';
      const fakeWs = { send: vi.fn() } as unknown as WebSocket;

      hub.registerConnection(deviceId, fakeWs, undefined);
      const handle = await hub.dispatch({ instruction: 'idle then disconnect', deviceId });
      const { taskId } = handle;
      hub.handleInbound(deviceId, createEnvelope('task.claim', { deviceId }, { taskId }));
      hub.handleInbound(deviceId, createEnvelope('task.started', {}, { taskId }));
      expect(taskStore.get(taskId)?.state).toBe('Running');

      // The device stays CONNECTED but goes idle well past taskLeaseMs —
      // the "long idle" half of the bug report. Condition (b) (dark) is
      // false the whole time (live WS), so this alone must never reap, no
      // matter how stale the task's own activity timestamp gets.
      await vi.advanceTimersByTimeAsync(SHORT_LEASE_MS * 2.9);
      expect(taskStore.get(taskId)?.state).toBe('Running');

      // NOW the device goes dark, shortly before the reaper's next
      // scheduled sweep tick — the "then disconnect" half. The task's own
      // last-activity timestamp is already ~2.9x taskLeaseMs stale at this
      // exact instant: precisely the precondition the bug describes.
      hub.handleDisconnect(deviceId, fakeWs);

      // Advance just past that next tick. The buggy implementation reaps
      // right here: `isDeviceDark` flips true the instant `connected` does,
      // with no elapsed-time floor of its own, and the already-stale
      // activity timestamp alone satisfies the old (c)-only check. The
      // fix must NOT have reaped yet — under 1x taskLeaseMs has elapsed
      // since the device actually went dark.
      await vi.advanceTimersByTimeAsync(SHORT_LEASE_MS);
      expect(taskStore.get(taskId)?.state).toBe('Running');

      // Once a full taskLeaseMs has genuinely elapsed since disconnect, the
      // reaper must still fire — this is a correctly-delayed reap, not a
      // permanently blocked one.
      await vi.advanceTimersByTimeAsync(SHORT_LEASE_MS);
      expect(taskStore.get(taskId)?.state).toBe('Failed');
      expect(taskStore.get(taskId)?.result).toEqual({ state: 'Failed', reason: 'lease-expired', retryable: true });
    } finally {
      hub?.stopLeaseReaper();
      vi.useRealTimers();
    }
  });

  it('bounds the lease activity map: an unknown taskId is never recorded, and a stale message for an already-terminal task does not recreate its (already-deleted) entry', async () => {
    // Drives `ConnectionHub` directly — `taskActivityMap`'s doc comment
    // above explains why (the private map isn't reachable at all through
    // `createByokServer`'s public surface).
    const taskStore = new InMemoryTaskStore();
    const hub = new ConnectionHub(taskStore, new DeviceRegistry(), SHORT_LEASE_MS);
    try {
      const deviceId = 'device-activity-bounds';
      const fakeWs = { send: vi.fn() } as unknown as WebSocket;
      hub.registerConnection(deviceId, fakeWs, undefined);

      const handle = await hub.dispatch({ instruction: 'bounds check', deviceId });
      const { taskId } = handle;
      hub.handleInbound(deviceId, createEnvelope('task.claim', { deviceId }, { taskId }));
      // Sanity baseline: a real, non-terminal, currently-claimed task IS
      // tracked — the fix must not break the normal case.
      expect(taskActivityMap(hub).has(taskId)).toBe(true);

      // (1) A taskId that never existed at all must never gain an entry —
      // otherwise an authenticated-but-malicious daemon could grow this map
      // without bound, since taskIds (unlike envelope ids) are never
      // deduped.
      const unknownTaskId = 'task_never-existed';
      hub.handleInbound(deviceId, createEnvelope('task.progress', { seq: 1, events: [] }, { taskId: unknownTaskId }));
      expect(taskActivityMap(hub).has(unknownTaskId)).toBe(false);

      // (2) Drive the real task to a terminal state — its entry must be
      // gone (already true pre-fix, via onStateChange's own cleanup).
      hub.handleInbound(deviceId, createEnvelope('task.started', {}, { taskId }));
      hub.handleInbound(deviceId, createEnvelope('task.complete', { summary: 'done', sessionRef: 'sess_bounds' }, { taskId }));
      expect(taskStore.get(taskId)?.state).toBe('Complete');
      expect(taskActivityMap(hub).has(taskId)).toBe(false);

      // (3) A stale message arriving *after* the task is terminal (a fresh
      // envelope id, so it isn't just a dedup no-op) must not recreate the
      // entry `onStateChange` already deleted — this is what fails pre-fix,
      // since `dispatchToHandler` used to record activity unconditionally,
      // before the per-type handler's own terminal-state check ever runs.
      hub.handleInbound(
        deviceId,
        createEnvelope('task.complete', { summary: 'done (stale retry)', sessionRef: 'sess_bounds' }, { taskId }),
      );
      expect(taskActivityMap(hub).has(taskId)).toBe(false);
    } finally {
      hub.stopLeaseReaper();
    }
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
