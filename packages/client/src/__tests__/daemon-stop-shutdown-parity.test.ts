import { FRESH_DAEMON_EGRESS, FRESH_OFFER } from './fixtures/fresh-offer';
import { freshTestAgentRef, testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from "./fixtures/execution-scratch";
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { acquireDaemonOwner, DaemonOwnerActiveError, storeMutexEndpoint } from '../daemon/daemon-owner';
import { controlEndpointPath, controlSocketPath, controlTokenPath } from '../daemon/control-protocol';
import { RetentionSweeper } from '../daemon/retention/sweeper';
import { OperationalHealthTracker } from '../daemon/operational-health';
import { connectControlClient, isControlDaemonGone } from '../daemon/control-client';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { RuntimeDisposalFailure } from '../runtime-failure';
import { resolveStorageConfig } from '../daemon/retention/config';
import { foldNameAliases } from '../util/fold-name-aliases';
import { resolveDaemonConfig } from '../daemon/create-daemon/config';
import { DeviceStore } from '../daemon/store';
import { stableAgentHomeOwnerId } from '../agent-home';
import { defaultScratchRoot } from '../daemon/retention/scratch';
import type { RuntimeAdapterPrepareInput, RuntimeAdapterPrepareResult } from '../types';
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
    const storeDir = await tmpDir(`byok-stop-parity-${productId}-store-`);
    const config: DaemonConfig = { localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId, serverUrl: server.url, storeDir };
    const built = createDaemonWithAdapters({agentHome: testAgentHomeConfig(), agentEgress: FRESH_DAEMON_EGRESS,  storage: { scratchRoot: testScratchRoot(), budget: { maxStoreBytes: 1024 * 1024 * 1024, minFreeBytes: 16 * 1024 * 1024 } }, ...(config) }, [adapter]);
    await built.pair('pairing-code');
    await built.start();
    return { daemon: built, config, storeDir };
  }

  it('with an active task: daemon.stop() interrupts it, sends retryable task.fail over the still-open connection, stops accepting further offers, and tears down the control socket', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const built = await pairedAndStarted('acme-stop-parity-active', adapter);
    daemon = built.daemon;

    server.send(
      createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'long task', ...FRESH_OFFER }, { taskId: 't1', seq: server.nextSeq() }),
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
      { agentRef: freshTestAgentRef(),  instruction: 'long task', ...FRESH_OFFER },
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
      createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'long task', ...FRESH_OFFER }, { taskId: 't-idem', seq: server.nextSeq() }),
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
      createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'long task', ...FRESH_OFFER }, { taskId: 't-double', seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await waitFor(() => expect(adapter.sessions).toHaveLength(1));

    await daemon.stop();
    await expect(daemon.stop()).resolves.toBeUndefined();

    const allFails = server.received.filter((e) => e.type === 'task.fail' && e.task_id === 't-double');
    expect(allFails).toHaveLength(1);
  }, 10000);

  it('retains the mutation lease when a writer teardown barrier fails, then releases it after a clean retry', async () => {
    const storeDir = await tmpDir('byok-stop-barrier-store-');
    const config: DaemonConfig = {
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme',
      productId: 'acme-stop-barrier',
      serverUrl: server.url,
      agentHome: testAgentHomeConfig(), agentEgress: FRESH_DAEMON_EGRESS,
      storeDir,
    };
    daemon = createDaemonWithAdapters({agentHome: testAgentHomeConfig(), agentEgress: FRESH_DAEMON_EGRESS,  storage: { scratchRoot: testScratchRoot(), budget: { maxStoreBytes: 1024 * 1024 * 1024, minFreeBytes: 16 * 1024 * 1024 } }, ...(config) }, [new StubRuntimeAdapter('pi')]);
    await daemon.pair('pairing-code');
    await daemon.start();

    const stopSpy = vi.spyOn(RetentionSweeper.prototype, 'stop').mockRejectedValueOnce(new Error('maintenance stop failed'));
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
    const storeDir = await tmpDir('byok-stop-concurrent-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot(), budget: { maxStoreBytes: 1024 * 1024 * 1024, minFreeBytes: 16 * 1024 * 1024 } },
        localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme',
        productId: 'acme-stop-concurrent',
        serverUrl: server.url,
        agentHome: testAgentHomeConfig(), agentEgress: FRESH_DAEMON_EGRESS,
        storeDir,
        shutdownGraceMs: 20,
      },
      [adapter],
    );
    await daemon.pair('pairing-code');
    await daemon.start();
    server.send(
      createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'late writer', ...FRESH_OFFER }, { taskId: 't-late', seq: server.nextSeq() }),
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
    // Session.close is only the process receipt. The retained late writer also
    // owns asynchronous SDK scratch removal and journal finalization.
    await waitFor(() => expect(daemon!.status().activeTaskCount).toBe(0));
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

/** A stub whose prepared operation takes an execution scratch, so a run leaves `<scratch root>/exec`. */
class LaunchingAdapter extends StubRuntimeAdapter {
  override async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const base = await super.prepare(input);
    if (base.kind !== 'prepared') return base;
    return {
      ...base,
      operation: {
        ...base.operation,
        resolveRuntimeLaunch: async ({ cwd, scratch }) => ({
          scratch, kind: 'pi-rpc', command: 'unused', fixedArgs: [], cwd, env: {}, sessionCwd: cwd,
          credentialSource: 'pi-auth-store', release: async () => {},
        }),
      },
    };
  }
}

// #1030: 8.3 short names and letter case are Windows name aliases, not links.
describe('daemon restart through a Windows name alias of the store (#1030)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;
  const scratchRoots: string[] = [];

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = undefined;
    await server.close();
    await Promise.all(scratchRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')('folds a letter-case alias of the store and its configured retention roots', async () => {
    // /private/tmp keeps a macOS root under the Unix socket limit.
    const store = realpathSync.native(await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'c-')));
    scratchRoots.push(store);
    const alias = path.join(path.dirname(store), path.basename(store).toUpperCase());
    expect(alias).not.toBe(store);
    expect(foldNameAliases(alias)).toBe(store);
    expect(foldNameAliases(path.join(alias, 'later'))).toBe(path.join(store, 'later'));
    expect(resolveStorageConfig(alias, { scratchRoot: path.join(alias, 's'), skillPackDataDirs: [alias] }))
      .toMatchObject({ scratchRoot: path.join(store, 's'), skillPackDataDirs: [store] });
    expect(resolveStorageConfig(alias)).toMatchObject({ scratchRoot: defaultScratchRoot(store), skillPackDataDirs: [store] });
    // Every identity derived from the store uses the folded spelling.
    expect(DeviceStore.resolveDir('acme-fold', alias)).toBe(store);
    expect(controlEndpointPath('acme-fold', DeviceStore.resolveDir('acme-fold', alias))).toBe(controlEndpointPath('acme-fold', store));
    expect(stableAgentHomeOwnerId(DeviceStore.resolveDir('acme-fold', alias), 'acme-fold')).toBe(stableAgentHomeOwnerId(store, 'acme-fold'));
    const { piByokLauncher } = resolveDaemonConfig({ overrides: {}, config: {
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-fold', serverUrl: 'ws://127.0.0.1:1',
      piByokLauncher: { command: 'byok-pi-launcher', profileDbPath: path.join(store, 'profiles.db'), sessionDir: path.join(alias, 'sessions') },
    } });
    expect(piByokLauncher?.sessionDir).toBe(path.join(store, 'sessions'));
  });

  it.skipIf(process.platform === 'win32')('never folds a store path through a symbolic link and keeps a missing tail', async () => {
    const store = realpathSync.native(await tmpDir('byok-link-target-'));
    const link = `${store}-link`;
    await fs.symlink(store, link);
    try {
      expect(foldNameAliases(link)).toBe(link);
      expect(foldNameAliases(path.join(link, 'later'))).toBe(path.join(link, 'later'));
      expect(resolveStorageConfig(link).skillPackDataDirs).toEqual([link]);
      expect(foldNameAliases(path.join(store, 'missing', 'tail'))).toBe(path.join(store, 'missing', 'tail'));
    } finally {
      await fs.rm(link, { force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')('folds the 8.3 short-name form of a store path', async (ctx) => {
    const canonical = realpathSync.native(await tmpDir('byok-short-name-store-'));
    // cmd's %~sI expansion prints the 8.3 form; it repeats the long name where none exists.
    const listed = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${canonical}") do @echo %~sI"`],
      { encoding: 'utf8', windowsVerbatimArguments: true });
    expect(listed.status).toBe(0);
    const short = listed.stdout.trim();
    ctx.skip(short === canonical, 'this volume does not generate 8.3 short names');
    expect(short).not.toBe(canonical);
    expect(foldNameAliases(short)).toBe(canonical);
    expect(DeviceStore.resolveDir('acme-short-name', short)).toBe(canonical);
  });

  it.skipIf(process.platform !== 'win32')('never folds a store path through a junction', async () => {
    const target = realpathSync.native(await tmpDir('byok-junction-target-'));
    const junction = path.join(path.dirname(target), `${path.basename(target)}-junction`);
    await fs.symlink(target, junction, 'junction');
    try {
      expect(foldNameAliases(junction)).toBe(junction);
      expect(foldNameAliases(path.join(junction, 'store'))).toBe(path.join(junction, 'store'));
    } finally {
      await fs.rm(junction, { force: true });
    }
  });

  it.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')('restarts and sweeps the default scratch root when the store is configured through a name alias', async () => {
    const canonical = realpathSync.native(await tmpDir('byok-alias-store-'));
    const storeDir = path.join(path.dirname(canonical), path.basename(canonical).toUpperCase());
    expect(realpathSync.native(storeDir)).toBe(canonical);
    expect(storeDir).not.toBe(canonical);
    // No storage.scratchRoot: the default root derives from the store.
    const config: DaemonConfig = {
      agentHome: testAgentHomeConfig(), agentEgress: FRESH_DAEMON_EGRESS, localAgentRelease: { version: '0.0.0-test' },
      productName: 'Acme', productId: 'acme-store-alias', serverUrl: server.url, storeDir,
    };
    const offer = (taskId: string) => server.send(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), instruction: taskId, ...FRESH_OFFER }, { taskId, seq: server.nextSeq() }));

    const first = new LaunchingAdapter('pi');
    daemon = createDaemonWithAdapters(config, [first]);
    await daemon.pair('pairing-code');
    await daemon.start();
    offer('alias-first');
    await waitFor(() => expect(first.sessions).toHaveLength(1));
    first.sessions[0]!.emit({ type: 'turn_end' });
    await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'alias-first');
    await daemon.stop();
    // A long store moves its default root to a fixed short one, so derive it.
    const scratchRoot = defaultScratchRoot(canonical);
    scratchRoots.push(scratchRoot);
    const exec = path.join(scratchRoot, 'exec');
    const tokens = await fs.readdir(exec);
    expect(tokens).toHaveLength(1);
    // Crash residue: a launch config left behind as if the process had been killed.
    const residue = path.join(exec, tokens[0]!, 'sdk');
    await fs.mkdir(residue);
    await fs.writeFile(path.join(residue, 'mcp-config.json'), 'secret');

    // A startup exec-sdk sweep failure is fatal; this one must remove the residue through the folded root.
    const second = new LaunchingAdapter('pi');
    daemon = createDaemonWithAdapters(config, [second]);
    await daemon.start();
    expect(await fileGone(residue)).toBe(true);
    offer('alias-second');
    await waitFor(() => expect(second.sessions).toHaveLength(1));
    second.sessions[0]!.emit({ type: 'turn_end' });
    await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'alias-second');

    // A CLI resolves the same aliased config through DeviceStore.resolveDir, which bin/config's resolveStoreDir
    // delegates to (bin-config.test.ts pins that wiring), and reaches this daemon's control endpoint.
    const cli = await connectControlClient({ storeDir: DeviceStore.resolveDir(config.productId, config.storeDir), productId: config.productId });
    if (!cli.ok) throw new Error(`expected the CLI to reach the daemon: ${JSON.stringify(cli)}`);
    cli.client.close();
  }, 20000);
});
