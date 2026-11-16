import { onTestFailed, TestRunner } from 'vitest';
import type { Daemon } from '../../daemon/create-daemon';
import type { DaemonEvent } from '../../daemon/observer';

/**
 * Resolves once `check()` holds, re-evaluating it 10 ms after each answer. It
 * has no deadline of its own: the test timeout is the only bound, so host load
 * cannot fail a wait whose state is still on its way. Use it only for state
 * with no event to await. On test timeout or cancellation, Vitest aborts its
 * signal and the wait rejects with the last state `observe()` reported.
 * A failed test also prints that diagnostic.
 */
export function until(check: () => boolean | Promise<boolean>, observe: () => string): Promise<void> {
  const signal = TestRunner.getCurrentTest()!.context.signal;
  let last = observe();
  const waiting = (): string => `until: still waiting; last observed ${last}`;
  if (signal.aborted) return Promise.reject(new Error(waiting()));
  let settled = false;
  onTestFailed(() => {
    if (!settled) console.error(waiting());
  });
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error(waiting()));
    };
    const poll = async (): Promise<void> => {
      try {
        const held = await check();
        // An abort during an asynchronous check has already rejected the wait.
        if (signal.aborted) return;
        if (held) {
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve();
          return;
        }
        last = observe();
        timer = setTimeout(() => void poll(), 10);
      } catch (error) {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void poll();
  });
}

/**
 * Resolves with the first event `daemon` emits that `matches`. It subscribes
 * at once, so call it before the action that causes the event. Like `until`,
 * it has no deadline of its own: on test timeout or cancellation it rejects
 * naming the event it waited for.
 */
export function nextEvent(
  daemon: Pick<Daemon, 'subscribe'>,
  matches: (event: DaemonEvent) => boolean,
  awaited: string,
): Promise<DaemonEvent> {
  const signal = TestRunner.getCurrentTest()!.context.signal;
  const waiting = `nextEvent: still waiting for ${awaited}`;
  if (signal.aborted) return Promise.reject(new Error(waiting));
  let settled = false;
  onTestFailed(() => {
    if (!settled) console.error(waiting);
  });
  return new Promise((resolve, reject) => {
    const unsubscribe = daemon.subscribe((event) => {
      if (!matches(event)) return;
      settled = true;
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
      resolve(event);
    });
    const onAbort = (): void => {
      unsubscribe();
      reject(new Error(waiting));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
