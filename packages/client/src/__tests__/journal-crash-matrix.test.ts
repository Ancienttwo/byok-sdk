/**
 * Sprint S3.4's crash matrix, points 1-6 (P-007).
 *
 * The six injection points walk the one window this whole slice defends:
 * mailbox row -> local commit -> ack -> admission -> claim -> runtime ->
 * terminal -> cloud receipt -> local completion mark. Each point asserts the
 * same four invariants: **no lost task**, **no duplicate side effect**,
 * **stable recovery status**, **protected data untouched**.
 *
 * Method, and why it is this one:
 *
 * - A "crash" is either an injected throw at a named transaction step
 *   (`JournalFaultSeam`) or dropping the journal instance without closing it
 *   and reopening the same file. Both are deterministic. A real process kill
 *   would be higher fidelity and lower value here — slow, platform-dependent,
 *   and it would test the OS rather than the ordering. What `synchronous=FULL`
 *   guarantees across a power cut is SQLite's contract, asserted once by the
 *   pragma test in `journal-sqlite.test.ts`; what this file asserts is that
 *   the daemon's own ordering puts the right things on either side of it.
 * - No wall clock anywhere: no sleeps, no timing assertions, no "wait a bit
 *   and check". Every step is either awaited or gated.
 *
 * Points 5 and 6 straddle the cloud boundary, so they run against the real
 * `@byok/cloud` composition over a real socket (the S3a fixture) rather than
 * a double — the claim being made is about the CLOUD's idempotency absorbing
 * a local retry, and a fake cloud would be asserting the test's own beliefs.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeEnvelope, encodeEnvelope, type Envelope } from '@byok/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { DeviceStore } from '../daemon/store';
import { journalHash, type JournalIdentity, type ReceivedEnvelopeRecord } from '../daemon/journal/journal';
import {
  JOURNAL_DB_FILENAME,
  SqliteLocalTaskJournal,
  DEFAULT_JOURNAL_BUSY_TIMEOUT_MS,
  type JournalFaultStep,
} from '../daemon/journal/sqlite-journal';
import { isSqliteAvailable, openJournalDatabase } from '../daemon/journal/sqlite-support';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { startRealCloud, type RealCloudHandle } from './fixtures/real-cloud';

const IDENTITY: JournalIdentity = { tenantId: 'tenant-a', productId: 'test-product', deviceId: 'dev_1' };

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

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

/** Reads the durable file directly, through a connection neither journal instance under test owns. */
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

function faultOnce(step: JournalFaultStep): { onStep(current: JournalFaultStep): void } {
  let fired = false;
  return {
    onStep(current) {
      if (current !== step || fired) return;
      fired = true;
      throw new Error(`crash injected at ${step}`);
    },
  };
}

describe.skipIf(!isSqliteAvailable())('S3.4 crash matrix, points 1-6', () => {
  const dirs: string[] = [];

  async function store(prefix: string): Promise<string> {
    const dir = await tmpDir(prefix);
    dirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------
  // 1. Crash BEFORE the local append.
  // -------------------------------------------------------------------
  it('1: crash before the local append leaves no trace, and the mailbox redelivery is the whole recovery', async () => {
    const storeDir = await store('byok-crash-1-');
    const crashing = new SqliteLocalTaskJournal({ storeDir, faults: faultOnce('append:before-begin') });

    await expect(crashing.appendEnvelope(offerRecord('task-1', 1))).rejects.toThrow(/crash injected/);

    // No lost task: nothing was acked, because `appendEnvelope` never
    // resolved, so `onEnvelope` never resolved, so the cursor never moved and
    // the cloud still holds this row. Locally there is nothing to lose.
    expect(countRows(storeDir, 'journal_envelope')).toBe(0);
    expect(countRows(storeDir, 'journal_task')).toBe(0);
    expect(await crashing.listRecoverable()).toEqual([]);

    // The redelivery — an ordinary first append, on a fresh instance as after
    // a restart. No test-side special-casing: the recovery IS the wire's
    // at-least-once guarantee.
    await crashing.close();
    const restarted = new SqliteLocalTaskJournal({ storeDir });
    const receipt = await restarted.appendEnvelope(offerRecord('task-1', 1));

    expect(receipt.created).toBe(true);
    expect(countRows(storeDir, 'journal_envelope')).toBe(1);
    expect((await restarted.listRecoverable()).map((task) => task.taskId)).toEqual(['task-1']);
    await restarted.close();
  });

  // -------------------------------------------------------------------
  // 2. Crash AFTER the SQLite commit, BEFORE the ack.
  //    The contract's cheapest falsifier.
  // -------------------------------------------------------------------
  it('2: crash after the commit and before the ack is absorbed by the receipt, with zero second side effect', async () => {
    const storeDir = await store('byok-crash-2-');

    // Committed. Then the process dies before the next poll could carry the
    // advanced cursor: the instance is DROPPED, never closed.
    const beforeCrash = new SqliteLocalTaskJournal({ storeDir });
    const first = await beforeCrash.appendEnvelope(offerRecord('task-2', 5));
    expect(first.created).toBe(true);

    // Restart. The mailbox never saw an ack, so it redelivers the identical
    // envelope.
    const afterCrash = new SqliteLocalTaskJournal({ storeDir });
    const redelivered = await afterCrash.appendEnvelope(offerRecord('task-2', 5));

    // No lost task: the bytes survived the crash.
    const [envelope] = readRows(storeDir, 'SELECT bytes, bytes_hash, seq FROM journal_envelope');
    expect(envelope?.bytes).toBe(offerRecord('task-2', 5).bytes);
    // No duplicate side effect: the redelivery hit the receipt and wrote
    // nothing — same commit instant, one row per table.
    expect(redelivered.created).toBe(false);
    expect(redelivered.committedAt).toBe(first.committedAt);
    expect(redelivered.bytesHash).toBe(first.bytesHash);
    expect(countRows(storeDir, 'journal_envelope')).toBe(1);
    expect(countRows(storeDir, 'journal_task')).toBe(1);
    expect(countRows(storeDir, 'journal_idempotency')).toBe(1);
    // Stable recovery status: exactly one task to recover, not two.
    expect((await afterCrash.listRecoverable()).map((task) => task.taskId)).toEqual(['task-2']);
    await afterCrash.close();
  });

  // -------------------------------------------------------------------
  // 3. Crash AFTER the ack, BEFORE admission.
  // -------------------------------------------------------------------
  it('3: crash after the ack and before admission leaves the task recoverable, and markRecovered closes it out', async () => {
    const storeDir = await store('byok-crash-3-');

    const beforeCrash = new SqliteLocalTaskJournal({ storeDir });
    await beforeCrash.appendEnvelope(offerRecord('task-3', 9));
    // The ack happened: the cloud has retired this row and will never resend
    // it. From here on, this journal is the only record that the task exists.

    const afterCrash = new SqliteLocalTaskJournal({ storeDir });
    const recoverable = await afterCrash.listRecoverable();

    // No lost task: the acked-but-unadmitted task is exactly what recovery is
    // for, and it is here with its envelope and cursor position intact.
    expect(recoverable).toHaveLength(1);
    expect(recoverable[0]).toMatchObject({ taskId: 'task-3', envelopeId: 'env-task-3', seq: 9, localState: 'received' });

    await afterCrash.markRecovered('task-3', { disposition: 'interrupted', reason: 'crashed before admission' });

    // Stable recovery status: closed out, and it stays closed out across
    // another crash — a second restart does not re-surface it, and a second
    // markRecovered does not overwrite the first decision.
    expect(await afterCrash.listRecoverable()).toEqual([]);
    const afterSecondCrash = new SqliteLocalTaskJournal({ storeDir });
    expect(await afterSecondCrash.listRecoverable()).toEqual([]);
    await afterSecondCrash.markRecovered('task-3', { disposition: 'abandoned', reason: 'second pass' });

    // Protected data untouched: recovery marks, it never deletes.
    const [task] = readRows(storeDir, 'SELECT task_id, recovery_marker FROM journal_task');
    expect(task?.task_id).toBe('task-3');
    expect(JSON.parse(task?.recovery_marker as string)).toMatchObject({ disposition: 'interrupted' });
    expect(countRows(storeDir, 'journal_envelope')).toBe(1);
    await afterSecondCrash.close();
  });

  // -------------------------------------------------------------------
  // 4. Crash AFTER the claim, BEFORE the runtime starts.
  // -------------------------------------------------------------------
  it('4: crash after the claim and before runtime start recovers a stable, complete task record', async () => {
    const storeDir = await store('byok-crash-4-');

    const beforeCrash = new SqliteLocalTaskJournal({ storeDir });
    await beforeCrash.appendEnvelope(offerRecord('task-4', 11));
    await beforeCrash.recordAdmission({
      taskId: 'task-4',
      admitted: true,
      claimedRuntime: 'claude',
      effectivePolicyHash: journalHash('policy'),
      workspaceRef: '/workspaces/task-4',
      decidedAt: '2026-08-07T00:00:01.000Z',
    });
    await beforeCrash.recordTransition({ transitionId: 'tr-claim', taskId: 'task-4', from: 'received', to: 'Claimed', occurredAt: '2026-08-07T00:00:02.000Z' });
    // The runtime session was never started — and could not be resumed even if
    // it had been, which is why recovery marks rather than resumes.

    const afterCrash = new SqliteLocalTaskJournal({ storeDir });
    const [recovered] = await afterCrash.listRecoverable();

    // No lost task, and everything the operator needs to act on it survived:
    // which runtime was claimed, under which policy, in which workspace.
    expect(recovered).toMatchObject({
      taskId: 'task-4',
      localState: 'Claimed',
      claimedRuntime: 'claude',
      workspaceRef: '/workspaces/task-4',
    });

    // Stable recovery status: reopening again reports the identical thing.
    const afterSecondCrash = new SqliteLocalTaskJournal({ storeDir });
    expect(await afterSecondCrash.listRecoverable()).toEqual(await afterCrash.listRecoverable());
    // No duplicate side effect: replaying the claim transition adds no row.
    await afterSecondCrash.recordTransition({ transitionId: 'tr-claim', taskId: 'task-4', from: 'received', to: 'Claimed', occurredAt: '2026-08-07T00:00:09.000Z' });
    expect(countRows(storeDir, 'journal_transition')).toBe(1);
    // Protected data untouched: a Running/Claimed task is on the
    // never-auto-delete list, and nothing here is a deletion path.
    expect(countRows(storeDir, 'journal_task')).toBe(1);
    await afterCrash.close();
    await afterSecondCrash.close();
  });

  // -------------------------------------------------------------------
  // 5 & 6: the cloud boundary, against the real hosted composition.
  // -------------------------------------------------------------------
  describe('across the cloud boundary', () => {
    let cloud: RealCloudHandle | undefined;
    let daemon: Daemon | undefined;
    let journal: SqliteLocalTaskJournal | undefined;

    afterEach(async () => {
      await daemon?.stop();
      daemon = undefined;
      await journal?.close();
      journal = undefined;
      await cloud?.close();
      cloud = undefined;
    });

    /** Drives one real task to `task.complete` through a journaling daemon against the real cloud, and hands back everything both sides recorded. */
    async function runOneTaskToTerminal(): Promise<{
      taskId: string;
      storeDir: string;
      terminal: Envelope;
      accessToken: string;
      cloudHandle: RealCloudHandle;
      journalHandle: SqliteLocalTaskJournal;
    }> {
      cloud = await startRealCloud({ productId: 'test-product', longPollHoldMs: 200, longPollIntervalMs: 20 });
      const storeDir = await store('byok-crash-cloud-store-');
      const workspaceRoot = await store('byok-crash-cloud-workspace-');
      const adapter = new StubRuntimeAdapter();
      // The journal is injected so this test owns its lifetime — it has to
      // outlive the daemon that used it, which is the whole point of a crash.
      journal = new SqliteLocalTaskJournal({ storeDir });

      daemon = createDaemonWithAdapters(
        {
          productName: 'Test',
          productId: 'test-product',
          serverUrl: cloud.url,
          workspaceRoot,
          storeDir,
          hostedJournal: { mode: 'sqlite', tenantId: 'tenant-cloud-test' },
        },
        [adapter],
        {
          hostedJournal: { journal },
          backoff: { baseMs: 20, maxMs: 50, factor: 2 },
          longPoll: { wsFailureThreshold: 1, wsRetryIntervalMs: 60_000, retryDelayMs: 20, idleDelayMs: 20 },
        },
      );

      const pairing = await cloud.createPairingCode();
      const record = await daemon.pair(pairing.code);
      await daemon.start();

      const offer = await cloud.enqueueOffer(record.deviceId, 'do it, then crash around it');
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), { timeout: 10_000 });
      adapter.sessions[0]?.emit({ type: 'progress', text: 'working' });
      adapter.sessions[0]?.emit({ type: 'turn_end' });
      await vi.waitFor(async () => {
        expect((await cloud?.readTaskAttempt(offer.taskId))?.status).toBe('complete');
      }, { timeout: 10_000 });

      const body = await cloud.readTerminalBody(offer.taskId);
      const stored = await new DeviceStore(storeDir).load();
      return {
        taskId: offer.taskId,
        storeDir,
        terminal: decodeEnvelope(body ?? ''),
        accessToken: stored?.accessToken ?? '',
        cloudHandle: cloud,
        journalHandle: journal,
      };
    }

    /** Re-sends a terminal exactly as a restarted daemon retrying an unconfirmed one would: same task, same payload, a NEW envelope id (so cloud-side dedup does not catch it — the RECEIPT has to). */
    async function resendTerminal(handle: RealCloudHandle, accessToken: string, terminal: Envelope): Promise<number> {
      const retried = { ...terminal, id: crypto.randomUUID(), ts: new Date().toISOString() };
      const response = await fetch(`${handle.url}/byok/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [JSON.parse(encodeEnvelope(retried as Envelope))] }),
      });
      return response.status;
    }

    it('5: crash after the terminal is journaled and before the cloud receipt — the retry is absorbed by the receipt', async () => {
      const { taskId, storeDir, terminal, accessToken, cloudHandle, journalHandle } = await runOneTaskToTerminal();

      // The terminal is durable locally, hashed, and the hash is over the
      // canonical bytes the cloud recorded — the two sides agree on WHAT
      // finished without the journal storing the payload.
      const [row] = readRows(storeDir, 'SELECT task_id, terminal_type, payload_hash, truth_state FROM journal_terminal');
      expect(row).toMatchObject({ task_id: taskId, terminal_type: 'complete', payload_hash: journalHash(encodeEnvelope(terminal)) });

      const receiptBefore = await cloudHandle.readTerminalBody(taskId);
      const attemptBefore = await cloudHandle.readTaskAttempt(taskId);

      // The retry a daemon that crashed in this window performs on restart.
      expect(await resendTerminal(cloudHandle, accessToken, terminal)).toBe(200);
      expect(await resendTerminal(cloudHandle, accessToken, terminal)).toBe(200);

      // No duplicate side effect: first terminal wins, byte-for-byte, and the
      // attempt did not move.
      expect(await cloudHandle.readTerminalBody(taskId)).toBe(receiptBefore);
      expect(await cloudHandle.readTaskAttempt(taskId)).toEqual(attemptBefore);
      // No lost task, stable recovery status: a task with a terminal is not
      // "in the middle of something", before or after the retry.
      expect(await journalHandle.listRecoverable()).toEqual([]);
      expect(countRows(storeDir, 'journal_terminal')).toBe(1);
    }, 30_000);

    it('6: crash after the cloud receipt and before the local completion mark — the mark replays idempotently', async () => {
      const { taskId, storeDir, terminal, cloudHandle, journalHandle } = await runOneTaskToTerminal();
      const payloadHash = journalHash(encodeEnvelope(terminal));
      const receiptBefore = await cloudHandle.readTerminalBody(taskId);

      // The cloud has the receipt; the local "confirmed" mark had not been
      // written when the process died. On restart the daemon replays it — and,
      // because it cannot know whether it already ran, replays it twice.
      await journalHandle.recordTerminal({
        taskId,
        terminalType: 'complete',
        payloadHash,
        truthState: 'confirmed',
        attempt: 2,
        recordedAt: '2026-08-07T00:10:00.000Z',
      });
      await journalHandle.recordTerminal({
        taskId,
        terminalType: 'complete',
        payloadHash,
        truthState: 'confirmed',
        attempt: 2,
        recordedAt: '2026-08-07T00:10:01.000Z',
      });

      // No duplicate side effect: one row, the ORIGINAL terminal fact, now
      // marked confirmed.
      const rows = readRows(storeDir, 'SELECT task_id, payload_hash, truth_state, attempt FROM journal_terminal');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ task_id: taskId, payload_hash: payloadHash, truth_state: 'confirmed' });
      // Protected data untouched, and the cloud's own first fact is unchanged
      // by anything the local replay did.
      expect(await cloudHandle.readTerminalBody(taskId)).toBe(receiptBefore);
      expect(countRows(storeDir, 'journal_envelope')).toBeGreaterThan(0);

      // Stable recovery status across a restart of the journal itself.
      await journalHandle.close();
      const reopened = new SqliteLocalTaskJournal({ storeDir });
      expect(await reopened.listRecoverable()).toEqual([]);
      expect(readRows(storeDir, 'SELECT truth_state FROM journal_terminal')[0]?.truth_state).toBe('confirmed');
      await reopened.close();
      journal = undefined; // already closed above; keep afterEach from double-closing
    }, 30_000);
  });
});
