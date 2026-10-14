import { TASK_STATES, type TaskState } from '@byok-sdk/protocol';
import { type DaemonTaskInfo } from '../index';
import type { DaemonLifecycle } from '../daemon/daemon-lifecycle';
import type { DaemonRecord } from '../daemon/daemon-record';
import { GIT_ERROR_CATEGORIES, GIT_WORKSPACE_PHASES } from '../daemon/git-workspace';

export interface TaskGitStatus {
  /** Opaque local correlation ID; never a path or commit ID. */
  workspaceId: string;
  phase: string;
  headChanged?: boolean;
  commitsSinceBaseline?: number;
  dirty?: { staged: number; unstaged: number; untracked: number; conflicted: number };
  errorCategory?: string;
}

/**
 * A task as the audit log describes it: `DaemonTaskInfo`'s lifecycle fields,
 * with the free-form `summary` replaced by its byte count (the log never holds
 * the text — issue #395) and the last Git observation.
 */
export type DerivedTaskInfo = Omit<DaemonTaskInfo, 'summary'> & { summaryBytes?: number; git?: TaskGitStatus };

/**
 * Both stable-set filters below are projected from `daemon/git-workspace.ts`'s
 * `GIT_WORKSPACE_PHASES`/`GIT_ERROR_CATEGORIES` (the single sources of truth
 * for the `GitWorkspacePhase`/`GitErrorCategory` unions) rather than carrying
 * literal copies that could drift from them; the runtime half of that
 * guarantee is `__tests__/git-category-drift.test.ts`. Same projection-of-
 * union idiom as `TASK_STATES` from `@byok-sdk/protocol` above.
 *
 * @internal Exported for the drift-guard test only (never re-exported from
 * `index.ts`).
 */
export const STABLE_GIT_PHASES = new Set<string>(GIT_WORKSPACE_PHASES);
export const STABLE_GIT_ERROR_CATEGORIES = new Set<string>(GIT_ERROR_CATEGORIES);

function nonNegativeSafeInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function deriveGitStatus(event: Extract<DaemonRecord, { kind: 'git-workspace' }>): TaskGitStatus {
  const dirty = event.dirty
    ? {
        staged: nonNegativeSafeInteger(event.dirty.staged),
        unstaged: nonNegativeSafeInteger(event.dirty.unstaged),
        untracked: nonNegativeSafeInteger(event.dirty.untracked),
        conflicted: nonNegativeSafeInteger(event.dirty.conflicted),
      }
    : undefined;
  const sanitizedDirty = dirty && Object.values(dirty).every((count) => count !== undefined)
    ? (dirty as TaskGitStatus['dirty'])
    : undefined;
  return {
    workspaceId: event.workspaceId,
    phase: STABLE_GIT_PHASES.has(event.phase) ? event.phase : 'unknown',
    ...(typeof event.headChanged === 'boolean' ? { headChanged: event.headChanged } : {}),
    ...(nonNegativeSafeInteger(event.commitsSinceBaseline) !== undefined
      ? { commitsSinceBaseline: nonNegativeSafeInteger(event.commitsSinceBaseline) }
      : {}),
    ...(sanitizedDirty ? { dirty: sanitizedDirty } : {}),
    ...(event.errorCategory !== undefined && STABLE_GIT_ERROR_CATEGORIES.has(event.errorCategory)
      ? { errorCategory: event.errorCategory }
      : {}),
  };
}

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
      case 'git-workspace': {
        const existing = tasks.get(event.taskId);
        // Git-only events are observational supplements. They cannot create a
        // task row or change lifecycle authority, and only update an existing
        // row created by a lifecycle event.
        if (existing) {
          tasks.set(event.taskId, {
            ...existing,
            git: deriveGitStatus(event),
            updatedAt: event.ts,
          });
        }
        break;
      }
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
