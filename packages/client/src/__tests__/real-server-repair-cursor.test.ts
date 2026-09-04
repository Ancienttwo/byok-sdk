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

const LONG_POLL_DAEMON_OPTIONS = {
  longPoll: { retryDelayMs: 20, idleDelayMs: 20 },
} as const;

/**
 * Finding F5 (stale cursor across re-pair), against the REAL `@byok-sdk/server`
 * — this is deliberate, not just consistency with the F2 test: the real
 * server's `POST /byok/pair` always mints a brand new `deviceId`, even for
 * a re-pair with the identical device keypair. The client's own lightweight
 * `TestServer` test stub deliberately does NOT reproduce that (it reuses the
 * deviceId for an already-seen public key — see its own doc comment), so it
 * can't exercise this bug at all; only the real server's actual behavior can.
 *
 * The daemon runs over long-poll here. The finding is transport-independent —
 * the cursor is keyed by `(serverUrl, deviceId)` in the client's own
 * `CursorStore` either way — and what makes the stale-cursor bug OBSERVABLE is
 * unchanged too: device B's mailbox starts at seq 1, so its very first
 * `task.offer` carries a seq device A's (higher) cursor would have filtered out.
 */
describe('re-pair does not inherit a stale cursor from the previous device (finding F5, real @byok-sdk/server)', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await real.close();
  });

  it('a fresh device (new deviceId from the server) receives its own low-seq envelopes after re-pairing, on the same storeDir', async () => {
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 200 });
    const workspaceRoot = await tmpDir('byok-e2e-workspace-');
    const storeDir = await tmpDir('byok-e2e-store-'); // shared across both pair()/start() cycles below
    const adapterA = new StubRuntimeAdapter();

    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [adapterA],
      LONG_POLL_DAEMON_OPTIONS,
    );

    const firstPairing = await real.createPairingCode();
    const recordA = await daemon.pair(firstPairing.code);
    await daemon.start();
    await vi.waitFor(async () => {
      expect((await real.byok.machines.list()).find((m) => m.deviceId === recordA.deviceId)?.connected).toBe(true);
    });

    // Advance this device's cursor well past 1 so a later "did it inherit
    // this?" check is unambiguous — dispatch a task through claim/complete.
    const handleA = await real.byok.dispatch({ instruction: 'first device task', policy: { mode: 'auto' } });
    await waitForTaskEvent(handleA, (e) => e.kind === 'state' && e.state === 'Claimed');
    await vi.waitFor(() => expect(adapterA.sessions).toHaveLength(1));
    adapterA.sessions[0]!.emit({ type: 'turn_end' });
    await handleA.result();

    await daemon.stop();

    // Re-pair the SAME daemon instance, same storeDir. The real server mints
    // a brand-new deviceId here regardless of the (reused) device keypair —
    // confirmed below, not assumed.
    const secondPairing = await real.createPairingCode();
    const recordB = await daemon.pair(secondPairing.code);
    expect(recordB.deviceId).not.toBe(recordA.deviceId);

    const adapterB = new StubRuntimeAdapter();
    const daemon2 = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test', productId: 'test-product', serverUrl: real.url, workspaceRoot, storeDir },
      [adapterB],
      LONG_POLL_DAEMON_OPTIONS,
    );
    daemon = daemon2;
    await daemon2.start();
    await vi.waitFor(async () => {
      expect((await real.byok.machines.list()).find((m) => m.deviceId === recordB.deviceId)?.connected).toBe(true);
    });

    // The new device's own server-side mailbox starts fresh (nextSeq=1), so
    // its very first task.offer gets a LOW seq — exactly what the bug would
    // drop if this daemon had inherited device A's (higher) stale cursor.
    const handleB = await real.byok.dispatch({ instruction: 'second device task', policy: { mode: 'auto' } });
    await waitForTaskEvent(handleB, (e) => e.kind === 'state' && e.state === 'Claimed');
    await vi.waitFor(() => expect(adapterB.sessions).toHaveLength(1));
    adapterB.sessions[0]!.emit({ type: 'turn_end' });
    const resultB = await handleB.result();
    expect(resultB.state).toBe('Complete');
  }, 15000);
});
