import { canTransition, type PermissionPolicy, type RuntimeId, type TaskState } from '@byok/protocol';
import type { TaskSnapshot } from './types';

/** Thrown by {@link TaskStore.transition} when `from -> to` is not in TASK_TRANSITIONS. */
export class IllegalTaskTransitionError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly from: TaskState,
    public readonly to: TaskState,
  ) {
    super(`illegal task transition for ${taskId}: ${from} -> ${to}`);
    this.name = 'IllegalTaskTransitionError';
  }
}

export interface CreateTaskInput {
  taskId: string;
  instruction: string;
  runtime?: RuntimeId;
  policy: PermissionPolicy;
  deviceId?: string;
  sessionRef?: string;
}

interface TaskRecord extends TaskSnapshot {}

/**
 * Plain, framework-agnostic in-memory task store. Enforces the protocol's
 * `TASK_TRANSITIONS` state machine via `canTransition` — every state change
 * must go through {@link transition}, which throws
 * {@link IllegalTaskTransitionError} rather than silently applying an invalid
 * move. Callers (the connection hub) decide what to do with that error; see
 * `hub.ts`'s `applyOrFail` for the "illegal transition -> force Failed if
 * possible, else drop" policy.
 */
export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();

  create(input: CreateTaskInput): TaskRecord {
    const now = new Date().toISOString();
    const record: TaskRecord = {
      taskId: input.taskId,
      state: 'Offered',
      instruction: input.instruction,
      runtime: input.runtime,
      policy: input.policy,
      deviceId: input.deviceId,
      sessionRef: input.sessionRef,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(record.taskId, record);
    return record;
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  /**
   * Apply `taskId`'s state -> `to`, merging `patch` into the record. Throws
   * {@link IllegalTaskTransitionError} if the move isn't legal per
   * `TASK_TRANSITIONS`, and if the task doesn't exist at all.
   */
  transition(taskId: string, to: TaskState, patch: Partial<Omit<TaskRecord, 'taskId' | 'state'>> = {}): TaskRecord {
    const record = this.tasks.get(taskId);
    if (!record) {
      throw new Error(`unknown taskId: ${taskId}`);
    }
    if (!canTransition(record.state, to)) {
      throw new IllegalTaskTransitionError(taskId, record.state, to);
    }
    const updated: TaskRecord = {
      ...record,
      ...patch,
      state: to,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, updated);
    return updated;
  }
}
