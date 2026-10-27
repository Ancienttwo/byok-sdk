import { TASK_STATES, type TaskState } from '@byok-sdk/protocol';
import { type DaemonTaskInfo } from '../index';
import type { DaemonLifecycle } from '../daemon/daemon-lifecycle';
import type { DaemonRecord } from '../daemon/daemon-record';

/**
 * A task as the audit log describes it: `DaemonTaskInfo`'s lifecycle fields,
 * with the free-form `summary` replaced by its byte count (the log never holds
 * the text — issue #395).
 */
export type DerivedTaskInfo = Omit<DaemonTaskInfo, 'summary'> & { summaryBytes?: number };

/**
 * Reconstructs the shape `DaemonObserver.tasks()` exposes to a LIVE
 * in-process daemon from the records a `byok-agent start` appended to the
 * audit log — this is what lets a separate, short-lived `byok-agent
 * tasks`/`status` invocation show task state without attaching to that
 * process (see `byok-agent.ts`'s header comment). A standalone reducer over
 * `DaemonRecord.kind`, mirroring the observer's own transitions.
 */
export function deriveTasksFromRecords(records: readonly DaemonRecord[]): DerivedTaskInfo[] {
  const tasks = new Map<string, DerivedTaskInfo>();

  function upsert(
    taskId: string,
    ts: string,
    patch: Partial<Omit<DerivedTaskInfo, 'taskId' | 'updatedAt'>> & { state: TaskState },
  ): void {
    const existing = tasks.get(taskId);
    tasks.set(taskId, { ...existing, ...patch, taskId, updatedAt: ts });
  }

  for (const event of records) {
    switch (event.kind) {
      case 'outbound-rejected':
        if (event.terminal && event.taskId !== undefined) upsert(event.taskId, event.ts, { state: event.taskState, delivery: 'rejected' });
        break;
      case 'offered':
        upsert(event.taskId, event.ts, { state: 'Offered', runtime: event.runtime });
        break;
      case 'claimed':
        upsert(event.taskId, event.ts, {
          state: 'Claimed',
          ...(event.claimedRuntime !== undefined ? { claimedRuntime: event.claimedRuntime } : {}),
        });
        break;
      case 'started':
        upsert(event.taskId, event.ts, { state: 'Running' });
        break;
      case 'turn':
        upsert(event.taskId, event.ts, { state: 'Running' });
        break;
      case 'awaiting-approval':
        upsert(event.taskId, event.ts, { state: 'AwaitApproval', summaryBytes: event.summaryBytes });
        break;
      case 'completed':
        upsert(event.taskId, event.ts, { state: 'Complete', summaryBytes: event.summaryBytes, sessionRef: event.sessionRef });
        break;
      case 'failed':
        upsert(event.taskId, event.ts, {
          state: 'Failed',
          summaryBytes: event.reasonBytes,
          ...(event.preClaim ? { declined: true } : {}),
        });
        break;
      case 'cancelled':
        upsert(event.taskId, event.ts, { state: 'Cancelled', summaryBytes: event.reasonBytes });
        break;
      // 'artifact' carries no task-STATE transition of its own (observer.ts
      // never calls its own upsertTask for it either); the remaining kinds
      // are daemon-level, not per-task.
      default:
        break;
    }
  }

  return [...tasks.values()];
}

/**
 * Most recent `lifecycle` record, if the log has any — used by `status`,
 * `doctor` and `service-status` to show the last-known lifecycle, including a
 * halt and its reason. Never a live/current guarantee: if `start` isn't
 * running right now, this is simply whatever it last reported before exiting
 * (or nothing, if it never ran at all) — see `byok-agent.ts`'s header comment.
 */
export function lastLifecycle(records: readonly DaemonRecord[]): { lifecycle: DaemonLifecycle; ts: string } | undefined {
  let last: { lifecycle: DaemonLifecycle; ts: string } | undefined;
  for (const event of records) {
    if (event.kind === 'lifecycle') last = { lifecycle: event.lifecycle, ts: event.ts };
  }
  return last;
}

export type TaskCounts = Record<TaskState, number> & { total: number };

/** Zero-filled over every `TaskState` (via `TASK_STATES`, the single authority — not a hand-maintained list) so a state with zero current tasks still renders instead of being silently absent. */
export function tallyTaskStates(tasks: readonly Pick<DaemonTaskInfo, 'state'>[]): TaskCounts {
  const counts = Object.fromEntries(TASK_STATES.map((state) => [state, 0])) as TaskCounts;
  counts.total = tasks.length;
  for (const task of tasks) counts[task.state] += 1;
  return counts;
}
