/**
 * Largest delay `setTimeout` honors (2^31 - 1 ms, ~24.8 days). Node and Bun
 * clamp anything longer to 1 ms, so a deadline that may be further away must
 * be armed in capped steps and re-armed until it is actually reached.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Aborting resolves the wait; it does not reject. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}
