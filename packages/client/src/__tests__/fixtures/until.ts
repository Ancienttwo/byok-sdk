import { onTestFailed } from 'vitest';
import { getCurrentTest } from 'vitest/suite';

/**
 * Resolves once `check()` holds, re-evaluating it every 10 ms. It has no
 * deadline of its own: the test timeout is the only bound, so host load
 * cannot fail a wait whose state is still on its way. Use it only for state
 * with no event to await. Polling stops when the test times out, and a
 * failed test prints the last state `observe()` reported before that.
 */
export function until(check: () => boolean, observe: () => string): Promise<void> {
  const signal = getCurrentTest()!.context.signal;
  let settled = false;
  let last = observe();
  onTestFailed(() => {
    if (!settled) console.error(`until: still waiting; last observed ${last}`);
  });
  return new Promise((resolve) => {
    const poll = (): void => {
      if (signal.aborted) return;
      if (check()) {
        settled = true;
        resolve();
        return;
      }
      last = observe();
      setTimeout(poll, 10);
    };
    poll();
  });
}
