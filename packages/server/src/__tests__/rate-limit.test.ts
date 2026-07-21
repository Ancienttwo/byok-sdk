import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import type { WebSocket } from 'ws';
import { DeviceRegistry } from '../auth';
import { ConnectionHub } from '../hub';
import { createByokServer } from '../index';
import { RateLimiter } from '../rate-limiter';
import { InMemoryTaskStore } from '../task-store';
import {
  claimAndStart,
  connectFakeDaemon,
  connectFakeDaemonWs,
  pairFakeDaemon,
  send,
  startServer,
  stopServer,
  waitForServerEvent,
  waitForTaskEvent,
} from './test-support';

const PRODUCT_ID = 'acme';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mirrors `integration.test.ts`'s identical helper — resolves once `socket` actually closes, with its close code/reason. */
function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

/**
 * M4 Phase 4 (part A): `ConnectionHub`'s per-device inbound-envelope token
 * bucket (`rate-limiter.ts`), enforced at the single `handleInbound` choke
 * point both WS and long-poll traffic pass through. Every test picks a
 * small, fast-refilling `rateLimit` config so the relevant behavior is
 * deterministic well within normal CI scheduling jitter — see each test's
 * own comment for the specific margin reasoning.
 */
describe('M4 Phase 4: per-device inbound rate limiting (part A)', () => {
  let server: HttpServer | undefined;
  let sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) ws.terminate();
    sockets = [];
    if (server) await stopServer(server);
    server = undefined;
  });

  it('sustained-rate traffic (comfortably at/under the configured rate) is never rate-limited and never disconnects the device', async () => {
    // messagesPerSecond=1000 means ~1 token/ms; a 5ms real sleep between
    // sends regenerates ~5 tokens against only 1 consumed, so the bucket
    // only grows (capped at burst) regardless of CI scheduling jitter —
    // slower-than-expected wall-clock time only ever means MORE refill,
    // never less, so this can't flake toward a false rate-limit trip.
    const byok = createByokServer({ productId: PRODUCT_ID, rateLimit: { messagesPerSecond: 1000, burst: 10 } });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    sockets.push(daemon.ws);

    const handle = await byok.dispatch({ instruction: 'sustained rate' });
    await claimAndStart(daemon.ws, daemon.deviceId, handle);

    for (let i = 0; i < 25; i++) {
      send(
        daemon.ws,
        createEnvelope('task.progress', { seq: i + 1, events: [{ type: 'progress', text: `tick-${i}` }] }, { taskId: handle.taskId }),
      );
      await sleep(5);
    }
    await waitForTaskEvent(handle, (e) => e.kind === 'agent' && e.event.type === 'progress' && e.event.text === 'tick-24');

    expect(byok.stats().rateLimitEvents).toBe(0);
    expect(byok.machines.list().find((m) => m.deviceId === daemon.deviceId)?.connected).toBe(true);
  });

  it('burst exceed disconnects the WS connection and emits a device.rate_limited event with deviceId + at — never a silent drop', async () => {
    // burst=3, messagesPerSecond=5 (slow refill, 1 token/200ms): sending 8
    // envelopes back-to-back in a synchronous loop takes microseconds, so
    // essentially zero refill happens mid-burst — the first 3 always
    // succeed and the rest are deterministically rate-limited regardless of
    // CI speed.
    const byok = createByokServer({ productId: PRODUCT_ID, rateLimit: { messagesPerSecond: 5, burst: 3 } });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    sockets.push(daemon.ws);

    const handle = await byok.dispatch({ instruction: 'burst' });
    const closePromise = waitForClose(daemon.ws);

    for (let i = 0; i < 8; i++) {
      send(daemon.ws, createEnvelope('task.claim', { deviceId: daemon.deviceId }, { taskId: handle.taskId }));
    }

    const rateLimitedEvent = await waitForServerEvent(byok, (e) => e.kind === 'device.rate_limited');
    expect(rateLimitedEvent).toMatchObject({ kind: 'device.rate_limited', deviceId: daemon.deviceId, at: expect.any(String) });

    const closed = await closePromise;
    expect(closed.code).toBe(1008);
    expect(closed.reason).toBe('rate limit exceeded');

    expect(byok.stats().rateLimitEvents).toBeGreaterThan(0);
    // The one claim that got through before the limit tripped still landed.
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Claimed');
  });

  it('recovers after reconnect: the device is not permanently bricked — a fresh connection resumes normal traffic once tokens refill', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID, rateLimit: { messagesPerSecond: 20, burst: 3 } });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    const daemon = await connectFakeDaemon(started.baseUrl, started.port, code, { productId: PRODUCT_ID });
    sockets.push(daemon.ws);

    const handle = await byok.dispatch({ instruction: 'recovers after reconnect' });
    const closePromise = waitForClose(daemon.ws);
    for (let i = 0; i < 6; i++) {
      send(daemon.ws, createEnvelope('task.claim', { deviceId: daemon.deviceId }, { taskId: handle.taskId }));
    }
    await closePromise;
    expect(byok.tasks.get(handle.taskId)?.state).toBe('Claimed'); // the first (in-budget) claim landed

    // The bucket persists across reconnect BY DESIGN (see rate-limiter.ts's
    // own doc comment) — a real client's backoff+reconnect delay is what
    // naturally gives it time to refill; mirror that with a short real wait
    // (20/sec => 50ms/token, so 200ms comfortably regenerates the full
    // burst=3 again).
    await sleep(200);

    const reconnected = await connectFakeDaemonWs(started.port, {
      deviceId: daemon.deviceId,
      accessToken: daemon.accessToken,
      productId: PRODUCT_ID,
    });
    sockets.push(reconnected.ws);

    // A fresh envelope on the new connection must be accepted normally, not
    // immediately re-rate-limited/disconnected.
    send(reconnected.ws, createEnvelope('task.started', {}, { taskId: handle.taskId }));
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
    expect(byok.machines.list().find((m) => m.deviceId === daemon.deviceId)?.connected).toBe(true);
  });

  it('long-poll device gets an HTTP 429 (not a silent 200) once its budget is exhausted, matching the transport\'s existing {error} response shape', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID, rateLimit: { messagesPerSecond: 5, burst: 3 } });
    const started = await startServer(byok);
    server = started.server;
    const { code } = byok.pairing.createPairingCode();
    // No WS/long-poll connection needed at all — handleInbound's rate-limit
    // gate runs before any taskStore lookup, so a bogus taskId is enough to
    // exercise it purely over POST /byok/messages.
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);

    const envelopes = Array.from({ length: 6 }, () =>
      createEnvelope('task.claim', { deviceId: 'unused' }, { taskId: 'task_bogus' }),
    );

    const res = await fetch(`${started.baseUrl}/byok/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ messages: envelopes }),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body).toHaveProperty('error');
    expect(byok.stats().rateLimitEvents).toBeGreaterThan(0);
  });

  it('isolates rate limits per device: device A flooding past its burst never throttles device B', async () => {
    const byok = createByokServer({ productId: PRODUCT_ID, rateLimit: { messagesPerSecond: 5, burst: 3 } });
    const started = await startServer(byok);
    server = started.server;

    const codeA = byok.pairing.createPairingCode().code;
    const deviceA = await connectFakeDaemon(started.baseUrl, started.port, codeA, { productId: PRODUCT_ID, deviceName: 'device-a' });
    sockets.push(deviceA.ws);
    const codeB = byok.pairing.createPairingCode().code;
    const deviceB = await connectFakeDaemon(started.baseUrl, started.port, codeB, { productId: PRODUCT_ID, deviceName: 'device-b' });
    sockets.push(deviceB.ws);

    const handleA = await byok.dispatch({ instruction: 'flood', deviceId: deviceA.deviceId });
    const handleB = await byok.dispatch({ instruction: 'untouched', deviceId: deviceB.deviceId });

    const closeA = waitForClose(deviceA.ws);
    for (let i = 0; i < 8; i++) {
      send(deviceA.ws, createEnvelope('task.claim', { deviceId: deviceA.deviceId }, { taskId: handleA.taskId }));
    }
    await closeA;
    expect(byok.stats().rateLimitEvents).toBeGreaterThan(0);

    // Device B was never touched — full burst still available, no
    // disconnect, and its own task proceeds completely normally.
    await claimAndStart(deviceB.ws, deviceB.deviceId, handleB);
    expect(byok.tasks.get(handleB.taskId)?.state).toBe('Running');
    expect(byok.machines.list().find((m) => m.deviceId === deviceB.deviceId)?.connected).toBe(true);
  });

  /**
   * Gatekeeper LOW advisory: a single flood can call `handleInbound` (and
   * therefore `handleRateLimited`) many times in a row for one device —
   * without coalescing, an embedder subscribed to `events.subscribe()`
   * would see one `device.rate_limited` event per hit for what is really
   * ONE ongoing episode. Driven directly against `ConnectionHub`
   * (mirroring `task-lease.test.ts`'s own "drive the hub directly" style)
   * for full determinism — no WS-close-timing races, every call is
   * synchronous.
   */
  it('coalesces to ONE device.rate_limited embedder event per over-budget episode, while stats().rateLimitEvents keeps counting every single hit', async () => {
    const taskStore = new InMemoryTaskStore();
    const rateLimiter = new RateLimiter({ messagesPerSecond: 5, burst: 3 });
    const hub = new ConnectionHub(taskStore, new DeviceRegistry(), 30 * 60_000, rateLimiter);
    try {
      const deviceId = 'device-coalesce-1';
      const fakeWs = { close: () => {}, send: () => {} } as unknown as WebSocket;
      hub.registerConnection(deviceId, fakeWs, undefined);

      const rateLimitedEvents: unknown[] = [];
      void (async () => {
        for await (const event of hub.subscribeServerEvents()) {
          if (event.kind === 'device.rate_limited') rateLimitedEvents.push(event);
        }
      })();

      const envelope = createEnvelope('task.claim', { deviceId }, { taskId: 'bogus-task-coalesce' });
      // 10 calls against burst=3: the first 3 succeed (rate-limiter-wise),
      // the remaining 7 all hit the limit — 7 raw hits, but they're all
      // the SAME continuous episode (nothing in between ever succeeds).
      for (let i = 0; i < 10; i++) {
        hub.handleInbound(deviceId, envelope);
      }

      await vi.waitFor(() => {
        expect(rateLimitedEvents.length).toBeGreaterThanOrEqual(1);
      });

      expect(hub.stats().rateLimitEvents).toBe(7); // every hit counted
      expect(rateLimitedEvents).toHaveLength(1); // coalesced to exactly one embedder event
    } finally {
      hub.stopLeaseReaper();
    }
  });

  it('a NEW over-budget episode (after the device genuinely recovers under budget in between) gets its own fresh device.rate_limited event, not coalesced with the earlier one', async () => {
    const taskStore = new InMemoryTaskStore();
    // Fast refill (1000/s) + tiny burst (1) so a single real-time wait
    // reliably lets the device "recover" (one token regenerates) between
    // the two flood episodes, deterministically.
    const rateLimiter = new RateLimiter({ messagesPerSecond: 1000, burst: 1 });
    const hub = new ConnectionHub(taskStore, new DeviceRegistry(), 30 * 60_000, rateLimiter);
    try {
      const deviceId = 'device-coalesce-2';
      const fakeWs = { close: () => {}, send: () => {} } as unknown as WebSocket;
      hub.registerConnection(deviceId, fakeWs, undefined);

      const rateLimitedEvents: unknown[] = [];
      void (async () => {
        for await (const event of hub.subscribeServerEvents()) {
          if (event.kind === 'device.rate_limited') rateLimitedEvents.push(event);
        }
      })();

      const envelope = createEnvelope('task.claim', { deviceId }, { taskId: 'bogus-task-coalesce-2' });

      // Episode 1: burst=1, so call #1 succeeds and call #2 floods.
      hub.handleInbound(deviceId, envelope);
      hub.handleInbound(deviceId, envelope);
      await vi.waitFor(() => expect(rateLimitedEvents).toHaveLength(1));

      // Let the bucket refill (1000/s — a few ms is plenty) so the NEXT
      // call genuinely succeeds, clearing the coalescing suppression.
      await new Promise((resolve) => setTimeout(resolve, 20));
      hub.handleInbound(deviceId, envelope); // succeeds — back under budget

      // Episode 2: flood again — a fresh, distinct embedder event.
      hub.handleInbound(deviceId, envelope);
      hub.handleInbound(deviceId, envelope);

      await vi.waitFor(() => {
        expect(rateLimitedEvents).toHaveLength(2);
      });
    } finally {
      hub.stopLeaseReaper();
    }
  });
});
