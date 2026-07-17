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
 * Wave 2 integration test #2: proves the end-to-end path Wave 1's server-side
 * fix (exempting `task.cancel`/`task.reject` from the terminal-task
 * redelivery filter — see `hub.ts`'s `OutboxEntry.redeliverThroughTerminal`
 * and docs/protocol.md §4) combines correctly with this wave's client-side
 * redelivery machinery (`ConnectionManager.deliver`/`process`).
 *
 * Mirrors `real-server-redelivery.test.ts` (finding F2, `task.approve`)
 * exactly, but for cancel: dispatch -> claim/start -> drop the socket (the
 * daemon's own liveness check, a genuine transport drop, not a simulated
 * one) -> `handle.cancel()` while disconnected (server state moves to
 * `Cancelled` immediately per protocol §4 — "server state is authoritative
 * on its own action" — the `task.cancel` notification has nowhere live to
 * go and must sit in the server's per-device outbox) -> reconnect ->
 * assert the redelivered `task.cancel` reached the SAME still-alive
 * session (`session.interrupt()` fired), the task result is `Cancelled`,
 * and the daemon's own resulting `task.cancelled` notification is absorbed
 * idempotently (the server's record is already `Cancelled` by the time it
 * arrives — see `hub.ts`'s `onCancelled` dual-purpose doc comment).
 */
describe('a task.cancel sent while disconnected is redelivered on reconnect and the daemon interrupts the same session (real @byok/server + real @byok/client)', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await real.close();
  });

  it('reconnect redelivers task.cancel; session.interrupt() fires and the task reaches Cancelled', async () => {
    real = await startRealServer({ productId: 'test-product' });

    const workspaceRoot = await tmpDir('byok-e2e-workspace-');
    const storeDir = await tmpDir('byok-e2e-store-');
    const adapter = new StubRuntimeAdapter();

    // Same short liveness timeout + fast backoff pattern as the F2 test —
    // lets the daemon's own liveness check self-detect the silent drop and
    // reconnect automatically within the same process/daemon instance.
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

    const handle = await real.byok.dispatch({ instruction: 'a long task to cancel', policy: { mode: 'auto' } });

    await waitForTaskEvent(handle, (e) => e.kind === 'state' && e.state === 'Running');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0]!;
    expect(session.interruptCalled).toBe(false); // not yet — nothing has cancelled it

    // Wait for the daemon's own liveness check to notice the connection has
    // gone silent and drop it — a genuine transport drop, not a simulated one.
    await vi.waitFor(() => expect(daemon?.status().connected).toBe(false), { timeout: 5000 });

    // Cancel WHILE disconnected: the server's own state moves to Cancelled
    // immediately (protocol §4), but `task.cancel` has nowhere live to go
    // right now and must sit in the server's per-device outbox — Wave 1's
    // `redeliverThroughTerminal` exemption is what keeps it eligible for
    // redelivery despite its own task already being terminal.
    await handle.cancel('no longer needed');
    expect(real.byok.tasks.get(handle.taskId)?.state).toBe('Cancelled');

    // Reconnect happens on its own (backoff above) — this is exactly the
    // conn.ack-then-backlog sequence the redelivery procedure (§9) drives.
    await vi.waitFor(() => expect(daemon?.status().connected).toBe(true), { timeout: 5000 });

    // Proof the redelivered task.cancel actually reached the SAME
    // still-alive session (not a fresh one) and interrupted it.
    await vi.waitFor(() => expect(session.interruptCalled).toBe(true), { timeout: 5000 });

    const result = await handle.result();
    expect(result.state).toBe('Cancelled');

    // The daemon's own task.cancelled — sent in response to processing the
    // redelivered task.cancel — arrives at a server whose record is
    // already Cancelled: an idempotent no-op ack (protocol §3.3), not an
    // error. There is no distinct client-observable signal for this beyond
    // "the task stayed Cancelled and nothing broke" — assert exactly that,
    // stably, over a short window.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(real.byok.tasks.get(handle.taskId)?.state).toBe('Cancelled');
  }, 15000);
});
