import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createByokServer } from '../index';
import { SqliteTaskStore } from '../sqlite-task-store';
import { isSqliteAvailable } from '../sqlite-support';
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
