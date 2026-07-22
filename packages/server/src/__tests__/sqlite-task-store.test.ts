import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createByokServer } from '../index';
import { ensureAdditiveColumns, SqliteTaskStore } from '../sqlite-task-store';
import { isSqliteAvailable, openSqliteDatabase } from '../sqlite-support';
import { IllegalTaskTransitionError } from '../task-store';

// node:sqlite requires Node 22.5+, and shipped behind --experimental-sqlite
// until later in the 22.x line — so "Node >= 22.5" alone doesn't mean the
// module actually loads. Gate on ACTUAL availability (attempts the real
// require — see sqlite-support.ts's isSqliteAvailable), not a version-number
// heuristic, so this correctly skips on any runtime where node:sqlite isn't
// really usable (the CI Node 20 leg, or an intermediate flagged 22.x) and
// still runs on one where it is.
const sqliteReady = isSqliteAvailable();

function tempDbPath(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return path.join(dir, 'tasks.db');
}

function createTask(store: SqliteTaskStore, taskId = 'task_1') {
  return store.create({
    taskId,
    instruction: 'do the thing',
    policy: { mode: 'confirm', allowTools: ['read_file'] },
    deviceId: 'dev_1',
    sessionRef: 'session-abc',
  });
}

describe.skipIf(!sqliteReady)('SqliteTaskStore', () => {
  it('creates a task in the Offered state (same contract as InMemoryTaskStore)', () => {
    const store = new SqliteTaskStore({ path: ':memory:' });
    const record = createTask(store);

    expect(record.state).toBe('Offered');
    expect(store.get('task_1')).toEqual(record);
    expect(store.list()).toEqual([record]);
    store.close();
  });

  it('returns undefined for an unknown taskId', () => {
    const store = new SqliteTaskStore({ path: ':memory:' });
    expect(store.get('nope')).toBeUndefined();
    store.close();
  });

  it('walks the full happy path Offered -> Claimed -> Running -> Complete, persisting the result', () => {
    const store = new SqliteTaskStore({ path: ':memory:' });
    createTask(store);

    store.transition('task_1', 'Claimed');
    store.transition('task_1', 'Running');
    const done = store.transition('task_1', 'Complete', {
      result: { state: 'Complete', summary: 'ok', artifactRefs: [] },
    });

    expect(done.state).toBe('Complete');
    expect(done.result).toEqual({ state: 'Complete', summary: 'ok', artifactRefs: [] });
    store.close();
  });

  it('rejects an illegal transition (Offered -> Running skips Claimed)', () => {
    const store = new SqliteTaskStore({ path: ':memory:' });
    createTask(store);

    expect(() => store.transition('task_1', 'Running')).toThrow(IllegalTaskTransitionError);
    expect(store.get('task_1')?.state).toBe('Offered');
    store.close();
  });

  it('throws transitioning an unknown taskId, same message shape as InMemoryTaskStore', () => {
    const store = new SqliteTaskStore({ path: ':memory:' });
    expect(() => store.transition('missing', 'Claimed')).toThrow(/unknown taskId/);
    store.close();
  });

  it('compare-and-set prevents a lost update: two stores racing on the same Running task — exactly one transition wins, the other is rejected against the state that actually won (no terminal -> terminal)', () => {
    const dbPath = tempDbPath('byok-sqlite-task-cas-race-');

    const storeA = new SqliteTaskStore({ path: dbPath });
    const storeB = new SqliteTaskStore({ path: dbPath });
    createTask(storeA);
    storeA.transition('task_1', 'Claimed');
    storeA.transition('task_1', 'Running');

    // Force the exact race a pre-CAS unconditional UPDATE was vulnerable to,
    // deterministically. `transition()` starts with `this.get(taskId)`; a
    // real race is "two connections both read Running, both validate a
    // different target, both write" — reproduced here by splicing storeB's
    // FULL, independent `Running -> Failed` transition in between storeA's
    // read and storeA's write: storeA's `get` is called first (capturing a
    // `Running` snapshot), then storeB commits `Failed` on the real
    // database, then the stale `Running` snapshot is handed back to
    // storeA's `transition`, exactly as if a second process had committed
    // between storeA's read and its write.
    const originalGet = storeA.get.bind(storeA);
    let intercepted = false;
    (storeA as unknown as { get: SqliteTaskStore['get'] }).get = (taskId: string) => {
      const record = originalGet(taskId);
      if (!intercepted) {
        intercepted = true;
        storeB.transition(taskId, 'Failed'); // the "concurrent" writer commits first
      }
      return record; // stale snapshot captured before storeB's write
    };

    // Pre-fix, this would have silently succeeded (unconditional UPDATE),
    // performing an illegal Failed -> Complete transition under the hood.
    // Post-fix, the CAS write affects 0 rows (the real state is now
    // Failed), so transition() re-reads, sees Failed, and rejects Complete.
    expect(() => storeA.transition('task_1', 'Complete')).toThrow(IllegalTaskTransitionError);

    // No lost update: the row reflects storeB's committed write, not
    // silently clobbered by storeA's stale Complete attempt.
    expect(storeA.get('task_1')?.state).toBe('Failed');

    storeA.close();
    storeB.close();
  });

  /**
   * S3 (cross-model review finding, P1): `setPendingApprovalId`'s UPDATE was
   * unconditional (no state predicate) — a laggard writer (e.g. a
   * delayed/queued `task.await_approval` processed after the task already
   * left `AwaitApproval` via a real `approveTask`/`rejectTask` elsewhere)
   * could resurrect a pending id for a task that has already moved on.
   * Fixed with a `WHERE ... AND state = 'AwaitApproval'` CAS predicate on
   * `updatePendingApprovalIdStmt` — mirrored in `InMemoryTaskStore` for
   * symmetry (`task-store.test.ts`'s own sibling test).
   */
  it('setPendingApprovalId is a no-op once the task has left AwaitApproval — the stored record is unchanged', () => {
    const store = new SqliteTaskStore({ path: ':memory:' });
    createTask(store);
    store.transition('task_1', 'Claimed');
    store.transition('task_1', 'Running');
    store.transition('task_1', 'AwaitApproval');
    store.setPendingApprovalId('task_1', 'appr-1');

    store.transition('task_1', 'Running'); // leaves AwaitApproval
    // transition() itself doesn't clear pendingApprovalId (that policy lives
    // one layer up, in hub.ts's transitionTask) — sanity check this test
    // starts from the state it claims to.
    expect(store.get('task_1')?.pendingApprovalId).toBe('appr-1');

    const result = store.setPendingApprovalId('task_1', 'appr-2');

    expect(result?.pendingApprovalId).toBe('appr-1'); // rejected — the write did not apply
    expect(store.get('task_1')?.pendingApprovalId).toBe('appr-1'); // stored record unchanged
    expect(store.get('task_1')?.state).toBe('Running');
    store.close();
  });

  it('recovers a task’s full record after being reopened on the same database file (record persistence — not live task reconnection; see SqliteTaskStore doc comment)', () => {
    const dbPath = tempDbPath('byok-sqlite-task-restart-');

    const storeA = new SqliteTaskStore({ path: dbPath });
    createTask(storeA);
    storeA.transition('task_1', 'Claimed', { deviceId: 'dev_1' });
    storeA.transition('task_1', 'Running');
    const beforeClose = storeA.transition('task_1', 'AwaitApproval');
    storeA.close(); // simulates the process exiting

    // A brand-new instance, constructed fresh against the same file — no
    // state is shared in memory between storeA and storeB.
    const storeB = new SqliteTaskStore({ path: dbPath });
    const recovered = storeB.get('task_1');

    expect(recovered).toEqual(beforeClose);
    expect(recovered?.state).toBe('AwaitApproval');
    expect(recovered?.instruction).toBe('do the thing');
    expect(recovered?.policy).toEqual({ mode: 'confirm', allowTools: ['read_file'] });
    expect(recovered?.deviceId).toBe('dev_1');
    expect(recovered?.sessionRef).toBe('session-abc');
    expect(storeB.list()).toEqual([beforeClose]);

    // storeB is fully live post-recovery, not just readable: resume the
    // AwaitApproval <-> Running loop and finish the task through it.
    const resumed = storeB.transition('task_1', 'Running');
    expect(resumed.state).toBe('Running');
    const done = storeB.transition('task_1', 'Complete', { result: { state: 'Complete', summary: 'done after restart' } });
    expect(done.result).toEqual({ state: 'Complete', summary: 'done after restart' });

    // And the recovered store still enforces the state machine correctly.
    expect(() => storeB.transition('task_1', 'Running')).toThrow(IllegalTaskTransitionError);
    storeB.close();
  });

  it('recovers multiple tasks in creation order after reopening', () => {
    const dbPath = tempDbPath('byok-sqlite-task-multi-');

    const storeA = new SqliteTaskStore({ path: dbPath });
    createTask(storeA, 'task_1');
    createTask(storeA, 'task_2');
    createTask(storeA, 'task_3');
    storeA.transition('task_2', 'Claimed', { deviceId: 'dev_1' });
    storeA.close();

    const storeB = new SqliteTaskStore({ path: dbPath });
    const ids = storeB.list().map((t) => t.taskId);
    expect(ids).toEqual(['task_1', 'task_2', 'task_3']);
    expect(storeB.get('task_2')?.state).toBe('Claimed');
    storeB.close();
  });

  /**
   * M5 (approval targeting): this repo has no migration machinery — every
   * table is `CREATE TABLE IF NOT EXISTS` only, which is a no-op against a
   * database file an OLDER version of this store already created. This test
   * builds exactly that: a `tasks` table using the PRE-M5 column set (no
   * `pending_approval_id` at all — the literal old `CREATE TABLE` SQL, not
   * just a subset of the new one), with an existing row already committed
   * to it, then opens it with the CURRENT `SqliteTaskStore` and proves the
   * idempotent `ensureAdditiveColumns` migration hook adds the missing
   * column in place and the pre-existing row stays fully readable and
   * further-transitionable.
   */
  it('opens a database file created with the OLD (pre-M5) schema — missing pending_approval_id — and adds the column in place, keeping the existing row readable and usable', () => {
    const dbPath = tempDbPath('byok-sqlite-task-old-schema-');

    const oldDb = openSqliteDatabase(dbPath);
    oldDb.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id     TEXT PRIMARY KEY,
        state       TEXT NOT NULL,
        instruction TEXT NOT NULL,
        runtime     TEXT,
        policy_json TEXT NOT NULL,
        device_id   TEXT,
        session_ref TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        result_json TEXT
      );
    `);
    const now = new Date().toISOString();
    oldDb
      .prepare(
        `INSERT INTO tasks
           (task_id, state, instruction, runtime, policy_json, device_id, session_ref, created_at, updated_at, result_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('task_pre_m5', 'AwaitApproval', 'pre-existing row', null, JSON.stringify({ mode: 'confirm' }), 'dev_1', null, now, now, null);
    // Sanity: the OLD schema genuinely has no pending_approval_id column —
    // proves this test actually exercises the old shape, not a no-op.
    const oldColumns = (oldDb.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(oldColumns).not.toContain('pending_approval_id');
    oldDb.close();

    // Opening with the CURRENT store must not throw, must add the column,
    // and must keep the pre-existing row fully intact and readable.
    const store = new SqliteTaskStore({ path: dbPath });
    const inspectDb = openSqliteDatabase(dbPath);
    const newColumns = (inspectDb.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name);
    inspectDb.close();
    expect(newColumns).toContain('pending_approval_id');

    const recovered = store.get('task_pre_m5');
    expect(recovered?.state).toBe('AwaitApproval');
    expect(recovered?.instruction).toBe('pre-existing row');
    expect(recovered?.deviceId).toBe('dev_1');
    expect(recovered?.pendingApprovalId).toBeUndefined(); // NULL from the pre-existing row — read back as undefined

    // Fully usable afterward, not just readable: both the general
    // transition path and the narrow setPendingApprovalId path work against
    // this migrated row.
    const withApproval = store.setPendingApprovalId('task_pre_m5', 'appr-after-migration');
    expect(withApproval?.pendingApprovalId).toBe('appr-after-migration');
    // `transition()` at the store level just carries `pendingApprovalId`
    // through untouched when the caller's patch doesn't mention it (the
    // clearing-on-leaving-AwaitApproval POLICY lives one layer up, in
    // hub.ts's `transitionTask` — this proves the column round-trips
    // through a plain `transition()` call on the migrated row).
    const resumed = store.transition('task_pre_m5', 'Running');
    expect(resumed.pendingApprovalId).toBe('appr-after-migration');
    store.close();
  });

  /**
   * M5 (claimed runtime): the same `ensureAdditiveColumns` idempotent-
   * migration hook, exercised for a DB file ONE COLUMN behind the current
   * schema rather than fully pre-M5 — it already has `pending_approval_id`
   * (an existing deployment that already picked up the approval-targeting
   * work) but predates `claimed_runtime`. Proves the hook's per-column loop
   * adds exactly the missing one without disturbing a column that's already
   * there, and that the migrated row round-trips a `claimedRuntime` write
   * afterward through the ordinary `transition()` path (this field has no
   * dedicated `setClaimedRuntime`-style method — it's only ever written
   * alongside a real state transition, unlike `pendingApprovalId`).
   */
  it('opens a database file missing ONLY claimed_runtime (already has pending_approval_id) and adds just that column in place, keeping the existing row readable and usable', () => {
    const dbPath = tempDbPath('byok-sqlite-task-old-schema-claimed-runtime-');

    const oldDb = openSqliteDatabase(dbPath);
    oldDb.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id             TEXT PRIMARY KEY,
        state               TEXT NOT NULL,
        instruction         TEXT NOT NULL,
        runtime             TEXT,
        policy_json         TEXT NOT NULL,
        device_id           TEXT,
        session_ref         TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        result_json         TEXT,
        pending_approval_id TEXT
      );
    `);
    const now = new Date().toISOString();
    oldDb
      .prepare(
        `INSERT INTO tasks
           (task_id, state, instruction, runtime, policy_json, device_id, session_ref, created_at, updated_at, result_json, pending_approval_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('task_pre_claimed_runtime', 'Claimed', 'pre-existing row', 'pi', JSON.stringify({ mode: 'confirm' }), 'dev_1', null, now, now, null, null);
    // Sanity: this schema has pending_approval_id but genuinely no
    // claimed_runtime — proves the test exercises "one column behind", not
    // a no-op and not the fully-old shape the sibling test above covers.
    const oldColumns = (oldDb.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(oldColumns).toContain('pending_approval_id');
    expect(oldColumns).not.toContain('claimed_runtime');
    oldDb.close();

    const store = new SqliteTaskStore({ path: dbPath });
    const inspectDb = openSqliteDatabase(dbPath);
    const newColumns = (inspectDb.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name);
    inspectDb.close();
    expect(newColumns).toContain('pending_approval_id');
    expect(newColumns).toContain('claimed_runtime');

    const recovered = store.get('task_pre_claimed_runtime');
    expect(recovered?.state).toBe('Claimed');
    expect(recovered?.instruction).toBe('pre-existing row');
    expect(recovered?.runtime).toBe('pi'); // requested runtime — pre-existing column, untouched by this migration
    expect(recovered?.claimedRuntime).toBeUndefined(); // NULL from the pre-existing row — read back as undefined

    // Fully usable afterward: a plain transition() carries a claimedRuntime
    // patch through on the migrated row exactly like any other field.
    const resumed = store.transition('task_pre_claimed_runtime', 'Running', { claimedRuntime: 'pi' });
    expect(resumed.claimedRuntime).toBe('pi');
    expect(resumed.runtime).toBe('pi'); // requested field still untouched
    store.close();
  });

  /**
   * S5 (cross-model review finding, P2): two processes (or two
   * `SqliteTaskStore` instances) constructing against the same pre-existing
   * file at close to the same instant can both see an additive column
   * missing via `PRAGMA table_info` and both attempt the identical `ALTER
   * TABLE ... ADD COLUMN` — SQLite lets only one actually add it; the
   * loser's `db.exec` throws `duplicate column name`. Fixed by catching that
   * specific error inside `ensureAdditiveColumns`, re-inspecting `PRAGMA
   * table_info`, and proceeding once the column is confirmed present
   * (rethrowing anything else).
   *
   * Forces the exact race deterministically (mirrors this file's own
   * `compare-and-set` test above, which intercepts a method to splice a
   * "concurrent" writer's commit into a real gap): `db.exec` is patched so
   * that the FIRST time `ensureAdditiveColumns` attempts its own `ALTER
   * TABLE ADD COLUMN pending_approval_id`, a SECOND, independent connection
   * to the SAME file commits the identical `ALTER TABLE` first — simulating
   * "another process already won this exact race" — before the real `exec`
   * call proceeds and genuinely collides with it.
   */
  it('ensureAdditiveColumns tolerates losing a concurrent ALTER TABLE race — catches "duplicate column name" and proceeds once it re-confirms the column is actually there', () => {
    const dbPath = tempDbPath('byok-sqlite-task-additive-race-');
    const db = openSqliteDatabase(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id     TEXT PRIMARY KEY,
        state       TEXT NOT NULL,
        instruction TEXT NOT NULL,
        runtime     TEXT,
        policy_json TEXT NOT NULL,
        device_id   TEXT,
        session_ref TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        result_json TEXT
      );
    `);

    const realExec = db.exec.bind(db);
    let sabotaged = false;
    (db as unknown as { exec: typeof db.exec }).exec = ((sql: string) => {
      if (!sabotaged && sql.includes('ADD COLUMN pending_approval_id')) {
        sabotaged = true;
        const racingConnection = openSqliteDatabase(dbPath);
        racingConnection.exec('ALTER TABLE tasks ADD COLUMN pending_approval_id TEXT'); // the "other process" wins first
        racingConnection.close();
      }
      return realExec(sql);
    }) as typeof db.exec;

    // Pre-fix, the collision this sabotage engineers would propagate
    // uncaught out of ensureAdditiveColumns. Post-fix, it's caught,
    // re-confirmed, and swallowed.
    expect(() => ensureAdditiveColumns(db)).not.toThrow();

    const columns = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain('pending_approval_id'); // added by the "racing" connection, confirmed present by the catch handler
    expect(columns).toContain('claimed_runtime'); // the OTHER additive column, genuinely missing and un-raced, still added normally in the same pass
    db.close();
  });
});

describe.skipIf(!sqliteReady)('createByokServer({ taskStore: new SqliteTaskStore(...) }) task-record persistence across restart', () => {
  it('a second createByokServer instance on the same db file can read the task RECORD created by the first (record persistence only — no live device/runtime reconnection)', () => {
    const dbPath = tempDbPath('byok-sqlite-task-server-');

    const storeA = new SqliteTaskStore({ path: dbPath });
    const byokA = createByokServer({ productId: 'acme', taskStore: storeA });
    // No connected device is required to prove persistence of task state —
    // drive the same injected store `byokA.tasks` reads from, directly.
    const record = storeA.create({
      taskId: 'task_persist_1',
      instruction: 'survive a restart',
      policy: { mode: 'confirm' },
      deviceId: 'dev_1',
    });
    storeA.transition(record.taskId, 'Claimed', { deviceId: 'dev_1' });
    storeA.transition(record.taskId, 'Running');
    expect(byokA.tasks.get(record.taskId)?.state).toBe('Running');
    byokA.stop();
    storeA.close();

    // "Restart": a brand-new createByokServer backed by a brand-new
    // SqliteTaskStore instance, pointed at the exact same file. `byokB` has
    // no connected device and no live runtime for this task — it never had
    // one — so this proves the RECORD survived and is readable through a
    // fresh server, not that the task's in-flight connection came back.
    // There's nothing here to actually push a new event to this task or
    // resume its runtime; see `SqliteTaskStore`'s doc comment for why that's
    // explicitly out of scope for this reference store.
    const storeB = new SqliteTaskStore({ path: dbPath });
    const byokB = createByokServer({ productId: 'acme', taskStore: storeB });

    const recovered = byokB.tasks.get(record.taskId);
    expect(recovered?.state).toBe('Running');
    expect(recovered?.instruction).toBe('survive a restart');
    expect(recovered?.deviceId).toBe('dev_1');
    expect(byokB.tasks.list()).toHaveLength(1);

    byokB.stop();
    storeB.close();
  });
});
