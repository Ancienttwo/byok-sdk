/**
 * L-002: the durable journal wired into the daemon.
 *
 * Two claims are under test, and they pull in opposite directions on purpose:
 *
 * 1. **Opt-in means opt-in.** With no `hostedJournal` config, NO journal object
 *    is constructed, no database file appears, and the envelope/send closures
 *    are the originals. This is the contract's own falsifier — if the default
 *    path had to change to make hosted mode work, "opt-in" was never true.
 * 2. **In hosted mode, the ack cannot outrun the commit.** Not by discipline —
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
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { CursorStore } from '../daemon/cursor-store';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type AdmissionGuardDecision, type TaskRunnerDeps } from '../daemon/task-runner';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { JOURNAL_DB_FILENAME } from '../daemon/journal/sqlite-journal';
import { isSqliteAvailable } from '../daemon/journal/sqlite-support';
import type { JournalReceipt, LocalTaskJournal, ReceivedEnvelopeRecord } from '../daemon/journal/journal';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

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

/**
 * A journal that records call order and can hold `appendEnvelope` open on
 * demand — the gate is a promise the test resolves, so "the daemon has not
 * proceeded yet" is asserted against a state that cannot move rather than
 * against a timer that might.
 */
class RecordingJournal implements LocalTaskJournal {
  readonly appended: ReceivedEnvelopeRecord[] = [];
  readonly terminals: string[] = [];
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
    if (this.#gate) await this.#gate;
    return {
      envelopeId: record.envelopeId,
      seq: record.seq,
      bytesHash: record.bytesHash,
      committedAt: '2026-08-07T00:00:00.000Z',
      created: true,
    };
  }
  async recordAdmission(): Promise<void> {}
  async recordTransition(): Promise<void> {}
  async recordTerminal(record: { taskId: string; payloadHash: string }): Promise<void> {
    this.terminals.push(`${record.taskId}:${record.payloadHash}`);
  }
  async listRecoverable(): Promise<[]> {
    return [];
  }
  async markRecovered(): Promise<void> {}
  async measureUsage(): Promise<never> {
    throw new Error('not used in this test');
  }
  async listCleanupCandidates(): Promise<[]> {
    return [];
  }
  async markCleanupResult(): Promise<void> {}
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
  });

  async function startDaemon(
    configOverrides: Partial<DaemonConfig>,
    journal?: LocalTaskJournal,
  ): Promise<{ adapter: StubRuntimeAdapter; storeDir: string; deviceId: string }> {
    const adapter = new StubRuntimeAdapter('pi');
    const workspaceRoot = await tmpDir('byok-journal-int-workspace-');
    const storeDir = await tmpDir('byok-journal-int-store-');
    daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
        productId: 'test-product-journal',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        ...configOverrides,
      },
      [adapter],
      journal ? { hostedJournal: { journal } } : {},
    );
    const record = await daemon.pair('pairing-code');
    await daemon.start();
    return { adapter, storeDir, deviceId: record.deviceId };
  }

  describe('the default path', () => {
    it('constructs no journal object and creates no database, through a full task lifecycle', async () => {
      const { adapter, storeDir } = await startDaemon({});

      server.send(
        createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-default-1', seq: server.nextSeq() }),
      );
      await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-default-1');
      adapter.sessions[0]?.emit({ type: 'turn_end' });
      await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-default-1');

      // The evidence that matters: not "the file is missing" (a constructed
      // journal that never wrote would also look like that) but "the
      // constructor was never reached".
      expect(journalConstructions.storeDirs).toEqual([]);
      expect(await exists(path.join(storeDir, JOURNAL_DB_FILENAME))).toBe(false);
    });
  });

  describe('configuration', () => {
    it('constructs exactly one journal, rooted at storeDir, when hostedJournal is set', async () => {
      if (!isSqliteAvailable()) return; // the real class is under test here; see journal-unavailable.test.ts for the Node 20 half
      const { storeDir } = await startDaemon({ hostedJournal: { mode: 'sqlite' } });

      expect(journalConstructions.storeDirs).toEqual([storeDir]);
      expect(await exists(path.join(storeDir, JOURNAL_DB_FILENAME))).toBe(true);
    });

    it('rejects an unknown mode at construction, before any daemon exists', async () => {
      const base: DaemonConfig = {
        localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
        productId: 'test-product-journal',
        serverUrl: server.url,
        workspaceRoot: await tmpDir('byok-journal-cfg-workspace-'),
        storeDir: await tmpDir('byok-journal-cfg-store-'),
      };

      expect(() =>
        createDaemonWithAdapters({ ...base, hostedJournal: { mode: 'jsonl' as 'sqlite' } }, []),
      ).toThrow(/must be "sqlite"/);
      // Nothing was constructed on the rejected path.
      expect(journalConstructions.storeDirs).toEqual([]);
    });
  });

  describe('ack ordering', () => {
    it('holds the whole envelope chain — and the cursor — behind the journal commit', async () => {
      const journal = new RecordingJournal();
      const { adapter, storeDir, deviceId } = await startDaemon(
        { hostedJournal: { mode: 'sqlite' } },
        journal,
      );
      const cursorStore = new CursorStore(storeDir);
      // The handshake's own inbound envelope (`conn.ack`) is journaled too —
      // EVERY inbound envelope is, since every one of them can move the
      // cursor. Baseline past it so this test is about the offer.
      const priorAppends = journal.appended.length;
      const cursorBeforeOffer = await cursorStore.load(server.url, deviceId);

      const release = journal.blockAppends();
      const seq = server.nextSeq();
      server.send(createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-order-1', seq }));

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
      expect(await cursorStore.load(server.url, deviceId)).toBe(cursorBeforeOffer);

      release();

      await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-order-1');
      await vi.waitFor(async () => {
        expect(await cursorStore.load(server.url, deviceId)).toBe(seq);
      });
    });

    it('records the terminal in the journal before it reaches the wire', async () => {
      const journal = new RecordingJournal();
      const { adapter } = await startDaemon({ hostedJournal: { mode: 'sqlite' } }, journal);

      server.send(
        createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-terminal-1', seq: server.nextSeq() }),
      );
      await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-terminal-1');
      adapter.sessions[0]?.emit({ type: 'turn_end' });

      const complete = await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-terminal-1');
      expect(complete).toBeDefined();
      // The terminal was journaled — and since the send is chained BEHIND that
      // write, its presence by the time the cloud has the envelope is the
      // ordering.
      expect(journal.terminals).toHaveLength(1);
      expect(journal.terminals[0]).toMatch(/^task-terminal-1:sha256:/);
    });
  });

  describe('recovery scan on start', () => {
    it('marks tasks the previous run left open, without resuming or deleting them', async () => {
      if (!isSqliteAvailable()) return;
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
        const bytes = JSON.stringify({ v: 1, id: 'env-crashed', type: 'task.offer', task_id: 'task-recover-1' });
        await seeded.appendEnvelope({
          identity: { tenantId: 'tenant-a', productId: 'test-product-journal', deviceId: 'device-1' },
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
          {
            localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
            productId: 'test-product-journal',
            serverUrl: server.url,
            workspaceRoot: await tmpDir('byok-journal-recover-workspace-'),
            storeDir,
            hostedJournal: { mode: 'sqlite' },
          },
          [adapter],
        );
        await daemon.pair('pairing-code');
        await daemon.start();

        expect(warn.mock.calls.some((call) => String(call[0]).includes('task-recover-1'))).toBe(true);
        // Marked, not resumed: no adapter session was started for it.
        expect(adapter.startCalls).toHaveLength(0);

        const after = new SqliteLocalTaskJournal({ storeDir });
        expect(await after.listRecoverable()).toEqual([]);
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
  const deps: TaskRunnerDeps = {
    adapters: [adapter],
    workspaceRoot: await tmpDir('byok-guard-workspace-'),
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
  return createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId, seq: 1 });
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
