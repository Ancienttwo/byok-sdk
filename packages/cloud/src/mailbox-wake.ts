import type { TenantId } from '@byok-sdk/core';

/** A lossy hint over the durable mailbox, never a delivery or cursor authority. */
export interface MailboxWake {
  /** Called after a mailbox commit. Synchronous and non-throwing. */
  appended(tenant: TenantId, deviceId: string): void;
  /** Subscribe before reading so an append between the read and next() is retained. */
  subscribe(tenant: TenantId, deviceId: string, signal: AbortSignal): MailboxWakeSubscription;
}

export interface MailboxWakeSubscription {
  /** Resolves on a hint, the fallback interval, maxWaitMs, abort, or close. */
  next(maxWaitMs: number): Promise<void>;
  close(): void;
}
