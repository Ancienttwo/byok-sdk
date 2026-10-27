import { describe, expect, it } from 'vitest';
import type { DaemonRecord } from '../index';
import { deriveTasksFromRecords, lastLifecycle, tallyTaskStates } from '../bin/tasks-view';

describe('bin/tasks-view: deriveTasksFromRecords', () => {
  it('replays offered -> claimed -> started -> turn -> completed into a single Complete task', () => {
    const records: DaemonRecord[] = [
      { kind: 'offered', ts: '2026-01-01T00:00:00.000Z', taskId: 't1', runtime: 'pi' },
      { kind: 'claimed', ts: '2026-01-01T00:00:01.000Z', taskId: 't1' },
      { kind: 'started', ts: '2026-01-01T00:00:02.000Z', taskId: 't1' },
      { kind: 'turn', ts: '2026-01-01T00:00:03.000Z', taskId: 't1', turn: 1, closedBy: 'terminal', progressEvents: 1, textBytes: 7, toolUses: 0, toolResults: 0, artifacts: 0, approvals: 0, errors: 0 },
      { kind: 'completed', ts: '2026-01-01T00:00:04.000Z', taskId: 't1', summaryBytes: 4, sessionRef: 'sess-1' },
    ];

    const tasks = deriveTasksFromRecords(records);
    expect(tasks).toEqual([
      {
        taskId: 't1',
        state: 'Complete',
        runtime: 'pi',
        summaryBytes: 4,
        sessionRef: 'sess-1',
        updatedAt: '2026-01-01T00:00:04.000Z',
      },
    ]);
  });

  it('preserves the requested runtime and replays the actual claimed runtime separately', () => {
    const records: DaemonRecord[] = [
      { kind: 'offered', ts: '2026-01-01T00:00:00.000Z', taskId: 't-runtime', runtime: 'claude' },
      { kind: 'claimed', ts: '2026-01-01T00:00:01.000Z', taskId: 't-runtime', claimedRuntime: 'pi' },
    ];

    expect(deriveTasksFromRecords(records)).toEqual([
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
    const [task] = deriveTasksFromRecords([
      { kind: 'claimed', ts: '2026-01-01T00:00:01.000Z', taskId: 't-legacy' },
    ]);

    expect(task).toEqual({ taskId: 't-legacy', state: 'Claimed', updatedAt: '2026-01-01T00:00:01.000Z' });
  });

  it('a pre-claim failed event with preClaim:true marks the task Failed + declined:true', () => {
    const records: DaemonRecord[] = [
      { kind: 'offered', ts: '2026-01-01T00:00:00.000Z', taskId: 't2', runtime: 'claude' },
      { kind: 'failed', ts: '2026-01-01T00:00:01.000Z', taskId: 't2', reasonBytes: 18, retryable: false, preClaim: true },
    ];
    const [task] = deriveTasksFromRecords(records);
    expect(task).toMatchObject({ taskId: 't2', state: 'Failed', summaryBytes: 18, declined: true });
  });

  it('a post-claim failed event (no preClaim) marks Failed without declined', () => {
    const records: DaemonRecord[] = [
      { kind: 'offered', ts: '2026-01-01T00:00:00.000Z', taskId: 't3' },
      { kind: 'claimed', ts: '2026-01-01T00:00:01.000Z', taskId: 't3' },
      { kind: 'started', ts: '2026-01-01T00:00:02.000Z', taskId: 't3' },
      { kind: 'failed', ts: '2026-01-01T00:00:03.000Z', taskId: 't3', reasonBytes: 7, retryable: true },
    ];
    const [task] = deriveTasksFromRecords(records);
    expect(task?.declined).toBeUndefined();
    expect(task).toMatchObject({ state: 'Failed', summaryBytes: 7 });
  });

  it('cancelled marks the task Cancelled with the reason size as summaryBytes', () => {
    const records: DaemonRecord[] = [
      { kind: 'offered', ts: '2026-01-01T00:00:00.000Z', taskId: 't4' },
      { kind: 'claimed', ts: '2026-01-01T00:00:01.000Z', taskId: 't4' },
      { kind: 'cancelled', ts: '2026-01-01T00:00:02.000Z', taskId: 't4', reasonBytes: 14 },
    ];
    const [task] = deriveTasksFromRecords(records);
    expect(task).toMatchObject({ state: 'Cancelled', summaryBytes: 14 });
  });

  it('an awaiting-approval task stays AwaitApproval with the approval summary size', () => {
    const records: DaemonRecord[] = [
      { kind: 'offered', ts: '2026-01-01T00:00:00.000Z', taskId: 't5' },
      { kind: 'claimed', ts: '2026-01-01T00:00:01.000Z', taskId: 't5' },
      { kind: 'started', ts: '2026-01-01T00:00:02.000Z', taskId: 't5' },
      { kind: 'awaiting-approval', ts: '2026-01-01T00:00:03.000Z', taskId: 't5', summaryBytes: 13 },
    ];
    const [task] = deriveTasksFromRecords(records);
    expect(task).toMatchObject({ state: 'AwaitApproval', summaryBytes: 13 });
  });

  it('tracks multiple concurrent tasks independently, in first-seen order', () => {
    const records: DaemonRecord[] = [
      { kind: 'offered', ts: '2026-01-01T00:00:00.000Z', taskId: 'a' },
      { kind: 'offered', ts: '2026-01-01T00:00:01.000Z', taskId: 'b' },
      { kind: 'claimed', ts: '2026-01-01T00:00:02.000Z', taskId: 'a' },
    ];
    const tasks = deriveTasksFromRecords(records);
    expect(tasks.map((t) => t.taskId)).toEqual(['a', 'b']);
    expect(tasks.find((t) => t.taskId === 'a')?.state).toBe('Claimed');
    expect(tasks.find((t) => t.taskId === 'b')?.state).toBe('Offered');
  });

  it('daemon-level records (lifecycle/paired/unpaired/runtimes-detected/artifact) never create a phantom task', () => {
    const records: DaemonRecord[] = [
      { kind: 'lifecycle', ts: '2026-01-01T00:00:00.000Z', lifecycle: { phase: 'running', connection: 'open' } },
      { kind: 'paired', ts: '2026-01-01T00:00:01.000Z', deviceId: 'dev-1' },
      { kind: 'unpaired', ts: '2026-01-01T00:00:02.000Z' },
      { kind: 'runtimes-detected', ts: '2026-01-01T00:00:03.000Z', runtimes: [] },
      { kind: 'environment-resolved', ts: '2026-01-01T00:00:03.500Z', source: 'inherited' },
      { kind: 'artifact', ts: '2026-01-01T00:00:04.000Z', taskId: 'orphan', nameBytes: 1, contentType: 'text/plain' },
    ];
    expect(deriveTasksFromRecords(records)).toEqual([]);
  });

  it('returns [] for an empty record list', () => {
    expect(deriveTasksFromRecords([])).toEqual([]);
  });
});

describe('bin/tasks-view: lastLifecycle', () => {
  it('returns undefined when there are no lifecycle records', () => {
    expect(lastLifecycle([{ kind: 'unpaired', ts: '2026-01-01T00:00:00.000Z' }])).toBeUndefined();
  });

  it('returns the MOST RECENT lifecycle record, not the first', () => {
    const halted = { phase: 'halted', reason: 'device_revoked', at: '2026-01-01T00:00:02.000Z' } as const;
    const records: DaemonRecord[] = [
      { kind: 'lifecycle', ts: '2026-01-01T00:00:00.000Z', lifecycle: { phase: 'running', connection: 'connecting' } },
      { kind: 'lifecycle', ts: '2026-01-01T00:00:01.000Z', lifecycle: { phase: 'running', connection: 'open' } },
      { kind: 'lifecycle', ts: '2026-01-01T00:00:02.000Z', lifecycle: halted },
    ];
    expect(lastLifecycle(records)).toEqual({ lifecycle: halted, ts: '2026-01-01T00:00:02.000Z' });
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
      { state: 'Running' },
      { state: 'Running' },
      { state: 'Complete' },
      { state: 'Failed' },
    ]);
    expect(counts.total).toBe(4);
    expect(counts.Running).toBe(2);
    expect(counts.Complete).toBe(1);
    expect(counts.Failed).toBe(1);
    expect(counts.Offered).toBe(0);
  });
});
