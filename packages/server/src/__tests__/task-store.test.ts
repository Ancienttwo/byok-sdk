import { describe, expect, it } from 'vitest';
import { IllegalTaskTransitionError, InMemoryTaskStore } from '../task-store';

function createTask(store: InMemoryTaskStore, taskId = 'task_1') {
  return store.create({
    taskId,
    instruction: 'do the thing',
    policy: { mode: 'confirm' },
    deviceId: 'dev_1',
  });
}

describe('InMemoryTaskStore', () => {
  it('creates a task in the Offered state', () => {
    const store = new InMemoryTaskStore();
    const record = createTask(store);

    expect(record.state).toBe('Offered');
    expect(store.get('task_1')).toEqual(record);
    expect(store.list()).toEqual([record]);
  });

  it('returns undefined for an unknown taskId', () => {
    const store = new InMemoryTaskStore();
    expect(store.get('nope')).toBeUndefined();
  });

  it('applies a legal transition and updates updatedAt', async () => {
    const store = new InMemoryTaskStore();
    createTask(store);

    await new Promise((r) => setTimeout(r, 2));
    const updated = store.transition('task_1', 'Claimed', { deviceId: 'dev_1' });

    expect(updated.state).toBe('Claimed');
    expect(updated.deviceId).toBe('dev_1');
    expect(updated.updatedAt >= updated.createdAt).toBe(true);
  });

  it('walks the full happy path Offered -> Claimed -> Running -> Complete', () => {
    const store = new InMemoryTaskStore();
    createTask(store);

    store.transition('task_1', 'Claimed');
    store.transition('task_1', 'Running');
    const done = store.transition('task_1', 'Complete', {
      result: { state: 'Complete', summary: 'ok' },
    });

    expect(done.state).toBe('Complete');
    expect(done.result).toEqual({ state: 'Complete', summary: 'ok' });
  });

  it('supports the AwaitApproval <-> Running loop', () => {
    const store = new InMemoryTaskStore();
    createTask(store);
    store.transition('task_1', 'Claimed');
    store.transition('task_1', 'Running');

    store.transition('task_1', 'AwaitApproval');
    const resumed = store.transition('task_1', 'Running');

    expect(resumed.state).toBe('Running');
  });

  it('rejects an illegal transition (Offered -> Running skips Claimed)', () => {
    const store = new InMemoryTaskStore();
    createTask(store);

    expect(() => store.transition('task_1', 'Running')).toThrow(IllegalTaskTransitionError);
    // state must be unchanged after the rejected attempt
    expect(store.get('task_1')?.state).toBe('Offered');
  });

  it('rejects an illegal transition out of a terminal state', () => {
    const store = new InMemoryTaskStore();
    createTask(store);
    store.transition('task_1', 'Cancelled');

    expect(() => store.transition('task_1', 'Running')).toThrow(IllegalTaskTransitionError);
  });

  it('rejects AwaitApproval -> Complete (must resume through Running first)', () => {
    const store = new InMemoryTaskStore();
    createTask(store);
    store.transition('task_1', 'Claimed');
    store.transition('task_1', 'Running');
    store.transition('task_1', 'AwaitApproval');

    expect(() => store.transition('task_1', 'Complete')).toThrow(IllegalTaskTransitionError);
  });

  it('throws transitioning an unknown taskId', () => {
    const store = new InMemoryTaskStore();
    expect(() => store.transition('missing', 'Claimed')).toThrow(/unknown taskId/);
  });

  describe('setPendingApprovalId', () => {
    it('sets pendingApprovalId while the task is AwaitApproval', () => {
      const store = new InMemoryTaskStore();
      createTask(store);
      store.transition('task_1', 'Claimed');
      store.transition('task_1', 'Running');
      store.transition('task_1', 'AwaitApproval');

      const updated = store.setPendingApprovalId('task_1', 'appr-1');
      expect(updated?.pendingApprovalId).toBe('appr-1');
      expect(store.get('task_1')?.pendingApprovalId).toBe('appr-1');
    });

    it('returns undefined for an unknown taskId', () => {
      const store = new InMemoryTaskStore();
      expect(store.setPendingApprovalId('missing', 'appr-1')).toBeUndefined();
    });

    /**
     * S3 (cross-model review finding, P1): mirrors `SqliteTaskStore`'s own
     * CAS guard (`sqlite-task-store.test.ts`) for symmetry between the two
     * reference implementations — a laggard caller (e.g. a delayed/queued
     * `task.await_approval` processed after the task already left
     * `AwaitApproval` via a real `approveTask`/`rejectTask` elsewhere) must
     * not resurrect a pending id for a task that has already moved on.
     */
    it('is a no-op once the task has left AwaitApproval — the stored record is unchanged', () => {
      const store = new InMemoryTaskStore();
      createTask(store);
      store.transition('task_1', 'Claimed');
      store.transition('task_1', 'Running');
      store.transition('task_1', 'AwaitApproval');
      store.setPendingApprovalId('task_1', 'appr-1');
      const beforeAttempt = store.transition('task_1', 'Running'); // leaves AwaitApproval
      expect(beforeAttempt.pendingApprovalId).toBe('appr-1'); // transition() itself doesn't clear it (hub.ts's transitionTask policy does, one layer up)

      const result = store.setPendingApprovalId('task_1', 'appr-2');

      expect(result?.pendingApprovalId).toBe('appr-1'); // rejected — the write did not apply
      expect(store.get('task_1')?.pendingApprovalId).toBe('appr-1'); // stored record unchanged
      expect(store.get('task_1')?.state).toBe('Running');
    });
  });
});
