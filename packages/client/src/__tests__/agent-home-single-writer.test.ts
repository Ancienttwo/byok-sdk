import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope, type RuntimeId } from '@byok-sdk/protocol';
import {
  AGENT_HOME_DIRECTORY,
  AGENT_HOME_INTERNAL_DIRECTORY,
  stableAgentHomeOwnerId,
} from '../agent-home';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal';
import { LocalStoragePressureEngine } from '../daemon/journal/storage-policy';
import { RuntimeDisposalFailure } from '../runtime-failure';
import type { RuntimeAdapterPrepareInput, RuntimeAdapterPrepareResult } from '../types';
import { connectControlClient } from '../bin/control-client';
import { type ControlStatusResult } from '../daemon/control-protocol';
import { TestServer } from './fixtures/test-server';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

/**
 * WP0 regression suite for the per-canonical-Agent-home single-writer gate
 * (`plans/plan-20260903-0436-agent-home-single-writer.md`).
 *
 * The invariant under test: at most
 * `DaemonConfig.maxConcurrentMutableSessionsPerAgentHome` (default 1) Attempts
 * may hold an execution lease in one canonical Agent home at a time, across
 * every lane and every session, and the slot is surrendered only after the
 * attempt is terminal AND `Session.close()` succeeded.
 */

async function temp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Records `prepare()` so a test can prove the busy gate ran before adapter admission. */
class LaneAdapter extends StubRuntimeAdapter {
  prepareCalls = 0;

  override async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    this.prepareCalls += 1;
    return super.prepare(input);
  }
}

function declineReason(envelope: Envelope): string {
  return (envelope.payload as { reason: string }).reason;
}

function declineRetryable(envelope: Envelope): boolean {
  return (envelope.payload as { retryable: boolean }).retryable;
}

describe('canonical Agent home single writer (WP0)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => { server = await TestServer.start(); });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  interface Harness {
    readonly daemon: Daemon;
    readonly pi: LaneAdapter;
    readonly claude: LaneAdapter;
    readonly hostStorageRoot: string;
    readonly storeDir: string;
    readonly productId: string;
  }

  async function start(
    overrides: Partial<DaemonConfig> = {},
    fixed: { hostStorageRoot?: string; storeDir?: string; productId?: string } = {},
  ): Promise<Harness> {
    const workspaceRoot = await temp('byok-single-writer-workspace-');
    const storeDir = fixed.storeDir ?? await temp('byok-single-writer-store-');
    const hostStorageRoot = fixed.hostStorageRoot ?? await temp('byok-single-writer-home-');
    const productId = fixed.productId ?? `single-writer-${path.basename(storeDir)}`;
    const pi = new LaneAdapter('pi');
    const claude = new LaneAdapter('claude');
    const started = createDaemonWithAdapters({
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Single writer',
      productId,
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
      agentHome: { hostStorageRoot },
      ...overrides,
    }, [pi, claude]);
    daemon = started;
    await started.pair('pairing-code');
    await started.start();
    await server.waitFor((entry) => entry.type === 'conn.hello');
    return { daemon: started, pi, claude, hostStorageRoot, storeDir, productId };
  }

  function offer(
    taskId: string,
    agentId: string,
    runtime?: RuntimeId,
  ): Envelope {
    return createEnvelope('task.offer_for_agent', {
      instruction: `work for ${agentId}`,
      policy: { mode: 'auto' },
      agentRef: { agentId, profileRevision: 'r1' },
      ...(runtime === undefined ? {} : { runtime }),
    }, { taskId, seq: server.nextSeq() });
  }

  function declineFor(taskId: string): (entry: Envelope) => boolean {
    return (entry) => entry.type === 'task.decline' && entry.task_id === taskId;
  }

  /** Poll a daemon-observable predicate instead of sleeping on a fixed delay. */
  async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  it('declines a second session of one Agent on a different lane before any adapter preparation', async () => {
    const harness = await start();

    server.send(offer('same-home-first', 'shared-agent', 'pi'));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'same-home-first');

    server.send(offer('same-home-second', 'shared-agent', 'claude'));
    const declined = await server.waitFor(declineFor('same-home-second'));

    expect(declineReason(declined)).toBe('agent home busy: 1 active attempt(s)');
    expect(declineRetryable(declined)).toBe(true);
    // Counts only: no home path, no agentId, no prompt text on the wire.
    expect(declineReason(declined)).not.toContain(harness.hostStorageRoot);
    expect(declineReason(declined)).not.toContain('shared-agent');
    expect(declineReason(declined)).not.toContain('work for');

    // Declined before admission: the second lane was never asked to prepare,
    // never started a process, and no workspace or claim was produced.
    expect(harness.claude.prepareCalls).toBe(0);
    expect(harness.claude.startCalls).toHaveLength(0);
    expect(harness.claude.sessions).toHaveLength(0);
    expect(server.received.some((entry) => entry.type === 'task.claim' && entry.task_id === 'same-home-second')).toBe(false);

    expect(harness.daemon.status().agentHomeExecution).toEqual({
      maxConcurrentMutableSessionsPerAgentHome: 1,
      activeHomes: 1,
      activeAttempts: 1,
    });
  });

  it('runs two different canonical Agent homes in parallel', async () => {
    const harness = await start();

    server.send(offer('home-a', 'agent-a', 'pi'));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'home-a');
    server.send(offer('home-b', 'agent-b', 'pi'));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'home-b');

    expect(harness.pi.startCalls).toHaveLength(2);
    expect(harness.pi.startCalls[0]!.ctx.workspaceDir).not.toBe(harness.pi.startCalls[1]!.ctx.workspaceDir);
    expect(server.received.filter((entry) => entry.type === 'task.decline')).toHaveLength(0);
    expect(harness.daemon.status().agentHomeExecution).toEqual({
      maxConcurrentMutableSessionsPerAgentHome: 1,
      activeHomes: 2,
      activeAttempts: 2,
    });
  });

  it('releases the slot only after the attempt is terminal and its session closed', async () => {
    const harness = await start();

    server.send(offer('release-first', 'release-agent', 'pi'));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'release-first');
    const session = harness.pi.sessions[0]!;
    session.emit({ type: 'turn_end' });
    await server.waitFor((entry) => entry.type === 'task.complete' && entry.task_id === 'release-first');
    await waitUntil(
      () => harness.daemon.status().agentHomeExecution.activeAttempts === 0,
      'the completed attempt to release its Agent home slot',
    );
    expect(session.closeCalled).toBe(true);

    server.send(offer('release-second', 'release-agent', 'claude'));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'release-second');
    expect(harness.claude.startCalls).toHaveLength(1);
  });

  it('keeps the home busy when disposal fails, and says so in status', async () => {
    const harness = await start();

    server.send(offer('disposal-first', 'disposal-agent', 'pi'));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'disposal-first');
    const session = harness.pi.sessions[0]!;
    let closeAttempted = false;
    session.close = async (): Promise<void> => {
      closeAttempted = true;
      throw new RuntimeDisposalFailure({ stage: 'quiescence', reason: 'stub refuses to quiesce' });
    };
    session.emit({ type: 'turn_end' });
    await waitUntil(() => closeAttempted, 'the failing Session.close() attempt');

    // Fail closed: a home whose writer could not be proven gone stays busy.
    expect(harness.daemon.status().agentHomeExecution).toEqual({
      maxConcurrentMutableSessionsPerAgentHome: 1,
      activeHomes: 1,
      activeAttempts: 1,
    });
    server.send(offer('disposal-second', 'disposal-agent', 'claude'));
    const declined = await server.waitFor(declineFor('disposal-second'));
    expect(declineReason(declined)).toBe('agent home busy: 1 active attempt(s)');
    expect(harness.claude.prepareCalls).toBe(0);

    // Let the shutdown in `afterEach` reach a quiescent runtime again; the
    // held slot above is the assertion, not a permanently wedged fixture.
    session.close = async (): Promise<void> => {};
  });

  it('releases a cancelled attempt only once its session has closed', async () => {
    const harness = await start();

    server.send(offer('cancel-first', 'cancel-agent', 'pi'));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'cancel-first');
    const session = harness.pi.sessions[0]!;
    // Observe the count from INSIDE `Session.close()`: the slot must still be
    // held while the runtime is being torn down, and only then surrendered.
    // (Observed in-band rather than by blocking close from a second offer:
    // `ConnectionManager` runs every envelope through one serial chain, so a
    // blocked close would stall the very offer meant to probe it.)
    const closeOriginal = session.close.bind(session);
    let attemptsDuringClose: number | undefined;
    session.close = async (): Promise<void> => {
      attemptsDuringClose = harness.daemon.status().agentHomeExecution.activeAttempts;
      await closeOriginal();
    };

    server.send(createEnvelope('task.cancel', { reason: 'operator cancelled' }, { taskId: 'cancel-first', seq: server.nextSeq() }));
    await server.waitFor((entry) => entry.type === 'task.cancelled' && entry.task_id === 'cancel-first');
    await waitUntil(
      () => harness.daemon.status().agentHomeExecution.activeAttempts === 0,
      'the cancelled attempt to release its Agent home slot after close',
    );
    expect(session.interruptCalled).toBe(true);
    expect(attemptsDuringClose).toBe(1);

    server.send(offer('cancel-second', 'cancel-agent', 'claude'));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'cancel-second');
    expect(harness.claude.startCalls).toHaveLength(1);
  });

  it('reclaims crash residue under the same stable owner identity and stays closed under a foreign one', async () => {
    const storeDir = await temp('byok-single-writer-residue-store-');
    const hostStorageRoot = await temp('byok-single-writer-residue-home-');
    const productId = `single-writer-residue-${path.basename(storeDir)}`;
    const agentRef = { agentId: 'residue-agent', profileRevision: 'r1' };
    const homeDir = path.join(await fs.realpath(hostStorageRoot), AGENT_HOME_DIRECTORY, agentRef.agentId);
    const markerPath = path.join(homeDir, AGENT_HOME_INTERNAL_DIRECTORY, 'agent-home.lease');
    const writeMarker = async (ownerId: string): Promise<void> => {
      await fs.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.writeFile(markerPath, JSON.stringify({
        version: 1,
        ownerId,
        leaseId: '00000000-0000-4000-8000-000000000000',
        agentRef,
        canonicalHome: homeDir,
      }), { mode: 0o600 });
    };

    // A marker left by a crashed daemon with a DIFFERENT identity is not this
    // daemon's to reclaim: the offer is declined rather than co-writing.
    await writeMarker('store-product:not-this-daemon');
    const foreign = await start({}, { storeDir, hostStorageRoot, productId });
    server.send(offer('residue-foreign', agentRef.agentId, 'pi'));
    const declined = await server.waitFor(declineFor('residue-foreign'));
    expect(declineReason(declined)).toMatch(/already has a mutable writer lease/);
    expect(foreign.pi.startCalls).toHaveLength(0);
    await foreign.daemon.stop();
    daemon = undefined;

    // The same stable owner identity restarting after a crash reclaims it.
    await writeMarker(stableAgentHomeOwnerId(storeDir, productId));
    const restarted = await start({}, { storeDir, hostStorageRoot, productId });
    server.send(offer('residue-reclaimed', agentRef.agentId, 'pi'));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'residue-reclaimed');
    expect(restarted.daemon.status().agentHomeExecution.activeAttempts).toBe(1);
  });

  it('admits exactly the configured number of Attempts when a host raises the limit', async () => {
    const harness = await start({ maxConcurrentMutableSessionsPerAgentHome: 2 });

    server.send(offer('limit-one', 'limit-agent', 'pi'));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'limit-one');
    server.send(offer('limit-two', 'limit-agent', 'pi'));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'limit-two');
    server.send(offer('limit-three', 'limit-agent', 'pi'));
    const declined = await server.waitFor(declineFor('limit-three'));

    expect(declineReason(declined)).toBe('agent home busy: 2 active attempt(s)');
    expect(declineRetryable(declined)).toBe(true);
    expect(harness.daemon.status().agentHomeExecution).toEqual({
      maxConcurrentMutableSessionsPerAgentHome: 2,
      activeHomes: 1,
      activeAttempts: 2,
    });
    // Same lane on purpose: two concurrent Attempts in one home must still
    // carry distinct runtime sessionRefs, which the execution lease manager
    // enforces independently of this cap.
    expect(harness.pi.startCalls).toHaveLength(2);
    expect(harness.claude.startCalls).toHaveLength(0);
  });

  it('never lets a pre-cancelled or duplicate offer consume a slot', async () => {
    const harness = await start();

    server.send(createEnvelope('task.cancel', { reason: 'cancelled first' }, { taskId: 'precancel', seq: server.nextSeq() }));
    server.send(offer('precancel', 'ordering-agent', 'pi'));
    const cancelled = await server.waitFor(declineFor('precancel'));
    expect(declineReason(cancelled)).toMatch(/cancelled before claim/);
    expect(harness.daemon.status().agentHomeExecution.activeAttempts).toBe(0);
    expect(harness.pi.prepareCalls).toBe(0);

    const first = offer('ordering-first', 'ordering-agent', 'pi');
    server.send(first);
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'ordering-first');
    expect(harness.daemon.status().agentHomeExecution.activeAttempts).toBe(1);

    // A redelivered offer for a task this device already claimed is deduped
    // above the busy gate: no second slot, and no second decline either.
    server.send({ ...first, seq: server.nextSeq() });
    // Deterministic barrier rather than a sleep: `ConnectionManager` runs every
    // envelope through one serial chain, so a claim for this later offer proves
    // the duplicate queued ahead of it has already been processed. A different
    // Agent on purpose — a same-home offer would be declined busy and would
    // prove nothing about whether the duplicate consumed a slot.
    server.send(offer('ordering-barrier', 'ordering-other-agent', 'claude'));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'ordering-barrier');
    expect(server.received.filter(declineFor('ordering-first'))).toHaveLength(0);
    expect(harness.pi.startCalls).toHaveLength(1);
    // One attempt per home, two homes: the duplicate consumed no second slot.
    expect(harness.daemon.status().agentHomeExecution).toEqual({
      maxConcurrentMutableSessionsPerAgentHome: 1,
      activeHomes: 2,
      activeAttempts: 2,
    });
  });

  it('creates no Agent home directory for an offer the host admission guard vetoes', async () => {
    // The busy count runs BEFORE the host's admission veto, so it must read
    // the canonical home without materializing it: a vetoed offer has to leave
    // the Agent-home root exactly as it found it.
    const workspaceRoot = await temp('byok-single-writer-veto-workspace-');
    const storeDir = await temp('byok-single-writer-veto-store-');
    const hostStorageRoot = await temp('byok-single-writer-veto-home-');
    const journal = new SqliteLocalTaskJournal({ storeDir });
    const engine = new LocalStoragePressureEngine({
      policy: {
        maxStoreBytes: 1024 * 1024 * 1024,
        minFreeBytes: 100 * 1024 * 1024,
        softMinFreeBytes: 200 * 1024 * 1024,
        ackCriticalReserveBytes: 8 * 1024 * 1024,
      },
      journal,
      // Under the hard watermark, so `admissionGuard()` refuses new offers.
      freeBytesProvider: () => 50 * 1024 * 1024,
    });
    const pi = new LaneAdapter('pi');
    const started = createDaemonWithAdapters({
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Single writer',
      productId: `single-writer-veto-${path.basename(storeDir)}`,
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
      agentHome: { hostStorageRoot },
      hostedJournal: { mode: 'sqlite' },
    }, [pi], { hostedJournal: { journal, pressureEngine: engine } });
    daemon = started;
    try {
      await started.pair('pairing-code');
      await started.start();
      await server.waitFor((entry) => entry.type === 'conn.hello');
      expect((await engine.tick()).state).toBe('hard-pressure');

      const agentsRoot = path.join(await fs.realpath(hostStorageRoot), AGENT_HOME_DIRECTORY);
      server.send(offer('veto-task', 'veto-agent', 'pi'));
      const declined = await server.waitFor(declineFor('veto-task'));

      // Declined by the host, not by the single-writer gate.
      expect(declineReason(declined)).not.toContain('agent home busy');
      await expect(fs.stat(path.join(agentsRoot, 'veto-agent'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(pi.prepareCalls).toBe(0);
      expect(pi.startCalls).toHaveLength(0);
      expect(started.status().agentHomeExecution.activeAttempts).toBe(0);
    } finally {
      await started.stop();
      daemon = undefined;
      await journal.close();
    }
  });

  it('creates nothing new in the Agent home root for a busy-declined offer', async () => {
    const harness = await start();

    server.send(offer('busy-fs-first', 'busy-fs-agent', 'pi'));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'busy-fs-first');
    const agentsRoot = path.join(await fs.realpath(harness.hostStorageRoot), AGENT_HOME_DIRECTORY);
    const before = (await fs.readdir(agentsRoot)).sort();

    server.send(offer('busy-fs-second', 'busy-fs-agent', 'claude'));
    const declined = await server.waitFor(declineFor('busy-fs-second'));
    expect(declineReason(declined)).toBe('agent home busy: 1 active attempt(s)');
    expect((await fs.readdir(agentsRoot)).sort()).toEqual(before);
  });

  it('declines an in-root symlinked Agent home instead of keying another Agent\'s count', async () => {
    const harness = await start();

    // A real home for `one`, materialized by the same `resolve()` path a live
    // offer uses, and left holding its single writer slot.
    server.send(offer('symlink-real', 'one', 'pi'));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'symlink-real');
    const agentsRoot = path.join(await fs.realpath(harness.hostStorageRoot), AGENT_HOME_DIRECTORY);
    const realHome = path.join(agentsRoot, 'one');
    const linkHome = path.join(agentsRoot, 'two');
    try {
      await fs.symlink(realHome, linkHome);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        console.warn(`skipping: this platform refuses symlink creation (${code})`);
        return;
      }
      throw error;
    }

    // `two` is a distinct Agent identity whose lexical home is a symlink to
    // `one`. The pre-admission count must not follow it: it fails closed
    // through the resolution error path rather than reading `one`'s count.
    server.send(offer('symlink-alias', 'two', 'claude'));
    const declined = await server.waitFor(declineFor('symlink-alias'));
    expect(declineReason(declined)).not.toContain('agent home busy');
    expect(declineReason(declined)).toMatch(/is not a real directory/);
    expect(declineRetryable(declined)).toBe(false);
    expect(harness.claude.prepareCalls).toBe(0);
    expect(harness.claude.startCalls).toHaveLength(0);

    // `one` is untouched: still exactly one attempt in exactly one home, and
    // the alias was never materialized into a second directory.
    expect(harness.daemon.status().agentHomeExecution).toEqual({
      maxConcurrentMutableSessionsPerAgentHome: 1,
      activeHomes: 1,
      activeAttempts: 1,
    });
    expect((await fs.lstat(linkHome)).isSymbolicLink()).toBe(true);
    expect((await fs.readdir(agentsRoot)).sort()).toEqual(['one', 'two']);
  });

  it('projects the same counts into the authenticated local control status', async () => {
    const harness = await start();
    server.send(offer('control-status', 'control-agent', 'pi'));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'control-status');

    const conn = await connectControlClient({ storeDir: harness.storeDir, productId: harness.productId });
    if (!conn.ok) throw new Error('expected the control socket to be reachable');
    try {
      const status = await conn.client.request<ControlStatusResult>('status');
      expect(status.agentHomeExecution).toEqual(harness.daemon.status().agentHomeExecution);
      expect(status.agentHomeExecution).toEqual({
        maxConcurrentMutableSessionsPerAgentHome: 1,
        activeHomes: 1,
        activeAttempts: 1,
      });
      // Counts only: the control status never names a home path or an Agent.
      expect(JSON.stringify(status.agentHomeExecution)).not.toContain(harness.hostStorageRoot);
    } finally {
      conn.client.close();
    }
  });

  it('rejects an unusable concurrency limit at construction instead of reinterpreting it', async () => {
    const workspaceRoot = await temp('byok-single-writer-invalid-workspace-');
    const storeDir = await temp('byok-single-writer-invalid-store-');
    const hostStorageRoot = await temp('byok-single-writer-invalid-home-');
    const build = (limit: number): Daemon => createDaemonWithAdapters({
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Single writer',
      productId: `single-writer-invalid-${limit}`,
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
      agentHome: { hostStorageRoot },
      maxConcurrentMutableSessionsPerAgentHome: limit,
    }, [new LaneAdapter('pi')]);

    for (const limit of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => build(limit)).toThrow(/maxConcurrentMutableSessionsPerAgentHome must be a positive safe integer/);
    }
    expect(() => build(3)).not.toThrow();
  });
});
