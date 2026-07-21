import { canTransition, type PermissionPolicy, type RuntimeId, type TaskState } from '@byok/protocol';
import type { TaskSnapshot } from './types';

/** Thrown by a {@link TaskStore}'s `transition` when `from -> to` is not in TASK_TRANSITIONS. Every implementation (in-memory, SQLite, or otherwise) must throw this rather than silently applying an invalid move. */
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

/** A task's full persisted state, as tracked by any {@link TaskStore} implementation. Same shape as {@link TaskSnapshot} — kept as its own (structurally identical) type so this storage-layer contract can evolve independently of the SDK-facing `TaskSnapshot` if a future need arises. */
export interface TaskRecord extends TaskSnapshot {}

/**
 * Storage contract for task records — the M3 injection point, mirroring how
 * {@link BlobStore} (`blob-store.ts`) is injectable: `createByokServer`
 * (`index.ts`) accepts `opts.taskStore`, defaulting to {@link InMemoryTaskStore}
 * so nothing breaks for an embedder that doesn't override it. `ConnectionHub`
 * (`hub.ts`) is written against this interface only — it never references
 * {@link InMemoryTaskStore} (or any other concrete implementation) directly —
 * so a persistent implementation such as `sqlite-task-store.ts`'s
 * `SqliteTaskStore` (M3) drops in with zero changes anywhere else.
 *
 * Every implementation MUST enforce the protocol's `TASK_TRANSITIONS` state
 * machine (via `canTransition`) inside `transition`, throwing
 * {@link IllegalTaskTransitionError} rather than silently applying an
 * invalid move — this is part of the interface's contract, not just an
 * `InMemoryTaskStore` implementation detail. `ConnectionHub`'s `applyOrFail`
 * (`hub.ts`) relies on that exception type to decide "illegal transition ->
 * force `Failed` if possible, else drop".
 */
export interface TaskStore {
  /** Create a new task record in the `Offered` state. */
  create(input: CreateTaskInput): TaskRecord;
  /** Look up a task by id, or `undefined` if unknown. */
  get(taskId: string): TaskRecord | undefined;
  /** All known tasks. */
  list(): TaskRecord[];
  /**
   * Apply `taskId`'s state -> `to`, merging `patch` into the record. Must
   * throw {@link IllegalTaskTransitionError} if the move isn't legal per
   * `TASK_TRANSITIONS`, and a plain `Error` (message: `` `unknown taskId:
   * ${taskId}` ``) if the task doesn't exist at all —
   * {@link InMemoryTaskStore.transition}'s existing message format, which
   * some tests match on.
   */
  transition(taskId: string, to: TaskState, patch?: Partial<Omit<TaskRecord, 'taskId' | 'state'>>): TaskRecord;
}

/**
 * Plain, framework-agnostic in-memory {@link TaskStore}. Enforces the
 * protocol's `TASK_TRANSITIONS` state machine via `canTransition` — every
 * state change must go through {@link transition}, which throws
 * {@link IllegalTaskTransitionError} rather than silently applying an invalid
 * move. Callers (the connection hub) decide what to do with that error; see
 * `hub.ts`'s `applyOrFail` for the "illegal transition -> force Failed if
 * possible, else drop" policy.
 *
 * M0/M1/M2 reference default — loses all state on process restart. See
 * `sqlite-task-store.ts`'s `SqliteTaskStore` (M3) for a persistent
 * alternative implementing the same {@link TaskStore} contract.
 */
export class InMemoryTaskStore implements TaskStore {
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
