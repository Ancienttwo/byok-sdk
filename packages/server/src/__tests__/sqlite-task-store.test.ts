import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createByokServer } from '../index';
import { SqliteTaskStore } from '../sqlite-task-store';
import { isSqliteCapableNodeVersion } from '../sqlite-support';
import { IllegalTaskTransitionError } from '../task-store';

// node:sqlite requires Node 22.5+. The core SDK works on the declared Node 20
// floor with the default InMemoryTaskStore; these SQLite reference-store tests
// skip on older runtimes (the CI Node 20 leg) rather than fail the whole leg.
const sqliteReady = isSqliteCapableNodeVersion(process.versions.node);

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

  it('recovers a task’s full state after being reopened on the same database file (restart-safety)', () => {
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

describe.skipIf(!sqliteReady)('createByokServer({ taskStore: new SqliteTaskStore(...) }) restart-safety', () => {
  it('a second createByokServer instance on the same db file recovers a task created by the first', () => {
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
    // SqliteTaskStore instance, pointed at the exact same file.
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
