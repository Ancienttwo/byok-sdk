import { createInProcessTaskEventsWake, type TaskEventsWake } from '@byok-sdk/cloud';
import { createPostgresWake, type PostgresWakeOptions } from './postgres-wake';

export type PostgresTaskEventsWakeOptions = PostgresWakeOptions;

/** A self-NOTIFY probe was not observed, so the connection cannot be trusted to carry notifications. */
export class TaskEventsWakeProbeMissedError extends Error {
  override readonly name = 'TaskEventsWakeProbeMissedError';
}

export interface PostgresTaskEventsWake extends TaskEventsWake {
  /** Host-owned lifetime, like pool.end(). Closes all outstanding subscriptions. */
  close(): Promise<void>;
}

/**
 * Task event hints for every instance on one database (#1113 A4): migration
 * 0036's triggers notify at each commit that changes a task's state, activity
 * log or approval timeline, whichever process or maintenance run wrote it. One
 * resident listener serves every subscription in this process; a lost hint
 * delays a reader by at most `fallbackMs`, and a reconnect wakes every
 * subscription so its reader rescans.
 */
export function createPostgresTaskEventsWake(options: PostgresTaskEventsWakeOptions): PostgresTaskEventsWake {
  const inner = createInProcessTaskEventsWake({
    ...(options.fallbackMs === undefined ? {} : { fallbackMs: options.fallbackMs }),
  });
  const wake = createPostgresWake({
    channel: 'byok_task_events_wake',
    applicationName: 'byok-task-events-wake',
    label: 'task events wake',
    inner: { notify: inner.changed, subscribe: inner.subscribe },
    probeMissed: (message) => new TaskEventsWakeProbeMissedError(message),
  }, options);
  return {
    // Only migration 0036's triggers signal commits; there is no application NOTIFY.
    changed() {},
    subscribe: wake.subscribe,
    close: wake.close,
  };
}
