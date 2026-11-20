import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INPUT_IMAGES_CAPABILITY } from '@byok-sdk/protocol/constants';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { detectRuntimes } from '../daemon/create-daemon/support';
import { PresencePublisher } from '../daemon/presence-publisher';
import type { AuthManager } from '../daemon/auth-manager';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';
import { testScratchRoot } from './fixtures/execution-scratch';
import * as timerDelay from '../util/timer-delay';

const ALLOW = { state: 'allow' as const, qualifiedVersion: '1.4.0' };
const WARN = { state: 'warn' as const, qualifiedVersion: '1.0.52' };
const BLOCK = { state: 'block' as const, qualifiedVersion: '0.169.0', matched: '0.16.' };

it('bounds concurrent probes and reports every unavailable executor in scan order', async () => {
  const adapters = Array.from({ length: 64 }, (_, index) => new StubRuntimeAdapter(`test-${index}`));
  let active = 0;
  let peak = 0;
  for (const adapter of adapters) {
    vi.spyOn(adapter, 'detect').mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return { kind: 'not-found' };
    });
  }

  const { runtimeUnavailable } = await detectRuntimes(adapters);
  expect(peak).toBe(8);
  expect(runtimeUnavailable.map(({ id }) => id)).toEqual(adapters.map(({ descriptor }) => descriptor.id));
});

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function stubAuth(): AuthManager {
  return {
    getValidAccessToken: async () => 'token-1',
    handleUnauthorized: async () => 'token-2',
  } as unknown as AuthManager;
}

/**
 * #1103 B2b: the daemon's one start snapshot projects onto both discovery
 * surfaces. These tests drive the real detection/projection path (stub
 * adapters through `detectRuntimes`) and a real `conn.hello`, then feed the
 * exact same snapshot to the presence publisher.
 */
describe('conn.hello / presence version-policy and runtime-unavailable projection', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;
  const dirs: string[] = [];

  beforeEach(async () => { server = await TestServer.start(); });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function startDaemon(): Promise<Daemon> {
    const storeDir = await tmpDir('byok-hello-presence-store-');
    dirs.push(storeDir);
    daemon = createDaemonWithAdapters(
      {
        storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Hello Presence',
        productId: 'hello-presence',
        serverUrl: server.url,
        storeDir,
      },
      [
        new StubRuntimeAdapter('pi', { kind: 'available', version: '1.4.0', versionVerdict: ALLOW }),
        new StubRuntimeAdapter('claude', { kind: 'not-found' }),
        new StubRuntimeAdapter('codex', { kind: 'available', version: '0.169.0', versionVerdict: BLOCK }),
        new StubRuntimeAdapter('grok', { kind: 'available', version: '1.0.62', versionVerdict: WARN }),
        new StubRuntimeAdapter('dsh', { kind: 'refused', reason: 'acp_unavailable' }),
        // No policy: the projection must omit the field instead of inventing allow.
        new StubRuntimeAdapter('zeta', { kind: 'available', version: '2.0.0' }),
      ],
    );
    await daemon.pair('pairing-code');
    await daemon.start();
    return daemon;
  }

  it('projects policy states for runtimes and harnesses, and typed causes for failures', async () => {
    await startDaemon();
    const hello = await server.waitFor((event) => event.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');

    const runtimes = new Map((hello.payload.harnesses ?? []).map((runtime) => [runtime.id, runtime]));
    expect(runtimes.get('pi')?.versionPolicy).toEqual(ALLOW);
    expect(runtimes.has('codex')).toBe(false);
    expect(runtimes.has('claude')).toBe(false);
    // A matched spec stays local; the wire carries state + qualified token only.
    expect(JSON.stringify(hello.payload)).not.toContain('"matched"');

    const harnesses = new Map((hello.payload.harnesses ?? []).map((harness) => [harness.id, harness]));
    expect(harnesses.get('grok')?.versionPolicy).toEqual(WARN);
    expect(harnesses.get('zeta')).not.toHaveProperty('versionPolicy');
    expect(harnesses.has('dsh')).toBe(false);

    expect(hello.payload.runtimeUnavailable).toEqual([
      { id: 'claude', cause: 'not_installed', retryable: true },
      { id: 'codex', cause: 'version_blocked', retryable: false },
      { id: 'dsh', cause: 'acp_unavailable', retryable: true },
    ]);
  });

  it.each([false, true])('publishes the new inventory after a scan with an older hello in flight: %s', async holdOldHello => {
    const sleep = timerDelay.abortableSleep;
    const nextScan = Promise.withResolvers<void>();
    const scanTimer = vi.spyOn(timerDelay, 'abortableSleep');
    scanTimer.mockImplementation((ms, signal) => ms === 60_000 ? nextScan.promise : sleep(ms, signal));
    let releaseOldHello: (() => void) | undefined;
    try {
      const adapter = new StubRuntimeAdapter('fixture');
      const storeDir = await tmpDir('byok-rescan-');
      dirs.push(storeDir);
      daemon = createDaemonWithAdapters({
        storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Rescan', productId: 'rescan', serverUrl: server.url, storeDir,
      }, [adapter]);
      await daemon.pair('pairing-code');
      await daemon.start();
      const first = await server.waitFor(event => event.type === 'conn.hello');
      if (first.type !== 'conn.hello') throw new Error('expected conn.hello');
      expect(first.payload).toMatchObject({ harnesses: [{ id: 'fixture' }] });
      expect(first.payload.capabilities).toContain(INPUT_IMAGES_CAPABILITY);
      if (holdOldHello) {
        await vi.waitFor(() => expect(daemon?.status().lifecycle).toEqual({ phase: 'running', connection: 'open' }));
        releaseOldHello = server.holdNextMessagesResponse(event => event.type === 'conn.hello');
        daemon.reloadMcpToolsets({}, daemon.status().toolsets.revision);
        await server.waitFor(event => event.type === 'conn.hello' && event.id !== first.id);
      }
      vi.spyOn(adapter, 'detect').mockResolvedValue({ kind: 'not-found' });
      scanTimer.mockRestore();
      nextScan.resolve();
      await vi.waitFor(() => expect(daemon?.status().runtimes).toMatchObject([{ id: 'fixture', outcome: 'not-found' }]));
      if (holdOldHello) {
        expect(server.received.some(event => event.type === 'conn.hello' && event.payload.harnesses.length === 0)).toBe(false);
      }
      releaseOldHello?.();
      const refreshed = await server.waitFor(event => event.type === 'conn.hello' && event.payload.harnesses.length === 0);
      if (refreshed.type !== 'conn.hello') throw new Error('expected conn.hello');
      expect(refreshed.payload).toMatchObject({
        harnesses: [], runtimeUnavailable: [{ id: 'fixture', cause: 'not_installed', retryable: true }],
      });
      expect(refreshed.payload.capabilities).not.toContain(INPUT_IMAGES_CAPABILITY);
      expect(daemon.status().runtimes).toMatchObject([{ id: 'fixture', outcome: 'not-found' }]);
    } finally {
      releaseOldHello?.();
      scanTimer.mockRestore();
      nextScan.resolve();
    }
  });

  it('advertises image input in the hello that adds a newly available harness', async () => {
    const sleep = timerDelay.abortableSleep;
    const nextScan = Promise.withResolvers<void>();
    const scanTimer = vi.spyOn(timerDelay, 'abortableSleep')
      .mockImplementation((ms, signal) => ms === 60_000 ? nextScan.promise : sleep(ms, signal));
    try {
      const adapter = new StubRuntimeAdapter('fixture', { kind: 'not-found' });
      const storeDir = await tmpDir('byok-rescan-images-');
      dirs.push(storeDir);
      daemon = createDaemonWithAdapters({
        storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Rescan Images', productId: 'rescan-images', serverUrl: server.url, storeDir,
      }, [adapter]);
      await daemon.pair('pairing-code');
      await daemon.start();
      const first = await server.waitFor(event => event.type === 'conn.hello');
      if (first.type !== 'conn.hello') throw new Error('expected conn.hello');
      expect(first.payload.harnesses).toEqual([]);
      expect(first.payload.capabilities).not.toContain(INPUT_IMAGES_CAPABILITY);
      await vi.waitFor(() => expect(daemon?.status().lifecycle).toEqual({ phase: 'running', connection: 'open' }));

      vi.spyOn(adapter, 'detect').mockResolvedValue({ kind: 'available', sessionCapabilities: { images: true } });
      scanTimer.mockRestore();
      nextScan.resolve();
      const refreshed = await server.waitFor(event => event.type === 'conn.hello' && event.id !== first.id);
      if (refreshed.type !== 'conn.hello') throw new Error('expected conn.hello');
      expect(refreshed.payload.harnesses).toMatchObject([{ id: 'fixture', capabilities: { images: true } }]);
      expect(refreshed.payload.capabilities).toContain(INPUT_IMAGES_CAPABILITY);
    } finally {
      scanTimer.mockRestore();
      nextScan.resolve();
    }
  });

  it('publishes the same projection on presence, with harness ids in runtimeUnavailable', async () => {
    await startDaemon();
    const hello = await server.waitFor((event) => event.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');

    const bodies: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    vi.useFakeTimers();
    try {
      const publisher = new PresencePublisher({
        serverUrl: 'https://example.test',
        auth: stubAuth(),
        intervalMs: 30_000,
        harnesses: hello.payload.harnesses,
        runtimeUnavailable: hello.payload.runtimeUnavailable,
      });
      publisher.start();
      await vi.advanceTimersByTimeAsync(0);
      publisher.stop();
    } finally {
      vi.useRealTimers();
      globalThis.fetch = originalFetch;
    }

    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect((body.harnesses as Array<{ id: string; versionPolicy?: unknown }>).map((runtime) => [runtime.id, runtime.versionPolicy]))
      .toEqual([['pi', ALLOW], ['grok', WARN], ['zeta', undefined]]);
    // Presence runtimes stay built-in; runtimeUnavailable is the conn.hello list, harness ids included.
    expect(body.runtimeUnavailable).toEqual(hello.payload.runtimeUnavailable);
  });
});
