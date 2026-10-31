import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { PresencePublisher } from '../daemon/presence-publisher';
import type { AuthManager } from '../daemon/auth-manager';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';
import { testScratchRoot } from './fixtures/execution-scratch';

const ALLOW = { state: 'allow' as const, qualifiedVersion: '1.4.0' };
const WARN = { state: 'warn' as const, qualifiedVersion: '1.0.52' };
const BLOCK = { state: 'block' as const, qualifiedVersion: '0.160.0', matched: '0.16.' };
// The wire projection carries state + qualified token only.
const WIRE_BLOCK = { state: 'block' as const, qualifiedVersion: '0.160.0' };

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
        new StubRuntimeAdapter('codex', { kind: 'available', version: '0.160.0', versionVerdict: BLOCK }),
        new StubRuntimeAdapter('grok', {
          kind: 'available', version: '1.0.62', versionVerdict: WARN,
          advisory: { reason: 'runtime_version_unqualified', qualifiedVersion: '1.0.52' },
        }),
        new StubRuntimeAdapter('hermes', { kind: 'refused', reason: 'acp_unavailable' }),
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

    expect(hello.payload.capabilities).toContain('runtime-unavailable-cause');

    const runtimes = new Map((hello.payload.runtimes ?? []).map((runtime) => [runtime.id, runtime]));
    expect(runtimes.get('pi')?.versionPolicy).toEqual(ALLOW);
    expect(runtimes.get('codex')?.versionPolicy).toEqual(WIRE_BLOCK);
    expect(runtimes.has('claude')).toBe(false);
    // A matched spec stays local; the wire carries state + qualified token only.
    expect(JSON.stringify(hello.payload)).not.toContain('"matched"');

    const harnesses = new Map((hello.payload.harnesses ?? []).map((harness) => [harness.id, harness]));
    expect(harnesses.get('grok')?.versionPolicy).toEqual(WARN);
    expect(harnesses.get('zeta')).not.toHaveProperty('versionPolicy');
    expect(harnesses.has('hermes')).toBe(false);

    expect(hello.payload.runtimeUnavailable).toEqual([
      { id: 'claude', cause: 'not_installed', retryable: true },
      { id: 'hermes', cause: 'acp_unavailable', retryable: true },
    ]);
    // A blocked runtime is still detected and available; block is not a
    // runtime_unavailable entry.
    expect(hello.payload.runtimeUnavailable?.some((entry) => entry.cause === 'version_blocked')).toBe(false);
  });

  it('publishes the same projection on presence and keeps the RuntimeId domain', async () => {
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
        runtimes: hello.payload.runtimes,
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
    expect((body.runtimes as Array<{ id: string; versionPolicy?: unknown }>).map((runtime) => [runtime.id, runtime.versionPolicy]))
      .toEqual([['pi', ALLOW], ['codex', WIRE_BLOCK]]);
    // harness ids (grok/hermes/zeta) never enter presence; claude's typed
    // failure does, because it is a built-in runtime.
    expect(body.runtimeUnavailable).toEqual([{ id: 'claude', cause: 'not_installed', retryable: true }]);
  });
});
