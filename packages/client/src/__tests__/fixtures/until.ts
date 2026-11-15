import { onTestFailed, TestRunner } from 'vitest';

/**
 * Resolves once `check()` holds, re-evaluating it every 10 ms. It has no
 * deadline of its own: the test timeout is the only bound, so host load
 * cannot fail a wait whose state is still on its way. Use it only for state
 * with no event to await. On test timeout or cancellation, Vitest aborts its
 * signal and the wait rejects with the last state `observe()` reported.
 * A failed test also prints that diagnostic.
 */
export function until(check: () => boolean, observe: () => string): Promise<void> {
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
    const poll = (): void => {
      try {
        if (check()) {
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve();
          return;
        }
        last = observe();
        timer = setTimeout(poll, 10);
      } catch (error) {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    poll();
  });
}
