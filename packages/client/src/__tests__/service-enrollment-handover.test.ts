import { FRESH_DAEMON_EGRESS } from './fixtures/fresh-offer';
import { testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from './fixtures/execution-scratch';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { controlTokenPath, type ControlStatusResult } from '../daemon/control-protocol';
import { DAEMON_OWNER_FILENAME } from '../daemon/daemon-owner';
import { AuthManager } from '../daemon/auth-manager';
import { connectControlClient, isControlDaemonGone } from '../bin/control-client';
import { runUnpairCommand } from '../bin/commands/unpair';
import type { RuntimeDetectResult } from '../types';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

/**
 * A service daemon waiting for enrollment holds the store lease, pairs, and
 * starts normally in the same process. Its control endpoint is the one
 * liveness signal `unpair` reads (`isControlDaemonGone`): it must never read
 * "gone" while the lease is held, enrollment must serve `shutdown`, and a
 * shutdown at any point of the pair and its deferred start must leave the
 * lease released for good.
 */

/** Holds `detect()`, which a start reaches after it has promoted the control methods. */
class GatedAdapter extends StubRuntimeAdapter {
  readonly reached: Promise<void>;
  private reach!: () => void;
  private opened!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.opened = resolve; });
  constructor() {
    super('pi');
    this.reached = new Promise<void>((resolve) => { this.reach = resolve; });
  }
  open(): void { this.opened(); }
  override async detect(): Promise<RuntimeDetectResult> {
    this.reach();
    await this.gate;
    return super.detect();
  }
}

/** Fails `detect()`, which a start reaches after it has promoted the control methods. */
class FailingDetectAdapter extends StubRuntimeAdapter {
  constructor() { super('pi'); }
  override async detect(): Promise<RuntimeDetectResult> {
    throw new Error('detect failed');
  }
}

describe('service enrollment handover (#1165 WinSW unpair)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;
  let storeDir = '';
  let config: DaemonConfig;

  beforeEach(async () => {
    server = await TestServer.start();
    storeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-enroll-handover-')));
    config = {
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-enroll-handover',
      serverUrl: server.url, agentHome: testAgentHomeConfig(), agentEgress: FRESH_DAEMON_EGRESS, storeDir,
      serviceEnrollment: { enabled: true },
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await daemon?.stop().catch(() => undefined);
    daemon = undefined;
    await server.close();
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  const build = (adapter: StubRuntimeAdapter = new StubRuntimeAdapter('pi')) =>
    createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() }, ...config }, [adapter]);
  const ownerPath = () => path.join(storeDir, DAEMON_OWNER_FILENAME);
  const leaseHeld = () => existsSync(ownerPath());
  const ownerNonce = async () => {
    try { return (JSON.parse(await fs.readFile(ownerPath(), 'utf8')) as { nonce: string }).nonce; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  };
  const gone = () => isControlDaemonGone(storeDir, config.productId);
  async function connect() {
    const conn = await connectControlClient({ storeDir, productId: config.productId });
    if (!conn.ok) throw new Error(`control endpoint unreachable: ${conn.reason}`);
    return conn.client;
  }
  async function enrolling(adapter?: StubRuntimeAdapter): Promise<Daemon> {
    daemon = build(adapter);
    await daemon.start();
    expect(daemon.status().lifecycle).toEqual({ phase: 'awaiting-enrollment' });
    return daemon;
  }
  /** Runs queued lifecycle work to the end, then proves nothing took the lease again. */
  async function expectStoppedForGood(current: Daemon): Promise<void> {
    // Observe the requested shutdown without a second stop, which could hide a queued restart.
    await new Promise((resolve) => setImmediate(resolve));
    await vi.waitFor(async () => {
      expect(leaseHeld()).toBe(false);
      expect(await gone()).toBe(true);
    }, { timeout: 5_000 });
    expect(leaseHeld()).toBe(false);
    expect(await gone()).toBe(true);
    expect(current.status().lifecycle.phase).not.toBe('running');
  }
  /**
   * Polls the real liveness predicate until `until` settles; resolves to how
   * often it read "gone" while the enrolling daemon's own owner record
   * (`nonce`) was in place before and after the read. A later contender's own
   * lease (a fresh unpair) is not this daemon's.
   */
  function watchGoneWhileHeld(nonce: string, until: Promise<unknown>): Promise<number> {
    let done = false;
    let failed = false;
    let failure: unknown;
    void until.then(() => { done = true; }, (error: unknown) => {
      done = true;
      failed = true;
      failure = error;
    });
    const deadline = Date.now() + 5_000;
    let lastErrorCode: string | undefined;
    const pending = Symbol('owner read pending');
    const observeNonce = async () => {
      try { return await ownerNonce(); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || code !== 'EPERM') throw error;
        lastErrorCode = code;
        // Windows can deny this ungated test read while the owner is being deleted.
        return pending;
      }
    };
    return (async () => {
      let violations = 0;
      let observationPending = false;
      while (!done || observationPending) {
        if (failed || Date.now() >= deadline) {
          throw new Error(`handover observation did not complete; last owner read error code: ${lastErrorCode ?? 'none'}`, { cause: failure });
        }
        const before = await observeNonce();
        observationPending = before === pending;
        if (!observationPending && await gone() && before === nonce) {
          const after = await observeNonce();
          observationPending = after === pending;
          if (after === nonce) violations += 1;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (failed) {
        throw new Error(`handover observation failed; last owner read error code: ${lastErrorCode ?? 'none'}`, { cause: failure });
      }
      return violations;
    })();
  }

  it('promotes the same endpoint, token and authenticated connection; gone never reads true while the lease is held', async () => {
    await enrolling();
    const client = await connect();
    const token = await fs.readFile(controlTokenPath(storeDir), 'utf8');
    await expect(client.request('approvals.list', {})).rejects.toMatchObject({ code: 'unknown_method' });

    const running = vi.waitFor(async () => {
      const status = await client.request<ControlStatusResult>('status');
      expect(status.lifecycle).toEqual({ phase: 'running', connection: 'open' });
    }, { timeout: 5_000, interval: 5 });
    const violations = watchGoneWhileHeld((await ownerNonce())!, running);
    await client.request('enrollment.pair', { pairingCode: 'pairing-code' });
    expect(await violations).toBe(0);
    expect(await client.request('approvals.list', {})).toEqual({ approvals: [] });
    expect(await fs.readFile(controlTokenPath(storeDir), 'utf8')).toBe(token);
    const newer = await connect();
    expect(await newer.request('approvals.list', {})).toEqual({ approvals: [] });
    newer.close();
    client.close();
  }, 15_000);

  it('enrollment serves shutdown: a fresh unpair confirms exit and clears the store', async () => {
    const current = await enrolling();
    const lines: string[] = [];
    await runUnpairCommand(build(), {
      confirmed: true, storeDir, productId: config.productId, log: (line) => lines.push(line),
      controlExitTimeoutMs: 5_000, controlExitPollIntervalMs: 5,
    });
    expect(lines.some((line) => line.includes('confirmed exited'))).toBe(true);
    await expectStoppedForGood(current);
  }, 15_000);

  it('a fresh unpair right after enrollment.pair stops the handover: no gone while held, no restart', async () => {
    const current = await enrolling();
    const client = await connect();
    await client.request('enrollment.pair', { pairingCode: 'pairing-code' });
    client.close();
    const nonce = (await ownerNonce())!;
    const unpairing = runUnpairCommand(build(), {
      confirmed: true, storeDir, productId: config.productId, log: () => undefined,
      controlExitTimeoutMs: 5_000, controlExitPollIntervalMs: 1,
    });
    const violations = watchGoneWhileHeld(nonce, unpairing);
    expect(await violations).toBe(0);
    await expectStoppedForGood(current);
  }, 15_000);

  it('shutdown while enrollment.pair is still at the server: the pair finishes, its start never runs', async () => {
    const current = await enrolling();
    const release = server.blockNextPair();
    const client = await connect();
    const pairing = client.request<{ deviceId: string }>('enrollment.pair', { pairingCode: 'pairing-code' });
    await vi.waitFor(() => expect(server.pairRequests).toHaveLength(1));
    const control = await connect();
    expect(await control.request('shutdown', { reason: 'unpair' })).toEqual({ acknowledged: true });
    control.close();
    release();
    await pairing.catch(() => undefined);
    client.close();
    await expectStoppedForGood(current);
  }, 15_000);

  it('shutdown after the pair persisted, before its deferred start runs: the start is cancelled', async () => {
    const current = await enrolling();
    const deferred: Array<() => void> = [];
    const realSetImmediate = globalThis.setImmediate;
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
      if (String(callback).includes('startUnderLease')) {
        deferred.push(() => callback(...args));
        return realSetImmediate(() => undefined);
      }
      return realSetImmediate(callback, ...args);
    }) as typeof setImmediate);
    const client = await connect();
    await client.request('enrollment.pair', { pairingCode: 'pairing-code' });
    expect(deferred).toHaveLength(1);
    expect(await client.request('shutdown', { reason: 'unpair' })).toEqual({ acknowledged: true });
    client.close();
    await vi.waitFor(async () => expect(await gone()).toBe(true), { timeout: 5_000 });
    expect(leaseHeld()).toBe(false);
    const resume = vi.spyOn(AuthManager.prototype, 'resume');
    deferred[0]!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(resume).not.toHaveBeenCalled();
    await expectStoppedForGood(current);
  }, 15_000);

  it('shutdown while the deferred start runs after promotion: gone stays false until the lease is released, then no restart', async () => {
    const adapter = new GatedAdapter();
    const current = await enrolling(adapter);
    const client = await connect();
    await client.request('enrollment.pair', { pairingCode: 'pairing-code' });
    await adapter.reached;
    expect(await client.request('approvals.list', {})).toEqual({ approvals: [] });
    expect(await client.request('shutdown', { reason: 'unpair' })).toEqual({ acknowledged: true });
    client.close();
    expect(leaseHeld()).toBe(true);
    expect(await gone()).toBe(false);
    adapter.open();
    await vi.waitFor(async () => expect(await gone()).toBe(true), { timeout: 5_000 });
    expect(leaseHeld()).toBe(false);
    await expectStoppedForGood(current);
  }, 15_000);

  it('shutdown pipelined ahead of enrollment.pair on one connection: the pair is refused and never reaches the server', async () => {
    const current = await enrolling();
    // Hold the teardown the shutdown handler defers, so both requests reach
    // the daemon before it destroys the connection. The two are separate
    // writes, and a pipe may deliver the second after that teardown ran.
    const teardowns: Array<() => void> = [];
    const realSetImmediate = globalThis.setImmediate;
    const held = vi.spyOn(globalThis, 'setImmediate').mockImplementation(((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
      if (String(callback).includes('performControlShutdown')) {
        teardowns.push(() => callback(...args));
        return realSetImmediate(() => undefined);
      }
      return realSetImmediate(callback, ...args);
    }) as typeof setImmediate);
    const client = await connect();
    const shutdown = client.request('shutdown', { reason: 'unpair' });
    const pairing = client.request('enrollment.pair', { pairingCode: 'pairing-code' });
    expect(await shutdown).toEqual({ acknowledged: true });
    await expect(pairing).rejects.toMatchObject({ code: 'shutting_down' });
    expect(teardowns).toHaveLength(1);
    expect(server.pairRequests).toHaveLength(0);
    expect(leaseHeld()).toBe(true);
    held.mockRestore();
    teardowns[0]!();
    await expectStoppedForGood(current);
    expect(server.pairRequests).toHaveLength(0);
    client.close();
  }, 15_000);

  it('a start that fails after promotion releases the lease before gone, and a fresh unpair then succeeds', async () => {
    const current = await enrolling(new FailingDetectAdapter());
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = await connect();
    const settled = vi.waitFor(async () => expect(await gone()).toBe(true), { timeout: 5_000, interval: 5 });
    const violations = watchGoneWhileHeld((await ownerNonce())!, settled);
    await client.request('enrollment.pair', { pairingCode: 'pairing-code' });
    client.close();
    expect(await violations).toBe(0);
    expect(leaseHeld()).toBe(false);
    await expect(build().unpair()).resolves.toBeUndefined();
    await expectStoppedForGood(current);
  }, 15_000);
});
