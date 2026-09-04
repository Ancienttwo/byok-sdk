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
 * Finding F2 (redelivery dead on reconnect), tested against the REAL
 * `@byok-sdk/server` + a REAL `@byok-sdk/client` daemon in-process (not the
 * lightweight `TestServer` stub the rest of this file's siblings use) —
 * this bug is specifically about the exact interaction between the real
 * server's delivery sequencing and the client's cursor bookkeeping, which a
 * hand-rolled stub server would not reliably reproduce.
 *
 * WP3B Step 2 restates the scenario on the one transport that still exists.
 * The original root cause was handshake-shaped: `conn.ack` carries a `seq` higher than
 * any backlog envelope about to be redelivered right after it, and the old
 * client advanced its cursor from ANY envelope's seq, so the reconnect ack
 * wrongly skipped the backlog. Over long-poll the daemon has no `conn.ack`
 * at all — the equivalent gap is the daemon simply not receiving for a while
 * (`GET /byok/events` failing at the network layer, a genuine transport
 * outage, not a simulated one) — but the FACT under test is the same one and
 * is the reason the finding mattered: a server-side action taken while the
 * daemon is not receiving must still reach it, in full, once it is receiving
 * again, and must land on the SAME still-alive session rather than a fresh one.
 *
 * The send path is deliberately left untouched by the interception: only the
 * receive half goes dark, so the task's own in-flight state is undisturbed
 * and the only thing under test is delivery of the envelope enqueued during
 * the gap.
 */
describe('redelivery across a real receive outage (finding F2, real @byok-sdk/server + real @byok-sdk/client)', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;
  let originalFetch: typeof globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await daemon?.stop();
    await real.close();
  });

  it('a task.approve sent while the daemon is not polling is delivered when polling resumes, and the task completes', async () => {
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 200 });

    const workspaceRoot = await tmpDir('byok-e2e-workspace-');
    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [adapter],
      {
        longPoll: { retryDelayMs: 20, idleDelayMs: 20 },
      },
    );

    const pairing = await real.createPairingCode();
    const record = await daemon.pair(pairing.code);
    await daemon.start();
    await vi.waitFor(async () => {
      expect((await real.byok.machines.list()).find((m) => m.deviceId === record.deviceId)?.connected).toBe(true);
    });

    const handle = await real.byok.dispatch({
      instruction: 'do a thing that needs approval',
      policy: { mode: 'confirm' },
    });

    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Claimed');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0]!;

    session.emit({ type: 'needs_approval', summary: 'about to do the risky thing' });
    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'AwaitApproval');
    expect(session.resolveApprovalCalls).toHaveLength(0); // not yet — nothing has approved it

    // Take the RECEIVE half of the transport down: every `GET /byok/events`
    // fails at the network layer (the daemon's own long-poll retry loop keeps
    // trying against it), while `POST /byok/messages` is left alone. This is
    // the long-poll shape of "the daemon is not receiving right now" — a real
    // failure the transport must recover from on its own, not a test hook on
    // the server.
    originalFetch = globalThis.fetch;
    let receiveDown = true;
    let blockedPolls = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (receiveDown && url.includes('/byok/events')) {
        blockedPolls += 1;
        throw new TypeError('simulated network failure — receive path down');
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;

    // Prove the gap is real before acting through it: at least one poll has
    // already failed, so nothing the server enqueues from here can have been
    // delivered on an in-flight request that predates the outage.
    await vi.waitFor(() => expect(blockedPolls).toBeGreaterThan(0));

    // Approve WHILE the daemon is not receiving: the server's own state moves
    // immediately (protocol §4 — "server state is authoritative on its own
    // action"), but the `task.approve` envelope has nowhere to go right now
    // and must sit un-acked in the device's mailbox until a poll succeeds.
    await handle.approve();
    expect(session.resolveApprovalCalls).toHaveLength(0); // still nothing — it cannot have arrived

    // Receiving resumes; the daemon's own retry loop picks the poll back up.
    receiveDown = false;

    // Proof the queued task.approve actually reached the SAME still-alive
    // session (not a fresh one) and resumed it.
    await vi.waitFor(() => expect(session.resolveApprovalCalls).toEqual([{ approved: true }]), { timeout: 5000 });

    session.emit({ type: 'progress', text: 'finishing up' });
    session.emit({ type: 'turn_end' });

    const result = await handle.result();
    expect(result.state).toBe('Complete');
  }, 15000);
});
