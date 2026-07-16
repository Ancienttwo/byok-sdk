import { describe, expect, it } from 'vitest';
import { IllegalTaskTransitionError, TaskStore } from '../task-store';

function createTask(store: TaskStore, taskId = 'task_1') {
  return store.create({
    taskId,
    instruction: 'do the thing',
    policy: { mode: 'confirm' },
    deviceId: 'dev_1',
  });
}

describe('TaskStore', () => {
  it('creates a task in the Offered state', () => {
    const store = new TaskStore();
    const record = createTask(store);

    expect(record.state).toBe('Offered');
    expect(store.get('task_1')).toEqual(record);
    expect(store.list()).toEqual([record]);
  });

  it('returns undefined for an unknown taskId', () => {
    const store = new TaskStore();
    expect(store.get('nope')).toBeUndefined();
  });

  it('applies a legal transition and updates updatedAt', async () => {
    const store = new TaskStore();
    createTask(store);

    await new Promise((r) => setTimeout(r, 2));
    const updated = store.transition('task_1', 'Claimed', { deviceId: 'dev_1' });

    expect(updated.state).toBe('Claimed');
    expect(updated.deviceId).toBe('dev_1');
    expect(updated.updatedAt >= updated.createdAt).toBe(true);
  });

  it('walks the full happy path Offered -> Claimed -> Running -> Complete', () => {
    const store = new TaskStore();
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
    const store = new TaskStore();
    createTask(store);
    store.transition('task_1', 'Claimed');
    store.transition('task_1', 'Running');

    store.transition('task_1', 'AwaitApproval');
    const resumed = store.transition('task_1', 'Running');

    expect(resumed.state).toBe('Running');
  });

  it('rejects an illegal transition (Offered -> Running skips Claimed)', () => {
    const store = new TaskStore();
    createTask(store);

    expect(() => store.transition('task_1', 'Running')).toThrow(IllegalTaskTransitionError);
    // state must be unchanged after the rejected attempt
    expect(store.get('task_1')?.state).toBe('Offered');
  });

  it('rejects an illegal transition out of a terminal state', () => {
    const store = new TaskStore();
    createTask(store);
    store.transition('task_1', 'Cancelled');

    expect(() => store.transition('task_1', 'Running')).toThrow(IllegalTaskTransitionError);
  });

  it('rejects AwaitApproval -> Complete (must resume through Running first)', () => {
    const store = new TaskStore();
    createTask(store);
    store.transition('task_1', 'Claimed');
    store.transition('task_1', 'Running');
    store.transition('task_1', 'AwaitApproval');

    expect(() => store.transition('task_1', 'Complete')).toThrow(IllegalTaskTransitionError);
  });

  it('throws transitioning an unknown taskId', () => {
    const store = new TaskStore();
    expect(() => store.transition('missing', 'Claimed')).toThrow(/unknown taskId/);
  });
});
