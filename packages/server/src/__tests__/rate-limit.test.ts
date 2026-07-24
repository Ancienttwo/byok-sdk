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

/**
 * `RateLimiter.buckets` is a private implementation detail (TS `private` is
 * compile-time-only) — reaching into it directly is the only way to observe
 * idle-eviction sweeps from outside, mirroring `task-lease.test.ts`'s own
 * `taskActivityMap` helper for the same reason. Used only by the
 * constructor-validation and idle-eviction tests below.
 */
function bucketsMap(limiter: RateLimiter): Map<string, { tokens: number; lastRefillMs: number }> {
  return (limiter as unknown as { buckets: Map<string, { tokens: number; lastRefillMs: number }> }).buckets;
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
    // naturally gives it time to refill; mirror that with a Date-only clock
    // jump (all network/WebSocket timers remain real).
    const refillStartedAt = Date.now();
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      // 20/sec => 50ms/token, so 200ms comfortably regenerates the full
      // burst=3 again.
      vi.setSystemTime(refillStartedAt + 200);

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
    } finally {
      vi.useRealTimers();
    }
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
      const refillStartedAt = Date.now();
      try {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(refillStartedAt + 20);
        hub.handleInbound(deviceId, envelope); // succeeds — back under budget

        // Episode 2: flood again — a fresh, distinct embedder event.
        hub.handleInbound(deviceId, envelope);
        hub.handleInbound(deviceId, envelope);
      } finally {
        vi.useRealTimers();
      }

      await vi.waitFor(() => {
        expect(rateLimitedEvents).toHaveLength(2);
      });
    } finally {
      hub.stopLeaseReaper();
    }
  });
});

/**
 * Cross-model review fix (P2, rate-limiter.ts:40): construction previously
 * accepted any `messagesPerSecond`/`burst` value unchecked — `NaN` poisons
 * every subsequent token computation, `0`/negative values either divide by
 * zero or make the bucket permanently empty, and `Infinity` makes the limit
 * never actually engage. All of these are a silently broken/disabled
 * limiter rather than a loud failure, so construction now validates
 * fail-fast instead.
 */
describe('RateLimiter: constructor option validation (fail-fast)', () => {
  it.each([
    ['messagesPerSecond', 'NaN', { messagesPerSecond: NaN }],
    ['messagesPerSecond', 'zero', { messagesPerSecond: 0 }],
    ['messagesPerSecond', 'negative', { messagesPerSecond: -5 }],
    ['messagesPerSecond', 'Infinity', { messagesPerSecond: Infinity }],
    ['burst', 'NaN', { burst: NaN }],
    ['burst', 'zero', { burst: 0 }],
    ['burst', 'negative', { burst: -5 }],
    ['burst', 'Infinity', { burst: Infinity }],
    // Finding R5 (cross-model re-review — F10 residual): 0 < burst < 1 used
    // to pass this validation cleanly, then silently construct a limiter
    // that rejects EVERY message forever for every key (see
    // rate-limiter.ts's own module doc comment: consume()'s debit check
    // can never succeed once the bucket's own ceiling is below 1 token).
    ['burst', '0.5 (between 0 and 1 — silently rejects everything forever, not just "too strict")', { burst: 0.5 }],
    ['burst', 'just under 1 (0.999...)', { burst: 0.999 }],
    ['maxTrackedDevices', 'NaN', { maxTrackedDevices: NaN }],
    ['maxTrackedDevices', 'zero', { maxTrackedDevices: 0 }],
    ['maxTrackedDevices', 'negative', { maxTrackedDevices: -5 }],
    ['maxTrackedDevices', 'Infinity', { maxTrackedDevices: Infinity }],
  ] as const)('throws a TypeError at construction when %s is %s', (_field, _label, opts) => {
    expect(() => new RateLimiter(opts)).toThrow(TypeError);
  });

  it('accepts valid finite positive options — including the all-defaults case and burst exactly at its new minimum (1) — without throwing', () => {
    expect(() => new RateLimiter()).not.toThrow();
    expect(() => new RateLimiter({ messagesPerSecond: 50, burst: 100 })).not.toThrow();
    expect(() => new RateLimiter({ messagesPerSecond: 0.5, burst: 1 })).not.toThrow();
    expect(() => new RateLimiter({ messagesPerSecond: 50, burst: 100, maxTrackedDevices: 5 })).not.toThrow();
  });

  it('finding R5: a burst of exactly 1 actually lets messages through (proving >= 1 is the correct boundary, not merely "no longer throws")', () => {
    const limiter = new RateLimiter({ messagesPerSecond: 1, burst: 1 });
    expect(limiter.consume('device-burst-one')).toBe(true);
    expect(limiter.consume('device-burst-one')).toBe(false); // exactly 1 token, no more until refill
  });
});

/**
 * Cross-model review fix (P2, rate-limiter.ts:40): `buckets` previously held
 * one permanent entry per historical device key for the life of the
 * process — a device that connected once and never again was never cleaned
 * up. These tests drive `RateLimiter` directly (bypassing `ConnectionHub`/
 * the server) with fake timers for full determinism over the internal sweep
 * cadence (`EVICTION_SWEEP_EVERY_N_CALLS` = 1000 calls to `consume()`,
 * across all keys), mirroring the "coalesces" tests above's own "drive it
 * directly" style.
 */
describe('RateLimiter: idle bucket eviction bounds memory', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('evicts idle buckets during a periodic sweep, keeping the map bounded instead of accumulating every historical key forever', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();
    vi.setSystemTime(t0);

    // messagesPerSecond=100, burst=10 => idle-to-full threshold = 100ms: any
    // bucket untouched for >=100ms is guaranteed already refilled to burst
    // (even from 0 tokens), so evicting it is behaviorally invisible — see
    // rate-limiter.ts's own doc comment on `idleEvictionThresholdMs`.
    const limiter = new RateLimiter({ messagesPerSecond: 100, burst: 10 });

    // Wave 1: exactly one sweep cycle's worth (1000) of distinct keys, all
    // created at the same instant t0 -> nothing is idle yet, so the sweep
    // that fires on the wave's last call finds nothing to evict.
    for (let i = 0; i < 1000; i++) {
      limiter.consume(`device-wave1-${i}`);
    }
    expect(bucketsMap(limiter).size).toBe(1000);

    // Move well past the idle threshold, then add a second full wave of
    // 1000 distinct keys. The sweep firing on THIS wave's last call now
    // finds every wave-1 entry idle (1000ms elapsed >> 100ms threshold) and
    // drops them, while wave-2's own entries (just created at t1) survive.
    const t1 = t0 + 1000;
    vi.setSystemTime(t1);
    for (let i = 0; i < 1000; i++) {
      limiter.consume(`device-wave2-${i}`);
    }

    // Bounded to wave 2 alone (1000 entries), not the full historical 2000
    // — wave 1's stale entries were swept away, proving this doesn't just
    // grow forever as distinct keys accumulate over the process lifetime.
    const remaining = bucketsMap(limiter);
    expect(remaining.size).toBe(1000);
    for (let i = 0; i < 1000; i++) {
      expect(remaining.has(`device-wave1-${i}`)).toBe(false);
      expect(remaining.has(`device-wave2-${i}`)).toBe(true);
    }
  });

  it("an evicted key's next consume() succeeds with a full fresh burst, exactly as if it were a never-before-seen key", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();
    vi.setSystemTime(t0);

    const limiter = new RateLimiter({ messagesPerSecond: 100, burst: 3 }); // idle-to-full threshold = 30ms
    const key = 'device-evicted';

    // Exhaust this key's burst completely (calls #1-4 of this instance).
    expect(limiter.consume(key)).toBe(true);
    expect(limiter.consume(key)).toBe(true);
    expect(limiter.consume(key)).toBe(true);
    expect(limiter.consume(key)).toBe(false); // over budget — 0 tokens left

    // Go idle long enough to be trivially full again, then drive the call
    // count the rest of the way to the next sweep boundary (1000 total)
    // with other keys so the periodic sweep actually runs and evicts `key`.
    vi.setSystemTime(t0 + 1000);
    for (let i = 0; i < 999; i++) {
      limiter.consume(`device-filler-${i}`);
    }
    expect(bucketsMap(limiter).has(key)).toBe(false); // confirms the sweep evicted it

    // The next consume() for the evicted key must behave EXACTLY like a
    // fresh full bucket (burst=3) — not remember it was just exhausted, and
    // not come back only partially refilled either.
    expect(limiter.consume(key)).toBe(true);
    expect(limiter.consume(key)).toBe(true);
    expect(limiter.consume(key)).toBe(true);
    expect(limiter.consume(key)).toBe(false); // exactly burst=3 tokens, no more
  });
});

/**
 * Finding R5 (cross-model re-review — F10 residual): the idle sweep above
 * only ever reclaims a bucket once it's gone quiet for
 * `idleEvictionThresholdMs` — a flood of many thousands of genuinely
 * DISTINCT, ACTIVELY-touched keys (arriving faster than any of them ever
 * goes idle) would defeat it and grow `buckets` without bound. A small
 * `maxTrackedDevices` (mirroring the idle-eviction tests' own convention of
 * driving `RateLimiter` directly, bypassing `ConnectionHub`/the server) is
 * used throughout so these tests don't need to actually insert real-world
 * (10,000-default) volumes of keys to exercise the cap.
 */
describe('RateLimiter: hard cap on tracked devices (finding R5)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never lets buckets.size exceed maxTrackedDevices, even under a flood of distinct keys that never go idle', () => {
    const limiter = new RateLimiter({ messagesPerSecond: 100, burst: 10, maxTrackedDevices: 50 });

    for (let i = 0; i < 500; i++) {
      limiter.consume(`device-${i}`);
      expect(bucketsMap(limiter).size).toBeLessThanOrEqual(50); // true after EVERY single insert, not just at the end
    }
    expect(bucketsMap(limiter).size).toBe(50);
  });

  it('evicts the LEAST-RECENTLY-refilled key first once at capacity', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();
    vi.setSystemTime(t0);

    const limiter = new RateLimiter({ messagesPerSecond: 100, burst: 10, maxTrackedDevices: 3 });
    limiter.consume('oldest'); // touched at t0
    vi.setSystemTime(t0 + 10);
    limiter.consume('middle'); // touched at t0+10
    vi.setSystemTime(t0 + 20);
    limiter.consume('newest'); // touched at t0+20
    expect(bucketsMap(limiter).size).toBe(3);

    // A 4th distinct key forces an eviction — must drop "oldest" specifically.
    vi.setSystemTime(t0 + 30);
    limiter.consume('fourth');

    const remaining = bucketsMap(limiter);
    expect(remaining.size).toBe(3);
    expect(remaining.has('oldest')).toBe(false);
    expect(remaining.has('middle')).toBe(true);
    expect(remaining.has('newest')).toBe(true);
    expect(remaining.has('fourth')).toBe(true);
  });

  it("an evicted-at-capacity key's next consume() behaves as fresh — exactly like a never-before-seen key, same as the idle-eviction case above", () => {
    const limiter = new RateLimiter({ messagesPerSecond: 100, burst: 3, maxTrackedDevices: 2 });

    // Exhaust "victim"'s entire burst before it gets evicted.
    expect(limiter.consume('victim')).toBe(true);
    expect(limiter.consume('victim')).toBe(true);
    expect(limiter.consume('victim')).toBe(true);
    expect(limiter.consume('victim')).toBe(false); // 0 tokens left

    limiter.consume('other'); // fills the cap (maxTrackedDevices=2: victim + other)
    limiter.consume('forces-eviction'); // 3rd distinct key -> evicts the least-recently-refilled entry (victim, untouched since its own exhausting calls)
    expect(bucketsMap(limiter).has('victim')).toBe(false);

    // "victim" reappearing must get a FULL fresh burst — not remember it
    // was just exhausted moments ago.
    expect(limiter.consume('victim')).toBe(true);
    expect(limiter.consume('victim')).toBe(true);
    expect(limiter.consume('victim')).toBe(true);
    expect(limiter.consume('victim')).toBe(false); // exactly burst=3 tokens again, no more
  });

  it('the idle sweep and the hard cap compose correctly: idle keys are swept first, so a slow-but-steady stream of distinct keys never needlessly hits the cap-eviction path', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();
    vi.setSystemTime(t0);

    // idle-to-full threshold = (10/100)*1000 = 100ms.
    const limiter = new RateLimiter({ messagesPerSecond: 100, burst: 10, maxTrackedDevices: 1000 });

    for (let i = 0; i < 1000; i++) {
      limiter.consume(`wave1-${i}`);
    }
    expect(bucketsMap(limiter).size).toBe(1000); // at the cap, but via genuinely distinct active keys, not eviction yet

    // Move well past the idle threshold so wave 1 is now stale, then send a
    // second wave — the periodic idle sweep (not the hard-cap eviction)
    // should reclaim wave 1's entries, leaving room for wave 2 without ever
    // exceeding the cap.
    vi.setSystemTime(t0 + 1000);
    for (let i = 0; i < 1000; i++) {
      limiter.consume(`wave2-${i}`);
      expect(bucketsMap(limiter).size).toBeLessThanOrEqual(1000);
    }

    const remaining = bucketsMap(limiter);
    expect(remaining.size).toBe(1000);
    for (let i = 0; i < 1000; i++) {
      expect(remaining.has(`wave1-${i}`)).toBe(false);
      expect(remaining.has(`wave2-${i}`)).toBe(true);
    }
  });
});
