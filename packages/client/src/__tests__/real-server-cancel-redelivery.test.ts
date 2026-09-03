import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { startRealServer, waitForTaskEvent, type RealServerHandle } from './fixtures/real-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Wave 2 integration test #2: a `task.cancel` for a task the server has
 * ALREADY moved to a terminal state must still be delivered — the one class of
 * server->daemon envelope whose own task is terminal before it is ever
 * delivered, and which therefore has to survive any "this task is done, drop
 * its traffic" filtering (docs/protocol.md §4). Combined here with the
 * client-side redelivery machinery (`ConnectionManager.deliver`/`process`).
 *
 * WP3B Step 2 restates the scenario on the one transport that still exists.
 * The original drop was a WebSocket going silent and reconnecting; over
 * long-poll the equivalent gap is the daemon simply not receiving for a while
 * (`GET /byok/events` failing at the network layer — a genuine transport
 * outage, not a simulated one), with the send half deliberately left alone so
 * the in-flight session is undisturbed. The facts under test are unchanged:
 * dispatch -> claim/start -> the daemon stops receiving -> `handle.cancel()`
 * during the gap (server state moves to `Cancelled` immediately per protocol
 * §4 — "server state is authoritative on its own action" — while the
 * `task.cancel` notification sits un-acked in the device's mailbox) ->
 * receiving resumes -> the delivered `task.cancel` reaches the SAME still-alive
 * session (`session.interrupt()` fired), the task result is `Cancelled`, and
 * the daemon's own resulting `task.cancelled` notification is absorbed
 * idempotently (the server's record is already `Cancelled` by the time it
 * arrives).
 */
describe('a task.cancel sent while the daemon is not polling is delivered when polling resumes and the daemon interrupts the same session (real @byok-sdk/server + real @byok-sdk/client)', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;
  let originalFetch: typeof globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await daemon?.stop();
    await real.close();
  });

  it('resumed polling delivers task.cancel; session.interrupt() fires and the task reaches Cancelled', async () => {
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 200 });

    const workspaceRoot = await tmpDir('byok-e2e-workspace-');
    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [adapter],
      {
        backoff: { baseMs: 20, maxMs: 50, factor: 2 },
        longPoll: { wsFailureThreshold: 1, wsRetryIntervalMs: 60_000, retryDelayMs: 20, idleDelayMs: 20 },
      },
    );

    const pairing = await real.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();
    expect(daemon.status().degraded).toBe(true); // long-poll: the real server serves no WS upgrade
    await vi.waitFor(async () => {
      expect((await real.byok.machines.list()).find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    const handle = await real.byok.dispatch({ instruction: 'a long task to cancel', policy: { mode: 'auto' } });

    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0]!;
    expect(session.interruptCalled).toBe(false); // not yet — nothing has cancelled it

    // Take the RECEIVE half of the transport down: every `GET /byok/events`
    // fails at the network layer, while `POST /byok/messages` is left alone.
    originalFetch = globalThis.fetch;
    let receiveDown = true;
    let blockedPolls = 0;
    // The daemon's own `task.cancelled` report is the observable completion
    // signal for the idempotent-absorption assertion at the end — read off the
    // wire rather than waited out on a timer.
    let reportedCancelled = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (receiveDown && url.includes('/byok/events')) {
        blockedPolls += 1;
        throw new TypeError('simulated network failure — receive path down');
      }
      if (url.includes('/byok/messages') && typeof init?.body === 'string') {
        const body = JSON.parse(init.body) as { messages: Array<{ type: string }> };
        reportedCancelled += body.messages.filter((message) => message.type === 'task.cancelled').length;
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;

    // Prove the gap is real before cancelling through it.
    await vi.waitFor(() => expect(blockedPolls).toBeGreaterThan(0));

    // Cancel WHILE the daemon is not receiving: the server's own state moves
    // to Cancelled immediately (protocol §4), but `task.cancel` has nowhere to
    // go right now and must sit un-acked in the device's mailbox — a task
    // whose own record is ALREADY terminal at the moment its notification is
    // finally delivered.
    await handle.cancel('no longer needed');
    expect((await real.byok.tasks.get(handle.taskId))?.state).toBe('Cancelled');
    expect(session.interruptCalled).toBe(false); // it cannot have arrived yet

    // Receiving resumes; the daemon's own retry loop picks the poll back up.
    receiveDown = false;

    // Proof the delivered task.cancel actually reached the SAME still-alive
    // session (not a fresh one) and interrupted it — despite its own task
    // having been terminal server-side the whole time it sat queued.
    await vi.waitFor(() => expect(session.interruptCalled).toBe(true), { timeout: 5000 });

    const result = await handle.result();
    expect(result.state).toBe('Cancelled');

    // The daemon's own task.cancelled — sent in response to processing the
    // delivered task.cancel — arrives at a server whose record is already
    // Cancelled: an idempotent no-op ack (protocol §3.3), not an error. Wait
    // for that report to actually go out on the wire (the real completion
    // signal), then assert the record neither changed nor errored.
    await vi.waitFor(() => expect(reportedCancelled).toBeGreaterThan(0), { timeout: 5000 });
    expect((await real.byok.tasks.get(handle.taskId))?.state).toBe('Cancelled');
  }, 15000);
});
