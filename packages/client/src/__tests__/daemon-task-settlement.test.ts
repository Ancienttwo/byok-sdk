import { FRESH_DAEMON_EGRESS, FRESH_OFFER } from './fixtures/fresh-offer';
import { freshTestAgentRef, testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, encodeEnvelope } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { DaemonTaskUnknownError, TaskSettlementRegistry, type DaemonTaskSettlement } from '../daemon/task-settlement';
import { LocalStorageEmergencyError } from '../daemon/retention/pressure';
import { SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal';
import { journalHash } from '../daemon/journal/journal';
import { CursorStore } from '../daemon/cursor-store';
import { RuntimeDisposalFailure } from '../runtime-failure';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

describe('Daemon.whenTaskSettled', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => { server = await TestServer.start(); });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  function build(adapter: StubRuntimeAdapter, storeDir: string): Daemon {
    daemon = createDaemonWithAdapters({
      agentHome: testAgentHomeConfig(), agentEgress: FRESH_DAEMON_EGRESS, storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product', productId: 'test-product-settlement',
      serverUrl: server.url, storeDir,
    }, [adapter]);
    return daemon;
  }

  async function started(adapter: StubRuntimeAdapter, storeDir?: string): Promise<{ d: Daemon; storeDir: string }> {
    const dir = storeDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'byok-settlement-'));
    const d = build(adapter, dir);
    if (storeDir === undefined) await d.pair('pairing-code');
    await d.start();
    return { d, storeDir: dir };
  }

  function offer(taskId: string, extra: Record<string, unknown> = {}): void {
    server.send(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), instruction: 'work', ...FRESH_OFFER, ...extra },
      { taskId, seq: server.nextSeq() }));
  }

  /** Tracks whether the awaitable has settled without awaiting it. */
  function track(promise: Promise<DaemonTaskSettlement>): { settled: () => boolean } {
    let done = false;
    void promise.then(() => { done = true; }, () => { done = true; });
    return { settled: () => done };
  }

  it('waits for the session close after the terminal is accepted, then reports the task as disposed', async () => {
    const adapter = new StubRuntimeAdapter();
    const { d } = await started(adapter);
    offer('task-complete');
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-complete');
    const [session] = adapter.sessions;
    const release = session!.blockClose();
    const settlement = d.whenTaskSettled('task-complete');
    const tracked = track(settlement);
    session!.emit({ type: 'turn_end' });
    await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-complete');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(tracked.settled()).toBe(false);
    release();
    await expect(settlement).resolves.toEqual({ terminal: 'complete', delivery: 'accepted', disposal: 'disposed' });
    await expect(d.whenTaskSettled('task-complete')).resolves.toEqual({ terminal: 'complete', delivery: 'accepted', disposal: 'disposed' });
  });

  it('reports a failed close as disposal failed', async () => {
    const adapter = new StubRuntimeAdapter();
    const { d } = await started(adapter);
    offer('task-close-fails');
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-close-fails');
    const [session] = adapter.sessions;
    vi.spyOn(session!, 'close').mockRejectedValueOnce(new RuntimeDisposalFailure({ stage: 'quiescence', reason: 'process still running' }));
    session!.emit({ type: 'turn_end' });
    await expect(d.whenTaskSettled('task-close-fails', { signal: AbortSignal.timeout(10_000) }))
      .resolves.toEqual({ terminal: 'complete', delivery: 'accepted', disposal: 'failed' });
  });

  it('settles a pre-claim decline without a runtime', async () => {
    const { d } = await started(new StubRuntimeAdapter());
    offer('task-decline', { harnessId: 'acme-harness', runtime: 'claude' });
    await server.waitFor((e) => e.type === 'task.decline' && e.task_id === 'task-decline');
    await expect(d.whenTaskSettled('task-decline')).resolves.toEqual({ terminal: 'declined', delivery: 'accepted', disposal: 'none' });
  });

  it('resolves when called from the offered listener, before the offer is journaled', async () => {
    const { d } = await started(new StubRuntimeAdapter());
    let settlement: Promise<DaemonTaskSettlement> | undefined;
    d.subscribe((event) => {
      if (event.kind === 'offered' && event.taskId === 'task-from-offered') settlement = d.whenTaskSettled('task-from-offered');
    });
    offer('task-from-offered', { harnessId: 'acme-harness', runtime: 'claude' });
    await vi.waitFor(() => expect(settlement).toBeDefined());
    await expect(settlement).resolves.toEqual({ terminal: 'declined', delivery: 'accepted', disposal: 'none' });
  });

  it('reports the first settlement when the cloud refuses the terminal', async () => {
    const adapter = new StubRuntimeAdapter();
    const { d } = await started(adapter);
    let refused = false;
    server.setOutboundRefusal((envelope) => {
      if (refused || envelope.type !== 'task.complete') return undefined;
      refused = true;
      return 'invalid_transition';
    });
    offer('task-refused');
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-refused');
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await expect(d.whenTaskSettled('task-refused')).resolves.toEqual({ terminal: 'complete', delivery: 'rejected', disposal: 'disposed' });
  });

  it('a cancel during start settles only after the start returns and its runtime is disposed', async () => {
    const adapter = new StubRuntimeAdapter();
    const { d } = await started(adapter);
    const release = adapter.blockStart();
    offer('task-cancel-in-start');
    await server.waitFor((e) => e.type === 'task.claim' && e.task_id === 'task-cancel-in-start');
    // task.claim precedes start(); a cancel before it would leave no runtime to dispose.
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));
    const settlement = d.whenTaskSettled('task-cancel-in-start');
    const tracked = track(settlement);
    server.send(createEnvelope('task.cancel', { reason: 'host cancelled' }, { taskId: 'task-cancel-in-start', seq: server.nextSeq() }));
    // The aborted start registers its runtime before the terminal goes out.
    await server.waitFor((e) => e.type === 'task.cancelled' && e.task_id === 'task-cancel-in-start');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(tracked.settled()).toBe(false);
    release();
    await expect(settlement).resolves.toEqual({ terminal: 'cancelled', delivery: 'accepted', disposal: 'disposed' });
    expect(server.received.some((e) => e.task_id === 'task-cancel-in-start' && e.type === 'task.started')).toBe(false);
  });

  it('reads a task settled before a restart from the journal, and rejects unknown, aborted and not-started calls', async () => {
    const adapter = new StubRuntimeAdapter();
    const first = await started(adapter);
    await expect(first.d.whenTaskSettled('task-x', { signal: AbortSignal.abort('stop waiting') })).rejects.toBe('stop waiting');
    offer('task-before-restart');
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-before-restart');
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await first.d.whenTaskSettled('task-before-restart');
    await first.d.stop();

    const restarted = build(new StubRuntimeAdapter(), first.storeDir);
    await expect(restarted.whenTaskSettled('task-before-restart')).rejects.toThrow(/not started/i);
    await restarted.start();
    await expect(restarted.whenTaskSettled('task-before-restart'))
      .resolves.toEqual({ terminal: 'complete', delivery: 'accepted', disposal: 'none' });
    await expect(restarted.whenTaskSettled('no-such-task')).rejects.toMatchObject({
      constructor: DaemonTaskUnknownError, code: 'daemon_task_unknown', taskId: 'no-such-task',
    });
  });

  it('settles a suppressed offer for waiting and late reads, fences redelivery, and reads the recovery failure after restart', async () => {
    const first = await started(new StubRuntimeAdapter());
    await first.d.stop();
    const taskId = 'task-suppressed-offer';
    const identity = { tenantId: 'tenant-test', productId: 'test-product-settlement', deviceId: 'device-1' };
    const original = createEnvelope('task.offer', { agentRef: freshTestAgentRef(), instruction: 'work', ...FRESH_OFFER },
      { taskId, seq: server.nextSeq() });
    const bytes = encodeEnvelope(original);
    // Crash window: the offer is durable, but its cursor and admission are not.
    const journal = new SqliteLocalTaskJournal({ storeDir: first.storeDir });
    await journal.appendEnvelope({ identity, envelopeId: original.id, taskId, seq: original.seq!, bytes,
      bytesHash: journalHash(bytes), receivedAt: original.ts, opensTask: true });
    await journal.close();

    const adapter = new StubRuntimeAdapter();
    const d = build(adapter, first.storeDir);
    await d.start();
    const read = vi.spyOn(SqliteLocalTaskJournal.prototype, 'readTask');
    try {
      const waiting = d.whenTaskSettled(taskId, { signal: AbortSignal.timeout(2_000) });
      const tracked = track(waiting);
      await vi.waitFor(() => expect(read).toHaveBeenCalledWith(taskId, identity));
      expect(tracked.settled()).toBe(false);
      // Cloud suppression means only the authoritative cancellation is delivered.
      server.send(createEnvelope('task.cancel', { reason: 'cancelled while daemon was down' },
        { taskId, seq: server.nextSeq() }));
      const expected = { terminal: 'cancelled', delivery: 'not-required', disposal: 'none' };
      await expect(waiting).resolves.toEqual(expected);
      await expect(d.whenTaskSettled(taskId)).resolves.toEqual(expected);

      // A later delivery of the same execution contract cannot reopen admission.
      const redelivery = createEnvelope('task.offer', original.payload, { taskId, seq: server.nextSeq() });
      server.send(redelivery);
      const cursor = new CursorStore(first.storeDir);
      await vi.waitFor(async () => expect(await cursor.load(server.url, identity.deviceId)).toBe(redelivery.seq));
      await expect(d.whenTaskSettled(taskId)).resolves.toEqual(expected);
      expect(adapter.startCalls).toHaveLength(0);
      expect(server.received.filter((e) => e.task_id === taskId)).toEqual([]);
      await d.stop();

      // Known limit (#1955): the journal reader exposes no inbound cancel.
      // With the cursor now past it, ordinary received-task recovery fails it.
      const restartedAdapter = new StubRuntimeAdapter();
      const restarted = build(restartedAdapter, first.storeDir);
      await restarted.start();
      await expect(restarted.whenTaskSettled(taskId, { signal: AbortSignal.timeout(2_000) }))
        .resolves.toEqual({ terminal: 'failed', delivery: 'accepted', disposal: 'none' });
      expect(restartedAdapter.startCalls).toHaveLength(0);
      expect(server.received.filter((e) => e.task_id === taskId)).toEqual([
        expect.objectContaining({ type: 'task.fail', payload: expect.objectContaining({ reason: 'daemon_interrupted' }) }),
      ]);
    } finally {
      read.mockRestore();
    }
  });

  it('rejects the waiter of an offer whose journal append failed with that error', async () => {
    const append = vi.spyOn(SqliteLocalTaskJournal.prototype, 'appendEnvelope').mockRejectedValueOnce(new Error('disk I/O error'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { d } = await started(new StubRuntimeAdapter());
      // The rejection is observed where the wait starts: the offered listener runs before the append fails.
      let outcome: Promise<unknown> | undefined;
      d.subscribe((event) => {
        if (event.kind === 'offered' && event.taskId === 'task-append-failed') {
          outcome = d.whenTaskSettled('task-append-failed').then(() => 'settled', (error: unknown) => error);
        }
      });
      offer('task-append-failed');
      await vi.waitFor(() => expect(outcome).toBeDefined());
      await expect(outcome).resolves.toMatchObject({ message: 'disk I/O error' });
      expect(append).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  describe('TaskSettlementRegistry waiters', () => {
    function registry(localState?: string): { registry: TaskSettlementRegistry; reads: () => number } {
      let reads = 0;
      const r = new TaskSettlementRegistry();
      r.bindJournal({
        readTask: async () => { reads += 1; return localState === undefined ? undefined : { localState }; },
        unconfirmedTerminal: async () => undefined,
      });
      return { registry: r, reads: () => reads };
    }

    it('drops the entry a wait created when its last waiter aborts', async () => {
      const { registry: r, reads } = registry('received');
      const controller = new AbortController();
      const waiting = r.wait('task-pending', controller.signal);
      await vi.waitFor(() => expect(reads()).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort('stop');
      await expect(waiting).rejects.toBe('stop');
      void r.wait('task-pending', AbortSignal.timeout(20)).catch(() => {});
      await vi.waitFor(() => expect(reads()).toBe(2));
    });

    it('rejects the waiters of a refused offer with the typed error, and a wait after redelivery starts clean', async () => {
      const { registry: r, reads } = registry();
      r.offerSeen('task-refused');
      const waiting = r.wait('task-refused');
      await vi.waitFor(() => expect(reads()).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const refusal = new LocalStorageEmergencyError('free space is below the ack-critical reserve');
      r.offerRefused('task-refused', refusal);
      await expect(waiting).rejects.toBe(refusal);
      await expect(r.wait('task-refused')).rejects.toBeInstanceOf(DaemonTaskUnknownError);
    });

    it('reads an offer as unknown once it is journaled without a row, not as seen', async () => {
      const { registry: r } = registry();
      r.offerSeen('task-gone');
      r.offerJournaled('task-gone');
      await expect(r.wait('task-gone')).rejects.toBeInstanceOf(DaemonTaskUnknownError);
    });
  });
});
