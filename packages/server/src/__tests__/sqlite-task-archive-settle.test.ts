/**
 * The embedded SQLite composition keeps activity and Agent message drafts in
 * memory, outside the archive transaction (#1120). A rollback of that
 * transaction must leave them in place, and `settle` removes them once the
 * archive committed: a failure inside `settle` is finished by the next call.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { contentHash, createMutableClock, tenantId } from '@byok-sdk/core';
import { createWebCrypto, type TaskArchiveStoreInput, type TaskRedactionCodec } from '@byok-sdk/cloud';
import { isSqliteAvailable } from '../sqlite-support';
import { createSqliteEmbeddedStores } from '../stores/sqlite';

const describeSqlite = (isSqliteAvailable() || process.env.BYOK_REQUIRE_SQLITE === '1') ? describe : describe.skip;
const TENANT = tenantId('sqlite-archive-settle');
const TASK = 'task';
const TERMINAL_KEY = `task:${TASK}:terminal`;
const TERMINAL_BODY = '{"type":"task.complete","canary":"original"}';
const AGENT_REF = { agentId: 'agent', profileRevision: '1' };
const FAILING = '2026-10-27T00:00:00.000Z';
const LATER = '2026-10-27T00:00:01.000Z';

/** The store applies whatever codec cloud passes; this one keeps the assertions readable. */
const codec: TaskRedactionCodec = {
  async tombstone(body) {
    const tombstone = `{"byokRedacted":1,"bytes":${String(body.length)}}`;
    return { body: tombstone, bodyHash: contentHash(`sha256:${'0'.repeat(64)}`), byteSize: BigInt(tombstone.length) };
  },
  absent: '{"byokRedacted":1,"absent":true}',
  isTombstone: (body) => body.startsWith('{"byokRedacted":1,'),
  blobHashes: () => [],
};

describeSqlite('SQLite terminal-task archive and its in-memory rows (#1120)', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('keeps the rows through a rolled-back archive and removes them in an idempotent settle', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-sqlite-archive-settle-'));
    directories.push(directory);
    const path = join(directory, 'server.sqlite');
    const clock = createMutableClock(new Date('2026-10-27T00:00:00.000Z'));
    const crypto = createWebCrypto();
    await createSqliteEmbeddedStores({ path }, { clock, crypto }).close();
    const raw = new DatabaseSync(path);
    // The store holds the file while open, so each trigger fails only one instant.
    raw.exec(`CREATE TRIGGER archive_fail BEFORE UPDATE OF archived_at ON task_attempt WHEN NEW.archived_at = '${FAILING}'
      BEGIN SELECT RAISE(ABORT, 'archive update failed'); END;`);
    raw.exec(`CREATE TRIGGER settle_fail BEFORE UPDATE OF archive_settled_at ON task_attempt WHEN NEW.archive_settled_at = '${FAILING}'
      BEGIN SELECT RAISE(ABORT, 'settle update failed'); END;`);
    raw.close();

    const stores = createSqliteEmbeddedStores({ path }, { clock, crypto });
    const { tasks, receipts, activity, agentMessageDraft, taskArchive } = stores.cloud;
    const archived = async () => (await tasks.get(TENANT, TASK))?.archivedAt;
    const input = (archivedAt: string): TaskArchiveStoreInput => ({
      taskId: TASK, receiptKeys: [TERMINAL_KEY], terminalReceiptKey: TERMINAL_KEY, releaseObjectReferences: [], archivedAt, codec,
    });
    const work = () => taskArchive.listWork(TENANT, { archiveBefore: LATER, limit: 10 });
    try {
      await tasks.open(TENANT, { taskId: TASK, deviceId: 'device' });
      await tasks.recordStatus(TENANT, { taskId: TASK, status: 'complete' });
      await receipts.record(TENANT, { key: TERMINAL_KEY, body: TERMINAL_BODY });
      await activity.append(TENANT, { taskId: TASK, sourceEnvelopeId: 'source', batchSeq: 1,
        events: [{ type: 'progress', text: 'kept until settled' }], dropped: 0, ttlMs: 300_000 });
      expect(await agentMessageDraft.apply(TENANT, { taskId: TASK, deviceId: 'device', agentRef: AGENT_REF, revision: 1,
        offset: 0, text: 'draft', maxBytes: 16, now: clock.now().toISOString() })).toBe('applied');

      // The last statement of the archive fails: nothing it did stays.
      await expect(taskArchive.archive(TENANT, input(FAILING))).rejects.toThrow('archive update failed');
      expect(await archived()).toBeUndefined();
      expect((await receipts.get(TENANT, TERMINAL_KEY))?.body).toBe(TERMINAL_BODY);
      expect(await activity.read(TENANT, TASK)).toBeDefined();
      expect(await agentMessageDraft.read(TENANT, TASK)).toBeDefined();
      // Settling a task that is not archived does nothing.
      await taskArchive.settle(TENANT, TASK, LATER);
      expect(await activity.read(TENANT, TASK)).toBeDefined();

      await expect(taskArchive.archive(TENANT, input(LATER))).resolves.toMatchObject({ outcome: 'archived' });
      expect(await archived()).toBe(LATER);
      expect(await activity.read(TENANT, TASK)).toBeDefined();
      expect(await work()).toEqual([expect.objectContaining({ taskId: TASK, phase: 'settle' })]);

      // Settle removes the rows, then fails to record itself; the next call finishes.
      await expect(taskArchive.settle(TENANT, TASK, FAILING)).rejects.toThrow('settle update failed');
      expect(await activity.read(TENANT, TASK)).toBeUndefined();
      expect(await agentMessageDraft.read(TENANT, TASK)).toBeUndefined();
      expect(await work()).toEqual([expect.objectContaining({ taskId: TASK, phase: 'settle' })]);
      await taskArchive.settle(TENANT, TASK, LATER);
      await taskArchive.settle(TENANT, TASK, LATER);
      expect(await work()).toEqual([]);
      expect(await activity.read(TENANT, TASK)).toBeUndefined();
    } finally {
      await stores.close();
    }
  });
});
