/**
 * `SqliteLocalTaskJournal` unit suite (L-001).
 *
 * Every test here is about one of the four things the journal has to be true
 * for the mailbox cursor to be allowed to move: the multi-table write is
 * atomic, a replay is a no-op, a reopened database still knows everything it
 * committed, and an unreadable database is preserved rather than replaced.
 *
 * Skipped wholesale on a runtime without `node:sqlite` (the `isSqliteAvailable`
 * idiom `@byok/server`'s own SQLite suites use). The fail-closed CONSTRUCTION
 * behaviour that matters on those runtimes is covered by
 * `journal-unavailable.test.ts`, which does not skip.
 */
import { promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JournalCorruptError,
  JournalRecordTooLargeError,
  JournalUnknownTaskError,
  journalHash,
  type JournalIdentity,
  type ReceivedEnvelopeRecord,
} from '../daemon/journal/journal';
import {
  DEFAULT_JOURNAL_BUSY_TIMEOUT_MS,
  JOURNAL_DB_FILENAME,
  JOURNAL_QUARANTINE_DIRNAME,
  SqliteLocalTaskJournal,
  type JournalFaultStep,
} from '../daemon/journal/sqlite-journal';
import { isSqliteAvailable, openJournalDatabase } from '../daemon/journal/sqlite-support';

const IDENTITY: JournalIdentity = { tenantId: 'tenant-a', productId: 'test-product', deviceId: 'dev_1' };

function envelopeRecord(overrides: Partial<ReceivedEnvelopeRecord> = {}): ReceivedEnvelopeRecord {
  const bytes = overrides.bytes ?? JSON.stringify({ v: 1, id: 'env-1', type: 'task.offer', task_id: 'task-1' });
  return {
    identity: IDENTITY,
    envelopeId: 'env-1',
    taskId: 'task-1',
    seq: 1,
    bytes,
    bytesHash: journalHash(bytes),
    receivedAt: '2026-08-07T00:00:00.000Z',
    opensTask: true,
    ...overrides,
  };
}

/** Reads straight off the database file through its OWN connection — the tests never see the journal's private handle, so an assertion here is about what actually landed on disk. */
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

/** Throws once, at exactly one named step. Later passes through the same step proceed — so a test can inject a failure and then prove the NEXT attempt succeeds. */
function faultOnce(step: JournalFaultStep): { onStep(step: JournalFaultStep): void; fired: () => boolean } {
  let fired = false;
  return {
    onStep(current) {
      if (current !== step || fired) return;
      fired = true;
      throw new Error(`injected fault at ${step}`);
    },
    fired: () => fired,
  };
}

describe.skipIf(!isSqliteAvailable())('SqliteLocalTaskJournal', () => {
  const dirs: string[] = [];
  const open: SqliteLocalTaskJournal[] = [];

  async function tmpStore(prefix = 'byok-journal-'): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function build(storeDir: string, options: Partial<ConstructorParameters<typeof SqliteLocalTaskJournal>[0]> = {}): SqliteLocalTaskJournal {
    const journal = new SqliteLocalTaskJournal({ storeDir, ...options });
    open.push(journal);
    return journal;
  }

  afterEach(async () => {
    for (const journal of open.splice(0)) {
      await journal.close().catch(() => undefined);
    }
    for (const dir of dirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  describe('durability settings', () => {
    it('applies the four §12.7.2 pragmas in an order that makes each of them real', async () => {
      const storeDir = await tmpStore();
      build(storeDir);

      const db = openJournalDatabase(path.join(storeDir, JOURNAL_DB_FILENAME), 1_000);
      try {
        // WAL is persisted in the file header, so a fresh connection observing
        // it proves the journal set it on the DATABASE, not just on its own
        // handle.
        expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
        // `auto_vacuum` is likewise persistent, and only settable before any
        // table exists — observing INCREMENTAL (2) here is what proves
        // `compact()`'s incremental_vacuum is not a no-op that reports success.
        expect((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(2);
        // These two are per-connection, so this asserts what `openJournalDatabase`
        // does for every connection it hands out — the journal's included.
        expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
        expect((db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(2); // FULL
      } finally {
        db.close();
      }
    });

    it('creates all eight §12.7.2 tables', async () => {
      const storeDir = await tmpStore();
      build(storeDir);

      const tables = readRows(storeDir, "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .map((row) => row.name as string)
        .filter((name) => !name.startsWith('sqlite_'));

      expect(tables).toEqual([
        'journal_envelope',
        'journal_idempotency',
        'journal_task',
        'journal_terminal',
        'journal_transition',
        'local_artifact_ref',
        'local_cleanup_candidate',
        'local_storage_usage',
      ]);
    });
  });

  describe('appendEnvelope', () => {
    it('commits the envelope, the task record, and the receipt as one unit', async () => {
      const storeDir = await tmpStore();
      const journal = build(storeDir);

      const receipt = await journal.appendEnvelope(envelopeRecord());

      expect(receipt.created).toBe(true);
      expect(receipt.seq).toBe(1);
      expect(countRows(storeDir, 'journal_envelope')).toBe(1);
      expect(countRows(storeDir, 'journal_task')).toBe(1);
      expect(countRows(storeDir, 'journal_idempotency')).toBe(1);
    });

    it('is idempotent by envelope id: a redelivery returns the ORIGINAL receipt and writes nothing', async () => {
      const storeDir = await tmpStore();
      const journal = build(storeDir);

      const first = await journal.appendEnvelope(envelopeRecord());
      const replay = await journal.appendEnvelope(envelopeRecord());

      expect(replay.created).toBe(false);
      // Same commit instant, not "now" — the caller is being told about the
      // original durable write, not a new one.
      expect(replay.committedAt).toBe(first.committedAt);
      expect(replay.bytesHash).toBe(first.bytesHash);
      expect(countRows(storeDir, 'journal_envelope')).toBe(1);
      expect(countRows(storeDir, 'journal_idempotency')).toBe(1);
    });

    it('rolls the WHOLE transaction back when a later table fails, leaving no half-row behind', async () => {
      const storeDir = await tmpStore();
      // Fires after the envelope row is inserted and before the task row — the
      // exact window a non-transactional implementation would leave an
      // envelope with no task record in.
      const fault = faultOnce('append:after-envelope');
      const journal = build(storeDir, { faults: fault });

      await expect(journal.appendEnvelope(envelopeRecord())).rejects.toThrow(/injected fault/);
      expect(fault.fired()).toBe(true);

      expect(countRows(storeDir, 'journal_envelope')).toBe(0);
      expect(countRows(storeDir, 'journal_task')).toBe(0);
      expect(countRows(storeDir, 'journal_idempotency')).toBe(0);

      // And the rollback left a usable database, not a wedged one: the retry
      // that a redelivery would bring is a clean first append.
      const retry = await journal.appendEnvelope(envelopeRecord());
      expect(retry.created).toBe(true);
      expect(countRows(storeDir, 'journal_envelope')).toBe(1);
    });

    it('leaves no half-row across a reopen either — the rollback is on disk, not just in memory', async () => {
      const storeDir = await tmpStore();
      const journal = build(storeDir, { faults: faultOnce('append:after-receipt') });

      await expect(journal.appendEnvelope(envelopeRecord())).rejects.toThrow(/injected fault/);
      await journal.close();

      const reopened = build(storeDir);
      expect(await reopened.listRecoverable()).toEqual([]);
      expect(countRows(storeDir, 'journal_envelope')).toBe(0);
    });

    it('refuses an oversized record instead of truncating it', async () => {
      const storeDir = await tmpStore();
      const journal = build(storeDir, { maxRecordBytes: 512 });

      const huge = 'x'.repeat(2_000);
      await expect(
        journal.appendEnvelope(envelopeRecord({ bytes: huge, bytesHash: journalHash(huge) })),
      ).rejects.toBeInstanceOf(JournalRecordTooLargeError);
      expect(countRows(storeDir, 'journal_envelope')).toBe(0);
    });

    it('refuses a task-opening envelope with no task identity', async () => {
      const storeDir = await tmpStore();
      const journal = build(storeDir);

      const record = envelopeRecord();
      const { taskId: _dropped, ...withoutTaskId } = record;
      await expect(journal.appendEnvelope(withoutTaskId as ReceivedEnvelopeRecord)).rejects.toThrow(/opensTask/);
    });
  });

  describe('restart', () => {
    it('recovers everything it committed after a clean close and reopen', async () => {
      const storeDir = await tmpStore();
      const first = build(storeDir);
      await first.appendEnvelope(envelopeRecord());
      await first.recordAdmission({ taskId: 'task-1', admitted: true, claimedRuntime: 'claude', decidedAt: '2026-08-07T00:00:01.000Z' });
      await first.close();

      const second = build(storeDir);
      const recoverable = await second.listRecoverable();

      expect(recoverable).toHaveLength(1);
      expect(recoverable[0]).toMatchObject({ taskId: 'task-1', envelopeId: 'env-1', seq: 1, localState: 'admitted', claimedRuntime: 'claude' });
      expect(recoverable[0]?.identity).toEqual(IDENTITY);
    });

    it('recovers everything it committed when the instance is DROPPED with no close at all', async () => {
      const storeDir = await tmpStore();
      // Deliberately not registered for teardown-close: the point is a process
      // that died holding this handle, so nothing here gets to run a shutdown
      // path. `synchronous=FULL` is what makes the committed rows survive that.
      const abandoned = new SqliteLocalTaskJournal({ storeDir });
      await abandoned.appendEnvelope(envelopeRecord());
      await abandoned.recordTransition({ transitionId: 'tr-1', taskId: 'task-1', to: 'Running', occurredAt: '2026-08-07T00:00:02.000Z' });

      const reopened = build(storeDir);
      const recoverable = await reopened.listRecoverable();

      expect(recoverable).toHaveLength(1);
      expect(recoverable[0]?.localState).toBe('Running');
      expect(countRows(storeDir, 'journal_transition')).toBe(1);
    });
  });

  describe('idempotency beyond the envelope', () => {
    it('records a transition once per transition id, and never drags local state backwards on a replay', async () => {
      const storeDir = await tmpStore();
      const journal = build(storeDir);
      await journal.appendEnvelope(envelopeRecord());

      await journal.recordTransition({ transitionId: 'tr-1', taskId: 'task-1', to: 'Claimed', occurredAt: '2026-08-07T00:00:01.000Z' });
      await journal.recordTransition({ transitionId: 'tr-2', taskId: 'task-1', from: 'Claimed', to: 'Running', occurredAt: '2026-08-07T00:00:02.000Z' });
      // The replay: an old transition arriving again (recovery re-walking a
      // stored sequence, or a redelivered envelope driving the same move).
      await journal.recordTransition({ transitionId: 'tr-1', taskId: 'task-1', to: 'Claimed', occurredAt: '2026-08-07T00:00:03.000Z' });

      expect(countRows(storeDir, 'journal_transition')).toBe(2);
      expect((await journal.listRecoverable())[0]?.localState).toBe('Running');
    });

    it('keeps the FIRST terminal and folds a same-hash retry into retry state only', async () => {
      const storeDir = await tmpStore();
      const journal = build(storeDir);
      await journal.appendEnvelope(envelopeRecord());

      await journal.recordTerminal({
        taskId: 'task-1',
        terminalType: 'complete',
        payloadHash: journalHash('first'),
        truthState: 'pending',
        attempt: 1,
        recordedAt: '2026-08-07T00:00:05.000Z',
      });
      await journal.recordTerminal({
        taskId: 'task-1',
        terminalType: 'complete',
        payloadHash: journalHash('first'),
        truthState: 'confirmed',
        attempt: 2,
        recordedAt: '2026-08-07T00:00:06.000Z',
      });
      // A DIFFERENT terminal for a task that already has one: first fact wins,
      // exactly as the cloud's own receipt does.
      await journal.recordTerminal({
        taskId: 'task-1',
        terminalType: 'failed',
        payloadHash: journalHash('second'),
        truthState: 'pending',
        attempt: 1,
        recordedAt: '2026-08-07T00:00:07.000Z',
      });

      const [terminal] = readRows(storeDir, 'SELECT * FROM journal_terminal');
      expect(countRows(storeDir, 'journal_terminal')).toBe(1);
      expect(terminal?.terminal_type).toBe('complete');
      expect(terminal?.payload_hash).toBe(journalHash('first'));
      expect(terminal?.truth_state).toBe('confirmed');
      expect(Number(terminal?.attempt)).toBe(2);
      // A task with a terminal is no longer "in the middle of something".
      expect(await journal.listRecoverable()).toEqual([]);
    });

    it('refuses a transition or terminal for a task it has no row for', async () => {
      const storeDir = await tmpStore();
      const journal = build(storeDir);

      await expect(
        journal.recordTransition({ transitionId: 'tr-x', taskId: 'ghost', to: 'Running', occurredAt: '2026-08-07T00:00:00.000Z' }),
      ).rejects.toBeInstanceOf(JournalUnknownTaskError);
      await expect(
        journal.recordTerminal({ taskId: 'ghost', terminalType: 'complete', payloadHash: journalHash('x'), truthState: 'pending', attempt: 1, recordedAt: '2026-08-07T00:00:00.000Z' }),
      ).rejects.toBeInstanceOf(JournalUnknownTaskError);
    });
  });

  describe('recovery markers', () => {
    it('takes a task out of the recoverable set without deleting it, and keeps the FIRST decision', async () => {
      const storeDir = await tmpStore();
      const journal = build(storeDir);
      await journal.appendEnvelope(envelopeRecord());

      await journal.markRecovered('task-1', { disposition: 'interrupted', reason: 'daemon restarted', occurredAt: '2026-08-07T00:01:00.000Z' });
      await journal.markRecovered('task-1', { disposition: 'abandoned', reason: 'second opinion', occurredAt: '2026-08-07T00:02:00.000Z' });

      expect(await journal.listRecoverable()).toEqual([]);
      // The row is still there — §12.7.2.1 forbids auto-deleting a
      // recovery-marked record — and it still says what the first pass decided.
      const [task] = readRows(storeDir, 'SELECT task_id, recovery_marker FROM journal_task');
      expect(task?.task_id).toBe('task-1');
      expect(JSON.parse(task?.recovery_marker as string)).toMatchObject({ disposition: 'interrupted', reason: 'daemon restarted' });
    });

    it('leaves a declined task out of the recoverable set', async () => {
      const storeDir = await tmpStore();
      const journal = build(storeDir);
      await journal.appendEnvelope(envelopeRecord());
      await journal.recordAdmission({ taskId: 'task-1', admitted: false, reason: 'no capable runtime', retryable: true, decidedAt: '2026-08-07T00:00:01.000Z' });

      expect(await journal.listRecoverable()).toEqual([]);
      expect(countRows(storeDir, 'journal_task')).toBe(1);
    });
  });

  describe('corrupt database quarantine', () => {
    it('moves the unreadable file aside with a manifest and fails closed, rebuilding nothing', async () => {
      const storeDir = await tmpStore();
      const dbPath = path.join(storeDir, JOURNAL_DB_FILENAME);
      writeFileSync(dbPath, 'this is definitively not a sqlite database');

      let thrown: unknown;
      try {
        new SqliteLocalTaskJournal({ storeDir });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(JournalCorruptError);

      // Nothing was rebuilt in its place: an empty journal reporting "no
      // recoverable tasks" is the silent failure this path exists to prevent.
      await expect(fs.access(dbPath)).rejects.toThrow();

      const quarantined = await fs.readdir(path.join(storeDir, JOURNAL_QUARANTINE_DIRNAME));
      const manifestName = quarantined.find((name) => name.endsWith('.manifest.json'));
      expect(manifestName).toBeDefined();
      const dbCopy = quarantined.find((name) => name.endsWith(JOURNAL_DB_FILENAME));
      expect(dbCopy).toBeDefined();

      // The evidence survived byte-for-byte.
      const preserved = await fs.readFile(path.join(storeDir, JOURNAL_QUARANTINE_DIRNAME, dbCopy ?? ''), 'utf8');
      expect(preserved).toBe('this is definitively not a sqlite database');

      const manifest = JSON.parse(
        await fs.readFile(path.join(storeDir, JOURNAL_QUARANTINE_DIRNAME, manifestName ?? ''), 'utf8'),
      ) as { reason: string; originalPath: string; files: string[]; quarantinedAt: string };
      expect(manifest.originalPath).toBe(dbPath);
      expect(manifest.reason).toBeTruthy();
      expect(manifest.files.length).toBeGreaterThan(0);
      expect(Date.parse(manifest.quarantinedAt)).not.toBeNaN();
    });

    it('does not overwrite an earlier quarantine when it happens again in the same millisecond', async () => {
      const storeDir = await tmpStore();
      const dbPath = path.join(storeDir, JOURNAL_DB_FILENAME);
      // A frozen clock is exactly the restart-loop-against-a-corrupt-file case:
      // every attempt stamps the same instant.
      const clock = () => new Date('2026-08-07T00:00:00.000Z');

      for (const contents of ['first corruption', 'second corruption']) {
        writeFileSync(dbPath, contents);
        expect(() => new SqliteLocalTaskJournal({ storeDir, clock })).toThrow(JournalCorruptError);
      }

      const quarantined = (await fs.readdir(path.join(storeDir, JOURNAL_QUARANTINE_DIRNAME))).filter((name) =>
        name.endsWith(JOURNAL_DB_FILENAME),
      );
      expect(quarantined).toHaveLength(2);
    });
  });

  describe('storage accounting and maintenance', () => {
    it('reports the five categories separately, measuring its own two', async () => {
      const storeDir = await tmpStore();
      const journal = build(storeDir);
      await journal.appendEnvelope(envelopeRecord());

      const usage = await journal.measureUsage();

      expect(Object.keys(usage.categories).sort()).toEqual(['cache', 'journal', 'log', 'quarantine', 'workspace']);
      expect(usage.categories.journal.bytes).toBeGreaterThan(0);
      expect(usage.categories.journal.approximate).toBe(false);
      // Nothing has reported these, so they say so rather than guessing.
      expect(usage.categories.cache).toEqual({ bytes: 0, approximate: true });
      expect(usage.totalBytes).toBe(
        Object.values(usage.categories).reduce((sum, category) => sum + category.bytes, 0),
      );

      await journal.reportCategoryUsage('cache', { bytes: 4_096, approximate: true });
      expect((await journal.measureUsage()).categories.cache).toEqual({ bytes: 4_096, approximate: true });
    });

    it('hands out only eligible cleanup candidates, and keeps a failed one eligible', async () => {
      const storeDir = await tmpStore();
      const journal = build(storeDir);

      await journal.enqueueCleanupCandidate({ candidateId: 'c1', category: 'expired-temp', ref: '/tmp/a', eligibleAt: '2026-08-07T00:00:00.000Z', reason: 'expired' });
      await journal.enqueueCleanupCandidate({ candidateId: 'c2', category: 'rotated-log', ref: '/tmp/b.log', eligibleAt: '2026-09-01T00:00:00.000Z', reason: 'rotated' });

      const now = new Date('2026-08-08T00:00:00.000Z');
      expect((await journal.listCleanupCandidates(now, 10)).map((c) => c.candidateId)).toEqual(['c1']);

      await journal.markCleanupResult({ candidateId: 'c1', outcome: 'failed', error: 'EBUSY', at: '2026-08-08T00:00:01.000Z' });
      const afterFailure = await journal.listCleanupCandidates(now, 10);
      expect(afterFailure.map((c) => c.candidateId)).toEqual(['c1']);
      expect(afterFailure[0]).toMatchObject({ attempts: 1, lastError: 'EBUSY' });

      await journal.markCleanupResult({ candidateId: 'c1', outcome: 'deleted', bytesReclaimed: 10, at: '2026-08-08T00:00:02.000Z' });
      expect(await journal.listCleanupCandidates(now, 10)).toEqual([]);
    });

    it('checkpoints the WAL and returns a bounded, honest result', async () => {
      const storeDir = await tmpStore();
      const journal = build(storeDir);
      for (let i = 0; i < 20; i += 1) {
        const bytes = JSON.stringify({ v: 1, id: `env-${i}`, type: 'task.offer', task_id: `task-${i}` });
        await journal.appendEnvelope(envelopeRecord({ envelopeId: `env-${i}`, taskId: `task-${i}`, seq: i, bytes, bytesHash: journalHash(bytes) }));
      }

      const result = await journal.compact({ checkpoint: 'truncate', incrementalVacuumPages: 32 });

      expect(result.checkpointed).toBe(true);
      expect(result.walFramesRemaining).toBe(0);
      expect(result.pagesVacuumed).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('path handling', () => {
    it('works under a store directory whose name would break naive Windows path handling', async () => {
      // Spaces, parentheses, a hash, an ampersand and non-ASCII: the shapes a
      // real `%LOCALAPPDATA%\<Product Name (Beta)>` path actually carries, and
      // the ones an unquoted/naively-concatenated path breaks on. Same intent
      // as the win32 coverage in `secure-dir.test.ts`: exercise the shape from
      // whatever host is running the suite.
      const base = await tmpStore();
      const storeDir = path.join(base, 'Product Name (Beta) #2 & 存储');
      const journal = build(storeDir);

      const receipt = await journal.appendEnvelope(envelopeRecord());
      expect(receipt.created).toBe(true);
      await journal.close();

      const reopened = build(storeDir);
      expect(await reopened.listRecoverable()).toHaveLength(1);
    });
  });
});
