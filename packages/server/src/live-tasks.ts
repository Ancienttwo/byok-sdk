import type { TaskAttempt } from '@byok-sdk/cloud';
import { TASK_STATES, TASK_TRANSITIONS, type TaskState } from '@byok-sdk/protocol';
import { toTaskState, type DispatchFacts } from './snapshot';

/**
 * This process's account of its tenant's tasks, sized by the tasks that can
 * still move rather than by history.
 *
 * Every attempt is in exactly one of two places: the LIVE set (projects to a
 * non-terminal state, so `stats()` must re-read it) or a per-terminal-state
 * COUNT. Terminal states are absorbing — the kernel never moves an attempt out
 * of `complete`/`failed`/`cancelled`, and a recorded cancellation is never
 * withdrawn — so an attempt is counted once, when it leaves the live set, and
 * never read again. Nothing here is an authority: the live set only says which
 * attempts to re-read, and every state reported is projected from a fresh store
 * read by the same `toTaskState` that `tasks.get` uses.
 *
 * Dispatch facts ride on the live entry and leave with it. They are the
 * dispatch input the kernel does not persist (`DispatchFacts`); a terminal
 * task's snapshot therefore reports the same fallback a restarted process
 * always has, instead of this process keeping one entry per task forever.
 */
export class LiveTaskIndex {
  readonly #live = new Map<string, DispatchFacts | undefined>();
  readonly #terminalCounts = new Map<TaskState, number>();

  /** Account an attempt that already existed when this process opened its store. */
  seed(attempt: TaskAttempt): void {
    const terminal = terminalStateOf(attempt);
    if (terminal === undefined) this.#live.set(attempt.taskId, undefined);
    else this.#count(terminal);
  }

  /**
   * Account an attempt a create call returned. A replayed create of a task that
   * is already terminal adds nothing: it was counted when it left the live set,
   * or by `seed`.
   */
  opened(attempt: TaskAttempt): void {
    if (terminalStateOf(attempt) !== undefined || this.#live.has(attempt.taskId)) return;
    this.#live.set(attempt.taskId, undefined);
  }

  /** Any fresh read or write result. A now-terminal live attempt is counted exactly once. */
  observe(attempt: TaskAttempt): void {
    const terminal = terminalStateOf(attempt);
    if (terminal !== undefined && this.#live.delete(attempt.taskId)) this.#count(terminal);
  }

  isLive(taskId: string): boolean {
    return this.#live.has(taskId);
  }

  liveTaskIds(): string[] {
    return [...this.#live.keys()];
  }

  /** Number of tasks this index holds per-task state for — the live set only. */
  get size(): number {
    return this.#live.size;
  }

  terminalCount(state: TaskState): number {
    return this.#terminalCounts.get(state) ?? 0;
  }

  /** Attach dispatch facts to a still-live task; a task already terminal keeps none. */
  attachFacts(taskId: string, facts: DispatchFacts): void {
    if (this.#live.has(taskId)) this.#live.set(taskId, facts);
  }

  facts(taskId: string): DispatchFacts | undefined {
    return this.#live.get(taskId);
  }

  clearFacts(): void {
    for (const taskId of this.#live.keys()) this.#live.set(taskId, undefined);
  }

  #count(state: TaskState): void {
    this.#terminalCounts.set(state, this.terminalCount(state) + 1);
  }
}

/** The attempt's projected state when it is terminal; terminal never depends on the approval timeline. */
export function terminalStateOf(attempt: TaskAttempt): TaskState | undefined {
  const state = toTaskState(attempt, undefined);
  return TASK_TRANSITIONS[state].length === 0 ? state : undefined;
}

/** A zeroed per-state count, in `TASK_STATES` order. */
export function emptyTaskCounts(): Record<TaskState, number> {
  return Object.fromEntries(TASK_STATES.map((state) => [state, 0])) as Record<TaskState, number>;
}
