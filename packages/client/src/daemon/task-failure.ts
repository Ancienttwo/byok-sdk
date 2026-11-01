import { requiredReceiverCapabilities, type TaskFailure } from '@byok-sdk/protocol';

/** The class of a failure the daemon makes itself: no runtime evidence names one. */
export const DAEMON_TASK_FAILURE: TaskFailure = Object.freeze({ class: 'unknown' });

/**
 * `task.fail.failure`, sent only to a server that advertised its gate (#869);
 * without the `scope` gate (#1271) it is sent without `scope`.
 * Server flags are live-only, so a terminal built with no connection has none.
 */
export function taskFailureField(failure: TaskFailure, serverCapabilities: readonly string[]): { failure?: TaskFailure } {
  const admitted = (candidate: TaskFailure) =>
    requiredReceiverCapabilities('task.fail', { failure: candidate }).every((flag) => serverCapabilities.includes(flag));
  if (admitted(failure)) return { failure };
  if ('scope' in failure) {
    const { scope: _scope, ...unscoped } = failure;
    if (admitted(unscoped)) return { failure: unscoped };
  }
  return {};
}
