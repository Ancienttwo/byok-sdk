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
 *
 * `Offered -> Failed` (M1 gap #5, "Declined vs. Failed"): a daemon that
 * declines an offer pre-claim (`task.decline`) reports it through the
 * existing `Failed` state rather than a new `Declined` state. A decline and
 * a post-claim failure are the same outcome from the dispatcher's point of
 * view — this attempt produced no result, `reason`/`retryable` say why and
 * whether retrying elsewhere makes sense — so reusing `Failed` keeps the
 * state machine minimal instead of forking every terminal-state consumer
 * into "Failed or Declined, handle both". See docs/protocol.md for the full
 * writeup.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  Offered: ['Claimed', 'Cancelled', 'Failed'],
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
