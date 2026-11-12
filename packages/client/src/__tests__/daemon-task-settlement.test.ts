import { FRESH_DAEMON_EGRESS, FRESH_OFFER } from './fixtures/fresh-offer';
import { freshTestAgentRef, testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, encodeEnvelope, HOST_MCP_TASK_CONTEXT_CAPABILITY } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon, type DaemonOverrides } from '../daemon/create-daemon';
import { DaemonTaskUnknownError, TaskSettlementRegistry, hasTaskCancellation, type DaemonTaskSettlement } from '../daemon/task-settlement';
import { LocalStorageEmergencyError } from '../daemon/retention/pressure';
import { SqliteLocalTaskJournal, JOURNAL_DB_FILENAME, DEFAULT_JOURNAL_BUSY_TIMEOUT_MS } from '../daemon/journal/sqlite-journal';
import { openJournalDatabase } from '../util/sqlite-support';
import { journalHash } from '../daemon/journal/journal';
import { CursorStore } from '../daemon/cursor-store';
import { SealedTasks } from '../daemon/sealed-task';
import { TaskRunner } from '../daemon/task-runner';
import { E2eeWebClient } from './fixtures/e2ee-web-client';
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

  function build(adapter: StubRuntimeAdapter, storeDir: string, overrides: DaemonOverrides = {}): Daemon {
    daemon = createDaemonWithAdapters({
      agentHome: testAgentHomeConfig(), agentEgress: FRESH_DAEMON_EGRESS, storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product', productId: 'test-product-settlement',
      serverUrl: server.url, storeDir,
    }, [adapter], overrides);
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

  it('keeps a live pre-claim cancellation pending until its selected terminal is committed', async () => {
    const adapter = new StubRuntimeAdapter();
    let releasePrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    const prepare = adapter.prepare.bind(adapter);
    const preparing = vi.spyOn(adapter, 'prepare').mockImplementation(async (input) => {
      await prepareGate;
      return prepare(input);
    });
    const { d } = await started(adapter);
    const taskId = 'task-cancel-pre-claim';
    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    const recordTerminal = SqliteLocalTaskJournal.prototype.recordTerminal;
    const terminal = vi.spyOn(SqliteLocalTaskJournal.prototype, 'recordTerminal').mockImplementation(async function (this: SqliteLocalTaskJournal, record) {
      if (record.taskId === taskId) await terminalGate;
      return recordTerminal.call(this, record);
    });
    try {
      offer(taskId);
      await vi.waitFor(() => expect(preparing).toHaveBeenCalled());
      server.send(createEnvelope('task.cancel', { reason: 'cancel preparation' }, { taskId, seq: server.nextSeq() }));
      await vi.waitFor(() => expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ taskId })));
      const settlement = d.whenTaskSettled(taskId, { signal: AbortSignal.timeout(2_000) });
      const tracked = track(settlement);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(tracked.settled()).toBe(false);
      releaseTerminal();
      releasePrepare();
      await expect(settlement).resolves.toEqual({ terminal: 'declined', delivery: 'accepted', disposal: 'none' });
      expect(adapter.startCalls).toHaveLength(0);
    } finally {
      releaseTerminal();
      releasePrepare();
      terminal.mockRestore();
      preparing.mockRestore();
    }
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

  async function recoveredOffer(taskId: string) {
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-settlement-recovery-'));
    const adapter = new StubRuntimeAdapter();
    const d = build(adapter, storeDir);
    await d.pair('pairing-code');
    const identity = { tenantId: 'tenant-test', productId: 'test-product-settlement', deviceId: 'device-1' };
    const original = createEnvelope('task.offer', { agentRef: freshTestAgentRef(), instruction: 'work', ...FRESH_OFFER },
      { taskId, seq: server.nextSeq() });
    const bytes = encodeEnvelope(original);
    // Crash window: the offer is durable, but its cursor and admission are not.
    const journal = new SqliteLocalTaskJournal({ storeDir });
    await journal.appendEnvelope({ identity, envelopeId: original.id, taskId, seq: original.seq!, bytes,
      bytesHash: journalHash(bytes), receivedAt: original.ts, opensTask: true });
    await journal.close();
    await d.start();
    const cancel = () => {
      const envelope = createEnvelope('task.cancel', { reason: 'cancelled while daemon was down' },
        { taskId, seq: server.nextSeq() });
      server.send(envelope);
      return envelope;
    };
    return { d, adapter, storeDir, identity, original, cancel };
  }

  const suppressed = { terminal: 'cancelled', delivery: 'not-required', disposal: 'none' };

  it('settles waiting and late reads of a recovered offer suppressed by cloud cancellation', async () => {
    const taskId = 'task-suppressed-offer';
    const { d, adapter, identity, cancel } = await recoveredOffer(taskId);
    const read = vi.spyOn(SqliteLocalTaskJournal.prototype, 'readTask');
    try {
      const waiting = d.whenTaskSettled(taskId, { signal: AbortSignal.timeout(2_000) });
      const tracked = track(waiting);
      await vi.waitFor(() => expect(read).toHaveBeenCalledWith(taskId, identity));
      expect(tracked.settled()).toBe(false);
      cancel();
      await expect(waiting).resolves.toEqual(suppressed);
      await expect(d.whenTaskSettled(taskId)).resolves.toEqual(suppressed);
      expect(adapter.startCalls).toHaveLength(0);
    } finally {
      read.mockRestore();
    }
  });

  it('declines a pre-cancelled offer when cancellation precedes its durable offer sequence', async () => {
    const adapter = new StubRuntimeAdapter();
    const { d } = await started(adapter);
    const taskId = 'task-cancel-before-offer';
    // Force the interleaving: the cancel reads the task only after its later offer is journaled.
    let journaled!: () => void;
    const offerJournaled = new Promise<void>((resolve) => { journaled = resolve; });
    const originalAppend = SqliteLocalTaskJournal.prototype.appendEnvelope;
    const append = vi.spyOn(SqliteLocalTaskJournal.prototype, 'appendEnvelope').mockImplementation(async function (this: SqliteLocalTaskJournal, record) {
      const receipt = await originalAppend.call(this, record);
      if (record.taskId === taskId && record.opensTask) journaled();
      return receipt;
    });
    const originalRead = SqliteLocalTaskJournal.prototype.readTask;
    const read = vi.spyOn(SqliteLocalTaskJournal.prototype, 'readTask').mockImplementation(async function (this: SqliteLocalTaskJournal, id, binding) {
      if (id === taskId) await offerJournaled;
      return originalRead.call(this, id, binding);
    });
    try {
      server.send(createEnvelope('task.cancel', { reason: 'cancel before offer' }, { taskId, seq: server.nextSeq() }));
      await vi.waitFor(() => expect(read).toHaveBeenCalledWith(taskId, expect.anything()));
      offer(taskId);
      const decline = await server.waitFor((e) => e.type === 'task.decline' && e.task_id === taskId);
      expect(decline.payload).toMatchObject({ reason: expect.stringMatching(/cancelled before claim/i) });
      await expect(d.whenTaskSettled(taskId)).resolves.toEqual({ terminal: 'declined', delivery: 'accepted', disposal: 'none' });
      expect(adapter.startCalls).toHaveLength(0);
    } finally {
      journaled();
      append.mockRestore();
      read.mockRestore();
    }
  });

  it('rejects an injected journal row whose sequence is not a safe integer', async () => {
    const adapter = new StubRuntimeAdapter();
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-settlement-injected-'));
    const journal = new SqliteLocalTaskJournal({ storeDir });
    const readTask = journal.readTask.bind(journal);
    journal.readTask = vi.fn(async (id: string, binding: Parameters<typeof readTask>[1]) => {
      const row = await readTask(id, binding);
      return row && { ...row, seq: null as unknown as number };
    });
    const d = build(adapter, storeDir, { journal });
    await d.pair('pairing-code');
    await d.start();
    const taskId = 'task-injected-null-seq';
    offer(taskId);
    await vi.waitFor(() => expect(journal.readTask).toHaveBeenCalledWith(taskId, expect.anything()));
    await expect(d.whenTaskSettled(taskId, { signal: AbortSignal.timeout(2_000) })).rejects.toThrow(/malformed.*seq/);
    expect(adapter.startCalls).toHaveLength(0);
    await d.stop();
    await journal.close();
  });

  it('starts with a frozen injected journal', async () => {
    const adapter = new StubRuntimeAdapter();
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-settlement-frozen-'));
    const journal = new SqliteLocalTaskJournal({ storeDir });
    // A Host object whose methods are own, frozen properties.
    const methods = Object.getOwnPropertyNames(SqliteLocalTaskJournal.prototype).filter((name) => name !== 'constructor');
    const frozen = Object.freeze(Object.fromEntries(methods.map((name) => [name,
      (...args: unknown[]) => (journal as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!(...args)])));
    const d = build(adapter, storeDir, { journal: frozen as unknown as SqliteLocalTaskJournal });
    await d.pair('pairing-code');
    await d.start();
    const taskId = 'task-frozen-journal';
    offer(taskId);
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === taskId);
    await d.stop();
    await journal.close();
  });

  it('does not settle a received offer when cancellation sequence equals its durable offer sequence', async () => {
    const taskId = 'task-cancel-unproven-order';
    const { d, adapter, original } = await recoveredOffer(taskId);
    const controller = new AbortController();
    const waiting = d.whenTaskSettled(taskId, { signal: controller.signal });
    const tracked = track(waiting);
    const routed = vi.spyOn(TaskRunner.prototype, 'handleEnvelope');
    try {
      server.send(createEnvelope('task.cancel', {}, { taskId, seq: original.seq! }));
      await vi.waitFor(() => expect(routed).toHaveBeenCalledWith(expect.objectContaining({ type: 'task.cancel', task_id: taskId })));
      expect(tracked.settled()).toBe(false);
      controller.abort('stop waiting without a proven order');
      await expect(waiting).rejects.toBe('stop waiting without a proven order');
      expect(adapter.startCalls).toHaveLength(0);
    } finally {
      controller.abort('cleanup');
      routed.mockRestore();
    }
  });

  it('fences redelivery of a cancelled offer within the same run', async () => {
    const taskId = 'task-cancelled-redelivery';
    const { d, adapter, storeDir, identity, original, cancel } = await recoveredOffer(taskId);
    cancel();
    await expect(d.whenTaskSettled(taskId, { signal: AbortSignal.timeout(2_000) })).resolves.toEqual(suppressed);
    const redelivery = createEnvelope('task.offer', original.payload, { taskId, seq: server.nextSeq() });
    server.send(redelivery);
    const cursor = new CursorStore(storeDir);
    await vi.waitFor(async () => expect(await cursor.load(server.url, identity.deviceId)).toBe(redelivery.seq));
    await expect(d.whenTaskSettled(taskId)).resolves.toEqual(suppressed);
    expect(adapter.startCalls).toHaveLength(0);
    expect(server.received.filter((e) => e.task_id === taskId)).toEqual([]);
  });

  it.each(['new', 'same'] as const)('preserves stored cancellation after %s-instance restart and fences redelivery', async (instance) => {
    const taskId = 'task-cancelled-restart';
    const { d, adapter, storeDir, identity, original, cancel } = await recoveredOffer(taskId);
    const cancellation = cancel();
    await expect(d.whenTaskSettled(taskId, { signal: AbortSignal.timeout(2_000) })).resolves.toEqual(suppressed);
    const cursor = new CursorStore(storeDir);
    await vi.waitFor(async () => expect(await cursor.load(server.url, identity.deviceId)).toBe(cancellation.seq));
    await d.stop();
    // The stored cancellation is authoritative after the run-local cache expires.
    const restartedAdapter = instance === 'same' ? adapter : new StubRuntimeAdapter();
    const restarted = instance === 'same' ? d : build(restartedAdapter, storeDir);
    await restarted.start();
    await expect(restarted.whenTaskSettled(taskId, { signal: AbortSignal.timeout(2_000) }))
      .resolves.toEqual(suppressed);
    expect(restartedAdapter.startCalls).toHaveLength(0);
    expect(server.received.filter((e) => e.task_id === taskId)).toEqual([]);
    const redelivery = createEnvelope('task.offer', original.payload, { taskId, seq: server.nextSeq() });
    server.send(redelivery);
    await vi.waitFor(async () => expect(await cursor.load(server.url, identity.deviceId)).toBe(redelivery.seq));
    await expect(restarted.whenTaskSettled(taskId)).resolves.toEqual(suppressed);
    expect(restartedAdapter.startCalls).toHaveLength(0);
    expect(server.received.filter((e) => e.task_id === taskId)).toEqual([]);
  });

  it('does not run a cancelled offer after retention pruned its evidence and the mailbox suppresses it', async () => {
    const taskId = 'task-cancelled-pruned';
    const { d, adapter, storeDir, identity, cancel } = await recoveredOffer(taskId);
    const cancellation = cancel();
    await expect(d.whenTaskSettled(taskId, { signal: AbortSignal.timeout(2_000) })).resolves.toEqual(suppressed);
    await vi.waitFor(async () => expect(await new CursorStore(storeDir).load(server.url, identity.deviceId)).toBe(cancellation.seq));
    await d.stop();
    const journal = new SqliteLocalTaskJournal({ storeDir });
    await expect(journal.listPrunableConfirmedTasks(new Date(Date.now() + 60_000), 10)).resolves.toEqual([taskId]);
    await expect(journal.pruneConfirmedJournalTask(taskId)).resolves.toBe(true);
    await journal.close();
    await d.start();
    // A conforming mailbox never redelivers the cancelled offer; later traffic still flows.
    offer('task-after-prune', { harnessId: 'acme-harness', runtime: 'claude' });
    await server.waitFor((e) => e.type === 'task.decline' && e.task_id === 'task-after-prune');
    await expect(d.whenTaskSettled(taskId)).rejects.toBeInstanceOf(DaemonTaskUnknownError);
    expect(adapter.startCalls).toHaveLength(0);
    expect(server.received.filter((e) => e.task_id === taskId)).toEqual([]);
  });

  it('leaves a stored offer after its acknowledged pre-cancel to the mailbox suppression contract after restart', async () => {
    const taskId = 'task-pre-cancel-restart';
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-settlement-recovery-'));
    const adapter = new StubRuntimeAdapter();
    const d = build(adapter, storeDir);
    await d.pair('pairing-code');
    const identity = { tenantId: 'tenant-test', productId: 'test-product-settlement', deviceId: 'device-1' };
    const cancellation = createEnvelope('task.cancel', { reason: 'operator cancelled first' }, { taskId, seq: server.nextSeq() });
    const original = createEnvelope('task.offer', { agentRef: freshTestAgentRef(), instruction: 'work', ...FRESH_OFFER },
      { taskId, seq: server.nextSeq() });
    // Crash window: the pre-cancel is acknowledged and the offer is durable, but its decline was never committed.
    const journal = new SqliteLocalTaskJournal({ storeDir });
    for (const [envelope, opensTask] of [[cancellation, false], [original, true]] as const) {
      const bytes = encodeEnvelope(envelope);
      await journal.appendEnvelope({ identity, envelopeId: envelope.id, taskId, seq: envelope.seq!, bytes,
        bytesHash: journalHash(bytes), receivedAt: envelope.ts, opensTask });
    }
    await journal.close();
    await new CursorStore(storeDir).save(server.url, identity.deviceId, cancellation.seq!);
    await d.start();
    const settlement = d.whenTaskSettled(taskId, { signal: AbortSignal.timeout(2_000) });
    const tracked = track(settlement);
    // A conforming mailbox resumes after the cursor and suppresses the cancelled task's offer, so
    // only later traffic arrives. The earlier cancellation is not authority over this offer.
    offer('task-after-pre-cancel', { harnessId: 'acme-harness', runtime: 'claude' });
    await server.waitFor((e) => e.type === 'task.decline' && e.task_id === 'task-after-pre-cancel');
    expect(tracked.settled()).toBe(false);
    expect(adapter.startCalls).toHaveLength(0);
    expect(server.received.filter((e) => e.task_id === taskId)).toEqual([]);
    await expect(settlement).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('keeps the runtime settlement when an offer gains an owner during the cancellation journal read', async () => {
    const taskId = 'task-cancel-admission-race';
    const { d, adapter, original } = await recoveredOffer(taskId);

    let reading!: () => void;
    const entered = new Promise<void>((resolve) => { reading = resolve; });
    let releaseRead!: () => void;
    const heldRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    const originalRead = SqliteLocalTaskJournal.prototype.readTask;
    const read = vi.spyOn(SqliteLocalTaskJournal.prototype, 'readTask').mockImplementationOnce(async function (this: SqliteLocalTaskJournal, id, binding) {
      const row = await originalRead.call(this, id, binding);
      reading();
      await heldRead;
      return row;
    });
    let releaseClose = (): void => {};
    try {
      server.send(createEnvelope('task.cancel', { reason: 'cancel racing admission' }, { taskId, seq: server.nextSeq() }));
      await entered;
      // The cancel observed no owner and read received; the offer now installs one.
      server.send(createEnvelope('task.offer', original.payload, { taskId, seq: server.nextSeq() }));
      await server.waitFor((e) => e.type === 'task.started' && e.task_id === taskId);
      releaseClose = adapter.sessions[0]!.blockClose();
      const waiting = d.whenTaskSettled(taskId, { signal: AbortSignal.timeout(2_000) });
      releaseRead();
      await server.waitFor((e) => e.type === 'task.cancelled' && e.task_id === taskId);
      releaseClose();
      await expect(waiting).resolves.toEqual({ terminal: 'cancelled', delivery: 'accepted', disposal: 'disposed' });
    } finally {
      releaseRead();
      releaseClose();
      read.mockRestore();
    }
  });

  it('waits for the real decline when cancellation arrives during sealed offer opening', async () => {
    server.setCapabilityDeclaration({ schema: 'byok-capabilities-v1', version: 1,
      capabilities: [HOST_MCP_TASK_CONTEXT_CAPABILITY, 'e2ee.member', 'e2ee.member.kem-epoch'] });
    const adapter = new StubRuntimeAdapter();
    const d = build(adapter, await fs.mkdtemp(path.join(os.tmpdir(), 'byok-settlement-sealed-')));
    const web = await E2eeWebClient.create(server.e2ee);
    const { deviceId } = await d.pair('pairing-code', { verificationSecret: web.verificationSecret });
    const device = await web.approve(deviceId);
    await web.putScope('settlement-scope', [device], { categories: ['task-output'] });
    await d.start();
    await server.waitFor((e) => e.type === 'conn.hello' && e.payload.capabilities.includes('sealed-payload-v1'));
    let opened!: () => void;
    const entered = new Promise<void>((resolve) => { opened = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalOpen = SealedTasks.prototype.openOffer;
    const opening = vi.spyOn(SealedTasks.prototype, 'openOffer').mockImplementationOnce(async function (this: SealedTasks, envelope) {
      opened();
      await gate;
      return originalOpen.call(this, envelope);
    });
    const routed = vi.spyOn(TaskRunner.prototype, 'handleEnvelope');
    try {
      const taskId = 'task-cancel-sealed-opening';
      offer(taskId, { sealing: { scopeId: 'settlement-scope', epoch: 1, categories: ['task-output'] } });
      await entered;
      const waiting = d.whenTaskSettled(taskId, { signal: AbortSignal.timeout(2_000) });
      const tracked = track(waiting);
      server.send(createEnvelope('task.cancel', {}, { taskId, seq: server.nextSeq() }));
      await vi.waitFor(() => expect(routed).toHaveBeenCalledWith(expect.objectContaining({ type: 'task.cancel', task_id: taskId })));
      expect(tracked.settled()).toBe(false);
      release();
      await expect(waiting).resolves.toEqual({ terminal: 'declined', delivery: 'accepted', disposal: 'none' });
      expect(adapter.startCalls).toHaveLength(0);
    } finally {
      release();
      opening.mockRestore();
      routed.mockRestore();
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

  describe('stored cancellation authority', () => {
    const taskId = 'stored-cancel';
    const identity = { tenantId: 'tenant-test', productId: 'test-product-settlement', deviceId: 'device-1' };
    const bytes = encodeEnvelope(createEnvelope('task.cancel', { reason: 'cancelled' }, { taskId, seq: 2 }));
    const evidence = { identity, bytes, bytesHash: journalHash(bytes) };

    it('settles a received journal row without an in-memory cancellation event', async () => {
      const r = new TaskSettlementRegistry();
      r.bindJournal({
        readTask: async () => ({ localState: 'received', seq: 1 }),
        hasTaskCancellation: (id, offerSeq) => hasTaskCancellation({ readTaskCancellation: async () => evidence }, id, offerSeq, identity),
        unconfirmedTerminal: async () => undefined,
      });
      await expect(r.wait(taskId)).resolves.toEqual({ terminal: 'cancelled', delivery: 'not-required', disposal: 'none' });
    });

    it.each([
      ['tenant', { ...evidence, identity: { ...identity, tenantId: 'other' } }],
      ['product', { ...evidence, identity: { ...identity, productId: 'other' } }],
      ['device', { ...evidence, identity: { ...identity, deviceId: 'other' } }],
      ['hash', { ...evidence, bytesHash: journalHash('other') }],
      ...[
        encodeEnvelope(createEnvelope('task.cancel', { reason: 'cancelled' }, { taskId: 'other', seq: 2 })),
        encodeEnvelope(createEnvelope('task.started', {}, { taskId })),
        // A pre-cancel at or below the offer sequence is not cancellation authority for that offer.
        encodeEnvelope(createEnvelope('task.cancel', { reason: 'cancelled' }, { taskId, seq: 1 })),
      ].map((wrongBytes) => ['binding', { ...evidence, bytes: wrongBytes, bytesHash: journalHash(wrongBytes) }] as const),
    ] as const)('rejects invalid %s evidence from an injected journal', async (_kind, record) => {
      const r = new TaskSettlementRegistry();
      r.bindJournal({
        readTask: async () => ({ localState: 'received', seq: 1 }),
        hasTaskCancellation: (id, offerSeq) => hasTaskCancellation({ readTaskCancellation: async () => record }, id, offerSeq, identity),
        unconfirmedTerminal: async () => undefined,
      });
      await expect(r.wait(taskId)).rejects.toThrow(/identity mismatch|hash mismatch|cancellation binding/);
    });

    it('refuses startup on a real stored cancellation with corrupt bytes without writing an interruption', async () => {
      const first = await started(new StubRuntimeAdapter());
      await first.d.stop();
      const journal = new SqliteLocalTaskJournal({ storeDir: first.storeDir });
      const seq = server.nextSeq();
      const offerBytes = encodeEnvelope(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), instruction: 'work', ...FRESH_OFFER }, { taskId, seq }));
      await journal.appendEnvelope({ identity, envelopeId: 'stored-offer', taskId, seq, bytes: offerBytes,
        bytesHash: journalHash(offerBytes), receivedAt: new Date().toISOString(), opensTask: true });
      const cancellation = createEnvelope('task.cancel', { reason: 'cancelled' }, { taskId, seq: server.nextSeq() });
      const cancelBytes = encodeEnvelope(cancellation);
      await journal.appendEnvelope({ identity, envelopeId: cancellation.id, taskId, seq: cancellation.seq!, bytes: cancelBytes,
        bytesHash: journalHash(cancelBytes), receivedAt: cancellation.ts, opensTask: false });
      await journal.close();
      const db = openJournalDatabase(path.join(first.storeDir, JOURNAL_DB_FILENAME), DEFAULT_JOURNAL_BUSY_TIMEOUT_MS);
      try {
        db.prepare('UPDATE journal_envelope SET bytes = ? WHERE envelope_id = ?')
          .run(cancelBytes.replace('task.cancel', 'task.started'), cancellation.id);
      } finally {
        db.close();
      }
      const terminal = vi.spyOn(SqliteLocalTaskJournal.prototype, 'recordTerminal');
      try {
        await expect(build(new StubRuntimeAdapter(), first.storeDir).start()).rejects.toThrow('durable cancellation candidate bytes/hash mismatch');
        expect(terminal).not.toHaveBeenCalled();
        expect(server.received.filter((e) => e.task_id === taskId)).toEqual([]);
      } finally {
        terminal.mockRestore();
      }
    });
  });

  describe('TaskSettlementRegistry waiters', () => {
    function registry(localState?: string): { registry: TaskSettlementRegistry; reads: () => number } {
      let reads = 0;
      const r = new TaskSettlementRegistry();
      r.bindJournal({
        readTask: async () => { reads += 1; return localState === undefined ? undefined : { localState, seq: 1 }; },
        hasTaskCancellation: async () => false,
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
