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
 * `@byok/server` + a REAL `@byok/client` daemon in-process (not the
 * lightweight `TestServer` stub the rest of this file's siblings use) —
 * this bug is specifically about the exact interaction between the real
 * server's `sendConnAck`-then-`redeliverAfterReconnect` sequencing (both in
 * `packages/server/src/hub.ts`) and the client's cursor bookkeeping, which a
 * hand-rolled stub server would not reliably reproduce.
 *
 * Root cause (confirmed empirically before fixing — see the task report):
 * `conn.ack` carries a `seq` for schema uniformity (every server->daemon
 * envelope does), and the server always assigns it the NEXT per-device
 * counter value — i.e. higher than any backlog envelope about to be
 * redelivered right after it. The old client code advanced its redelivery
 * cursor from ANY envelope's `seq`, including `conn.ack`'s. So on
 * reconnect: `conn.ack` (high seq) arrives first and wrongly advances the
 * cursor, then the redelivered backlog (lower seqs, sent before the drop)
 * all look already-processed and get silently dropped.
 */
describe('redelivery across a real reconnect (finding F2, real @byok/server + real @byok/client)', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await real.close();
  });

  it('a task.approve sent while the daemon is disconnected is redelivered on reconnect and the task completes', async () => {
    real = await startRealServer({ productId: 'test-product' });

    const workspaceRoot = await tmpDir('byok-e2e-workspace-');
    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter();

    // A short liveness timeout + prompt backoff lets the daemon's own
    // liveness check self-detect a silent connection (rather than needing a
    // server-side "kill this socket" test hook, which the real server does
    // not expose) and reconnect automatically, all within the same daemon
    // instance/process — i.e. a genuine transport drop-and-reconnect, not a
    // process restart (which would also lose the in-flight session this
    // test needs to still be there after reconnecting).
    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [adapter],
      {
        liveness: { timeoutMs: 150, checkIntervalMs: 20 },
        backoff: { baseMs: 150, maxMs: 300, factor: 2 },
      },
    );

    const pairing = real.byok.pairing.createPairingCode();
    await daemon.pair(pairing.code);
    await daemon.start();
    expect(daemon.status().connected).toBe(true);

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

    // Wait for the daemon's own liveness check to notice the (real, silent)
    // connection has gone quiet and drop it — the actual "drop socket
    // mid-task" step, driven by the daemon's real, already-public liveness
    // mechanism rather than a server-side test hook.
    await vi.waitFor(() => expect(daemon?.status().connected).toBe(false), { timeout: 5000 });

    // Approve WHILE disconnected: the server's own state moves immediately
    // (protocol §4 — "server state is authoritative on its own action"),
    // but the `task.approve` envelope has nowhere live to go right now and
    // must sit in the server's per-device outbox for redelivery.
    await handle.approve();

    // Reconnect happens on its own (backoff above); this is exactly the
    // conn.ack-then-backlog sequence finding F2 is about.
    await vi.waitFor(() => expect(daemon?.status().connected).toBe(true), { timeout: 5000 });

    // Proof the redelivered task.approve actually reached the SAME
    // still-alive session (not a fresh one) and resumed it.
    await vi.waitFor(() => expect(session.resolveApprovalCalls).toEqual([{ approved: true }]), { timeout: 5000 });

    session.emit({ type: 'progress', text: 'finishing up' });
    session.emit({ type: 'turn_end' });

    const result = await handle.result();
    expect(result.state).toBe('Complete');
  }, 15000);
});
