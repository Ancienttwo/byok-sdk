/**
 * The embedded SQLite activity log is durable (#1113 A2b): a cursor read
 * before a restart resumes after it, an active task has no idle expiry, a
 * refused entry changes nothing, and archive removes content behind a gap.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { contentHash, createMutableClock, tenantId, type MutableClock } from '@byok-sdk/core';
import { createWebCrypto, type ActivityAppendInput, type ActivityCursor, type ActivityTail, type TaskRedactionCodec } from '@byok-sdk/cloud';
import { isSqliteAvailable } from '../sqlite-support';
import { createSqliteEmbeddedStores } from '../stores/sqlite';
import { SqliteActivityStore } from '../stores/sqlite/activity';

const describeSqlite = (isSqliteAvailable() || process.env.BYOK_REQUIRE_SQLITE === '1') ? describe : describe.skip;
const TENANT = tenantId('sqlite-activity-restart');
const TASK = 'task';
const TERMINAL_KEY = `task:${TASK}:terminal`;

const codec: TaskRedactionCodec = {
  async tombstone(body) {
    const tombstone = `{"byokRedacted":1,"bytes":${String(body.length)}}`;
    return { body: tombstone, bodyHash: contentHash(`sha256:${'0'.repeat(64)}`), byteSize: BigInt(tombstone.length) };
  },
  absent: '{"byokRedacted":1,"absent":true}',
  isTombstone: (body) => body.startsWith('{"byokRedacted":1,'),
  blobHashes: () => [],
};

function batch(id: number, extra: Partial<ActivityAppendInput> = {}): ActivityAppendInput {
  return { taskId: TASK, sourceEnvelopeId: `source-${id}`, batchSeq: id, events: [{ type: 'progress', text: `${id}` }], dropped: 0, ttlMs: 600_000, ...extra } as ActivityAppendInput;
}

describeSqlite('SQLite durable activity log across restarts (#1113)', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function database(): { readonly path: string; readonly clock: MutableClock; open(): ReturnType<typeof createSqliteEmbeddedStores> } {
    const directory = mkdtempSync(join(tmpdir(), 'byok-sqlite-activity-restart-'));
    directories.push(directory);
    const path = join(directory, 'server.sqlite');
    const clock = createMutableClock(new Date('2026-11-01T00:00:00.000Z'));
    return { path, clock, open: () => createSqliteEmbeddedStores({ path }, { clock, crypto: createWebCrypto() }) };
  }

  function rows(path: string): { readonly heads: unknown[]; readonly entries: unknown[] } {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return {
        heads: db.prepare('SELECT * FROM activity_log_head ORDER BY task_id').all(),
        entries: db.prepare('SELECT * FROM activity_log_entry ORDER BY task_id, revision').all(),
      };
    } finally {
      db.close();
    }
  }

  it('resumes an earlier cursor after a restart with only later entries in the same generation', async () => {
    const { open } = database();
    const first = open();
    expect(first.cloud.activity).toBeInstanceOf(SqliteActivityStore);
    let cursor!: ActivityCursor;
    try {
      const one = await first.cloud.activity.append(TENANT, batch(1));
      cursor = one.cursor;
      await first.cloud.activity.append(TENANT, batch(2));
    } finally {
      await first.close();
    }

    const second = open();
    try {
      const page = (await second.cloud.activity.read(TENANT, TASK, { after: cursor }))!;
      expect(page.entries.map((entry) => [entry.revision, entry.sourceEnvelopeId])).toEqual([[2, 'source-2']]);
      const { generation } = cursor;
      expect(page.cursor).toMatchObject({ generation, revision: 2 });
      expect(page.after).toBe(1);
      // A replay of an envelope admitted before the restart stays idempotent.
      await expect(second.cloud.activity.append(TENANT, batch(1))).resolves.toMatchObject({ cursor: { generation, revision: 2 } });
      await expect(second.cloud.activity.append(TENANT, batch(3))).resolves.toMatchObject({ cursor: { generation, revision: 3 } });
    } finally {
      await second.close();
    }
  });

  it('keeps a quiet active task past ten minutes, across a restart', async () => {
    const { open, clock } = database();
    const first = open();
    let tail!: ActivityTail;
    try {
      tail = await first.cloud.activity.append(TENANT, batch(1));
    } finally {
      await first.close();
    }
    clock.advance(11 * 60_000);
    const second = open();
    try {
      await expect(second.cloud.activity.collectExpired(TENANT, { now: clock.now().toISOString(), limit: 10 }))
        .resolves.toMatchObject({ removed: 0, more: false });
      expect(await second.cloud.activity.read(TENANT, TASK)).toEqual(tail);
    } finally {
      await second.close();
    }
  });

  it('refuses an oversized entry without changing the revision or any row', async () => {
    const { open, path } = database();
    const stores = open();
    const large = (id: number) => batch(id, { byteCapacity: 1_000, events: [{ type: 'progress', text: 'x'.repeat(2_000) }] });
    let tail!: ActivityTail;
    try {
      await expect(stores.cloud.activity.append(TENANT, large(1))).rejects.toMatchObject({ code: 'activity_batch_too_large' });
      await expect(stores.cloud.activity.read(TENANT, TASK)).resolves.toBeUndefined();
      tail = await stores.cloud.activity.append(TENANT, batch(1, { byteCapacity: 1_000 }));
    } finally {
      await stores.close();
    }
    const before = rows(path);
    expect(before.entries).toHaveLength(1);
    const reopened = open();
    try {
      await expect(reopened.cloud.activity.append(TENANT, large(2))).rejects.toMatchObject({ code: 'activity_batch_too_large' });
      expect(await reopened.cloud.activity.read(TENANT, TASK)).toEqual(tail);
    } finally {
      await reopened.close();
    }
    expect(rows(path)).toEqual(before);
  });

  it('archive removes content behind a history gap and refuses later output, across a restart', async () => {
    const { open, path, clock } = database();
    const stores = open();
    let cursor!: ActivityCursor;
    try {
      await stores.cloud.tasks.open(TENANT, { taskId: TASK, deviceId: 'device' });
      cursor = (await stores.cloud.activity.append(TENANT, batch(1))).cursor;
      await stores.cloud.activity.append(TENANT, batch(2));
      await stores.cloud.tasks.recordStatus(TENANT, { taskId: TASK, status: 'complete' });
      await expect(stores.cloud.taskArchive.archive(TENANT, {
        taskId: TASK, receiptKeys: [TERMINAL_KEY], terminalReceiptKey: TERMINAL_KEY, releaseObjectReferences: [],
        archivedAt: clock.now().toISOString(), codec,
      })).resolves.toMatchObject({ outcome: 'archived', counts: { ephemeralRowsDeleted: 1 } });
      await expect(stores.cloud.activity.read(TENANT, TASK, { after: cursor })).rejects.toMatchObject({ code: 'activity_history_gap' });
      await expect(stores.cloud.activity.append(TENANT, batch(3))).rejects.toMatchObject({ code: 'activity_history_gap' });
    } finally {
      await stores.close();
    }

    const stored = rows(path);
    expect(stored.heads).toEqual([expect.objectContaining({ task_id: TASK, removed: 1, revision: 2, floor: 2, retained_bytes: 0 })]);
    expect(stored.entries).toEqual([
      expect.objectContaining({ revision: 1, body: null, byte_size: 0 }),
      expect.objectContaining({ revision: 2, body: null, byte_size: 0 }),
    ]);

    const reopened = open();
    try {
      await expect(reopened.cloud.activity.read(TENANT, TASK)).resolves.toBeUndefined();
      await expect(reopened.cloud.activity.read(TENANT, TASK, { after: cursor })).rejects.toMatchObject({ code: 'activity_history_gap' });
      // Neither a replayed nor a new envelope recreates removed history.
      await expect(reopened.cloud.activity.append(TENANT, batch(1))).rejects.toMatchObject({ code: 'activity_history_gap' });
      await expect(reopened.cloud.activity.append(TENANT, batch(3))).rejects.toMatchObject({ code: 'activity_history_gap' });
    } finally {
      await reopened.close();
    }
  });
});
