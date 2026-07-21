import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectControlClient } from '../bin/control-client';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import type { DaemonEvent } from '../daemon/observer';
import { TaskRunner } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * P2 re-gate hardening finding: `create-daemon.ts`'s `performControlShutdown`
 * now wraps its body in try/finally so `observer.noteShutdownComplete` fires
 * regardless of whether `TaskRunner.shutdownActiveTasks`/`stop()` throw.
 * Before this fix, a throw anywhere in that body would propagate straight
 * out (the control socket's `shutdown` handler only logs it —
 * `create-daemon.ts`'s `void performControlShutdown(reason).catch(...)`)
 * and `shutdown-complete` would never fire — exactly the event
 * `bin/commands/start.ts`'s `runStartCommand` waits on to know it's safe to
 * return, so it would hang forever.
 *
 * `vi.spyOn(TaskRunner.prototype, 'shutdownActiveTasks')` forces the
 * REALISTIC failure this finding is about, without needing access to
 * `create-daemon.ts`'s own private closures — `runner` inside
 * `createDaemonWithAdapters` is a genuine `TaskRunner` instance, so a
 * prototype-level spy intercepts its call there exactly as it would any
 * other instance.
 */
describe('shutdown-complete fires even when TaskRunner.shutdownActiveTasks throws (P2 re-gate hardening)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await daemon?.stop().catch(() => {});
    daemon = undefined;
    await server?.close();
  });

  it('emits shutdown-complete despite shutdownActiveTasks rejecting, so a caller waiting on it is never left hanging', async () => {
    server = await TestServer.start();
    const adapter = new StubRuntimeAdapter();
    const workspaceRoot = await tmpDir('byok-shutdown-hardening-ws-');
    const storeDir = await tmpDir('byok-shutdown-hardening-store-');
    const built = createDaemonWithAdapters(
      { productName: 'Acme', productId: 'acme-shutdown-hardening', serverUrl: server.url, workspaceRoot, storeDir },
      [adapter],
    );
    daemon = built;
    await built.pair('pairing-code');
    await built.start();

    const shutdownSpy = vi
      .spyOn(TaskRunner.prototype, 'shutdownActiveTasks')
      .mockRejectedValue(new Error('simulated teardown failure'));

    const events: DaemonEvent[] = [];
    const unsubscribe = built.subscribe((event) => events.push(event));

    const conn = await connectControlClient({ storeDir, productId: 'acme-shutdown-hardening' });
    if (!conn.ok) throw new Error('expected reachable');
    await conn.client.request('shutdown', { reason: 'operator' });
    conn.client.close();

    // The bug this test guards against is exactly "this never resolves" —
    // vi.waitFor's own timeout is what would turn a real regression into a
    // failing test instead of a silently-hanging one.
    await vi.waitFor(
      () => {
        expect(events.some((e) => e.kind === 'shutdown-complete')).toBe(true);
      },
      { timeout: 3000 },
    );

    expect(shutdownSpy).toHaveBeenCalled();
    unsubscribe();
    daemon = undefined; // performControlShutdown already stopped it; avoid a redundant afterEach stop()
  });
});
