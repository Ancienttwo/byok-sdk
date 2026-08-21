/**
 * Sprint S3.4's disk-pressure matrix, points 7-12 (P-007).
 *
 * The crash matrix (points 1-6) asks what survives a process dying. This half
 * asks the harder question: what does a daemon do when the disk it depends on
 * is running out — and specifically, what does it refuse to do. §12.7.2.1's
 * answer is that it stops taking new work, then stops acking, and never
 * deletes protected data to buy room. Every point below asserts the same four
 * invariants: **no lost task**, **no duplicate side effect**, **stable
 * recovery status**, **protected data untouched**.
 *
 * Method, and why it is this one:
 *
 * - **No real disk is filled.** Free space is an injected provider and the
 *   budget is a policy number, so "this device is at 90%" is a value, not a
 *   condition to arrange. Filling a real filesystem would make these tests
 *   environment-dependent and would still not let them sit at an exact
 *   watermark.
 * - **No wall clock.** The maintenance cadence is a caller-driven `tick()`;
 *   where ordering has to be proven (point 11), it is proven with a logical
 *   clock that advances one unit per journal commit and with the observed
 *   completion order of the journal's own writer queue — not with elapsed time.
 * - **The journal under test is the real SQLite one.** Points 10 and 11 are
 *   claims about transactions and the WAL; a double would be asserting the
 *   test's own beliefs about SQLite.
 */
import { promises as fs, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnvelope } from '@byok-sdk/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectControlClient } from '../bin/control-client';
import { formatLiveStatusLines } from '../bin/format';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import type { ControlStatusResult } from '../daemon/control-protocol';
import { CursorStore } from '../daemon/cursor-store';
import { journalHash, type CleanupCandidate, type JournalIdentity, type ReceivedEnvelopeRecord } from '../daemon/journal/journal';
import {
  JOURNAL_DB_FILENAME,
  JOURNAL_QUARANTINE_DIRNAME,
  SqliteLocalTaskJournal,
  DEFAULT_JOURNAL_BUSY_TIMEOUT_MS,
  type JournalFaultStep,
} from '../daemon/journal/sqlite-journal';
import { isSqliteAvailable, openJournalDatabase } from '../daemon/journal/sqlite-support';
import {
  cleanupEligibleAt,
  createFilesystemCleanupExecutor,
  LocalStoragePressureEngine,
  LocalStorageEmergencyError,
  resolveLocalStoragePolicy,
  type CleanupExecutor,
  type LocalStoragePolicyInput,
  type StoragePressureEvent,
} from '../daemon/journal/storage-policy';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const IDENTITY: JournalIdentity = { tenantId: 'tenant-a', productId: 'test-product', deviceId: 'dev_1' };

/** Free space large enough that the free-space axis of the watermark never fires — used whenever a test wants the BUDGET axis isolated. */
const ROOMY_FREE_BYTES = 512 * 1024 * 1024;

const dirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

it.skipIf(!isSqliteAvailable())('serializes scheduled maintenance and stop waits for the in-flight pass before journal close', async () => {
  const storeDir = await tmpDir('byok-pressure-scheduler-barrier-');
  const journal = new SqliteLocalTaskJournal({ storeDir });
  const realMeasureUsage = journal.measureUsage.bind(journal);
  let releaseMeasure: (() => void) | undefined;
  const measureGate = new Promise<void>((resolve) => {
    releaseMeasure = resolve;
  });
  const measureSpy = vi.spyOn(journal, 'measureUsage').mockImplementation(async () => {
    await measureGate;
    return realMeasureUsage();
  });
  let scheduled: (() => void) | undefined;
  const clearInterval = vi.fn();
  const outcomes: string[] = [];
  const engine = new LocalStoragePressureEngine({
    policy: freeDrivenPolicy(),
    journal,
    freeBytesProvider: () => ROOMY_FREE_BYTES,
    onMaintenanceOutcome: (outcome) => outcomes.push(outcome),
    timers: {
      setInterval: (handler) => {
        scheduled = handler;
        return 'maintenance-timer';
      },
      clearInterval,
    },
  });

  engine.start();
  scheduled?.();
  scheduled?.();
  await Promise.resolve();
  expect(measureSpy).toHaveBeenCalledOnce();

  let stopSettled = false;
  const stop = engine.stop().then(() => {
    stopSettled = true;
  });
  await Promise.resolve();
  expect(stopSettled).toBe(false);
  expect(clearInterval).toHaveBeenCalledWith('maintenance-timer');

  releaseMeasure?.();
  await stop;
  expect(outcomes).toEqual(['success']);
  await journal.close();
});

function offerRecord(taskId: string, seq: number): ReceivedEnvelopeRecord {
  const bytes = JSON.stringify({ v: 1, id: `env-${taskId}`, type: 'task.offer', task_id: taskId, seq });
  return {
    identity: IDENTITY,
    envelopeId: `env-${taskId}`,
    taskId,
    seq,
    bytes,
    bytesHash: journalHash(bytes),
    receivedAt: '2026-08-07T00:00:00.000Z',
    opensTask: true,
  };
}

/** Reads the durable file directly, through a connection no journal instance under test owns. */
function readRows(storeDir: string, sql: string): Array<Record<string, unknown>> {
  const db = openJournalDatabase(path.join(storeDir, JOURNAL_DB_FILENAME), DEFAULT_JOURNAL_BUSY_TIMEOUT_MS);
  try {
    return db.prepare(sql).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function countRows(storeDir: string, table: string): number {
  return Number(readRows(storeDir, `SELECT count(*) AS n FROM ${table}`)[0]?.n ?? -1);
}

async function exists(target: string): Promise<boolean> {
  return fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}

/** A policy whose free-space axis is the one under the test's control; the budget is far out of reach unless a test says otherwise. */
function freeDrivenPolicy(overrides: Partial<LocalStoragePolicyInput> = {}): LocalStoragePolicyInput {
  return {
    maxStoreBytes: 1024 * 1024 * 1024,
    minFreeBytes: 100 * 1024 * 1024,
    softMinFreeBytes: 200 * 1024 * 1024,
    ackCriticalReserveBytes: 8 * 1024 * 1024,
    ...overrides,
  };
}

describe.skipIf(!isSqliteAvailable())('S3.4 disk-pressure matrix, points 7-12', () => {
  // -------------------------------------------------------------------
  // 7. Soft watermark.
  // -------------------------------------------------------------------
  it('7: soft pressure alerts and cleans ONLY rebuildable/expired categories, touching no durable record', async () => {
    const storeDir = await tmpDir('byok-pressure-7-store-');
    const scratch = await tmpDir('byok-pressure-7-scratch-');
    const journal = new SqliteLocalTaskJournal({ storeDir });

    // Protected data, in every shape §12.7.2.1 names.
    // 1. An acked envelope for a task still in flight (no terminal, no marker).
    await journal.appendEnvelope(offerRecord('task-running', 1));
    await journal.recordTransition({ transitionId: 'tr-run', taskId: 'task-running', to: 'Running', occurredAt: '2026-08-07T00:00:01.000Z' });
    // 2. A terminal the cloud has NOT confirmed.
    await journal.appendEnvelope(offerRecord('task-pending-truth', 2));
    await journal.recordTerminal({
      taskId: 'task-pending-truth',
      terminalType: 'complete',
      payloadHash: journalHash('payload-pending'),
      truthState: 'pending',
      attempt: 1,
      recordedAt: '2026-08-07T00:00:02.000Z',
    });
    // 3. A confirmed terminal — the only journal shape cleanup step 3 may ever
    //    touch, and it must stay untouched anyway at this state.
    await journal.appendEnvelope(offerRecord('task-confirmed', 3));
    await journal.recordTerminal({
      taskId: 'task-confirmed',
      terminalType: 'complete',
      payloadHash: journalHash('payload-confirmed'),
      truthState: 'confirmed',
      attempt: 1,
      recordedAt: '2026-08-07T00:00:03.000Z',
    });
    // 4. Quarantine evidence.
    const quarantineFile = path.join(storeDir, JOURNAL_QUARANTINE_DIRNAME, '2026-evidence.db');
    await fs.mkdir(path.dirname(quarantineFile), { recursive: true });
    await fs.writeFile(quarantineFile, 'corrupt database evidence');

    // One candidate per cleanable category, all eligible.
    const tempFile = path.join(scratch, 'upload.tmp');
    const rotatedLog = path.join(scratch, 'daemon.1.log');
    const ephemeralWorkspace = path.join(scratch, 'ws-ephemeral');
    const orphanArtifact = path.join(scratch, 'orphan.bin');
    await fs.writeFile(tempFile, 'x'.repeat(2048));
    await fs.writeFile(rotatedLog, 'y'.repeat(4096));
    await fs.mkdir(ephemeralWorkspace, { recursive: true });
    await fs.writeFile(path.join(ephemeralWorkspace, 'file.txt'), 'z'.repeat(1024));
    await fs.writeFile(orphanArtifact, 'w'.repeat(512));

    const eligibleAt = '2026-08-01T00:00:00.000Z';
    await journal.enqueueCleanupCandidate({ candidateId: 'c-temp', category: 'expired-temp', ref: tempFile, eligibleAt, reason: 'expired upload temp' });
    await journal.enqueueCleanupCandidate({ candidateId: 'c-log', category: 'rotated-log', ref: rotatedLog, eligibleAt, reason: 'rotated past retention' });
    await journal.enqueueCleanupCandidate({ candidateId: 'c-journal', category: 'confirmed-journal', ref: 'task:task-confirmed', eligibleAt, reason: 'terminal confirmed' });
    await journal.enqueueCleanupCandidate({ candidateId: 'c-ws', category: 'ephemeral-workspace', ref: ephemeralWorkspace, eligibleAt, reason: 'host-marked ephemeral' });
    await journal.enqueueCleanupCandidate({ candidateId: 'c-orphan', category: 'orphan-artifact', ref: orphanArtifact, eligibleAt, reason: 'reference scan + grace' });

    const envelopesBefore = countRows(storeDir, 'journal_envelope');
    const tasksBefore = countRows(storeDir, 'journal_task');
    const terminalsBefore = countRows(storeDir, 'journal_terminal');

    // The budget is sized off the CURRENT measurement so the device sits
    // between the soft (80%) and hard (90%) watermarks exactly, with no
    // dependence on how big a SQLite page happens to be on this machine.
    const measured = await journal.measureUsage();
    const events: StoragePressureEvent[] = [];
    const engine = new LocalStoragePressureEngine({
      policy: {
        maxStoreBytes: Math.ceil(measured.totalBytes / 0.85),
        minFreeBytes: 1024,
        ackCriticalReserveBytes: 512,
      },
      journal,
      freeBytesProvider: () => ROOMY_FREE_BYTES,
      executor: createFilesystemCleanupExecutor({ pruneJournalTask: (taskId) => journal.pruneConfirmedJournalTask(taskId) }),
      onEvent: (event) => events.push(event),
    });

    const result = await engine.tick();

    // The alert §12.7.2.1 asks for, on the transition itself.
    expect(result.state).toBe('pressure');
    expect(events.filter((e) => e.kind === 'state-changed')).toEqual([
      expect.objectContaining({ kind: 'state-changed', from: 'normal', to: 'pressure' }),
    ]);

    // Only the two rebuildable/expired categories were acted on — and both of
    // those actually happened, so this is not a pass by doing nothing.
    expect(result.cleaned.map((r) => r.candidateId).sort()).toEqual(['c-log', 'c-temp']);
    expect(result.cleaned.every((r) => r.outcome === 'deleted')).toBe(true);
    expect(await exists(tempFile)).toBe(false);
    expect(await exists(rotatedLog)).toBe(false);

    // Protected data untouched: not one journal row moved, the unconfirmed
    // terminal is intact, and quarantine evidence is exactly where it was.
    expect(countRows(storeDir, 'journal_envelope')).toBe(envelopesBefore);
    expect(countRows(storeDir, 'journal_task')).toBe(tasksBefore);
    expect(countRows(storeDir, 'journal_terminal')).toBe(terminalsBefore);
    expect(readRows(storeDir, "SELECT truth_state FROM journal_terminal WHERE task_id = 'task-pending-truth'")[0]?.truth_state).toBe('pending');
    expect(await exists(quarantineFile)).toBe(true);
    // Including the CONFIRMED journal row, whose candidate exists and is
    // eligible — pressure truncates the order rather than extending it.
    expect(readRows(storeDir, "SELECT task_id FROM journal_task WHERE task_id = 'task-confirmed'")).toHaveLength(1);
    expect(await exists(ephemeralWorkspace)).toBe(true);
    expect(await exists(orphanArtifact)).toBe(true);

    // No lost task, stable recovery status: the in-flight task is still the
    // one and only thing recovery would pick up.
    expect((await journal.listRecoverable()).map((t) => t.taskId)).toEqual(['task-running']);
    // The untouched candidates are still queued, not silently resolved.
    const remaining = await journal.listCleanupCandidates(new Date('2026-08-09T00:00:00.000Z'), 100);
    expect(remaining.map((c) => c.candidateId).sort()).toEqual(['c-journal', 'c-orphan', 'c-ws']);

    await journal.close();
  });

  // -------------------------------------------------------------------
  // 8 & 9. Hard watermark, idle and with a task Running.
  // -------------------------------------------------------------------
  describe('against a running daemon', () => {
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

    /** A journaling daemon whose pressure engine is injected, so this test owns the free-space reading and the tick cadence outright. */
    async function startPressuredDaemon(initialFreeBytes: number): Promise<{
      adapter: StubRuntimeAdapter;
      journal: SqliteLocalTaskJournal;
      engine: LocalStoragePressureEngine;
      storeDir: string;
      deviceId: string;
      setFreeBytes: (value: number) => void;
    }> {
      const storeDir = await tmpDir('byok-pressure-daemon-store-');
      const workspaceRoot = await tmpDir('byok-pressure-daemon-workspace-');
      const journal = new SqliteLocalTaskJournal({ storeDir });
      let freeBytes = initialFreeBytes;
      const engine = new LocalStoragePressureEngine({
        policy: freeDrivenPolicy(),
        journal,
        freeBytesProvider: () => freeBytes,
      });
      const adapter = new StubRuntimeAdapter('pi');
      daemon = createDaemonWithAdapters(
        {
          localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
          productId: 'test-product-pressure',
          serverUrl: server.url,
          workspaceRoot,
          storeDir,
          hostedJournal: { mode: 'sqlite', tenantId: 'tenant-a' },
        },
        [adapter],
        { hostedJournal: { journal, pressureEngine: engine } },
      );
      const record = await daemon.pair('pairing-code');
      await daemon.start();
      return { adapter, journal, engine, storeDir, deviceId: record.deviceId, setFreeBytes: (value) => (freeBytes = value) };
    }

    it('8: hard pressure while idle declines new offers retryably, while terminal flush, delete and export keep working', async () => {
      const { adapter, journal, engine, storeDir } = await startPressuredDaemon(50 * 1024 * 1024);

      expect((await engine.tick()).state).toBe('hard-pressure');

      server.send(createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-hard-idle', seq: server.nextSeq() }));
      const decline = await server.waitFor((e) => e.type === 'task.decline' && e.task_id === 'task-hard-idle');

      // Declined before anything was claimed or spawned — the whole point of
      // putting the guard ahead of adapter selection.
      expect(decline.payload).toMatchObject({ retryable: true, reason: 'local storage hard pressure' });
      expect(adapter.startCalls).toHaveLength(0);
      expect(server.received.filter((e) => e.type === 'task.claim')).toHaveLength(0);

      // No lost task: the offer was durably journaled BEFORE admission ran, so
      // the decline is a decision on record rather than an envelope dropped.
      // Hard pressure gates ADMISSION, not durability.
      expect(readRows(storeDir, "SELECT task_id FROM journal_task WHERE task_id = 'task-hard-idle'")).toHaveLength(1);

      // §12.7.2.1's other half of the hard-pressure row: everything that
      // FINISHES work keeps running while the device is at the hard watermark.
      // Terminal flush:
      await journal.recordTerminal({
        taskId: 'task-hard-idle',
        terminalType: 'complete',
        payloadHash: journalHash('hard-pressure-terminal'),
        truthState: 'confirmed',
        attempt: 1,
        recordedAt: '2026-08-07T00:01:00.000Z',
      });
      expect(readRows(storeDir, "SELECT truth_state FROM journal_terminal WHERE task_id = 'task-hard-idle'")[0]?.truth_state).toBe('confirmed');
      // Export/read:
      expect(await journal.listRecoverable()).toEqual([]);
      // Delete:
      expect(await journal.pruneConfirmedJournalTask('task-hard-idle')).toBe(true);
      expect(countRows(storeDir, 'journal_task')).toBe(0);
      // Still hard pressure throughout — none of the above needed the state to
      // relax first.
      expect(engine.state).toBe('hard-pressure');
    });

    it('9: hard pressure arriving mid-task lets the Running task finish while new offers are declined', async () => {
      const { adapter, engine, setFreeBytes } = await startPressuredDaemon(ROOMY_FREE_BYTES);

      expect((await engine.tick()).state).toBe('normal');

      server.send(createEnvelope('task.offer', { instruction: 'first', policy: { mode: 'auto' } }, { taskId: 'task-running-1', seq: server.nextSeq() }));
      await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-running-1');

      // The disk fills while that task is mid-flight.
      setFreeBytes(50 * 1024 * 1024);
      expect((await engine.tick()).state).toBe('hard-pressure');

      server.send(createEnvelope('task.offer', { instruction: 'second', policy: { mode: 'auto' } }, { taskId: 'task-declined-2', seq: server.nextSeq() }));
      const decline = await server.waitFor((e) => e.type === 'task.decline' && e.task_id === 'task-declined-2');
      expect(decline.payload).toMatchObject({ retryable: true });
      expect(adapter.startCalls).toHaveLength(1); // still only the first task's session

      // The Running task is untouched by pressure and runs to its terminal —
      // §12.7.2.1's "仍允许 terminal/truth flush". No lost task, and no second
      // side effect: exactly one terminal for it.
      adapter.sessions[0]?.emit({ type: 'turn_end' });
      await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-running-1');
      expect(server.received.filter((e) => e.type === 'task.complete')).toHaveLength(1);
    });

    // -----------------------------------------------------------------
    // 10. SQLite disk-full / IO error before the commit.
    // -----------------------------------------------------------------
    it('10: an IO failure before the commit leaves no half row and freezes the cursor; the redelivery then succeeds', async () => {
      const storeDir = await tmpDir('byok-pressure-10-store-');
      const workspaceRoot = await tmpDir('byok-pressure-10-workspace-');
      let failing = true;
      let faultFired = false;
      const journal = new SqliteLocalTaskJournal({
        storeDir,
        faults: {
          onStep(step: JournalFaultStep) {
            if (step !== 'append:before-commit' || !failing) return;
            faultFired = true;
            throw new Error('SQLITE_FULL: database or disk is full');
          },
        },
      });

      const adapter = new StubRuntimeAdapter('pi');
      daemon = createDaemonWithAdapters(
        {
          localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
          productId: 'test-product-pressure',
          serverUrl: server.url,
          workspaceRoot,
          storeDir,
          hostedJournal: { mode: 'sqlite', tenantId: 'tenant-a' },
        },
        [adapter],
        { hostedJournal: { journal } },
      );
      const record = await daemon.pair('pairing-code');
      await daemon.start();

      const cursorStore = new CursorStore(storeDir);
      const cursorBefore = await cursorStore.load(server.url, record.deviceId);

      server.send(createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-diskfull', seq: server.nextSeq() }));
      // Waiting on a POSITIVE signal — the fault actually fired inside the
      // append — rather than on the absence of one.
      await vi.waitFor(() => expect(faultFired).toBe(true), { timeout: 5000 });

      // The cursor cannot have advanced: it moves only when the envelope
      // handler resolves, and the handler rejected. Nothing was acked, so the
      // mailbox still owns this task.
      expect(await cursorStore.load(server.url, record.deviceId)).toBe(cursorBefore);
      // No half row anywhere: the transaction rolled back whole.
      expect(countRows(storeDir, 'journal_envelope')).toBe(0);
      expect(countRows(storeDir, 'journal_task')).toBe(0);
      expect(countRows(storeDir, 'journal_idempotency')).toBe(0);
      // And no work was scheduled off bytes that were never durable.
      expect(adapter.startCalls).toHaveLength(0);

      // The fault clears (space was freed) and the wire redelivers, which is
      // the ordinary at-least-once path, not a special recovery mode.
      failing = false;
      const receipt = await journal.appendEnvelope(offerRecord('task-diskfull', 42));
      expect(receipt.created).toBe(true);
      expect(readRows(storeDir, "SELECT envelope_id FROM journal_envelope WHERE envelope_id = 'env-task-diskfull'")).toHaveLength(1);
      // Stable recovery status: one task row for it, once — a re-append of the
      // same task cannot open a second.
      expect(readRows(storeDir, "SELECT task_id FROM journal_task WHERE task_id = 'task-diskfull'")).toHaveLength(1);
      expect((await journal.listRecoverable()).map((t) => t.taskId)).toContain('task-diskfull');
    });

    it('reports storage on the control-socket status surface, without colliding with queue watermarks', async () => {
      const { engine, storeDir } = await startPressuredDaemon(50 * 1024 * 1024);
      await engine.tick();

      const conn = await connectControlClient({ storeDir, productId: 'test-product-pressure' });
      expect(conn.ok).toBe(true);
      if (!conn.ok) return;
      try {
        const status = await conn.client.request<ControlStatusResult>('status');
        expect(status.storage).toMatchObject({
          pressureState: 'hard-pressure',
          budgetBytes: 1024 * 1024 * 1024,
          freeBytes: 50 * 1024 * 1024,
        });
        // All five §12.7.2.1 categories, separately — a single total cannot
        // drive a category-scoped cleanup order or never-delete list.
        expect(status.storage?.categories.map((c) => c.category)).toEqual(['cache', 'journal', 'log', 'quarantine', 'workspace']);
        // The two concepts stay apart on the wire and in the rendering.
        expect(status.queueWatermarks).toEqual([]);
        const lines = formatLiveStatusLines(status);
        expect(lines.some((line) => line.startsWith('live-storage: state=hard-pressure'))).toBe(true);
        expect(lines.filter((line) => line.startsWith('live-storage-category:'))).toHaveLength(5);
        expect(lines.some((line) => line.startsWith('live-queue-watermarks: (none)'))).toBe(true);

        // And a daemon with no storage policy renders none of it, rather than
        // a row of zeros that reads as a healthy measurement.
        expect(formatLiveStatusLines({ ...status, storage: undefined }).some((line) => line.startsWith('live-storage'))).toBe(false);
      } finally {
        conn.client.close();
      }
    });

    it('emergency refuses to ack at all, and the frozen cursor is what keeps the task safe', async () => {
      const { engine, storeDir, deviceId, setFreeBytes, adapter } = await startPressuredDaemon(ROOMY_FREE_BYTES);
      const cursorStore = new CursorStore(storeDir);

      // Below the ack-critical reserve: one more transaction cannot be
      // guaranteed, so §12.7.2.1 says stop acking rather than ack optimistically.
      setFreeBytes(1024);
      expect((await engine.tick()).state).toBe('emergency');
      expect(engine.admissionGuard().admit).toBe(false);
      expect(() => engine.assertAckCriticalAllowed()).toThrow(LocalStorageEmergencyError);

      const cursorBefore = await cursorStore.load(server.url, deviceId);
      const envelopesBefore = countRows(storeDir, 'journal_envelope');
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        server.send(createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-emergency', seq: server.nextSeq() }));
        // The positive signal: `ConnectionManager` reporting that the handler
        // rejected and it therefore left the cursor where it was. Waiting on
        // this rather than on an absence is what keeps the assertion below
        // from being a race the test happens to win.
        await vi.waitFor(
          () =>
            expect(
              logged.mock.calls.some(
                (call) => String(call[0]).includes('cursor left unadvanced') && call[1] instanceof LocalStorageEmergencyError,
              ),
            ).toBe(true),
          { timeout: 5000 },
        );
      } finally {
        logged.mockRestore();
      }
      expect(await cursorStore.load(server.url, deviceId)).toBe(cursorBefore);
      // Not acked, and not recorded: the envelope never reached the journal.
      expect(countRows(storeDir, 'journal_envelope')).toBe(envelopesBefore);
      expect(readRows(storeDir, "SELECT task_id FROM journal_task WHERE task_id = 'task-emergency'")).toEqual([]);
      expect(adapter.startCalls).toHaveLength(0);

      // Recovery evidence is preserved, not traded for room: nothing was
      // deleted to get out of emergency, and the way out is free space.
      setFreeBytes(ROOMY_FREE_BYTES);
      expect((await engine.tick()).state).toBe('normal');
      expect(engine.admissionGuard().admit).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // 11. A large WAL that needs a checkpoint.
  // -------------------------------------------------------------------
  it('11: a bounded checkpoint reclaims the WAL and never starves a concurrent append', async () => {
    const storeDir = await tmpDir('byok-pressure-11-store-');
    // One logical tick per commit timestamp — the only clock in this test, and
    // it advances only when the journal actually commits something.
    let logicalTick = 0;
    const base = Date.parse('2026-08-07T00:00:00.000Z');
    const journal = new SqliteLocalTaskJournal({
      storeDir,
      clock: () => new Date(base + logicalTick++),
    });

    for (let i = 0; i < 400; i += 1) await journal.appendEnvelope(offerRecord(`task-wal-${i}`, i + 1));
    const walPath = path.join(storeDir, `${JOURNAL_DB_FILENAME}-wal`);
    const walBefore = statSync(walPath).size;
    expect(walBefore).toBeGreaterThan(0);

    const checkpoint = await journal.compact({ checkpoint: 'truncate', incrementalVacuumPages: 8 });

    // Bounded and observable: the vacuum honoured its page cap and the result
    // says what happened rather than "ok".
    expect(checkpoint.pagesVacuumed).toBeLessThanOrEqual(8);
    expect(checkpoint.checkpointed).toBe(true);
    expect(checkpoint.walFramesRemaining).toBe(0);
    expect(typeof checkpoint.durationMs).toBe('number');
    expect(statSync(walPath).size).toBeLessThan(walBefore);

    // Now the starvation question: a checkpoint and five appends issued in the
    // same turn, none awaited before the next is scheduled.
    const completions: string[] = [];
    const tickAtScheduling = logicalTick;
    const compactPromise = journal
      .compact({ checkpoint: 'truncate', incrementalVacuumPages: 8 })
      .then((result) => {
        completions.push('compact');
        return result;
      });
    const appendPromises = Array.from({ length: 5 }, (_, i) =>
      journal.appendEnvelope(offerRecord(`task-concurrent-${i}`, 1000 + i)).then((receipt) => {
        completions.push(`append-${i}`);
        return receipt;
      }),
    );

    const [compacted, ...receipts] = await Promise.all([compactPromise, ...appendPromises]);

    // Nothing was starved: every append that was queued behind the checkpoint
    // completed, and completed for real (a fresh commit, not a dedup).
    expect(receipts.every((receipt) => receipt.created)).toBe(true);
    // Strict FIFO through the single-writer queue — the checkpoint could not
    // jump ahead of a later append, and no append was deferred behind a second
    // maintenance pass. Bounded latency is exactly this: each operation waits
    // for the ones already ahead of it and nothing else.
    expect(completions).toEqual(['compact', 'append-0', 'append-1', 'append-2', 'append-3', 'append-4']);
    // And the wait cost exactly five commits' worth of logical time — the
    // appends spent no clock ticks waiting, because `compact` consumes none.
    expect(logicalTick - tickAtScheduling).toBe(5);
    expect(compacted.pagesVacuumed).toBeLessThanOrEqual(8);

    // No lost task, no duplicate side effect: 405 envelopes in, 405 rows down.
    expect(countRows(storeDir, 'journal_envelope')).toBe(405);
    expect(countRows(storeDir, 'journal_idempotency')).toBe(405);
    await journal.close();
  });

  // -------------------------------------------------------------------
  // 12. Cleanup worker crash, both orders.
  // -------------------------------------------------------------------
  describe('12: a cleanup worker crash, in either order', () => {
    /** A journal plus a protected-data baseline, so every assertion below can end with "and none of this moved". */
    async function seeded(prefix: string): Promise<{ storeDir: string; scratch: string; journal: SqliteLocalTaskJournal }> {
      const storeDir = await tmpDir(`${prefix}-store-`);
      const scratch = await tmpDir(`${prefix}-scratch-`);
      const journal = new SqliteLocalTaskJournal({ storeDir });
      await journal.appendEnvelope(offerRecord('task-protected', 1));
      await journal.recordTransition({ transitionId: 'tr-p', taskId: 'task-protected', to: 'Running', occurredAt: '2026-08-07T00:00:01.000Z' });
      return { storeDir, scratch, journal };
    }

    function engineWith(journal: SqliteLocalTaskJournal, executor: CleanupExecutor): LocalStoragePressureEngine {
      return new LocalStoragePressureEngine({
        // Roomy on both axes: this test is about the cleanup worker, and
        // `normal` is the state whose cleanup order includes every category.
        policy: freeDrivenPolicy(),
        journal,
        freeBytesProvider: () => ROOMY_FREE_BYTES,
        executor,
        clock: () => new Date('2026-08-09T00:00:00.000Z'),
      });
    }

    it('order A — file deleted, metadata not marked: the retry converges and deletes nothing twice', async () => {
      const { storeDir, scratch, journal } = await seeded('byok-pressure-12a');
      const target = path.join(scratch, 'expired.tmp');
      await fs.writeFile(target, 'temp bytes');
      await journal.enqueueCleanupCandidate({
        candidateId: 'c-crash-a',
        category: 'expired-temp',
        ref: target,
        eligibleAt: '2026-08-01T00:00:00.000Z',
        reason: 'expired',
      });

      // The crash: the worker removes the file, then dies before the journal
      // learns anything about it.
      const seen: string[] = [];
      const crashing: CleanupExecutor = async (candidate) => {
        seen.push(candidate.candidateId);
        await fs.rm(candidate.ref, { force: true });
        throw new Error('cleanup worker died after the unlink');
      };
      await engineWith(journal, crashing).tick();

      expect(await exists(target)).toBe(false);
      // The candidate is NOT resolved — `failed` leaves it eligible, which is
      // what makes the crash recoverable at all.
      const [pending] = await journal.listCleanupCandidates(new Date('2026-08-09T00:00:00.000Z'), 10);
      expect(pending).toMatchObject({ candidateId: 'c-crash-a', attempts: 1 });

      // The retry, with a healthy worker. It finds nothing to delete and says
      // so — no second deletion, no infinite retry.
      const realExecutor = createFilesystemCleanupExecutor();
      const retry = await engineWith(journal, realExecutor).tick();
      expect(retry.cleaned).toEqual([
        expect.objectContaining({ candidateId: 'c-crash-a', outcome: 'deleted', bytesReclaimed: 0 }),
      ]);
      expect(await journal.listCleanupCandidates(new Date('2026-08-09T00:00:00.000Z'), 10)).toEqual([]);
      expect(seen).toEqual(['c-crash-a']);

      // Protected data untouched throughout, and recovery still sees exactly
      // the one in-flight task.
      expect(countRows(storeDir, 'journal_envelope')).toBe(1);
      expect((await journal.listRecoverable()).map((t) => t.taskId)).toEqual(['task-protected']);
      await journal.close();
    });

    it('order B — metadata marked, file not deleted: a fresh reference scan re-enqueues and the retry is idempotent', async () => {
      const { storeDir, scratch, journal } = await seeded('byok-pressure-12b');
      const target = path.join(scratch, 'orphan.bin');
      await fs.writeFile(target, 'artifact bytes');
      await journal.enqueueCleanupCandidate({
        candidateId: 'c-crash-b',
        category: 'orphan-artifact',
        ref: target,
        eligibleAt: '2026-08-01T00:00:00.000Z',
        reason: 'reference scan + grace',
      });

      // The other order: the journal is told the work is done, and then the
      // unlink never happens.
      const lying: CleanupExecutor = async () => ({ outcome: 'deleted', bytesReclaimed: 14 });
      await engineWith(journal, lying).tick();
      expect(await journal.listCleanupCandidates(new Date('2026-08-09T00:00:00.000Z'), 10)).toEqual([]);
      expect(await exists(target)).toBe(true); // still on disk, metadata says otherwise

      // Re-enqueueing the SAME candidate id changes nothing — resolved rows are
      // not reopened by a repeated enqueue, so a scan that runs twice cannot
      // resurrect the same work twice.
      await journal.enqueueCleanupCandidate({
        candidateId: 'c-crash-b',
        category: 'orphan-artifact',
        ref: target,
        eligibleAt: '2026-08-01T00:00:00.000Z',
        reason: 'reference scan + grace',
      });
      expect(countRows(storeDir, 'local_cleanup_candidate')).toBe(1);
      expect(await journal.listCleanupCandidates(new Date('2026-08-09T00:00:00.000Z'), 10)).toEqual([]);

      // The next reference scan sees a file with no reference and enqueues it
      // afresh, which is the convergence path.
      await journal.enqueueCleanupCandidate({
        candidateId: 'c-crash-b-rescan',
        category: 'orphan-artifact',
        ref: target,
        eligibleAt: cleanupEligibleAt(resolveLocalStoragePolicy(freeDrivenPolicy()), 'orphan-artifact', new Date('2026-08-01T00:00:00.000Z')),
        reason: 'reference scan + grace, second pass',
      });
      const realExecutor = createFilesystemCleanupExecutor();
      const first = await engineWith(journal, realExecutor).tick();
      expect(first.cleaned).toEqual([
        expect.objectContaining({ candidateId: 'c-crash-b-rescan', outcome: 'deleted', bytesReclaimed: 14 }),
      ]);
      expect(await exists(target)).toBe(false);

      // Idempotent on a third pass: same ref, already gone, still `deleted`
      // with nothing reclaimed and no error.
      await journal.enqueueCleanupCandidate({
        candidateId: 'c-crash-b-rescan-2',
        category: 'orphan-artifact',
        ref: target,
        eligibleAt: '2026-08-01T00:00:00.000Z',
        reason: 'third pass',
      });
      const second = await engineWith(journal, realExecutor).tick();
      expect(second.cleaned).toEqual([
        expect.objectContaining({ candidateId: 'c-crash-b-rescan-2', outcome: 'deleted', bytesReclaimed: 0 }),
      ]);

      expect(countRows(storeDir, 'journal_envelope')).toBe(1);
      expect((await journal.listRecoverable()).map((t) => t.taskId)).toEqual(['task-protected']);
      await journal.close();
    });

    it('protected data has no cleanup spelling: the journal prune refuses anything unconfirmed or recovery-marked', async () => {
      const { storeDir, journal } = await seeded('byok-pressure-12c');

      // An unconfirmed terminal.
      await journal.appendEnvelope(offerRecord('task-unconfirmed', 2));
      await journal.recordTerminal({
        taskId: 'task-unconfirmed',
        terminalType: 'complete',
        payloadHash: journalHash('p1'),
        truthState: 'pending',
        attempt: 1,
        recordedAt: '2026-08-07T00:00:02.000Z',
      });
      // A confirmed terminal that ALSO carries a recovery marker.
      await journal.appendEnvelope(offerRecord('task-marked', 3));
      await journal.recordTerminal({
        taskId: 'task-marked',
        terminalType: 'complete',
        payloadHash: journalHash('p2'),
        truthState: 'confirmed',
        attempt: 1,
        recordedAt: '2026-08-07T00:00:03.000Z',
      });
      await journal.markRecovered('task-marked', { disposition: 'interrupted' });
      // And one that is genuinely eligible, to prove the guard is not simply
      // refusing everything.
      await journal.appendEnvelope(offerRecord('task-eligible', 4));
      await journal.recordTerminal({
        taskId: 'task-eligible',
        terminalType: 'complete',
        payloadHash: journalHash('p3'),
        truthState: 'confirmed',
        attempt: 1,
        recordedAt: '2026-08-07T00:00:04.000Z',
      });

      expect(await journal.pruneConfirmedJournalTask('task-protected')).toBe(false); // in flight, no terminal
      expect(await journal.pruneConfirmedJournalTask('task-unconfirmed')).toBe(false);
      expect(await journal.pruneConfirmedJournalTask('task-marked')).toBe(false);
      expect(await journal.pruneConfirmedJournalTask('task-eligible')).toBe(true);

      expect(readRows(storeDir, 'SELECT task_id FROM journal_task ORDER BY task_id').map((r) => r.task_id)).toEqual([
        'task-marked',
        'task-protected',
        'task-unconfirmed',
      ]);
      expect(countRows(storeDir, 'journal_terminal')).toBe(2);
      // The pruned task took its envelope and receipt with it, and nothing else did.
      expect(readRows(storeDir, 'SELECT envelope_id FROM journal_envelope ORDER BY envelope_id').map((r) => r.envelope_id)).toEqual([
        'env-task-marked',
        'env-task-protected',
        'env-task-unconfirmed',
      ]);

      // A refused prune is a `skipped` candidate, not a failure to retry
      // forever — the executor reports it and the journal resolves it.
      const refused: CleanupCandidate = {
        candidateId: 'c-refused',
        category: 'confirmed-journal',
        ref: 'task:task-marked',
        eligibleAt: '2026-08-01T00:00:00.000Z',
        reason: 'confirmed terminal',
        attempts: 0,
      };
      const executor = createFilesystemCleanupExecutor({ pruneJournalTask: (taskId) => journal.pruneConfirmedJournalTask(taskId) });
      expect(await executor(refused)).toMatchObject({ outcome: 'skipped' });

      await journal.close();
    });
  });
});
