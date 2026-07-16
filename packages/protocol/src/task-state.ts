export const TASK_STATES = [
  'Offered',
  'Claimed',
  'Running',
  'AwaitApproval',
  'Complete',
  'Failed',
  'Cancelled',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/**
 * Legal state transitions for a task. `Complete` / `Failed` / `Cancelled` are
 * terminal (no outgoing edges). `Running` and `AwaitApproval` form a loop:
 * the daemon can request approval mid-run and resume once the server
 * approves (or fail/cancel out of the approval wait).
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  Offered: ['Claimed', 'Cancelled'],
  Claimed: ['Running', 'Failed', 'Cancelled'],
  Running: ['AwaitApproval', 'Complete', 'Failed', 'Cancelled'],
  AwaitApproval: ['Running', 'Failed', 'Cancelled'],
  Complete: [],
  Failed: [],
  Cancelled: [],
};

/** Whether `from -> to` is a legal transition per {@link TASK_TRANSITIONS}. */
export function canTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}
