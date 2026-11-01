import type { TenantId } from '@byok-sdk/core';

/**
 * A lossy hint that a task's activity log, approval timeline or state may have
 * changed (#1113 A4). It names only the tenant and task, never content, and it
 * is never a cursor or event authority: a woken reader re-reads those sources.
 * One hint can cause an extra read, never a new event.
 */
export interface TaskEventsWake {
  /** Called after a commit that changed the task. Synchronous and non-throwing. */
  changed(tenant: TenantId, taskId: string): void;
  /** Subscribe before reading so a commit between the read and next() is retained. */
  subscribe(tenant: TenantId, taskId: string, signal: AbortSignal): TaskEventsWakeSubscription;
}

export interface TaskEventsWakeSubscription {
  /** Resolves on a hint, the fallback interval, maxWaitMs, abort, or close. */
  next(maxWaitMs: number): Promise<void>;
  close(): void;
}
