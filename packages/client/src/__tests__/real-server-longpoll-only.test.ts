import { testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { type RealServerHandle, startRealServer, submitAgentTask, waitForTaskResult, waitForTaskState } from './fixtures/real-server';
import { OPEN_LIFECYCLE, waitForDaemonOpen } from './fixtures/lifecycle-barrier';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Finding F6 (long-poll can receive but never send): a full task lifecycle
 * — offer, claim, started, progress, complete — carried entirely over
 * `GET /byok/events` (receive) + `POST /byok/messages` (send). Run against
 * the real `@byok-sdk/server` (not the client's own `TestServer` stub) via
 * `startRealServer`.
 */
describe('a full task lifecycle over long-poll (finding F6, real @byok-sdk/server)', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await daemon?.stop();
    await real.close();
  });

  /** Records every `GET /byok/events` URL and every `POST /byok/messages` batch; `respond` may answer a poll in place of the server. */
  function recordTraffic(respond?: (pollIndex: number) => Response | undefined): {
    polls: URL[];
    posts: Array<{ types: string[] }>;
    failedPolls: () => number;
  } {
    const nativeFetch = globalThis.fetch;
    const polls: URL[] = [];
    const posts: Array<{ types: string[] }> = [];
    let failed = 0;
    vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/byok/messages' && typeof init?.body === 'string') {
        const body = JSON.parse(init.body) as { messages: Array<{ type: string }> };
        posts.push({ types: body.messages.map((message) => message.type) });
      }
      if (url.pathname === '/byok/events') {
        polls.push(url);
        const injected = respond?.(polls.length - 1);
        if (injected) return injected;
        const response = await nativeFetch(input, init);
        if (!response.ok) failed += 1;
        return response;
      }
      return nativeFetch(input, init);
    }) as typeof fetch);
    return { polls, posts, failedPolls: () => failed };
  }

  it('#391: an idle cold start opens under the DEFAULT long-poll hold and stays open past it', async () => {
    // No `longPollHoldMs` and no daemon long-poll overrides: the server holds
    // an empty poll for its ~50s default. Readiness is the accepted handshake
    // `conn.hello`, so it does not wait for a poll at all.
    real = await startRealServer({ productId: 'test-product' });
    const storeDir = await tmpDir('byok-coldstart-store-');
    const adapter = new StubRuntimeAdapter();
    const traffic = recordTraffic();
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, storeDir, agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY } },
      [adapter],
    );
    const record = await daemon.pair((await real.createPairingCode()).code);

    const startedAt = Date.now();
    await daemon.start();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await waitForDaemonOpen(daemon, 5_000);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(daemon.status().lifecycle).toEqual(OPEN_LIFECYCLE);
    // The session opened with a lone handshake hello.
    expect(traffic.posts[0]).toEqual({ types: ['conn.hello'] });

    // Work dispatched after open is delivered promptly by the held poll.
    const dispatchedAt = Date.now();
    const heldTask = await submitAgentTask(real, { taskId: 'task-held-poll', deviceId: record.deviceId, instruction: 'delivered by the held poll' });
    await waitForTaskState(real, heldTask, 'Running');
    expect(Date.now() - dispatchedAt).toBeLessThan(1_500);
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await waitForTaskResult(real, heldTask);

    // Past one full default hold: still open on both sides, and no poll failed.
    await new Promise((resolve) => setTimeout(resolve, 56_000));
    expect(daemon.status().lifecycle).toEqual(OPEN_LIFECYCLE);
    expect((await real.byok.machines.list()).find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    expect(traffic.failedPolls()).toBe(0);
    expect(traffic.posts.filter((post) => post.types.includes('conn.hello'))).toHaveLength(1);
  }, 75_000);

  it('#391: every reconnect after a failed route handshakes with a fresh conn.hello before anything else', async () => {
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 200 });
    const storeDir = await tmpDir('byok-resettle-store-');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The second poll fails; the session drops back to connecting and reconnects.
    const traffic = recordTraffic((index) => (index === 1 ? new Response('unavailable', { status: 503 }) : undefined));
    const lifecycles: unknown[] = [];
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, storeDir, agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY } },
      [new StubRuntimeAdapter()],
      { longPoll: { retryDelayMs: 20, idleDelayMs: 20 } },
    );
    daemon.subscribe((event) => {
      if (event.kind === 'lifecycle') lifecycles.push(event.lifecycle);
    });
    await daemon.pair((await real.createPairingCode()).code);
    await daemon.start();

    const connecting = { phase: 'running', connection: 'connecting' };
    await vi.waitFor(() => expect(lifecycles).toEqual([connecting, OPEN_LIFECYCLE, connecting, OPEN_LIFECYCLE]), { timeout: 5_000 });
    expect(daemon.status().lifecycle).toEqual(OPEN_LIFECYCLE);
    // Two sessions, each opened by a lone hello: the first POST of each.
    const hellos = traffic.posts.filter((post) => post.types.includes('conn.hello'));
    expect(hellos).toEqual([{ types: ['conn.hello'] }, { types: ['conn.hello'] }]);
    expect(traffic.posts[0]).toEqual({ types: ['conn.hello'] });
  }, 15_000);

  it('#391: opens only once the conn.hello is accepted, so Agent dispatch is admitted at once', async () => {
    real = await startRealServer({ productId: 'test-product' });
    const storeDir = await tmpDir('byok-hello-gate-store-');
    const hostStorageRoot = await tmpDir('byok-hello-gate-home-');
    const nativeFetch = globalThis.fetch;
    let helloAnsweredAt: number | undefined;
    // Hold the first POST (the handshake conn.hello) for a while.
    vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== '/byok/messages' || helloAnsweredAt !== undefined) return nativeFetch(input, init);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const response = await nativeFetch(input, init);
      helloAnsweredAt = Date.now();
      return response;
    }) as typeof fetch);
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test',
        productId: 'test-product',
        serverUrl: real.url,
        storeDir,
        agentHome: { hostStorageRoot },
        agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
      },
      [new StubRuntimeAdapter('pi')],
    );
    const record = await daemon.pair((await real.createPairingCode()).code);

    await daemon.start();
    // start() does not wait for the server (#391).
    expect(helloAnsweredAt).toBeUndefined();
    await waitForDaemonOpen(daemon, 5_000);
    const openedAt = Date.now();
    expect(helloAnsweredAt).toBeDefined();
    expect(openedAt).toBeGreaterThanOrEqual(helloAnsweredAt!);
    // No retry loop: the server already holds the device's Agent capabilities.
    await expect(real.byok.executions.submit({
      taskId: 'task-hello-gate',
      deviceId: record.deviceId,
      payload: {
        session: { mode: 'fresh' },
        instruction: 'admitted right after open',
        runtime: 'pi',
        agentRef: { agentId: 'agent-hello-gate', profileRevision: 'profile-1' },
        egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
        terminalProjection: { mode: 'none' },
      },
    })).resolves.toBeDefined();
  }, 15_000);

  it('aborts the active held GET when the daemon stops', async () => {
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 5_000 });
    const storeDir = await tmpDir('byok-stop-store-');
    const adapter = new StubRuntimeAdapter();
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nativeFetch = globalThis.fetch;
    let activePollSignal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', ((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/byok/events')) activePollSignal = init?.signal;
      return nativeFetch(input, init);
    }) as typeof fetch);

    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, storeDir, agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY } },
      [adapter],
      {
        longPoll: { retryDelayMs: 20, idleDelayMs: 20 },
      },
    );

    const pairing = await real.createPairingCode();
    await daemon.pair(pairing.code);
    await daemon.start();
    await vi.waitFor(() => expect(activePollSignal).toBeDefined());
    expect(activePollSignal?.aborted).toBe(false);

    await daemon.stop();
    daemon = undefined;
    expect(activePollSignal?.aborted).toBe(true);
    expect(warnings.mock.calls.some((call) => String(call[0]).includes('/byok/events failed'))).toBe(false);
  }, 15_000);

  it('offer -> claim -> started -> progress -> complete all travel over GET /byok/events + POST /byok/messages', async () => {
    // A short longPollHoldMs keeps every GET /byok/events request (and thus
    // teardown) fast — the real default (~50s) is meant for production, not
    // a test that wants prompt polling cadence.
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 200 });

    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, storeDir, agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY } },
      [adapter],
      {
        // Keep retry delays short for the test.
        longPoll: { retryDelayMs: 20, idleDelayMs: 20 },
      },
    );

    const pairing = await real.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();

    // The daemon settled through the long-poll path.
    await waitForDaemonOpen(daemon);
    expect(daemon.status().lifecycle).toEqual(OPEN_LIFECYCLE);

    // Wait until the server observes the first events poll before dispatching.
    await vi.waitFor(async () => {
      expect((await real.byok.machines.list()).find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    const taskId = await submitAgentTask(real, { taskId: 'task-over-long-poll', deviceId: record.deviceId, instruction: 'do it over long-poll' });

    // Running (after claim and started): proves the offer was received over
    // GET /byok/events and the daemon's outbound replies reached the server
    // over POST /byok/messages (there is no other path for them to have
    // arrived).
    await waitForTaskState(real, taskId, 'Running');
    expect(daemon.status().lifecycle).toEqual(OPEN_LIFECYCLE); // still true throughout — WS never came up

    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0]!;
    session.emit({ type: 'progress', text: 'working over long-poll' });
    session.emit({ type: 'turn_end' });

    const result = await waitForTaskResult(real, taskId);
    expect(result.state).toBe('Complete');
    expect(result.summary).toBe('working over long-poll');

    expect(daemon.status().lifecycle).toEqual(OPEN_LIFECYCLE);
  }, 15000);

  it('publishes agent-home-contract over long-poll before Agent dispatch admission', async () => {
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 200 });
    const storeDir = await tmpDir('byok-agent-longpoll-store-');
    const hostStorageRoot = await tmpDir('byok-agent-longpoll-home-');
    const adapter = new StubRuntimeAdapter('pi');

    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test',
        productId: 'test-product',
        serverUrl: real.url,
        storeDir,
        agentHome: { hostStorageRoot },
        agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
      },
      [adapter],
      {
        longPoll: { retryDelayMs: 20, idleDelayMs: 20 },
      },
    );

    const record = await daemon.pair((await real.createPairingCode()).code);
    await daemon.start();

    // Fresh Agent execution has one entry (#470/#484). A refused submit writes
    // nothing, so the same host-owned taskId is retried until admission.
    const taskId = 'task-agent-longpoll';
    await vi.waitFor(async () => {
      expect(await real.byok.executions.submit({
        taskId,
        deviceId: record.deviceId,
        payload: {
          session: { mode: 'fresh' },
          instruction: 'run in the durable Agent home over long-poll',
          runtime: 'pi',
          agentRef: { agentId: 'agent-longpoll', profileRevision: 'profile-1' },
          egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
          terminalProjection: { mode: 'none' },
        },
      })).toMatchObject({ taskId });
    }, { timeout: 5000, interval: 20 });

    await vi.waitFor(async () => expect((await real.byok.tasks.get(taskId))?.state).toBe('Running'), { timeout: 10_000, interval: 20 });
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(async () => expect((await real.byok.tasks.get(taskId))?.result).toMatchObject({ state: 'Complete' }), { timeout: 10_000, interval: 20 });
    expect(adapter.startCalls[0]?.ctx.workspaceDir).toBe(
      path.join(await fs.realpath(hostStorageRoot), 'agents', 'agent-longpoll'),
    );
  }, 15000);
});
