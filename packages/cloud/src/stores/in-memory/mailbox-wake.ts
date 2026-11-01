import type { TenantId } from '@byok-sdk/core';
import type { MailboxWake, MailboxWakeSubscription } from '../../mailbox-wake';
import type { TaskEventsWake } from '../../task-events-wake';

export const DEFAULT_MAILBOX_WAKE_FALLBACK_MS = 5_000;
/** How long a task event reader no hint reached waits before it re-reads (#1113 A4). */
export const DEFAULT_TASK_EVENTS_WAKE_FALLBACK_MS = 5_000;

export interface InProcessMailboxWakeOptions {
  /** Bounds delivery latency when all hints are lost. Defaults to 5 seconds. */
  readonly fallbackMs?: number;
}

export interface InProcessTaskEventsWakeOptions {
  /** Bounds read latency when all hints are lost. Defaults to 5 seconds. */
  readonly fallbackMs?: number;
}

/** Request-local subscriptions behind a port; losing the table only delays reads. */
export function createInProcessMailboxWake(options: InProcessMailboxWakeOptions = {}): MailboxWake {
  const wake = createInProcessKeyedWake('mailbox wake', options.fallbackMs ?? DEFAULT_MAILBOX_WAKE_FALLBACK_MS);
  return { appended: wake.notify, subscribe: wake.subscribe };
}

/**
 * Hints for task event readers in this process. It covers only writers in the
 * same process: a composition whose writers span processes needs a transport
 * that observes their commits, such as the Postgres task events wake.
 */
export function createInProcessTaskEventsWake(options: InProcessTaskEventsWakeOptions = {}): TaskEventsWake {
  const wake = createInProcessKeyedWake('task events wake', options.fallbackMs ?? DEFAULT_TASK_EVENTS_WAKE_FALLBACK_MS);
  return { changed: wake.notify, subscribe: wake.subscribe };
}

/** One tenant-scoped key space of hints, shared by the mailbox and task event wakes. */
interface KeyedWake {
  notify(tenant: TenantId, key: string): void;
  subscribe(tenant: TenantId, key: string, signal: AbortSignal): MailboxWakeSubscription;
}

function createInProcessKeyedWake(name: string, fallbackMs: number): KeyedWake {
  if (!Number.isSafeInteger(fallbackMs) || fallbackMs <= 0 || fallbackMs > 2_147_483_647) {
    throw new RangeError(`${name} fallbackMs must be a positive timer-safe integer`);
  }
  const routes = new Map<string, Set<() => void>>();
  const keyFor = (tenant: TenantId, key: string): string => JSON.stringify([tenant, key]);

  return {
    notify(tenant, routeKey) {
      for (const notify of routes.get(keyFor(tenant, routeKey)) ?? []) notify();
    },
    subscribe(tenant, routeKey, signal) {
      const key = keyFor(tenant, routeKey);
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
            throw new RangeError(`${name} maxWaitMs must be finite and nonnegative`);
          }
          if (release !== undefined) throw new Error(`${name} next() is already pending`);
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
