import { TASK_STATES, type TaskState } from '@byok/protocol';
import { type ConnectionState, type DaemonEvent, type DaemonTaskInfo } from '../index';

/**
 * Reconstructs the same shape `DaemonObserver.tasks()` exposes to a LIVE
 * in-process daemon, but from a REPLAYED sequence of already-logged
 * `DaemonEvent`s instead — this is what lets a separate, short-lived
 * `byok-agent tasks`/`status` invocation show task state without attaching
 * to the `start` process that actually observed it (see `byok-agent.ts`'s
 * header comment). Deliberately a standalone reducer, not a call into
 * `DaemonObserver` itself: `DaemonObserver`'s own public methods
 * (`handleInboundEnvelope`/`handleOutboundEnvelope`) take a raw protocol
 * `Envelope`, not the already-normalized `DaemonEvent` this module receives
 * from the audit log — the two shapes don't line up, so this mirrors that
 * reducer's logic operating on `DaemonEvent.kind` directly instead.
 */
export function deriveTasksFromEvents(events: readonly DaemonEvent[]): DaemonTaskInfo[] {
  const tasks = new Map<string, DaemonTaskInfo>();

  function upsert(
    taskId: string,
    ts: string,
    patch: Partial<Omit<DaemonTaskInfo, 'taskId' | 'updatedAt'>> & { state: TaskState },
  ): void {
    const existing = tasks.get(taskId);
    tasks.set(taskId, { ...existing, ...patch, taskId, updatedAt: ts });
  }

  for (const event of events) {
    switch (event.kind) {
      case 'offered':
        upsert(event.taskId, event.ts, { state: 'Offered', runtime: event.runtime });
        break;
      case 'claimed':
        upsert(event.taskId, event.ts, { state: 'Claimed' });
        break;
      case 'started':
        upsert(event.taskId, event.ts, { state: 'Running' });
        break;
      case 'progress':
        upsert(event.taskId, event.ts, { state: 'Running' });
        break;
      case 'awaiting-approval':
        upsert(event.taskId, event.ts, { state: 'AwaitApproval', summary: event.summary });
        break;
      case 'completed':
        upsert(event.taskId, event.ts, { state: 'Complete', summary: event.summary, sessionRef: event.sessionRef });
        break;
      case 'failed':
        upsert(event.taskId, event.ts, {
          state: 'Failed',
          summary: event.reason,
          ...(event.preClaim ? { declined: true } : {}),
        });
        break;
      case 'cancelled':
        upsert(event.taskId, event.ts, { state: 'Cancelled', summary: event.reason });
        break;
      // 'artifact' carries no task-STATE transition of its own (observer.ts
      // never calls its own upsertTask for it either); 'connection'/
      // 'paired'/'unpaired'/'runtimes-detected' are daemon-level, not
      // per-task.
      default:
        break;
    }
  }

  return [...tasks.values()];
}

/**
 * Most recent `connection` DaemonEvent, if the log has any — used by
 * `status` to show a best-effort "last known" transport state. Never a
 * live/current guarantee: if `start` isn't running right now, this is
 * simply whatever it last reported before exiting (or nothing, if it never
 * ran at all) — see `byok-agent.ts`'s header comment.
 */
export function lastConnectionState(events: readonly DaemonEvent[]): { state: ConnectionState; ts: string } | undefined {
  let last: { state: ConnectionState; ts: string } | undefined;
  for (const event of events) {
    if (event.kind === 'connection') last = { state: event.state, ts: event.ts };
  }
  return last;
}

export type TaskCounts = Record<TaskState, number> & { total: number };

/** Zero-filled over every `TaskState` (via `TASK_STATES`, the single authority — not a hand-maintained list) so a state with zero current tasks still renders instead of being silently absent. */
export function tallyTaskStates(tasks: readonly DaemonTaskInfo[]): TaskCounts {
  const counts = Object.fromEntries(TASK_STATES.map((state) => [state, 0])) as TaskCounts;
  counts.total = tasks.length;
  for (const task of tasks) counts[task.state] += 1;
  return counts;
}
