import type { TaskFailure } from '@byok-sdk/protocol';

/** The class of a failure the daemon makes itself: no runtime evidence names one. */
export const DAEMON_TASK_FAILURE: TaskFailure = Object.freeze({ class: 'unknown' });
