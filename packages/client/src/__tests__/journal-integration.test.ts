import { freshTestAgentRef, testAgentHomeConfig, testAgentHomeDeps } from './fixtures/test-agent';
import { testScratchRoot, testScratchOwner } from "./fixtures/execution-scratch";
/**
 * L-002: the durable journal wired into the daemon.
 *
 * Two claims are under test:
 *
 * 1. **Every daemon journals (#924).** The default config constructs exactly
 *    one journal, rooted at `storeDir`.
 * 2. **The ack cannot outrun the commit.** Not by discipline —
 *    structurally. `ConnectionManager.process` advances the redelivery cursor
 *    only once `onEnvelope` resolves (unchanged by this slice; transport
 *    untouched), and `onEnvelope` does not resolve until the journal
 *    transaction commits. The test for it holds the journal write open and
 *    watches what the rest of the daemon is NOT allowed to do yet — no clock,
 *    no sleep, no race.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnvelope, encodeEnvelope, type Envelope } from '@byok-sdk/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { CursorStore } from '../daemon/cursor-store';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type AdmissionGuardDecision, type TaskRunnerDeps } from '../daemon/task-runner';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { DaemonConfigFieldRemovedError } from '../daemon/daemon-errors';
import { DEFAULT_JOURNAL_BUSY_TIMEOUT_MS, JOURNAL_DB_FILENAME } from '../daemon/journal/sqlite-journal';
import { openJournalDatabase } from '../daemon/journal/sqlite-support';
import type { JournalIdentity, JournalReceipt, LocalTaskJournal, LocalTerminalRecord, ReceivedEnvelopeRecord, RecoverableTask } from '../daemon/journal/journal';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';
import { testIngressBudget } from './fixtures/activity-ingress';

/**
 * Counts every `SqliteLocalTaskJournal` construction while leaving the real
 * class in place. This is the "no journal object at all on the default path"
 * assertion's evidence: a filesystem check alone would pass for a journal that
 * was constructed and simply had not written yet.
 */
const journalConstructions = vi.hoisted(() => ({ storeDirs: [] as string[] }));

vi.mock('../daemon/journal/sqlite-journal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon/journal/sqlite-journal')>();
  class CountingSqliteLocalTaskJournal extends actual.SqliteLocalTaskJournal {
    constructor(options: ConstructorParameters<typeof actual.SqliteLocalTaskJournal>[0]) {
      journalConstructions.storeDirs.push(options.storeDir);
      super(options);
    }
  }
  return { ...actual, SqliteLocalTaskJournal: CountingSqliteLocalTaskJournal };
});

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function exists(target: string): Promise<boolean> {
  return fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}

/** Reads `journal_terminal.truth_state` directly; the journal API lists only unconfirmed terminals. */
function terminalTruthState(storeDir: string, taskId: string): unknown {
  const db = openJournalDatabase(path.join(storeDir, JOURNAL_DB_FILENAME), DEFAULT_JOURNAL_BUSY_TIMEOUT_MS);
  try {
    return (db.prepare('SELECT truth_state FROM journal_terminal WHERE task_id = ?').get(taskId) as { truth_state?: unknown } | undefined)?.truth_state;
  } finally {
    db.close();
  }
}

/**
 * A journal that records call order and can hold `appendEnvelope` open on
 * demand — the gate is a promise the test resolves, so "the daemon has not
 * proceeded yet" is asserted against a state that cannot move rather than
 * against a timer that might.
 */
class RecordingJournal implements LocalTaskJournal {
  readonly appended: ReceivedEnvelopeRecord[] = [];
  readonly terminals: LocalTerminalRecord[] = [];
  readonly tasks = new Map<string, RecoverableTask>();
  #gate: Promise<void> | undefined;
  #release: (() => void) | undefined;

  blockAppends(): () => void {
    this.#gate = new Promise((resolve) => {
      this.#release = resolve;
    });
    return () => {
      this.#release?.();
      this.#gate = undefined;
    };
  }

  async appendEnvelope(record: ReceivedEnvelopeRecord): Promise<JournalReceipt> {
    this.appended.push(record);
    if (record.opensTask && record.taskId !== undefined) {
      this.tasks.set(record.taskId, {
        taskId: record.taskId, envelopeId: record.envelopeId, seq: record.seq,
        identity: record.identity, localState: 'received', updatedAt: record.receivedAt,
        envelopeBytes: record.bytes,
      });
    }
    if (this.#gate) await this.#gate;
    return {
      envelopeId: record.envelopeId,
      seq: record.seq,
      bytesHash: record.bytesHash,
      committedAt: '2026-08-07T00:00:00.000Z',
      created: true,
    };
  }
  async appendWithheldOffer(): Promise<never> { throw new Error('not used'); }
  async recordAdmission(): Promise<void> {}
  async recordTransition(): Promise<void> {}
  async recordTerminal(record: LocalTerminalRecord): Promise<void> {
    if (!this.terminals.some((terminal) => terminal.taskId === record.taskId)) this.terminals.push(record);
  }
  async listPendingTerminals(): Promise<LocalTerminalRecord[]> { return this.terminals.filter((terminal) => terminal.truthState !== 'confirmed'); }
  async confirmTerminal(taskId: string, payloadHash: string): Promise<void> {
    const terminal = this.terminals.find((candidate) => candidate.taskId === taskId && candidate.payloadHash === payloadHash);
    if (!terminal) throw new Error('terminal acknowledgement does not match durable terminal');
    this.terminals[this.terminals.indexOf(terminal)] = { ...terminal, truthState: 'confirmed' };
  }
  async rejectTerminal(taskId: string, payloadHash: string, reason: string): Promise<void> {
    const terminal = this.terminals.find((candidate) => candidate.taskId === taskId && candidate.payloadHash === payloadHash);
    if (!terminal) throw new Error('terminal acknowledgement does not match durable terminal');
    this.terminals[this.terminals.indexOf(terminal)] = { ...terminal, truthState: 'failed', lastError: reason };
  }
  async replaceRefusedTerminal(taskId: string, refusedPayloadHash: string, record: LocalTerminalRecord): Promise<void> {
    const terminal = this.terminals.find((candidate) => candidate.taskId === taskId && candidate.payloadHash === refusedPayloadHash && candidate.truthState === 'failed');
    if (!terminal) throw new Error('terminal replacement does not match a refused durable terminal');
    this.terminals[this.terminals.indexOf(terminal)] = record;
  }
  async listRecoveryTasks(): Promise<[]> { return []; }
  async readTask(taskId: string, identity: JournalIdentity): Promise<RecoverableTask | undefined> {
    const task = this.tasks.get(taskId);
    if (task && (task.identity.tenantId !== identity.tenantId || task.identity.productId !== identity.productId || task.identity.deviceId !== identity.deviceId)) throw new Error('journal enrollment identity mismatch');
    return task;
  }
  async listRecoverable(): Promise<[]> {
    return [];
  }
  async markRecovered(): Promise<void> {}
  async measureUsage(): Promise<never> {
    throw new Error('not used in this test');
  }
  async listPrunableConfirmedTasks(): Promise<string[]> { return []; }
  async pruneConfirmedJournalTask(): Promise<boolean> { return false; }
  async compact(): Promise<never> {
    throw new Error('not used in this test');
  }
  async close(): Promise<void> {}
}

describe('hosted journal integration (L-002)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    journalConstructions.storeDirs.length = 0;
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
    vi.restoreAllMocks();
  });

  async function startDaemon(
    configOverrides: Partial<DaemonConfig>,
    journal?: LocalTaskJournal,
  ): Promise<{ adapter: StubRuntimeAdapter; storeDir: string; deviceId: string }> {
    const adapter = new StubRuntimeAdapter('pi');
    const workspaceRoot = await tmpDir('byok-journal-int-workspace-');
    const storeDir = await tmpDir('byok-journal-int-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
        productId: 'test-product-journal',
        serverUrl: server.url,
        workspaceRoot,
        agentHome: testAgentHomeConfig(),
        storeDir,
        ...configOverrides,
      },
      [adapter],
      journal ? { journal } : {},
    );
    const record = await daemon.pair('pairing-code');
    await daemon.start();
    return { adapter, storeDir, deviceId: record.deviceId };
  }

  it('durably rejects a terminal with its wire reason before publishing status and event', async () => {
    const { LongPollClient } = await import('../daemon/long-poll-transport');
    const original = LongPollClient.prototype.postBatch;
    const journal = new RecordingJournal();
    vi.spyOn(LongPollClient.prototype, 'postBatch').mockImplementation(async function(this: import('../daemon/long-poll-transport').LongPollClient, batch, signal) {
      if (!batch.some((envelope) => envelope.type === 'task.complete')) return original.call(this, batch, signal);
      return { accepted: batch.filter((envelope) => envelope.type !== 'task.complete').length, rejected: 1,
        outcomes: batch.map((envelope) => envelope.type === 'task.complete'
          ? { id: envelope.id, outcome: 'rejected' as const, reason: 'state_conflict' }
          : { id: envelope.id, outcome: 'accepted' as const }) };
    });
    const { adapter, storeDir } = await startDaemon({}, journal);
    const rejected: import('../daemon/observer').DaemonEvent[] = [];
    daemon!.subscribe((event) => {
      if (event.kind === 'outbound-rejected') {
        expect(journal.terminals[0]?.truthState).toBe('failed');
        rejected.push(event);
      }
    });
    server.send(createEnvelope('task.offer_for_agent', { agentRef: freshTestAgentRef(),  instruction: 'PAYLOAD_SENTINEL' }, { taskId: 'terminal-rejected', seq: server.nextSeq() }));
    await server.waitFor((envelope) => envelope.type === 'task.started');
    adapter.sessions[0]!.emit({ type: 'progress', text: 'PAYLOAD_SENTINEL' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(rejected).toHaveLength(1));
    expect(journal.terminals[0]).toMatchObject({ truthState: 'failed', lastError: 'state_conflict' });
    expect(daemon!.status().outbound).toMatchObject({ rejected: 1, rejectedByReason: { state_conflict: 1 }, rejectedTerminals: 1 });
    expect(daemon!.status().operationalHealth).toMatchObject({ availability: 'available', state: 'healthy' });
    expect(daemon!.tasks().find((task) => task.taskId === 'terminal-rejected')).toMatchObject({ state: 'Complete', delivery: 'rejected', summary: 'PAYLOAD_SENTINEL' });
    expect(JSON.stringify(rejected)).not.toContain('PAYLOAD_SENTINEL');
    const { connectControlClient } = await import('../bin/control-client');
    const connected = await connectControlClient({ storeDir, productId: 'test-product-journal' });
    if (!connected.ok) throw new Error('control unavailable');
    try { expect((await connected.client.request<import('../daemon/control-protocol').ControlStatusResult>('status')).activeTasks).toEqual([]); } finally { connected.client.close(); }
  });

  it('keeps exact successful terminal bytes and active ownership through a journal write outage', async () => {
    const journal = new RecordingJournal();
    let unavailable = true;
    const candidates: LocalTerminalRecord[] = [];
    const recordTerminal = journal.recordTerminal.bind(journal);
    vi.spyOn(journal, 'recordTerminal').mockImplementation(async record => {
      candidates.push(record);
      if (unavailable) throw new Error('EIO');
      await recordTerminal(record);
    });
    const { adapter } = await startDaemon({}, journal);
    server.send(createEnvelope('task.offer_for_agent', { agentRef: freshTestAgentRef(),  instruction: 'unique result' },
      { taskId: 'terminal-retry', seq: server.nextSeq() }));
    await server.waitFor(e => e.type === 'task.started');
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(() => expect(candidates).toHaveLength(1));
    expect(daemon!.status().pendingTerminalCommits).toBe(1);
    expect(server.received.some(e => e.type === 'task.complete')).toBe(false);
    await vi.waitFor(() => expect(adapter.sessions[0]!.closeCalled).toBe(true));
    expect(daemon!.status().activeTaskCount).toBe(1);
    unavailable = false;
    await server.waitFor(e => e.type === 'task.complete', 3_000);
    await vi.waitFor(() => expect(daemon!.status().pendingTerminalCommits).toBe(0));
    await vi.waitFor(() => expect(daemon!.status().activeTaskCount).toBe(0));
    expect(candidates.every(record => record.bytes === candidates[0]!.bytes && record.payloadHash === candidates[0]!.payloadHash)).toBe(true);
    expect(adapter.startCalls).toHaveLength(1);
  });

  it('decline journal failure leaves its offer cursor unacknowledged until recovery', async () => {
    const journal = new RecordingJournal();
    let unavailable = true;
    const recordTerminal = journal.recordTerminal.bind(journal);
    vi.spyOn(journal, 'recordTerminal').mockImplementation(async record => {
      if (unavailable) throw new Error('ENOSPC');
      await recordTerminal(record);
    });
    const { adapter, storeDir, deviceId } = await startDaemon({}, journal);
    const seq = server.nextSeq();
    const offer = createEnvelope('task.offer_for_agent', { agentRef: freshTestAgentRef(),  instruction: 'invalid limit', limits: { maxTokens: 1 } },
      { taskId: 'decline-retry', seq });
    server.send(offer);
    await vi.waitFor(() => expect(daemon!.status().pendingTerminalCommits).toBe(1));
    expect(await new CursorStore(storeDir).load(server.url, deviceId)).toBe(0);
    expect(server.received.some(e => e.type === 'task.decline')).toBe(false);
    unavailable = false;
    server.send(offer);
    await server.waitFor(e => e.type === 'task.decline');
    await vi.waitFor(async () => expect(await new CursorStore(storeDir).load(server.url, deviceId)).toBe(seq));
    expect(adapter.startCalls).toHaveLength(0);
  });

  describe('configuration', () => {
    it('constructs exactly one journal, rooted at storeDir, with the default config', async () => {
      const { storeDir } = await startDaemon({});

      expect(journalConstructions.storeDirs).toEqual([storeDir]);
      expect(await exists(path.join(storeDir, JOURNAL_DB_FILENAME))).toBe(true);
    });

    it('refuses the removed hostedJournal field at construction, before any daemon exists', async () => {
      const base: DaemonConfig = {
        localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
        productId: 'test-product-journal',
        serverUrl: server.url,
        workspaceRoot: await tmpDir('byok-journal-cfg-workspace-'),
        agentHome: testAgentHomeConfig(),
        storeDir: await tmpDir('byok-journal-cfg-store-'),
      };

      expect(() =>
        createDaemonWithAdapters({agentHome: testAgentHomeConfig(),  storage: { scratchRoot: testScratchRoot() }, ...base, hostedJournal: { mode: 'sqlite' } } as DaemonConfig, []),
      ).toThrow(DaemonConfigFieldRemovedError);
      // Nothing was constructed on the rejected path.
      expect(journalConstructions.storeDirs).toEqual([]);
    });
  });

  describe('ack ordering', () => {
    it('holds the whole envelope chain — and the cursor — behind the journal commit', async () => {
      const journal = new RecordingJournal();
      const { adapter, storeDir, deviceId } = await startDaemon({}, journal);
      const cursorStore = new CursorStore(storeDir);
      // EVERY inbound envelope is journaled, since every one of them can
      // move the cursor. Baseline past any earlier one so this test is about
      // the offer.
      const priorAppends = journal.appended.length;
      const cursorBeforeOffer = await cursorStore.load(server.url, deviceId);

      const release = journal.blockAppends();
      const seq = server.nextSeq();
      server.send(createEnvelope('task.offer_for_agent', { agentRef: freshTestAgentRef(),  instruction: 'x' }, { taskId: 'task-order-1', seq }));

      // The append has been ENTERED (so the journal is genuinely on the
      // inbound path, not merely constructed) and is now held open.
      await vi.waitFor(() => expect(journal.appended.length).toBe(priorAppends + 1));
      expect(journal.appended[priorAppends]).toMatchObject({
        envelopeId: expect.any(String),
        taskId: 'task-order-1',
        seq,
        opensTask: true,
        identity: { tenantId: 'tenant-test', productId: 'test-product-journal', deviceId },
      });

      // While it is held: the runner has not been handed the offer, nothing
      // has been claimed on the wire, and the redelivery cursor has not moved
      // to this seq. All three follow from the same fact — `onEnvelope` has
      // not resolved — which is exactly the property the ordering rests on.
      expect(adapter.startCalls).toHaveLength(0);
      expect(server.received.some((e) => e.type === 'task.claim')).toBe(false);
      expect(await cursorStore.load(server.url, deviceId)).toBe(cursorBeforeOffer ?? 0);

      release();

      await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-order-1');
      await vi.waitFor(async () => {
        expect(await cursorStore.load(server.url, deviceId)).toBe(seq);
      });
    });

    it('records the terminal in the journal before it reaches the wire', async () => {
      const journal = new RecordingJournal();
      const { adapter } = await startDaemon({}, journal);

      server.send(
        createEnvelope('task.offer_for_agent', { agentRef: freshTestAgentRef(),  instruction: 'x' }, { taskId: 'task-terminal-1', seq: server.nextSeq() }),
      );
      await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-terminal-1');
      adapter.sessions[0]?.emit({ type: 'turn_end' });

      const complete = await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-terminal-1');
      expect(complete).toBeDefined();
      // The terminal was journaled — and since the send is chained BEHIND that
      // write, its presence by the time the cloud has the envelope is the
      // ordering.
      expect(journal.terminals).toHaveLength(1);
      expect(journal.terminals[0]).toMatchObject({ taskId: 'task-terminal-1', payloadHash: expect.stringMatching(/^sha256:/) });
    });
  });

  describe('recovery scan on start', () => {
    it('marks tasks the previous run left open, without resuming or deleting them', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { SqliteLocalTaskJournal } = await import('../daemon/journal/sqlite-journal');
      const { journalHash } = await import('../daemon/journal/journal');
      try {
        // The state a CRASH leaves: an offer envelope durable, no terminal, no
        // recovery marker. Built directly rather than by stopping a daemon,
        // because a graceful `stop()` deliberately fails its active tasks and
        // journals those terminals — that is the well-behaved path, not the one
        // recovery exists for.
        const storeDir = await tmpDir('byok-journal-recover-store-');
        const seeded = new SqliteLocalTaskJournal({ storeDir });
        const bytes = encodeEnvelope(createEnvelope('task.offer_for_agent', { agentRef: freshTestAgentRef(),  instruction: 'recover' }, { taskId: 'task-recover-1', seq: 7 }));
        await seeded.appendEnvelope({
          identity: { tenantId: 'tenant-test', productId: 'test-product-journal', deviceId: 'device-1' },
          envelopeId: 'env-crashed',
          taskId: 'task-recover-1',
          seq: 7,
          bytes,
          bytesHash: journalHash(bytes),
          receivedAt: '2026-08-07T00:00:00.000Z',
          opensTask: true,
        });
        await seeded.recordTransition({ transitionId: 'tr-1', taskId: 'task-recover-1', to: 'Running', occurredAt: '2026-08-07T00:00:01.000Z' });
        await seeded.close();

        const adapter = new StubRuntimeAdapter('pi');
        daemon = createDaemonWithAdapters(
          { storage: { scratchRoot: testScratchRoot() },
            localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
            productId: 'test-product-journal',
            serverUrl: server.url,
            workspaceRoot: await tmpDir('byok-journal-recover-workspace-'),
            agentHome: testAgentHomeConfig(),
            storeDir,
          },
          [adapter],
        );
        await daemon.pair('pairing-code');
        // Startup queues the recovered terminal before the connection opens, so its
        // POST can be accepted (and confirmed locally) before start() returns. Hold
        // that acceptance so the read below sees the row strictly before confirmation.
        const releaseConfirmation = server.holdNextMessagesResponse(
          (envelope) => envelope.type === 'task.fail' && envelope.task_id === 'task-recover-1',
        );
        await daemon.start();

        await server.waitFor((envelope) => envelope.type === 'task.fail' && envelope.task_id === 'task-recover-1');
        // Marked, not resumed: no adapter session was started for it.
        expect(adapter.startCalls).toHaveLength(0);

        const after = new SqliteLocalTaskJournal({ storeDir });
        expect(await after.listRecoverable()).toEqual([]);
        const identity = { tenantId: 'tenant-test', productId: 'test-product-journal', deviceId: 'device-1' };
        expect(await after.listPendingTerminals(identity)).toMatchObject([
          { taskId: 'task-recover-1', terminalType: 'failed', truthState: 'pending' },
        ]);
        releaseConfirmation();
        // Transport acceptance confirms the terminal; the task row keeps its terminal state.
        await vi.waitFor(() => expect(terminalTruthState(storeDir, 'task-recover-1')).toBe('confirmed'));
        expect(await after.listPendingTerminals(identity)).toEqual([]);
        expect(await after.readTask('task-recover-1', identity)).toMatchObject({
          taskId: 'task-recover-1', localState: 'terminal:failed',
        });
        await after.close();
        // Marked, not deleted: the row and its bytes are still there.
        const reread = new SqliteLocalTaskJournal({ storeDir });
        await expect(
          reread.markRecovered('task-recover-1', { disposition: 'abandoned' }),
        ).resolves.toBeUndefined();
        await reread.close();
      } finally {
        warn.mockRestore();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// The admission-guard seam, exercised directly against TaskRunner. The storage
// policy that will supply a real guard is L-003; what this slice owes is a seam
// that is in the right place and cannot fire in the wrong one.
// ---------------------------------------------------------------------------

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => {
    throw new Error('not used in this test');
  },
  uploadArtifact: async () => {
    throw new Error('not used in this test');
  },
};

async function makeRunner(
  adapter: StubRuntimeAdapter,
  sent: Envelope[],
  admissionGuard?: TaskRunnerDeps['admissionGuard'],
): Promise<TaskRunner> {
  const deps: TaskRunnerDeps = { getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [adapter],
    workspaceRoot: await tmpDir('byok-guard-workspace-'),
    ...testAgentHomeDeps(),
    deviceId: 'device-1',
    send: (envelope) => {
      sent.push(envelope);
    },
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-guard-store-')),
    approvalRegistry: new ApprovalRegistry(),
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    ...(admissionGuard ? { admissionGuard } : {}),
  };
  return new TaskRunner(deps);
}

function offer(taskId: string): Envelope {
  return createEnvelope('task.offer_for_agent', { agentRef: freshTestAgentRef(),  instruction: 'x' }, { taskId, seq: 1 });
}

describe('TaskRunner.admissionGuard (L-002 seam)', () => {
  it('declines pre-claim, retryably, and never touches an adapter', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent, () => ({
      admit: false,
      reason: 'local storage is under hard pressure',
      retryable: true,
    }));

    await runner.handleEnvelope(offer('task-guard-1'));

    expect(sent.map((e) => e.type)).toEqual(['task.decline']);
    expect(sent[0]?.payload).toMatchObject({ retryable: true, reason: 'local storage is under hard pressure' });
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('is not consulted for a redelivery of an offer this device already took', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const calls: string[] = [];
    const guard = (input: { taskId: string }): AdmissionGuardDecision => {
      calls.push(input.taskId);
      return { admit: true };
    };
    const runner = await makeRunner(adapter, sent, guard);

    await runner.handleEnvelope(offer('task-guard-2'));
    // The redelivery the at-least-once wire guarantees. It is already this
    // device's task; asking the guard again could turn a task in flight into a
    // spurious decline the moment pressure rose.
    await runner.handleEnvelope(offer('task-guard-2'));

    expect(calls).toEqual(['task-guard-2']);
    expect(sent.filter((e) => e.type === 'task.decline')).toHaveLength(0);
    expect(sent.filter((e) => e.type === 'task.claim')).toHaveLength(1);
  });

  it('changes nothing when it admits, and nothing at all when absent', async () => {
    const sentWithGuard: Envelope[] = [];
    const admitting = await makeRunner(new StubRuntimeAdapter('pi'), sentWithGuard, () => ({ admit: true }));
    await admitting.handleEnvelope(offer('task-guard-3'));

    const sentWithout: Envelope[] = [];
    const bare = await makeRunner(new StubRuntimeAdapter('pi'), sentWithout);
    await bare.handleEnvelope(offer('task-guard-3'));

    expect(sentWithGuard.map((e) => e.type)).toEqual(sentWithout.map((e) => e.type));
    expect(sentWithGuard.map((e) => e.type)).toContain('task.claim');
  });
});
