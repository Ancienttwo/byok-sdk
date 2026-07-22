import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { controlSocketPath, controlTokenPath } from '../daemon/control-protocol';
import { connectControlClient } from '../bin/control-client';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function fileGone(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(
    () => false,
    () => true,
  );
}

/**
 * M5 batch-3 (workstream 2): closes the M5 ledger item "SIGTERM path doesn't
 * send task.fail" — the public `Daemon.stop()` (the entry point
 * `bin/commands/start.ts`'s SIGINT/SIGTERM handler calls) now runs the exact
 * same graceful-shutdown sequence the control socket's `shutdown` RPC
 * (`performControlShutdown`) already used: stop accepting offers -> best-
 * effort interrupt+fail every active task, over the STILL-OPEN connection ->
 * bounded outbox drain -> close connection/control socket. Before this fix,
 * `stop()` just dropped the connection outright with no notion of active
 * tasks — see `daemon-control-socket.test.ts`'s "shutdown: stops accepting
 * offers, interrupts+fails the active task, ..." test for the control-socket
 * counterpart these assertions mirror.
 */
describe('daemon.stop() shutdown parity with the control-socket shutdown path (M5 batch-3, workstream 2)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await daemon?.stop().catch(() => {});
    daemon = undefined;
    await server.close();
  });

  async function pairedAndStarted(
    productId: string,
    adapter: StubRuntimeAdapter,
  ): Promise<{ daemon: Daemon; config: DaemonConfig; storeDir: string }> {
    const workspaceRoot = await tmpDir(`byok-stop-parity-${productId}-ws-`);
    const storeDir = await tmpDir(`byok-stop-parity-${productId}-store-`);
    const config: DaemonConfig = { productName: 'Acme', productId, serverUrl: server.url, workspaceRoot, storeDir };
    const built = createDaemonWithAdapters(config, [adapter]);
    await built.pair('pairing-code');
    await built.start();
    return { daemon: built, config, storeDir };
  }

  it('with an active task: daemon.stop() interrupts it, sends retryable task.fail over the still-open connection, stops accepting further offers, and tears down the control socket', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const built = await pairedAndStarted('acme-stop-parity-active', adapter);
    daemon = built.daemon;

    server.send(
      createEnvelope('task.offer', { instruction: 'long task', policy: { mode: 'auto' } }, { taskId: 't1', seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));

    await daemon.stop();

    // The active task must be reported FAILED (not silently dropped) to the
    // server, over the still-open connection, BEFORE the daemon actually
    // closed it — this is the exact ledger item this test closes: before
    // the fix, stop() dropped the connection with no task.fail at all.
    const fail = await server.waitFor((e) => e.type === 'task.fail' && e.task_id === 't1');
    expect((fail.payload as { reason: string; retryable: boolean }).retryable).toBe(true);
    expect((fail.payload as { reason: string }).reason).toMatch(/shutting down/i);
    expect(adapter.sessions[0]?.interruptCalled).toBe(true);

    // Same control-socket teardown daemon.stop() has always performed —
    // still true now that it does more work first.
    await vi.waitFor(async () => {
      expect(await fileGone(controlTokenPath(built.storeDir))).toBe(true);
      expect(await fileGone(controlSocketPath(built.storeDir))).toBe(true);
    });

    // No new task was ever claimed once shutdown began.
    expect(adapter.sessions).toHaveLength(1);
  }, 10000);

  it('with no active task: daemon.stop() is unaffected — no spurious task.fail, control socket still torn down', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const built = await pairedAndStarted('acme-stop-parity-idle', adapter);
    daemon = built.daemon;

    await daemon.stop();

    expect(server.received.some((e) => e.type === 'task.fail')).toBe(false);
    await vi.waitFor(async () => {
      expect(await fileGone(controlTokenPath(built.storeDir))).toBe(true);
    });
  });

  it('idempotency: a control-socket shutdown followed by daemon.stop() does not double-fail the task or throw', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const built = await pairedAndStarted('acme-stop-parity-idempotent', adapter);
    daemon = built.daemon;

    server.send(
      createEnvelope('task.offer', { instruction: 'long task', policy: { mode: 'auto' } }, { taskId: 't-idem', seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));

    const conn = await connectControlClient({ storeDir: built.storeDir, productId: built.config.productId });
    if (!conn.ok) throw new Error('expected reachable');
    await expect(conn.client.request('shutdown', { reason: 'operator' })).resolves.toEqual({ acknowledged: true });
    conn.client.close();

    const fail = await server.waitFor((e) => e.type === 'task.fail' && e.task_id === 't-idem');
    expect((fail.payload as { retryable: boolean }).retryable).toBe(true);

    await vi.waitFor(async () => {
      expect(await fileGone(controlTokenPath(built.storeDir))).toBe(true);
    });

    // The control-socket shutdown already tore this daemon down fully;
    // calling the public stop() again (exactly what bin/commands/start.ts's
    // own signal handler does once it wakes from `shutdown-complete` — see
    // that file's own doc comment) must be a safe, non-throwing no-op.
    await expect(daemon.stop()).resolves.toBeUndefined();

    const allFails = server.received.filter((e) => e.type === 'task.fail' && e.task_id === 't-idem');
    expect(allFails).toHaveLength(1);
    expect(adapter.sessions).toHaveLength(1);
  }, 10000);

  it('idempotency: calling daemon.stop() twice directly (no control socket involved) does not double-fail or throw', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const built = await pairedAndStarted('acme-stop-parity-double-stop', adapter);
    daemon = built.daemon;

    server.send(
      createEnvelope('task.offer', { instruction: 'long task', policy: { mode: 'auto' } }, { taskId: 't-double', seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));

    await daemon.stop();
    await expect(daemon.stop()).resolves.toBeUndefined();

    const allFails = server.received.filter((e) => e.type === 'task.fail' && e.task_id === 't-double');
    expect(allFails).toHaveLength(1);
  }, 10000);
});
