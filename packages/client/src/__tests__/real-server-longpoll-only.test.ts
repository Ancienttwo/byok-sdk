import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_EGRESS_RELIABLE_ACK_CAPABILITY, EVENTS_POLL_NO_HOLD_PARAM } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from '../daemon/connection-manager';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { startRealServer, waitForTaskEvent, type RealServerHandle } from './fixtures/real-server';

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

  /** Records every `GET /byok/events` URL; `respond` may answer one in place of the server. */
  function recordEventPolls(respond?: (pollIndex: number) => Response | undefined): URL[] {
    const nativeFetch = globalThis.fetch;
    const polls: URL[] = [];
    vi.stubGlobal('fetch', ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/byok/events') {
        polls.push(url);
        const injected = respond?.(polls.length - 1);
        if (injected) return Promise.resolve(injected);
      }
      return nativeFetch(input, init);
    }) as typeof fetch);
    return polls;
  }

  const isSettlePoll = (url: URL) => url.searchParams.get(EVENTS_POLL_NO_HOLD_PARAM) === '1';

  it('#384: an idle cold start settles under the DEFAULT long-poll hold and stays connected', async () => {
    // No `longPollHoldMs` and no daemon long-poll overrides: the server holds
    // an empty poll for its ~50s default, five times the 10s settle timeout.
    // Only the no-hold settle poll can settle this idle device in time.
    real = await startRealServer({ productId: 'test-product' });
    const workspaceRoot = await tmpDir('byok-coldstart-workspace-');
    const storeDir = await tmpDir('byok-coldstart-store-');
    const adapter = new StubRuntimeAdapter();
    const polls = recordEventPolls();
    const capabilityReads = vi.spyOn(ConnectionManager.prototype, 'getServerCapabilities');
    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [adapter],
    );
    const record = await daemon.pair((await real.createPairingCode()).code);

    const startedAt = Date.now();
    await daemon.start();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(daemon.status().connected).toBe(true);
    // start()'s capability-gated reliable-egress retry is its last read; it
    // saw the server's advertisement, not the empty pre-settle list.
    expect(capabilityReads.mock.results.at(-1)?.value).toContain(AGENT_EGRESS_RELIABLE_ACK_CAPABILITY);
    expect(isSettlePoll(polls[0]!)).toBe(true);

    // The follow-up poll is an ordinary held one, and holding it does not
    // drop the settled connection on either side.
    await vi.waitFor(() => expect(polls.length).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    expect(polls.slice(1).some(isSettlePoll)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(daemon.status().connected).toBe(true);
    expect((await real.byok.machines.list()).find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    expect(polls.length).toBe(2);

    // Work enqueued during that held poll is still delivered by it.
    const handle = await real.byok.dispatch({ instruction: 'delivered by the held poll' });
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
    expect(polls.slice(1).some(isSettlePoll)).toBe(false);
  }, 15_000);

  it('#384: re-arms the no-hold settle poll after a failed poll under the default hold', async () => {
    real = await startRealServer({ productId: 'test-product' });
    const workspaceRoot = await tmpDir('byok-resettle-workspace-');
    const storeDir = await tmpDir('byok-resettle-store-');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The first held poll fails; the transport withdraws capabilities and reconnects.
    const polls = recordEventPolls((index) => (index === 1 ? new Response('unavailable', { status: 503 }) : undefined));
    const states: string[] = [];
    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter()],
      { longPoll: { retryDelayMs: 20, idleDelayMs: 20 } },
    );
    daemon.subscribe((event) => {
      if (event.kind === 'connection') states.push(event.state);
    });
    await daemon.pair((await real.createPairingCode()).code);
    await daemon.start();

    await vi.waitFor(() => expect(polls.length).toBeGreaterThanOrEqual(3), { timeout: 2_000 });
    expect(polls.slice(0, 3).map(isSettlePoll)).toEqual([true, false, true]);
    await vi.waitFor(() => expect(states).toEqual(['connecting', 'open', 'connecting', 'open']), { timeout: 2_000 });
    expect(daemon.status().connected).toBe(true);
  }, 15_000);

  it('#384: settles only after the start conn.hello is answered, so Agent dispatch is admitted at once', async () => {
    real = await startRealServer({ productId: 'test-product' });
    const workspaceRoot = await tmpDir('byok-hello-gate-workspace-');
    const storeDir = await tmpDir('byok-hello-gate-store-');
    const hostStorageRoot = await tmpDir('byok-hello-gate-home-');
    const nativeFetch = globalThis.fetch;
    let helloAnsweredAt: number | undefined;
    // Hold the first POST (the start conn.hello) well past the no-hold settle poll.
    vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== '/byok/messages' || helloAnsweredAt !== undefined) return nativeFetch(input, init);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const response = await nativeFetch(input, init);
      helloAnsweredAt = Date.now();
      return response;
    }) as typeof fetch);
    daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test',
        productId: 'test-product',
        serverUrl: real.url,
        workspaceRoot,
        storeDir,
        agentHome: { hostStorageRoot },
      },
      [new StubRuntimeAdapter('pi')],
    );
    const record = await daemon.pair((await real.createPairingCode()).code);

    await daemon.start();
    const startedAt = Date.now();
    expect(helloAnsweredAt).toBeDefined();
    expect(startedAt).toBeGreaterThanOrEqual(helloAnsweredAt!);
    // No retry loop: the server already holds the device's Agent capabilities.
    await expect(real.byok.dispatch({
      deviceId: record.deviceId,
      instruction: 'admitted right after start',
      agentRef: { agentId: 'agent-hello-gate', profileRevision: 'profile-1' },
    })).resolves.toBeDefined();
  }, 15_000);

  it('aborts the active held GET when the daemon stops', async () => {
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 5_000 });
    const workspaceRoot = await tmpDir('byok-stop-workspace-');
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
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
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

    const workspaceRoot = await tmpDir('byok-e2e-workspace-');
    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
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
    expect(daemon.status().connected).toBe(true);

    // Wait until the server observes the first events poll before dispatching.
    await vi.waitFor(async () => {
      expect((await real.byok.machines.list()).find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    const handle = await real.byok.dispatch({ instruction: 'do it over long-poll' });

    // Claim/started: proves the offer was received over GET /byok/events and
    // the daemon's outbound reply reached the server over POST /byok/messages
    // (there is no other path for it to have arrived).
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Claimed');
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
    expect(daemon.status().connected).toBe(true); // still true throughout — WS never came up

    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0]!;
    session.emit({ type: 'progress', text: 'working over long-poll' });
    session.emit({ type: 'turn_end' });

    const result = await handle.result();
    expect(result.state).toBe('Complete');
    expect(result.summary).toBe('working over long-poll');

    expect(daemon.status().connected).toBe(true);
  }, 15000);

  it('publishes agent-home-contract over long-poll before Agent dispatch admission', async () => {
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 200 });
    const workspaceRoot = await tmpDir('byok-agent-longpoll-workspace-');
    const storeDir = await tmpDir('byok-agent-longpoll-store-');
    const hostStorageRoot = await tmpDir('byok-agent-longpoll-home-');
    const adapter = new StubRuntimeAdapter('pi');

    daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test',
        productId: 'test-product',
        serverUrl: real.url,
        workspaceRoot,
        storeDir,
        agentHome: { hostStorageRoot },
      },
      [adapter],
      {
        longPoll: { retryDelayMs: 20, idleDelayMs: 20 },
      },
    );

    const record = await daemon.pair((await real.createPairingCode()).code);
    await daemon.start();

    let handle: Awaited<ReturnType<typeof real.byok.dispatch>> | undefined;
    await vi.waitFor(async () => {
      handle = await real.byok.dispatch({
        deviceId: record.deviceId,
        instruction: 'run in the durable Agent home over long-poll',
        agentRef: { agentId: 'agent-longpoll', profileRevision: 'profile-1' },
      });
      expect(handle).toBeDefined();
    }, { timeout: 5000, interval: 20 });

    await waitForTaskEvent(handle!, (event) => event.kind === 'state' && event.state === 'Running');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await expect(handle!.result()).resolves.toMatchObject({ state: 'Complete' });
    expect(adapter.startCalls[0]?.ctx.workspaceDir).toBe(
      path.join(await fs.realpath(hostStorageRoot), 'agents', 'agent-longpoll'),
    );
  }, 15000);
});
