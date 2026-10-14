import type { TenantId } from '@byok-sdk/core';
import type { MailboxWake, MailboxWakeSubscription } from '../../mailbox-wake';

export const DEFAULT_MAILBOX_WAKE_FALLBACK_MS = 5_000;

export interface InProcessMailboxWakeOptions {
  /** Bounds delivery latency when all hints are lost. Defaults to 5 seconds. */
  readonly fallbackMs?: number;
}

/** Request-local subscriptions behind a port; losing the table only delays reads. */
export function createInProcessMailboxWake(options: InProcessMailboxWakeOptions = {}): MailboxWake {
  const fallbackMs = options.fallbackMs ?? DEFAULT_MAILBOX_WAKE_FALLBACK_MS;
  if (!Number.isSafeInteger(fallbackMs) || fallbackMs <= 0 || fallbackMs > 2_147_483_647) {
    throw new RangeError('mailbox wake fallbackMs must be a positive timer-safe integer');
  }
  const routes = new Map<string, Set<() => void>>();
  const keyFor = (tenant: TenantId, deviceId: string): string => JSON.stringify([tenant, deviceId]);

  return {
    appended(tenant, deviceId) {
      for (const notify of routes.get(keyFor(tenant, deviceId)) ?? []) notify();
    },
    subscribe(tenant, deviceId, signal) {
      const key = keyFor(tenant, deviceId);
      let closed = false;
      let pending = false;
      let release: (() => void) | undefined;
      const notify = (): void => {
        pending = true;
        release?.();
      };
      const close = (): void => {
        if (closed) return;
        closed = true;
        signal.removeEventListener('abort', close);
        const listeners = routes.get(key);
        listeners?.delete(notify);
        if (listeners?.size === 0) routes.delete(key);
        release?.();
      };
      const subscription: MailboxWakeSubscription = {
        next(maxWaitMs) {
          if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0) {
            throw new RangeError('mailbox wake maxWaitMs must be finite and nonnegative');
          }
          if (release !== undefined) throw new Error('mailbox wake next() is already pending');
          if (closed || pending || maxWaitMs === 0) {
            pending = false;
            return Promise.resolve();
          }
          const deadline = performance.now() + Math.min(fallbackMs, maxWaitMs);
          return new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout>;
            const finish = (): void => {
              clearTimeout(timer);
              release = undefined;
              pending = false;
              resolve();
            };
            const expire = (): void => {
              const remaining = deadline - performance.now();
              // Node timers may fire before the monotonic deadline. Rearm
              // here rather than making the handler perform an extra read.
              if (remaining > 0) timer = setTimeout(expire, Math.ceil(remaining));
              else finish();
            };
            timer = setTimeout(expire, Math.ceil(Math.min(fallbackMs, maxWaitMs)));
            release = finish;
          });
        },
        close,
      };
      if (signal.aborted) close();
      else {
        let listeners = routes.get(key);
        if (listeners === undefined) {
          listeners = new Set();
          routes.set(key, listeners);
        }
        listeners.add(notify);
        signal.addEventListener('abort', close, { once: true });
      }
      return subscription;
    },
  };
}
