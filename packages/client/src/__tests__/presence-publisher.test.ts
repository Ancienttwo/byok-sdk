import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthManager } from '../daemon/auth-manager';
import { DeviceRevokedError } from '../daemon/auth-manager';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { PresencePublisher } from '../daemon/presence-publisher';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { startRealCloud, type RealCloudHandle } from './fixtures/real-cloud';
import { TestServer } from './fixtures/test-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** The two `AuthManager` methods `authedFetch` uses, and nothing else. */
function stubAuth(overrides: Partial<Pick<AuthManager, 'getValidAccessToken' | 'handleUnauthorized'>> = {}): AuthManager {
  return {
    getValidAccessToken: async () => 'token-1',
    handleUnauthorized: async () => 'token-2',
    ...overrides,
  } as unknown as AuthManager;
}

function jsonOk(): Response {
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('PresencePublisher', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('rejects a cadence outside minimumIntervalMs < intervalMs < ttlMs at construction', () => {
    const auth = stubAuth();
    // Faster than the store's throttle: every other beat would come back 429.
    expect(
      () => new PresencePublisher({ serverUrl: 'https://example.test', auth, intervalMs: 4_000, minimumIntervalMs: 5_000, ttlMs: 90_000 }),
    ).toThrow(/minimumIntervalMs < intervalMs < ttlMs/);
    // Slower than the TTL: the device flickers offline between beats.
    expect(
      () => new PresencePublisher({ serverUrl: 'https://example.test', auth, intervalMs: 90_000, minimumIntervalMs: 5_000, ttlMs: 90_000 }),
    ).toThrow(/minimumIntervalMs < intervalMs < ttlMs/);
    expect(
      () => new PresencePublisher({ serverUrl: 'https://example.test', auth, intervalMs: 30_000, minimumIntervalMs: 5_000, ttlMs: 90_000 }),
    ).not.toThrow();
  });

  it('publishes only level online, immediately and then once per interval', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonOk();
    }) as typeof globalThis.fetch;

    const publisher = new PresencePublisher({
      serverUrl: 'wss://example.test/some/path',
      auth: stubAuth(),
      intervalMs: 30_000,
    });
    publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://example.test/byok/presence');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ level: 'online' });
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer token-1');

    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(2);

    publisher.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(2);
  });

  it('publishes configured logical IDs without projecting local MCP definitions', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonOk();
    }) as typeof globalThis.fetch;

    const publisher = new PresencePublisher({
      serverUrl: 'https://example.test',
      auth: stubAuth(),
      intervalMs: 30_000,
      configuredToolsets: ['crm.readonly', 'salesko.connectors'],
    });
    publisher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(bodies).toEqual([
      {
        level: 'online',
        configuredToolsets: ['crm.readonly', 'salesko.connectors'],
      },
    ]);
    expect(JSON.stringify(bodies)).not.toMatch(/command|args|env|header|secret/i);
    publisher.stop();
  });

  it('renews the device token once on a 401 and keeps beating with the new one', async () => {
    const tokens: string[] = [];
    let renewals = 0;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const token = (init?.headers as Record<string, string>).Authorization ?? '';
      tokens.push(token);
      return token === 'Bearer token-1' ? new Response('', { status: 401 }) : jsonOk();
    }) as typeof globalThis.fetch;

    const publisher = new PresencePublisher({
      serverUrl: 'https://example.test',
      auth: stubAuth({
        handleUnauthorized: async () => {
          renewals += 1;
          return 'token-2';
        },
      }),
      intervalMs: 30_000,
    });
    publisher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(renewals).toBe(1);
    expect(tokens).toEqual(['Bearer token-1', 'Bearer token-2']);

    // The cadence survived the renewal: the next beat is still on schedule.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tokens).toHaveLength(4);
  });

  it('stops permanently once the device is revoked, without retry spin', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response('', { status: 401 });
    }) as typeof globalThis.fetch;

    const degraded: string[] = [];
    const publisher = new PresencePublisher({
      serverUrl: 'https://example.test',
      auth: stubAuth({
        handleUnauthorized: async () => {
          throw new DeviceRevokedError();
        },
      }),
      intervalMs: 30_000,
      onDegraded: (reason) => degraded.push(reason),
    });
    publisher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(requests).toBe(1);
    expect(degraded).toEqual(['presence heartbeat stopped: device has been revoked; re-pair required']);

    // No further beat, ever — and a later `start()` cannot resurrect it either.
    await vi.advanceTimersByTimeAsync(300_000);
    publisher.start();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(requests).toBe(1);
  });

  it('stops permanently when a renewed token is still rejected, rather than renewing forever', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response('', { status: 401 });
    }) as typeof globalThis.fetch;

    const degraded: string[] = [];
    let renewals = 0;
    const publisher = new PresencePublisher({
      serverUrl: 'https://example.test',
      auth: stubAuth({
        handleUnauthorized: async () => {
          renewals += 1;
          return 'token-2';
        },
      }),
      intervalMs: 30_000,
      onDegraded: (reason) => degraded.push(reason),
    });
    publisher.start();
    await vi.advanceTimersByTimeAsync(0);

    // Exactly the original request plus `authedFetch`'s one retry, one
    // renewal, and one permanent stop — no third attempt, ever.
    expect(requests).toBe(2);
    expect(renewals).toBe(1);
    expect(degraded).toEqual(['presence heartbeat unauthorized after token renewal (HTTP 401)']);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(requests).toBe(2);
    expect(degraded).toHaveLength(1);
  });

  it('records a failed publish and retries on the next beat rather than escalating', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return requests === 1 ? new Response('', { status: 503 }) : jsonOk();
    }) as typeof globalThis.fetch;

    const degraded: string[] = [];
    const publisher = new PresencePublisher({
      serverUrl: 'https://example.test',
      auth: stubAuth(),
      intervalMs: 30_000,
      onDegraded: (reason) => degraded.push(reason),
    });
    publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(degraded).toEqual(['presence heartbeat failed: HTTP 503']);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(requests).toBe(2);
    expect(degraded).toHaveLength(1);
    publisher.stop();
  });
});

/**
 * The wiring, against the real `@byok-sdk/cloud` composition: whether the
 * daemon publishes at all is decided by the deployment's declaration and
 * nothing else (ADR-010), and stopping the daemon is the only offline signal
 * there is.
 */
describe('daemon presence wiring against the real @byok-sdk/cloud', () => {
  let cloud: RealCloudHandle | undefined;
  let daemon: Daemon | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await daemon?.stop();
    daemon = undefined;
    await cloud?.close();
    cloud = undefined;
  });

  async function startDaemon(
    handle: RealCloudHandle,
  ): Promise<{ daemon: Daemon; adapter: StubRuntimeAdapter; deviceId: string }> {
    const workspaceRoot = await tmpDir('byok-presence-workspace-');
    const storeDir = await tmpDir('byok-presence-store-');
    const adapter = new StubRuntimeAdapter();
    const started = createDaemonWithAdapters(
      {
        productName: 'Test',
        productId: 'test-product',
        serverUrl: handle.url,
        workspaceRoot,
        storeDir,
        presence: { intervalMs: 50, minimumIntervalMs: 10, ttlMs: 2_000 },
      },
      [adapter],
      {
        backoff: { baseMs: 20, maxMs: 50, factor: 2 },
        longPoll: { wsFailureThreshold: 1, wsRetryIntervalMs: 60_000, retryDelayMs: 20, idleDelayMs: 20 },
      },
    );
    const pairing = await handle.createPairingCode();
    const record = await started.pair(pairing.code);
    await started.start();
    return { daemon: started, adapter, deviceId: record.deviceId };
  }

  it('publishes an online hint when the deployment declares presence.hints, and lets it expire after shutdown', async () => {
    cloud = await startRealCloud({
      productId: 'test-product',
      longPollHoldMs: 200,
      longPollIntervalMs: 20,
      presenceTtlMs: 1_000,
      presenceMinimumIntervalMs: 0,
    });
    daemon = (await startDaemon(cloud)).daemon;

    const handle = cloud;
    await vi.waitFor(async () => {
      const hints = await handle.listPresence();
      expect(hints).toHaveLength(1);
      expect(hints[0]?.level).toBe('online');
      expect(hints[0]?.configuredToolsets).toEqual([]);
    });

    // Stopping IS the offline signal: no `offline` publish is issued, the hint
    // simply stops being renewed and its TTL takes it out of every read.
    await daemon.stop();
    daemon = undefined;
    await vi.waitFor(
      async () => {
        expect(await handle.listPresence()).toHaveLength(0);
      },
      { timeout: 5_000 },
    );
  }, 20000);

  it('issues zero presence requests when the deployment does not declare presence.hints', async () => {
    const presenceRequests: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/byok/presence')) presenceRequests.push(url);
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;

    cloud = await startRealCloud({
      productId: 'test-product',
      longPollHoldMs: 200,
      longPollIntervalMs: 20,
      omitCapabilities: ['presence.hints'],
    });
    daemon = (await startDaemon(cloud)).daemon;

    // Several heartbeat intervals' worth of wall clock, with nothing to show
    // for it: the gate is the declaration, not a probe of the route.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(presenceRequests).toEqual([]);
    expect(await cloud.listPresence()).toHaveLength(0);
  }, 20000);

  it('fails closed when the declaration cannot be read: no publishing, daemon otherwise unaffected', async () => {
    const presenceRequests: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/byok/capabilities')) throw new Error('capability discovery is unreachable in this test');
      if (url.includes('/byok/presence')) presenceRequests.push(url);
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;

    cloud = await startRealCloud({ productId: 'test-product', longPollHoldMs: 200, longPollIntervalMs: 20 });
    const started = await startDaemon(cloud);
    daemon = started.daemon;

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(presenceRequests).toEqual([]);
    expect(await cloud.listPresence()).toHaveLength(0);

    // "Otherwise unaffected" proven by real work, not by a transport flag: a
    // full offer -> claim -> complete round trip still travels while discovery
    // is broken, because nothing on the task path ever consults a declaration.
    const handle = cloud;
    const offer = await handle.enqueueOffer(started.deviceId, 'work while discovery is broken');
    await vi.waitFor(() => expect(started.adapter.sessions).toHaveLength(1));
    const session = started.adapter.sessions[0]!;
    session.emit({ type: 'progress', text: 'still working' });
    session.emit({ type: 'turn_end' });
    await vi.waitFor(async () => {
      expect((await handle.readTaskAttempt(offer.taskId))?.status).toBe('complete');
    });
    expect(presenceRequests).toEqual([]);
  }, 20000);
});

/**
 * Re-discovery on reconnect. A declaration is a deployment fact, and a
 * long-lived daemon can outlive a rollout that changes it — so every
 * connection re-settle re-reads it. This is also the ONLY healing path a
 * failed startup discovery gets: no retry timer, by decision.
 *
 * Driven against `TestServer` (a real WS reconnect, which the stateless cloud
 * fixture has no WS half to offer), with only `/byok/capabilities` and
 * `/byok/presence` answered by the interceptor — pairing, renewal and the WS
 * lifecycle are the fixture's own.
 */
describe('presence re-discovery on reconnect', () => {
  let server: TestServer | undefined;
  let daemon: Daemon | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await daemon?.stop();
    daemon = undefined;
    await server?.close();
    server = undefined;
  });

  function declarationResponse(capabilities: string[]): Response {
    return new Response(JSON.stringify({ schema: 'byok-capabilities-v1', version: 1, capabilities }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  interface Intercepted {
    /** Declaration reads so far — the reconnect signal this suite waits on. */
    discoveries: () => number;
    /** Every `PUT /byok/presence` this daemon issued. */
    presenceRequests: () => number;
  }

  function intercept(opts: {
    onDiscovery: (attempt: number) => Response;
    presenceStatus?: number;
  }): Intercepted {
    let discoveries = 0;
    let presenceRequests = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/byok/capabilities')) {
        discoveries += 1;
        return opts.onDiscovery(discoveries);
      }
      if (url.includes('/byok/presence')) {
        presenceRequests += 1;
        return new Response('{}', { status: opts.presenceStatus ?? 200, headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;
    return { discoveries: () => discoveries, presenceRequests: () => presenceRequests };
  }

  async function startDaemon(url: string): Promise<Daemon> {
    const workspaceRoot = await tmpDir('byok-presence-reconnect-workspace-');
    const storeDir = await tmpDir('byok-presence-reconnect-store-');
    const started = createDaemonWithAdapters(
      {
        productName: 'Test',
        productId: 'test-product',
        serverUrl: url,
        workspaceRoot,
        storeDir,
        presence: { intervalMs: 50, minimumIntervalMs: 10, ttlMs: 2_000 },
      },
      [new StubRuntimeAdapter()],
      { backoff: { baseMs: 20, maxMs: 100, factor: 2 } },
    );
    await started.pair('code');
    await started.start();
    return started;
  }

  it('heals a failed startup discovery on the next reconnect', async () => {
    server = await TestServer.start();
    const seen = intercept({
      onDiscovery: (attempt) => {
        if (attempt === 1) throw new Error('capability discovery is unreachable in this test');
        return declarationResponse(['presence.hints']);
      },
    });
    daemon = await startDaemon(server.url);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen.discoveries()).toBe(1);
    expect(seen.presenceRequests()).toBe(0);

    server.dropConnection();
    await vi.waitFor(() => expect(seen.presenceRequests()).toBeGreaterThan(0), { timeout: 5_000 });
  }, 20000);

  it('stops publishing when a reconnect returns a declaration without presence.hints', async () => {
    server = await TestServer.start();
    const seen = intercept({
      onDiscovery: (attempt) => declarationResponse(attempt === 1 ? ['presence.hints'] : ['events.longpoll']),
    });
    daemon = await startDaemon(server.url);

    await vi.waitFor(() => expect(seen.presenceRequests()).toBeGreaterThan(0), { timeout: 5_000 });

    server.dropConnection();
    await vi.waitFor(() => expect(seen.discoveries()).toBeGreaterThanOrEqual(2), { timeout: 5_000 });

    // Let any beat that was already in flight land, then prove the cadence is
    // actually over rather than merely slow.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const settled = seen.presenceRequests();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(seen.presenceRequests()).toBe(settled);
  }, 20000);

  it('keeps the permanent stop latched across a reconnect', async () => {
    server = await TestServer.start();
    // Every publish is rejected even after renewal — the permanent-stop branch.
    const seen = intercept({ onDiscovery: () => declarationResponse(['presence.hints']), presenceStatus: 401 });
    daemon = await startDaemon(server.url);

    await vi.waitFor(() => expect(seen.presenceRequests()).toBe(2), { timeout: 5_000 });

    server.dropConnection();
    await vi.waitFor(() => expect(seen.discoveries()).toBeGreaterThanOrEqual(2), { timeout: 5_000 });

    // The fresh declaration still contains `presence.hints`; the latch, not the
    // declaration, decides — publishing never resumes.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(seen.presenceRequests()).toBe(2);
  }, 20000);
});
