import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { acquireDaemonOwner, DaemonOwnerActiveError, storeMutexEndpoint } from '../daemon/daemon-owner';
import { controlSocketPath, controlTokenPath } from '../daemon/control-protocol';
import { LocalStoragePressureEngine } from '../daemon/journal/storage-policy';
import { isSqliteAvailable } from '../daemon/journal/sqlite-support';
import { OperationalHealthTracker } from '../daemon/operational-health';
import { connectControlClient, isControlDaemonGone } from '../bin/control-client';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { RuntimeDisposalFailure } from '../runtime-failure';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runner-portable stand-in for `vi.waitFor`: retries `check` until it stops
 * throwing, then returns; rethrows the LAST failure once the deadline passes,
 * so a timeout still reports the real assertion error rather than a generic
 * "timed out". Same contract this file used before, minus the runner
 * dependency — `bun test`'s `vi` shim has no `waitFor`, and this file is a
 * `tests_pass` target the harness completion gate runs under bun.
 *
 * The default budget is deliberately well inside bun's own 5s per-test
 * default: every condition here (an adapter session appearing, the control
 * socket files disappearing) settles in milliseconds once the awaited event
 * that precedes it has already landed.
 */
async function waitFor(check: () => unknown | Promise<unknown>, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 2_000);
  const intervalMs = opts.intervalMs ?? 20;
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await sleep(intervalMs);
    }
  }
}

/**
 * Local stand-in for `daemon-owner.ts`'s own private `probeStoreMutex`, kept
 * to the one bit this guard needs: is the store-mutation lock's endpoint
 * still BOUND (i.e. `probeStoreMutex` would answer anything other than
 * `unbound`, and `acquireDaemonOwner` would therefore refuse)? Same
 * "`ECONNREFUSED`/`ENOENT` is the only positive proof of absence, every other
 * errno is unknown-and-therefore-occupied" convention that module uses.
 * Written here rather than exported from there on purpose: the guard must not
 * change the module whose ordering it is policing.
 */
async function storeMutexBound(endpoint: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(endpoint);
    let settled = false;
    const finish = (bound: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(bound);
    };
    const timer = setTimeout(() => finish(true), 1000);
    socket.once('connect', () => finish(true));
    socket.once('error', (err: NodeJS.ErrnoException) => finish(!(err.code === 'ECONNREFUSED' || err.code === 'ENOENT')));
  });
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
    await waitFor(() => expect(adapter.sessions).toHaveLength(1));

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
    await waitFor(async () => {
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
    await waitFor(async () => {
      expect(await fileGone(controlTokenPath(built.storeDir))).toBe(true);
    });
  });

  it('retains daemon ownership when runtime disposal rejects, then a clean retry releases it without a second terminal', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const built = await pairedAndStarted('acme-stop-runtime-disposal-barrier', adapter);
    daemon = built.daemon;
    server.send(createEnvelope(
      'task.offer',
      { instruction: 'long task', policy: { mode: 'auto' } },
      { taskId: 't-disposal-barrier', seq: server.nextSeq() },
    ));
    await server.waitFor((event) => event.type === 'task.started');
    const session = adapter.sessions[0]!;
    const close = session.close.bind(session);
    let attempts = 0;
    session.close = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new RuntimeDisposalFailure({ stage: 'quiescence', reason: 'fixture process tree remains live' });
      }
      await close();
    };

    await expect(daemon.stop()).rejects.toBeInstanceOf(RuntimeDisposalFailure);
    await expect(acquireDaemonOwner(built.storeDir, 'doctor')).rejects.toBeInstanceOf(DaemonOwnerActiveError);
    expect(await isControlDaemonGone(built.storeDir, built.config.productId)).toBe(false);
    expect(server.received.filter((event) => event.type === 'task.fail' && event.task_id === 't-disposal-barrier')).toHaveLength(1);

    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(server.received.filter((event) => event.type === 'task.fail' && event.task_id === 't-disposal-barrier')).toHaveLength(1);
    const doctorLease = await acquireDaemonOwner(built.storeDir, 'doctor');
    await doctorLease.release();
  }, 10000);

  it('idempotency: a control-socket shutdown followed by daemon.stop() does not double-fail the task or throw', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const built = await pairedAndStarted('acme-stop-parity-idempotent', adapter);
    daemon = built.daemon;

    server.send(
      createEnvelope('task.offer', { instruction: 'long task', policy: { mode: 'auto' } }, { taskId: 't-idem', seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await waitFor(() => expect(adapter.sessions).toHaveLength(1));

    const conn = await connectControlClient({ storeDir: built.storeDir, productId: built.config.productId });
    if (!conn.ok) throw new Error('expected reachable');
    await expect(conn.client.request('shutdown', { reason: 'operator' })).resolves.toEqual({ acknowledged: true });
    conn.client.close();

    const fail = await server.waitFor((e) => e.type === 'task.fail' && e.task_id === 't-idem');
    expect((fail.payload as { retryable: boolean }).retryable).toBe(true);

    await waitFor(async () => {
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
    await waitFor(() => expect(adapter.sessions).toHaveLength(1));

    await daemon.stop();
    await expect(daemon.stop()).resolves.toBeUndefined();

    const allFails = server.received.filter((e) => e.type === 'task.fail' && e.task_id === 't-double');
    expect(allFails).toHaveLength(1);
  }, 10000);

  it.skipIf(!isSqliteAvailable())('retains the mutation lease when a writer teardown barrier fails, then releases it after a clean retry', async () => {
    const workspaceRoot = await tmpDir('byok-stop-barrier-ws-');
    const storeDir = await tmpDir('byok-stop-barrier-store-');
    const config: DaemonConfig = {
      productName: 'Acme',
      productId: 'acme-stop-barrier',
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
      hostedJournal: {
        mode: 'sqlite',
        tenantId: 'tenant-stop-barrier',
        storagePolicy: { maxStoreBytes: 1024 * 1024 * 1024, minFreeBytes: 16 * 1024 * 1024 },
      },
    };
    daemon = createDaemonWithAdapters(config, [new StubRuntimeAdapter('pi')]);
    await daemon.pair('pairing-code');
    await daemon.start();

    const stopSpy = vi.spyOn(LocalStoragePressureEngine.prototype, 'stop').mockRejectedValueOnce(new Error('maintenance stop failed'));
    await expect(daemon.stop()).rejects.toThrow('maintenance stop failed');
    await expect(acquireDaemonOwner(storeDir, 'doctor')).rejects.toBeInstanceOf(DaemonOwnerActiveError);
    // Plan `shutdown-lease-order`: a retained lease must keep the exit gate
    // FALSE. This branch used to remove the control socket/token — publishing
    // "exited" — while deliberately holding the lease forever, so `unpair`'s
    // poll saw a confirmed exit and then failed on the reacquire with
    // `DaemonOwnerActiveError` instead of its own `UnpairExitUnconfirmedError`.
    expect(await isControlDaemonGone(storeDir, config.productId)).toBe(false);

    stopSpy.mockRestore();
    await expect(daemon.stop()).resolves.toBeUndefined();
    const doctorLease = await acquireDaemonOwner(storeDir, 'doctor');
    await doctorLease.release();
    expect(await isControlDaemonGone(storeDir, config.productId)).toBe(true);
  });

  it('single-flights concurrent stops and retains ownership until a timed-out late task writer settles', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const workspaceRoot = await tmpDir('byok-stop-concurrent-ws-');
    const storeDir = await tmpDir('byok-stop-concurrent-store-');
    daemon = createDaemonWithAdapters(
      {
        productName: 'Acme',
        productId: 'acme-stop-concurrent',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        shutdownGraceMs: 20,
      },
      [adapter],
    );
    await daemon.pair('pairing-code');
    await daemon.start();
    server.send(
      createEnvelope('task.offer', { instruction: 'late writer', policy: { mode: 'auto' } }, { taskId: 't-late', seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const releaseClose = adapter.sessions[0]!.blockClose();

    const first = daemon.stop();
    const concurrent = daemon.stop();
    // `Promise.allSettled` rather than two sequential `expect(...).rejects`:
    // these two promises reject at the same instant, and `.rejects` does not
    // attach its handler synchronously, so the second one sits momentarily
    // unhandled while the first is awaited — which `bun test` reports as an
    // unhandled rejection and fails the test for. allSettled subscribes to
    // both up front. Same assertion: BOTH stops reject with the grace-deadline
    // error (that is what "single-flighted" means here).
    const outcomes = await Promise.allSettled([first, concurrent]);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      expect(String((outcome as PromiseRejectedResult).reason)).toMatch(/grace deadline/);
    }
    await expect(acquireDaemonOwner(storeDir, 'doctor')).rejects.toBeInstanceOf(DaemonOwnerActiveError);
    // Same invariant as the barrier test above: ownership retained for a
    // possible residual writer means this daemon has NOT exited, and the
    // signal `unpair` polls must say so.
    expect(await isControlDaemonGone(storeDir, 'acme-stop-concurrent')).toBe(false);

    releaseClose();
    await waitFor(() => expect(adapter.sessions[0]!.closeCalled).toBe(true));
    await expect(daemon.stop()).resolves.toBeUndefined();
    const doctorLease = await acquireDaemonOwner(storeDir, 'doctor');
    await doctorLease.release();
  });

  /**
   * Plan `shutdown-lease-order` regression guard. The invariant: this
   * daemon's "I am gone" signal — `isControlDaemonGone`, i.e. the control
   * token file being gone AND a connect to the control socket being refused,
   * which is what `bin/commands/unpair.ts` polls and what every contender
   * mirrors — must never be observable while this daemon still holds the
   * store-mutation lease. Before the fix, `runShutdownSequence` closed the
   * control endpoint FIRST and released the lease 11-46ms later (measured
   * across 53 real cross-process runs; CI job 94465898325's intermittent
   * `ipc-smoke` failure), so an `acquireDaemonOwner` issued at the instant
   * unpair/start/doctor confirmed exit hit the still-bound mutex and was
   * refused with `DaemonOwnerActiveError('unknown')`.
   *
   * The window is real but short, so this guard AMPLIFIES it rather than
   * gambling on catching a few milliseconds: `markCleanStop` is the one step
   * that already sits between the two operations under test, and delaying it
   * (then calling through) widens the pre-fix gap without reordering
   * anything. On unfixed code the sampler below therefore lands inside the
   * window deterministically; on fixed code the ordering makes the window
   * unreachable no matter how long that step takes, because the signal is
   * published only after the lease is gone.
   */
  it('never publishes "control daemon gone" while the store-mutation lease is still held', async () => {
    const WINDOW_AMPLIFIER_MS = 250;
    const adapter = new StubRuntimeAdapter('pi');
    const built = await pairedAndStarted('acme-stop-lease-order', adapter);
    daemon = built.daemon;

    const canonicalStoreDir = await fs.realpath(built.storeDir);
    const mutexEndpoint = storeMutexEndpoint(canonicalStoreDir, createHash('sha256').update(canonicalStoreDir).digest('hex'));
    expect(await storeMutexBound(mutexEndpoint)).toBe(true); // the running daemon holds it

    const originalMarkCleanStop = OperationalHealthTracker.prototype.markCleanStop;
    const markCleanStopSpy = vi
      .spyOn(OperationalHealthTracker.prototype, 'markCleanStop')
      .mockImplementation(async function (this: OperationalHealthTracker): Promise<void> {
        await sleep(WINDOW_AMPLIFIER_MS);
        await originalMarkCleanStop.call(this);
      });

    const samples: Array<{ controlGone: boolean; mutexBound: boolean }> = [];
    let acquireAtGate: 'acquired' | string = 'never reached the gate';
    try {
      // The RPC acks and then defers the teardown (`setImmediate`), so this
      // resolves while the shutdown sequence is still running — exactly the
      // moment `unpair` starts polling for exit.
      const conn = await connectControlClient({ storeDir: built.storeDir, productId: built.config.productId });
      if (!conn.ok) throw new Error('expected the control socket to be reachable');
      await expect(conn.client.request('shutdown', { reason: 'operator' })).resolves.toEqual({ acknowledged: true });
      conn.client.close();

      const deadline = Date.now() + 8_000;
      for (;;) {
        // Order matters: read the exit gate FIRST, then the lock. The lease is
        // only ever released during this sequence, never re-taken, so a lock
        // still bound AFTER a gate that already read "gone" proves it was
        // bound at the gate too. The reverse order would prove nothing.
        const controlGone = await isControlDaemonGone(built.storeDir, built.config.productId);
        const mutexBound = await storeMutexBound(mutexEndpoint);
        samples.push({ controlGone, mutexBound });
        if (controlGone) {
          // What `unpair.ts` (and `byok-agent start`, and doctor) does next.
          try {
            const contender = await acquireDaemonOwner(built.storeDir, 'doctor');
            acquireAtGate = 'acquired';
            await contender.release();
          } catch (err) {
            acquireAtGate = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          }
          break;
        }
        if (Date.now() >= deadline) throw new Error('the daemon never reached the control-exit gate');
      }
    } finally {
      markCleanStopSpy.mockRestore();
    }

    // Asserted together so a failure reports BOTH halves of the invariant at
    // once: the raw sample that saw "gone" over a still-bound lock, and what
    // the real product call (`acquireDaemonOwner`) actually got at that exact
    // instant.
    const violations = samples.filter((s) => s.controlGone && s.mutexBound);
    expect({ violations, acquireAtGate }).toEqual({ violations: [], acquireAtGate: 'acquired' });
    expect(samples.length).toBeGreaterThan(0);
    expect(await fileGone(controlTokenPath(built.storeDir))).toBe(true);
    expect(await fileGone(controlSocketPath(built.storeDir))).toBe(true);
  }, 20000);
});
