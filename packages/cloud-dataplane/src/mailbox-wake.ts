import { createInProcessMailboxWake, type MailboxWake } from '@byok-sdk/cloud';
import { createPostgresWake, type PostgresWakeOptions } from './postgres-wake';

export type PostgresMailboxWakeOptions = PostgresWakeOptions;

/** A self-NOTIFY probe was not observed, so the connection cannot be trusted to carry notifications. */
export class MailboxWakeProbeMissedError extends Error {
  override readonly name = 'MailboxWakeProbeMissedError';
}

export interface PostgresMailboxWake extends MailboxWake {
  /** Host-owned lifetime, like pool.end(). Closes all outstanding subscriptions. */
  close(): Promise<void>;
}

/** One resident Node listener, independent of the request pool and the mailbox authority. */
export function createPostgresMailboxWake(options: PostgresMailboxWakeOptions): PostgresMailboxWake {
  const inner = createInProcessMailboxWake({
    ...(options.fallbackMs === undefined ? {} : { fallbackMs: options.fallbackMs }),
  });
  const wake = createPostgresWake({
    channel: 'byok_mailbox_wake',
    applicationName: 'byok-mailbox-wake',
    label: 'mailbox wake',
    inner: { notify: inner.appended, subscribe: inner.subscribe },
    probeMissed: (message) => new MailboxWakeProbeMissedError(message),
  }, options);
  return {
    // Only the transaction trigger signals Postgres commits, including writers
    // in other processes and maintenance replay. No application-layer NOTIFY.
    appended() {},
    subscribe: wake.subscribe,
    close: wake.close,
  };
}
