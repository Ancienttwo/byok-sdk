import { describe, expect, it } from 'vitest';
import type { DaemonEvent } from '../index';
import { deriveTasksFromEvents, lastConnectionState, tallyTaskStates } from '../bin/tasks-view';

describe('bin/tasks-view: deriveTasksFromEvents', () => {
  it('replays offered -> claimed -> started -> progress -> completed into a single Complete task', () => {
    const events: DaemonEvent[] = [
      { kind: 'offered', ts: '2026-01-01T00:00:00.000Z', taskId: 't1', runtime: 'pi' },
      { kind: 'claimed', ts: '2026-01-01T00:00:01.000Z', taskId: 't1' },
      { kind: 'started', ts: '2026-01-01T00:00:02.000Z', taskId: 't1' },
      { kind: 'progress', ts: '2026-01-01T00:00:03.000Z', taskId: 't1', event: { type: 'progress', text: 'working' } },
      { kind: 'completed', ts: '2026-01-01T00:00:04.000Z', taskId: 't1', summary: 'done', sessionRef: 'sess-1' },
    ];

    const tasks = deriveTasksFromEvents(events);
    expect(tasks).toEqual([
      {
        taskId: 't1',
        state: 'Complete',
        runtime: 'pi',
        summary: 'done',
        sessionRef: 'sess-1',
        updatedAt: '2026-01-01T00:00:04.000Z',
      },
    ]);
  });

  it('preserves the requested runtime and replays the actual claimed runtime separately', () => {
    const events: DaemonEvent[] = [
      { kind: 'offered', ts: '2026-01-01T00:00:00.000Z', taskId: 't-runtime', runtime: 'claude' },
      { kind: 'claimed', ts: '2026-01-01T00:00:01.000Z', taskId: 't-runtime', claimedRuntime: 'pi' },
    ];

    expect(deriveTasksFromEvents(events)).toEqual([
      {
        taskId: 't-runtime',
        state: 'Claimed',
        runtime: 'claude',
        claimedRuntime: 'pi',
        updatedAt: '2026-01-01T00:00:01.000Z',
      },
    ]);
  });

  it('keeps a legacy claimed event without runtime free of claimedRuntime', () => {
    const [task] = deriveTasksFromEvents([
      { kind: 'claimed', ts: '2026-01-01T00:00:01.000Z', taskId: 't-legacy' },
    ]);

    expect(task).toEqual({ taskId: 't-legacy', state: 'Claimed', updatedAt: '2026-01-01T00:00:01.000Z' });
  });

  it('a pre-claim failed event with preClaim:true marks the task Failed + declined:true', () => {
    const events: DaemonEvent[] = [
      { kind: 'offered', ts: '2026-01-01T00:00:00.000Z', taskId: 't2', runtime: 'claude' },
      { kind: 'failed', ts: '2026-01-01T00:00:01.000Z', taskId: 't2', reason: 'policy not allowed', retryable: false, preClaim: true },
    ];
    const [task] = deriveTasksFromEvents(events);
    expect(task).toMatchObject({ taskId: 't2', state: 'Failed', summary: 'policy not allowed', declined: true });
  });

  it('a post-claim failed event (no preClaim) marks Failed without declined', () => {
    const events: DaemonEvent[] = [
      { kind: 'offered', ts: '2026-01-01T00:00:00.000Z', taskId: 't3' },
      { kind: 'claimed', ts: '2026-01-01T00:00:01.000Z', taskId: 't3' },
      { kind: 'started', ts: '2026-01-01T00:00:02.000Z', taskId: 't3' },
      { kind: 'failed', ts: '2026-01-01T00:00:03.000Z', taskId: 't3', reason: 'crashed', retryable: true },
    ];
    const [task] = deriveTasksFromEvents(events);
    expect(task?.declined).toBeUndefined();
    expect(task).toMatchObject({ state: 'Failed', summary: 'crashed' });
  });

  it('cancelled marks the task Cancelled with the reason as summary', () => {
    const events: DaemonEvent[] = [
      { kind: 'offered', ts: '2026-01-01T00:00:00.000Z', taskId: 't4' },
      { kind: 'claimed', ts: '2026-01-01T00:00:01.000Z', taskId: 't4' },
      { kind: 'cancelled', ts: '2026-01-01T00:00:02.000Z', taskId: 't4', reason: 'user cancelled' },
    ];
    const [task] = deriveTasksFromEvents(events);
    expect(task).toMatchObject({ state: 'Cancelled', summary: 'user cancelled' });
  });

  it('an awaiting-approval task stays AwaitApproval with the approval summary', () => {
    const events: DaemonEvent[] = [
      { kind: 'offered', ts: '2026-01-01T00:00:00.000Z', taskId: 't5' },
      { kind: 'claimed', ts: '2026-01-01T00:00:01.000Z', taskId: 't5' },
      { kind: 'started', ts: '2026-01-01T00:00:02.000Z', taskId: 't5' },
      { kind: 'awaiting-approval', ts: '2026-01-01T00:00:03.000Z', taskId: 't5', summary: 'needs a human' },
    ];
    const [task] = deriveTasksFromEvents(events);
    expect(task).toMatchObject({ state: 'AwaitApproval', summary: 'needs a human' });
  });

  it('tracks multiple concurrent tasks independently, in first-seen order', () => {
    const events: DaemonEvent[] = [
      { kind: 'offered', ts: '2026-01-01T00:00:00.000Z', taskId: 'a' },
      { kind: 'offered', ts: '2026-01-01T00:00:01.000Z', taskId: 'b' },
      { kind: 'claimed', ts: '2026-01-01T00:00:02.000Z', taskId: 'a' },
    ];
    const tasks = deriveTasksFromEvents(events);
    expect(tasks.map((t) => t.taskId)).toEqual(['a', 'b']);
    expect(tasks.find((t) => t.taskId === 'a')?.state).toBe('Claimed');
    expect(tasks.find((t) => t.taskId === 'b')?.state).toBe('Offered');
  });

  it('daemon-level events (connection/paired/unpaired/runtimes-detected/artifact) never create a phantom task', () => {
    const events: DaemonEvent[] = [
      { kind: 'connection', ts: '2026-01-01T00:00:00.000Z', state: 'open' },
      { kind: 'paired', ts: '2026-01-01T00:00:01.000Z', deviceId: 'dev-1' },
      { kind: 'unpaired', ts: '2026-01-01T00:00:02.000Z' },
      { kind: 'runtimes-detected', ts: '2026-01-01T00:00:03.000Z', runtimes: [] },
      { kind: 'artifact', ts: '2026-01-01T00:00:04.000Z', taskId: 'orphan', name: 'x', contentType: 'text/plain' },
    ];
    expect(deriveTasksFromEvents(events)).toEqual([]);
  });

  it('returns [] for an empty event list', () => {
    expect(deriveTasksFromEvents([])).toEqual([]);
  });
});

describe('bin/tasks-view: lastConnectionState', () => {
  it('returns undefined when there are no connection events', () => {
    expect(lastConnectionState([{ kind: 'unpaired', ts: '2026-01-01T00:00:00.000Z' }])).toBeUndefined();
  });

  it('returns the MOST RECENT connection event, not the first', () => {
    const events: DaemonEvent[] = [
      { kind: 'connection', ts: '2026-01-01T00:00:00.000Z', state: 'connecting' },
      { kind: 'connection', ts: '2026-01-01T00:00:01.000Z', state: 'open' },
      { kind: 'connection', ts: '2026-01-01T00:00:02.000Z', state: 'degraded' },
    ];
    expect(lastConnectionState(events)).toEqual({ state: 'degraded', ts: '2026-01-01T00:00:02.000Z' });
  });
});

describe('bin/tasks-view: tallyTaskStates', () => {
  it('zero-fills every TaskState even when no tasks are in it', () => {
    const counts = tallyTaskStates([]);
    expect(counts).toEqual({
      total: 0,
      Offered: 0,
      Claimed: 0,
      Running: 0,
      AwaitApproval: 0,
      Complete: 0,
      Failed: 0,
      Cancelled: 0,
    });
  });

  it('tallies a mix of states correctly', () => {
    const counts = tallyTaskStates([
      { taskId: 'a', state: 'Running', updatedAt: 't' },
      { taskId: 'b', state: 'Running', updatedAt: 't' },
      { taskId: 'c', state: 'Complete', updatedAt: 't' },
      { taskId: 'd', state: 'Failed', updatedAt: 't' },
    ]);
    expect(counts.total).toBe(4);
    expect(counts.Running).toBe(2);
    expect(counts.Complete).toBe(1);
    expect(counts.Failed).toBe(1);
    expect(counts.Offered).toBe(0);
  });
});
