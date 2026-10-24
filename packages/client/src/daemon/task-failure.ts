import { requiredReceiverCapabilities, type TaskFailure } from '@byok-sdk/protocol';

/** The class of a failure the daemon makes itself: no runtime evidence names one. */
export const DAEMON_TASK_FAILURE: TaskFailure = Object.freeze({ class: 'unknown' });

/**
 * `task.fail.failure`, sent only to a server that advertised its gate (#869).
 * Server flags are live-only, so a terminal built with no connection has none.
 */
export function taskFailureField(failure: TaskFailure, serverCapabilities: readonly string[]): { failure?: TaskFailure } {
  return requiredReceiverCapabilities('task.fail', { failure }).every((flag) => serverCapabilities.includes(flag)) ? { failure } : {};
}
