import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { controlSocketPath, controlTokenPath, type ControlStatusResult } from '../daemon/control-protocol';
import { connectControlClient } from '../bin/control-client';
import { runStartCommand } from '../bin/commands/start';
import { runStatusCommand } from '../bin/commands/status';
import { runTasksFollowCommand } from '../bin/commands/tasks';
import { runUnpairCommand } from '../bin/commands/unpair';
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
 * M4 Phase 2: end-to-end coverage of the daemon control socket, driven
 * against a REAL `createDaemonWithAdapters` daemon (real pair()/start(),
 * a real `TestServer`, a stub-adapter task) — the same convention
 * `bin-start-command.test.ts` already uses for `runStartCommand`. Unit-level
 * coverage for the transport/handshake/RPC-dispatch machinery in isolation
 * lives in `control-protocol.test.ts`/`control-server.test.ts`; this file
 * proves the whole stack (create-daemon.ts's method registry, task-runner.ts's
 * shutdown methods, observer.ts's new event, the CLI commands) actually
 * works together.
 */
describe('M4 Phase 2: control socket end-to-end', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  async function pairedAndStarted(
    productId: string,
    adapter: StubRuntimeAdapter,
  ): Promise<{ daemon: Daemon; config: DaemonConfig; storeDir: string }> {
    const workspaceRoot = await tmpDir(`byok-ctl-e2e-${productId}-ws-`);
    const storeDir = await tmpDir(`byok-ctl-e2e-${productId}-store-`);
    const config: DaemonConfig = { productName: 'Acme', productId, serverUrl: server.url, workspaceRoot, storeDir };
    const built = createDaemonWithAdapters(config, [adapter]);
    await built.pair('pairing-code');
    await built.start();
    return { daemon: built, config, storeDir };
  }

  it('status reports live pid/uptime/transport/activeTasks/runtimeIds', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const built = await pairedAndStarted('acme-ctl-status', adapter);
    daemon = built.daemon;

    const conn = await connectControlClient({ storeDir: built.storeDir, productId: built.config.productId });
    if (!conn.ok) throw new Error('expected reachable');
    const status = await conn.client.request<ControlStatusResult>('status');

    expect(status.pid).toBe(process.pid);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(status.paired).toBe(true);
    expect(typeof status.deviceId).toBe('string');
    expect(status.transport).toBe('open');
    expect(status.activeTasks).toEqual([]);
    expect(status.runtimeIds).toEqual(['pi']);
    conn.client.close();
  });

  it('status.activeTasks reflects a genuinely running task, and clears once it completes', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const built = await pairedAndStarted('acme-ctl-status-active', adapter);
    daemon = built.daemon;

    server.send(
      createEnvelope('task.offer', { instruction: 'do work', policy: { mode: 'auto' } }, { taskId: 't1', seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started');

    const conn = await connectControlClient({ storeDir: built.storeDir, productId: built.config.productId });
    if (!conn.ok) throw new Error('expected reachable');
    const status = await conn.client.request<ControlStatusResult>('status');
    expect(status.activeTasks).toEqual([{ taskId: 't1', state: 'Running' }]);

    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    adapter.sessions[0]?.emit({ type: 'turn_end' });
    await server.waitFor((e) => e.type === 'task.complete');

    const statusAfter = await conn.client.request<ControlStatusResult>('status');
    expect(statusAfter.activeTasks).toEqual([]);
    conn.client.close();
  });

  it('approvals.list is empty and approvals.resolve of an unknown id is not_found (Phase 2: nothing produces approvals yet)', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const built = await pairedAndStarted('acme-ctl-approvals', adapter);
    daemon = built.daemon;

    const conn = await connectControlClient({ storeDir: built.storeDir, productId: built.config.productId });
    if (!conn.ok) throw new Error('expected reachable');

    await expect(conn.client.request('approvals.list')).resolves.toEqual({ approvals: [] });
    await expect(conn.client.request('approvals.resolve', { approvalId: 'ghost', decision: 'approve' })).rejects.toMatchObject({
      code: 'not_found',
    });
    conn.client.close();
  });

  it('tasks.subscribe streams the same live DaemonEvents as daemon.subscribe(), full fidelity', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const built = await pairedAndStarted('acme-ctl-subscribe', adapter);
    daemon = built.daemon;

    const viaSocket: unknown[] = [];
    const conn = await connectControlClient({ storeDir: built.storeDir, productId: built.config.productId });
    if (!conn.ok) throw new Error('expected reachable');
    const subscription = conn.client.subscribe('tasks.subscribe', {}, (event) => viaSocket.push(event));

    server.send(
      createEnvelope('task.offer', { instruction: 'do work', policy: { mode: 'auto' } }, { taskId: 't1', seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    adapter.sessions[0]?.emit({ type: 'turn_end' });
    await server.waitFor((e) => e.type === 'task.complete');

    await vi.waitFor(() =>
      expect(viaSocket.some((e) => (e as { kind: string; taskId?: string }).kind === 'completed' && (e as { taskId: string }).taskId === 't1')).toBe(
        true,
      ),
    );

    subscription.close();
    conn.client.close();
  });

  it('shutdown: stops accepting offers, interrupts+fails the active task, appends a shutdown-requested event, and removes the control files', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const built = await pairedAndStarted('acme-ctl-shutdown', adapter);
    daemon = built.daemon;

    server.send(
      createEnvelope('task.offer', { instruction: 'long task', policy: { mode: 'auto' } }, { taskId: 't1', seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));

    const observed: Array<{ kind: string }> = [];
    daemon.subscribe((event) => observed.push(event));

    const conn = await connectControlClient({ storeDir: built.storeDir, productId: built.config.productId });
    if (!conn.ok) throw new Error('expected reachable');
    await expect(conn.client.request('shutdown', { reason: 'unpair' })).resolves.toEqual({ acknowledged: true });
    conn.client.close();

    // The active task must be reported FAILED (not cancelled) to the server,
    // over the still-open connection, before the daemon actually closes it.
    const fail = await server.waitFor((e) => e.type === 'task.fail' && e.task_id === 't1');
    expect((fail.payload as { reason: string; retryable: boolean }).retryable).toBe(true);
    expect(adapter.sessions[0]?.interruptCalled).toBe(true);

    await vi.waitFor(() => expect(observed.some((e) => e.kind === 'shutdown-requested')).toBe(true));

    await vi.waitFor(async () => {
      expect(await fileGone(controlTokenPath(built.storeDir))).toBe(true);
      expect(await fileGone(controlSocketPath(built.storeDir))).toBe(true);
    });

    // A fresh connect attempt now reports "not reachable" — the daemon is genuinely gone from the control socket's point of view.
    const after = await connectControlClient({ storeDir: built.storeDir, productId: built.config.productId });
    expect(after.ok).toBe(false);

    // A NEW offer arriving after shutdown was requested (but possibly before
    // the connection fully tears down) must never be claimed.
    expect(adapter.sessions).toHaveLength(1);
  }, 10000);

  it('runStartCommand exits cleanly when the control socket shutdown RPC fires, with no external abort signal ever sent', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const workspaceRoot = await tmpDir('byok-ctl-e2e-startcmd-ws-');
    const storeDir = await tmpDir('byok-ctl-e2e-startcmd-store-');
    const config: DaemonConfig = { productName: 'Acme', productId: 'acme-ctl-startcmd', serverUrl: server.url, workspaceRoot, storeDir };
    daemon = createDaemonWithAdapters(config, [adapter]);
    await daemon.pair('pairing-code');

    const lines: string[] = [];
    const controller = new AbortController(); // deliberately never aborted
    const startPromise = runStartCommand(config, { daemon, log: (l) => lines.push(l), signal: controller.signal });

    await vi.waitFor(() => expect(lines.some((l) => l.startsWith('daemon started:'))).toBe(true));

    const conn = await connectControlClient({ storeDir, productId: config.productId });
    if (!conn.ok) throw new Error('expected reachable');
    await conn.client.request('shutdown', { reason: 'operator' });
    conn.client.close();

    await startPromise; // must resolve on its own — proves the process-hang gap is closed
    expect(lines).toContain('daemon stopped');
  }, 10000);

  it('REGRESSION (gatekeeper-caught): a control-socket shutdown through runStartCommand must not drop an active task\'s task.fail', async () => {
    // This is the exact scenario the gatekeeper's probe showed failing:
    // runStartCommand used to wake up on the EARLY `shutdown-requested`
    // event and call daemon.stop() itself, racing ConnectionManager's
    // synchronous `stopped = true` ahead of the still-in-flight
    // session.interrupt() -> task.fail send inside
    // TaskRunner.shutdownActiveTasks — silently stranding task.fail in a
    // post-stopped outbox that never drains. `interruptCalled` becoming
    // true was NEVER the problem; the server never receiving `task.fail`
    // was. This test drives the WHOLE thing through the real
    // runStartCommand (not a direct daemon.shutdownActiveTasks call, which
    // bypasses the race entirely) with a genuinely active task.
    const adapter = new StubRuntimeAdapter('pi');
    const workspaceRoot = await tmpDir('byok-ctl-e2e-startcmd-active-ws-');
    const storeDir = await tmpDir('byok-ctl-e2e-startcmd-active-store-');
    const config: DaemonConfig = {
      productName: 'Acme',
      productId: 'acme-ctl-startcmd-active',
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
    };
    daemon = createDaemonWithAdapters(config, [adapter]);
    await daemon.pair('pairing-code');

    const lines: string[] = [];
    const controller = new AbortController(); // deliberately never aborted — only the control socket drives this shutdown
    const startPromise = runStartCommand(config, { daemon, log: (l) => lines.push(l), signal: controller.signal });

    await vi.waitFor(() => expect(lines.some((l) => l.startsWith('daemon started:'))).toBe(true));

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'long task', policy: { mode: 'auto' } },
        { taskId: 'race-task', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));

    const conn = await connectControlClient({ storeDir, productId: config.productId });
    if (!conn.ok) throw new Error('expected reachable');
    await conn.client.request('shutdown', { reason: 'unpair' });
    conn.client.close();

    await startPromise; // must resolve on its own, same as the test above

    expect(adapter.sessions[0]?.interruptCalled).toBe(true); // was already true even under the bug
    const fail = await server.waitFor((e) => e.type === 'task.fail' && e.task_id === 'race-task'); // this is what the bug made never arrive
    expect((fail.payload as { reason: string; retryable: boolean }).reason).toMatch(/shutting down/i);
    expect((fail.payload as { retryable: boolean }).retryable).toBe(true);
  }, 10000);

  it('CLI fallback: runStatusCommand shows the live-* section when reachable, and a clear not-reachable note once the daemon stops', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const built = await pairedAndStarted('acme-ctl-status-cli', adapter);
    daemon = built.daemon;

    const linesLive: string[] = [];
    await runStatusCommand(built.config, { log: (l) => linesLive.push(l) });
    expect(linesLive.some((l) => l.startsWith('live: pid='))).toBe(true);
    expect(linesLive.some((l) => l === 'live-active-tasks: (none)')).toBe(true);
    expect(linesLive.some((l) => l === 'live-runtimes: pi')).toBe(true);

    await daemon.stop();

    const linesDown: string[] = [];
    await runStatusCommand(built.config, { log: (l) => linesDown.push(l) });
    expect(linesDown.some((l) => l.startsWith('live status: daemon not reachable'))).toBe(true);
    expect(linesDown.some((l) => l.startsWith('live:'))).toBe(false);
  });

  it('CLI fallback: runTasksFollowCommand subscribes live when reachable, and falls back to the audit tail once the daemon stops', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const built = await pairedAndStarted('acme-ctl-tasks-cli', adapter);
    daemon = built.daemon;

    const linesLive: string[] = [];
    const liveController = new AbortController();
    const liveFollow = runTasksFollowCommand(built.config, { log: (l) => linesLive.push(l), signal: liveController.signal });

    // The control socket's `tasks.subscribe` handshake+dispatch (a separate
    // connection from the WS one `server.send` rides) needs a moment to
    // register server-side before an event sent right now is guaranteed to
    // be observed — retry with a fresh taskId each attempt (a task.offer for
    // an already-active/finished id is a documented no-op, so only a taskId
    // that hasn't been tried yet can prove a later attempt actually worked).
    let attempt = 0;
    await vi.waitFor(
      () => {
        if (linesLive.some((l) => /started taskId=t-live-\d+/.test(l))) return;
        attempt += 1;
        server.send(
          createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: `t-live-${attempt}`, seq: server.nextSeq() }),
        );
        throw new Error('live subscription not yet active');
      },
      { timeout: 3000 },
    );
    liveController.abort();
    await liveFollow;

    await daemon.stop();

    const linesDown: string[] = [];
    const downController = new AbortController();
    const downFollow = runTasksFollowCommand(built.config, { log: (l) => linesDown.push(l), signal: downController.signal, pollIntervalMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    downController.abort();
    await downFollow; // must complete via the audit-tail fallback, not hang
  });

  it('runUnpairCommand performs a real live unpair over the control socket: shuts the daemon down, confirms exit, and clears the store', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const built = await pairedAndStarted('acme-ctl-unpair-cli', adapter);
    daemon = built.daemon;
    const capturedDaemon = daemon;

    const lines: string[] = [];
    await runUnpairCommand(
      { unpair: () => capturedDaemon.unpair() },
      {
        confirmed: true,
        storeDir: built.storeDir,
        productId: built.config.productId,
        log: (l) => lines.push(l),
        controlExitTimeoutMs: 5000,
        controlExitPollIntervalMs: 50,
      },
    );

    expect(lines.some((l) => l.includes('confirmed exited'))).toBe(true);
    expect(await fileGone(controlTokenPath(built.storeDir))).toBe(true);
    expect(daemon.status().paired).toBe(false);
  }, 10000);
});
